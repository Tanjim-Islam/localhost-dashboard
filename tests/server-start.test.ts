import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ServerStartController,
  type StartDependencies,
} from "../src/main/projects/start-controller";
import { ServerStopController } from "../src/main/projects/stop-controller";
import { ProjectModel, emptyProjectState } from "../src/main/projects/model";
import { captureLaunchRecipe, type LaunchRecipe } from "../src/main/server-restart/plan";
import type { ServerInfo, ServiceRecord } from "../src/shared/servers";
import type {
  LaunchContext,
  Listener,
  ProcessIdentity,
} from "../src/main/server-restart/types";

function context(pid: number, ppid: number, executable = "C:\\node\\node.exe", argv = ["node", "server.js"]): LaunchContext {
  return {
    pid, ppid, executable, argv, started: `${pid}-start`, startedMs: 1700000000000 + pid,
    cwd: "C:\\Projects\\space & Unicode বাংলা", env: { PATH: "C:\\node", SECRET: "value with spaces & $symbols" },
  };
}
const recipe = (pid: number, ports: number[], argv = ["node", "C:\\node\\npm-cli.js", "run", "dev", "--", "a b"]): LaunchRecipe =>
  ({ launch: context(pid, 10, "C:\\node\\node.exe", argv), ports });

function service(pid: number, port: number, extra: Partial<ServerInfo> = {}): ServerInfo {
  return {
    key: `${pid}:${port}`, firstSeen: 1000 + pid, pid, port, protocol: "tcp", url: "", lastSeen: 2000,
    discovery: "development", serviceName: `svc-${port}`, projectId: "project", serviceId: `service-${port}`,
    association: "detected", canStop: true, ...extra,
  };
}
const record = (s: ServerInfo): ServiceRecord => ({
  key: s.key, firstSeen: s.firstSeen, pid: s.pid, port: s.port, serviceName: s.serviceName,
  serviceId: s.serviceId, projectId: s.projectId, lastSeen: s.lastSeen, status: "listener-disappeared", stoppedAt: 3000,
});

function harness() {
  let items: ServerInfo[] = [];
  let stopped: ServiceRecord[] = [];
  const recipes = new Map<number, LaunchRecipe>();
  const processes: ProcessIdentity[] = [];
  let listeners: Listener[] = [];
  const launched: LaunchContext[] = [];
  const completed: string[] = [];
  const replacements: ProcessIdentity[][] = [];
  let nextPid = 5000, now = 0, exitOnLaunch = false;
  const ignored = new Set<string>();
  const deps: StartDependencies = {
    items: () => items,
    stopped: () => stopped,
    recipe: (pid) => recipes.get(pid),
    ignored: (id) => !!id && ignored.has(id),
    createHost: () => ({ snapshot: async () => ({ processes: structuredClone(processes), contexts: [] }), dispose: () => {} }),
    listeners: async () => structuredClone(listeners),
    launch: async (ctx) => {
      launched.push(structuredClone(ctx));
      const pid = nextPid++;
      if (exitOnLaunch) return { pid, exited: () => true, detach: () => {} };
      const root = { pid, ppid: 1, started: `${pid}`, startedMs: now, executable: ctx.executable };
      const child = { pid: pid + 1000, ppid: pid, started: `${pid + 1000}`, startedMs: now, executable: ctx.executable };
      processes.push(root, child);
      const ports = [...recipes.values()].find((r) => r.launch.argv.join() === ctx.argv.join())!.ports;
      listeners.push(...ports.map((localPort) => ({ pid: child.pid, localPort })));
      return { pid, exited: () => false, detach: () => {} };
    },
    preflight: async () => {},
    operationBusy: () => false,
    completed: async (refs, replacement) => {
      completed.push(...refs.map((r) => r.key));
      replacements.push(replacement);
    },
    now: () => now,
    pause: async (ms) => { now += ms; },
    startupTimeoutMs: 45000,
  };
  const controller = new ServerStartController(deps);
  // Observe services running, then stop them the way reconcile records it.
  const observeThenStop = (...running: ServerInfo[]) => {
    items = running;
    controller.remember(items);
    stopped = [...running.map(record), ...stopped];
    items = [];
    controller.remember(items);
  };
  return {
    controller, deps, recipes, processes, launched, completed, replacements, ignored,
    observeThenStop,
    setItems: (next: ServerInfo[]) => { items = next; },
    setStopped: (next: ServiceRecord[]) => { stopped = next; },
    setListeners: (next: Listener[]) => { listeners = next; },
    exitOnLaunch: () => { exitOnLaunch = true; },
  };
}

test("launch recipes follow npm through its shell and stop at the dashboard", async () => {
  const npm = context(80, 10, "C:\\node\\node.exe", ["node", "C:\\node\\npm-cli.js", "run", "dev", "--", "--port", "3000"]);
  const shell = context(90, 80, "C:\\Windows\\System32\\cmd.exe", ["cmd", "/d", "/s", "/c", "vite"]);
  const server = context(100, 90);
  const snapshot = { processes: [npm, shell, server], contexts: [npm, shell, server] };
  const captured = await captureLaunchRecipe(snapshot, [{ pid: 100, localPort: 3000 }], 100, "win32", 999);
  assert.deepEqual(captured, { launch: npm, ports: [3000] });
  // A server the dashboard launched has the dashboard as parent: the server's own launcher is the root.
  const dashboard = context(10, 1, "C:\\Apps\\Dashboard.exe", ["Dashboard"]);
  const fromDashboard = await captureLaunchRecipe({ processes: [dashboard, npm, shell, server], contexts: [npm, shell, server] }, [{ pid: 100, localPort: 3000 }], 100, "win32", 10);
  assert.equal(fromDashboard?.launch.pid, 80);
  assert.equal(await captureLaunchRecipe({ processes: [server], contexts: [] }, [{ pid: 100, localPort: 3000 }], 100, "win32", 999), undefined);
});

test("a stopped service starts again with its exact launch context and is reported per service", async () => {
  const h = harness();
  const api = service(100, 3000);
  h.recipes.set(100, recipe(80, [3000]));
  h.observeThenStop(api);
  const [stoppedApi] = h.deps.stopped();
  assert.equal(h.controller.canStart(stoppedApi), true);
  const results = await h.controller.start({ refs: [{ key: api.key, firstSeen: api.firstSeen }], projectId: "project" });
  assert.deepEqual(results.map((r) => [r.ok, r.message]), [[true, "Started on :3000."]]);
  assert.deepEqual(h.launched, [recipe(80, [3000]).launch]);
  assert.deepEqual(h.completed, [api.key]);
  assert.deepEqual(h.replacements.map((r) => r.map((p) => p.pid)), [[6000]], "listening replacement is handed to stop protection");
  assert.equal(h.controller.isBusy(), false);
});

test("services sharing one launcher start it once; Start all reports each", async () => {
  const h = harness();
  const web = service(100, 3000), api = service(101, 3001);
  const shared = recipe(80, [3000, 3001]);
  h.recipes.set(100, shared).set(101, shared);
  h.observeThenStop(web, api);
  const results = await h.controller.start({ refs: [web, api].map(({ key, firstSeen }) => ({ key, firstSeen })), projectId: "project" });
  assert.equal(h.launched.length, 1);
  assert.deepEqual(results.map((r) => [r.serviceName, r.ok]), [["svc-3000", true], ["svc-3001", true]]);
});

test("conflicts are rejected before anything is launched", async () => {
  const cases: [string, (h: ReturnType<typeof harness>, s: ServerInfo) => void, unknown, RegExp][] = [
    ["port in use", (h) => h.setListeners([{ pid: 777, localPort: 3000 }]), undefined, /Port :3000 is in use/],
    ["launcher alive", (h) => h.processes.push(recipe(80, [3000]).launch), undefined, /still running/],
    ["already running", (h, s) => h.setItems([{ ...service(900, 4000), serviceId: s.serviceId }]), undefined, /already running/],
    ["ignored project", (h) => h.ignored.add("project"), undefined, /Restore this project/],
    ["other project", () => {}, "elsewhere", /association changed/],
    ["missing files", (h) => { h.deps.preflight = async () => { throw new Error("ENOENT C:\\private"); }; }, undefined, /missing\. Nothing was started/],
    ["operation busy", (h) => { h.deps.operationBusy = () => true; }, undefined, /already running/],
  ];
  for (const [name, arrange, projectId, expected] of cases) {
    const h = harness();
    const api = service(100, 3000);
    h.recipes.set(100, recipe(80, [3000]));
    h.observeThenStop(api);
    arrange(h, api);
    await assert.rejects(
      h.controller.start({ refs: [{ key: api.key, firstSeen: api.firstSeen }], ...(projectId ? { projectId } : {}) }),
      expected, name,
    );
    assert.deepEqual(h.launched, [], name);
  }
});

test("two selected services claiming one port start nothing", async () => {
  const h = harness();
  const a = service(100, 3000, { projectId: "a", serviceId: "a" }), b = service(200, 3000, { projectId: "b", serviceId: "b" });
  h.recipes.set(100, recipe(80, [3000], ["node", "a.js"])).set(200, recipe(90, [3000], ["node", "b.js"]));
  h.observeThenStop(a);
  h.observeThenStop(b);
  await assert.rejects(h.controller.start({ refs: [a, b].map(({ key, firstSeen }) => ({ key, firstSeen })) }), /Two selected services/);
  assert.deepEqual(h.launched, []);
});

test("unknown recipes, invalid payloads and early exits are reported without leaking details", async () => {
  const h = harness();
  const api = service(100, 3000);
  h.observeThenStop(api);
  assert.equal(h.controller.canStart(h.deps.stopped()[0]), false);
  await assert.rejects(h.controller.start({ refs: [{ key: api.key, firstSeen: api.firstSeen }] }), /unavailable/);
  for (const invalid of [null, {}, { refs: [] }, { refs: [{ key: "1:2 && evil", firstSeen: 1 }] }, { refs: [{ key: api.key, firstSeen: api.firstSeen }], projectId: "../x" }])
    await assert.rejects(h.controller.start(invalid));
  const again = harness();
  again.recipes.set(100, recipe(80, [3000]));
  again.observeThenStop(api);
  again.exitOnLaunch();
  const [result] = await again.controller.start({ refs: [{ key: api.key, firstSeen: api.firstSeen }] });
  assert.equal(result.ok, false);
  assert.match(result.message, /exited before/);
  assert.doesNotMatch(result.message, /SECRET|npm-cli|spaces/);
  assert.deepEqual(again.completed, []);
});

test("recipes are kept only for listed services and require the observed port", () => {
  const h = harness();
  const api = service(100, 3000);
  h.recipes.set(100, recipe(80, [3001]));
  h.observeThenStop(api);
  assert.equal(h.controller.canStart(h.deps.stopped()[0]), false, "a recipe must own the stopped port");
  const next = harness();
  next.recipes.set(100, recipe(80, [3000]));
  next.observeThenStop(api);
  const stoppedApi = next.deps.stopped()[0];
  assert.equal(next.controller.canStart(stoppedApi), true);
  next.setStopped([]);
  next.controller.remember([]);
  assert.equal(next.controller.canStart(stoppedApi), false, "pruned with its history entry");
});

test("project snapshots expose canStart without persisting it, and started entries leave the list", () => {
  const state = emptyProjectState();
  const model = new ProjectModel(state);
  const api = record(service(100, 3000));
  state.recentlyStopped.push(api, record(service(101, 3001)));
  model.startable = (s) => s.key === api.key;
  assert.deepEqual(model.snapshot().recentlyStopped.map((s) => s.canStart), [true, false]);
  assert.equal("canStart" in state.recentlyStopped[0], false);
  model.forgetStopped([{ key: api.key, firstSeen: api.firstSeen }]);
  assert.deepEqual(state.recentlyStopped.map((s) => s.key), ["101:3001"]);
});

test("servers launched by the dashboard can be stopped again, other dashboard children cannot", async () => {
  for (const launchedByDashboard of [true, false]) {
    const own: ProcessIdentity = { pid: 1, ppid: 0, started: "1", startedMs: 1, executable: "C:/Dashboard.exe" };
    const server: ProcessIdentity = { pid: 100, ppid: 1, started: "100", startedMs: 2, executable: "C:/node.exe" };
    let live = [own, server];
    const item = service(100, 3000);
    const stopper = new ServerStopController({
      items: () => [item], identity: () => server, projectName: () => "project", ownPid: 1,
      restartBusy: () => false,
      listeners: async () => (live.includes(server) ? [{ pid: 100, localPort: 3000 }] : []),
      createHost: () => ({
        snapshot: async () => ({ processes: live, contexts: [] }),
        stop: async () => { live = [own]; },
        dispose: () => {},
      }),
      refresh: async () => {}, now: () => 0, pause: async () => {},
    });
    if (launchedByDashboard) stopper.rememberRestarted([server]);
    if (launchedByDashboard) assert.equal((await stopper.stop({ refs: [item] }))[0].ok, true);
    else await assert.rejects(stopper.stop({ refs: [item] }), /identity could not be confirmed/);
  }
});
