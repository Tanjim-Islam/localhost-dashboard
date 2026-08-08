import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const testRoot = await mkdtemp(path.join(os.tmpdir(), "local-dashboard-clis-"));
const fixtureAppData = path.join(testRoot, "electron-app-data");
await mkdir(fixtureAppData, { recursive: true });
process.stdout.write(`CLIs test root: ${testRoot}\n`);
process.stdout.write(
  "Starting Localhost Dashboard in fixture-only CLIs test mode.\n",
);

const command = process.execPath;
const args = [
  path.join(
    process.cwd(),
    "node_modules",
    "electron-vite",
    "bin",
    "electron-vite.js",
  ),
  "dev",
];

const child = spawn(command, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    APPDATA: path.join(fixtureAppData, "Roaming"),
    LOCALAPPDATA: path.join(fixtureAppData, "Local"),
    LOCAL_DASHBOARD_CLIS_TEST_ROOT: testRoot,
  },
});

child.on("exit", (code, signal) => {
  process.stdout.write(
    `CLIs test-mode app exited with ${signal ?? `code ${code ?? 0}`}. Fixture remains at ${testRoot}.\n`,
  );
  process.exitCode = code ?? 0;
});
