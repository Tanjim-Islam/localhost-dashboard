import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseLsofListeningOutput,
  parseNumericPid,
  parseNumericPort,
  shouldIgnoreListener,
} from "../src/main/server-detection";

test("normalizes macOS systeminformation string ports and invalid PIDs", () => {
  assert.equal(parseNumericPort("5173"), 5173);
  assert.equal(parseNumericPort(3000), 3000);
  assert.equal(parseNumericPid(Number.NaN), undefined);
  assert.equal(parseNumericPid("93751"), 93751);
});

test("parses lsof listen output with real PIDs for macOS fallback scanning", () => {
  const output = `
p93751
n127.0.0.1:5173
p93786
n127.0.0.1:3000
`;

  assert.deepEqual(parseLsofListeningOutput(output), [
    { protocol: "tcp", localPort: 5173, pid: 93751, state: "LISTEN" },
    { protocol: "tcp", localPort: 3000, pid: 93786, state: "LISTEN" },
  ]);
});

test("ignores the macOS Control Center listener on port 5000 without affecting Windows", () => {
  assert.equal(
    shouldIgnoreListener(
      "darwin",
      5000,
      "ControlCenter",
      "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter",
    ),
    true,
  );
  assert.equal(
    shouldIgnoreListener("win32", 5000, "node", "node server.js"),
    false,
  );
});
