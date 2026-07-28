import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCliDefinition } from "./catalogue";
import {
  createEndpointFingerprint,
  createInstallationFingerprint,
  createInstallationId,
  stableCliId,
} from "./fingerprint";
import type { CliFixtureProvider } from "./scanner";
import type {
  CliCommand,
  CliCommandResult,
  CliCommandRunner,
  CliExecutableEndpoint,
  CliInstallation,
  CliInventorySnapshot,
  CliPackageIdentity,
  CliPlatform,
  CliProduct,
  CliScanProgress,
  CliSourceResult,
  CliUninstallCapability,
} from "./types";

const STAGES: Array<{
  stage: CliScanProgress["stage"];
  label: string;
}> = [
  { stage: "revalidating-cache", label: "Revalidating cached data" },
  { stage: "enumerating-path", label: "Enumerating PATH directories" },
  { stage: "reading-package-sources", label: "Reading package sources" },
  { stage: "matching-installations", label: "Matching installations" },
  { stage: "checking-versions", label: "Checking versions" },
  { stage: "finalizing", label: "Finalizing inventory" },
];

export class FixtureCliProvider implements CliFixtureProvider {
  private readonly removed = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly platform: CliPlatform,
    private readonly architecture: string,
    private readonly now: () => number,
  ) {}

  async scan(input: Parameters<CliFixtureProvider["scan"]>[0]): Promise<CliInventorySnapshot> {
    await this.ensureFiles();
    for (let index = 0; index < STAGES.length; index += 1) {
      input.cancellation.throwIfCancelled();
      const item = STAGES[index];
      input.onProgress({
        stage: item.stage,
        label: item.label,
        completedSources: index,
        totalSources: STAGES.length,
        completedProbes: item.stage === "checking-versions" ? 2 : 0,
        totalProbes: 2,
        startedAt: this.now(),
      });
      await delay(55, input.cancellation.signal);
    }
    return this.createSnapshot();
  }

  markUninstalled(installationId: string): void {
    this.removed.add(installationId);
  }

  private async ensureFiles(): Promise<void> {
    const files = [
      "path-a/codex.cmd",
      "path-a/opencode.cmd",
      "path-a/bun.exe",
      "path-b/bun.exe",
      "path-a/python.cmd",
      "path-a/dotnet.exe",
      "npm/node.exe",
      "npm/node_modules/npm/bin/npm-cli.js",
      "npm/node_modules/@openai/codex/package.json",
      "npm/node_modules/opencode-ai/package.json",
    ];
    for (const relative of files) {
      const target = path.join(this.root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await writeFile(target, `fixture:${relative}\n`, { flag: "wx" });
      } catch {
        // Existing fixture files remain stable across revalidation scans.
      }
    }
  }

  private createSnapshot(): CliInventorySnapshot {
    const generatedAt = this.now();
    const records = [
      this.record({
        productId: "codex",
        commandNames: ["codex"],
        version: "0.62.0",
        endpointPath: path.join(this.root, "path-a", "codex.cmd"),
        pathIndex: 0,
        identity: this.npmIdentity("@openai/codex", "0.62.0"),
        capability: capability(
          "supported",
          "npm",
          "@openai/codex",
          ["codex"],
          "Exact npm package ownership is available.",
        ),
      }),
      this.record({
        productId: "opencode",
        commandNames: ["opencode"],
        version: "1.2.4",
        endpointPath: path.join(this.root, "path-a", "opencode.cmd"),
        pathIndex: 0,
        identity: this.npmIdentity("opencode-ai", "1.2.4"),
        capability: capability(
          "supported",
          "npm",
          "opencode-ai",
          ["opencode"],
          "Exact npm package ownership is available.",
        ),
      }),
      this.record({
        productId: "bun",
        commandNames: ["bun"],
        version: "1.1.8",
        endpointPath: path.join(this.root, "path-a", "bun.exe"),
        pathIndex: 0,
        issues: ["duplicate-version", "path-conflict"],
      }),
      this.record({
        productId: "bun",
        commandNames: ["bun"],
        version: "1.2.20",
        endpointPath: path.join(this.root, "path-b", "bun.exe"),
        pathIndex: 1,
        issues: ["duplicate-version", "path-conflict", "shadowed"],
      }),
      this.record({
        productId: "python",
        commandNames: ["python"],
        version: "3.13.5",
        endpointPath: path.join(this.root, "path-a", "python.cmd"),
        pathIndex: 0,
        endpointIssue: "broken-shim",
        issues: ["broken-shim", "missing-target"],
      }),
      this.record({
        productId: "dotnet",
        commandNames: ["dotnet"],
        version: "9.0.7",
        endpointPath: path.join(this.root, "path-a", "dotnet.exe"),
        pathIndex: 0,
        issues: ["incomplete-installation"],
      }),
      this.record({
        productId: "gemini-cli",
        commandNames: ["gemini"],
        version: "0.1.12",
        endpointPath: path.join(this.root, "removed", "gemini.cmd"),
        pathIndex: undefined,
        presence: "missing",
        issues: ["cached-missing"],
      }),
    ];
    const visible: Array<{
      installation: CliInstallation;
      command: CliCommand;
      endpoint: CliExecutableEndpoint;
    }> = records.map((record) => {
      if (!this.removed.has(record.installation.id)) return record;
      return {
        ...record,
        installation: {
          ...record.installation,
          presence: "missing" as const,
          health: "missing" as const,
          verificationStatus: "cached" as const,
          issueCodes: ["cached-missing"],
          missingSince: generatedAt,
          lastSeenAt: record.installation.lastSeenAt,
          lastVerifiedAt: generatedAt,
          uninstallCapability: {
            ...record.installation.uninstallCapability,
            status: "blocked" as const,
            reasonCode: "installation-missing" as const,
            reason: "The installation is no longer present.",
          },
        },
        command: { ...record.command, pathRole: "not-on-path" as const },
      };
    });
    const installations = visible.map((record) => record.installation);
    const commands = visible.map((record) => record.command);
    const endpoints = visible.map((record) => record.endpoint);
    const products = createProducts(installations, commands);
    const sourceResults: CliSourceResult[] = [
      source("fixture-path", "Fixture PATH", "success", 7, generatedAt),
      source("fixture-npm", "Fixture npm packages", "success", 2, generatedAt),
      source(
        "fixture-winget",
        "Fixture Winget packages",
        "failed",
        0,
        generatedAt,
        "A fixture source failed without invalidating cached rows.",
      ),
    ];
    return {
      schemaVersion: 2,
      revision: `revision-${crypto.randomUUID()}`,
      platform: this.platform,
      architecture: this.architecture,
      generatedAt,
      lastSuccessfulScanAt: generatedAt - 5 * 60 * 1000,
      completeness: "partial",
      cached: false,
      products,
      installations,
      commands,
      endpoints,
      sourceResults,
    };
  }

  private record(input: {
    productId: string;
    commandNames: string[];
    version: string;
    endpointPath: string;
    pathIndex?: number;
    identity?: CliPackageIdentity;
    capability?: CliUninstallCapability;
    presence?: CliInstallation["presence"];
    issues?: CliInstallation["issueCodes"];
    endpointIssue?: "broken-shim";
  }): {
    installation: CliInstallation;
    command: CliCommand;
    endpoint: CliExecutableEndpoint;
  } {
    const targetExists = !input.endpointIssue && input.presence !== "missing";
    const endpointBase = {
      commandName: input.commandNames[0],
      kind: input.endpointIssue ? ("shim" as const) : ("native" as const),
      path: input.endpointPath,
      canonicalPath: input.endpointPath,
      ...(input.endpointIssue
        ? { shimTarget: path.join(this.root, "missing", "python.exe") }
        : {}),
      ...(input.pathIndex !== undefined ? { pathIndex: input.pathIndex } : {}),
      accessible: input.presence !== "missing",
      executable: input.presence !== "missing",
      targetExists,
      fileSize: 32,
      modifiedAt: 1_720_000_000_000,
      fileIdentity: `fixture-${input.productId}-${input.pathIndex ?? "missing"}`,
    };
    const endpoint: CliExecutableEndpoint = {
      id: stableCliId("endpoint", {
        path: input.endpointPath,
        command: input.commandNames[0],
      }),
      ...endpointBase,
      fingerprint: createEndpointFingerprint(endpointBase, this.platform),
    };
    const installationId = createInstallationId({
      platform: this.platform,
      productId: input.productId,
      packageIdentity: input.identity,
      canonicalPath: input.endpointPath,
    });
    const commandId = stableCliId("command", {
      installationId,
      name: input.commandNames[0],
    });
    const issues = input.issues ?? [];
    const presence = input.presence ?? "present";
    const health: CliInstallation["health"] =
      presence === "missing"
        ? "missing"
        : issues.some((issue) => ["broken-shim", "missing-target"].includes(issue))
          ? "broken"
          : issues.includes("incomplete-installation")
            ? "incomplete"
            : "healthy";
    const installation: CliInstallation = {
      id: installationId,
      productId: input.productId,
      platform: this.platform,
      architecture: this.architecture,
      scope: input.identity?.scope ?? "unknown",
      origin: input.identity ? "package-manager" : "user",
      version: input.version,
      versionSource: input.identity ? "package-metadata" : "version-probe",
      verificationStatus:
        presence === "missing"
          ? "cached"
          : input.identity
            ? "verified"
            : "ownership-unknown",
      ...(input.identity ? { packageIdentity: input.identity } : {}),
      endpointIds: [endpoint.id],
      commandIds: [commandId],
      fingerprint: createInstallationFingerprint({
        platform: this.platform,
        packageIdentity: input.identity,
        endpoints: [endpoint],
      }),
      presence,
      health,
      issueCodes: issues,
      firstSeenAt: this.now() - 86_400_000,
      ...(presence === "present" ? { lastSeenAt: this.now() } : {}),
      lastVerifiedAt: this.now(),
      ...(presence === "present"
        ? { lastSuccessfulVerificationAt: this.now() }
        : { missingSince: this.now() - 3_600_000 }),
      uninstallCapability:
        input.capability ??
        capability(
          "blocked",
          "standalone",
          undefined,
          input.commandNames,
          "Standalone binaries do not have a proven uninstall owner.",
        ),
    };
    return {
      installation,
      command: {
        id: commandId,
        productId: input.productId,
        installationId,
        name: input.commandNames[0],
        endpointIds: [endpoint.id],
        activeEndpointId: input.pathIndex === 0 ? endpoint.id : undefined,
        pathRole:
          input.pathIndex === undefined
            ? "not-on-path"
            : input.pathIndex === 0
              ? "active"
              : "shadowed",
      },
      endpoint,
    };
  }

  private npmIdentity(packageId: string, version: string): CliPackageIdentity {
    return {
      source: "npm",
      packageId,
      packageVersion: version,
      scope: "user",
      managerRoot: path.join(this.root, "npm"),
      managerExecutablePath: path.join(this.root, "npm", "node.exe"),
      managerCommandPath: path.join(
        this.root,
        "npm",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
      installRoot: path.join(
        this.root,
        "npm",
        "node_modules",
        ...packageId.split("/"),
      ),
      ownershipConfidence: "exact",
      uninstallEvidence: "manager-owned",
    };
  }
}

export class FixtureCliCommandRunner implements CliCommandRunner {
  async run(spec: import("./types").CliCommandSpec): Promise<CliCommandResult> {
    const fails = spec.args.some((argument) => argument === "opencode-ai");
    return {
      executable: spec.executable,
      exitCode: fails ? 1 : 0,
      stdout: fails ? "" : "Fixture uninstall complete.",
      stderr: fails ? "Fixture manager rejected the uninstall." : "",
      timedOut: false,
      cancelled: false,
      outputExceeded: false,
      ...(fails ? { errorCode: "FIXTURE_UNINSTALL_FAILED" } : {}),
    };
  }
}

function createProducts(
  installations: CliInstallation[],
  commands: CliCommand[],
): CliProduct[] {
  const products: CliProduct[] = [];
  for (const productId of new Set(installations.map((item) => item.productId))) {
    const definition = getCliDefinition(productId);
    if (!definition) continue;
    const owned = installations.filter((item) => item.productId === productId);
    const issueCodes = [...new Set(owned.flatMap((item) => item.issueCodes))];
    products.push({
      id: productId,
      displayName: definition.displayName,
      category: definition.category,
      aliases: [...(definition.aliases ?? [])],
      commandNames: [
        ...new Set(
          commands
            .filter((command) => command.productId === productId)
            .map((command) => command.name),
        ),
      ],
      supportedPlatforms: [...(definition.platforms ?? ["win32", "darwin"])],
      discoveryConfidence: "catalogued",
      installationIds: owned.map((item) => item.id),
      currentInstallationIds: owned
        .filter((item) => item.presence === "present")
        .map((item) => item.id),
      removedInstallationIds: owned
        .filter((item) => item.presence === "missing")
        .map((item) => item.id),
      embeddedInstallationIds: [],
      health: owned.some((item) =>
        ["broken", "inaccessible", "incomplete"].includes(item.health),
      )
        ? "broken"
        : owned.every((item) => item.health === "missing")
          ? "missing"
          : issueCodes.length
            ? "warning"
            : "healthy",
      verificationStatus: owned.some(
        (item) => item.verificationStatus === "ownership-unknown",
      )
        ? "ownership-unknown"
        : owned.every((item) => item.verificationStatus === "cached")
          ? "cached"
          : "verified",
      issueCodes,
    });
  }
  return products.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function capability(
  status: CliUninstallCapability["status"],
  sourceType: CliUninstallCapability["source"],
  packageId: string | undefined,
  commands: string[],
  reason: string,
): CliUninstallCapability {
  return {
    status,
    source: sourceType,
    ...(packageId ? { packageId } : {}),
    reasonCode:
      status === "supported"
        ? "exact-manager-owned"
        : status === "requires-warning"
          ? "multiple-commands"
          : "standalone-binary",
    reason,
    warnings: status === "requires-warning" ? ["All package commands will be removed."] : [],
    requiresElevation: false,
    providedCommands: commands,
  };
}

function source(
  sourceId: string,
  label: string,
  status: CliSourceResult["status"],
  recordCount: number,
  now: number,
  message?: string,
): CliSourceResult {
  return {
    sourceId,
    label,
    status,
    startedAt: now - 100,
    finishedAt: now,
    recordCount,
    ...(message ? { errorCode: "FIXTURE_SOURCE_FAILURE", message } : {}),
  };
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Fixture scan cancelled."));
      },
      { once: true },
    );
  });
}
