import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthChecker } from "../src/main/health-checker";
import http from "node:http";

test("overlapping health cycles share requests and resume on the following cycle", async () => {
  const checker = new HealthChecker();
  checker.setServers([{ key: "fixture", url: "http://localhost:60000", firstSeen: 1 }]);
  let calls = 0;
  let updates = 0;
  let complete!: (value: { responseTime: number; endpoint: "http" }) => void;
  checker.on("update", () => updates++);
  checker["pingUrl"] = () => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  };
  const first = checker["checkAll"]();
  const overlapping = checker["checkAll"]();
  assert.equal(first, overlapping);
  assert.equal(calls, 1);
  complete({ responseTime: 12, endpoint: "http" });
  await Promise.all([first, overlapping]);
  assert.equal(updates, 1);
  const next = checker["checkAll"]();
  assert.equal(calls, 2);
  complete({ responseTime: 14, endpoint: "http" });
  await next;
  assert.equal(checker.getResults()[0].responseTime, 14);
});

test("changed URLs and removed instances reject late health results", async () => {
  for (const replacement of [[], [{ key: "fixture", url: "http://[::1]:60000", firstSeen: 1 }]]) {
    const checker = new HealthChecker();
    checker.setServers([{ key: "fixture", url: "http://localhost:60000", firstSeen: 1 }]);
    checker["pingUrl"] = async () => ({ responseTime: 2, endpoint: "http" });
    await checker["checkAll"]();
    assert.equal(checker.getResults().length, 1);
    let complete!: (value: { responseTime: number; endpoint: "http" }) => void;
    checker["pingUrl"] = () => new Promise(resolve => { complete = resolve; });
    const pending = checker["checkAll"]();
    checker.setServers(replacement);
    assert.deepEqual(checker.getResults(), []);
    complete({ responseTime: 20, endpoint: "http" });
    await pending;
    assert.deepEqual(checker.getResults(), []);
  }
});

test("an HTTP failure does not imply a stopped listener, and successful slow responses remain responsive", async () => {
  const checker = new HealthChecker();
  checker.setServers([
    { key: "10:60000", url: "http://localhost:60000", firstSeen: 1 },
  ]);
  checker["pingUrl"] = async () => {
    throw new Error("Timeout");
  };
  await checker["checkAll"]();
  assert.equal(checker.getResults()[0].status, "down");
  checker["pingUrl"] = async () => ({ responseTime: 2200, endpoint: "http" });
  await checker["checkAll"]();
  assert.equal(checker.getResults()[0].status, "slow");
  checker["pingUrl"] = async () => ({ responseTime: 10, endpoint: "http" });
  await checker["checkAll"]();
  assert.equal(checker.getResults()[0].status, "healthy");
});
test("late HTTP responses cannot attach to a replacement process using the same port", async () => {
  const checker = new HealthChecker();
  checker.setServers([
    { key: "10:60000", url: "http://localhost:60000", firstSeen: 1 },
  ]);
  let finish!: (response: { responseTime: number; endpoint: "http" }) => void;
  checker["pingUrl"] = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const checking = checker["checkAll"]();
  checker.setServers([
    { key: "10:60000", url: "http://localhost:60000", firstSeen: 2 },
  ]);
  finish({ responseTime: 10, endpoint: "http" });
  await checking;
  assert.deepEqual(checker.getResults(), []);
});

test("HTTP upgrade responses are reachable, and 426 alone does not prove WebSocket", async () => {
  for (const upgrade of [undefined, "websocket"]) {
    const server = http.createServer((_req, res) => {
      res.writeHead(426, upgrade ? { Upgrade: upgrade } : {});
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const checker = new HealthChecker();
      checker.setServers([
        {
          key: "fixture",
          url: `http://127.0.0.1:${address.port}`,
          firstSeen: 1,
        },
      ]);
      await checker["checkAll"]();
      const result = checker.getResults()[0];
      assert.notEqual(result.status, "down");
      assert.equal(result.httpStatus, 426);
      assert.equal(result.endpoint, upgrade ? "websocket" : "upgrade");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
