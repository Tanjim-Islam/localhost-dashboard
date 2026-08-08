import path from "node:path";

const WINDOWS_ENV_PATTERN = /%([A-Z0-9_]+)%/gi;
const WILDCARD_PATTERN = /[*?\[\]]/;
const UNEXPANDED_ENV_PATTERN = /%[^%]+%/;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const EXTENDED_PATH_PATTERN = /^(?:\\\\|\/\/)[?.](?:\\|\/)/;
const UNC_PATH_PATTERN = /^(?:\\\\|\/\/)/;

export function expandWindowsEnvironmentPath(
  input: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return input.replace(WINDOWS_ENV_PATTERN, (_match, name: string) => {
    const key = Object.keys(environment).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (!key || !environment[key]) {
      throw new Error(`Environment variable ${name} is not available.`);
    }
    return environment[key]!;
  });
}

export function normalizeWindowsPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("A path is required.");
  if (trimmed.includes("\0"))
    throw new Error("Paths cannot contain null bytes.");
  if (URL_PATTERN.test(trimmed))
    throw new Error("URL paths are not supported.");
  if (EXTENDED_PATH_PATTERN.test(trimmed)) {
    throw new Error("Extended-length Windows paths are not supported.");
  }
  if (UNC_PATH_PATTERN.test(trimmed)) {
    throw new Error("Network and UNC paths are not supported.");
  }
  if (WILDCARD_PATTERN.test(trimmed)) {
    throw new Error("Wildcard paths are not allowed.");
  }
  if (UNEXPANDED_ENV_PATTERN.test(trimmed)) {
    throw new Error("Unexpanded environment-variable paths are not allowed.");
  }
  const windowsPath = trimmed.replaceAll("/", "\\");
  if (!path.win32.isAbsolute(windowsPath)) {
    throw new Error("Only absolute Windows paths are allowed.");
  }
  const normalized = path.win32.normalize(windowsPath);
  const parsed = path.win32.parse(normalized);
  if (!/^[a-z]:\\$/i.test(parsed.root)) {
    throw new Error("Only local drive paths are supported.");
  }
  if (normalized.toLowerCase() === parsed.root.toLowerCase()) {
    return `${parsed.root[0].toLowerCase()}:\\`;
  }
  return normalized.replace(/[\\/]+$/, "").toLowerCase();
}

export function canonicalizeWindowsDriveRoot(input: string): string {
  const trimmed = input.trim().replaceAll("/", "\\");
  const match = /^([a-z]):(?:\\)?$/i.exec(trimmed);
  if (!match) {
    throw new Error(
      `Cleaner SystemDrive must be a local Windows drive root, received ${JSON.stringify(input)}.`,
    );
  }
  return `${match[1].toUpperCase()}:\\`;
}

export function canonicalizeWindowsAbsolutePath(input: string): string {
  const normalized = normalizeWindowsPath(input);
  if (/^[a-z]:\\$/i.test(normalized)) {
    return `${normalized[0].toUpperCase()}:\\`;
  }
  return path.win32.normalize(input.trim().replaceAll("/", "\\"));
}

export function sameWindowsPath(left: string, right: string): boolean {
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

export function isWindowsPathInside(
  targetPath: string,
  ancestorPath: string,
): boolean {
  const target = normalizeWindowsPath(targetPath);
  const ancestor = normalizeWindowsPath(ancestorPath);
  return target === ancestor || target.startsWith(`${ancestor}\\`);
}

export function windowsPathDepth(input: string): number {
  const normalized = normalizeWindowsPath(input);
  const parsed = path.win32.parse(normalized);
  return normalized.slice(parsed.root.length).split("\\").filter(Boolean)
    .length;
}
