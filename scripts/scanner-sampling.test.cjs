// Isolated scanner wiring tests. Never load the user's Electron settings.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const fs = require("node:fs");
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(output, filename);
};
const settingsPath = require.resolve("../src/main/settings.ts");
require.cache[settingsPath] = { exports: { settings: { get: () => 5000 } } };
const { AHKScanner } = require("../src/main/ahk-scanner.ts");
const { AutomatorScanner } = require("../src/main/automator-scanner.ts");
const { Scanner } = require("../src/main/scanner.ts");
const sampling = require("../src/main/process-sampling.ts");
const listeners = require("../src/main/server-restart/listeners.ts");
const { NativeProcessHost } = require("../src/main/server-restart/native-host.ts");
const si = require("systeminformation");
const empty = { all: 0, running: 0, blocked: 0, sleeping: 0, unknown: 0, list: [] };

test("script scanners coalesce overlapping scans", async (t) => {
  // Unsupported-platform scanner has no process discovery to mock.
  const scanner = process.platform === "darwin" ? new AHKScanner() : new AutomatorScanner();
  let enter;
  let complete;
  const entered = new Promise(resolve => { enter = resolve; });
  let calls = 0;
  t.mock.method(sampling, "sampleProcessMetrics", () => {
    calls++;
    enter();
    return new Promise(resolve => { complete = () => resolve(new Map()); });
  });
  const first = scanner.scan();
  assert.equal(scanner.scan(), first);
  await entered;
  assert.equal(calls, 1);
  complete();
  await first;
  const next = scanner.scan();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  complete();
  await next;
});

test("an unavailable AHK process table preserves running scripts", { skip: process.platform !== "win32" }, async (t) => {
  const scanner = new AHKScanner();
  const record = { key: "900001", pid: 900001, processName: "AutoHotkey.exe", scriptName: "fixture.ahk", firstSeen: 1, lastSeen: 1 };
  scanner.items.set(record.key, record);
  let stopped = 0;
  let errors = 0;
  scanner.on("stopped", () => stopped++);
  scanner.on("error", () => errors++);
  t.mock.method(console, "error", () => {});
  t.mock.method(sampling, "readProcessSnapshot", async () => { throw new Error("query unavailable"); });
  await scanner.scan();
  assert.equal(stopped, 0);
  assert.equal(errors, 1);
  assert.deepEqual(scanner.getItems(), [record]);
});

test("multiple listener ports share one native metrics query and retain per-row histories", { skip: !["win32", "darwin"].includes(process.platform) }, async (t) => {
  const scanner = new Scanner("unused", item => ({ ...item, discovery: "development" }));
  t.mock.method(si, "networkConnections", async () => []);
  t.mock.method(sampling, "readProcessSnapshot", async () => empty);
  t.mock.method(listeners, "readListeners", async () => [
    { pid: 900001, localPort: 60001 }, { pid: 900001, localPort: 60002 },
    { pid: 900002, localPort: 60003 },
  ]);
  t.mock.method(NativeProcessHost.prototype, "snapshot", async () => ({ processes: [], contexts: [] }));
  const original = sampling.sampleProcessMetrics;
  const batches = [];
  t.mock.method(sampling, "sampleProcessMetrics", pids => original(pids, async batch => {
    batches.push(batch);
    return { 900001: { cpu: 5, memory: 1024 }, 900002: { cpu: 8, memory: 2048 } };
  }));
  await scanner.scan();
  await scanner.scan();
  assert.deepEqual(batches, [[900001, 900002], [900001, 900002]]);
  const rows = scanner.getItems();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.cpu, row.pid === 900001 ? 5 : 8);
    assert.equal(row.memory, row.pid === 900001 ? 1024 : 2048);
    assert.deepEqual(row.cpuHistory, row.pid === 900001 ? [5, 5] : [8, 8]);
  }
});
