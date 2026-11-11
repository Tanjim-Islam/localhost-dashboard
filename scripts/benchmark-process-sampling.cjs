// Read-only benchmark: metrics are sampled from this script's own dummy
// processes. Compile tests first; an alternate compiled directory is optional.
const assert = require("node:assert/strict");
const path = require("node:path");
const cp = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { setTimeout: pause } = require("node:timers/promises");

let launches = 0;
const originalSpawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (...args) {
  launches++;
  return originalSpawn.apply(this, args);
};

const si = require("systeminformation");
const pidusage = require("pidusage");
const compiled = path.resolve(process.argv[2] || ".tmp-tests");
const { createProcessSnapshotReader, sampleProcessMetrics } = require(path.join(compiled, "src/main/process-sampling.js"));
const children = [];
const measurements = [];

async function measure(name, run) {
  const start = performance.now();
  const cpu = process.cpuUsage();
  const beforeLaunches = launches;
  const count = await run();
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  measurements.push({ name, elapsedMs: elapsed, parentCpuMs: (used.user + used.system) / 1000, childLaunches: launches - beforeLaunches, returnedItems: count });
}

async function main() {
  for (let i = 0; i < 4; i++) {
    const child = cp.spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  }
  const pids = children.map(child => child.pid);
  // Six service rows, including two pairs of listeners sharing one process.
  const servicePids = [...pids, pids[0], pids[1]];
  const warm = await sampleProcessMetrics(pids);
  assert.equal(warm.size, pids.length, "native metrics must work before comparing performance");
  // Raw OS-query cost is measured here. The server caller keeps its 5s timeout.
  const read = createProcessSnapshotReader();
  const scenarios = {
    "process-enumeration-before": async () => {
      const values = await Promise.all([si.processes(), si.processes()]);
      assert.ok(values.every(value => value.list.some(item => item.pid === pids[0])));
      return values[0].list.length;
    },
    "process-enumeration-after": async () => {
      const values = await Promise.all([read(), read()]);
      assert.equal(values[0], values[1]);
      assert.ok(values[0].list.some(item => item.pid === pids[0]));
      return values[0].list.length;
    },
    "metrics-before": async () => {
      for (const pid of servicePids) {
        const value = await pidusage(pid);
        assert.ok(Number.isFinite(value.cpu) && value.memory > 0);
      }
      return servicePids.length;
    },
    "metrics-after": async () => {
      const values = await sampleProcessMetrics(servicePids);
      assert.equal(values.size, pids.length);
      for (const pid of servicePids) assert.ok(values.get(pid).memory > 0);
      return servicePids.length;
    },
  };
  for (let round = 0; round < 3; round++) {
    const names = Object.keys(scenarios);
    if (round % 2) names.reverse();
    for (const name of names) {
      // Do not mistake systeminformation's short internal cache for a saving.
      await pause(600);
      await measure(name, scenarios[name]);
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(Object.keys(scenarios).map(name => {
    const rows = measurements.filter(row => row.name === name);
    return [name, {
      samples: rows.length,
      medianElapsedMs: +median(rows.map(row => row.elapsedMs)).toFixed(2),
      medianParentCpuMs: +median(rows.map(row => row.parentCpuMs)).toFixed(2),
      childLaunchesPerSample: rows.map(row => row.childLaunches),
    }];
  }));
  console.log(JSON.stringify({ platform: process.platform, dummyProcesses: pids.length, serviceRows: servicePids.length, summary, measurements }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    const closed = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await closed;
  }
  pidusage.clear();
  cp.ChildProcess.prototype.spawn = originalSpawn;
});
