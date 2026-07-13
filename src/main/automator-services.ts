import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type {
  DetectedAutomatorProcess,
  MacProcessRow,
} from "./automator-detection";

export type ServiceScriptEntry = {
  key: string;
  pid?: number;
  ppid?: number;
  processName?: string;
  scriptPath: string;
  scriptName: string;
  sourceKind: "service-workflow" | "service-script";
  sourceLabel: string;
  status: "running" | "installed";
  firstSeen?: number;
  lastSeen: number;
  runtimeSeconds?: number;
  command?: string;
  processPath?: string;
  canOpenInAutomator: boolean;
};

const SCRIPT_EXTENSIONS = new Set([
  ".workflow",
  ".app",
  ".scpt",
  ".applescript",
  ".swift",
  ".sh",
  ".command",
  ".js",
  ".ts",
  ".py",
  ".rb",
  ".pl",
]);

export function getUserServicesPath(): string {
  return path.join(os.homedir(), "Library", "Services");
}

export async function discoverServiceScriptEntries(
  servicesPath = getUserServicesPath(),
  processRows: MacProcessRow[] = [],
): Promise<ServiceScriptEntry[]> {
  let itemNames: string[];
  try {
    itemNames = await fs.readdir(servicesPath);
  } catch {
    return [];
  }

  const now = Date.now();
  const entries: ServiceScriptEntry[] = [];

  for (const itemName of itemNames) {
    if (itemName.startsWith(".")) continue;

    const itemPath = path.join(servicesPath, itemName);
    const ext = path.extname(itemName).toLowerCase();
    if (!SCRIPT_EXTENSIONS.has(ext)) continue;
    const stats = await safeStats(itemPath);
    if (!stats) continue;
    if (stats.isDirectory() && ext !== ".workflow" && ext !== ".app") continue;

    const running = findRunningProcessForPath(itemPath, processRows);
    const sourceKind = ext === ".workflow" || ext === ".app" ? "service-workflow" : "service-script";

    entries.push({
      key: itemPath,
      pid: running?.pid,
      ppid: running?.ppid,
      processName: running ? processNameFromCommand(running.commandLine) : undefined,
      scriptPath: itemPath,
      scriptName: displayNameFromServicesItem(itemName),
      sourceKind,
      sourceLabel: sourceKind === "service-workflow" ? "Automator workflow" : "Services script",
      status: running ? "running" : "installed",
      firstSeen: running?.elapsedSeconds ? now - running.elapsedSeconds * 1000 : stats?.birthtimeMs,
      lastSeen: now,
      runtimeSeconds: running?.elapsedSeconds,
      command: running?.commandLine,
      canOpenInAutomator: ext === ".workflow" || ext === ".app",
    });
  }

  return entries.sort((a, b) => a.scriptName.localeCompare(b.scriptName));
}

export function attachAnonymousWorkflowRunners(
  entries: ServiceScriptEntry[],
  runnerProcesses: DetectedAutomatorProcess[],
): ServiceScriptEntry[] {
  const next = entries.map((entry) => ({ ...entry }));
  const workflowsWithoutPid = next
    .filter(
      (entry) => entry.sourceKind === "service-workflow" && !entry.pid,
    )
    .sort((a, b) => a.scriptName.localeCompare(b.scriptName));

  if (
    workflowsWithoutPid.length === 0 ||
    workflowsWithoutPid.length !== runnerProcesses.length
  ) {
    return next;
  }

  const now = Date.now();
  const runners = [...runnerProcesses].sort((a, b) => a.pid - b.pid);

  workflowsWithoutPid.forEach((entry, index) => {
    const runner = runners[index];
    entry.pid = runner.pid;
    entry.ppid = runner.ppid;
    entry.processName = runner.processName;
    entry.status = "running";
    entry.firstSeen =
      typeof runner.elapsedSeconds === "number"
        ? now - runner.elapsedSeconds * 1000
        : entry.firstSeen;
    entry.runtimeSeconds = runner.elapsedSeconds;
    entry.command = runner.commandLine;
    entry.processPath = runner.processPath;
  });

  return next.sort((a, b) => a.scriptName.localeCompare(b.scriptName));
}

function findRunningProcessForPath(
  scriptPath: string,
  processRows: MacProcessRow[],
): MacProcessRow | undefined {
  return processRows.find((row) => row.commandLine.includes(scriptPath));
}

function displayNameFromServicesItem(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  return withoutExtension.replace(/^~[:/]/, "");
}

function processNameFromCommand(commandLine: string): string {
  const swiftFrontend = commandLine.includes("swift-frontend");
  if (swiftFrontend) return "swift";

  const firstToken = commandLine.match(/^("[^"]+"|'[^']+'|\S+)/)?.[1];
  if (!firstToken) return "Process";
  return path.basename(firstToken.replace(/^["']|["']$/g, ""));
}

async function safeStats(itemPath: string) {
  try {
    return await fs.stat(itemPath);
  } catch {
    return undefined;
  }
}
