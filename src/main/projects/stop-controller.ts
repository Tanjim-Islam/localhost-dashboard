import { randomUUID } from "node:crypto";
import {
  stopScope,
  type ServerInfo,
  type ServerRef,
  type StopPreview,
  type StopResult,
  type StopScope,
  type StopTarget,
} from "../../shared/servers";
import {
  sameProcess,
  type Listener,
  type ProcessIdentity,
  type ProcessSnapshot,
} from "../server-restart/types";

type Host = {
  snapshot(pid?: number): Promise<ProcessSnapshot>;
  stop(targets: ProcessIdentity[]): Promise<void>;
  dispose(): void;
};
export type StopDependencies = {
  items: () => ServerInfo[];
  identity: (pid: number) => ProcessIdentity | undefined;
  projectName: (id?: string) => string | undefined;
  createHost: () => Host;
  listeners: () => Promise<Listener[]>;
  ownPid: number;
  restartBusy: () => boolean;
  refresh: (stopped: ServerRef[]) => Promise<void>;
  now: () => number;
  pause: (ms: number) => Promise<void>;
};
type Prepared = {
  public: StopPreview;
  scope: StopScope;
  identities: ProcessIdentity[];
  services: Pick<
    ServerInfo,
    "key" | "firstSeen" | "pid" | "projectId" | "discovery"
  >[];
};
const portsFor = (listeners: Listener[], pid: number) =>
  [
    ...new Set(listeners.filter((l) => l.pid === pid).map((l) => l.localPort)),
  ].sort((a, b) => a - b);

export class ServerStopController {
  private prepared?: Prepared;
  private busy = false;
  private restarted = new Map<number, ProcessIdentity>();
  constructor(private deps: StopDependencies) {}
  // Only the main-process restarter can grant this exception for its verified
  // replacement listeners. PID reuse never inherits it.
  rememberRestarted(identities: ProcessIdentity[]): void {
    for (const identity of identities)
      this.restarted.set(identity.pid, { ...identity });
    while (this.restarted.size > 512)
      this.restarted.delete(this.restarted.keys().next().value!);
  }
  isBusy(): boolean {
    return this.busy;
  }
  private selected(scope: StopScope): ServerInfo[] {
    return scope.refs.map((ref) => {
      const item = this.deps
        .items()
        .find((i) => i.key === ref.key && i.firstSeen === ref.firstSeen);
      if (
        !item ||
        !item.canStop ||
        item.ignored ||
        (item.discovery !== "development" && item.discovery !== "application")
      )
        throw new Error(
          "A selected service changed or cannot be verified. Refresh and select it again.",
        );
      if (
        scope.projectId &&
        (item.discovery !== "development" ||
          item.projectId !== scope.projectId ||
          !item.association)
      )
        throw new Error(
          "Project association changed. Review the services again.",
        );
      return item;
    });
  }
  async preview(value: unknown): Promise<StopPreview> {
    return this.withHost((host) => this.prepare(value, host));
  }
  async execute(token: string): Promise<StopResult[]> {
    return this.withHost((host) => this.perform(token, host));
  }
  // One renderer action, one helper, and one operation lock across both checks.
  async stop(value: unknown): Promise<StopResult[]> {
    return this.withHost(async (host) => {
      const plan = await this.prepare(value, host);
      return this.perform(plan.token, host);
    });
  }
  private async withHost<T>(action: (host: Host) => Promise<T>): Promise<T> {
    if (this.busy || this.deps.restartBusy())
      throw new Error("A server operation is already running.");
    this.busy = true;
    let host: Host | undefined;
    try {
      host = this.deps.createHost();
      return await action(host);
    } finally {
      host?.dispose();
      this.busy = false;
    }
  }
  private async prepare(value: unknown, host: Host): Promise<StopPreview> {
    const scope = stopScope(value);
    this.prepared = undefined;
    const selected = this.selected(scope);
    const [snapshot, listeners] = await Promise.all([
      host.snapshot(),
      this.deps.listeners(),
    ]);
    const protectedPids = new Set([this.deps.ownPid]);
    let ancestor = snapshot.processes.find((p) => p.pid === this.deps.ownPid);
    for (let depth = 0; ancestor && depth < 32; depth++) {
      protectedPids.add(ancestor.pid);
      ancestor = snapshot.processes.find(
        (p) => p.pid === ancestor!.ppid && p.startedMs <= ancestor!.startedMs,
      );
      if (ancestor && protectedPids.has(ancestor.pid)) break;
    }
    for (const [pid, identity] of this.restarted)
      if (!snapshot.processes.some((p) => sameProcess(p, identity)))
        this.restarted.delete(pid);
    // Protect Dashboard helpers, while allowing exact listeners intentionally
    // relaunched by Restart. Detached servers still have Dashboard as parent.
    const children = new Set([this.deps.ownPid]);
    for (let depth = 0; depth < 32; depth++) {
      const size = children.size;
      for (const p of snapshot.processes)
        if (
          children.has(p.ppid) &&
          snapshot.processes.some(
            (parent) =>
              parent.pid === p.ppid && parent.startedMs <= p.startedMs,
          )
        )
          children.add(p.pid);
      if (size === children.size) break;
    }
    for (const pid of children) {
      const restarted = this.restarted.get(pid);
      if (
        !restarted ||
        !snapshot.processes.some((p) => sameProcess(p, restarted))
      )
        protectedPids.add(pid);
    }
    const identities: ProcessIdentity[] = [],
      targets: StopTarget[] = [];
    for (const item of selected) {
      if (identities.some((p) => p.pid === item.pid)) continue;
      const identity = this.deps.identity(item.pid);
      const current = snapshot.processes.find((p) => p.pid === item.pid);
      if (
        !identity ||
        !current ||
        !sameProcess(identity, current) ||
        protectedPids.has(item.pid) ||
        item.pid <= 4 ||
        /^(?:[a-z]:[\\/]Windows[\\/]|\/System\/|\/usr\/libexec\/)/i.test(
          current.executable,
        )
      )
        throw new Error(
          "Process identity could not be confirmed. Nothing was stopped.",
        );
      if (
        this.deps
          .items()
          .some((i) => i.pid === item.pid && i.projectId !== item.projectId)
      )
        throw new Error(
          "This process serves multiple project associations. Stop it from its terminal.",
        );
      const ports = portsFor(listeners, item.pid);
      if (!ports.includes(item.port))
        throw new Error(
          "A selected listener disappeared. Refresh and try again.",
        );
      identities.push({ ...identity });
      targets.push({
        ref: { key: item.key, firstSeen: item.firstSeen },
        pid: item.pid,
        ports,
        processName: item.processName || "Process",
        projectName: this.deps.projectName(item.projectId),
        serviceName: item.serviceName,
      });
    }
    const preview = {
      token: randomUUID(),
      expiresAt: this.deps.now() + 60000,
      targets,
    };
    this.prepared = {
      public: preview,
      scope,
      identities,
      services: this.deps
        .items()
        .filter((s) => identities.some((p) => p.pid === s.pid))
        .map(({ key, firstSeen, pid, projectId, discovery }) => ({
          key,
          firstSeen,
          pid,
          projectId,
          discovery,
        })),
    };
    return structuredClone(preview);
  }
  private async perform(token: string, host: Host): Promise<StopResult[]> {
    const plan = this.prepared;
    this.prepared = undefined;
    if (
      !plan ||
      plan.public.token !== token ||
      plan.public.expiresAt <= this.deps.now()
    )
      throw new Error("Stop request expired. Try again.");
    this.selected(plan.scope);
    const results: StopResult[] = [];
    for (let index = 0; index < plan.identities.length; index++) {
      const identity = plan.identities[index],
        target = plan.public.targets[index];
      try {
        // Earlier successes may already have disappeared from the scanner. Recheck
        // this process's original selection and ownership before each operation.
        const expected = plan.services.filter((s) => s.pid === identity.pid);
        const validateSelection = () => {
          const current = this.selected({ ...plan.scope, refs: expected });
          if (
            current.some(
              (s) =>
                s.projectId !==
                  expected.find((e) => e.key === s.key)?.projectId ||
                s.discovery !==
                  expected.find((e) => e.key === s.key)?.discovery,
            ) ||
            this.deps
              .items()
              .some(
                (s) =>
                  s.pid === identity.pid &&
                  s.projectId !== expected[0].projectId,
              )
          )
            throw new Error("changed");
        };
        validateSelection();
        const [listeners, snapshot] = await Promise.all([
          this.deps.listeners(),
          host.snapshot(),
        ]);
        if (
          !snapshot.processes.some((p) => sameProcess(p, identity)) ||
          JSON.stringify(portsFor(listeners, identity.pid)) !==
            JSON.stringify(target.ports)
        )
          throw new Error("changed");
        // A project may have been ignored while native inspection was pending.
        validateSelection();
        // Native helpers revalidate start time and executable at the termination boundary.
        // No process tree, parent, shell command, or unselected PID is passed here.
        await host.stop([identity]);
        let stopped = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          if (
            !(await host.snapshot()).processes.some((p) =>
              sameProcess(p, identity),
            )
          ) {
            stopped = true;
            break;
          }
          await this.deps.pause(250);
        }
        if (stopped) await this.deps.refresh(expected);
        results.push({
          target,
          ok: stopped,
          message: stopped ? "Stopped" : "The process is still running.",
        });
      } catch {
        results.push({
          target,
          ok: false,
          message:
            "Process or listener identity changed, or access was denied. Stop was not confirmed.",
        });
      }
    }
    return results;
  }
}
