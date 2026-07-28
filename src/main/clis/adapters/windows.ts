import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  findCliByCommand,
  findCliByPackage,
  getCliDefinitions,
} from "../catalogue";
import type {
  CliAdapterResult,
  CliCommandRunner,
  CliPackageRecord,
  CliScanEnvironment,
  CliSourceResult,
} from "../types";

type WindowsEvidence = {
  userPath?: string;
  machinePath?: string;
  appPaths?: Array<{ command: string; targetPath: string }>;
  uninstallRecords?: Array<{
    displayName: string;
    displayVersion?: string;
    publisher?: string;
    installLocation?: string;
    scope: "user" | "machine";
  }>;
};

export function getWindowsKnownDirectories(
  environment: CliScanEnvironment,
): string[] {
  const appData = environment.env.APPDATA;
  const localAppData = environment.env.LOCALAPPDATA;
  const userProfile = environment.env.USERPROFILE ?? environment.homeDirectory;
  const programData = environment.env.PROGRAMDATA;
  const scoopRoot =
    environment.env.SCOOP ?? path.join(userProfile, "scoop");
  return [
    appData ? path.join(appData, "npm") : "",
    path.join(userProfile, ".cargo", "bin"),
    path.join(userProfile, ".local", "bin"),
    path.join(userProfile, "bin"),
    path.join(scoopRoot, "shims"),
    programData ? path.join(programData, "chocolatey", "bin") : "",
    localAppData
      ? path.join(localAppData, "Microsoft", "WindowsApps")
      : "",
    localAppData ? path.join(localAppData, "Programs", "Python") : "",
    path.join(userProfile, ".bun", "bin"),
    path.join(userProfile, "AppData", "Local", "Android", "Sdk", "platform-tools"),
  ].filter(Boolean);
}

export async function collectWindowsEvidence(input: {
  environment: CliScanEnvironment;
  runner: CliCommandRunner;
  signal: AbortSignal;
  now: () => number;
}): Promise<CliAdapterResult> {
  const startedAt = input.now();
  const powershell = getPowerShellPath(input.environment);
  if (!powershell) {
    return failedResult(
      "windows-registry",
      "Windows registry",
      startedAt,
      input.now(),
      "POWERSHELL_UNAVAILABLE",
      "Windows registry evidence is unavailable.",
    );
  }
  const commandNames = getCliDefinitions("win32")
    .flatMap((definition) => definition.commands)
    .filter((value, index, values) => values.indexOf(value) === index);
  const script = createWindowsEvidenceScript(commandNames);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = await input.runner.run(
    {
      executable: powershell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      cwd: input.environment.neutralWorkingDirectory,
      timeoutMs: 15_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    },
    input.signal,
  );
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
    return failedResult(
      "windows-registry",
      "Windows registry",
      startedAt,
      input.now(),
      result.errorCode ?? "REGISTRY_QUERY_FAILED",
      result.message ?? "Windows registry evidence could not be read.",
    );
  }
  let evidence: WindowsEvidence;
  try {
    evidence = JSON.parse(result.stdout) as WindowsEvidence;
  } catch {
    return failedResult(
      "windows-registry",
      "Windows registry",
      startedAt,
      input.now(),
      "MALFORMED_OUTPUT",
      "Windows registry evidence returned malformed data.",
    );
  }

  const packageRecords: CliPackageRecord[] = [];
  for (const record of evidence.uninstallRecords ?? []) {
    const lowered = record.displayName.toLowerCase();
    const definition =
      findCliByPackage("registry", record.displayName, "win32") ??
      getCliDefinitions("win32").find(
        (candidate) =>
          candidate.displayName.toLowerCase() === lowered ||
          candidate.aliases?.some((alias) => alias.toLowerCase() === lowered),
      );
    if (!definition) continue;
    const installRoot = normalizeSafeWindowsInstallLocation(
      record.installLocation,
    );
    packageRecords.push({
      productId: definition.id,
      sourceId: "windows-registry",
      commandNames: [...definition.commands],
      binEntries: [],
      version: record.displayVersion,
      packageIdentity: {
        source: "registry",
        packageId: record.displayName,
        packageVersion: record.displayVersion,
        scope: record.scope,
        ...(installRoot ? { installRoot } : {}),
        ownershipConfidence: "corroborated",
        uninstallEvidence: "none",
      },
    });
  }

  const extraPathDirectories = [
    ...(evidence.userPath?.split(";") ?? []),
    ...(evidence.machinePath?.split(";") ?? []),
    ...(evidence.appPaths ?? [])
      .filter((record) =>
        Boolean(findCliByCommand(record.command.replace(/\.[^.]+$/, ""), "win32")),
      )
      .map((record) => path.dirname(record.targetPath)),
  ];
  return {
    packageRecords,
    extraPathDirectories,
    sourceResults: [
      {
        sourceId: "windows-registry",
        label: "Windows registry",
        status: "success",
        startedAt,
        finishedAt: input.now(),
        recordCount:
          packageRecords.length + (evidence.appPaths?.length ?? 0),
      },
    ],
  };
}

export async function readBoundedPackageJson(
  packageRoot: string,
): Promise<Record<string, unknown> | null> {
  try {
    const file = path.join(packageRoot, "package.json");
    const stats = await import("node:fs/promises").then((fs) => fs.stat(file));
    if (stats.size > 512 * 1024) return null;
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getPowerShellPath(environment: CliScanEnvironment): string | null {
  const systemRoot = environment.env.SystemRoot ?? environment.env.WINDIR;
  return systemRoot
    ? path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : null;
}

function createWindowsEvidenceScript(commands: string[]): string {
  const encodedCommands = commands
    .slice(0, 256)
    .map((command) => `'${command.replaceAll("'", "''")}.exe'`)
    .join(",");
  return `
$ErrorActionPreference='Stop'
$commands=@(${encodedCommands})
$appPaths=@()
foreach($root in @('Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths')){
  foreach($command in $commands){
    $item=Get-ItemProperty -LiteralPath (Join-Path $root $command) -ErrorAction SilentlyContinue
    if($item){$appPaths += [pscustomobject]@{command=$command;targetPath=[string]$item.'(default)'}}
  }
}
$uninstall=@()
foreach($entry in @(
  @{scope='user';path='Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'},
  @{scope='machine';path='Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'},
  @{scope='machine';path='Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'}
)){
  Get-ItemProperty -Path $entry.path -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName} | Select-Object -First 500 | ForEach-Object {
    $uninstall += [pscustomobject]@{displayName=[string]$_.DisplayName;displayVersion=[string]$_.DisplayVersion;publisher=[string]$_.Publisher;installLocation=[string]$_.InstallLocation;scope=$entry.scope}
  }
}
[pscustomobject]@{
  userPath=[Environment]::GetEnvironmentVariable('Path','User')
  machinePath=[Environment]::GetEnvironmentVariable('Path','Machine')
  appPaths=$appPaths
  uninstallRecords=$uninstall
} | ConvertTo-Json -Compress -Depth 5
`;
}

function normalizeSafeWindowsInstallLocation(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim().replace(/^"(.*)"$/, "$1");
  if (
    !trimmed ||
    trimmed.length > 1_024 ||
    !path.win32.isAbsolute(trimmed) ||
    trimmed.includes("\0")
  ) {
    return undefined;
  }
  return path.normalize(trimmed);
}

function failedResult(
  sourceId: string,
  label: string,
  startedAt: number,
  finishedAt: number,
  errorCode: string,
  message: string,
): CliAdapterResult {
  const source: CliSourceResult = {
    sourceId,
    label,
    status: "failed",
    startedAt,
    finishedAt,
    recordCount: 0,
    errorCode,
    message,
  };
  return { packageRecords: [], sourceResults: [source] };
}
