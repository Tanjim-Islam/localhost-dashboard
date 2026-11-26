// Drive the shipped React bundle in the native Windows WebView2 host.
// All persistent app data and CLI operations use a fresh fixture directory.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { checkServerScreen } from "./desktop-servers.mjs";
import {
  checkCliActions,
  checkCliFolders,
  removeSavedCliFolder,
} from "./desktop-clis.mjs";
import { checkMigration } from "./desktop-migration.mjs";
import { checkAhkScreen } from "./desktop-ahk.mjs";

if (process.platform !== "win32")
  throw new Error("This WebView2 integration suite requires Windows.");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-webview-"));
const exe =
  process.env.DASHBOARD_TEST_BINARY ||
  path.resolve("src-tauri/target/debug/local-dashboard.exe");
const key =
  "LOCAL_DASHBOARD_TEST_KEY_" + randomUUID().replaceAll("-", "").toUpperCase();
const renamed = key + "_RENAMED";
const value = "Rust fixture 💡";
const errors = [];
let app, browser, page;
let checkpoints = 0;
function pass(message) {
  checkpoints++;
  console.log("PASS", message);
}
async function until(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(120);
  }
  throw new Error("Timed out waiting for " + label);
}
async function launch(profile = root) {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const endpoint = "http://127.0.0.1:" + port;
  app = spawn(exe, [], {
    windowsHide: true,
    env: {
      ...process.env,
      LOCAL_DASHBOARD_CLIS_TEST_ROOT: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  app.stderr.on("data", (buf) => process.stderr.write(buf));
  await until(async () => {
    if (app.exitCode !== null)
      throw new Error("Dashboard exited " + app.exitCode);
    return fetch(endpoint + "/json/version").then(
      (r) => r.ok,
      () => false,
    );
  }, "WebView2 debug endpoint");
  browser = await chromium.connectOverCDP(endpoint);
  page = await until(
    () => browser.contexts().flatMap((c) => c.pages())[0],
    "native dashboard page",
  );
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  await page.emulateMedia({ colorScheme: "light" });
  await page
    .getByText(/^v\d+\.\d+\.\d+$/)
    .first()
    .waitFor();
}
const api = (name, arg) =>
  page.evaluate(([method, value]) => window.api[method](value), [name, arg]);
const button = (name) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
async function closeApp() {
  await api("updateSettings", { closeToTray: false });
  const stopped = once(app, "exit");
  void page.evaluate(() => window.windowControls.close()).catch(() => {});
  await Promise.race([
    stopped,
    delay(10000).then(() => {
      if (app.exitCode === null) throw Error("Window close did not exit.");
    }),
  ]);
  await browser.close();
}
function cleanEnv() {
  // The only persistent OS test values are the two generated fixture names.
  const ps =
    "$names=@('" +
    key +
    "','" +
    renamed +
    "');foreach($n in $names){[Environment]::SetEnvironmentVariable($n,$null,'User')}";
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { windowsHide: true },
  );
}
try {
  await launch();
  const meta = await api("getMeta");
  assert.equal(meta.platform, "win32");
  assert.equal(meta.clisTestMode, true);
  assert.equal(meta.features.automatorScripts, false);
  assert.equal(await api("getCliInventory"), null);
  for (const tab of [/^Servers/, /^CLIs/, /^AHK Scripts/, /^ENV Keys/])
    assert(await button(tab).isVisible());
  pass("Native IPC, platform tabs and cached-only startup");

  await button("Settings").click();
  await button("Close settings").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await delay(450);
  await page.screenshot({ path: path.join(root, "settings.png") });
  const styles = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.title-bar button, [aria-label="Close settings"], .title-bar input',
      ),
    ].map((el) => {
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect();
      return {
        name: el.getAttribute("aria-label") || el.textContent.trim(),
        color: s.color,
        bg: s.backgroundColor,
        border: s.borderRadius,
        font: s.fontFamily,
        height: r.height,
        width: r.width,
      };
    }),
  );
  await fs.writeFile(
    path.join(root, "styles.json"),
    JSON.stringify(styles, null, 2),
  );
  {
    const original = JSON.parse(
      await fs.readFile(
        new URL(
          "../tests/fixtures/electron-windows-controls.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      styles.map(({ width, ...rest }) => rest),
      original.map(({ width, ...rest }) => rest),
    );
    if (await page.evaluate(() => window.innerWidth === 1100)) {
      for (let i = 0; i < styles.length; i++)
        assert(
          Math.abs(styles[i].width - original[i].width) < 2,
          styles[i].name + " width changed",
        );
    }
    pass(
      "Original Electron control colors, fills, radii, font families and geometry",
    );
  }
  await button("Dark").click();
  await button("Close settings").click();
  await page.keyboard.press("Control+,");
  await button("Close settings").click();
  await api("updateSettings", {
    notifyOnStart: false,
    notifyOnStop: false,
    scanIntervalMs: 2200,
  });
  assert.equal((await api("getSettings")).scanIntervalMs, 2200);
  await assert.rejects(api("updateSettings", { globalHotkey: "invalid" }));
  await api("checkForUpdates");
  assert.equal((await api("getUpdateStatus")).state, "not-available");
  await api("dismissUpdate");
  assert.equal((await api("getUpdateStatus")).state, "idle");
  pass(
    "Settings, persisted appearance, shortcut, input validation and update states",
  );

  await button(/^ENV Keys/).click();
  await button("Add key").click();
  await page.getByPlaceholder("GITHUB_TOKEN").fill(key);
  await page.getByPlaceholder("Enter secret value").fill(value);
  await button("Create key").click();
  await page
    .getByRole("dialog", { name: "Add ENV key" })
    .waitFor({ state: "hidden" });
  await button("Edit " + key).waitFor();
  const search = page.getByRole("textbox", { name: "Search dashboard" });
  await search.fill(key);
  await button("Reveal value").click();
  await page.getByText(value, { exact: true }).waitFor();
  await button("Hide value").click();
  await page.getByText(value, { exact: true }).waitFor({ state: "hidden" });
  await button("Edit " + key).click();
  await page.getByPlaceholder("GITHUB_TOKEN").fill(renamed);
  await button("Save changes").click();
  await page
    .getByRole("dialog", { name: "Edit ENV key" })
    .waitFor({ state: "hidden" });
  await button("Delete " + renamed).click();
  await button("Cancel").click();
  assert.equal(
    await api("getEnvironmentKeyValue", { scope: "user", name: renamed }),
    value,
  );
  await button("Delete " + renamed).click();
  await button("Delete permanently").click();
  await button("Delete " + renamed).waitFor({ state: "hidden" });
  assert(
    !(await api("getEnvironmentKeys")).some(
      (row) => row.name === key || row.name === renamed,
    ),
  );
  await search.fill("");
  pass(
    "ENV key native registry create, reveal, hide, rename, confirmation, cancellation and delete",
  );

  await button(/^CLIs/).click();
  assert.equal(await button("Refresh").count(), 0);
  await button("Scan Now").click();
  await until(
    async () =>
      ["complete", "partial"].includes((await api("getCliScanState")).status),
    "completed CLI scan",
  );
  const inventory = await api("getCliInventory");
  assert(inventory.products.length >= 5);
  assert(inventory.installations.some((i) => i.health === "broken"));
  const scanning = await api("startCliScan");
  await api("cancelCliScan", scanning.id);
  await until(
    async () => (await api("getCliScanState")).status === "cancelled",
    "cancelled CLI scan",
  );
  assert.equal((await api("getCliInventory")).revision, inventory.revision);
  await assert.rejects(
    api("uninstallCliInstallation", {
      installationId: "invalid",
      inventoryRevision: inventory.revision,
      confirmation: "uninstall-exact-cli-installation",
      previewToken: "invalid",
    }),
  );
  pass(
    "CLI scan, progress, partial source, cancellation, cache integrity and uninstall rejection",
  );
  const cliRevision = await checkCliActions({
    root,
    page,
    api,
    pass,
    inventory,
  });
  const cliFolders = await checkCliFolders({
    root,
    page,
    api,
    pid: app.pid,
    pass,
  });
  const bounded = await api("getProjects");
  for (const key of ["projects", "activity", "recentlyStopped", "legacyNotes"])
    assert(Array.isArray(bounded[key]));
  assert(Array.isArray(await api("getServers")));
  assert((await api("getStats")).portCounts);
  await assert.rejects(api("openUrl", "https://example.org/"));
  await assert.rejects(api("stopServers", { refs: [] }));
  await assert.rejects(api("restartServer", { key: "0:0", firstSeen: 1 }));
  pass("Server, project and port-stat contracts and invalid action rejection");

  await checkAhkScreen({ root, page, api, until, pass });
  const project = await checkServerScreen({ root, page, api, until });
  pass(
    "Project editor, activity, ignored protection, hidden selection, Stop Selected and Start in the drawer",
  );
  await button(/^CLIs/).click();
  await closeApp();
  await launch();
  assert.equal((await api("getCliInventory")).revision, cliRevision);
  await removeSavedCliFolder({ root, page, api, selected: cliFolders, pass });
  assert.equal((await api("getSettings")).scanIntervalMs, 2200);
  assert(
    (await api("getProjects")).projects.some(
      (p) => p.id === project.id && p.notes === "WebView2 integration note",
    ),
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("dashboard:themeMode")),
    "dark",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("dashboard:activeTab")),
    "clis",
  );
  assert.equal((await api("resetSettings")).scanIntervalMs, 5000);
  pass(
    "Window close, restart and persistent settings, theme, inventory and active tab",
  );
  await closeApp();
  await checkMigration({
    root,
    launch,
    api,
    closeApp,
    baseline: process.env.DASHBOARD_ELECTRON_BASELINE,
  });
  pass(
    "First launch imports legacy project notes, settings, statistics, recent scripts and cached CLI inventory exactly once",
  );
  assert.deepEqual(errors, []);
  console.log(
    checkpoints + " Windows WebView2 checkpoints passed. Evidence:",
    root,
  );
} catch (e) {
  console.error("Fixture directory:", root);
  throw e;
} finally {
  cleanEnv();
  if (app && app.exitCode === null) app.kill();
  await browser?.close().catch(() => {});
}
