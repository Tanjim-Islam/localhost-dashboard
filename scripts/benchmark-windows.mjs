import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright-core";

const [previous, current] = process.argv.slice(2);
if (process.platform !== "win32" || !previous || !current)
  throw Error(
    "Supply the paths of the previous and current Windows dashboard executables.",
  );
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-benchmark-"));
async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function sample(pid) {
  const command = `
    $all = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,PrivatePageCount,WorkingSetSize
    $ids = [Collections.Generic.HashSet[uint32]]::new()
    [void]$ids.Add([uint32]${pid})
    do { $before=$ids.Count; foreach($p in $all){if($ids.Contains($p.ParentProcessId)){[void]$ids.Add($p.ProcessId)}} } while($ids.Count -ne $before)
    $rows=@($all | Where-Object {$ids.Contains($_.ProcessId)})
    [pscustomobject]@{processes=$rows.Count;privateBytes=($rows|Measure-Object PrivatePageCount -Sum).Sum;workingSetBytes=($rows|Measure-Object WorkingSetSize -Sum).Sum}|ConvertTo-Json -Compress
  `;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", windowsHide: true },
    ),
  );
}
async function measure(backend, exe, run) {
  const port = await availablePort();
  const endpoint = "http://127.0.0.1:" + port;
  const fixture = path.join(root, backend + "-" + run);
  const legacy = path.join(fixture, "electron-app-data", "Electron");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(
    path.join(legacy, "settings.json"),
    JSON.stringify({
      notifyOnStart: false,
      notifyOnStop: false,
      startAtLogin: false,
      closeToTray: false,
    }),
  );
  const flag = "--remote-debugging-port=" + port;
  const start = performance.now();
  const child = spawn(exe, backend === "Electron" ? [flag] : [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LOCAL_DASHBOARD_CLIS_TEST_ROOT: fixture,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: flag,
    },
  });
  let browser;
  try {
    while (
      !(await fetch(endpoint + "/json/version").then(
        (r) => r.ok,
        () => false,
      ))
    ) {
      if (child.exitCode !== null || performance.now() - start > 45000)
        throw Error(backend + " did not start");
      await wait(50);
    }
    browser = await chromium.connectOverCDP(endpoint);
    let page;
    while (!(page = browser.contexts().flatMap((c) => c.pages())[0])) {
      if (performance.now() - start > 45000) throw Error("Window did not open");
      await wait(50);
    }
    await page
      .getByText(/^v\d+\.\d+\.\d+$/)
      .first()
      .waitFor();
    const uiReadyMs = Math.round(performance.now() - start);
    await page.waitForFunction(
      async () => (await window.api.getServers()).length > 0,
      undefined,
      { timeout: 45000 },
    );
    const listenersReadyMs = Math.round(performance.now() - start);
    await wait(15000);
    const memory = sample(child.pid);
    const listeners = (await page.evaluate(() => window.api.getServers()))
      .length;
    await page.evaluate(() => window.windowControls.close()).catch(() => {});
    return { backend, run, uiReadyMs, listenersReadyMs, listeners, ...memory };
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}
const rows = [];
for (let round = 1; round <= 3; round++) {
  const order =
    round % 2
      ? [
          ["Electron", previous],
          ["Tauri", current],
        ]
      : [
          ["Tauri", current],
          ["Electron", previous],
        ];
  for (const [backend, exe] of order) {
    const row = await measure(backend, exe, round);
    rows.push(row);
    console.log(JSON.stringify(row));
    await wait(1200);
  }
}
await fs.writeFile(
  path.join(root, "results.json"),
  JSON.stringify(rows, null, 2),
);
console.log("Results:", root);
