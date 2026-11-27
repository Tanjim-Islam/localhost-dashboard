import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { checkShellOpen } from "./desktop-shell-open.mjs";
import { checkInstalledAhk } from "./desktop-ahk.mjs";

assert.equal(
  process.platform,
  "win32",
  "Windows shell checks require Windows.",
);
const hosted = process.argv.includes("--installed");
if (hosted)
  assert(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "Installed tests require a disposable hosted runner.",
  );
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-shell-"));
const exe = hosted
  ? path.join(
      process.env.LOCALAPPDATA,
      "Localhost Dashboard",
      "local-dashboard.exe",
    )
  : process.env.DASHBOARD_TEST_BINARY ||
    path.resolve("src-tauri/target/debug/local-dashboard.exe");
const system = process.env.SystemRoot;
const observer = path.join(dir, "window-observer.exe");
const ps = (code, args = []) =>
  execFileSync(
    path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", code, ...args],
    { encoding: "utf8", windowsHide: true },
  ).trim();
const windows = (...args) =>
  execFileSync(observer, [String(app.pid), ...args.map(String)], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const state = () => {
  const [visible, minimized, maximized, x, y] = windows("state")
    .split(" ")
    .map(Number);
  return { visible, minimized, maximized, x, y };
};
const until = async (check, label, timeout = 25000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(125);
  }
  throw Error("Timed out waiting for " + label);
};
let browser, page, app;
const invoke = (name, value) =>
  page.evaluate(([method, arg]) => window.api[method](arg), [name, value]);
const button = (name) => page.getByRole("button", { name, exact: true });
const pass = (message) => console.log("PASS", message);
const failures = [];
async function exercise(name, action) {
  try {
    await action();
  } catch (error) {
    failures.push(new Error(name, { cause: error }));
    console.error("FAIL", name, error);
  }
}

async function start(args) {
  const sock = net.createServer().listen(0, "127.0.0.1");
  await once(sock, "listening");
  const port = sock.address().port;
  await new Promise((resolve) => sock.close(resolve));
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
  };
  if (hosted) delete env.LOCAL_DASHBOARD_CLIS_TEST_ROOT;
  else env.LOCAL_DASHBOARD_CLIS_TEST_ROOT = dir;
  app = spawn(exe, args, {
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  app.stderr.on("data", (data) => process.stderr.write(data));
  const endpoint = "http://127.0.0.1:" + port;
  await until(async () => {
    assert.equal(app.exitCode, null, "Native shell exited");
    return fetch(endpoint + "/json/version").then(
      (r) => r.ok,
      () => false,
    );
  }, "WebView2 connection");
  browser = await chromium.connectOverCDP(endpoint);
  page = await until(
    () => browser.contexts().flatMap((c) => c.pages())[0],
    "dashboard page",
  );
  await page
    .getByText(/^v\d+\.\d+\.\d+$/)
    .first()
    .waitFor({ state: "attached" });
  assert.equal((await invoke("getMeta")).clisTestMode, !hosted);
}

async function close() {
  await invoke("updateSettings", { closeToTray: false });
  const exit = once(app, "exit");
  void page.evaluate(() => window.windowControls.close()).catch(() => {});
  await Promise.race([
    exit,
    sleep(6000).then(() => {
      if (app.exitCode === null) throw Error("Window failed to exit");
    }),
  ]);
  await browser.close();
}

function loginCommand() {
  return ps(
    '$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"); if ($key) { $key.GetValue("Localhost Dashboard",""); $key.Dispose() }',
  );
}

async function checkSingleInstance() {
  await invoke("updateSettings", { closeToTray: true });
  await button("Close").click();
  await until(
    () => !state().visible,
    "first installed instance hidden in tray",
  );
  const second = spawn(exe, [], { windowsHide: true, stdio: "ignore" });
  try {
    await until(
      () => second.exitCode !== null,
      "second installed launch exited",
      15000,
    );
    assert.equal(second.exitCode, 0);
    assert.equal(app.exitCode, null);
    await until(
      () => state().visible,
      "the first installed window was restored",
    );
    assert.equal(windows("same-image-dashboard-count"), "1");
    pass(
      "Second installed launch restored the original window and exited with a single dashboard",
    );
  } finally {
    if (second.exitCode === null) second.kill();
  }
}

async function osActions() {
  assert.equal(loginCommand(), "", "Hosted profile already has a login item.");
  const marker = "dashboard-clipboard-" + randomUUID();
  windows("clipboard-empty");
  try {
    await invoke("copyText", marker);
    windows("clipboard-matches", marker);
    pass("Native clipboard write and Windows read");
  } finally {
    windows("clear-clipboard", marker);
  }
  if (desktop.startsWith("no-cursor")) {
    console.log(
      "SKIP Physical mouse and shortcut delivery. GetCursorPos reports no input desktop.",
    );
    return;
  }
  const spot = await page
    .locator(".title-bar")
    .getByText("Localhost Dashboard", { exact: true })
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [
        Math.round((r.x + r.width / 2) * devicePixelRatio),
        Math.round((r.y + r.height / 2) * devicePixelRatio),
      ];
    });
  const before = state();
  windows("drag", ...spot);
  await until(
    () => Math.abs(state().x - before.x) > 15,
    "dragged native window",
  );
  windows("double", ...spot);
  await until(() => state().maximized, "physical title-bar double-click");
  await button("Maximize").click();
  await until(() => !state().maximized, "restored physical double-click");
  pass("Native title-bar drag and physical double-click");
  await invoke("updateSettings", {
    globalHotkey: "Control+Alt+Shift+F23",
    closeToTray: true,
  });
  await button("Settings").click();
  const settings = page.getByRole("dialog", {name: "Settings"});
  await settings.getByRole("button", {name: "Edit", exact: true}).click();
  await settings.getByText("Recording...", {exact: true}).waitFor();
  windows("hotkey", 0x86);
  await settings.getByText("F23", {exact: true}).waitFor();
  assert.equal(state().visible, 1);
  assert(await settings.locator("footer").getByRole("button", {name: "Save"}).isDisabled());
  await settings.getByRole("button", {name: "Cancel", exact: true}).click();
  await button("Close settings").click();
  await settings.waitFor({state: "hidden"});
  windows("hotkey", 0x86);
  await until(() => !state().visible, "shortcut hides the dashboard after cancelling a recording");
  windows("hotkey", 0x86);
  await until(() => state().visible, "shortcut restores the dashboard after recording");
  pass("Recording the active global shortcut keeps Settings open and Cancel restores normal toggling");
  await button("Close").click();
  await until(() => !state().visible, "close-to-tray");
  windows("hotkey", 0x86);
  await until(
    () => state().visible,
    "configured global shortcut restores hidden window",
  );
  await invoke("updateSettings", { globalHotkey: "Control+Alt+Shift+F24" });
  await button("Close").click();
  await until(() => !state().visible, "second close-to-tray");
  windows("hotkey", 0x86);
  await sleep(300);
  assert.equal(state().visible, 0, "Old global shortcut remained bound");
  windows("hotkey", 0x87);
  await until(() => state().visible, "reconfigured shortcut");
  pass(
    "Close to tray, global shortcut registration, reconfiguration and restore",
  );
}

execFileSync(
  path.join(system, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
  [
    "/nologo",
    "/target:exe",
    "/reference:System.Windows.Forms.dll",
    "/out:" + observer,
    path.resolve("scripts/desktop-shell-windows.cs"),
  ],
  { windowsHide: true, stdio: "pipe" },
);
const desktop = execFileSync(observer, ["desktop"], {
  windowsHide: true,
  encoding: "utf8",
}).trim();
console.log("Windows desktop:", desktop);
try {
  await start([]);
  assert.equal(state().visible, 1);
  await button("Maximize").click();
  await until(() => state().maximized, "native maximize");
  await button("Maximize").click();
  await until(() => !state().maximized, "native restore");
  await page
    .locator(".title-bar")
    .dispatchEvent("dblclick", { button: 0, detail: 2 });
  await until(() => state().maximized, "React title-bar double-click handler");
  await button("Maximize").click();
  await button("Minimize").click();
  await until(() => state().minimized, "native minimize");
  windows("restore");
  await until(
    () => !state().minimized && state().visible,
    "native window restoration",
  );
  pass("Title-bar buttons and double-click update native window state");
  if (hosted) {
    await exercise(
      "Installed single-instance restoration",
      checkSingleInstance,
    );
    windows("restore");
    await exercise("Installed clipboard and desktop input", osActions);
    windows("restore");
    await exercise("Installed AutoHotkey controls and notifications", () =>
      checkInstalledAhk({ dir, page, invoke, until, windows, pass, exercise }),
    );
    await exercise("Installed Explorer, URL and editor actions", () =>
      checkShellOpen({ dir, observer, invoke, until, exercise }),
    );
  } else {
    await invoke("updateSettings", { closeToTray: true });
    await button("Close").click();
    await until(() => !state().visible, "close-to-tray hides fixture");
    assert.equal(app.exitCode, null);
    pass("Close-to-tray hid the native window and kept its process alive");
    await exercise("Native notification-area restoration", async () => {
      let lastStatus;
      const delivered = await until(() => {
        const result = windows("tray-callback");
        if (result !== lastStatus && result !== "sent") console.log("Windows tray:", result);
        lastStatus = result;
        return result === "sent" || result.startsWith("unavailable:")
          ? result
          : false;
      }, "Windows notification-area rectangle for the registered fixture tray icon");
      if (delivered !== "sent") {
        assert.equal(
          process.env.RUNNER_ENVIRONMENT,
          "github-hosted",
          delivered,
        );
        console.log("SKIP Notification-area callback.", delivered);
        return;
      }
      await until(
        () => state().visible,
        "native tray callback restored the hidden window",
      );
      pass("Native tray click callback restored the hidden dashboard");
    });
    windows("restore");
  }
  await invoke("updateSettings", {
    startAtLogin: true,
    openInTrayAtLogin: true,
  });
  if (hosted) {
    const command = loginCommand();
    assert.equal(
      command.toLowerCase(),
      `"${exe.toLowerCase()}" --hidden`,
      "Login item does not launch the installed app with --hidden",
    );
    pass("Installed app registered its executable and hidden login argument");
  }
  await close();
  await start(["--hidden"]);
  assert.equal(state().visible, 0, "Login startup should be hidden");
  windows("restore");
  await invoke("updateSettings", { openInTrayAtLogin: false });
  await close();
  await start(["--hidden"]);
  assert.equal(
    state().visible,
    1,
    "Disabled login hiding should leave the window visible",
  );
  await invoke("updateSettings", { startAtLogin: false });
  if (hosted)
    assert.equal(
      loginCommand(),
      "",
      "Disabling Start at Login left a registration",
    );
  pass(
    "Hidden login startup and visible startup preference on actual native launches",
  );
  await close();
  if (failures.length)
    throw new AggregateError(failures, "Windows shell checks failed");
} finally {
  if (hosted && page && app?.exitCode === null) {
    try {
      await invoke("updateSettings", { startAtLogin: false });
    } catch {}
  }
  if (app?.exitCode === null) app.kill();
  await browser?.close().catch(() => {});
}
