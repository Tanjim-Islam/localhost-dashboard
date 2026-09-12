import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { parseLsofListeningOutput } from "../server-detection";
import type { Listener } from "./types";

const run = promisify(execFile);

export function parseNetstatListeners(output: string): Listener[] {
  const result: Listener[] = [];
  const expression = /^\s*TCP\S*\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i;
  for (const line of output.split(/\r?\n/)) {
    const match = expression.exec(line);
    if (match) result.push({ pid: Number(match[2]), localPort: Number(match[1]) });
  }
  return result;
}

// Restart uses a fresh OS listener table, without scanner caching or port filters.
// Failure is not an empty table: callers must leave the original process alone.
export async function readListeners(platform: NodeJS.Platform = process.platform): Promise<Listener[]> {
  if (platform === "win32") {
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/netstat.exe");
    const { stdout } = await run(executable, ["-ano", "-p", "tcp"], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return parseNetstatListeners(stdout);
  }
  if (platform === "darwin") {
    try {
      const { stdout } = await run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fp", "-Fn"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      return parseLsofListeningOutput(stdout);
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      // lsof returns 1 for no matches. Any diagnostic means incomplete evidence.
      if (failure.code === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return [];
      throw error;
    }
  }
  throw new Error("Unsupported platform.");
}
