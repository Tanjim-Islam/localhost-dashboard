// Launch contexts contain private process environment values. Main process only.
export type ProcessIdentity = {
  pid: number;
  ppid: number;
  started: string;
  startedMs: number;
  executable: string;
};

export type LaunchContext = ProcessIdentity & {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

export type ProcessSnapshot = {
  processes: ProcessIdentity[];
  contexts: LaunchContext[];
};

export type Listener = { pid: number; localPort: number };
export type ServerRef = { key: string; firstSeen: number };
export type RestartResult = { ok: boolean; port: number; message: string };
export type RestartPhase = "preparing" | "stopping" | "starting" | "ready" | "failed";
export type RestartProgress = {
  key: string;
  port: number;
  phase: RestartPhase;
  message: string;
};

export function validateServerRef(value: unknown): ServerRef {
  if (!value || typeof value !== "object") throw new Error("Invalid server reference.");
  const ref = value as Record<string, unknown>;
  if (
    typeof ref.key !== "string" || !/^[1-9]\d{0,9}:[1-9]\d{0,4}$/.test(ref.key) ||
    typeof ref.firstSeen !== "number" || !Number.isSafeInteger(ref.firstSeen) || ref.firstSeen <= 0
  ) throw new Error("Invalid server reference.");
  const [pid, port] = ref.key.split(":").map(Number);
  if (pid > 0x7fffffff || port > 65535) throw new Error("Invalid server reference.");
  return { key: ref.key, firstSeen: ref.firstSeen };
}

export class RestartError extends Error {}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.started === b.started && a.executable === b.executable;
}
