import pidusage from "pidusage";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { settings } from "./settings";
import {
  detectAutomatorProcesses,
  parsePsOutput,
  type AutomatorSourceKind,
} from "./automator-detection";
import {
  attachAnonymousWorkflowRunners,
  discoverServiceScriptEntries,
  getUserServicesPath,
} from "./automator-services";

const execFileAsync = promisify(execFile);

export type AutomatorScriptInfo = {
  key: string;
  pid?: number;
  ppid?: number;
  processName?: string;
  scriptName: string;
  sourceKind: AutomatorSourceKind;
  sourceLabel: string;
  status: "running" | "installed";
  firstSeen: number;
  lastSeen: number;
  command?: string;
  scriptPath?: string;
  processPath?: string;
  runtimeSeconds?: number;
  canOpenInAutomator: boolean;
  cpu?: number;
  memory?: number;
};

type AutomatorSnapshot = Omit<
  AutomatorScriptInfo,
  "firstSeen" | "lastSeen" | "cpu" | "memory"
> & {
  firstSeen?: number;
  runtimeSeconds?: number;
};

export class AutomatorScanner extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private items = new Map<string, AutomatorScriptInfo>();

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
      const processes = await getAutomatorProcesses();
      const keys = new Set<string>();

      for (const proc of processes) {
        const key = proc.key;
        keys.add(key);

        const processStartedAt =
          typeof proc.runtimeSeconds === "number"
            ? now - proc.runtimeSeconds * 1000
            : proc.firstSeen ?? now;

        let rec = this.items.get(key);
        if (!rec) {
          rec = {
            ...proc,
            key,
            firstSeen: processStartedAt,
            lastSeen: now,
          };
          this.items.set(key, rec);
          if (rec.status === "running") this.emit("new", rec);
        } else {
          rec.lastSeen = now;
          rec.pid = proc.pid;
          rec.ppid = proc.ppid;
          rec.processName = proc.processName;
          rec.scriptName = proc.scriptName;
          rec.sourceKind = proc.sourceKind;
          rec.sourceLabel = proc.sourceLabel;
          rec.status = proc.status;
          rec.command = proc.command;
          rec.scriptPath = proc.scriptPath;
          rec.processPath = proc.processPath;
          rec.runtimeSeconds = proc.runtimeSeconds;
          rec.canOpenInAutomator = proc.canOpenInAutomator;
          if (typeof proc.runtimeSeconds === "number") {
            rec.firstSeen = processStartedAt;
          }
        }
      }

      for (const [key, rec] of this.items) {
        if (!keys.has(key) && now - rec.lastSeen > settings.get("scanIntervalMs") * 2) {
          this.items.delete(key);
          if (rec.status === "running") this.emit("stopped", rec);
        }
      }

      for (const rec of this.items.values()) {
        if (!rec.pid) {
          rec.cpu = undefined;
          rec.memory = undefined;
          continue;
        }
        try {
          const usage = await pidusage(rec.pid);
          rec.cpu = usage.cpu;
          rec.memory = usage.memory;
        } catch {
          // Process may have exited between ps and pidusage.
        }
      }

      this.emit("update", this.getItems());
    } catch (err) {
      this.emit("error", err);
    }
  }

  getItems(): AutomatorScriptInfo[] {
    return Array.from(this.items.values()).sort((a, b) =>
      a.scriptName.localeCompare(b.scriptName),
    );
  }
}

async function getAutomatorProcesses(): Promise<
  AutomatorSnapshot[]
> {
  if (process.platform !== "darwin") return [];

  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,etime=,command="],
    { maxBuffer: 1024 * 1024 },
  );

  const rows = parsePsOutput(stdout);
  const servicesPath = getUserServicesPath();
  const detected = detectAutomatorProcesses(rows);
  const serviceEntries = attachAnonymousWorkflowRunners(
    await discoverServiceScriptEntries(servicesPath, rows),
    detected.filter(
      (proc) =>
        !proc.scriptPath &&
        (proc.sourceKind === "workflow-service-runner" ||
          proc.sourceKind === "automator-runner"),
    ),
  );
  const servicePrefix = `${path.resolve(servicesPath)}${path.sep}`;

  const pathBackedProcesses = detected
    .filter((proc) => {
      if (!proc.scriptPath) return false;
      const scriptPath = path.resolve(proc.scriptPath);
      return !scriptPath.startsWith(servicePrefix);
    })
    .map((proc) => ({
      key: proc.scriptPath || String(proc.pid),
      pid: proc.pid,
      ppid: proc.ppid,
      processName: proc.processName,
      scriptName: proc.scriptName,
      sourceKind: proc.sourceKind,
      sourceLabel: proc.sourceLabel,
      status: "running" as const,
      command: proc.commandLine,
      scriptPath: proc.scriptPath,
      processPath: proc.processPath,
      runtimeSeconds: proc.elapsedSeconds,
      canOpenInAutomator: proc.canOpenInAutomator,
    }));

  return [...serviceEntries, ...pathBackedProcesses];
}
