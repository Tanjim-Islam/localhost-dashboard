import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectShell } from "./desktop-shell-open.mjs";

async function findInterpreter() {
  const roots = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    process.env["ProgramFiles(x86)"],
  ].filter(Boolean);
  const candidates = roots.flatMap((root) =>
    ["AutoHotkey64.exe", "AutoHotkey32.exe", "AutoHotkey.exe"].map((name) =>
      path.join(root, "AutoHotkey", "v2", name),
    ),
  );
  for (const candidate of candidates) {
    if (
      await fs.stat(candidate).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return candidate;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function checkAhkScreen({
  root,
  page,
  api,
  until,
  pass,
  onCard,
  onStopped,
}) {
  const exe = process.env.DASHBOARD_QA_AHK_EXE || (await findInterpreter());
  if (!exe) {
    console.log("SKIP AutoHotkey UI lifecycle requires the v2 interpreter.");
    return;
  }
  const fixture = await fs.mkdtemp(path.join(root, "AHK Project "));
  const name = "Dashboard QA " + randomUUID() + ".ahk";
  const script = path.join(fixture, name);
  const record = path.join(fixture, "instances.txt");
  const stop = path.join(fixture, "exit-fixture");
  const source = [
    "#Requires AutoHotkey v2.0",
    "#SingleInstance Force",
    "#NoTrayIcon",
    'FileAppend(ProcessExist() "`n", A_ScriptDir "\\instances.txt", "UTF-8-RAW")',
    "SetTimer(CheckExit, 100)",
    "CheckExit() {",
    '  if FileExist(A_ScriptDir "\\exit-fixture") || A_TickCount - StartedAt > 180000',
    "    ExitApp",
    "}",
    "StartedAt := A_TickCount",
  ].join("\r\n");
  await fs.writeFile(script, source);
  const pids = async () =>
    (await fs.readFile(record, "utf8").catch(() => ""))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  const first = spawn(exe, ["/ErrorStdOut", script], {
    cwd: fixture,
    windowsHide: true,
    stdio: "ignore",
  });
  const card = page
    .locator(".app-card")
    .filter({ has: page.getByTitle(name, { exact: true }) });
  const recent = page.getByRole("dialog", {
    name: /Recently used AHK Scripts/i,
  });
  const row = recent
    .locator(".app-card")
    .filter({ has: page.getByText(name, { exact: true }) });
  const showRecent = () =>
    page.getByRole("button", { name: /^Recently Used/ }).click();
  const closeRecent = () =>
    recent.getByRole("button", { name: "Close recent scripts" }).click();
  try {
    await until(
      async () => (await pids())[0] === first.pid,
      "fixture AHK startup",
    );
    await api("refresh");
    await page.getByRole("button", { name: /^AHK Scripts/ }).click();
    await card.getByText("PID " + first.pid, { exact: true }).waitFor();
    const saved = (await api("getRecentScripts")).find(
      (s) => s.scriptName === name,
    );
    assert.equal(saved.type, "ahk");
    assert.equal(
      await fs.realpath(saved.scriptPath),
      await fs.realpath(script),
    );
    if (onCard) await onCard({ card, script, copiedPath: saved.scriptPath });
    await card.getByRole("button", { name: "Restart", exact: true }).click();
    const second = await until(async () => (await pids())[1], "AHK restart");
    assert.notEqual(second, first.pid);
    await until(() => !alive(first.pid), "original interpreter exited");
    await card.getByText("PID " + second, { exact: true }).waitFor();
    await card
      .filter({ hasText: "PID " + second })
      .getByRole("button", { name: "Kill", exact: true })
      .click();
    await until(() => !alive(second), "restarted interpreter stopped");
    if (onStopped) await onStopped(script);
    await showRecent();
    await row.getByRole("button", { name: "Start", exact: true }).click();
    const third = await until(
      async () => (await pids())[2],
      "Recently Used spawned the fixture",
    );
    assert.notEqual(third, second);
    await closeRecent();
    await card.getByText("PID " + third, { exact: true }).waitFor();
    await card
      .filter({ hasText: "PID " + third })
      .getByRole("button", { name: "Kill", exact: true })
      .click();
    await until(() => !alive(third), "recently started interpreter stopped");
    await showRecent();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.waitFor({ state: "detached" });
    assert(!(await api("getRecentScripts")).some((s) => s.id === saved.id));
    assert.equal(await fs.readFile(script, "utf8"), source);
    await closeRecent();
    pass(
      "Real AHK script discovery, restart, stop, recent start and delete with the script file preserved",
    );
  } finally {
    await fs.writeFile(stop, "stop");
    await until(
      async () => (await pids()).every((pid) => !alive(pid)),
      "AHK fixture cleanup",
      10000,
    );
  }
}

export async function checkInstalledAhk({
  dir,
  page,
  invoke,
  until,
  windows,
  pass,
  exercise,
}) {
  assert(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  assert(
    process.env.DASHBOARD_QA_AHK_EXE,
    "The hosted Windows check needs its verified AutoHotkey fixture.",
  );
  await invoke("updateSettings", {
    notifyOnStart: true,
    notifyOnStop: true,
    scanIntervalMs: 2200,
  });
  let toastEnabled;
  await checkAhkScreen({
    root: dir,
    page,
    api: invoke,
    until,
    pass,
    async onCard({ card, script, copiedPath }) {
      await exercise("AutoHotkey card clipboard", async () => {
        windows("clipboard-empty");
        try {
          await card.getByRole("button", { name: "Copy", exact: true }).click();
          windows("clipboard-matches", copiedPath);
        } finally {
          windows("clear-clipboard", copiedPath);
        }
        pass("AHK card copied the exact script path");
      });
      await exercise("AutoHotkey card edit", async () => {
        await card.getByRole("button", { name: "Edit", exact: true }).click();
        let receiver;
        try {
          receiver = await until(
            () => inspectShell(dir, "edited-file", script),
            "script in VS Code or the Explorer fallback",
          );
        } catch (error) {
          console.error(inspectShell(dir, "diagnostics", script));
          throw error;
        }
        pass(
          receiver === "editor"
            ? "AHK Edit opened the fixture in VS Code"
            : "AHK Edit revealed the fixture in Explorer",
        );
      });
      await exercise("AutoHotkey card Explorer", async () => {
        await card
          .getByRole("button", { name: "Explorer", exact: true })
          .click();
        await until(
          () => inspectShell(dir, "selected-file", script) === "selected",
          "Explorer selected the fixture script",
        );
        pass("AHK card Explorer selected the exact script path");
      });
      await exercise("Windows AHK start notification", async () => {
        const status = inspectShell(dir, "toast-setting", script);
        toastEnabled = status === "Enabled";
        if (toastEnabled) {
          await until(
            () => inspectShell(dir, "toast-started", script) === "delivered",
            "AHK Started toast in Windows notification history",
          );
        } else {
          assert(
            [
              "DisabledByGroupPolicy",
              "DisabledForUser",
              "NotSupported",
            ].includes(status),
            "Unexpected Windows notification setting: " + status,
          );
          console.log(
            "SKIP Windows toast delivery. The hosted OS reports " + status,
          );
        }
      });
    },
    async onStopped(script) {
      if (toastEnabled) {
        await exercise("Windows AHK stop notification", async () => {
          await until(
            () => inspectShell(dir, "toast-stopped", script) === "delivered",
            "AHK Stopped toast in Windows notification history",
          );
          pass(
            "Windows received the native AHK Stopped notification for the fixture",
          );
        });
      }
    },
  });
}
