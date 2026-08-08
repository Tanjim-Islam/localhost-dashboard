import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CliScanEnvironment } from "../types";

export async function getMacKnownDirectories(
  environment: CliScanEnvironment,
): Promise<string[]> {
  const directories = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(environment.homeDirectory, ".local", "bin"),
    path.join(environment.homeDirectory, "bin"),
    path.join(environment.homeDirectory, ".cargo", "bin"),
    path.join(environment.homeDirectory, ".bun", "bin"),
    path.join(environment.homeDirectory, "Library", "pnpm"),
    path.join(
      environment.homeDirectory,
      "Library",
      "Android",
      "sdk",
      "platform-tools",
    ),
  ];
  directories.push(...(await readSystemPaths()));
  return directories;
}

async function readSystemPaths(): Promise<string[]> {
  const results: string[] = [];
  try {
    results.push(
      ...(await readFile("/etc/paths", "utf8"))
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    );
  } catch {
    // The app PATH and known roots still provide a useful inventory.
  }
  try {
    const files = (await readdir("/etc/paths.d")).slice(0, 128);
    for (const file of files) {
      try {
        results.push(
          ...(await readFile(path.join("/etc/paths.d", file), "utf8"))
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        );
      } catch {
        continue;
      }
    }
  } catch {
    // Optional system path fragments may not exist.
  }
  return results;
}
