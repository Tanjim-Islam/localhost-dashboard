import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProcessSnapshotReader,
  sampleProcessMetrics,
} from "../src/main/process-sampling";
import { boundedObservation } from "../src/main/server-detection";

const snapshot = { all: 0, running: 0, blocked: 0, sleeping: 0, unknown: 0, list: [] };

test("concurrent server and script observations share one query without caching completed snapshots", async () => {
  let calls = 0;
  let complete!: (value: typeof snapshot) => void;
  const read = createProcessSnapshotReader(() => {
    calls++;
    return new Promise((resolve) => { complete = resolve; });
  });
  const server = read();
  const scripts = read();
  assert.equal(server, scripts);
  assert.equal(calls, 1);
  complete(snapshot);
  assert.deepEqual(await server, snapshot);
  const next = read();
  assert.equal(calls, 2);
  complete(snapshot);
  await next;
});

test("a timed-out caller cannot duplicate a pending query or discard its eventual result", async () => {
  let calls = 0;
  let complete!: (value: typeof snapshot) => void;
  const read = createProcessSnapshotReader(() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("unavailable"));
    if (calls === 2) return new Promise(resolve => { complete = resolve; });
    return Promise.resolve(snapshot);
  });
  await assert.rejects(read(), /unavailable/);
  const slow = read();
  await assert.rejects(boundedObservation(slow, 10), /timed out/i);
  assert.equal(read(), slow);
  assert.equal(calls, 2);
  complete(snapshot);
  assert.deepEqual(await slow, snapshot);
  assert.deepEqual(await read(), snapshot);
  assert.equal(calls, 3);
});

test("metrics batch unique valid PIDs and preserve distinct process readings", async () => {
  const calls: number[][] = [];
  const metrics = await sampleProcessMetrics([10, 10, 11, 0, -1, NaN, 1.5], async (pids) => {
    calls.push([...pids]);
    return { 10: { cpu: 3, memory: 1024 }, 11: { cpu: 8, memory: 2048 } };
  });
  assert.deepEqual(calls, [[10, 11]]);
  assert.deepEqual(metrics.get(10), { cpu: 3, memory: 1024 });
  assert.deepEqual(metrics.get(11), { cpu: 8, memory: 2048 });
});

test("a process exiting during a batch cannot discard surviving process metrics", async () => {
  const calls: number[][] = [];
  const metrics = await sampleProcessMetrics([10, 11], async (pids) => {
    calls.push([...pids]);
    if (pids.includes(11)) throw new Error("process exited");
    return { 10: { cpu: 3, memory: 1024 } };
  });
  assert.deepEqual(calls, [[10, 11], [10], [11]]);
  assert.deepEqual([...metrics.keys()], [10]);
});

test("partial batch metrics stay optional and command size remains bounded", async () => {
  const sizes: number[] = [];
  const metrics = await sampleProcessMetrics(Array.from({ length: 300 }, (_, i) => i + 1), async (pids) => {
    sizes.push(pids.length);
    return Object.fromEntries(pids.filter(pid => pid !== 2).map(pid => [pid, { cpu: 0, memory: 1024 }]));
  });
  assert.deepEqual(sizes, [128, 128, 44]);
  assert.equal(metrics.size, 299);
  assert.equal(metrics.has(2), false);
  await sampleProcessMetrics([], async () => { assert.fail("empty sample must not spawn a query"); });
});
