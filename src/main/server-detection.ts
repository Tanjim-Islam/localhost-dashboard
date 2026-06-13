export type ParsedListener = {
  protocol: "tcp";
  localPort: number;
  pid: number;
  state: "LISTEN";
};

export function shouldIgnoreListener(
  platform: NodeJS.Platform,
  port: number,
  processName?: string,
  commandOrPath?: string,
): boolean {
  if (platform !== "darwin" || port !== 5000) return false;

  const haystack = `${processName ?? ""} ${commandOrPath ?? ""}`.toLowerCase();
  return (
    haystack.includes("controlcenter") ||
    haystack.includes("/system/library/coreservices/controlcenter.app/")
  );
}

export function parseNumericPort(value: unknown): number | undefined {
  const port =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

export function parseNumericPid(value: unknown): number | undefined {
  const pid =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

export function parseLsofListeningOutput(stdout: string): ParsedListener[] {
  const listeners: ParsedListener[] = [];
  let currentPid: number | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const pidMatch = line.match(/^p(\d+)$/);
    if (pidMatch) {
      currentPid = Number.parseInt(pidMatch[1], 10);
      continue;
    }

    const portMatch = line.match(/^n.+?:(\d+)$/);
    if (portMatch && currentPid) {
      listeners.push({
        protocol: "tcp",
        localPort: Number.parseInt(portMatch[1], 10),
        pid: currentPid,
        state: "LISTEN",
      });
    }
  }

  return listeners;
}
