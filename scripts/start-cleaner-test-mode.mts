import { spawn } from "node:child_process";
import path from "node:path";
import { createCleanerFixtureRoot } from "./cleaner-fixtures.mts";

const testRoot = await createCleanerFixtureRoot();
const fixtureAppData = path.join(testRoot, "electron-app-data");
process.stdout.write(`Cleaner test root: ${testRoot}\n`);
process.stdout.write(
  "Starting Localhost Dashboard in fixture-only Cleaner test mode.\n",
);

const command =
  process.platform === "win32"
    ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
    : "npm";
const args =
  process.platform === "win32"
    ? ["/d", "/s", "/c", "npm run dev"]
    : ["run", "dev"];

const child = spawn(command, args, {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    APPDATA: path.join(fixtureAppData, "Roaming"),
    LOCALAPPDATA: path.join(fixtureAppData, "Local"),
    LOCAL_DASHBOARD_CLEANER_TEST_ROOT: testRoot,
    LOCAL_DASHBOARD_CLEANER_TEST_DELAY_MS: "180",
  },
});

child.on("exit", (code, signal) => {
  process.stdout.write(
    `Cleaner test-mode app exited with ${signal ?? `code ${code ?? 0}`}. Fixture remains at ${testRoot}.\n`,
  );
  process.exitCode = code ?? 0;
});
