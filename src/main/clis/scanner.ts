import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { createPathSnapshot, enumerateCliPathEndpoints } from "./adapters/path";
import {
  collectWindowsEvidence,
  getWindowsKnownDirectories,
} from "./adapters/windows";
import { getMacKnownDirectories } from "./adapters/macos";
import { collectNodePackageInventories } from "./adapters/node-packages";
import { collectToolPackageInventories } from "./adapters/tool-packages";
import { collectWindowsPackageInventories } from "./adapters/windows-packages";
import { collectMacPackageInventories } from "./adapters/macos-packages";
import { classifyCliOrigin, isEmbeddedCliOrigin } from "./origin";
import {
  assembleInventory,
  finalizeHealth,
  indexEndpoints,
} from "./inventory-builder";
import { matchInstallations } from "./installation-matcher";
import type { CliCancellationToken } from "./session";
import type {
  CliAdapterResult,
  CliClock,
  CliCommandRunner,
  CliInventorySnapshot,
  CliScanEnvironment,
  CliScanProgress,
  CliSourceResult,
} from "./types";
import { probeVersions } from "./version-probes";

const SCAN_SOURCE_COUNT = 6;

export type CliScannerOptions = {
  createEnvironment(): Promise<CliScanEnvironment>;
  runner: CliCommandRunner;
  clock: CliClock;
  fixtureProvider?: CliFixtureProvider;
};

export type CliFixtureProvider = {
  scan(input: {
    previous: CliInventorySnapshot | null;
    cancellation: CliCancellationToken;
    onProgress: (progress: Omit<CliScanProgress, "scanSessionId">) => void;
    scanSessionId: string;
  }): Promise<CliInventorySnapshot>;
  markUninstalled?(installationId: string): void;
};

export class CliScanner {
  constructor(private readonly options: CliScannerOptions) {}

  async scan(input: {
    previous: CliInventorySnapshot | null;
    cancellation: CliCancellationToken;
    scanSessionId: string;
    onProgress: (progress: CliScanProgress) => void;
  }): Promise<CliInventorySnapshot> {
    if (this.options.fixtureProvider) {
      return this.options.fixtureProvider.scan({
        ...input,
        onProgress: (progress) =>
          input.onProgress({ ...progress, scanSessionId: input.scanSessionId }),
      });
    }
    const environment = await this.options.createEnvironment();
    const startedAt = this.options.clock.now();
    const emit = (
      stage: CliScanProgress["stage"],
      label: string,
      completedSources: number,
      totalSources = SCAN_SOURCE_COUNT,
      completedProbes = 0,
      totalProbes = 0,
    ): void => {
      input.onProgress({
        scanSessionId: input.scanSessionId,
        stage,
        label,
        completedSources,
        totalSources,
        completedProbes,
        totalProbes,
        startedAt,
      });
    };

    emit("revalidating-cache", "Revalidating cached data", 0);
    input.cancellation.throwIfCancelled();

    let osEvidence: CliAdapterResult = {
      packageRecords: [],
      sourceResults: [],
      extraPathDirectories: [],
    };
    let knownDirectories: string[];
    if (environment.platform === "win32") {
      osEvidence = await collectWindowsEvidence({
        environment,
        runner: this.options.runner,
        signal: input.cancellation.signal,
        now: () => this.options.clock.now(),
      });
      knownDirectories = getWindowsKnownDirectories(environment);
    } else {
      knownDirectories = await getMacKnownDirectories(environment);
    }
    input.cancellation.throwIfCancelled();

    emit("enumerating-path", "Enumerating PATH directories", 1);
    const pathStartedAt = this.options.clock.now();
    const pathSnapshot = createPathSnapshot({
      platform: environment.platform,
      pathValue: environment.pathValue,
      pathExtValue: environment.pathExtValue,
      extraDirectories: [
        ...knownDirectories,
        ...(osEvidence.extraPathDirectories ?? []),
      ],
    });
    const pathRecords = await enumerateCliPathEndpoints({
      platform: environment.platform,
      snapshot: pathSnapshot,
      cancellation: input.cancellation,
      concurrency: 8,
    });
    const sourceResults: CliSourceResult[] = [
      ...osEvidence.sourceResults,
      {
        sourceId: "path",
        label:
          environment.platform === "darwin"
            ? "Application PATH and known directories"
            : "PATH and known directories",
        status: "success",
        startedAt: pathStartedAt,
        finishedAt: this.options.clock.now(),
        recordCount: pathRecords.length,
      },
    ];
    const endpointsByProduct = indexEndpoints(pathRecords);
    input.cancellation.throwIfCancelled();

    emit("reading-package-sources", "Reading package sources", 2);
    const nodeInventory = await collectNodePackageInventories({
      environment,
      runner: this.options.runner,
      managerEndpoints: pathRecords
        .filter(
          (record) =>
            ["npm", "pnpm", "yarn"].includes(record.productId) &&
            !isEmbeddedCliOrigin(
              classifyCliOrigin({
                platform: environment.platform,
                productId: record.productId,
                endpoints: [record.endpoint],
                homeDirectory: environment.homeDirectory,
              }),
            ),
        )
        .map((record) => ({
          productId: record.productId as "npm" | "pnpm" | "yarn",
          endpoint: record.endpoint,
        })),
      nodeEndpoints: endpointsByProduct.get("node") ?? [],
      signal: input.cancellation.signal,
      now: () => this.options.clock.now(),
    });
    input.cancellation.throwIfCancelled();
    const toolInventory = await collectToolPackageInventories({
      environment,
      runner: this.options.runner,
      pipxEndpoints: endpointsByProduct.get("pipx") ?? [],
      signal: input.cancellation.signal,
      now: () => this.options.clock.now(),
    });
    input.cancellation.throwIfCancelled();
    const platformInventory =
      environment.platform === "win32"
        ? await collectWindowsPackageInventories({
            environment,
            runner: this.options.runner,
            endpointsByProduct,
            signal: input.cancellation.signal,
            now: () => this.options.clock.now(),
          })
        : await collectMacPackageInventories({
            environment,
            runner: this.options.runner,
            endpointsByProduct,
            signal: input.cancellation.signal,
            now: () => this.options.clock.now(),
          });
    sourceResults.push(
      ...nodeInventory.sourceResults,
      ...toolInventory.sourceResults,
      ...platformInventory.sourceResults,
    );
    const packageRecords = [
      ...osEvidence.packageRecords,
      ...nodeInventory.packageRecords,
      ...toolInventory.packageRecords,
      ...platformInventory.packageRecords,
    ];
    input.cancellation.throwIfCancelled();

    emit("matching-installations", "Matching installations", 5);
    const mutable = matchInstallations(
      environment,
      pathRecords,
      packageRecords,
    );
    const failedSourceIds = new Set(
      sourceResults
        .filter(
          (source) =>
            source.status === "failed" ||
            (source.status === "skipped" && Boolean(source.errorCode)),
        )
        .map((source) => source.sourceId.toLowerCase()),
    );
    const assembled = assembleInventory({
      environment,
      mutable,
      previous: input.previous,
      failedSourceIds,
      now: this.options.clock.now(),
    });
    input.cancellation.throwIfCancelled();

    const needsProbe = assembled.installations.filter(
      (installation) =>
        installation.presence === "present" &&
        !installation.version &&
        installation.issueCodes.includes("version-unverified"),
    );
    emit(
      "checking-versions",
      "Checking versions",
      5,
      SCAN_SOURCE_COUNT,
      0,
      needsProbe.length,
    );
    await probeVersions({
      environment,
      runner: this.options.runner,
      cancellation: input.cancellation,
      installations: assembled.installations,
      endpoints: assembled.endpoints,
      previous: input.previous,
      onProgress: (completed) =>
        emit(
          "checking-versions",
          "Checking versions",
          5,
          SCAN_SOURCE_COUNT,
          completed,
          needsProbe.length,
        ),
    });
    input.cancellation.throwIfCancelled();

    emit(
      "finalizing",
      "Finalizing inventory",
      SCAN_SOURCE_COUNT,
      SCAN_SOURCE_COUNT,
      needsProbe.length,
      needsProbe.length,
    );
    finalizeHealth(assembled);
    const completeness = sourceResults.some(
      (source) => source.status === "failed",
    )
      ? "partial"
      : "complete";
    return {
      schemaVersion: 2,
      revision: `revision-${randomUUID()}`,
      platform: environment.platform,
      architecture: environment.architecture,
      generatedAt: this.options.clock.now(),
      completeness,
      cached: false,
      ...assembled,
      sourceResults: sourceResults.slice(0, 64),
    };
  }

  async revalidateInstallation(
    snapshot: CliInventorySnapshot,
    installationId: string,
  ): Promise<{ current: boolean; reason?: string }> {
    if (this.options.fixtureProvider) {
      const fixtureInstallation = snapshot.installations.find(
        (candidate) => candidate.id === installationId,
      );
      return fixtureInstallation?.presence === "present"
        ? { current: true }
        : {
            current: false,
            reason: "The fixture installation is no longer present.",
          };
    }
    const installation = snapshot.installations.find(
      (candidate) => candidate.id === installationId,
    );
    if (!installation || installation.presence !== "present") {
      return { current: false, reason: "The installation is no longer present." };
    }
    const endpoints = snapshot.endpoints.filter((endpoint) =>
      installation.endpointIds.includes(endpoint.id),
    );
    for (const endpoint of endpoints) {
      try {
        const target = endpoint.canonicalPath ?? endpoint.path;
        const metadata = await stat(target);
        if (
          endpoint.fileSize !== undefined &&
          endpoint.fileSize !== metadata.size
        ) {
          return { current: false, reason: "The executable changed." };
        }
      } catch {
        return {
          current: false,
          reason: "The executable is no longer available.",
        };
      }
    }
    const identity = installation.packageIdentity;
    if (identity?.installRoot) {
      try {
        await access(identity.installRoot);
      } catch {
        return { current: false, reason: "The package installation changed." };
      }
    }
    if (identity?.managerExecutablePath) {
      try {
        await access(identity.managerExecutablePath);
      } catch {
        return { current: false, reason: "The package manager is unavailable." };
      }
    }
    if (identity?.managerCommandPath) {
      try {
        await access(identity.managerCommandPath);
      } catch {
        return {
          current: false,
          reason: "The package manager command changed.",
        };
      }
    }
    return { current: true };
  }

  markFixtureUninstalled(installationId: string): void {
    this.options.fixtureProvider?.markUninstalled?.(installationId);
  }
}
