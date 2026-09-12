// Real OS integration against temporary servers only. Works on Windows/macOS;
// records actual PIDs, port ownership, boot values, argv, cwd and environment.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { setTimeout: pause } = require("node:timers/promises");
const { NativeProcessHost } = require("../.tmp-tests/src/main/server-restart/native-host.js");
const { ServerRestartController, createRestartDependencies } = require("../.tmp-tests/src/main/server-restart/controller.js");
const { descendants } = require("../.tmp-tests/src/main/server-restart/plan.js");
const { readListeners } = require("../.tmp-tests/src/main/server-restart/listeners.js");

const repo = path.resolve(__dirname, "..");
const resources = path.join(repo, "resources/server-restart");
const inspector = new NativeProcessHost(resources);
const owned = new Map();
const liveChildren = [];
let root;
let passed = 0;
let skipped = 0;

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
  const end = Date.now() + 18000;
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

async function createFixture(name, extra = {}) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const port = await freePort();
  const config = { value: "before", ...extra };
  await fs.writeFile(path.join(dir, "boot.json"), JSON.stringify(config));
  await fs.writeFile(path.join(dir, "server.cjs"), `
const fs = require('node:fs'), http = require('node:http');
const boot = JSON.parse(fs.readFileSync('boot.json', 'utf8'));
if (boot.fail) process.exit(7);
const ports = [Number(process.env.DASHBOARD_FIXTURE_PORT), ...(boot.extraPorts || [])];
const response = JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), value: boot.value, env: process.env.DASHBOARD_FIXTURE_VALUE, parent: process.env.DASHBOARD_FIXTURE_PARENT });
for (const port of ports) http.createServer((req, res) => { res.setHeader('content-type','application/json'); res.end(response); }).listen(port, '127.0.0.1');
process.on('SIGINT', () => { fs.appendFileSync('interrupts.txt', 'SIGINT\\n'); process.exit(0); });
`);
  const env = { ...process.env, DASHBOARD_FIXTURE_PORT: String(port), DASHBOARD_FIXTURE_VALUE: "test-only spaces & $literal বাংলা" };
  // A fixture must not accidentally inherit npm lifecycle identity from this test.
  for (const key of Object.keys(env)) if (/^npm_/i.test(key)) delete env[key];
  return { dir, port, env, config };
}

async function start(fixture, executable = process.execPath, args = ["server.cjs"]) {
  const child = spawn(executable, args, { cwd: fixture.dir, env: fixture.env, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let fixtureError = "";
  child.stderr.on("data", (chunk) => { fixtureError = (fixtureError + chunk.toString()).slice(-8192); });
  child.once("exit", (code) => {
    if (code && fixtureError) console.error(`Fixture launcher exited with code ${code}: ${fixtureError}`);
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  liveChildren.push(child);
  await remember(child.pid);
  return child;
}

async function restart(fixture, oldPid, options = {}) {
  const state = await remember(oldPid);
  const original = state.processes.find((p) => p.pid === oldPid);
  assert.ok(original, "original server is still alive");
  const ref = { key: `${oldPid}:${fixture.port}`, firstSeen: Date.now() };
  const events = [];
  const deps = createRestartDependencies(resources, {
    getServer: () => ({ ...ref, pid: oldPid, port: fixture.port, processStarted: new Date(original.startedMs).toISOString() }),
    progress: (event) => events.push(event.phase), completed: async () => {},
  });
  const actualLaunch = deps.launch;
  deps.launch = async (context) => {
    const child = await actualLaunch(context);
    await remember(child.pid);
    return child;
  };
  if (options.timeout) deps.startupTimeoutMs = options.timeout;
  const controller = new ServerRestartController(deps);
  const result = options.double ? (await Promise.all([controller.restart(ref), controller.restart(ref)])) : [await controller.restart(ref)];
  return { result: result[0], second: result[1], events };
}

async function test(name, fn) {
  const started = Date.now();
  await fn();
  passed++;
  console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

async function main() {
  assert.ok(["win32", "darwin"].includes(process.platform), "Run these live checks on Windows or macOS.");
  root = await fs.mkdtemp(path.join(os.tmpdir(), "local-dashboard-restart-"));
  console.log(`Running real server restart checks on ${process.platform}.`);

  await test("direct Node, changed boot config, exact argv/env, spaces and Unicode cwd", async () => {
    const fixture = await createFixture("project spaces & বাংলা");
    const args = ["server.cjs", "", "two words", 'quote"value', "slash\\", "$literal; & safe"];
    await start(fixture, process.execPath, args);
    const before = await waitHttp(fixture.port);
    await fs.writeFile(path.join(fixture.dir, "boot.json"), JSON.stringify({ value: "after" }));
    const { result } = await restart(fixture, before.pid);
    assert.equal(result.ok, true, result.message);
    const after = await waitHttp(fixture.port, (data) => data.pid !== before.pid);
    assert.equal(after.value, "after");
    assert.equal(after.cwd, before.cwd, "restart preserves the actual working directory");
    assert.equal(await fs.realpath(after.cwd), await fs.realpath(fixture.dir));
    assert.deepEqual(after.args, args.slice(1));
    assert.equal(after.env, fixture.env.DASHBOARD_FIXTURE_VALUE);
    const repeated = await restart(fixture, after.pid, { double: true });
    assert.equal(repeated.result.ok, true, repeated.result.message);
    assert.equal(repeated.second.ok, false);
    const third = await waitHttp(fixture.port, (data) => data.pid !== after.pid);
    assert.equal(third.value, "after");
    const listeners = (await readListeners()).filter((l) => l.localPort === fixture.port);
    assert.equal(new Set(listeners.map((l) => l.pid)).size, 1);
  });

  await test("npm run script reruns pre-hook and keeps forwarded arguments", async () => {
    const fixture = await createFixture("npm project");
    await fs.writeFile(path.join(fixture.dir, "hook.cjs"), "require('node:fs').appendFileSync('hook.txt','ran\\n')");
    await fs.writeFile(path.join(fixture.dir, "package.json"), JSON.stringify({ name: "dashboard-restart-fixture", private: true, scripts: { preserve: "node hook.cjs", serve: "node server.cjs" } }));
    assert.ok(process.env.npm_execpath, "Run through npm run test:servers:live to locate npm.");
    await start(fixture, process.execPath, [process.env.npm_execpath, "run", "serve", "--", "two words", "--sample=3000"]);
    const before = await waitHttp(fixture.port);
    const { result } = await restart(fixture, before.pid);
    assert.equal(result.ok, true, result.message);
    const after = await waitHttp(fixture.port, (data) => data.pid !== before.pid);
    assert.deepEqual(after.args, before.args);
    assert.equal((await fs.readFile(path.join(fixture.dir, "hook.txt"), "utf8")).trim().split("\n").length, 2);
  });

  await test("watcher parent and child both restart, without a duplicate respawn", async () => {
    const fixture = await createFixture("watcher");
    await fs.writeFile(path.join(fixture.dir, "watcher.cjs"), `const {spawn}=require('node:child_process'); function run(){const child=spawn(process.execPath,['server.cjs'],{env:{...process.env,DASHBOARD_FIXTURE_PARENT:String(process.pid)},stdio:'ignore'});child.on('exit',()=>setTimeout(run,25));} run();`);
    await start(fixture, process.execPath, ["watcher.cjs"]);
    const before = await waitHttp(fixture.port);
    const { result } = await restart(fixture, before.pid);
    assert.equal(result.ok, true, result.message);
    const after = await waitHttp(fixture.port, (data) => data.pid !== before.pid);
    assert.notEqual(after.parent, before.parent);
    assert.equal(new Set((await readListeners()).filter((l) => l.localPort === fixture.port).map((l) => l.pid)).size, 1);
  });

  await test("npm workspace restarts from the original root and reruns its hook", async () => {
    const fixture = await createFixture("workspace root/web");
    const workspaceRoot = path.dirname(fixture.dir);
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "fixture-monorepo", private: true, workspaces: ["web"] }));
    await fs.writeFile(path.join(fixture.dir, "hook.cjs"), "require('node:fs').appendFileSync('hook.txt','ran\\n')");
    await fs.writeFile(path.join(fixture.dir, "package.json"), JSON.stringify({ name: "fixture-web", scripts: { preserve: "node hook.cjs", serve: "node server.cjs" } }));
    await start({ ...fixture, dir: workspaceRoot }, process.execPath, [process.env.npm_execpath, "run", "serve", "--workspace", "fixture-web", "--", "workspace arg"]);
    const before = await waitHttp(fixture.port);
    const { result } = await restart(fixture, before.pid);
    assert.equal(result.ok, true, result.message);
    const after = await waitHttp(fixture.port, (data) => data.pid !== before.pid);
    assert.deepEqual(after.args, ["workspace arg"]);
    assert.equal((await fs.readFile(path.join(fixture.dir, "hook.txt"), "utf8")).trim().split("\n").length, 2);
  });

  await test("real Vite CLI retains explicit port, host and project config", async () => {
    const fixture = await createFixture("Vite project");
    await fs.writeFile(path.join(fixture.dir, "vite.config.mjs"), `import fs from 'node:fs'; const boot=JSON.parse(fs.readFileSync('boot.json','utf8')); export default { plugins:[{name:'fixture-response',configureServer(server){ const data=JSON.stringify({pid:process.pid,value:boot.value,cwd:process.cwd()}); server.middlewares.use((req,res)=>{res.setHeader('content-type','application/json');res.end(data)});}}] };`);
    await start(fixture, process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(fixture.port), "--strictPort"]);
    const before = await waitHttp(fixture.port);
    await fs.writeFile(path.join(fixture.dir, "boot.json"), JSON.stringify({ value: "Vite after" }));
    const { result } = await restart(fixture, before.pid);
    assert.equal(result.ok, true, result.message);
    assert.equal((await waitHttp(fixture.port, (data) => data.pid !== before.pid)).value, "Vite after");
  });

  await test("shared multi-project launcher refuses restart and leaves both servers running", async () => {
    const a = await createFixture("shared A"), b = await createFixture("shared B");
    await fs.writeFile(path.join(a.dir, "shared.cjs"), `const {spawn}=require('node:child_process'); spawn(process.execPath,['server.cjs'],{cwd:${JSON.stringify(a.dir)},env:process.env,stdio:'ignore'}); spawn(process.execPath,['server.cjs'],{cwd:${JSON.stringify(b.dir)},env:{...process.env,DASHBOARD_FIXTURE_PORT:${JSON.stringify(String(b.port))}},stdio:'ignore'}); setInterval(()=>{},1000);`);
    await start(a, process.execPath, ["shared.cjs"]);
    const beforeA = await waitHttp(a.port), beforeB = await waitHttp(b.port);
    const { result } = await restart(a, beforeA.pid);
    assert.equal(result.ok, false);
    assert.equal((await waitHttp(a.port)).pid, beforeA.pid);
    assert.equal((await waitHttp(b.port)).pid, beforeB.pid);
  });

  await test("one process with two listening ports recovers both", async () => {
    const extraPort = await freePort();
    const fixture = await createFixture("two ports", { extraPorts: [extraPort] });
    await start(fixture);
    const before = await waitHttp(fixture.port);
    const { result } = await restart(fixture, before.pid);
    assert.equal(result.ok, true, result.message);
    const after = await waitHttp(fixture.port, (data) => data.pid !== before.pid);
    assert.equal((await waitHttp(extraPort)).pid, after.pid);
  });

  await test("same command in two projects restarts only the selected project", async () => {
    const a = await createFixture("separate A"), b = await createFixture("separate B");
    await start(a); await start(b);
    const beforeA = await waitHttp(a.port), beforeB = await waitHttp(b.port);
    const { result } = await restart(a, beforeA.pid);
    assert.equal(result.ok, true, result.message);
    assert.notEqual((await waitHttp(a.port)).pid, beforeA.pid);
    assert.equal((await waitHttp(b.port)).pid, beforeB.pid);
  });

  await test("startup failure is reported and no retry loop or false success occurs", async () => {
    const fixture = await createFixture("startup failure");
    await start(fixture);
    const before = await waitHttp(fixture.port);
    await fs.writeFile(path.join(fixture.dir, "boot.json"), JSON.stringify({ fail: true }));
    const { result, events } = await restart(fixture, before.pid, { timeout: 8000 });
    assert.equal(result.ok, false);
    assert.equal(events.at(-1), "failed");
    assert.equal((await readListeners()).some((l) => l.localPort === fixture.port), false);
  });

  const python = process.env.DASHBOARD_TEST_PYTHON;
  if (python) {
    await test("Python server preserves interpreter, relative script, environment and cwd", async () => {
      const fixture = await createFixture("Python project");
      await fs.writeFile(path.join(fixture.dir, "server.py"), `import os,json,sys\nfrom http.server import HTTPServer,BaseHTTPRequestHandler\nboot=json.load(open('boot.json'))\ndata=json.dumps(dict(pid=os.getpid(),cwd=os.getcwd(),args=sys.argv[1:],value=boot['value'],env=os.environ['DASHBOARD_FIXTURE_VALUE'])).encode()\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(data)\n def log_message(self,*args): pass\nHTTPServer(('127.0.0.1',int(os.environ['DASHBOARD_FIXTURE_PORT'])),Handler).serve_forever()\n`);
      await start(fixture, python, ["server.py", "two words"]);
      const before = await waitHttp(fixture.port);
      await fs.writeFile(path.join(fixture.dir, "boot.json"), JSON.stringify({ value: "python after" }));
      const { result } = await restart(fixture, before.pid);
      assert.equal(result.ok, true, result.message);
      const after = await waitHttp(fixture.port, (data) => data.pid !== before.pid);
      assert.equal(after.value, "python after"); assert.deepEqual(after.args, ["two words"]);
      assert.equal(after.env, fixture.env.DASHBOARD_FIXTURE_VALUE);
    });
  } else { skipped++; console.log("SKIP Python live test, set DASHBOARD_TEST_PYTHON to an absolute interpreter path."); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try {
    const state = await inspector.snapshot();
    for (const original of [...owned.values()]) {
      for (const member of descendants(original, state.processes)) owned.set(member.pid, member);
    }
    await inspector.stop([...owned.values()]);
    await pause(300);
    const remaining = await inspector.snapshot();
    assert.equal(remaining.processes.filter((p) => owned.get(p.pid)?.started === p.started).length, 0, "all fixture processes were stopped");
    const absoluteRoot = path.resolve(root || ".");
    if (path.dirname(absoluteRoot) === path.resolve(os.tmpdir()) && path.basename(absoluteRoot).startsWith("local-dashboard-restart-")) await fs.rm(absoluteRoot, { recursive: true, force: true });
  } catch (error) { console.error("Fixture cleanup did not complete.", error.message); process.exitCode = 1; }
  inspector.dispose();
  for (const child of liveChildren) child.unref();
  console.log(`${passed} live scenarios passed, ${skipped} skipped. Fixture processes checked and removed.`);
});
