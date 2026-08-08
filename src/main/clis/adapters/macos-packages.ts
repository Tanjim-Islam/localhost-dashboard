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

export async function collectMacPackageInventories(input: {
  environment: CliScanEnvironment;
  runner: CliCommandRunner;
  endpointsByProduct: ReadonlyMap<string, CliExecutableEndpoint[]>;
  signal: AbortSignal;
  now: () => number;
}): Promise<CliAdapterResult> {
  const records: CliPackageRecord[] = [];
  const sources: CliSourceResult[] = [];
  const brewEndpoints = input.endpointsByProduct.get("homebrew") ?? [];
  for (const endpoint of uniqueEndpoints(brewEndpoints)) {
    const startedAt = input.now();
    const managerPath = endpoint.canonicalPath ?? endpoint.path;
    const result = await input.runner.run(
      {
        executable: managerPath,
        args: ["info", "--json=v2", "--installed"],
        cwd: input.environment.neutralWorkingDirectory,
        env: {
          HOMEBREW_NO_AUTO_UPDATE: "1",
          HOMEBREW_NO_ENV_HINTS: "1",
          HOMEBREW_NO_ANALYTICS: "1",
        },
        timeoutMs: 30_000,
        maxStdoutBytes: 4 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      },
      input.signal,
    );
    const parsed =
      result.exitCode === 0
        ? parseHomebrewOutput(result.stdout, managerPath)
        : null;
    if (parsed) records.push(...parsed);
    sources.push({
      sourceId: `homebrew|${managerPath}`,
      label: `Homebrew at ${path.dirname(managerPath)}`,
      status: parsed ? "success" : "failed",
      startedAt,
      finishedAt: input.now(),
      recordCount: parsed?.length ?? 0,
      ...(!parsed
        ? {
            errorCode: result.errorCode ?? "MALFORMED_OUTPUT",
            message:
              result.message ?? "Homebrew inventory returned unexpected output.",
          }
        : {}),
    });
  }
  if (brewEndpoints.length === 0) {
    sources.push(skipped("homebrew", "Homebrew formulas", input.now));
  }

  const port = input.endpointsByProduct.get("macports")?.[0];
  if (port) {
    const startedAt = input.now();
    const managerPath = port.canonicalPath ?? port.path;
    const result = await input.runner.run(
      {
        executable: managerPath,
        args: ["installed", "-q"],
        cwd: input.environment.neutralWorkingDirectory,
        timeoutMs: 20_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      },
      input.signal,
    );
    const parsed =
      result.exitCode === 0
        ? parseMacPortsOutput(result.stdout, managerPath)
        : null;
    if (parsed) records.push(...parsed);
    sources.push({
      sourceId: "macports",
      label: "MacPorts packages",
      status: parsed ? "success" : "failed",
      startedAt,
      finishedAt: input.now(),
      recordCount: parsed?.length ?? 0,
      ...(!parsed
        ? {
            errorCode: result.errorCode ?? "MALFORMED_OUTPUT",
            message:
              result.message ?? "MacPorts inventory returned unexpected output.",
          }
        : {}),
    });
  } else {
    sources.push(skipped("macports", "MacPorts packages", input.now));
  }
  return { packageRecords: records, sourceResults: sources };
}

export function parseHomebrewOutput(
  stdout: string,
  managerExecutablePath: string,
): CliPackageRecord[] | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  const formulas = Array.isArray(parsed.formulae) ? parsed.formulae : [];
  const casks = Array.isArray(parsed.casks) ? parsed.casks : [];
  const records: CliPackageRecord[] = [];
  for (const [kind, values] of [
    ["homebrew-formula", formulas],
    ["homebrew-cask", casks],
  ] as const) {
    for (const raw of values) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const packageId =
        typeof record.full_name === "string"
          ? record.full_name
          : typeof record.name === "string"
            ? record.name
            : typeof record.token === "string"
              ? record.token
              : "";
      if (!packageId) continue;
      const definition =
        findCliByPackage(kind, packageId, "darwin") ??
        findCliByCommand(packageId, "darwin");
      if (!definition) continue;
      const installed = Array.isArray(record.installed)
        ? (record.installed as Array<Record<string, unknown>>)
        : [];
      const version =
        typeof record.linked_keg === "string"
          ? record.linked_keg
          : typeof installed.at(-1)?.version === "string"
            ? (installed.at(-1)?.version as string)
            : undefined;
      const prefix = path.dirname(path.dirname(managerExecutablePath));
      records.push({
        productId: definition.id,
        sourceId: `${kind}|${managerExecutablePath}`,
        commandNames: [...definition.commands],
        binEntries: [],
        version,
        packageIdentity: {
          source: kind,
          packageId,
          packageVersion: version,
          scope: "user",
          managerRoot: prefix,
          managerExecutablePath,
          installRoot:
            kind === "homebrew-formula" && version
              ? path.join(prefix, "Cellar", packageId, version)
              : undefined,
          ownershipConfidence: "exact",
          uninstallEvidence:
            kind === "homebrew-formula" ? "manager-owned" : "none",
        },
      });
    }
  }
  return records;
}

export function parseMacPortsOutput(
  stdout: string,
  managerExecutablePath: string,
): CliPackageRecord[] | null {
  const records: CliPackageRecord[] = [];
  let sawLine = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^([^\s]+)\s+@([^\s+]+)[^\s]*(?:\s+\(active\))?/);
    if (!match) continue;
    sawLine = true;
    const [, packageId, version] = match;
    const definition =
      findCliByPackage("macports", packageId, "darwin") ??
      findCliByCommand(packageId, "darwin");
    if (!definition) continue;
    records.push({
      productId: definition.id,
      sourceId: "macports",
      commandNames: [...definition.commands],
      binEntries: [],
      version,
      packageIdentity: {
        source: "macports",
        packageId,
        packageVersion: version,
        scope: "system",
        managerRoot: "/opt/local",
        managerExecutablePath,
        ownershipConfidence: "exact",
        uninstallEvidence: "none",
      },
    });
  }
  return sawLine || stdout.trim() === "" ? records : null;
}

function uniqueEndpoints(
  endpoints: CliExecutableEndpoint[],
): CliExecutableEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = endpoint.canonicalPath ?? endpoint.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
