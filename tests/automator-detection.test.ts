import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectAutomatorProcesses,
  parseElapsedSeconds,
  parsePsOutput,
} from "../src/main/automator-detection";

test("parses macOS ps rows without relying on shell output in the renderer", () => {
  const rows = parsePsOutput(`
 4659     1 23:15:59 /System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/WorkflowServiceRunner.xpc/Contents/MacOS/WorkflowServiceRunner
 4661     1 1-02:03:04 /System/Library/Frameworks/Automator.framework/Versions/A/XPCServices/com.apple.automator.runner.xpc/Contents/MacOS/com.apple.automator.runner
`);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 4659);
  assert.equal(rows[0].elapsedSeconds, 83759);
  assert.equal(rows[1].elapsedSeconds, 93784);
});

test("detects the live Automator runner processes macOS exposes for workflows", () => {
  const detected = detectAutomatorProcesses([
    {
      pid: 4659,
      ppid: 1,
      elapsedSeconds: 83759,
      commandLine:
        "/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/WorkflowServiceRunner.xpc/Contents/MacOS/WorkflowServiceRunner",
    },
    {
      pid: 4661,
      ppid: 1,
      elapsedSeconds: 83758,
      commandLine:
        "/System/Library/Frameworks/Automator.framework/Versions/A/XPCServices/com.apple.automator.runner.xpc/Contents/MacOS/com.apple.automator.runner",
    },
  ]);

  const workflowRunner = detected.find((item) => item.sourceKind === "workflow-service-runner");
  const automatorRunner = detected.find((item) => item.sourceKind === "automator-runner");

  assert.equal(detected.length, 2);
  assert.equal(workflowRunner?.scriptName, "WorkflowServiceRunner");
  assert.equal(automatorRunner?.scriptName, "Automator Runner");
});

test("detects saved Automator app bundles and exposes the app path", () => {
  const detected = detectAutomatorProcesses([
    {
      pid: 123,
      ppid: 1,
      elapsedSeconds: 12,
      commandLine:
        "/Users/me/Automation/Nightly Build.app/Contents/MacOS/Application Stub",
    },
  ]);

  assert.equal(detected.length, 1);
  assert.equal(detected[0].scriptName, "Nightly Build.app");
  assert.equal(detected[0].scriptPath, "/Users/me/Automation/Nightly Build.app");
  assert.equal(detected[0].sourceKind, "automator-app");
  assert.equal(detected[0].canOpenInAutomator, true);
});

test("detects AppleScript files when the path is visible in osascript arguments", () => {
  const detected = detectAutomatorProcesses([
    {
      pid: 456,
      ppid: 1,
      elapsedSeconds: 34,
      commandLine: '/usr/bin/osascript "/Users/me/Scripts/Sync Mail.scpt"',
    },
  ]);

  assert.equal(detected.length, 1);
  assert.equal(detected[0].scriptName, "Sync Mail.scpt");
  assert.equal(detected[0].scriptPath, "/Users/me/Scripts/Sync Mail.scpt");
  assert.equal(detected[0].sourceKind, "osascript");
});

test("ignores Shortcuts service processes in the Automator tab", () => {
  const detected = detectAutomatorProcesses([
    {
      pid: 1814,
      ppid: 1,
      elapsedSeconds: parseElapsedSeconds("23:21:47"),
      commandLine:
        "/System/Library/PrivateFrameworks/WorkflowKit.framework/XPCServices/ShortcutsViewService.xpc/Contents/MacOS/ShortcutsViewService",
    },
  ]);

  assert.deepEqual(detected, []);
});
