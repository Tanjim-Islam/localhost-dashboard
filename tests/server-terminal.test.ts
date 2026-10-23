import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalDirectory } from "../src/shared/servers";
import {
  openProjectTerminal,
  terminalLaunch,
} from "../src/main/project-terminal";

test("Windows terminal directories remain data, including shell metacharacters", () => {
  const directory = "D:\\Work\\A & B (%PATH%) 'project'";
  const plan = terminalLaunch(directory, "win32", {
    SystemRoot: "C:\\Windows",
  });
  assert.equal(
    plan.executable,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.equal(plan.env.LOCAL_DASHBOARD_TERMINAL_DIRECTORY, directory);
  const script = Buffer.from(plan.args.at(-1)!, "base64").toString("utf16le");
  assert.ok(!script.includes(directory));
  assert.match(script, /-WorkingDirectory \$directory -WindowStyle Normal/);
  assert.match(script, /Remove-Item Env:LOCAL_DASHBOARD_TERMINAL_DIRECTORY/);
});
test("macOS terminal uses an absolute launcher and literal folder argument", () => {
  const directory = "/Users/test/Work/a $() & 'b'";
  const plan = terminalLaunch(directory, "darwin", {});
  assert.equal(plan.executable, "/usr/bin/open");
  assert.deepEqual(plan.args, ["-a", "Terminal", "--", directory]);
});
test("terminal boundary rejects relative, remote, malformed and missing folders", async () => {
  for (const value of [
    null,
    {},
    "",
    "project",
    "C:relative",
    "\\\\remote\\share",
    "//remote/share",
    "D:/bad\npath",
    "D:/bad\0path",
  ])
    assert.throws(() => terminalDirectory(value));
  await assert.rejects(
    openProjectTerminal("D:/__dashboard_nonexistent_terminal_fixture__"),
    /not found/,
  );
});
