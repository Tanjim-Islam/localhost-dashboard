import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildRestartPlan, descendants } from "../src/main/server-restart/plan";
import { ServerRestartController, type RestartDependencies } from "../src/main/server-restart/controller";
import { validateServerRef, type LaunchContext, type ProcessIdentity, type ProcessSnapshot, type RestartProgress } from "../src/main/server-restart/types";
import { parseNetstatListeners } from "../src/main/server-restart/listeners";
import { literalShellWords, recoverNpmContexts } from "../src/main/server-restart/npm-context";

function context(pid = 100, ppid = 10, executable = "/usr/local/bin/node", argv = ["node", "server.js"]): LaunchContext {
  return { pid, ppid, executable, argv, started: String(pid), startedMs: 1700000000000 + pid,
    cwd: "/projects/a project", env: { PATH: "/usr/bin", CUSTOM: "with spaces & special $values" } };
}
function snapshot(...contexts: LaunchContext[]): ProcessSnapshot { return { processes: contexts, contexts }; }

test("restart validates IPC references and drops untrusted command/path fields", () => {
  for (const invalid of [null, 10, {}, { key: "0:3000", firstSeen: 1 }, { key: "12:99999", firstSeen: 1 }, { key: "12:3000 && cmd", firstSeen: 1 }, { key: "12:3000", firstSeen: NaN }]) assert.throws(() => validateServerRef(invalid));
  assert.deepEqual(validateServerRef({ key: "100:3000", firstSeen: 10, command: "evil", cwd: "/evil" }), { key: "100:3000", firstSeen: 10 });
});

test("direct server retains exact arguments, cwd, environment and all its ports", () => {
  const server = context(); server.argv.push("", "a b", "a\"b", "$HOME;touch nope");
  const plan = buildRestartPlan(snapshot(server), [{ pid: 100, localPort: 3000 }, { pid: 100, localPort: 3001 }], 100, "darwin", new Set());
  assert.deepEqual(plan.launch, server);
  assert.deepEqual(plan.ports, [3000, 3001]);
});

test("npm script selects original package launcher through its shell, preserving workspace flags", () => {
  const npm = context(80, 10, "C:\\node\\node.exe", ["node", "C:\\node\\npm-cli.js", "run", "dev", "--workspace", "web", "--", "--port", "3000"]);
  const shell = context(90, 80, "C:\\Windows\\System32\\cmd.exe", ["cmd", "/d", "/s", "/c", "node server.js"]);
  const server = context(100, 90, "C:\\node\\node.exe");
  for (const item of [npm, shell, server]) item.cwd = "C:\\Projects\\space & Unicode বাংলা";
  const plan = buildRestartPlan(snapshot(npm, shell, server), [{ pid: 100, localPort: 3000 }], 100, "win32", new Set());
  assert.equal(plan.launch.pid, 80);
  assert.deepEqual(plan.launch.argv, npm.argv);
  assert.deepEqual(plan.tree.map((p) => p.pid), [80, 90, 100]);
});

test("Python reloader and Node watcher restart their parent with fresh code", () => {
  for (const [exe, args] of [["/usr/bin/python3", ["python3", "-m", "uvicorn", "app:app", "--reload"]], ["/usr/bin/node", ["node", "/project/node_modules/nodemon/bin/nodemon.js", "server.js"]]] as const) {
    const parent = context(80, 10, exe, [...args]);
    const server = context(100, 80, exe, [exe, "worker"]);
    assert.equal(buildRestartPlan(snapshot(parent, server), [{ pid: 100, localPort: 3000 }], 100, "darwin", new Set()).launch.pid, 80);
  }
});

test("interactive shells, IDEs and reused parent PIDs are not restarted", () => {
  for (const parent of [context(80, 10, "/bin/zsh", ["zsh"]), context(80, 10, "/Applications/Code.app/Electron", ["Electron"]), { ...context(80), startedMs: 1800000000000 }]) {
    const server = context(100, 80);
    assert.equal(buildRestartPlan(snapshot(parent, server), [{ pid: 100, localPort: 3000 }], 100, "darwin", new Set()).launch.pid, 100);
  }
});

test("ambiguous shared launchers, unreadable context, missing env and system apps fail before stopping", () => {
  const parent = context(80), server = context(100, 80), sibling = context(110, 80);
  assert.throws(() => buildRestartPlan(snapshot(parent, server, sibling), [{ pid: 100, localPort: 3000 }, { pid: 110, localPort: 4000 }], 100, "darwin", new Set()), /another server/);
  assert.throws(() => buildRestartPlan({ processes: [server], contexts: [] }, [{ pid: 100, localPort: 3000 }], 100, "darwin", new Set()), /Cannot read/);
  assert.throws(() => buildRestartPlan(snapshot({ ...server, env: {} }), [{ pid: 100, localPort: 3000 }], 100, "darwin", new Set()), /incomplete/);
  assert.throws(() => buildRestartPlan(snapshot({ ...server, executable: "/System/ControlCenter" }), [{ pid: 100, localPort: 3000 }], 100, "darwin", new Set()), /development runtimes/);
  assert.throws(() => buildRestartPlan(snapshot(server), [{ pid: 100, localPort: 3000 }, { pid: 999, localPort: 3000 }], 100, "darwin", new Set()), /Another process/);
});

test("Windows listener parsing covers IPv4, IPv6 and ignores established connections", () => {
  assert.deepEqual(parseNetstatListeners(" TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 100\n TCP [::]:3001 [::]:0 LISTENING 100\n TCP 127.0.0.1:99 127.0.0.1:1 ESTABLISHED 20"), [{ pid: 100, localPort: 3000 }, { pid: 100, localPort: 3001 }]);
});

function harness(options: { platform?: NodeJS.Platform; stale?: boolean; missing?: boolean; stuck?: boolean; exit?: boolean; collision?: boolean; timeout?: boolean; privacyError?: boolean } = {}) {
  const original = context();
  const replacement = context(200);
  let now = 1700000001000;
  let stopped = false, launched = false, stops = 0, launches = 0;
  const events: RestartProgress[] = [];
  const ref = { key: "100:3000", firstSeen: 1 };
  const deps: RestartDependencies = {
    platform: options.platform ?? "darwin", ownPid: 9999, now: () => now,
    getServer: () => options.stale ? undefined : { ...ref, pid: 100, port: 3000, processStarted: new Date(original.startedMs).toISOString() },
    createHost: () => ({
      snapshot: async () => {
        if (options.privacyError) throw new Error("SECRET_TOKEN=do-not-leak");
        return snapshot(...(!stopped || options.stuck ? [original] : launched && !options.exit ? [replacement] : []));
      },
      interrupt: async () => false,
      stop: async (_targets: ProcessIdentity[]) => { stops++; stopped = true; },
      dispose: () => {},
    }),
    listeners: async () => !stopped || options.stuck ? [{ pid: 100, localPort: 3000 }] : options.collision ? [{ pid: 12345, localPort: 3000 }] : launched && !options.timeout && !options.exit ? [{ pid: 200, localPort: 3000 }] : [],
    launch: async () => { launches++; launched = true; return { pid: 200, exited: () => !!options.exit, detach: () => {} }; },
    preflight: async () => { if (options.missing) throw new Error("missing"); },
    progress: (event) => events.push(event), completed: async () => {},
    pause: async (ms) => { now += ms; }, startupTimeoutMs: 2000,
  };
  return { controller: new ServerRestartController(deps), ref, events, counts: () => ({ stops, launches }), deps };
}

test("controller verifies replacement PID and stable original port before success", async () => {
  const run = harness();
  assert.equal((await run.controller.restart(run.ref)).ok, true);
  assert.deepEqual(run.counts(), { stops: 1, launches: 1 });
  assert.deepEqual(run.events.map((p) => p.phase), ["preparing", "stopping", "starting", "ready"]);
});

test("controller refuses stale references and unsafe preparations without stopping", async () => {
  for (const options of [{ stale: true }, { missing: true }, { platform: "linux" as const }, { privacyError: true }]) {
    const run = harness(options);
    const result = await run.controller.restart(run.ref);
    assert.equal(result.ok, false);
    assert.deepEqual(run.counts(), { stops: 0, launches: 0 });
    assert.doesNotMatch(JSON.stringify([result, run.events]), /SECRET_TOKEN|do-not-leak/);
  }
});

test("controller does not spawn after failed stop or a port stolen before launch", async () => {
  for (const options of [{ stuck: true }, { collision: true }]) {
    const run = harness(options);
    assert.equal((await run.controller.restart(run.ref)).ok, false);
    assert.equal(run.counts().launches, 0);
  }
});

test("controller reports startup exit and timeout without a false ready or retry loop", async () => {
  for (const options of [{ exit: true }, { timeout: true }]) {
    const run = harness(options);
    assert.equal((await run.controller.restart(run.ref)).ok, false);
    assert.equal(run.counts().launches, 1);
    assert.equal(run.events.at(-1)?.phase, "failed");
  }
});

test("concurrent restart clicks cannot spawn duplicate servers", async () => {
  const run = harness();
  const [first, second] = await Promise.all([run.controller.restart(run.ref), run.controller.restart(run.ref)]);
  assert.equal(first.ok, true); assert.equal(second.ok, false);
  assert.deepEqual(run.counts(), { stops: 1, launches: 1 });
});

test("POSIX literal argument parsing preserves quoted spaces, empty strings and escaped metacharacters", () => {
  assert.deepEqual(literalShellWords(`--flag '' 'two words' "a\\\"b" 'it'\\''s' \\$literal`), ["--flag", "", "two words", 'a"b', "it's", "$literal"]);
  for (const text of ["$HOME", "$(touch file)", "x; y", "x && y", "*.js", "`cmd`", "'unfinished"]) assert.equal(literalShellWords(text), null);
});

test("macOS recovers overwritten npm argv from an observed shell without losing forwarded quoted args", async () => {
  const npm = context(80, 10, "/usr/bin/node", ["npm run dev two words", "", ""]);
  const shell = context(90, 80, "/bin/sh", ["sh", "-c", "node server.js 'two words' ''"]);
  shell.env = { ...shell.env, npm_execpath: "/usr/lib/npm/bin/npm-cli.js", npm_package_json: "/projects/a project/package.json", npm_lifecycle_event: "dev", npm_lifecycle_script: "node server.js" };
  const server = context(100, 90);
  const result = await recoverNpmContexts(snapshot(npm, shell, server), "darwin");
  assert.deepEqual(result.contexts[0].argv, ["/usr/bin/node", "/usr/lib/npm/bin/npm-cli.js", "run", "dev", "--", "two words", ""]);
});

test("macOS recovers npm after the script shell execs a package CLI, using its resolved bin path", async () => {
  const npm = context(80, 10, "/usr/bin/node", ["npm run dev --port 3000", ""]);
  const server = context(100, 80, "/usr/bin/node", ["node", "/projects/web/node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "3000"]);
  server.cwd = "/projects/web";
  server.env = { PATH: "/projects/web/node_modules/.bin:/usr/bin", npm_execpath: "/usr/lib/npm/bin/npm-cli.js", npm_package_json: "/projects/web/package.json", npm_lifecycle_event: "dev", npm_lifecycle_script: "vite --host 127.0.0.1" };
  const paths = new Map([["/projects/web/node_modules/.bin/vite", "/projects/web/node_modules/vite/bin/vite.js"], ["/projects/web/node_modules/vite/bin/vite.js", "/projects/web/node_modules/vite/bin/vite.js"], ["/usr/bin/node", "/usr/bin/node"]]);
  const result = await recoverNpmContexts(snapshot(npm, server), "darwin", new Set(), async (p) => { const resolved = paths.get(p); if (!resolved) throw new Error(); return resolved; });
  assert.deepEqual(result.contexts[0].argv.slice(2), ["run", "dev", "--", "--port", "3000"]);
  assert.equal(result.contexts[0].cwd, "/projects/web");
});

test("macOS refuses ambiguous npm recovery and excludes the dashboard's own ancestors", async () => {
  const npm = context(80, 10, "/usr/bin/node", ["npm run dev", ""]);
  await assert.rejects(recoverNpmContexts(snapshot(npm), "darwin"), /could not be recovered/);
  assert.deepEqual(await recoverNpmContexts(snapshot(npm), "darwin", new Set([80])), snapshot(npm));
});

test("shared cluster/reloader socket is allowed, while a service manager is refused", () => {
  const parent = context(80), worker = context(100, 80), sibling = context(110, 80);
  const plan = buildRestartPlan(snapshot(parent, worker, sibling), [{ pid: 80, localPort: 3000 }, { pid: 100, localPort: 3000 }, { pid: 110, localPort: 3000 }], 100, "darwin", new Set());
  assert.equal(plan.launch.pid, 80);
  assert.deepEqual(plan.ports, [3000]);
  const service = context(50, 1, "C:\\Windows\\System32\\services.exe", ["services.exe"]);
  const node = context(100, 50, "C:\\node.exe", ["node", "service.js"]); node.cwd = "C:\\project";
  assert.throws(() => buildRestartPlan(snapshot(service, node), [{ pid: 100, localPort: 3000 }], 100, "win32", new Set()), /service or container/);
});

test("PID reuse does not associate the replacement process's children with an old launcher", () => {
  const original = context(80);
  const reused = { ...original, started: "new identity", startedMs: original.startedMs + 1000 };
  const unrelatedChild = { ...context(100, 80), startedMs: reused.startedMs + 100 };
  assert.deepEqual(descendants(original, [reused, unrelatedChild]), []);
});

test("a fresh but reused PID is rejected before stopping anything", async () => {
  const run = harness();
  run.deps.getServer = () => ({ ...run.ref, pid: 100, port: 3000, processStarted: new Date(1600000000000).toISOString() });
  assert.equal((await run.controller.restart(run.ref)).ok, false);
  assert.deepEqual(run.counts(), { stops: 0, launches: 0 });
});

test("listener inspection failure leaves the original running and sanitizes its error", async () => {
  const run = harness();
  run.deps.listeners = async () => { throw new Error("private command output"); };
  const result = await run.controller.restart(run.ref);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, /private command output/);
  assert.deepEqual(run.counts(), { stops: 0, launches: 0 });
});

test("a port stolen after launch is not mistaken for the new project", async () => {
  const run = harness();
  const normalListeners = run.deps.listeners;
  const host = run.deps.createHost();
  const normalSnapshot = host.snapshot;
  host.snapshot = async () => {
    const state = await normalSnapshot();
    if (run.counts().launches) state.processes.push(context(54321, 999));
    return state;
  };
  run.deps.createHost = () => host;
  run.deps.listeners = async () => run.counts().launches ? [{ pid: 54321, localPort: 3000 }] : normalListeners();
  const result = await run.controller.restart(run.ref);
  assert.equal(result.ok, false);
  assert.match(result.message, /different process/);
});

test("a launcher child born during the listener read is verified with a newer process snapshot", async () => {
  const run = harness();
  const host = run.deps.createHost();
  const normalSnapshot = host.snapshot;
  const normalListeners = run.deps.listeners;
  let workerListening = false;
  host.snapshot = async () => {
    const state = await normalSnapshot();
    if (workerListening) state.processes.push(context(201, 200));
    return state;
  };
  run.deps.createHost = () => host;
  run.deps.listeners = async () => {
    if (!run.counts().launches) return normalListeners();
    workerListening = true;
    return [{ pid: 201, localPort: 3000 }];
  };
  assert.equal((await run.controller.restart(run.ref)).ok, true);
  assert.deepEqual(run.counts(), { stops: 1, launches: 1 });
});

test("a transient listener whose process has already exited is never treated as ready", async () => {
  const run = harness();
  const normalListeners = run.deps.listeners;
  run.deps.listeners = async () => run.counts().launches ? [{ pid: 333, localPort: 3000 }] : normalListeners();
  const result = await run.controller.restart(run.ref);
  assert.equal(result.ok, false);
  assert.match(result.message, /did not return/);
  assert.equal(run.events.at(-1)?.phase, "failed");
});
