import * as path from "node:path";

export type AutomatorSourceKind =
  | "service-workflow"
  | "service-script"
  | "workflow-service-runner"
  | "automator-runner"
  | "automator-app"
  | "workflow"
  | "osascript";

export type MacProcessRow = {
  pid: number;
  ppid: number;
  elapsedSeconds?: number;
  commandLine: string;
};

export type DetectedAutomatorProcess = {
  pid: number;
  ppid: number;
  processName: string;
  scriptName: string;
  sourceKind: AutomatorSourceKind;
  sourceLabel: string;
  commandLine: string;
  elapsedSeconds?: number;
  processPath?: string;
  scriptPath?: string;
  canOpenInAutomator: boolean;
};

const WORKFLOW_SERVICE_RUNNER = "WorkflowServiceRunner.xpc/Contents/MacOS/WorkflowServiceRunner";
const AUTOMATOR_RUNNER = "com.apple.automator.runner.xpc/Contents/MacOS/com.apple.automator.runner";
const AUTOMATOR_APP_STUB = ".app/Contents/MacOS/Application Stub";

export function parsePsOutput(stdout: string): MacProcessRow[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parsePsLine)
    .filter((row): row is MacProcessRow => Boolean(row));
}

export function parseElapsedSeconds(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const daySplit = trimmed.split("-");
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const timePart = daySplit.length === 2 ? daySplit[1] : daySplit[0];
  if (!Number.isFinite(days)) return undefined;

  const parts = timePart.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return undefined;

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 86400 + minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  return undefined;
}

export function detectAutomatorProcesses(
  rows: MacProcessRow[],
): DetectedAutomatorProcess[] {
  const detected: DetectedAutomatorProcess[] = [];

  for (const row of rows) {
    const commandLine = row.commandLine;
    const lower = commandLine.toLowerCase();

    if (lower.includes("shortcutsviewservice")) {
      continue;
    }

    if (commandLine.includes(WORKFLOW_SERVICE_RUNNER)) {
      detected.push({
        ...baseDetection(row, "WorkflowServiceRunner"),
        sourceKind: "workflow-service-runner",
        sourceLabel: "Workflow service runner",
        processPath: extractBundlePath(commandLine, "xpc"),
        canOpenInAutomator: false,
      });
      continue;
    }

    if (commandLine.includes(AUTOMATOR_RUNNER)) {
      detected.push({
        ...baseDetection(row, "Automator Runner"),
        sourceKind: "automator-runner",
        sourceLabel: "Automator runner",
        processPath: extractBundlePath(commandLine, "xpc"),
        canOpenInAutomator: false,
      });
      continue;
    }

    const scriptPath = extractScriptPath(commandLine);
    if (scriptPath) {
      const isWorkflow = /\.workflow$/i.test(scriptPath);
      const isApp = /\.app$/i.test(scriptPath);
      const isOsascript = lower.includes("/osascript") || lower.startsWith("osascript ");

      if (isApp && !commandLine.includes(AUTOMATOR_APP_STUB)) {
        continue;
      }

      if (isWorkflow || isApp || isOsascript) {
        detected.push({
          ...baseDetection(row, fileName(scriptPath)),
          sourceKind: isApp ? "automator-app" : isOsascript ? "osascript" : "workflow",
          sourceLabel: isApp
            ? "Automator app"
            : isOsascript
              ? "AppleScript"
              : "Automator workflow",
          scriptPath,
          processPath: extractExecutablePath(commandLine),
          canOpenInAutomator: isWorkflow || isApp,
        });
      }
    }
  }

  return detected.sort((a, b) => a.scriptName.localeCompare(b.scriptName));
}

function parsePsLine(line: string): MacProcessRow | null {
  const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;

  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    elapsedSeconds: parseElapsedSeconds(match[3]),
    commandLine: match[4],
  };
}

function baseDetection(row: MacProcessRow, scriptName: string) {
  return {
    pid: row.pid,
    ppid: row.ppid,
    processName: processNameFromCommand(row.commandLine),
    scriptName,
    commandLine: row.commandLine,
    elapsedSeconds: row.elapsedSeconds,
  };
}

function extractScriptPath(commandLine: string): string | undefined {
  return (
    extractBundlePath(commandLine, "workflow") ||
    extractBundlePath(commandLine, "app") ||
    extractBundlePath(commandLine, "scpt") ||
    extractBundlePath(commandLine, "applescript")
  );
}

function extractBundlePath(
  commandLine: string,
  extension: "workflow" | "app" | "scpt" | "applescript" | "xpc",
): string | undefined {
  const quotedPattern = new RegExp(`["']([^"']+?\\.${extension})["']`, "i");
  const quotedMatch = commandLine.match(quotedPattern);
  if (quotedMatch?.[1]) return quotedMatch[1];

  const pattern = new RegExp(
    `((?:/|~\\/)[^\\n]+?\\.${extension})(?:"|'|/|\\s|$)`,
    "i",
  );
  const match = commandLine.match(pattern);
  return match?.[1]?.replace(/^"|"$/g, "");
}

function extractExecutablePath(commandLine: string): string | undefined {
  const bundlePath =
    extractBundlePath(commandLine, "workflow") ||
    extractBundlePath(commandLine, "app") ||
    extractBundlePath(commandLine, "xpc");
  if (bundlePath && commandLine.includes(`${bundlePath}/Contents/MacOS/`)) {
    const marker = `${bundlePath}/Contents/MacOS/`;
    const rest = commandLine.slice(commandLine.indexOf(marker) + marker.length);
    const executable = rest.split(/\s--|\s-\w|\s\/|$/)[0]?.trim();
    return executable ? `${marker}${executable}` : undefined;
  }

  const firstToken = commandLine.match(/^("[^"]+"|'[^']+'|\S+)/)?.[1];
  return firstToken?.replace(/^["']|["']$/g, "");
}

function processNameFromCommand(commandLine: string): string {
  if (commandLine.includes(WORKFLOW_SERVICE_RUNNER)) return "WorkflowServiceRunner";
  if (commandLine.includes(AUTOMATOR_RUNNER)) return "com.apple.automator.runner";
  if (commandLine.includes(AUTOMATOR_APP_STUB)) return "Application Stub";

  const executablePath = extractExecutablePath(commandLine);
  return executablePath ? fileName(executablePath) : "Automator process";
}

function fileName(filePath: string): string {
  return path.basename(filePath);
}
