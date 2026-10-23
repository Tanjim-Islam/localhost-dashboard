import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthChecker } from "../src/main/health-checker";

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
  checker["pingUrl"] = async () => 2200;
  await checker["checkAll"]();
  assert.equal(checker.getResults()[0].status, "slow");
  checker["pingUrl"] = async () => 10;
  await checker["checkAll"]();
  assert.equal(checker.getResults()[0].status, "healthy");
});
test("late HTTP responses cannot attach to a replacement process using the same port", async () => {
  const checker = new HealthChecker();
  checker.setServers([
    { key: "10:60000", url: "http://localhost:60000", firstSeen: 1 },
  ]);
  let finish!: (ms: number) => void;
  checker["pingUrl"] = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const checking = checker["checkAll"]();
  checker.setServers([
    { key: "10:60000", url: "http://localhost:60000", firstSeen: 2 },
  ]);
  finish(10);
  await checking;
  assert.deepEqual(checker.getResults(), []);
});
