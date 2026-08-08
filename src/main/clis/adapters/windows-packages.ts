import { readFile, readdir, stat } from "node:fs/promises";
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

export async function collectWindowsPackageInventories(input: {
  environment: CliScanEnvironment;
  runner: CliCommandRunner;
  endpointsByProduct: ReadonlyMap<string, CliExecutableEndpoint[]>;
  signal: AbortSignal;
  now: () => number;
}): Promise<CliAdapterResult> {
  const records: CliPackageRecord[] = [];
  const sources: CliSourceResult[] = [];
  const winget = input.endpointsByProduct.get("winget")?.[0];
  const choco = input.endpointsByProduct.get("chocolatey")?.[0];

  if (winget && path.extname(winget.path).toLowerCase() === ".exe") {
    const source = await runTextInventory({
      sourceId: "winget",
      label: "Winget packages",
      endpoint: winget,
      args: [
        "list",
        "--disable-interactivity",
        "--accept-source-agreements",
      ],
      timeoutMs: 45_000,
      input,
      parser: (stdout) => parseWingetOutput(stdout, input.environment),
    });
    records.push(...source.records);
    sources.push(source.source);
  } else {
    sources.push(skipped("winget", "Winget packages", input.now));
  }

  if (choco && path.extname(choco.path).toLowerCase() === ".exe") {
    const source = await runTextInventory({
      sourceId: "chocolatey",
      label: "Chocolatey packages",
      endpoint: choco,
      args: ["list", "--limit-output", "--no-color"],
      timeoutMs: 20_000,
      input,
      parser: (stdout) => parseChocolateyOutput(stdout, input.environment),
    });
    records.push(...source.records);
    sources.push(source.source);
  } else {
    sources.push(skipped("chocolatey", "Chocolatey packages", input.now));
  }

  const scoop = await collectScoopInventory(input.environment, input.now);
  records.push(...scoop.packageRecords);
  sources.push(...scoop.sourceResults);
  return { packageRecords: records, sourceResults: sources };
}

export function parseChocolateyOutput(
  stdout: string,
  environment: CliScanEnvironment,
): CliPackageRecord[] | null {
  const records: CliPackageRecord[] = [];
  let sawRecord = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("|");
    if (separator <= 0) continue;
    sawRecord = true;
    const packageId = line.slice(0, separator).trim();
    const version = line.slice(separator + 1).trim();
    const definition =
      findCliByPackage("chocolatey", packageId, environment.platform) ??
      findCliByCommand(packageId, environment.platform);
    if (!definition) continue;
    records.push(packageRecord(definition.id, definition.commands, {
      source: "chocolatey",
      packageId,
      packageVersion: version,
      scope: "machine",
      managerRoot:
        environment.env.PROGRAMDATA &&
        path.join(environment.env.PROGRAMDATA, "chocolatey"),
      managerExecutablePath:
        environment.env.PROGRAMDATA &&
        path.join(environment.env.PROGRAMDATA, "chocolatey", "bin", "choco.exe"),
      ownershipConfidence: "exact",
      uninstallEvidence: "manager-owned",
    }));
  }
  return sawRecord || stdout.trim() === "" ? records : null;
}

export function parseWingetOutput(
  stdout: string,
  environment: CliScanEnvironment,
): CliPackageRecord[] | null {
  const lines = stdout.split(/\r?\n/);
  const divider = lines.findIndex((line) => /^-{3,}/.test(line.trim()));
  if (divider < 0) return null;
  const records: CliPackageRecord[] = [];
  for (const line of lines.slice(divider + 1)) {
    if (!line.trim()) continue;
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 3) continue;
    const [name, packageId, version] = columns;
    const definition =
      findCliByPackage("winget", packageId, environment.platform) ??
      findCliByCommand(name.toLowerCase(), environment.platform);
    if (!definition) continue;
    records.push(packageRecord(definition.id, definition.commands, {
      source: "winget",
      packageId,
      packageVersion: version,
      scope: "unknown",
      sourceName: columns.at(-1),
      managerRoot: path.dirname(
        environment.env.LOCALAPPDATA
          ? path.join(
              environment.env.LOCALAPPDATA,
              "Microsoft",
              "WindowsApps",
              "winget.exe",
            )
          : "winget.exe",
      ),
      managerExecutablePath: environment.env.LOCALAPPDATA
        ? path.join(
            environment.env.LOCALAPPDATA,
            "Microsoft",
            "WindowsApps",
            "winget.exe",
          )
        : undefined,
      ownershipConfidence:
        columns.at(-1)?.toLowerCase() === "winget" ? "corroborated" : "uncertain",
      uninstallEvidence: "none",
    }));
  }
  return records;
}

async function collectScoopInventory(
  environment: CliScanEnvironment,
  now: () => number,
): Promise<CliAdapterResult> {
  const startedAt = now();
  const root =
    environment.env.SCOOP ?? path.join(environment.homeDirectory, "scoop");
  const appsRoot = path.join(root, "apps");
  let appIds: string[];
  try {
    appIds = (await readdir(appsRoot)).slice(0, 500);
  } catch {
    return {
      packageRecords: [],
      sourceResults: [skipped("scoop", "Scoop applications", now)],
    };
  }
  const records: CliPackageRecord[] = [];
  for (const appId of appIds) {
    const currentRoot = path.join(appsRoot, appId, "current");
    const manifestPath = path.join(currentRoot, "manifest.json");
    let manifest: Record<string, unknown>;
    try {
      const metadata = await stat(manifestPath);
      if (metadata.size > 1024 * 1024) continue;
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    const commands = parseScoopBins(manifest.bin);
    const definition =
      findCliByPackage("scoop", appId, environment.platform) ??
      commands
        .map((command) => findCliByCommand(command, environment.platform))
        .find(Boolean);
    if (!definition) continue;
    const hasHooks = [
      "pre_uninstall",
      "post_uninstall",
      "uninstaller",
    ].some((key) => manifest[key] !== undefined);
    records.push(packageRecord(definition.id, commands.length ? commands : definition.commands, {
      source: "scoop",
      packageId: appId,
      packageVersion:
        typeof manifest.version === "string" ? manifest.version : undefined,
      scope: "user",
      managerRoot: root,
      managerExecutablePath: path.join(root, "bin", "scoop.ps1"),
      installRoot: currentRoot,
      ownershipConfidence: "exact",
      uninstallEvidence: hasHooks ? "none" : "simple-manifest",
    }));
  }
  return {
    packageRecords: records,
    sourceResults: [
      {
        sourceId: "scoop",
        label: "Scoop applications",
        status: "success",
        startedAt,
        finishedAt: now(),
        recordCount: records.length,
      },
    ],
  };
}

function parseScoopBins(value: unknown): string[] {
  if (typeof value === "string") return [path.basename(value, path.extname(value))];
  if (!Array.isArray(value)) return [];
  const commands: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      commands.push(path.basename(item, path.extname(item)));
    } else if (Array.isArray(item)) {
      const alias = item[1];
      const executable = item[0];
      if (typeof alias === "string") commands.push(alias);
      else if (typeof executable === "string") {
        commands.push(path.basename(executable, path.extname(executable)));
      }
    }
  }
  return commands;
}

async function runTextInventory(input: {
  sourceId: string;
  label: string;
  endpoint: CliExecutableEndpoint;
  args: string[];
  timeoutMs: number;
  input: {
    environment: CliScanEnvironment;
    runner: CliCommandRunner;
    signal: AbortSignal;
    now: () => number;
  };
  parser: (stdout: string) => CliPackageRecord[] | null;
}): Promise<{ records: CliPackageRecord[]; source: CliSourceResult }> {
  const startedAt = input.input.now();
  const result = await input.input.runner.run(
    {
      executable: input.endpoint.canonicalPath ?? input.endpoint.path,
      args: input.args,
      cwd: input.input.environment.neutralWorkingDirectory,
      timeoutMs: input.timeoutMs,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    },
    input.input.signal,
  );
  const parsed = result.exitCode === 0 ? input.parser(result.stdout) : null;
  return {
    records: parsed ?? [],
    source: {
      sourceId: input.sourceId,
      label: input.label,
      status: parsed ? "success" : "failed",
      startedAt,
      finishedAt: input.input.now(),
      recordCount: parsed?.length ?? 0,
      ...(!parsed
        ? {
            errorCode: result.errorCode ?? "MALFORMED_OUTPUT",
            message:
              result.message ?? `${input.label} returned unexpected output.`,
          }
        : {}),
    },
  };
}

function packageRecord(
  productId: string,
  commandNames: readonly string[],
  packageIdentity: CliPackageRecord["packageIdentity"],
): CliPackageRecord {
  return {
    productId,
    sourceId: packageIdentity.source,
    commandNames: [...commandNames],
    binEntries: [],
    version: packageIdentity.packageVersion,
    packageIdentity,
  };
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
