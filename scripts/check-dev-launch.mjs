// Exercise the development entry point end to end using an isolated profile.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

assert.equal(process.platform, "win32");
const listener = net.createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const endpoint = "http://127.0.0.1:" + listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const child = spawn(process.execPath, ["scripts/start-fixture.mjs"], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--remote-debugging-port=" + new URL(endpoint).port,
  },
  stdio: "inherit",
  windowsHide: true,
});
let browser;
try {
  const deadline = Date.now() + 300000;
  while (
    !(await fetch(endpoint + "/json/version").then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    assert.equal(child.exitCode, null, "Development launcher exited too early");
    assert(Date.now() < deadline, "No development webview appeared");
    await sleep(200);
  }
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((c) => c.pages())[0];
  await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  assert.equal(new URL(page.url()).origin, "http://localhost:1420");
  const { meta, hot } = await page.evaluate(async () => ({
    meta: await window.api.getMeta(),
    hot: typeof (await import("/@vite/client")).createHotContext,
  }));
  assert.equal(meta.clisTestMode, true);
  assert.equal(hot, "function");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Close settings" }).waitFor();
  await page.evaluate(() => window.api.updateSettings({ closeToTray: false }));
  const exit = once(child, "exit");
  void page.evaluate(() => window.windowControls.close()).catch(() => {});
  const code = await Promise.race([exit, sleep(15000, null, { ref: false })]);
  assert.equal(
    code?.[0],
    0,
    "Closing the dashboard should stop its development launcher",
  );
  console.log(
    "PASS Development launcher, Vite hot client, native IPC, Settings and exit",
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {}
  }
}
