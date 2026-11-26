import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

export async function checkShellOpen({ dir, observer, invoke, until }) {
  assert(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  const fixture = path.join(dir, "Editor Project #1");
  const sample = path.join(fixture, "Selected file.txt");
  const script = path.join(fixture, "server.cjs");
  const browserReceipt = path.join(fixture, "received-browser.txt");
  await fs.mkdir(fixture);
  await fs.writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "dashboard-shell-fixture", private: true }),
  );
  await fs.writeFile(sample, "Disposable fixture.");
  await fs.writeFile(
    script,
    [
      'const fs=require("node:fs"); const http=require("node:http");',
      "const app=http.createServer((request,response)=>{",
      '  if(request.method==="GET" && /Mozilla\\/5\\.0/.test(request.headers["user-agent"] || ""))',
      '    fs.writeFileSync("received-browser.txt","browser");',
      '  response.end("Dashboard shell integration");',
      "});",
      'app.listen(0,"127.0.0.1",()=>console.log(app.address().port));',
    ].join("\n"),
  );
  const powershell = path.join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const shell = (action, target) =>
    execFileSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.resolve("scripts/desktop-shell-open.ps1"),
        "-Action",
        action,
        "-FixtureDirectory",
        dir,
        "-File",
        target,
      ],
      { windowsHide: true, encoding: "utf8" },
    ).trim();
  const server = spawn(process.execPath, [script], {
    cwd: fixture,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const [data] = await once(server.stdout, "data");
    const port = Number(data.toString().trim());
    await invoke("refresh");
    const service = await until(
      async () =>
        (await invoke("getServers")).find(
          (s) => s.pid === server.pid && s.port === port && s.projectId,
        ),
      "fixture project",
    );
    await invoke("openExplorer", sample);
    await until(
      () => shell("selected-file", sample) === "selected",
      "Explorer selection of the requested fixture file",
    );
    console.log("PASS", "Explorer selected the requested file");
    await invoke("openUrl", service.url);
    await until(
      () =>
        fs.readFile(browserReceipt, "utf8").then(
          (t) => t === "browser",
          () => false,
        ),
      "system browser GET to observed loopback service",
    );
    console.log("PASS", "System browser opened a discovered local service");
    try {
      shell("install-handler", observer);
      await invoke("openInVSCode", { path: fixture });
      const value = await until(
        () =>
          fs
            .readFile(path.join(dir, "received-uri.txt"), "utf8")
            .catch(() => false),
        "registered vscode protocol handler",
      );
      const url = new URL(value);
      assert.equal(url.protocol, "vscode:");
      assert.equal(url.host, "file");
      assert.equal(
        decodeURIComponent(url.pathname.slice(1)).toLowerCase(),
        fixture.replaceAll("\\", "/").toLowerCase(),
      );
      console.log(
        "PASS",
        "Native VS Code action dispatched the exact project through the Windows protocol handler",
      );
    } finally {
      shell("remove-handler", observer);
    }
  } finally {
    if (server.exitCode === null) server.kill();
  }
}
