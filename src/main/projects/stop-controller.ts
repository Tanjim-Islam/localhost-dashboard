import { randomUUID } from "node:crypto";
import {
  stopScope,
  type ServerInfo,
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
  refresh: (stoppedPids: number[]) => Promise<void>;
  now: () => number;
  pause: (ms: number) => Promise<void>;
};
type Prepared = {
  public: StopPreview;
  scope: StopScope;
  identities: ProcessIdentity[];
  services: Pick<ServerInfo, "key" | "firstSeen" | "pid" | "projectId">[];
};
const portsFor = (listeners: Listener[], pid: number) =>
  [
    ...new Set(listeners.filter((l) => l.pid === pid).map((l) => l.localPort)),
  ].sort((a, b) => a - b);

export class ServerStopController {
  private prepared?: Prepared;
  private busy = false;
  constructor(private deps: StopDependencies) {}
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
        item.discovery !== "development"
      )
        throw new Error(
          "A selected service changed or cannot be verified. Refresh and select it again.",
        );
      if (
        scope.projectId &&
        (item.projectId !== scope.projectId || !item.association)
      )
        throw new Error(
          "Project association changed. Review the services again.",
        );
      return item;
    });
  }
  async preview(value: unknown): Promise<StopPreview> {
    const scope = stopScope(value);
    if (this.busy || this.deps.restartBusy())
      throw new Error("A server operation is already running.");
    this.busy = true;
    this.prepared = undefined;
    const host = this.deps.createHost();
    try {
      const selected = this.selected(scope);
      const snapshot = await host.snapshot();
      const listeners = await this.deps.listeners();
      const protectedPids = new Set([this.deps.ownPid]);
      let ancestor = snapshot.processes.find((p) => p.pid === this.deps.ownPid);
      for (let depth = 0; ancestor && depth < 32; depth++) {
        protectedPids.add(ancestor.pid);
        ancestor = snapshot.processes.find(
          (p) => p.pid === ancestor!.ppid && p.startedMs <= ancestor!.startedMs,
        );
        if (ancestor && protectedPids.has(ancestor.pid)) break;
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
          protectedPids.has(item.pid)
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
        services: selected.map(({ key, firstSeen, pid, projectId }) => ({
          key,
          firstSeen,
          pid,
          projectId,
        })),
      };
      return structuredClone(preview);
    } finally {
      host.dispose();
      this.busy = false;
    }
  }
  async execute(token: string): Promise<StopResult[]> {
    if (this.busy || this.deps.restartBusy())
      throw new Error("A server operation is already running.");
    const plan = this.prepared;
    this.prepared = undefined;
    if (
      !plan ||
      plan.public.token !== token ||
      plan.public.expiresAt <= this.deps.now()
    )
      throw new Error("Confirmation expired. Review the targets again.");
    this.selected(plan.scope);
    this.busy = true;
    const host = this.deps.createHost(),
      results: StopResult[] = [];
    try {
      for (let index = 0; index < plan.identities.length; index++) {
        const identity = plan.identities[index],
          target = plan.public.targets[index];
        try {
          // Earlier successes may already have disappeared from the scanner. Recheck
          // this process's original selection and ownership before each operation.
          const expected = plan.services.filter((s) => s.pid === identity.pid);
          const current = this.selected({ ...plan.scope, refs: expected });
          if (
            current.some(
              (s) =>
                s.projectId !==
                expected.find((e) => e.key === s.key)?.projectId,
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
          const listeners = await this.deps.listeners();
          const snapshot = await host.snapshot();
          if (
            !snapshot.processes.some((p) => sameProcess(p, identity)) ||
            JSON.stringify(portsFor(listeners, identity.pid)) !==
              JSON.stringify(target.ports)
          )
            throw new Error("changed");
          // A project may have been ignored while native inspection was pending.
          this.selected({ ...plan.scope, refs: expected });
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
      await this.deps.refresh(
        results.filter((r) => r.ok).map((r) => r.target.pid),
      );
      return results;
    } finally {
      host.dispose();
      this.busy = false;
    }
  }
}
