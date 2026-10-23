import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { terminalDirectory } from "../shared/servers";

const execFileAsync = promisify(execFile);
const windowsScript = `
$ErrorActionPreference = 'Stop'
$directory = $env:LOCAL_DASHBOARD_TERMINAL_DIRECTORY
Remove-Item Env:LOCAL_DASHBOARD_TERMINAL_DIRECTORY
$terminal = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -ArgumentList '/d', '/k' -WorkingDirectory $directory -WindowStyle Normal -PassThru
Start-Sleep -Milliseconds 350
if ($terminal.HasExited) { throw 'Terminal exited before opening.' }
`;

export function terminalLaunch(
  directory: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  terminalDirectory(directory);
  if (platform === "win32")
    return {
      executable: path.win32.join(
        env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsScript, "utf16le").toString("base64"),
      ],
      env: { ...env, LOCAL_DASHBOARD_TERMINAL_DIRECTORY: directory },
    };
  if (platform === "darwin")
    return {
      executable: "/usr/bin/open",
      args: ["-a", "Terminal", "--", directory],
      env,
    };
  return { executable: "/usr/bin/x-terminal-emulator", args: [], env };
}

export async function openProjectTerminal(input: unknown): Promise<void> {
  const directory = await fs.realpath(terminalDirectory(input)).catch(() => {
    throw new Error("Project folder was not found.");
  });
  if (!(await fs.stat(directory)).isDirectory())
    throw new Error("Select a project folder.");
  const launch = terminalLaunch(directory, process.platform);
  try {
    if (process.platform === "win32" || process.platform === "darwin") {
      // Hide only the short-lived launcher. Start-Process explicitly creates a
      // visible console, rather than a detached cmd with discarded standard I/O.
      await execFileAsync(launch.executable, launch.args, {
        cwd: directory,
        env: launch.env,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 16384,
      });
    } else {
      const child = spawn(launch.executable, launch.args, {
        cwd: directory,
        env: launch.env,
        shell: false,
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      child.unref();
    }
  } catch {
    throw new Error(
      "Could not open terminal. Check that a terminal app is installed.",
    );
  }
}
