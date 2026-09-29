import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { RestartError, type ProcessIdentity, type ProcessSnapshot } from "./types";

// A lazy helper keeps native inspection off Electron's main thread. One request
// at a time, bounded output/time, no diagnostics containing private launch data.
export class NativeProcessHost {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (value: unknown) => void; reject: (error: Error) => void };
  private buffer = "";
  private nextId = 0;

  constructor(private resourceDir: string, readonly platform: NodeJS.Platform = process.platform) {}

  private async start(): Promise<void> {
    if (this.child) return;
    let executable: string;
    let args: string[];
    if (this.platform === "win32") {
      executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const script = await fs.readFile(path.join(this.resourceDir, "windows-process.ps1"), "utf8");
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    } else if (this.platform === "darwin") {
      executable = path.join(this.resourceDir, "darwin-process-helper");
      args = [];
    } else throw new RestartError("Server restart is available on Windows and macOS.");
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: "pipe" });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      this.buffer += part;
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) return this.fail();
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.error || response.id !== this.nextId || !this.pending) return this.fail();
          const pending = this.pending;
          this.pending = undefined;
          pending.resolve(response.result);
        } catch { this.fail(); }
      }
    });
    child.stderr.resume();
    child.on("error", () => this.fail());
    child.on("exit", () => { if (this.child === child) this.fail(); });
    child.stdin.on("error", () => this.fail());
  }

  private fail(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.dispose();
    pending?.reject(new RestartError("Cannot inspect this process safely. Restart it from its terminal."));
  }

  async request(op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.pending) throw new RestartError("A process operation is already running.");
    await this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 12000);
      this.pending = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.child!.stdin.write(JSON.stringify({ id: ++this.nextId, op, ...payload }) + "\n");
    });
  }

  async snapshot(pid = 0): Promise<ProcessSnapshot> {
    const result = await this.request("snapshot", { pid }) as ProcessSnapshot;
    if (!result || !Array.isArray(result.processes) || !Array.isArray(result.contexts)) {
      throw new RestartError("Process inspection returned incomplete data.");
    }
    return result;
  }

  async interrupt(targets: ProcessIdentity[]): Promise<boolean> {
    const result = await this.request("interrupt", { pid: targets[0].pid, targets: targets.map(identityOnly) });
    return Array.isArray(result) ? result.some(Boolean) : result === true;
  }

  async stop(targets: ProcessIdentity[]): Promise<void> {
    await this.request("stop", { targets: targets.map(identityOnly) });
  }

  dispose(): void {
    const child = this.child;
    this.child = undefined;
    this.buffer = "";
    child?.stdin.end();
    child?.kill();
  }
}

function identityOnly({ pid, ppid, started, startedMs, executable }: ProcessIdentity): ProcessIdentity {
  return { pid, ppid, started, startedMs, executable };
}
