import path from "node:path";
import systeminformation from "systeminformation";
import type {
  CleanerEnvironment,
  CleanerProcessCommandCategory,
  CleanerProcessProvider,
  CleanerProcessSnapshot,
} from "../types";
import type { TestCleanerFilesystem } from "./test-filesystem";
import { CLEANER_APPLICATION_DEFINITIONS } from "../applications/definitions";
import { normalizeWindowsPath } from "../path-normalization";

export class RealCleanerProcessProvider implements CleanerProcessProvider {
  async list(
    environment: CleanerEnvironment,
  ): Promise<CleanerProcessSnapshot[]> {
    const snapshot = await systeminformation.processes();
    return snapshot.list.map((rawProcessInfo) => {
      const processInfo = rawProcessInfo as unknown as Record<string, unknown>;
      const name =
        stringValue(processInfo["name"]) ||
        stringValue(processInfo["command"]) ||
        "unknown";
      const executablePath =
        stringValue(processInfo["path"]) ||
        inferExecutablePath(stringValue(processInfo["command"]));
      const rawCommand = [
        stringValue(processInfo["command"]),
        stringValue(processInfo["params"]),
      ]
        .filter(Boolean)
        .join(" ");
      return {
        name,
        pid: numberValue(processInfo["pid"]),
        executablePath,
        parentPid:
          numberValue(processInfo["parentPid"]) ??
          numberValue(processInfo["ppid"]),
        createdAt: parseStartedAt(processInfo["started"]),
        commandCategory: categorizeCleanerProcessCommand(
          name,
          executablePath,
          rawCommand,
        ),
        applicationId: resolveProcessApplicationId(
          name,
          executablePath,
          environment,
        ),
        referencedPaths: extractBoundedWindowsPathReferences(rawCommand),
      };
    });
  }
}

export class TestCleanerProcessProvider implements CleanerProcessProvider {
  constructor(private readonly filesystem: TestCleanerFilesystem) {}

  async list(): Promise<CleanerProcessSnapshot[]> {
    const manifest = await this.filesystem.readManifest(true);
    return manifest.evidence.processes.map((processInfo) => ({
      ...processInfo,
      referencedPaths: [...processInfo.referencedPaths],
    }));
  }
}

export function categorizeCleanerProcessCommand(
  name: string,
  executablePath: string | undefined,
  command: string,
): CleanerProcessCommandCategory {
  const basename = path.win32.basename(executablePath || name).toLowerCase();
  const normalized = command.replaceAll("/", "\\").toLowerCase();
  if (basename === "uv.exe" || basename === "uv") return "uv-operation";
  if (basename === "conda.exe" || basename === "conda")
    return "conda-operation";
  if (
    basename.startsWith("jupyter") ||
    /\bjupyter(?:-lab|-notebook)?\b/.test(normalized)
  )
    return "jupyter-operation";
  if (/\bpython(?:3|\.exe)?\b/.test(basename)) {
    if (/\buv\b/.test(normalized)) return "uv-operation";
    if (/\bpip(?:3)?\b/.test(normalized)) return "pip-operation";
    if (/\bpoetry\b/.test(normalized)) return "poetry-operation";
    if (/\bpipenv\b/.test(normalized)) return "pipenv-operation";
    if (/\bjupyter\b/.test(normalized)) return "jupyter-operation";
    if (/\bconda\b/.test(normalized)) return "conda-operation";
  }
  if (basename === "npm.exe" || basename === "npm.cmd")
    return "npm-cache-operation";
  if (basename === "npx.exe" || basename === "npx.cmd") return "npx-execution";
  if (basename === "yarn.exe" || basename === "yarn.cmd")
    return "yarn-operation";
  if (basename === "pnpm.exe" || basename === "pnpm.cmd")
    return "pnpm-operation";
  if (basename === "bun.exe") return "bun-operation";
  if (basename === "corepack.exe" || basename === "corepack.cmd")
    return "corepack-operation";
  if (basename === "node-gyp.exe" || basename === "node-gyp.cmd")
    return "node-gyp-operation";
  if (basename === "go.exe" || basename === "go") return "go-build";
  if (
    basename === "cargo.exe" ||
    basename === "cargo" ||
    basename === "rustc.exe" ||
    basename === "rustc"
  ) {
    return "cargo-operation";
  }
  if (
    /^(gradle|gradlew)(\.exe|\.cmd|\.bat)?$/.test(basename) ||
    ((basename === "java.exe" || basename === "java") &&
      /\b(?:org\.gradle|gradle-launcher|gradlew?)\b/.test(normalized))
  ) {
    return "gradle-operation";
  }
  if (
    /^(mvn|mvnw)(\.exe|\.cmd|\.bat)?$/.test(basename) ||
    ((basename === "java.exe" || basename === "java") &&
      /\b(?:maven|plexus|mvnw?)\b/.test(normalized))
  ) {
    return "maven-operation";
  }
  if (/^(dotnet|nuget|msbuild)(\.exe)?$/.test(basename)) {
    return "nuget-operation";
  }
  if (
    /\b_npx\b/.test(normalized) ||
    /(?:^|\s)npx(?:\.cmd|\.exe)?(?:\s|$)/.test(normalized)
  ) {
    return "npx-execution";
  }
  if (
    /(?:^|\s)npm(?:\.cmd|\.exe)?\s+(?:cache|install|ci|update|pack)\b/.test(
      normalized,
    )
  ) {
    return "npm-cache-operation";
  }
  if (
    /(?:electron|node)[^\r\n]*(?:download|install\.js|postinstall)/.test(
      normalized,
    )
  )
    return "electron-download";
  if (/\\npm-cache\\_npx(?:\\|\s|$)/.test(normalized)) return "npx-execution";
  if (/\\uv\\cache(?:\\|\s|$)/.test(normalized)) return "uv-operation";
  if (/\b(update|updater|squirrel)\b/.test(basename)) return "updater";
  if (/^(chrome|brave|msedge|firefox)(\.exe)?$/.test(basename))
    return "browser";
  if (
    /^(code|code - insiders|cursor|windsurf|windsurf - next|trae|qoder|studio64|idea64|pycharm64|webstorm64|rider64)(\.exe)?$/.test(
      basename,
    )
  ) {
    return "editor";
  }
  if (/^(dwm|nvcontainer)(\.exe)?$/.test(basename)) return "graphics";
  return "unknown";
}

function resolveProcessApplicationId(
  processName: string,
  executablePath: string | undefined,
  environment: CleanerEnvironment,
): string | undefined {
  if (!executablePath) return undefined;
  let normalizedExecutable: string;
  try {
    normalizedExecutable = normalizeWindowsPath(executablePath);
  } catch {
    return undefined;
  }
  const basename = path.win32.basename(processName).toLowerCase();
  const matches = CLEANER_APPLICATION_DEFINITIONS.filter((definition) =>
    definition.executableSignatures.some((signature) => {
      const basenameMatches = signature.basenames.some(
        (candidate) => candidate.toLowerCase() === basename,
      );
      if (!basenameMatches) return false;
      return signature.knownPaths(environment).some((knownPath) => {
        try {
          return normalizeWindowsPath(knownPath) === normalizedExecutable;
        } catch {
          return false;
        }
      });
    }),
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

function extractBoundedWindowsPathReferences(command: string): string[] {
  const matches =
    command.match(/[A-Za-z]:[\\/][^"'\r\n|<>]{1,500}/g)?.slice(0, 8) ?? [];
  const results = new Set<string>();
  for (const match of matches) {
    const candidate = match.trim().replace(/[),;]+$/g, "");
    try {
      results.add(normalizeWindowsPath(candidate));
    } catch {
      // Only canonical local paths are retained.
    }
  }
  return [...results];
}

function inferExecutablePath(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const quoted = command.match(/^"([^"]+\.exe)"/i)?.[1];
  if (quoted) return quoted;
  return command.match(/^([A-Za-z]:[\\/][^\r\n]+?\.exe)(?:\s|$)/i)?.[1];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseStartedAt(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
