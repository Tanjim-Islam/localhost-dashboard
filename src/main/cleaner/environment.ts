import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { CleanerEnvironment } from "./types";
import {
  CLEANER_TEST_SENTINEL,
  CLEANER_TEST_MANIFEST,
} from "./adapters/filesystem";
import {
  canonicalizeWindowsAbsolutePath,
  canonicalizeWindowsDriveRoot,
  normalizeWindowsPath,
} from "./path-normalization";
import { assertValidCleanerProtectedRoots } from "./path-safety";
import { CLEANER_APPLICATION_DEFINITION_VERSION } from "./applications/definitions";

export async function createCleanerEnvironment(
  environmentVariables: NodeJS.ProcessEnv = process.env,
): Promise<CleanerEnvironment> {
  const testRoot = environmentVariables["LOCAL_DASHBOARD_CLEANER_TEST_ROOT"];
  if (testRoot) return createTestCleanerEnvironment(testRoot);

  const home = canonicalizeWindowsAbsolutePath(os.homedir());
  const localAppData = canonicalizeWindowsAbsolutePath(
    requireEnvironmentValue(environmentVariables, "LOCALAPPDATA"),
  );
  const roamingAppData = canonicalizeWindowsAbsolutePath(
    requireEnvironmentValue(environmentVariables, "APPDATA"),
  );
  const programData = canonicalizeWindowsAbsolutePath(
    requireEnvironmentValue(environmentVariables, "PROGRAMDATA"),
  );
  const windowsDir =
    environmentVariables["WINDIR"] || environmentVariables["SystemRoot"];
  if (!windowsDir) throw new Error("Windows directory is unavailable.");
  const canonicalWindowsDir = canonicalizeWindowsAbsolutePath(windowsDir);
  const systemDrive = canonicalizeWindowsDriveRoot(
    environmentVariables["SystemDrive"] ||
      path.win32.parse(canonicalWindowsDir).root,
  );
  const tempDir = canonicalizeWindowsAbsolutePath(
    environmentVariables["TEMP"] || path.join(localAppData, "Temp"),
  );

  const environment: CleanerEnvironment = {
    systemDrive,
    home,
    localAppData,
    roamingAppData,
    programData,
    windowsDir: canonicalWindowsDir,
    tempDir,
    projectRoots: [
      path.join(home, "source", "repos"),
      path.join(home, "Projects"),
      path.join(home, "Developer"),
      path.join(home, "dev"),
      path.join(home, "code"),
      path.join(home, "Documents", "GitHub"),
    ],
    goCache: await resolveGoCache(
      environmentVariables,
      roamingAppData,
      localAppData,
      systemDrive,
    ),
    definitionVersion: CLEANER_APPLICATION_DEFINITION_VERSION,
  };
  validateCleanerEnvironment(environment);
  return environment;
}

export async function createTestCleanerEnvironment(
  testRoot: string,
): Promise<CleanerEnvironment> {
  const sentinel = path.join(testRoot, CLEANER_TEST_SENTINEL);
  const manifest = path.join(testRoot, CLEANER_TEST_MANIFEST);
  await fs.access(sentinel);
  await fs.access(manifest);
  const environment: CleanerEnvironment = {
    // In test mode the injected root represents the system-drive namespace.
    // Path safety still verifies that its real drive matches the host system drive.
    systemDrive: testRoot,
    home: path.join(testRoot, "User"),
    localAppData: path.join(testRoot, "User", "AppData", "Local"),
    roamingAppData: path.join(testRoot, "User", "AppData", "Roaming"),
    programData: path.join(testRoot, "ProgramData"),
    windowsDir: path.join(testRoot, "Windows"),
    tempDir: path.join(testRoot, "User", "AppData", "Local", "Temp"),
    projectRoots: [path.join(testRoot, "Projects")],
    goCache: path.join(testRoot, "User", "AppData", "Local", "go-build"),
    definitionVersion: CLEANER_APPLICATION_DEFINITION_VERSION,
    testRoot,
  };
  validateCleanerEnvironment(environment);
  return environment;
}

function requireEnvironmentValue(
  environmentVariables: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environmentVariables[name];
  if (!value) throw new Error(`${name} is unavailable.`);
  return value;
}

export function validateCleanerEnvironment(
  environment: CleanerEnvironment,
): void {
  const namedPaths: Array<[string, string]> = [
    ["systemDrive", environment.systemDrive],
    ["home", environment.home],
    ["localAppData", environment.localAppData],
    ["roamingAppData", environment.roamingAppData],
    ["programData", environment.programData],
    ["windowsDir", environment.windowsDir],
    ["tempDir", environment.tempDir],
    ...environment.projectRoots.map(
      (root, index) => [`projectRoots[${index}]`, root] as [string, string],
    ),
  ];
  if (environment.goCache) namedPaths.push(["goCache", environment.goCache]);
  for (const [name, targetPath] of namedPaths) {
    try {
      normalizeWindowsPath(targetPath);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "The path is invalid.";
      throw new Error(`Cleaner environment ${name} is invalid. ${detail}`);
    }
  }
  const systemRoot = path.win32.parse(environment.systemDrive).root;
  if (
    !environment.testRoot &&
    environment.systemDrive !==
      canonicalizeWindowsDriveRoot(environment.systemDrive)
  ) {
    throw new Error(
      "Cleaner environment systemDrive must be a canonical drive root.",
    );
  }
  for (const [name, targetPath] of namedPaths.slice(1)) {
    if (
      path.win32.parse(targetPath).root.toLowerCase() !==
      systemRoot.toLowerCase()
    ) {
      throw new Error(
        `Cleaner environment ${name} is outside the configured system drive.`,
      );
    }
  }
  assertValidCleanerProtectedRoots(environment);
}

async function resolveGoCache(
  environmentVariables: NodeJS.ProcessEnv,
  roamingAppData: string,
  localAppData: string,
  systemDrive: string,
): Promise<string | undefined> {
  let configured = environmentVariables["GOCACHE"];
  if (!configured) {
    try {
      const goEnvironment = await fs.readFile(
        path.join(roamingAppData, "go", "env"),
        "utf8",
      );
      configured = goEnvironment
        .split(/\r?\n/)
        .find((line) => line.startsWith("GOCACHE="))
        ?.slice("GOCACHE=".length)
        .trim();
    } catch {
      // Go's environment file is optional.
    }
  }
  const target = configured || path.join(localAppData, "go-build");
  try {
    const normalized = normalizeWindowsPath(target);
    const systemRoot = path.win32.parse(systemDrive).root.toLowerCase();
    if (path.win32.parse(normalized).root.toLowerCase() !== systemRoot)
      return undefined;
    return canonicalizeWindowsAbsolutePath(target);
  } catch {
    return undefined;
  }
}
