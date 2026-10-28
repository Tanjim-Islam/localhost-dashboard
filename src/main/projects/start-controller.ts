import {
  startScope,
  type ServerInfo,
  type ServerRef,
  type ServiceRecord,
  type StartResult,
} from "../../shared/servers";
import {
  waitForLaunch,
  type ReadyDependencies,
  type RunningChild,
} from "../server-restart/controller";
import type { LaunchRecipe } from "../server-restart/plan";
import {
  RestartError,
  sameProcess,
  type LaunchContext,
  type ProcessIdentity,
  type ProcessSnapshot,
} from "../server-restart/types";

type Host = { snapshot(pid?: number): Promise<ProcessSnapshot>; dispose(): void };
export type StartDependencies = ReadyDependencies & {
  items: () => ServerInfo[];
  stopped: () => ServiceRecord[];
  recipe: (pid: number) => LaunchRecipe | undefined;
  ignored: (projectId?: string) => boolean;
  createHost: () => Host;
  launch: (context: LaunchContext) => Promise<RunningChild>;
  preflight: (context: LaunchContext) => Promise<void>;
  operationBusy: () => boolean;
  // Replacement listeners are exempt from dashboard-child stop protection.
  completed: (started: ServerRef[], replacement: ProcessIdentity[]) => Promise<void>;
};
type Launch = { recipe: LaunchRecipe; records: ServiceRecord[] };
const instance = (r: ServerRef) => `${r.key}/${r.firstSeen}`;

// Recipes live only in memory, keyed by the observed instance. A service seen
// running in this session can start again from its exact launch context after
// it stops. Nothing here is persisted, logged, or sent to the renderer.
export class ServerStartController {
  private recipes = new Map<string, LaunchRecipe>();
  private busy = false;
  constructor(private deps: StartDependencies) {}
  isBusy(): boolean {
    return this.busy;
  }
  remember(items: ServerInfo[]): void {
    for (const item of items) {
      if (item.discovery !== "development" || !item.canStop) continue;
      const recipe = this.deps.recipe(item.pid);
      if (recipe?.ports.includes(item.port))
        this.recipes.set(instance(item), recipe);
    }
    const keep = new Set([...items, ...this.deps.stopped()].map(instance));
    for (const key of this.recipes.keys())
      if (!keep.has(key)) this.recipes.delete(key);
  }
  canStart(record: ServiceRecord): boolean {
    return (
      this.recipes.has(instance(record)) &&
      !this.deps.ignored(record.projectId) &&
      !this.running(record)
    );
  }
  private running(record: ServiceRecord): boolean {
    return (
      !!record.serviceId &&
      this.deps.items().some((i) => i.serviceId === record.serviceId)
    );
  }
  async start(value: unknown): Promise<StartResult[]> {
    const scope = startScope(value);
    if (this.busy || this.deps.operationBusy())
      throw new Error("A server operation is already running.");
    this.busy = true;
    const host = this.deps.createHost();
    try {
      const launches: Launch[] = [];
      for (const ref of scope.refs) {
        const record = this.deps
          .stopped()
          .find((s) => instance(s) === instance(ref));
        const recipe = this.recipes.get(instance(ref));
        if (!record || !recipe)
          throw new Error(
            "Launch details for this service are unavailable. Start it from its terminal.",
          );
        if (scope.projectId && record.projectId !== scope.projectId)
          throw new Error("Project association changed. Review the services again.");
        if (this.deps.ignored(record.projectId))
          throw new Error("Restore this project before starting its services.");
        if (this.running(record))
          throw new Error(`${record.serviceName} is already running.`);
        // One launcher can own several stopped listeners. Start it once.
        const shared = launches.find((l) =>
          sameProcess(l.recipe.launch, recipe.launch),
        );
        if (shared) shared.records.push(record);
        else launches.push({ recipe, records: [record] });
      }
      // Check every launch before starting any, so a conflict starts nothing.
      const [listeners, snapshot] = await Promise.all([
        this.deps.listeners(),
        host.snapshot(),
      ]);
      const claimed = new Set<number>();
      for (const { recipe } of launches) {
        for (const port of recipe.ports) {
          if (listeners.some((l) => l.localPort === port))
            throw new Error(`Port :${port} is in use. Nothing was started.`);
          if (claimed.has(port))
            throw new Error(
              `Two selected services use port :${port}. Start them one at a time.`,
            );
          claimed.add(port);
        }
        // A surviving launcher or watcher would produce a duplicate tree.
        if (snapshot.processes.some((p) => sameProcess(p, recipe.launch)))
          throw new Error(
            "The original launcher is still running. Nothing was started.",
          );
        await this.deps.preflight(recipe.launch).catch(() => {
          throw new Error(
            "The original executable or project folder is missing. Nothing was started.",
          );
        });
      }
      const results: StartResult[] = [];
      for (const launch of launches)
        results.push(...(await this.launch(host, launch)));
      return results;
    } finally {
      host.dispose();
      this.busy = false;
    }
  }
  private async launch(host: Host, { recipe, records }: Launch): Promise<StartResult[]> {
    const report = (ok: boolean, message: string) =>
      records.map((r) => ({
        ref: { key: r.key, firstSeen: r.firstSeen },
        serviceName: r.serviceName,
        port: r.port,
        ok,
        message,
      }));
    let child: RunningChild | undefined;
    try {
      // An earlier launch in this request may have opened another port.
      const listeners = await this.deps.listeners();
      const taken = recipe.ports.find((port) =>
        listeners.some((l) => l.localPort === port),
      );
      if (taken)
        throw new RestartError(`Port :${taken} is in use. It was not started.`);
      try {
        child = await this.deps.launch(recipe.launch);
      } catch {
        throw new RestartError(
          "The launch command could not be started. Start it from its terminal.",
        );
      }
      const replacement = await waitForLaunch(
        this.deps,
        host,
        recipe.launch,
        recipe.ports,
        child,
      );
      await this.deps.completed(
        records.map((r) => ({ key: r.key, firstSeen: r.firstSeen })),
        replacement,
      );
      return report(
        true,
        `Started on ${recipe.ports.map((p) => `:${p}`).join(", ")}.`,
      );
    } catch (error) {
      // Never forward OS exception messages, output, argv, or environment.
      return report(
        false,
        error instanceof RestartError
          ? error.message
          : "Start could not be verified. Check the project before starting another copy.",
      );
    } finally {
      child?.detach();
    }
  }
}
