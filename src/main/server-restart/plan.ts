import path from "node:path";
import { isNpmLauncher } from "./npm-context";
import { RestartError, sameProcess, type LaunchContext, type Listener, type ProcessIdentity, type ProcessSnapshot } from "./types";

export type RestartPlan = {
  launch: LaunchContext;
  tree: ProcessIdentity[];
  ports: number[];
};

const runtimes = /^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)?)?|ruby(?:\d+(?:\.\d+)?)?|php(?:\d+(?:\.\d+)?)?|go|cargo|dotnet|uv|uvicorn|gunicorn|npm|pnpm|yarn)(?:\.exe)?$/i;
const shells = /^(?:cmd|powershell|pwsh|bash|zsh|sh|fish)(?:\.exe)?$/i;
const supervisors = /(?:^|[\\/\s])(?:pm2|forever)(?:[\\/\s.]|$)/i;
const serviceOwners = /^(?:services|svchost|nssm|winsw|launchd|systemd|supervisord|wsl|wslhost|docker|com\.docker\.backend)(?:\.exe)?$/i;

function basename(executable: string): string {
  return executable.replace(/\\/g, "/").split("/").pop() || "";
}

export function descendants(root: ProcessIdentity, processes: ProcessIdentity[]): ProcessIdentity[] {
  const currentRoot = processes.find((p) => p.pid === root.pid);
  if (currentRoot && !sameProcess(root, currentRoot)) return [];
  const found = [root];
  const ids = new Set([root.pid]);
  for (let i = 0; i < found.length; i++) {
    for (const item of processes) {
      if (!ids.has(item.pid) && item.ppid === found[i].pid && item.startedMs >= found[i].startedMs) {
        ids.add(item.pid);
        found.push(item);
        if (found.length > 128) throw new RestartError("This launcher has too many child processes. Restart it from its terminal.");
      }
    }
  }
  return found;
}

export function buildRestartPlan(
  snapshot: ProcessSnapshot,
  listeners: Listener[],
  pid: number,
  platform: NodeJS.Platform,
  protectedPids: Set<number>,
): RestartPlan {
  const contextByPid = new Map(snapshot.contexts.map((p) => [p.pid, p]));
  const byPid = new Map(snapshot.processes.map((p) => [p.pid, p]));
  const selected = contextByPid.get(pid);
  if (!selected) throw new RestartError("Cannot read this server's launch command and environment. Restart it from its terminal.");
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const sameCwd = (a: string, b: string) => platform === "win32"
    ? pathApi.resolve(a).toLowerCase() === pathApi.resolve(b).toLowerCase()
    : pathApi.resolve(a) === pathApi.resolve(b);
  let launch = selected;
  let cursor: ProcessIdentity = selected;
  const visited = new Set<number>();
  // Follow project launchers through npm's non-interactive shell, never through
  // an interactive terminal, IDE, service manager, or unrelated working directory.
  for (let depth = 0; depth < 12; depth++) {
    if (visited.has(cursor.pid)) throw new RestartError("The server's process tree changed. Refresh and try again.");
    visited.add(cursor.pid);
    const parent = byPid.get(cursor.ppid);
    if (!parent || parent.startedMs > cursor.startedMs || protectedPids.has(parent.pid)) break;
    const name = basename(parent.executable);
    if (serviceOwners.test(name)) throw new RestartError("This server is managed by a service or container. Restart it through its owner.");
    const ctx = contextByPid.get(parent.pid);
    if (shells.test(name)) {
      if (!ctx || !ctx.argv.some((a) => /^(?:\/c|-c)$/i.test(a))) break;
      cursor = parent;
      continue;
    }
    if (!runtimes.test(name)) {
      if (supervisors.test(parent.executable)) throw new RestartError("This server is managed by a supervisor. Restart it through that supervisor.");
      break;
    }
    const npmOwnsPackage = ctx && isNpmLauncher(ctx) && snapshot.contexts.some((child) =>
      child.env.npm_execpath && child.env.npm_package_json &&
      sameCwd(child.env.npm_execpath, ctx.argv[1] || "") &&
      sameCwd(pathApi.dirname(child.env.npm_package_json), selected.cwd));
    if (!ctx || (!sameCwd(ctx.cwd, selected.cwd) && !npmOwnsPackage)) {
      throw new RestartError("The parent launcher uses a different or unreadable project folder. Restart it from its terminal.");
    }
    launch = ctx;
    cursor = ctx;
  }
  if (!runtimes.test(basename(launch.executable))) {
    throw new RestartError("Automatic restart is available for development runtimes. Restart this application or service through its owner.");
  }
  if (!pathApi.isAbsolute(launch.executable) || !pathApi.isAbsolute(launch.cwd) ||
      launch.argv.length < 2 || !launch.argv[1] || launch.argv.some((a) => typeof a !== "string" || a.includes("\0")) ||
      !launch.env || !Object.keys(launch.env).length) {
    throw new RestartError("The original launch details are incomplete. The server has been left running.");
  }
  if (/^(?:next-server|npm |node \()/i.test(launch.argv[0])) {
    throw new RestartError("This launcher replaced its original arguments. Restart it from its terminal.");
  }
  if (supervisors.test(launch.argv.join(" "))) {
    throw new RestartError("This server is managed by a watcher or supervisor. Restart it through that launcher.");
  }
  const tree = descendants(launch, snapshot.processes);
  if (!tree.some((p) => p.pid === selected.pid) || tree.some((p) => protectedPids.has(p.pid) || p.pid <= 4)) {
    throw new RestartError("The server shares a protected process tree. It has been left running.");
  }
  const ids = new Set(tree.map((p) => p.pid));
  const owned = listeners.filter((l) => ids.has(l.pid));
  const selectedPorts = new Set(owned.filter((l) => l.pid === selected.pid).map((l) => l.localPort));
  // Multiple sockets of one server are restarted together. Sibling servers in a
  // monorepo launcher require restarting the launcher manually, not guessing.
  if (owned.some((l) => !selectedPorts.has(l.localPort) && !descendants(selected, snapshot.processes).some((p) => p.pid === l.pid))) {
    throw new RestartError("This launcher also runs another server. Restart the shared launcher from its terminal.");
  }
  const ports = [...new Set(owned.map((l) => l.localPort))].sort((a, b) => a - b);
  if (!ports.length) throw new RestartError("This server is no longer listening. Refresh and try again.");
  if (listeners.some((l) => ports.includes(l.localPort) && !ids.has(l.pid))) {
    throw new RestartError("Another process also uses this port. The server has been left running.");
  }
  return { launch, tree, ports };
}
