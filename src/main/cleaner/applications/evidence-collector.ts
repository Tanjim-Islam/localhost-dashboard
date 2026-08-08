import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CleanerApplicationDefinition,
  CleanerApplicationEvidence,
  CleanerApplicationEvidenceProvider,
  CleanerApplicationEvidenceSnapshot,
  CleanerApplicationObservation,
  CleanerEnvironment,
  CleanerEvidenceSourceResult,
  CleanerEvidenceSourceType,
  CleanerProcessSnapshot,
  CleanerScanMode,
} from "../types";
import type { TestCleanerFilesystem } from "../adapters/test-filesystem";
import { CLEANER_APPLICATION_DEFINITIONS } from "./definitions";
import { CleanerCancelledError } from "../cancellation";

const execFileAsync = promisify(execFile);
const DEEP_SOURCE_TIMEOUT_MS = 12_000;

type RegistryRecord = {
  displayName?: string;
  publisher?: string;
  version?: string;
  installLocation?: string;
  displayIcon?: string;
  keyName?: string;
};

type AppPathRecord = {
  keyName?: string;
  targetPath?: string;
};

type AppxRecord = {
  name?: string;
  packageFamilyName?: string;
  publisher?: string;
  version?: string;
  installLocation?: string;
  locationExists?: boolean;
};

type ShortcutRecord = {
  targetPath?: string;
  name?: string;
  targetExists?: boolean;
};

type ExecutableMetadataRecord = {
  executablePath?: string;
  productName?: string;
  companyName?: string;
  version?: string;
};

type NamedRecord = {
  name?: string;
  targetPath?: string;
};

export class RealCleanerApplicationEvidenceProvider implements CleanerApplicationEvidenceProvider {
  async collect(
    mode: CleanerScanMode,
    environment: CleanerEnvironment,
    processes: CleanerProcessSnapshot[],
    observations: Record<string, CleanerApplicationObservation>,
    options?: {
      isCancelled?(): boolean;
      onSourceProgress?(
        source: CleanerEvidenceSourceType,
        completed: number,
        total: number,
      ): void;
    },
  ): Promise<CleanerApplicationEvidenceSnapshot> {
    const sources: CleanerEvidenceSourceResult[] = [];
    const tasks: Array<{
      source: CleanerEvidenceSourceType;
      mandatory: boolean;
      collect(): Promise<CleanerEvidenceSourceResult>;
    }> = [
      {
        source: "uninstall-registry",
        mandatory: true,
        collect: () => collectUninstallRegistry(environment),
      },
      {
        source: "app-path",
        mandatory: true,
        collect: () => collectAppPaths(environment),
      },
      {
        source: "exact-registry-key",
        mandatory: true,
        collect: () => collectExactRegistryKeys(),
      },
      {
        source: "executable",
        mandatory: true,
        collect: () => collectKnownExecutables(environment),
      },
      {
        source: "appx",
        mandatory: true,
        collect: () => collectAppxPackages(environment),
      },
      {
        source: "process",
        mandatory: true,
        collect: async () => collectProcessEvidence(processes),
      },
      {
        source: "observation",
        mandatory: false,
        collect: async () => collectObservationEvidence(observations),
      },
    ];
    if (mode === "deep") {
      tasks.push(
        {
          source: "shortcut",
          mandatory: true,
          collect: () => collectShortcuts(environment),
        },
        {
          source: "portable-root",
          mandatory: true,
          collect: () => collectPortableExecutables(environment),
        },
        {
          source: "service",
          mandatory: false,
          collect: () => collectNamedPowerShellEvidence(environment, "service"),
        },
        {
          source: "scheduled-task",
          mandatory: false,
          collect: () =>
            collectNamedPowerShellEvidence(environment, "scheduled-task"),
        },
        {
          source: "protocol",
          mandatory: false,
          collect: () =>
            collectNamedPowerShellEvidence(environment, "protocol"),
        },
        {
          source: "package-manager",
          mandatory: false,
          collect: () => collectWingetRecords(environment),
        },
      );
    }
    const startedAt = Date.now();
    const globalBudgetMs =
      mode === "standard" ? 20_000 : Number.POSITIVE_INFINITY;
    for (let index = 0; index < tasks.length; index += 1) {
      if (options?.isCancelled?.()) throw new CleanerCancelledError();
      const task = tasks[index];
      if (mode === "standard" && Date.now() - startedAt > globalBudgetMs) {
        for (const remaining of tasks.slice(index)) {
          sources.push(
            failedSource(
              remaining.source,
              remaining.mandatory,
              "The application-evidence global time budget expired.",
            ),
          );
        }
        break;
      }
      options?.onSourceProgress?.(task.source, index, tasks.length);
      sources.push(await task.collect());
      options?.onSourceProgress?.(task.source, index + 1, tasks.length);
    }

    return {
      collectedAt: Date.now(),
      mode,
      sources,
    };
  }
}

export class TestCleanerApplicationEvidenceProvider implements CleanerApplicationEvidenceProvider {
  constructor(private readonly filesystem: TestCleanerFilesystem) {}

  async collect(
    mode: CleanerScanMode,
    _environment?: CleanerEnvironment,
    _processes?: CleanerProcessSnapshot[],
    _observations?: Record<string, CleanerApplicationObservation>,
    options?: {
      isCancelled?(): boolean;
      onSourceProgress?(
        source: CleanerEvidenceSourceType,
        completed: number,
        total: number,
      ): void;
    },
  ): Promise<CleanerApplicationEvidenceSnapshot> {
    if (options?.isCancelled?.()) throw new CleanerCancelledError();
    const manifest = await this.filesystem.readManifest(true);
    const snapshot = structuredClone(manifest.evidence);
    snapshot.mode = mode;
    if (mode === "standard") {
      snapshot.sources = snapshot.sources.filter((source) =>
        [
          "uninstall-registry",
          "app-path",
          "exact-registry-key",
          "executable",
          "appx",
          "process",
          "observation",
        ].includes(source.source),
      );
    }
    return snapshot;
  }
}

async function collectExactRegistryKeys(): Promise<CleanerEvidenceSourceResult> {
  return {
    source: "exact-registry-key",
    mandatory: true,
    completed: true,
    evidence: [],
  };
}

async function collectUninstallRegistry(
  environment: CleanerEnvironment,
): Promise<CleanerEvidenceSourceResult> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$records = [System.Collections.Generic.List[object]]::new()
$locations = @(
  @{ Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; View = [Microsoft.Win32.RegistryView]::Default },
  @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry64 },
  @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry32 }
)
foreach ($location in $locations) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($location.Hive, $location.View)
  $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
  if ($null -eq $key) { continue }
  foreach ($name in $key.GetSubKeyNames()) {
    $item = $key.OpenSubKey($name)
    if ($null -eq $item) { continue }
    $displayName = [string]$item.GetValue('DisplayName')
    if ([string]::IsNullOrWhiteSpace($displayName)) { continue }
    $records.Add([pscustomobject]@{
      displayName = $displayName
      publisher = [string]$item.GetValue('Publisher')
      version = [string]$item.GetValue('DisplayVersion')
      installLocation = [string]$item.GetValue('InstallLocation')
      displayIcon = [string]$item.GetValue('DisplayIcon')
      keyName = $name
    })
  }
}
$records | ConvertTo-Json -Compress -Depth 3
`;
  return collectPowerShellRecords(
    environment,
    "uninstall-registry",
    true,
    script,
    (record: RegistryRecord) =>
      matchCleanerRegistryIdentity(record).map((applicationId) => ({
        source: "uninstall-registry",
        applicationId,
        observedName: record.displayName,
        publisher: emptyToUndefined(record.publisher),
        version: emptyToUndefined(record.version),
        installLocation: emptyToUndefined(record.installLocation),
        executablePath: normalizeDisplayIcon(record.displayIcon),
        current: true,
        verified: false,
        strength: "medium",
        summary: `Current structured uninstall record for ${record.displayName ?? "application"}.`,
      })),
  );
}

async function collectAppPaths(
  environment: CleanerEnvironment,
): Promise<CleanerEvidenceSourceResult> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$records = [System.Collections.Generic.List[object]]::new()
$locations = @(
  @{ Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; View = [Microsoft.Win32.RegistryView]::Default },
  @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry64 },
  @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry32 }
)
foreach ($location in $locations) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($location.Hive, $location.View)
  $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths')
  if ($null -eq $key) { continue }
  foreach ($name in $key.GetSubKeyNames()) {
    $item = $key.OpenSubKey($name)
    if ($null -eq $item) { continue }
    $records.Add([pscustomobject]@{ keyName = $name; targetPath = [string]$item.GetValue('') })
  }
}
$records | ConvertTo-Json -Compress -Depth 3
`;
  return collectPowerShellRecords(
    environment,
    "app-path",
    true,
    script,
    (record: AppPathRecord) =>
      matchCleanerExecutableIdentity(record.keyName).map((applicationId) => ({
        source: "app-path",
        applicationId,
        targetPath: emptyToUndefined(record.targetPath),
        executablePath: emptyToUndefined(record.targetPath),
        current: true,
        verified: false,
        strength: "medium",
        summary: `Current App Paths record for ${record.keyName ?? "application"}.`,
      })),
  );
}

async function collectKnownExecutables(
  environment: CleanerEnvironment,
): Promise<CleanerEvidenceSourceResult> {
  const candidates: Array<{
    definition: CleanerApplicationDefinition;
    signature: CleanerApplicationDefinition["executableSignatures"][number];
    executablePath: string;
  }> = [];
  let inaccessible = false;
  for (const definition of CLEANER_APPLICATION_DEFINITIONS) {
    for (const signature of definition.executableSignatures) {
      for (const executablePath of signature.knownPaths(environment)) {
        try {
          const stat = await fs.lstat(executablePath);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          if (
            !signature.basenames.some((basename) =>
              equalsIgnoreCase(path.win32.basename(executablePath), basename),
            )
          ) {
            continue;
          }
          candidates.push({ definition, signature, executablePath });
        } catch (error) {
          if (!isMissingFilesystemError(error)) inaccessible = true;
        }
      }
    }
  }
  let metadata: ExecutableMetadataRecord[] = [];
  if (candidates.length > 0) {
    const literalPaths = candidates
      .map((candidate) => `'${candidate.executablePath.replaceAll("'", "''")}'`)
      .join(",");
    const script = `$ErrorActionPreference='Stop'; @(${literalPaths}) | ForEach-Object { $item=Get-Item -LiteralPath $_ -ErrorAction Stop; $v=$item.VersionInfo; [pscustomobject]@{executablePath=$item.FullName;productName=[string]$v.ProductName;companyName=[string]$v.CompanyName;version=[string]$v.FileVersion} } | ConvertTo-Json -Compress -Depth 3`;
    try {
      metadata = parseJsonArray<ExecutableMetadataRecord>(
        await runPowerShell(environment, script),
      );
    } catch {
      inaccessible = true;
    }
  }
  const evidence = candidates.map((candidate) => {
    const record = metadata.find((item) =>
      item.executablePath
        ? equalsIgnoreCase(item.executablePath, candidate.executablePath)
        : false,
    );
    const productVerified =
      candidate.signature.productNames?.length && record?.productName
        ? candidate.signature.productNames.some((productName) =>
            equalsIgnoreCase(productName, record.productName ?? ""),
          )
        : false;
    const publisherVerified =
      !candidate.signature.publishers?.length ||
      Boolean(
        record?.companyName &&
        candidate.signature.publishers.some((publisher) =>
          equalsIgnoreCase(publisher, record.companyName ?? ""),
        ),
      );
    const verified = Boolean(productVerified && publisherVerified);
    return {
      source: "executable" as const,
      applicationId: candidate.definition.id,
      executablePath: candidate.executablePath,
      observedName: record?.productName ?? candidate.definition.displayName,
      publisher: emptyToUndefined(record?.companyName),
      version: emptyToUndefined(record?.version),
      current: true,
      verified,
      strength: verified ? ("strong" as const) : ("medium" as const),
      summary: verified
        ? `Verified executable identity ${path.win32.basename(candidate.executablePath)} at an exact defined location.`
        : `Executable ${path.win32.basename(candidate.executablePath)} exists at an exact defined location, but product metadata was incomplete or did not match.`,
    };
  });
  return {
    source: "executable",
    mandatory: true,
    completed: !inaccessible,
    error: inaccessible
      ? "One or more exact executable locations could not be inspected."
      : undefined,
    evidence,
  };
}

async function collectAppxPackages(
  environment: CleanerEnvironment,
): Promise<CleanerEvidenceSourceResult> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Get-AppxPackage | ForEach-Object {
  [pscustomobject]@{
    Name = $_.Name
    PackageFamilyName = $_.PackageFamilyName
    Publisher = $_.Publisher
    Version = [string]$_.Version
    InstallLocation = $_.InstallLocation
    LocationExists = [bool]($_.InstallLocation -and (Test-Path -LiteralPath $_.InstallLocation))
  }
} | ConvertTo-Json -Compress -Depth 3
`;
  return collectPowerShellRecords(
    environment,
    "appx",
    true,
    script,
    (record: AppxRecord) =>
      matchCleanerAppxIdentity(record).map((applicationId) => ({
        source: "appx",
        applicationId,
        observedName: record.name,
        publisher: emptyToUndefined(record.publisher),
        version: emptyToUndefined(record.version),
        packageFamilyName: emptyToUndefined(record.packageFamilyName),
        installLocation: emptyToUndefined(record.installLocation),
        current: true,
        verified: record.locationExists === true,
        strength: record.locationExists ? "strong" : "medium",
        summary: `Current Appx package ${record.name ?? record.packageFamilyName ?? "application"}.`,
      })),
  );
}

function collectProcessEvidence(
  processes: CleanerProcessSnapshot[],
): CleanerEvidenceSourceResult {
  return {
    source: "process",
    mandatory: true,
    completed: true,
    evidence: processes.flatMap((processInfo) => {
      if (!processInfo.applicationId || !processInfo.executablePath) return [];
      return [
        {
          source: "process" as const,
          applicationId: processInfo.applicationId,
          executablePath: processInfo.executablePath,
          current: true,
          verified: true,
          strength: "strong" as const,
          summary: `Running verified executable ${path.win32.basename(processInfo.executablePath)}.`,
        },
      ];
    }),
  };
}

function collectObservationEvidence(
  observations: Record<string, CleanerApplicationObservation>,
): CleanerEvidenceSourceResult {
  return {
    source: "observation",
    mandatory: false,
    completed: true,
    evidence: Object.values(observations).map((observation) => ({
      source: "observation",
      applicationId: observation.applicationId,
      current: false,
      verified: false,
      stale: true,
      strength: "weak",
      summary: `Historical Cleaner observation: ${observation.lastInstallState}.`,
    })),
  };
}

async function collectShortcuts(
  environment: CleanerEnvironment,
): Promise<CleanerEvidenceSourceResult> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$roots = @(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$shell = New-Object -ComObject WScript.Shell
$records = [System.Collections.Generic.List[object]]::new()
foreach ($root in $roots) {
  foreach ($item in [IO.Directory]::EnumerateFiles($root, '*.lnk', [IO.SearchOption]::AllDirectories) | Select-Object -First 500) {
    try {
      $shortcut = $shell.CreateShortcut($item)
      $records.Add([pscustomobject]@{
        name = [IO.Path]::GetFileNameWithoutExtension($item)
        targetPath = $shortcut.TargetPath
        targetExists = [bool]($shortcut.TargetPath -and (Test-Path -LiteralPath $shortcut.TargetPath -PathType Leaf))
      })
    } catch {}
  }
}
$records | ConvertTo-Json -Compress -Depth 3
`;
  return collectPowerShellRecords(
    environment,
    "shortcut",
    false,
    script,
    (record: ShortcutRecord) =>
      matchCleanerExecutableIdentity(
        path.win32.basename(record.targetPath ?? ""),
      ).map((applicationId) => ({
        source: "shortcut",
        applicationId,
        observedName: emptyToUndefined(record.name),
        targetPath: emptyToUndefined(record.targetPath),
        executablePath: emptyToUndefined(record.targetPath),
        current: record.targetExists === true,
        stale: record.targetExists !== true,
        verified: record.targetExists === true,
        strength: record.targetExists ? "strong" : "weak",
        summary: record.targetExists
          ? `Resolved shortcut with a verified target for ${record.name ?? "application"}.`
          : `Stale shortcut with a missing target for ${record.name ?? "application"}.`,
      })),
  );
}

async function collectPortableExecutables(
  environment: CleanerEnvironment,
): Promise<CleanerEvidenceSourceResult> {
  const roots = [
    path.join(environment.home, "Applications"),
    path.join(environment.home, "PortableApps"),
  ];
  const wanted = new Map<string, string[]>();
  for (const definition of CLEANER_APPLICATION_DEFINITIONS) {
    for (const signature of definition.executableSignatures) {
      for (const basename of signature.basenames) {
        wanted.set(basename.toLowerCase(), [
          ...(wanted.get(basename.toLowerCase()) ?? []),
          definition.id,
        ]);
      }
    }
  }
  const evidence: CleanerApplicationEvidence[] = [];
  let inspected = 0;
  let inaccessible = false;
  const queue = roots.map((targetPath) => ({ targetPath, depth: 0 }));
  while (queue.length > 0 && inspected < 500) {
    const current = queue.shift()!;
    try {
      const entries = await fs.readdir(current.targetPath, {
        withFileTypes: true,
      });
      inspected += 1;
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryPath = path.join(current.targetPath, entry.name);
        if (entry.isDirectory() && current.depth < 3) {
          queue.push({ targetPath: entryPath, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        for (const applicationId of wanted.get(entry.name.toLowerCase()) ??
          []) {
          const definition = CLEANER_APPLICATION_DEFINITIONS.find(
            (item) => item.id === applicationId,
          );
          const parentName = path.basename(current.targetPath);
          const exactProductFolder = Boolean(
            definition && equalsIgnoreCase(parentName, definition.displayName),
          );
          let portableMarker = false;
          try {
            const marker = await fs.lstat(
              path.join(current.targetPath, ".portable"),
            );
            portableMarker = marker.isFile() && !marker.isSymbolicLink();
          } catch {
            // Portable markers are optional.
          }
          const verified = exactProductFolder || portableMarker;
          evidence.push({
            source: "portable-root",
            applicationId,
            executablePath: entryPath,
            current: true,
            verified,
            portable: true,
            strength: verified ? "strong" : "weak",
            summary: verified
              ? `Verified portable structure for ${entry.name} in a bounded portable root.`
              : `Possible portable executable ${entry.name}; product structure was not verified.`,
          });
        }
      }
    } catch (error) {
      if (!isMissingFilesystemError(error)) inaccessible = true;
    }
  }
  return {
    source: "portable-root",
    mandatory: false,
    completed: !inaccessible,
    error: inaccessible
      ? "A bounded portable-application root was inaccessible."
      : undefined,
    evidence,
  };
}

async function collectNamedPowerShellEvidence(
  environment: CleanerEnvironment,
  source: "service" | "scheduled-task" | "protocol",
): Promise<CleanerEvidenceSourceResult> {
  const definitions = CLEANER_APPLICATION_DEFINITIONS.flatMap((definition) => {
    if (source === "service") {
      return definition.serviceSignatures.flatMap((item) =>
        item.serviceNames.map((name) => ({
          applicationId: definition.id,
          name,
        })),
      );
    }
    if (source === "scheduled-task") {
      return definition.scheduledTaskSignatures.flatMap((item) =>
        item.taskNames.map((name) => ({ applicationId: definition.id, name })),
      );
    }
    return definition.protocolSignatures.flatMap((item) =>
      item.protocolNames.map((name) => ({
        applicationId: definition.id,
        name,
      })),
    );
  });
  if (definitions.length === 0) {
    return {
      source,
      mandatory: false,
      completed: true,
      evidence: [],
    };
  }
  const names = definitions.map((item) => item.name);
  const literalNames = names
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(",");
  const script =
    source === "service"
      ? `$ErrorActionPreference='Stop'; @(${literalNames}) | ForEach-Object { $s=Get-Service -Name $_ -ErrorAction SilentlyContinue; if($s){[pscustomobject]@{name=$s.Name}} } | ConvertTo-Json -Compress`
      : source === "scheduled-task"
        ? `$ErrorActionPreference='Stop'; @(${literalNames}) | ForEach-Object { $s=Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue; if($s){[pscustomobject]@{name=$s.TaskName}} } | ConvertTo-Json -Compress`
        : `$ErrorActionPreference='Stop'; @(${literalNames}) | ForEach-Object { $p=Get-ItemProperty -LiteralPath ('Registry::HKEY_CURRENT_USER\\Software\\Classes\\'+$_+'\\shell\\open\\command') -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{name=$_;targetPath=[string]$p.'(default)'}} } | ConvertTo-Json -Compress`;
  return collectPowerShellRecords(
    environment,
    source,
    false,
    script,
    (record: NamedRecord) => {
      const match = definitions.find((item) =>
        equalsIgnoreCase(item.name, record.name ?? ""),
      );
      if (!match) return [];
      return [
        {
          source,
          applicationId: match.applicationId,
          serviceName: source === "service" ? record.name : undefined,
          taskName: source === "scheduled-task" ? record.name : undefined,
          protocolName: source === "protocol" ? record.name : undefined,
          targetPath: emptyToUndefined(record.targetPath),
          current: true,
          verified: true,
          strength: "medium",
          summary: `Current exact ${source} evidence for ${record.name}.`,
        },
      ];
    },
  );
}

async function collectWingetRecords(
  environment: CleanerEnvironment,
): Promise<CleanerEvidenceSourceResult> {
  const packageDefinitions = CLEANER_APPLICATION_DEFINITIONS.filter(
    (definition) => definition.packageManagerSignatures.length > 0,
  );
  if (packageDefinitions.length === 0) {
    return {
      source: "package-manager",
      mandatory: false,
      completed: true,
      evidence: [],
    };
  }
  try {
    const { stdout } = await execFileAsync(
      "winget.exe",
      ["list", "--disable-interactivity", "--accept-source-agreements"],
      {
        windowsHide: true,
        timeout: DEEP_SOURCE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: safeChildEnvironment(environment),
      },
    );
    const evidence: CleanerApplicationEvidence[] = [];
    for (const definition of packageDefinitions) {
      for (const signature of definition.packageManagerSignatures) {
        if (
          !signature.managers.some((manager) =>
            equalsIgnoreCase(manager, "winget"),
          )
        ) {
          continue;
        }
        for (const packageId of signature.packageIds) {
          const exactLine = stdout
            .split(/\r?\n/)
            .find((line) =>
              line
                .split(/\s{2,}/)
                .some((cell) => equalsIgnoreCase(cell.trim(), packageId)),
            );
          if (!exactLine) continue;
          evidence.push({
            source: "package-manager",
            applicationId: definition.id,
            observedName: packageId,
            current: true,
            verified: false,
            strength: "medium",
            summary: `Current exact winget record ${packageId}.`,
          });
        }
      }
    }
    return {
      source: "package-manager",
      mandatory: false,
      completed: true,
      evidence,
    };
  } catch {
    return failedSource(
      "package-manager",
      false,
      "The bounded package-manager inventory was unavailable or timed out.",
    );
  }
}

async function collectPowerShellRecords<T>(
  environment: CleanerEnvironment,
  source: CleanerEvidenceSourceType,
  mandatory: boolean,
  script: string,
  map: (record: T) => CleanerApplicationEvidence[],
): Promise<CleanerEvidenceSourceResult> {
  try {
    const stdout = await runPowerShell(environment, script);
    const records = parseJsonArray<T>(stdout);
    return {
      source,
      mandatory,
      completed: true,
      evidence: records.flatMap(map),
    };
  } catch {
    return failedSource(
      source,
      mandatory,
      `${source} evidence was unavailable or timed out.`,
    );
  }
}

async function runPowerShell(
  environment: CleanerEnvironment,
  script: string,
): Promise<string> {
  const executable = path.join(
    environment.windowsDir,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      windowsHide: true,
      timeout: DEEP_SOURCE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: safeChildEnvironment(environment),
    },
  );
  return stdout;
}

function safeChildEnvironment(
  environment: CleanerEnvironment,
): NodeJS.ProcessEnv {
  return {
    SystemRoot: environment.windowsDir,
    WINDIR: environment.windowsDir,
    TEMP: environment.tempDir,
    TMP: environment.tempDir,
    PATH: process.env["PATH"],
  };
}

export function matchCleanerRegistryIdentity(record: RegistryRecord): string[] {
  return CLEANER_APPLICATION_DEFINITIONS.filter((definition) =>
    definition.registrySignatures.some((signature) => {
      const nameMatches = signature.displayNames.some((name) =>
        equalsIgnoreCase(name, record.displayName ?? ""),
      );
      if (!nameMatches) return false;
      if (!record.publisher || !signature.publishers?.length) return true;
      return signature.publishers.some((publisher) =>
        equalsIgnoreCase(publisher, record.publisher ?? ""),
      );
    }),
  ).map((definition) => definition.id);
}

export function matchCleanerExecutableIdentity(
  input: string | undefined,
): string[] {
  if (!input) return [];
  return CLEANER_APPLICATION_DEFINITIONS.filter((definition) =>
    definition.executableSignatures.some((signature) =>
      signature.basenames.some((basename) => equalsIgnoreCase(basename, input)),
    ),
  ).map((definition) => definition.id);
}

export function matchCleanerAppxIdentity(record: AppxRecord): string[] {
  return CLEANER_APPLICATION_DEFINITIONS.filter((definition) =>
    definition.appxSignatures.some((signature) =>
      signature.packageFamilyNames.some((family) =>
        equalsIgnoreCase(family, record.packageFamilyName ?? ""),
      ),
    ),
  ).map((definition) => definition.id);
}

function parseJsonArray<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as T | T[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function failedSource(
  source: CleanerEvidenceSourceType,
  mandatory: boolean,
  error: string,
): CleanerEvidenceSourceResult {
  return { source, mandatory, completed: false, error, evidence: [] };
}

function normalizeDisplayIcon(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^"|"$/g, "").split(",")[0]?.trim() || undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isMissingFilesystemError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}
