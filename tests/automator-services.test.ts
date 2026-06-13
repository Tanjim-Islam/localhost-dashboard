import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  attachAnonymousWorkflowRunners,
  discoverServiceScriptEntries,
  type ServiceScriptEntry,
} from "../src/main/automator-services";

test("discovers workflow and script files from a Services directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "services-"));
  fs.mkdirSync(path.join(root, "cleanup-system.workflow"));
  fs.mkdirSync(path.join(root, "~:update-cli.workflow"));
  fs.writeFileSync(path.join(root, "awei-keepalive.swift"), "#!/usr/bin/env swift\n");
  fs.writeFileSync(path.join(root, ".DS_Store"), "");

  const entries = await discoverServiceScriptEntries(root, [
    {
      pid: 981,
      ppid: 1,
      elapsedSeconds: 42,
      commandLine:
        "/Library/Developer/CommandLineTools/usr/bin/swift-frontend -frontend -interpret " +
        path.join(root, "awei-keepalive.swift"),
    },
  ]);

  assert.deepEqual(
    entries.map((entry: ServiceScriptEntry) => ({
      name: entry.scriptName,
      path: entry.scriptPath,
      pid: entry.pid,
      canOpenInAutomator: entry.canOpenInAutomator,
    })),
    [
      {
        name: "awei-keepalive",
        path: path.join(root, "awei-keepalive.swift"),
        pid: 981,
        canOpenInAutomator: false,
      },
      {
        name: "cleanup-system",
        path: path.join(root, "cleanup-system.workflow"),
        pid: undefined,
        canOpenInAutomator: true,
      },
      {
        name: "update-cli",
        path: path.join(root, "~:update-cli.workflow"),
        pid: undefined,
        canOpenInAutomator: true,
      },
    ],
  );
});

test("attaches anonymous Automator runner PIDs only when Services workflows match exactly", () => {
  const entries: ServiceScriptEntry[] = [
    {
      key: "/Users/test/Library/Services/cleanup-system.workflow",
      scriptPath: "/Users/test/Library/Services/cleanup-system.workflow",
      scriptName: "cleanup-system",
      sourceKind: "service-workflow",
      sourceLabel: "Automator workflow",
      status: "installed",
      lastSeen: 1,
      canOpenInAutomator: true,
    },
    {
      key: "/Users/test/Library/Services/~:update-cli.workflow",
      scriptPath: "/Users/test/Library/Services/~:update-cli.workflow",
      scriptName: "update-cli",
      sourceKind: "service-workflow",
      sourceLabel: "Automator workflow",
      status: "installed",
      lastSeen: 1,
      canOpenInAutomator: true,
    },
  ];

  const attached = attachAnonymousWorkflowRunners(entries, [
    {
      pid: 4659,
      ppid: 1,
      processName: "WorkflowServiceRunner",
      scriptName: "WorkflowServiceRunner",
      sourceKind: "workflow-service-runner",
      sourceLabel: "Workflow service runner",
      commandLine: "/System/Library/Frameworks/AppKit.framework/WorkflowServiceRunner",
      elapsedSeconds: 10,
      canOpenInAutomator: false,
    },
    {
      pid: 4661,
      ppid: 1,
      processName: "com.apple.automator.runner",
      scriptName: "Automator Runner",
      sourceKind: "automator-runner",
      sourceLabel: "Automator runner",
      commandLine: "/System/Library/Frameworks/Automator.framework/com.apple.automator.runner",
      elapsedSeconds: 8,
      canOpenInAutomator: false,
    },
  ]);

  assert.deepEqual(
    attached.map((entry) => ({
      name: entry.scriptName,
      status: entry.status,
      pid: entry.pid,
    })),
    [
      { name: "cleanup-system", status: "running", pid: 4659 },
      { name: "update-cli", status: "running", pid: 4661 },
    ],
  );

  const unmatched = attachAnonymousWorkflowRunners(entries, [
    {
      pid: 999,
      ppid: 1,
      processName: "WorkflowServiceRunner",
      scriptName: "WorkflowServiceRunner",
      sourceKind: "workflow-service-runner",
      sourceLabel: "Workflow service runner",
      commandLine: "/System/Library/Frameworks/AppKit.framework/WorkflowServiceRunner",
      canOpenInAutomator: false,
    },
  ]);

  assert.deepEqual(
    unmatched.map((entry) => entry.status),
    ["installed", "installed"],
  );
});
