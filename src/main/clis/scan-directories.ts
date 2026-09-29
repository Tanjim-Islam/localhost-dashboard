import path from "node:path";
import { stableCliId } from "./fingerprint";

export function normalizeScanDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter((item): item is string => {
      if (
        typeof item !== "string" ||
        !path.isAbsolute(item) ||
        item.length > 1024 ||
        item.includes("\0")
      )
        return false;
      const key =
        process.platform === "win32"
          ? path.normalize(item).toLowerCase()
          : path.normalize(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

export function scanDirectoryId(directory: string): string {
  return stableCliId("scan-folder", {
    path: process.platform === "win32" ? directory.toLowerCase() : directory,
  });
}
