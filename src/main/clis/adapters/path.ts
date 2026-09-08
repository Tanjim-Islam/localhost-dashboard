import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { findCliByCommand } from "../catalogue";
import { discoveredCommandId, validCliCommand } from "../discovery";
import {
  createEndpointFingerprint,
  normalizeCliPath,
  stableCliId,
} from "../fingerprint";
import type {
  CliEndpointKind,
  CliExecutableEndpoint,
  CliPathEndpointRecord,
  CliPlatform,
  CliPackageRecord,
} from "../types";
import type { CliCancellationToken } from "../session";

const WINDOWS_LAUNCHER_EXTENSIONS = new Set([
  ".com",
  ".exe",
  ".bat",
  ".cmd",
  ".ps1",
]);
const MAX_SHIM_BYTES = 64 * 1024;
const MAX_DIRECT_SHIM_BYTES = 2 * 1024;
const MAX_DIRECT_SHIM_LINES = 20;

export type CliPathSnapshot = {
  directories: string[];
  pathExt: string[];
  pathDirectoryCount?: number;
};

export function createPathSnapshot(input: {
  platform: CliPlatform;
  pathValue: string;
  pathExtValue: string;
  extraDirectories: string[];
}): CliPathSnapshot {
  const delimiter = input.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const directories: string[] = [];
  const addDirectory = (candidate: string): void => {
    const trimmed = candidate.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed || !path.isAbsolute(trimmed)) return;
    const key = normalizeCliPath(trimmed, input.platform);
    if (seen.has(key)) return;
    seen.add(key);
    directories.push(path.normalize(trimmed));
  };
  for (const candidate of input.pathValue.split(delimiter)) {
    addDirectory(candidate);
  }
  const pathDirectoryCount = directories.length;
  for (const candidate of input.extraDirectories) {
    addDirectory(candidate);
  }
  const pathExt =
    input.platform === "win32"
      ? input.pathExtValue
          .split(";")
          .map((extension) => extension.trim().toLowerCase())
          .filter((extension) => WINDOWS_LAUNCHER_EXTENSIONS.has(extension))
      : [];
  return { directories, pathExt, pathDirectoryCount };
}

export async function collectPackageEndpoints(input: {
  platform: CliPlatform;
  packageRecords: CliPackageRecord[];
  pathRecords: CliPathEndpointRecord[];
  cancellation: CliCancellationToken;
}): Promise<CliPathEndpointRecord[]> {
  const results: CliPathEndpointRecord[] = [];
  const seen = new Set(
    input.pathRecords.flatMap(({ endpoint }) =>
      [endpoint.path, endpoint.canonicalPath, endpoint.shimTarget]
        .filter((value): value is string => Boolean(value))
        .map(
          (value) =>
            `${endpoint.commandName}|${normalizeCliPath(value, input.platform)}`,
        ),
    ),
  );
  for (const record of input.packageRecords) {
    for (const entry of record.binEntries) {
      input.cancellation.throwIfCancelled();
      const key = `${entry.commandName}|${normalizeCliPath(entry.targetPath, input.platform)}`;
      if (
        seen.has(key) ||
        !validCliCommand(entry.commandName) ||
        !path.isAbsolute(entry.targetPath)
      )
        continue;
      const endpoint = await inspectEndpoint({
        platform: input.platform,
        commandName: entry.commandName,
        endpointPath: entry.targetPath,
      });
      if (!endpoint.accessible || !endpoint.targetExists) continue;
      seen.add(key);
      results.push({ productId: record.productId, endpoint });
    }
  }
  return results;
}

export async function enumerateCliPathEndpoints(input: {
  platform: CliPlatform;
  snapshot: CliPathSnapshot;
  cancellation: CliCancellationToken;
  concurrency?: number;
  systemRoot?: string;
}): Promise<CliPathEndpointRecord[]> {
  const results: CliPathEndpointRecord[] = [];
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 8, 8));
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < input.snapshot.directories.length) {
      input.cancellation.throwIfCancelled();
      const pathIndex = nextIndex;
      nextIndex += 1;
      const directory = input.snapshot.directories[pathIndex];
      let names: string[];
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        names = entries
          .filter((entry) => entry.isFile() || entry.isSymbolicLink())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of names) {
        input.cancellation.throwIfCancelled();
        const parsed = parseCommandName(name, input.platform);
        if (!parsed || !validCliCommand(parsed.commandName)) continue;
        const definition = findCliByCommand(parsed.commandName, input.platform);
        if (
          !definition &&
          input.systemRoot &&
          isPathWithin(directory, input.systemRoot)
        )
          continue;
        if (
          !definition &&
          !(await isConsoleLauncher(path.join(directory, name), input.platform))
        )
          continue;
        const endpoint = await inspectEndpoint({
          platform: input.platform,
          commandName: parsed.commandName,
          endpointPath: path.join(directory, name),
          pathIndex:
            pathIndex <
            (input.snapshot.pathDirectoryCount ??
              input.snapshot.directories.length)
              ? pathIndex
              : undefined,
          pathextIndex:
            input.platform === "win32"
              ? input.snapshot.pathExt.indexOf(parsed.extension)
              : undefined,
        });
        results.push({
          productId: definition?.id ?? discoveredCommandId(parsed.commandName),
          endpoint,
        });
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, input.snapshot.directories.length || 1) },
      () => worker(),
    ),
  );
  return results.sort(compareEndpointRecords);
}

export function groupEquivalentEndpointKey(
  record: CliPathEndpointRecord,
  platform: CliPlatform,
): string {
  const endpoint = record.endpoint;
  const packageRoot =
    endpoint.shimPackageRoot && !/[%$]/.test(endpoint.shimPackageRoot)
      ? endpoint.shimPackageRoot
      : undefined;
  const identity =
    platform === "win32"
      ? path.dirname(endpoint.canonicalPath ?? endpoint.path)
      : (packageRoot ??
        endpoint.shimTarget ??
        endpoint.symlinkTarget ??
        endpoint.canonicalPath ??
        endpoint.path);
  return `${record.productId}|${normalizeCliPath(identity, platform)}`;
}

export function isWindowsExecutionAliasPath(value: string): boolean {
  const normalized = value.replaceAll("/", "\\").toLowerCase();
  return /\\appdata\\local\\microsoft\\windowsapps(?:\\|$)/.test(normalized);
}

function parseCommandName(
  filename: string,
  platform: CliPlatform,
): { commandName: string; extension: string } | null {
  const extension = path.extname(filename).toLowerCase();
  if (platform === "win32") {
    if (extension && !WINDOWS_LAUNCHER_EXTENSIONS.has(extension)) return null;
    return {
      commandName: (extension
        ? filename.slice(0, -extension.length)
        : filename
      ).toLowerCase(),
      extension,
    };
  }
  return { commandName: filename.toLowerCase(), extension };
}

export async function inspectEndpoint(input: {
  platform: CliPlatform;
  commandName: string;
  endpointPath: string;
  pathIndex?: number;
  pathextIndex?: number;
}): Promise<CliExecutableEndpoint> {
  const executionAlias =
    input.platform === "win32" &&
    isWindowsExecutionAliasPath(input.endpointPath);
  let linkStats: Stats | undefined;
  let targetStats: Stats | undefined;
  let canonicalPath: string | undefined;
  let symlinkTarget: string | undefined;
  let targetExists = true;
  let accessible = true;
  let executable = true;

  try {
    linkStats = await lstat(input.endpointPath, { bigint: false });
    try {
      // Parent directories can be junctions too, as with nvm's nodejs path.
      canonicalPath = await realpath(input.endpointPath);
      if (linkStats.isSymbolicLink()) symlinkTarget = canonicalPath;
    } catch {
      if (!executionAlias) targetExists = false;
    }
    if (targetExists)
      targetStats = await stat(canonicalPath ?? input.endpointPath);
    await access(
      canonicalPath ?? input.endpointPath,
      input.platform === "darwin" ? fsConstants.X_OK : fsConstants.F_OK,
    );
  } catch {
    accessible = false;
    executable = false;
    if (!linkStats) targetExists = false;
  }

  const shim = await inspectShim(
    input.endpointPath,
    input.platform,
    input.commandName,
    targetStats?.size,
  );
  const [shimTarget, shimPackageRoot, bundledWith] = await Promise.all([
    resolveExistingPath(shim.target),
    resolveExistingPath(shim.packageRoot),
    detectBundledDistribution(input.platform, input.commandName, canonicalPath),
  ]);
  const kind = classifyEndpointKind(
    input.endpointPath,
    input.platform,
    Boolean(linkStats?.isSymbolicLink()),
    shim.isShim,
    shim.scriptLike,
  );
  // POSIX shebang files can accompany Windows shims, but are not launchers for
  // PowerShell or cmd. Keep them as evidence without assigning PATH precedence.
  if (input.platform === "win32" && !path.extname(input.endpointPath))
    executable = false;
  const base = {
    commandName: input.commandName,
    kind,
    path: input.endpointPath,
    ...(canonicalPath ? { canonicalPath } : {}),
    ...(symlinkTarget ? { symlinkTarget } : {}),
    ...(shimTarget ? { shimTarget } : {}),
    ...(shimPackageRoot ? { shimPackageRoot } : {}),
    ...(bundledWith ? { bundledWith } : {}),
    ...(input.pathIndex !== undefined ? { pathIndex: input.pathIndex } : {}),
    ...(input.pathextIndex !== undefined && input.pathextIndex >= 0
      ? { pathextIndex: input.pathextIndex }
      : {}),
    accessible,
    executable,
    targetExists: targetExists && (shim.targetExists ?? true),
    ...(targetStats ? { fileSize: targetStats.size } : {}),
    ...(targetStats ? { modifiedAt: targetStats.mtimeMs } : {}),
    ...(targetStats
      ? { fileIdentity: `${targetStats.dev}:${targetStats.ino}` }
      : {}),
  };
  const fingerprint = createEndpointFingerprint(base, input.platform);
  return {
    id: stableCliId("endpoint", {
      platform: input.platform,
      path: normalizeCliPath(input.endpointPath, input.platform),
      commandName: input.commandName,
    }),
    ...base,
    fingerprint,
  };
}

async function resolveExistingPath(
  value?: string,
): Promise<string | undefined> {
  return value ? realpath(value).catch(() => value) : undefined;
}

async function detectBundledDistribution(
  platform: CliPlatform,
  commandName: string,
  canonicalPath?: string,
): Promise<CliExecutableEndpoint["bundledWith"]> {
  if (platform !== "win32" || commandName === "perl" || !canonicalPath)
    return undefined;
  const bin = path.dirname(canonicalPath);
  const tools = path.dirname(bin);
  if (
    path.basename(bin).toLowerCase() !== "bin" ||
    !["c", "perl"].includes(path.basename(tools).toLowerCase())
  )
    return undefined;
  const root = path.dirname(tools);
  try {
    // Bounded, passive distribution evidence. A folder called Strawberry is insufficient.
    const readme = path.join(root, "README.txt");
    const [readmeStat, perlStat] = await Promise.all([
      stat(readme),
      stat(path.join(root, "perl", "bin", "perl.exe")),
    ]);
    if (
      !readmeStat.isFile() ||
      readmeStat.size > 64 * 1024 ||
      !perlStat.isFile()
    )
      return undefined;
    if (
      /^=== Strawberry Perl \([^\r\n]+\) [\d.]+[^\r\n]* README ===\r?$/m.test(
        await readFile(readme, "utf8"),
      )
    ) {
      return "strawberry-perl";
    }
  } catch {
    // Missing or unreadable evidence leaves the distributor unidentified.
  }
  return undefined;
}

function isPathWithin(value: string, root: string): boolean {
  const relative = path.relative(root.toLowerCase(), value.toLowerCase());
  return (
    !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

// Inspect file headers only. Discovering an unfamiliar command never executes it.
export async function isConsoleLauncher(
  file: string,
  platform: CliPlatform,
): Promise<boolean> {
  let handle;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if (platform === "darwin") {
      await access(file, fsConstants.X_OK);
      return true;
    }
    const extension = path.extname(file).toLowerCase();
    if ([".cmd", ".bat", ".ps1"].includes(extension)) return true;
    handle = await open(file, "r");
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!extension)
      return bytesRead >= 2 && header.toString("ascii", 0, 2) === "#!";
    if (
      extension !== ".exe" ||
      bytesRead < 64 ||
      header.toString("ascii", 0, 2) !== "MZ"
    )
      return false;
    const peOffset = header.readUInt32LE(60);
    if (peOffset < 64 || peOffset > 1024 * 1024 || peOffset + 94 > info.size)
      return false;
    const pe = Buffer.alloc(94);
    const read = await handle.read(pe, 0, pe.length, peOffset);
    return (
      read.bytesRead === pe.length &&
      pe.readUInt32LE(0) === 0x4550 &&
      [0x10b, 0x20b].includes(pe.readUInt16LE(24)) &&
      pe.readUInt16LE(92) === 3
    );
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function inspectShim(
  endpointPath: string,
  platform: CliPlatform,
  commandName: string,
  fileSize?: number,
): Promise<{
  isShim: boolean;
  scriptLike: boolean;
  target?: string;
  packageRoot?: string;
  targetExists?: boolean;
}> {
  const extension = path.extname(endpointPath).toLowerCase();
  const mayBeShim =
    platform === "win32"
      ? [".cmd", ".ps1", ".bat", ""].includes(extension)
      : extension === "" || extension === ".sh";
  if (!mayBeShim || fileSize === undefined || fileSize > MAX_SHIM_BYTES) {
    return { isShim: false, scriptLike: false };
  }
  let content: string;
  try {
    content = await readFile(endpointPath, "utf8");
  } catch {
    return { isShim: false, scriptLike: false };
  }
  const expanded = expandLauncherVariables(content, path.dirname(endpointPath));
  const packageRoots = extractNodePackageRoots(expanded);
  for (const packageRoot of packageRoots) {
    const packageTarget = await readPackageBinTarget(
      packageRoot,
      commandName,
      platform,
    );
    if (packageTarget) {
      return {
        isShim: true,
        scriptLike: true,
        packageRoot,
        target: packageTarget.path,
        targetExists: packageTarget.exists,
      };
    }
  }
  const directTarget = await findDirectLauncherTarget(
    expanded,
    path.dirname(endpointPath),
    platform,
  );
  if (directTarget) {
    return {
      isShim: true,
      scriptLike: true,
      target: directTarget.path,
      targetExists: directTarget.exists,
    };
  }
  return {
    isShim: packageRoots.length > 0,
    scriptLike: /^#!|(?:^|\r?\n)\s*(?:@echo|@setlocal|setlocal)\b/i.test(
      content,
    ),
    ...(packageRoots[0] ? { packageRoot: packageRoots[0] } : {}),
  };
}

function classifyEndpointKind(
  endpointPath: string,
  platform: CliPlatform,
  symlink: boolean,
  shim: boolean,
  scriptLike: boolean,
): CliEndpointKind {
  if (platform === "win32" && isWindowsExecutionAliasPath(endpointPath)) {
    return "app-alias";
  }
  if (symlink) return "symlink";
  if (shim) return "shim";
  const extension = path.extname(endpointPath).toLowerCase();
  if (scriptLike || [".cmd", ".bat", ".ps1", ".sh"].includes(extension)) {
    return "script";
  }
  return "native";
}

function expandLauncherVariables(
  content: string,
  launcherRoot: string,
): string {
  const rootWithSeparator = `${launcherRoot}${path.sep}`;
  return content
    .replace(/%dp0%/gi, rootWithSeparator)
    .replace(/%~dp0/gi, rootWithSeparator)
    .replace(/\$\{basedir\}/gi, launcherRoot)
    .replace(/\$basedir/gi, launcherRoot)
    .replace(/\$PSScriptRoot/gi, launcherRoot)
    .replaceAll("/", path.sep);
}

function extractNodePackageRoots(content: string): string[] {
  const matches = content.matchAll(
    /[A-Za-z]:\\[^"\r\n]*?\\node_modules\\(?:@[^\\/"\r\n]+\\)?[^\\/"\r\n]+/gi,
  );
  const roots = new Set<string>();
  for (const match of matches) {
    const candidate = match[0].trim();
    if (!path.isAbsolute(candidate) || /[%$]/.test(candidate)) continue;
    roots.add(path.normalize(candidate));
  }
  return [...roots];
}

async function readPackageBinTarget(
  packageRoot: string,
  commandName: string,
  platform: CliPlatform,
): Promise<{ path: string; exists: boolean } | null> {
  try {
    const manifestPath = path.join(packageRoot, "package.json");
    const metadata = await stat(manifestPath);
    if (metadata.size > 512 * 1024) return null;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name?: unknown;
      bin?: unknown;
    };
    let relativeTarget: string | undefined;
    if (typeof manifest.bin === "string") {
      relativeTarget = manifest.bin;
    } else if (
      manifest.bin &&
      typeof manifest.bin === "object" &&
      !Array.isArray(manifest.bin)
    ) {
      const value = (manifest.bin as Record<string, unknown>)[commandName];
      if (typeof value === "string") relativeTarget = value;
    }
    if (!relativeTarget || path.isAbsolute(relativeTarget)) return null;
    const target = path.resolve(packageRoot, relativeTarget);
    const relative = path.relative(packageRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (await pathExists(target)) return { path: target, exists: true };
    // npm can declare a native bin without its Windows extension. cmd and
    // PowerShell resolve that declaration to the neighboring .exe.
    if (
      platform === "win32" &&
      !path.extname(target) &&
      (await pathExists(`${target}.exe`))
    )
      return { path: `${target}.exe`, exists: true };
    return { path: target, exists: false };
  } catch {
    return null;
  }
}

async function findDirectLauncherTarget(
  content: string,
  launcherRoot: string,
  platform: CliPlatform,
): Promise<{ path: string; exists: boolean } | null> {
  if (
    content.length > MAX_DIRECT_SHIM_BYTES ||
    content.split(/\r?\n/).length > MAX_DIRECT_SHIM_LINES
  ) {
    return null;
  }
  const quoted = [...content.matchAll(/["']([^"'\r\n]+)["']/g)].map((match) =>
    match[1].trim(),
  );
  const candidates = new Map<string, string>();
  for (const candidate of quoted) {
    if (/[%$]/.test(candidate)) continue;
    const normalized = path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.resolve(launcherRoot, candidate);
    if (![".exe", ".com"].includes(path.extname(normalized).toLowerCase())) {
      continue;
    }
    const relative = path.relative(launcherRoot, normalized);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    candidates.set(normalizeCliPath(normalized, platform), normalized);
  }
  if (candidates.size !== 1) return null;
  const target = [...candidates.values()][0];
  return { path: target, exists: await pathExists(target) };
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function compareEndpointRecords(
  left: CliPathEndpointRecord,
  right: CliPathEndpointRecord,
): number {
  const pathDifference =
    (left.endpoint.pathIndex ?? Number.MAX_SAFE_INTEGER) -
    (right.endpoint.pathIndex ?? Number.MAX_SAFE_INTEGER);
  if (pathDifference !== 0) return pathDifference;
  return (
    (left.endpoint.pathextIndex ?? Number.MAX_SAFE_INTEGER) -
    (right.endpoint.pathextIndex ?? Number.MAX_SAFE_INTEGER)
  );
}
