import path from "node:path";
import type { CleanerFilesystem } from "./types";

const PROTECTED_MARKER_NAMES = new Set([
  ".git",
  "history",
  "backups",
  "workspacestorage",
  "globalstorage",
  "modulardata",
  "projects",
  "worktrees",
  "local storage",
  "indexeddb",
  "webstorage",
  "session storage",
  "databases",
  "extensions",
  "models",
  "runtimes",
  "conda-meta",
  "plugins",
  "localhistory",
  "settings",
  "vcs",
]);

export function isCleanerProtectedMarkerName(name: string): boolean {
  return PROTECTED_MARKER_NAMES.has(name.toLowerCase());
}

export type CleanerProtectedMarkerScan = {
  markers: string[];
  internalReparsePoints: number;
  inaccessibleEntries: number;
  complete: boolean;
};

export async function scanCleanerProtectedMarkers(
  filesystem: CleanerFilesystem,
  targetPath: string,
  options?: {
    maxEntries?: number;
    maxDepth?: number;
    maxDurationMs?: number;
  },
): Promise<CleanerProtectedMarkerScan> {
  const maxEntries = options?.maxEntries ?? 2_000;
  const maxDepth = options?.maxDepth ?? 8;
  const maxDurationMs = options?.maxDurationMs ?? 1_500;
  const startedAt = Date.now();
  const queue = [{ targetPath, depth: 0, root: true }];
  let queueIndex = 0;
  const markers = new Set<string>();
  let internalReparsePoints = 0;
  let inaccessibleEntries = 0;
  let inspected = 0;
  let limitReached = false;

  while (
    queueIndex < queue.length &&
    inspected < maxEntries &&
    Date.now() - startedAt < maxDurationMs
  ) {
    const current = queue[queueIndex++]!;
    try {
      const stat = await filesystem.lstat(current.targetPath);
      inspected += 1;
      if (stat.isSymbolicLink || stat.isReparsePoint) {
        if (!current.root) internalReparsePoints += 1;
        continue;
      }
      if (!stat.isDirectory || current.depth >= maxDepth) continue;
      for await (const entries of readMarkerBatches(
        filesystem,
        current.targetPath,
      )) {
        for (const entry of entries) {
          if (
            inspected >= maxEntries ||
            Date.now() - startedAt >= maxDurationMs
          ) {
            limitReached = true;
            break;
          }
          inspected += 1;
          if (entry.isSymbolicLink) {
            internalReparsePoints += 1;
            continue;
          }
          if (isCleanerProtectedMarkerName(entry.name)) {
            markers.add(entry.name);
          }
          if (entry.isDirectory) {
            queue.push({
              targetPath: path.join(current.targetPath, entry.name),
              depth: current.depth + 1,
              root: false,
            });
          }
        }
        if (limitReached) break;
      }
    } catch {
      inaccessibleEntries += 1;
    }
    if (limitReached) break;
    if (inspected % 128 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return {
    markers: [...markers].slice(0, 32),
    internalReparsePoints,
    inaccessibleEntries,
    complete:
      !limitReached && queueIndex >= queue.length && inaccessibleEntries === 0,
  };
}

async function* readMarkerBatches(
  filesystem: CleanerFilesystem,
  targetPath: string,
): AsyncIterable<import("./types").CleanerDirectoryEntry[]> {
  if (filesystem.readDirectoryBatches) {
    yield* filesystem.readDirectoryBatches(targetPath, 256);
    return;
  }
  yield await filesystem.readDirectory(targetPath);
}
