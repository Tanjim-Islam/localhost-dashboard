// Real OS checks for starting recently stopped services. Only servers generated
// by this script are captured, stopped, started, or cleaned up.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { setTimeout: pause } = require("node:timers/promises");
const { NativeProcessHost } = require("../.tmp-tests/src/main/server-restart/native-host.js");
const { launchServer, preflightLaunch } = require("../.tmp-tests/src/main/server-restart/controller.js");
const { captureLaunchRecipe, descendants } = require("../.tmp-tests/src/main/server-restart/plan.js");
const { readListeners } = require("../.tmp-tests/src/main/server-restart/listeners.js");
const { ServerStartController } = require("../.tmp-tests/src/main/projects/start-controller.js");
const { ServerStopController } = require("../.tmp-tests/src/main/projects/stop-controller.js");

const resources = path.resolve(__dirname, "../resources/server-restart");
const inspector = new NativeProcessHost(resources);
const owned = new Map();
const liveChildren = [];
let root;
let passed = 0;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function remember(pid) {
  const state = await inspector.snapshot(pid);
  const process = state.processes.find((p) => p.pid === pid);
  if (process) for (const member of descendants(process, state.processes)) owned.set(member.pid, member);
  return state;
}

async function waitHttp(port, predicate = () => true) {
  const end = Date.now() + 20000;
  do {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
      const data = await response.json();
      if (predicate(data)) { await remember(data.pid); return data; }
    } catch {}
    await pause(150);
  } while (Date.now() < end);
  throw new Error(`Fixture did not open port ${port}.`);
}

async function waitClosed(port) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (!(await readListeners()).some((l) => l.localPort === port)) return;
    await pause(150);
  }
  throw new Error(`Port ${port} stayed open.`);
}

async function createFixture(name, extra = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const port = await freePort();
  await fs.writeFile(path.join(dir, "boot.json"), JSON.stringify({ value: "before", ...extra }));
  await fs.writeFile(path.join(dir, "server.cjs"), `
const fs = require('node:fs'), http = require('node:http');
const boot = JSON.parse(fs.readFileSync('boot.json', 'utf8'));
if (boot.fail) process.exit(7);
const ports = [Number(process.env.DASHBOARD_FIXTURE_PORT), ...(boot.extraPorts || [])];
const response = JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), value: boot.value, env: process.env.DASHBOARD_FIXTURE_VALUE });
for (const port of ports) http.createServer((req, res) => { res.setHeader('content-type','application/json'); res.end(response); }).listen(port, '127.0.0.1');
`);
  const env = { ...process.env, DASHBOARD_FIXTURE_PORT: String(port), DASHBOARD_FIXTURE_VALUE: "test-only spaces & $literal বাংলা" };
  for (const key of Object.keys(env)) if (/^npm_/i.test(key)) delete env[key];
  return { dir, port, env };
}

async function start(fixture, args = ["server.cjs"]) {
  const child = spawn(process.execPath, args, { cwd: fixture.dir, env: fixture.env, detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  liveChildren.push(child);
  await remember(child.pid);
  return child;
}

// Mirrors main: capture while running, observe as a development service.
async function observe(port, pid, projectId) {
  const snapshot = await inspector.snapshot(pid);
  const identity = snapshot.processes.find((p) => p.pid === pid);
  const recipe = await captureLaunchRecipe(snapshot, await readListeners(), pid, process.platform, process.pid);
  assert.ok(recipe, "launch recipe captured while running");
  const item = {
    key: `${pid}:${port}`, firstSeen: Date.now(), lastSeen: Date.now(), pid, port, protocol: "tcp", url: "",
    discovery: "development", serviceName: `Fixture ${port}`, projectId, serviceId: `service-${port}`,
    association: "detected", canStop: true, processStarted: new Date(identity.startedMs).toISOString(),
  };
  return { item, identity, recipe };
}

function harness(services) {
  let items = services.map((s) => s.item);
  let stopped = [];
  const results = { completed: [] };
  const starter = new ServerStartController({
    items: () => items,
    stopped: () => stopped,
    recipe: (pid) => services.find((s) => s.item.pid === pid)?.recipe,
    ignored: () => false,
    createHost: () => new NativeProcessHost(resources),
    listeners: readListeners,
    launch: async (context) => {
      const child = await launchServer(context);
      await remember(child.pid);
      return child;
    },
    preflight: preflightLaunch,
    operationBusy: () => false,
    completed: async (refs, replacement) => { results.completed.push(...refs); results.replacement = replacement; },
    now: Date.now, pause, startupTimeoutMs: 30000,
  });
  // Fixtures are children of this script. Only the dashboard-launch check
  // passes this script's PID as the dashboard's own process.
  const stopper = (ownPid = 2147483647) => new ServerStopController({
    items: () => items,
    identity: (pid) => services.find((s) => s.item.pid === pid)?.identity,
    projectName: (id) => id,
    createHost: () => {
      const host = new NativeProcessHost(resources);
      return { snapshot: (pid) => host.snapshot(pid), stop: (targets) => host.stop(targets, true), dispose: () => host.dispose() };
    },
    listeners: readListeners,
    ownPid,
    restartBusy: () => starter.isBusy(),
    refresh: async () => {},
    now: Date.now, pause,
  });
  starter.remember(items);
  return {
    starter, stopper, results,
    // Same order as main: the stop enters history, then recipes are pruned.
    markStopped(list) {
      stopped = [...list.map(({ item }) => ({ ...item, status: "listener-disappeared", stoppedAt: Date.now() })), ...stopped];
      items = items.filter((i) => !list.some((s) => s.item.key === i.key));
      starter.remember(items);
    },
    stoppedRecords: () => stopped,
    refs: (list) => list.map(({ item }) => ({ key: item.key, firstSeen: item.firstSeen })),
  };
}

async function test(name, fn) {
  const started = Date.now();
  await fn();
  passed++;
  console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

async function main() {
  assert.ok(["win32", "darwin"].includes(process.platform), "Run these live checks on Windows or macOS.");
  root = await fs.mkdtemp(path.join(os.tmpdir(), "local-dashboard-start-"));
  console.log(`Running real stopped-service start checks on ${process.platform}.`);

  await test("dashboard stop, then start with exact argv, env, Unicode cwd and port", async () => {
    const fixture = await createFixture("project spaces & বাংলা");
    const args = ["server.cjs", "", "two words", 'quote"value', "$literal; & safe"];
    await start(fixture, args);
    const before = await waitHttp(fixture.port);
    const svc = await observe(fixture.port, before.pid, "direct");
    const h = harness([svc]);
    const [stopResult] = await h.stopper().stop({ refs: h.refs([svc]) });
    assert.equal(stopResult.ok, true, stopResult.message);
    await waitClosed(fixture.port);
    h.markStopped([svc]);
    assert.equal(h.starter.canStart(h.stoppedRecords()[0]), true);
    const [result] = await h.starter.start({ refs: h.refs([svc]), projectId: "direct" });
    assert.equal(result.ok, true, result.message);
    const after = await waitHttp(fixture.port, (d) => d.pid !== before.pid);
    assert.deepEqual(after.args, before.args);
    assert.equal(after.cwd, before.cwd);
    assert.equal(after.env, fixture.env.DASHBOARD_FIXTURE_VALUE);
    assert.deepEqual(h.results.completed, h.refs([svc]));
    assert.equal(new Set((await readListeners()).filter((l) => l.localPort === fixture.port).map((l) => l.pid)).size, 1);
  });

  await test("npm script stopped through its server process restarts from npm with hook and arguments", async () => {
    const fixture = await createFixture("npm project");
    await fs.writeFile(path.join(fixture.dir, "hook.cjs"), "require('node:fs').appendFileSync('hook.txt','ran\\n')");
    await fs.writeFile(path.join(fixture.dir, "package.json"), JSON.stringify({ name: "dashboard-start-fixture", private: true, scripts: { preserve: "node hook.cjs", serve: "node server.cjs" } }));
    assert.ok(process.env.npm_execpath, "Run through npm run test:servers:start-live to locate npm.");
    await start(fixture, [process.env.npm_execpath, "run", "serve", "--", "two words", "--sample=3000"]);
    const before = await waitHttp(fixture.port);
    const svc = await observe(fixture.port, before.pid, "npm");
    assert.match(svc.recipe.launch.argv.join(" "), /run serve -- two words --sample=3000/);
    const h = harness([svc]);
    assert.equal((await h.stopper().stop({ refs: h.refs([svc]) }))[0].ok, true);
    await waitClosed(fixture.port);
    // npm exits after its server; the original launcher must be gone before start.
    const end = Date.now() + 10000;
    while ((await inspector.snapshot()).processes.some((p) => p.pid === svc.recipe.launch.pid && p.started === svc.recipe.launch.started) && Date.now() < end) await pause(200);
    h.markStopped([svc]);
    const [result] = await h.starter.start({ refs: h.refs([svc]) });
    assert.equal(result.ok, true, result.message);
    const after = await waitHttp(fixture.port, (d) => d.pid !== before.pid);
    assert.deepEqual(after.args, ["two words", "--sample=3000"]);
    assert.equal((await fs.readFile(path.join(fixture.dir, "hook.txt"), "utf8")).trim().split("\n").length, 2);
  });

  await test("a started server can be stopped again only through its verified replacement identity", async () => {
    const fixture = await createFixture("stop again");
    await start(fixture);
    const before = await waitHttp(fixture.port);
    const svc = await observe(fixture.port, before.pid, "again");
    const h = harness([svc]);
    assert.equal((await h.stopper().stop({ refs: h.refs([svc]) }))[0].ok, true);
    await waitClosed(fixture.port);
    h.markStopped([svc]);
    assert.equal((await h.starter.start({ refs: h.refs([svc]) }))[0].ok, true);
    const after = await waitHttp(fixture.port, (d) => d.pid !== before.pid);
    const restarted = await observe(fixture.port, after.pid, "again");
    const next = harness([restarted]);
    await assert.rejects(next.stopper(process.pid).stop({ refs: next.refs([restarted]) }), /identity could not be confirmed/, "old behavior treated it as a dashboard helper");
    const stopper = next.stopper(process.pid);
    stopper.rememberRestarted(h.results.replacement);
    const [stopResult] = await stopper.stop({ refs: next.refs([restarted]) });
    assert.equal(stopResult.ok, true, stopResult.message);
    await waitClosed(fixture.port);
  });

  await test("an occupied port refuses to start and leaves the other process running", async () => {
    const fixture = await createFixture("port conflict");
    await start(fixture);
    const before = await waitHttp(fixture.port);
    const svc = await observe(fixture.port, before.pid, "conflict");
    const h = harness([svc]);
    assert.equal((await h.stopper().stop({ refs: h.refs([svc]) }))[0].ok, true);
    await waitClosed(fixture.port);
    h.markStopped([svc]);
    const squatter = await createFixture("squatter");
    await start({ ...squatter, env: { ...squatter.env, DASHBOARD_FIXTURE_PORT: String(fixture.port) } });
    const other = await waitHttp(fixture.port);
    await assert.rejects(h.starter.start({ refs: h.refs([svc]) }), /in use/);
    assert.equal((await waitHttp(fixture.port)).pid, other.pid);
  });

  await test("one process with two ports starts once and recovers both", async () => {
    const extraPort = await freePort();
    const fixture = await createFixture("two ports", { extraPorts: [extraPort] });
    await start(fixture);
    const before = await waitHttp(fixture.port);
    await waitHttp(extraPort);
    const main = await observe(fixture.port, before.pid, "two");
    const extra = { ...main, item: { ...main.item, key: `${before.pid}:${extraPort}`, port: extraPort, serviceId: `service-${extraPort}` } };
    const h = harness([main, extra]);
    assert.deepEqual(main.recipe.ports, [fixture.port, extraPort].sort((a, b) => a - b));
    assert.equal((await h.stopper().stop({ refs: h.refs([main, extra]) }))[0].ok, true);
    await waitClosed(fixture.port);
    h.markStopped([main, extra]);
    const results = await h.starter.start({ refs: h.refs([main, extra]), projectId: "two" });
    assert.deepEqual(results.map((r) => r.ok), [true, true]);
    const after = await waitHttp(fixture.port, (d) => d.pid !== before.pid);
    assert.equal((await waitHttp(extraPort)).pid, after.pid);
  });

  await test("a project that fails at startup is reported and not left listening", async () => {
    const fixture = await createFixture("startup failure");
    await start(fixture);
    const before = await waitHttp(fixture.port);
    const svc = await observe(fixture.port, before.pid, "fail");
    const h = harness([svc]);
    assert.equal((await h.stopper().stop({ refs: h.refs([svc]) }))[0].ok, true);
    await waitClosed(fixture.port);
    h.markStopped([svc]);
    await fs.writeFile(path.join(fixture.dir, "boot.json"), JSON.stringify({ fail: true }));
    const [result] = await h.starter.start({ refs: h.refs([svc]) });
    assert.equal(result.ok, false);
    assert.match(result.message, /exited before/);
    assert.equal((await readListeners()).some((l) => l.localPort === fixture.port), false);
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    const state = await inspector.snapshot();
    for (const original of [...owned.values()]) {
      const current = state.processes.find((p) => p.pid === original.pid && p.started === original.started);
      if (!current) continue;
      for (const member of descendants(current, state.processes)) owned.set(member.pid, member);
    }
    if (owned.size) await inspector.stop([...owned.values()]);
    await pause(300);
    const remaining = await inspector.snapshot();
    assert.equal(remaining.processes.filter((p) => owned.get(p.pid)?.started === p.started).length, 0, "all fixture processes were stopped");
    const absoluteRoot = path.resolve(root || ".");
    if (path.dirname(absoluteRoot) === path.resolve(os.tmpdir()) && path.basename(absoluteRoot).startsWith("local-dashboard-start-")) await fs.rm(absoluteRoot, { recursive: true, force: true });
  } catch (error) { console.error("Fixture cleanup did not complete.", error.message); process.exitCode = 1; }
  inspector.dispose();
  for (const child of liveChildren) child.unref();
  console.log(`${passed} live scenarios passed. ${process.exitCode ? "See failure details above." : "Fixture processes checked and removed."}`);
});
