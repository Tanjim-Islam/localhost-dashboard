import si from "systeminformation";
import pidusage from "pidusage";
import { EventEmitter } from "node:events";
import { settings } from "./settings";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);

export type ServerInfo = {
  key: string; // pid:port
  pid: number;
  port: number;
  protocol: "tcp" | "udp";
  processName?: string;
  command?: string;
  path?: string;
  cwd?: string; // Current working directory of the process
  firstSeen: number;
  lastSeen: number;
  url: string;
  cpu?: number;
  memory?: number;
  framework?: string;
  cpuHistory?: number[]; // Last 6 CPU readings for sparkline
  memoryHistory?: number[]; // Last 6 memory readings for sparkline
};

function inConfiguredPorts(port: number): boolean {
  if (settings.get("scanAllPorts")) return true;
  const ports = settings.get("ports");
  for (const p of ports) {
    if (Array.isArray(p)) {
      if (port >= p[0] && port <= p[1]) return true;
    } else if (port === p) return true;
  }
  return false;
}

function guessFramework(cmd?: string, name?: string): string | undefined {
  const s = `${cmd ?? ""} ${name ?? ""}`.toLowerCase();
  if (s.includes("vite")) return "Vite";
  if (s.includes("next")) return "Next.js";
  if (s.includes("nuxt")) return "Nuxt";
  if (s.includes("remix")) return "Remix";
  if (s.includes("astro")) return "Astro";
  if (s.includes("angular") || s.includes("ng ")) return "Angular";
  if (s.includes("react-scripts")) return "CRA";
  if (s.includes("webpack-dev-server")) return "Webpack Dev Server";
  if (s.includes("uvicorn")) return "Uvicorn";
  if (s.includes("gunicorn")) return "Gunicorn";
  if (s.includes("django")) return "Django";
  if (s.includes("rails")) return "Rails";
  if (s.includes("dotnet")) return ".NET";
  if (s.includes("php")) return "PHP";
  if (s.includes("deno")) return "Deno";
  if (s.includes("go ") || s.includes("go.exe")) return "Go";
  if (s.includes("autohotkey")) return "AutoHotkey";
  return undefined;
}

// Cache for CWD lookups - keyed by PID
const cwdCache = new Map<number, { cwd: string | null; time: number }>();
const CWD_CACHE_TTL = 30000; // 30 seconds

async function getProcessCwd(pid: number): Promise<string | null> {
  // Check cache first
  const cached = cwdCache.get(pid);
  if (cached && Date.now() - cached.time < CWD_CACHE_TTL) {
    return cached.cwd;
  }

  let cwd: string | null = null;

  try {
    if (process.platform === "win32") {
      // Use wmic to get current directory on Windows
      const { stdout } = await execAsync(
        `wmic process where processid=${pid} get CommandLine /format:list`,
        { timeout: 3000 }
      );
      // Try to extract project path from command line
      // Look for paths containing common project indicators
      const cmdLine = stdout.replace(/\r?\n/g, " ").trim();
      cwd = extractProjectPath(cmdLine);
    } else {
      // On Unix, we can read /proc/<pid>/cwd
      const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`, {
        timeout: 3000,
      });
      cwd = stdout.trim() || null;
    }
  } catch {
    // Process may have exited or we don't have permissions
  }

  // Cache the result
  cwdCache.set(pid, { cwd, time: Date.now() });
  return cwd;
}

function extractProjectPath(cmdLine: string): string | null {
  if (!cmdLine) return null;

  // Normalize path separators
  const normalized = cmdLine.replace(/\\/g, "/");

  // Look for node_modules path - go up to project root
  const nodeModulesMatch = normalized.match(
    /([A-Za-z]:[^"'<>|*?\s]+|\/[^"'<>|*?\s]+)\/node_modules/i
  );
  if (nodeModulesMatch) {
    return nodeModulesMatch[1].replace(/\//g, "\\");
  }

  // Look for common config files
  const configPatterns = [
    /([A-Za-z]:[^"'<>|*?\s]+|\/[^"'<>|*?\s]+)\/(vite\.config\.[jt]s|next\.config\.[jm]?[jt]s|nuxt\.config\.[jt]s|angular\.json|package\.json)/i,
  ];

  for (const pattern of configPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return match[1].replace(/\//g, "\\");
    }
  }

  // Look for paths that look like project directories (contain src, app, etc)
  const projectDirMatch = normalized.match(
    /([A-Za-z]:[^"'<>|*?\s]+|\/[^"'<>|*?\s]+)\/(src|app|pages|components)\//i
  );
  if (projectDirMatch) {
    return projectDirMatch[1].replace(/\//g, "\\");
  }

  return null;
}

export class Scanner extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private items = new Map<string, ServerInfo>();
  private lastSnapshot = new Set<string>();

  getAllPids(): number[] {
    return Array.from(
      new Set(Array.from(this.items.values()).map((r) => r.pid))
    );
  }

  getItems(): ServerInfo[] {
    return Array.from(this.items.values());
  }

  start() {
    const interval = settings.get("scanIntervalMs");
    this.stop();
    this.scan();
    this.timer = setInterval(() => this.scan(), interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan() {
    try {
      const now = Date.now();
      const listening = await getListening();
      const interested = listening.filter(
        (c) =>
          typeof c.localPort === "number" && inConfiguredPorts(c.localPort!)
      );

      const keys = new Set<string>();
      for (const c of interested) {
        const pid = c.pid ?? 0;
        const port = c.localPort ?? 0;
        if (!pid || !port) continue;
        const key = `${pid}:${port}`;
        keys.add(key);
        let rec = this.items.get(key);
        if (!rec) {
          rec = {
            key,
            pid,
            port,
            protocol: (c.protocol?.toLowerCase() as "tcp") || "tcp",
            firstSeen: now,
            lastSeen: now,
            url: `http://localhost:${port}`,
          };
          this.items.set(key, rec);
          this.emit("new", rec);
        } else {
          rec.lastSeen = now;
        }
      }

      // remove stale
      for (const [key, rec] of this.items) {
        if (
          !keys.has(key) &&
          now - rec.lastSeen > settings.get("scanIntervalMs") * 2
        ) {
          this.items.delete(key);
          this.emit("stopped", rec);
        }
      }

      // enrich processes for all current items
      const pids = Array.from(
        new Set(Array.from(this.items.values()).map((r) => r.pid))
      );
      const procData = await si.processes();
      const byPid = new Map<
        number,
        si.Systeminformation.ProcessesProcessData
      >();
      procData.list.forEach((p) => byPid.set(p.pid, p));

      for (const rec of this.items.values()) {
        const p = byPid.get(rec.pid);
        if (p) {
          rec.processName = p.name;
          rec.command = p.command;
          rec.path = p.path;
          rec.framework = guessFramework(p.command, p.name);

          // Get CWD (project directory) - only if not already set
          if (!rec.cwd) {
            const cwd = await getProcessCwd(rec.pid);
            if (cwd) {
              rec.cwd = cwd;
            } else {
              // Fallback: try to extract from command line
              rec.cwd = extractProjectPath(p.command || "") || undefined;
            }
          }

          try {
            const usage = await pidusage(rec.pid);
            rec.cpu = usage.cpu; // percent
            rec.memory = usage.memory; // bytes

            // Track history for sparklines (keep last 6 readings)
            if (!rec.cpuHistory) rec.cpuHistory = [];
            if (!rec.memoryHistory) rec.memoryHistory = [];
            rec.cpuHistory.push(usage.cpu);
            rec.memoryHistory.push(usage.memory);
            if (rec.cpuHistory.length > 6) rec.cpuHistory.shift();
            if (rec.memoryHistory.length > 6) rec.memoryHistory.shift();
          } catch {
            // ignore
          }
        }
      }

      const payload = Array.from(this.items.values()).sort(
        (a, b) => a.port - b.port
      );
      this.emit("update", payload);
      this.lastSnapshot = keys;
    } catch (err) {
      this.emit("error", err);
    }
  }
}

type SimpleConn = {
  protocol: string;
  localPort: number;
  pid: number;
  state: string;
};

async function getListening(): Promise<SimpleConn[]> {
  const byKey = new Map<string, SimpleConn>();

  // 1) systeminformation
  try {
    const conns = await si.networkConnections();
    for (const c of conns) {
      const proto = (c.protocol || "").toLowerCase();
      const state = (c.state || "").toLowerCase();
      const port = (c as any).localPort ?? (c as any).localport;
      if (!proto.startsWith("tcp") || !state.startsWith("listen")) continue;
      if (typeof port !== "number" || port <= 0) continue;
      const pid = c.pid ?? 0;
      const key = `${pid}:${port}`;
      byKey.set(key, {
        protocol: c.protocol || "tcp",
        localPort: port,
        pid,
        state: c.state || "LISTENING",
      });
    }
  } catch {
    // ignore
  }

  // 2) Windows netstat — merge in (never treat as fallback only)
  if (process.platform === "win32") {
    try {
      // include both TCP and TCPv6 lines
      const { stdout } = await execAsync("netstat -ano");
      const lines = stdout.split(/\r?\n/);
      const re = /^\s*TCP\S*\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i;
      for (const line of lines) {
        const m = re.exec(line);
        if (m) {
          const port = parseInt(m[1], 10);
          const pid = parseInt(m[2], 10);
          const key = `${pid}:${port}`;
          if (!byKey.has(key))
            byKey.set(key, {
              protocol: "tcp",
              localPort: port,
              pid,
              state: "LISTENING",
            });
        }
      }
    } catch {
      // ignore
    }
  }

  return Array.from(byKey.values());
}
