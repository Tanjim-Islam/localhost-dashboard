import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { NativeProcessHost } from "./native-host";
import { buildRestartPlan, descendants, type RestartPlan } from "./plan";
import { readListeners } from "./listeners";
import { recoverNpmContexts } from "./npm-context";
import { RestartError, sameProcess, validateServerRef, type LaunchContext, type Listener, type ProcessIdentity, type ProcessSnapshot, type RestartProgress, type RestartResult, type ServerRef } from "./types";

export type TrackedServer = ServerRef & { pid: number; port: number; processStarted?: string };
type Host = Pick<NativeProcessHost, "snapshot" | "interrupt" | "stop" | "dispose">;
type RunningChild = { pid: number; exited: () => boolean; detach: () => void };

export type RestartDependencies = {
  platform: NodeJS.Platform;
  ownPid: number;
  getServer: (ref: ServerRef) => TrackedServer | undefined;
  createHost: () => Host;
  listeners: () => Promise<Listener[]>;
  launch: (context: LaunchContext) => Promise<RunningChild>;
  preflight: (context: LaunchContext) => Promise<void>;
  progress: (event: RestartProgress) => void;
  completed: (oldPids: number[]) => Promise<void>;
  pause: (ms: number) => Promise<void>;
  now: () => number;
  startupTimeoutMs: number;
};

export async function launchServer(context: LaunchContext): Promise<RunningChild> {
  // The exact server environment replaces Electron's environment. Do not merge
  // process.env, invoke a login shell, infer a package script, or persist output.
  const child = spawn(context.executable, context.argv.slice(1), {
    argv0: context.argv[0], cwd: context.cwd, env: context.env,
    shell: false, detached: true, windowsHide: true, stdio: "ignore",
  });
  let exited = false;
  child.on("exit", () => { exited = true; });
  child.on("error", () => { exited = true; });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new RestartError("The original server stopped, but its launch command could not be started. Run it from its terminal.")));
  });
  return { pid: child.pid!, exited: () => exited, detach: () => child.unref() };
}

export function createRestartDependencies(
  resourceDir: string,
  callbacks: Pick<RestartDependencies, "getServer" | "progress" | "completed">,
): RestartDependencies {
  return {
    ...callbacks, platform: process.platform, ownPid: process.pid,
    createHost: () => new NativeProcessHost(resourceDir),
    listeners: () => readListeners(), launch: launchServer,
    preflight: async (context) => {
      const [executable, cwd] = await Promise.all([fs.stat(context.executable), fs.stat(context.cwd)]);
      if (!executable.isFile() || !cwd.isDirectory()) throw new RestartError("The original executable or project folder is missing. The server has been left running.");
    },
    pause: delay, now: Date.now, startupTimeoutMs: 45000,
  };
}

export class ServerRestartController {
  private busy = false;
  private current: RestartProgress | null = null;
  constructor(private deps: RestartDependencies) {}
  getState(): RestartProgress | null { return this.current; }
  isBusy(): boolean { return this.busy; }

  async restart(input: unknown): Promise<RestartResult> {
    const ref = validateServerRef(input);
    if (this.busy) return { ok: false, port: Number(ref.key.split(":")[1]), message: "A server restart is already in progress." };
    const server = this.deps.getServer(ref);
    if (!server || server.firstSeen !== ref.firstSeen) return { ok: false, port: Number(ref.key.split(":")[1]), message: "This server changed or stopped. Refresh and try again." };
    this.busy = true;
    const host = this.deps.createHost();
    let stopped = false;
    let stoppedPids: number[] = [];
    let child: RunningChild | undefined;
    const emit = (phase: RestartProgress["phase"], message: string) => {
      this.current = { ...ref, port: server.port, phase, message };
      this.deps.progress(this.current);
    };
    try {
      emit("preparing", "Checking the server's launch command and project folder...");
      if (this.deps.platform !== "win32" && this.deps.platform !== "darwin") throw new RestartError("Server restart is available on Windows and macOS.");
      const rawSnapshot = await host.snapshot(server.pid);
      const protectedPids = this.protectedPids(rawSnapshot);
      const snapshot = await recoverNpmContexts(rawSnapshot, this.deps.platform, protectedPids);
      const selected = snapshot.processes.find((p) => p.pid === server.pid);
      const started = server.processStarted ? new Date(server.processStarted).getTime() : NaN;
      if (!selected || !Number.isFinite(started) || Math.abs(started - selected.startedMs) > 2000) {
        throw new RestartError("The server's process identity cannot be confirmed. Refresh and try again.");
      }
      const listeners = await this.deps.listeners();
      if (!listeners.some((l) => l.pid === server.pid && l.localPort === server.port)) throw new RestartError("This server no longer owns the port. Refresh and try again.");
      const plan = buildRestartPlan(snapshot, listeners, server.pid, this.deps.platform, protectedPids);
      await this.deps.preflight(plan.launch);
      const fresh = await host.snapshot(server.pid);
      if (plan.tree.some((p) => !fresh.processes.some((q) => sameProcess(p, q)))) {
        throw new RestartError("The server's process tree changed during preparation. Try again.");
      }
      const freshTree = descendants(plan.launch, fresh.processes);
      if (freshTree.length !== plan.tree.length) throw new RestartError("The server started another child process. Try again once startup finishes.");
      emit("stopping", "Stopping the server and its child processes...");
      stopped = true;
      await this.stopTree(host, plan);
      stoppedPids = plan.tree.map((p) => p.pid);
      const beforeStart = await this.deps.listeners();
      if (beforeStart.some((l) => plan.ports.includes(l.localPort))) {
        throw new RestartError("The original server stopped, but another process took its port. No replacement was started.");
      }
      emit("starting", "Starting the project and waiting for its original port...");
      child = await this.deps.launch(plan.launch);
      await this.waitForReady(host, plan, child);
      await this.deps.completed(stoppedPids);
      const message = `Restarted on ${plan.ports.map((p) => `:${p}`).join(", ")}.`;
      emit("ready", message);
      return { ok: true, port: server.port, message };
    } catch (error) {
      // Never forward OS exception messages, stdout, stderr, argv, or environment.
      const message = error instanceof RestartError ? error.message : stopped
        ? "Restart could not be verified. Check the project and its port before starting another copy."
        : "Cannot recover this server's launch details safely. The server has been left running.";
      emit("failed", message);
      if (stopped) await this.deps.completed(stoppedPids).catch(() => {});
      return { ok: false, port: server.port, message };
    } finally {
      child?.detach();
      host.dispose();
      this.busy = false;
    }
  }

  private protectedPids(snapshot: ProcessSnapshot): Set<number> {
    const protectedPids = new Set([this.deps.ownPid]);
    let item = snapshot.processes.find((p) => p.pid === this.deps.ownPid);
    for (let i = 0; item && i < 32; i++) {
      protectedPids.add(item.pid);
      item = snapshot.processes.find((p) => p.pid === item!.ppid && p.startedMs <= item!.startedMs);
      if (item && protectedPids.has(item.pid)) break;
    }
    return protectedPids;
  }

  private async stopTree(host: Host, plan: RestartPlan): Promise<void> {
    // Windows Ctrl+C is broadcast to a console. The helper sends it only when
    // every console process belongs to this tree, otherwise use verified handles.
    const interrupted = await host.interrupt(plan.tree);
    let remaining = plan.tree;
    const graceDeadline = this.deps.now() + (interrupted ? 5000 : 0);
    do {
      const snapshot = await host.snapshot();
      remaining = plan.tree.filter((p) => snapshot.processes.some((q) => sameProcess(p, q)));
      // Refuse to launch while a watcher has introduced descendants not captured
      // by the plan. Stop those only after a fresh parent/start-time association.
      for (const root of remaining) {
        for (const child of descendants(root, snapshot.processes)) {
          if (!plan.tree.some((p) => p.pid === child.pid)) plan.tree.push(child);
        }
      }
      remaining = plan.tree.filter((p) => snapshot.processes.some((q) => sameProcess(p, q)));
      if (!remaining.length) return;
      if (this.deps.now() >= graceDeadline) break;
      await this.deps.pause(200);
    } while (true);
    // Stop launcher first so a watcher cannot respawn a child while it is stopped.
    await host.stop(remaining);
    const stoppedAt = this.deps.now();
    for (let attempt = 0; attempt < 15; attempt++) {
      const snapshot = await host.snapshot();
      const newChildren: ProcessIdentity[] = [];
      for (const original of [...plan.tree]) {
        for (const member of descendants(original, snapshot.processes)) {
          if (member.startedMs <= stoppedAt && !plan.tree.some((p) => sameProcess(p, member))) {
            plan.tree.push(member);
            newChildren.push(member);
          }
        }
      }
      if (newChildren.length) await host.stop(newChildren);
      if (!plan.tree.some((p) => snapshot.processes.some((q) => sameProcess(p, q)))) return;
      await this.deps.pause(200);
    }
    throw new RestartError("The server could not be fully stopped. No replacement was started.");
  }

  private async waitForReady(host: Host, plan: RestartPlan, child: RunningChild): Promise<void> {
    const deadline = this.deps.now() + this.deps.startupTimeoutMs;
    let stableSince: number | undefined;
    let launchedRoot: ProcessIdentity | undefined;
    const known = new Map<number, ProcessIdentity>();
    do {
      // Read sockets first. A launcher can create a listening child between OS
      // reads, so the process snapshot must be newer than the observed socket.
      const listeners = await this.deps.listeners();
      const snapshot = await host.snapshot();
      const root = snapshot.processes.find((p) => p.pid === child.pid);
      if (root && !launchedRoot && !child.exited() && root.executable === plan.launch.executable) launchedRoot = root;
      if (root && launchedRoot && sameProcess(root, launchedRoot)) {
        for (const item of descendants(root, snapshot.processes)) known.set(item.pid, item);
      }
      const live = new Set(snapshot.processes.filter((p) => known.has(p.pid) && sameProcess(p, known.get(p.pid)!)).map((p) => p.pid));
      if (listeners.some((l) => plan.ports.includes(l.localPort) && !live.has(l.pid) && snapshot.processes.some((p) => p.pid === l.pid))) {
        throw new RestartError("A different process took the original port. Restart was not confirmed. Check the project before retrying.");
      }
      const ready = plan.ports.every((port) => listeners.some((l) => l.localPort === port && live.has(l.pid)));
      if (ready) {
        stableSince ??= this.deps.now();
        if (this.deps.now() - stableSince >= 1000) return;
      } else stableSince = undefined;
      if (child.exited() && !live.size) {
        throw new RestartError("The project exited before reopening its port. Check its configuration, then start it from its terminal.");
      }
      await this.deps.pause(250);
    } while (this.deps.now() < deadline);
    throw new RestartError("The project was started, but its original port did not return within 45 seconds. It may still be starting. Check it before launching another copy.");
  }
}
