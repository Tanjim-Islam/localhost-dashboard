import { app } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliController } from "./controller";
import { RealCliCommandRunner } from "./command-runner";
import { ElectronCliPersistence } from "./electron-store";
import { FixtureCliCommandRunner, FixtureCliProvider } from "./fixture";
import { CliScanner } from "./scanner";
import type { CliClock, CliPlatform, CliScanEnvironment } from "./types";

const systemClock: CliClock = { now: () => Date.now() };

export async function createCliController(): Promise<{
  controller: CliController;
  testMode: boolean;
}> {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("CLIs are available only on Windows and macOS.");
  }
  const platform = process.platform as CliPlatform;
  const fixtureRoot = process.env.LOCAL_DASHBOARD_CLIS_TEST_ROOT;
  const testMode = Boolean(fixtureRoot);
  const neutralWorkingDirectory = path.join(
    fixtureRoot ?? app.getPath("temp"),
    "local-dashboard-clis-neutral",
  );
  await mkdir(neutralWorkingDirectory, { recursive: true });
  await writeFile(
    path.join(neutralWorkingDirectory, "package.json"),
    '{"private":true}\n',
    "utf8",
  );
  const environment = async (): Promise<CliScanEnvironment> => ({
    platform,
    architecture: process.arch,
    env: { ...process.env },
    homeDirectory: fixtureRoot ?? os.homedir(),
    pathValue: fixtureRoot
      ? [
          path.join(fixtureRoot, "path-a"),
          path.join(fixtureRoot, "path-b"),
        ].join(platform === "win32" ? ";" : ":")
      : process.env.PATH ?? "",
    pathExtValue:
      process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1",
    knownDirectories: [],
    neutralWorkingDirectory,
    testMode,
  });
  const runner = fixtureRoot
    ? new FixtureCliCommandRunner()
    : new RealCliCommandRunner(neutralWorkingDirectory);
  const scanner = new CliScanner({
    createEnvironment: environment,
    runner,
    clock: systemClock,
    ...(fixtureRoot
      ? {
          fixtureProvider: new FixtureCliProvider(
            fixtureRoot,
            platform,
            process.arch,
            () => Date.now(),
          ),
        }
      : {}),
  });
  return {
    controller: new CliController({
      scanner,
      persistence: new ElectronCliPersistence(),
      clock: systemClock,
      runner,
    }),
    testMode,
  };
}

export * from "./types";
export { CliController } from "./controller";
