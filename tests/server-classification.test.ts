import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicationOwner,
  classifyListener,
} from "../src/main/projects/classify";
import type {
  ProcessIdentity,
  ProcessSnapshot,
} from "../src/main/server-restart/types";

const processInfo = (
  pid: number,
  executable: string,
  ppid = 0,
): ProcessIdentity => ({
  pid,
  ppid,
  executable,
  started: String(pid),
  startedMs: pid * 1000,
});
const snapshot = (...processes: ProcessIdentity[]): ProcessSnapshot => ({
  processes,
  contexts: [],
});
const context = (executable: string, ...args: string[]) => ({
  executable,
  cwd: "D:/Work/project",
  argv: [executable, ...args],
});

test("Raycast is identified from the bundled runtime and actual parent, without port matching", () => {
  const root =
    "C:/Program Files/WindowsApps/Raycast.Raycast_2.9.0.0_x64__fixture/Raycast";
  const owner = applicationOwner(
    snapshot(
      processInfo(2, `${root}/backend/node.exe`, 1),
      processInfo(1, `${root}/Raycast.exe`),
    ),
    2,
    "win32",
  );
  assert.equal(owner?.name, "Raycast");
  assert.equal(owner?.evidence, "bundled-runtime");
  const result = classifyListener({
    name: "node.exe",
    context: context(`${root}/backend/node.exe`, `${root}/backend/index.mjs`),
    application: owner,
  });
  assert.equal(result.discovery, "application");
  assert.equal(result.serviceName, "Raycast");
  assert.equal(result.framework, "Node.js");
  assert.equal(
    classifyListener({
      name: "node.exe",
      context: context("C:/Program Files/nodejs/node.exe", "server.js"),
    }).discovery,
    "development",
  );
});

test("IDE and terminal ancestors do not absorb external development runtimes", () => {
  for (const ancestor of [
    "C:/Users/test/AppData/Local/Programs/Microsoft VS Code/Code.exe",
    "C:/Windows/System32/cmd.exe",
  ]) {
    assert.equal(
      applicationOwner(
        snapshot(
          processInfo(2, "C:/Program Files/nodejs/node.exe", 1),
          processInfo(1, ancestor),
        ),
        2,
        "win32",
      ),
      undefined,
    );
  }
  // Similar prefixes, a new parent with a reused PID, and missing metadata are not proof.
  assert.equal(
    applicationOwner(
      snapshot(
        processInfo(2, "C:/Program Files/Raycast-other/node.exe", 1),
        processInfo(1, "C:/Program Files/Raycast/Raycast.exe"),
      ),
      2,
      "win32",
    ),
    undefined,
  );
  assert.equal(
    applicationOwner(
      snapshot(
        processInfo(1, "C:/Program Files/Raycast/node.exe", 2),
        processInfo(2, "C:/Program Files/Raycast/Raycast.exe"),
      ),
      1,
      "win32",
    ),
    undefined,
  );
  assert.equal(
    applicationOwner(
      snapshot(
        processInfo(
          2,
          "C:/Program Files/WindowsApps/PythonSoftwareFoundation.Python.3.10/python3.10.exe",
        ),
      ),
      2,
      "win32",
    ),
    undefined,
  );
  assert.equal(
    classifyListener({ name: "node.exe" }).discovery,
    "unidentified",
  );
  const bundledNode = "C:/Program Files/UnknownApp/backend/node.exe";
  assert.equal(
    classifyListener({
      name: "node.exe",
      context: context(
        bundledNode,
        "C:/Program Files/UnknownApp/backend/index.mjs",
      ),
      platform: "win32",
    }).discovery,
    "unidentified",
    "an unreadable application parent must not turn its bundled script into a development server",
  );
});

test("macOS bundles identify the enclosing app without claiming external Node servers", () => {
  assert.equal(
    applicationOwner(
      snapshot(
        processInfo(
          2,
          "/Applications/Raycast.app/Contents/Resources/backend/node",
        ),
      ),
      2,
      "darwin",
    )?.name,
    "Raycast",
  );
  assert.equal(
    applicationOwner(
      snapshot(
        processInfo(
          2,
          "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
        ),
      ),
      2,
      "darwin",
    )?.name,
    "Visual Studio Code",
  );
  assert.equal(
    applicationOwner(
      snapshot(
        processInfo(2, "/opt/homebrew/bin/node", 1),
        processInfo(
          1,
          "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
        ),
      ),
      2,
      "darwin",
    ),
    undefined,
  );
});

test("portable Electron and browser debug listeners cannot become projects from their working directory", () => {
  const application = applicationOwner(
    snapshot(
      processInfo(2, "D:/work/project/node_modules/electron/dist/electron.exe"),
    ),
    2,
    "win32",
  );
  assert.equal(application?.name, "Electron");
  assert.equal(
    classifyListener({
      name: "electron.exe",
      application,
      evidence: {
        directory: "D:/work/project",
        name: "Project",
        serviceDirectory: "D:/work/project",
        serviceName: "web",
        associationKey: "b".repeat(32),
      },
    }).discovery,
    "application",
  );
});

test("framework evidence improves service names without treating bare runtimes as projects", () => {
  for (const [args, framework] of [
    ["odoo-bin", "Odoo"],
    ["-m flask run", "Flask"],
    ["-m uvicorn main:app", "Uvicorn"],
    ["-m http.server 60000", "Python HTTP"],
  ]) {
    const result = classifyListener({
      name: "python3.10.exe",
      context: context("C:/Python/python3.10.exe", ...args.split(" ")),
    });
    assert.equal(result.framework, framework);
    assert.equal(result.discovery, "development");
  }
  assert.equal(
    classifyListener({
      name: "node.exe",
      context: context("C:/node.exe", "--version"),
    }).discovery,
    "unidentified",
  );
  assert.equal(
    classifyListener({
      name: "custom-server",
      evidence: {
        directory: "/work/app",
        name: "App",
        serviceName: "API",
        serviceDirectory: "/work/app/api",
        associationKey: "a".repeat(32),
      },
    }).discovery,
    "development",
  );
});

test("python.org and Command Line Tools macOS runtime bundles remain development servers", () => {
  for (const executable of [
    "/Library/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python",
    "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python",
  ]) {
    const application = applicationOwner(
      snapshot(processInfo(2, executable)),
      2,
      "darwin",
    );
    assert.equal(application, undefined);
    const result = classifyListener({
      name: "Python",
      context: context(executable, "-m", "http.server", "6000"),
      application,
      platform: "darwin",
    });
    assert.equal(result.discovery, "development");
    assert.equal(result.framework, "Python HTTP");
  }
});
