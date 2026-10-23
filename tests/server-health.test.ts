import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthChecker } from "../src/main/health-checker";
import http from "node:http";

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
