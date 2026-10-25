import si from "systeminformation";
import pidusage from "pidusage";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { settings } from "./settings";
import { NativeProcessHost } from "./server-restart/native-host";
import { readListeners } from "./server-restart/listeners";
import { boundedObservation } from "./server-detection";
import type { ProcessIdentity } from "./server-restart/types";
import type { ServerInfo, ServerRef, ServiceRecord } from "../shared/servers";
import {
  ProjectIdentifier,
  serviceAssociationKey,
  stableId,
  type ProjectEvidence,
} from "./projects/identify";
import {
  developmentRuntime,
  ListenerTracker,
  serviceLabel,
  sameObservedStart,
} from "./projects/discovery";
import {
  applicationOwner,
  classifyListener,
  type ListenerClassification,
} from "./projects/classify";
export type { ServerInfo } from "../shared/servers";

type Inspection = {
  stamp?: string;
  until: number;
  identity?: ProcessIdentity;
  evidence?: ProjectEvidence;
  associationKey?: string;
  cwd?: string;
  framework?: string;
  classification?: ListenerClassification;
};
export class Scanner extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  private presenceInFlight?: Promise<void>;
  private retiredDuringScan = new Set<string>();
  private inFlight?: Promise<void>;
  private tracker = new ListenerTracker();
  private inspections = new Map<number, Inspection>();
  private identifier = new ProjectIdentifier();
  private previousRuns: ServiceRecord[];
  private hasObservation = false;
  private nativePresence = new Map<string, number>();
  constructor(
    private resourceDir: string,
    private decorate: (
      item: ServerInfo,
      evidence?: ProjectEvidence,
      key?: string,
    ) => ServerInfo = (i) => i,
    previousRuns: ServiceRecord[] = [],
  ) {
    super();
    this.previousRuns = structuredClone(previousRuns);
  }
  getItems(): ServerInfo[] {
    return this.tracker.values();
  }
  getInspection(pid: number): Inspection | undefined {
    return this.inspections.get(pid);
  }
  async associationKey(item: ServerInfo): Promise<string> {
    const cached = this.inspections.get(item.pid)?.associationKey;
    if (cached) return cached;
    const host = new NativeProcessHost(this.resourceDir);
    try {
      const snapshot = await host.snapshot(item.pid);
      const identity = snapshot.processes.find((p) => p.pid === item.pid);
      const context = snapshot.contexts.find((p) => p.pid === item.pid);
      const observedStart = new Date(item.processStarted || "").getTime();
      if (
        !identity ||
        !Number.isFinite(observedStart) ||
        Math.abs(identity.startedMs - observedStart) > 2000
      )
        throw new Error("changed");
      const key = context
        ? serviceAssociationKey(context.cwd, context.executable, context.argv)
        : stableId(
            `process:${identity.pid}:${identity.started}:${identity.executable}`,
          );
      const { pid, ppid, started, startedMs, executable } = identity;
      this.inspections.set(item.pid, {
        ...this.inspections.get(item.pid),
        until: Date.now() + 60000,
        identity: { pid, ppid, started, startedMs, executable },
        associationKey: key,
        cwd: context?.cwd,
      });
      return key;
    } catch {
      throw new Error(
        "The service identity is unavailable. Refresh after its process becomes readable.",
      );
    } finally {
      host.dispose();
    }
  }
  redecorate(): void {
    // Editing cached projects before the first scan is not an empty listener
    // observation. Persisted live services must await actual OS evidence.
    if (!this.hasObservation) return;
    this.tracker.reconcile(
      this.getItems().map((item) => {
        const info = this.inspections.get(item.pid);
        return this.decorate(item, info?.evidence, info?.associationKey);
      }),
      false,
    );
    this.emit("update", this.getItems());
  }
  start(): void {
    this.stop();
    void this.scan();
    this.timer = setInterval(
      () => void this.scan(),
      Math.max(2000, settings.get("scanIntervalMs")),
    );
    if (process.platform === "win32" || process.platform === "darwin")
      this.presenceTimer = setInterval(() => void this.checkPresence(), 1000);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
  }
  // A successful native stop is stronger evidence than two absent scans.
  confirmStopped(refs: ServerRef[]): void {
    this.publishRemoved(this.tracker.retire(refs));
  }
  private publishRemoved(removed: ServerInfo[]): void {
    if (!removed.length) return;
    for (const item of removed) {
      this.retiredDuringScan.add(item.key);
      this.nativePresence.delete(item.key);
      if (!this.getItems().some((s) => s.pid === item.pid))
        this.inspections.delete(item.pid);
      if (item.discovery === "development") this.emit("stopped", item);
    }
    this.emit("update", this.getItems());
  }
  checkPresence(): Promise<void> {
    return (this.presenceInFlight ??= this.checkPresenceOnce().finally(() => {
      this.presenceInFlight = undefined;
    }));
  }
  private async checkPresenceOnce(): Promise<void> {
    // Native-only absence cannot retire listeners discovered by a fallback.
    const refs = this.getItems().filter(
      (item) => this.nativePresence.get(item.key) === item.firstSeen,
    );
    if (!refs.length) return;
    try {
      const listeners = await readListeners();
      this.publishRemoved(
        this.tracker.checkPresence(
          refs,
          new Set(listeners.map((l) => `${l.pid}:${l.localPort}`)),
        ),
      );
    } catch {
      // A failed query is not evidence that a listener stopped.
    }
  }
  scan(): Promise<void> {
    return (this.inFlight ??= this.scanOnce().finally(() => {
      this.inFlight = undefined;
    }));
  }
  async scanFresh(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    await this.scan();
  }
  private async scanOnce(): Promise<void> {
    this.retiredDuringScan.clear();
    const host = new NativeProcessHost(this.resourceDir);
    try {
      const [siResult, nativeResult, processResult] = await Promise.allSettled([
        boundedObservation(si.networkConnections(), 2000),
        process.platform === "win32" || process.platform === "darwin"
          ? readListeners()
          : Promise.resolve(null),
        boundedObservation(si.processes(), 5000),
      ]);
      if (
        nativeResult.status === "rejected" ||
        (siResult.status === "rejected" &&
          nativeResult.status === "fulfilled" &&
          nativeResult.value === null)
      )
        throw new Error("Listener query failed.");
      const listeners = new Map<
        string,
        { pid: number; port: number; ipv6: boolean }
      >();
      if (siResult.status === "fulfilled")
        for (const c of siResult.value) {
          if (!/^tcp/i.test(c.protocol) || !/^listen/i.test(c.state)) continue;
          const rawPid = Number(c.pid),
            port = Number(c.localPort);
          const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : 0;
          if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
          const key = `${pid}:${port}`;
          const ipv6 = c.localAddress.includes(":");
          const old = listeners.get(key);
          listeners.set(key, {
            pid,
            port,
            ipv6: old ? old.ipv6 && ipv6 : ipv6,
          });
        }
      if (nativeResult.status === "fulfilled")
        for (const c of nativeResult.value || []) {
          const key = `${c.pid}:${c.localPort}`;
          if (!listeners.has(key))
            listeners.set(key, {
              pid: c.pid,
              port: c.localPort,
              ipv6: c.ipv6 || false,
            });
        }
      for (const [key, listener] of listeners)
        if (
          listener.pid === 0 &&
          [...listeners.values()].some(
            (c) => c.pid > 0 && c.port === listener.port,
          )
        )
          listeners.delete(key);
      const processes = new Map(
        processResult.status === "fulfilled"
          ? processResult.value.list.map((p) => [p.pid, p])
          : [],
      );
      const now = Date.now(),
        oldItems = this.getItems();
      const observed: ServerInfo[] = [];
      let inspectionBudget = 12;
      for (const { pid, port, ipv6 } of listeners.values()) {
        const p = processes.get(pid);
        const old = oldItems.find((i) => i.key === `${pid}:${port}`);
        const prior =
          old || this.previousRuns.find((i) => i.key === `${pid}:${port}`);
        let cached = this.inspections.get(pid);
        const nativeKnownBefore =
          !!cached?.identity || (!old && !!prior?.processStarted);
        const changed = !!(
          cached?.stamp &&
          p?.started &&
          cached.stamp !== p.started
        );
        if (changed) {
          this.inspections.delete(pid);
          cached = undefined;
        }
        const runtime = developmentRuntime(p?.name, p?.command);
        if (
          pid > 0 &&
          (!cached || cached.until < now) &&
          inspectionBudget > 0 &&
          (runtime ||
            cached?.evidence ||
            !p ||
            !/^(system|svchost\.exe|services\.exe|lsass\.exe|wininit\.exe)$/i.test(
              p.name,
            ))
        ) {
          inspectionBudget--;
          const info: Inspection = {
            stamp: p?.started,
            until: now + 60000,
            framework: runtime,
          };
          try {
            if (process.platform === "win32" || process.platform === "darwin") {
              const snapshot = await host.snapshot(pid);
              const identity = snapshot.processes.find((q) => q.pid === pid);
              const context = snapshot.contexts.find((q) => q.pid === pid);
              const application = applicationOwner(
                snapshot,
                pid,
                process.platform,
              );
              if (application && pid === process.pid)
                application.name = "Localhost Dashboard";
              if (identity) {
                const {
                  pid: id,
                  ppid,
                  started,
                  startedMs,
                  executable,
                } = identity;
                info.identity = {
                  pid: id,
                  ppid,
                  started,
                  startedMs,
                  executable,
                };
              }
              if (context) {
                info.cwd = context.cwd;
                info.framework = developmentRuntime(
                  p?.name || context.executable.split(/[\\/]/).pop(),
                  context.argv.join(" "),
                );
                info.evidence = application
                  ? undefined
                  : await this.identifier.identify(
                      context.cwd,
                      context.argv,
                      context.executable,
                    );
                // Private arguments are hashed, never persisted or exposed.
                info.associationKey = serviceAssociationKey(
                  context.cwd,
                  context.executable,
                  context.argv,
                );
              }
              info.classification = classifyListener({
                name: p?.name,
                context,
                evidence: info.evidence,
                application,
              });
            } else {
              info.cwd = await fs.readlink(`/proc/${pid}/cwd`);
              info.evidence = await this.identifier.identify(
                info.cwd,
                [],
                p?.path || "",
              );
              info.associationKey = info.evidence?.associationKey;
              info.classification = classifyListener({
                name: p?.name,
                evidence: info.evidence,
              });
            }
          } catch {
            // Keep the last verified observation when metadata temporarily fails.
            // Stop/restart still revalidate native identity before any mutation.
            if (cached && !changed)
              Object.assign(info, cached, { until: now + 10000 });
          }
          this.inspections.set(pid, info);
          cached = info;
        }
        const started = cached?.identity
          ? new Date(cached.identity.startedMs).toISOString()
          : p?.started || prior?.processStarted;
        const same =
          prior &&
          !changed &&
          sameObservedStart(
            prior.processStarted,
            started,
            !!cached?.identity && nativeKnownBefore,
          );
        const framework = cached?.framework || runtime;
        const classification =
          cached?.classification || classifyListener({ name: p?.name });
        const item: ServerInfo = {
          key: `${pid}:${port}`,
          pid,
          port,
          protocol: "tcp",
          firstSeen: same ? prior.firstSeen : now,
          lastSeen: now,
          url: `http://${ipv6 ? "[::1]" : "localhost"}:${port}`,
          processName: p?.name || old?.processName,
          processStarted:
            same && !cached?.identity
              ? prior.processStarted || started
              : started,
          framework,
          cwd: cached?.cwd,
          ...classification,
          serviceName: classification.serviceName || serviceLabel(framework),
          canStop:
            !!cached?.identity &&
            pid > 4 &&
            pid !== process.pid &&
            !/^(?:[a-z]:[\\/]Windows[\\/]|\/System\/|\/usr\/libexec\/)/i.test(
              cached.identity.executable,
            ),
          ...(p && Number.isFinite(p.cpu) ? { cpu: p.cpu } : {}),
          ...(p && Number.isFinite(p.memRss)
            ? { memory: p.memRss * 1024 }
            : {}),
          cpuHistory: same ? [...(old?.cpuHistory || [])] : [],
          memoryHistory: same ? [...(old?.memoryHistory || [])] : [],
        };
        if (item.discovery === "development")
          try {
            const usage = await pidusage(pid);
            item.cpu = usage.cpu;
            item.memory = usage.memory;
            item.cpuHistory = [...item.cpuHistory!, usage.cpu].slice(-6);
            item.memoryHistory = [...item.memoryHistory!, usage.memory].slice(
              -6,
            );
          } catch {
            /* Optional metrics must not turn an observation into a failure. */
          }
        observed.push(
          this.decorate(item, cached?.evidence, cached?.associationKey),
        );
      }
      // Metadata gathered before a verified disappearance must not resurrect it.
      const nativeKeys = new Set(
        nativeResult.status === "fulfilled"
          ? (nativeResult.value || []).map((l) => `${l.pid}:${l.localPort}`)
          : [],
      );
      for (const item of observed)
        if (nativeKeys.has(item.key) && !this.retiredDuringScan.has(item.key))
          this.nativePresence.set(item.key, item.firstSeen);
      const result = this.tracker.reconcile(
        observed.filter((item) => !this.retiredDuringScan.has(item.key)),
        (item) => this.nativePresence.get(item.key) !== item.firstSeen,
      );
      for (const [key, firstSeen] of this.nativePresence)
        if (
          !result.items.some(
            (item) => item.key === key && item.firstSeen === firstSeen,
          )
        )
          this.nativePresence.delete(key);
      this.hasObservation = true;
      this.previousRuns = [];
      for (const item of result.added)
        if (item.discovery === "development") this.emit("new", item);
      for (const item of result.removed)
        if (item.discovery === "development") this.emit("stopped", item);
      const livePids = new Set(result.items.map((i) => i.pid));
      for (const pid of this.inspections.keys())
        if (!livePids.has(pid)) this.inspections.delete(pid);
      this.emit(
        "update",
        result.items.sort((a, b) => a.port - b.port),
      );
    } catch {
      this.emit(
        "error",
        "Local listeners could not be refreshed. The previous results are retained.",
      );
    } finally {
      host.dispose();
    }
  }
}
