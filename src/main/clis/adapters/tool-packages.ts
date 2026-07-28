import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { findCliByCommand, findCliByPackage } from "../catalogue";
import type {
  CliAdapterResult,
  CliCommandRunner,
  CliExecutableEndpoint,
  CliPackageRecord,
  CliScanEnvironment,
  CliSourceResult,
} from "../types";

export async function collectToolPackageInventories(input: {
  environment: CliScanEnvironment;
  runner: CliCommandRunner;
  pipxEndpoints: CliExecutableEndpoint[];
  signal: AbortSignal;
  now: () => number;
}): Promise<CliAdapterResult> {
  const packageRecords: CliPackageRecord[] = [];
  const sourceResults: CliSourceResult[] = [];
  const pipx = input.pipxEndpoints[0];
  if (pipx) {
    const startedAt = input.now();
    const result = await input.runner.run(
      {
        executable: pipx.canonicalPath ?? pipx.path,
        args: ["list", "--output", "json"],
        cwd: input.environment.neutralWorkingDirectory,
        timeoutMs: 20_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      },
      input.signal,
    );
    const parsed =
      result.exitCode === 0
        ? parsePipxOutput(
            result.stdout,
            input.environment,
            pipx.canonicalPath ?? pipx.path,
          )
        : null;
    if (parsed) packageRecords.push(...parsed);
    sourceResults.push({
      sourceId: "pipx",
      label: "pipx applications",
      status: parsed ? "success" : "failed",
      startedAt,
      finishedAt: input.now(),
      recordCount: parsed?.length ?? 0,
      ...(!parsed
        ? {
            errorCode: result.errorCode ?? "MALFORMED_OUTPUT",
            message:
              result.message ?? "pipx inventory could not be read safely.",
          }
        : {}),
    });
  } else {
    sourceResults.push(skipped("pipx", "pipx applications", input.now));
  }

  const cargo = await collectCargoMetadata(input.environment, input.now);
  packageRecords.push(...cargo.packageRecords);
  sourceResults.push(...cargo.sourceResults);
  return { packageRecords, sourceResults };
}

export function parsePipxOutput(
  stdout: string,
  environment: CliScanEnvironment,
  managerExecutablePath: string,
): CliPackageRecord[] | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  const venvs = parsed.venvs;
  if (!venvs || typeof venvs !== "object" || Array.isArray(venvs)) return null;
  const records: CliPackageRecord[] = [];
  for (const [environmentName, raw] of Object.entries(
    venvs as Record<string, unknown>,
  )) {
    if (!raw || typeof raw !== "object") continue;
    const metadata = raw as Record<string, unknown>;
    const mainPackage = metadata.metadata
      ? (metadata.metadata as Record<string, unknown>).main_package
      : metadata.main_package;
    if (!mainPackage || typeof mainPackage !== "object") continue;
    const pkg = mainPackage as Record<string, unknown>;
    const packageId =
      stringValue(pkg.package) ?? stringValue(pkg.package_or_url) ?? environmentName;
    const version = stringValue(pkg.package_version);
    const apps = Array.isArray(pkg.apps)
      ? pkg.apps.filter((value): value is string => typeof value === "string")
      : [];
    const definition =
      findCliByPackage("pipx", packageId, environment.platform) ??
      apps
        .map((command) => findCliByCommand(command, environment.platform))
        .find(Boolean);
    if (!definition) continue;
    records.push({
      productId: definition.id,
      sourceId: "pipx",
      commandNames: apps.length ? apps : [...definition.commands],
      binEntries: [],
      version,
      packageIdentity: {
        source: "pipx",
        packageId: environmentName,
        packageVersion: version,
        scope: "user",
        managerRoot:
          environment.env.PIPX_HOME ??
          path.join(environment.homeDirectory, ".local", "share", "pipx"),
        managerExecutablePath,
        installRoot: path.join(
          environment.env.PIPX_HOME ??
            path.join(environment.homeDirectory, ".local", "share", "pipx"),
          "venvs",
          environmentName,
        ),
        ownershipConfidence: "exact",
        uninstallEvidence: "manager-owned",
      },
    });
  }
  return records;
}

async function collectCargoMetadata(
  environment: CliScanEnvironment,
  now: () => number,
): Promise<CliAdapterResult> {
  const startedAt = now();
  const cargoHome =
    environment.env.CARGO_HOME ??
    path.join(environment.homeDirectory, ".cargo");
  const metadataPath = path.join(cargoHome, ".crates2.json");
  let parsed: Record<string, unknown>;
  try {
    const stats = await stat(metadataPath);
    if (stats.size > 2 * 1024 * 1024) throw new Error("metadata too large");
    parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {
      packageRecords: [],
      sourceResults: [skipped("cargo", "Cargo installed packages", now)],
    };
  }
  const installs = parsed.installs;
  if (!installs || typeof installs !== "object" || Array.isArray(installs)) {
    return {
      packageRecords: [],
      sourceResults: [
        {
          sourceId: "cargo",
          label: "Cargo installed packages",
          status: "failed",
          startedAt,
          finishedAt: now(),
          recordCount: 0,
          errorCode: "MALFORMED_OUTPUT",
          message: "Cargo install metadata is malformed.",
        },
      ],
    };
  }
  const records: CliPackageRecord[] = [];
  for (const [packageSpec, raw] of Object.entries(
    installs as Record<string, unknown>,
  )) {
    const packageMatch = packageSpec.match(/^(.+?)\s+([^\s]+)\s+\(/);
    const packageId = packageMatch?.[1] ?? packageSpec.split(" ")[0];
    const version = packageMatch?.[2];
    const metadata =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const bins = Array.isArray(metadata.bins)
      ? metadata.bins.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const definition =
      findCliByPackage("cargo", packageId, environment.platform) ??
      bins
        .map((command) => findCliByCommand(command, environment.platform))
        .find(Boolean);
    if (!definition) continue;
    records.push({
      productId: definition.id,
      sourceId: "cargo",
      commandNames: bins.length ? bins : [...definition.commands],
      binEntries: [],
      version,
      packageIdentity: {
        source: "cargo",
        packageId,
        packageVersion: version,
        scope: "user",
        managerRoot: cargoHome,
        managerExecutablePath: path.join(
          cargoHome,
          "bin",
          environment.platform === "win32" ? "cargo.exe" : "cargo",
        ),
        installRoot: cargoHome,
        ownershipConfidence: "exact",
        uninstallEvidence: "manager-owned",
      },
    });
  }
  return {
    packageRecords: records,
    sourceResults: [
      {
        sourceId: "cargo",
        label: "Cargo installed packages",
        status: "success",
        startedAt,
        finishedAt: now(),
        recordCount: records.length,
      },
    ],
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function skipped(
  sourceId: string,
  label: string,
  now: () => number,
): CliSourceResult {
  const timestamp = now();
  return {
    sourceId,
    label,
    status: "skipped",
    startedAt: timestamp,
    finishedAt: timestamp,
    recordCount: 0,
  };
}
