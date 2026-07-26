import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CleanerClock,
  CleanerDetector,
  CleanerPersistence,
  CleanerScanMode,
  CleanerStoreSchema,
} from "../src/main/cleaner/types";
import { createTestCleanerEnvironment } from "../src/main/cleaner/environment";
import { TestCleanerFilesystem } from "../src/main/cleaner/adapters/test-filesystem";
import { TestCleanerProcessProvider } from "../src/main/cleaner/adapters/process-provider";
import { TestCleanerApplicationEvidenceProvider } from "../src/main/cleaner/adapters/registry-provider";
import { TestCleanerDriveProvider } from "../src/main/cleaner/adapters/drive-provider";
import { createCleanerDetectors } from "../src/main/cleaner/detectors";
import { CleanerScanner } from "../src/main/cleaner/scanner";
import {
  CleanerScanSession,
  CleanerScanSessionManager,
} from "../src/main/cleaner/scan-session";
import { CleanerCleanupExecutor } from "../src/main/cleaner/cleanup-executor";
import {
  CLEANER_TEST_MANIFEST,
  type CleanerFixtureManifest,
} from "../src/main/cleaner/adapters/filesystem";
import {
  InProcessCleanerAccountingWorkerFactory,
  type CleanerAccountingWorkerFactory,
} from "../src/main/cleaner/accounting-worker";
import type { CleanerStandardMeasurementPolicy } from "../src/main/cleaner/measurement-policy";

const execFileAsync = promisify(execFile);

export const createEmptyCleanerState = (): CleanerStoreSchema => ({
  schemaVersion: 3,
  exclusions: [],
  itemHistory: {},
  cleanupEvents: [],
  cleanupReceipts: [],
  applicationObservations: {},
  migrationNotices: [],
  preferences: { defaultScanMode: "standard", showExcluded: false },
});

export class TestMemoryPersistence implements CleanerPersistence {
  constructor(private state = createEmptyCleanerState()) {}
  read(): CleanerStoreSchema {
    return structuredClone(this.state);
  }
  write(next: CleanerStoreSchema): void {
    this.state = structuredClone(next);
  }
}

export async function createCleanerFixture(): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "scripts/cleaner-fixtures.mts", "create"],
    { cwd: process.cwd(), windowsHide: true },
  );
  const root = stdout.trim().split(/\r?\n/).at(-1);
  if (!root) throw new Error("Cleaner fixture script did not return a root.");
  process.env["LOCAL_DASHBOARD_CLEANER_TEST_ROOT"] = root;
  return root;
}

export async function removeCleanerFixture(root: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/cleaner-fixtures.mts",
      "remove",
      root,
    ],
    { cwd: process.cwd(), windowsHide: true },
  );
  if (process.env["LOCAL_DASHBOARD_CLEANER_TEST_ROOT"] === root) {
    delete process.env["LOCAL_DASHBOARD_CLEANER_TEST_ROOT"];
  }
}

export async function updateFixtureManifest(
  root: string,
  update: (manifest: CleanerFixtureManifest) => void,
): Promise<void> {
  const manifestPath = path.join(root, CLEANER_TEST_MANIFEST);
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as CleanerFixtureManifest;
  update(manifest);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function createCleanerHarness(
  root: string,
  persistence = new TestMemoryPersistence(),
  options: {
    accountingWorkerFactory?: CleanerAccountingWorkerFactory;
    clock?: CleanerClock;
    detectors?: CleanerDetector[];
    detectorDelayMs?: number;
    standardActionableMeasurementPolicy?: CleanerStandardMeasurementPolicy;
    standardInformationalMeasurementPolicy?: CleanerStandardMeasurementPolicy;
  } = {},
) {
  const environment = await createTestCleanerEnvironment(root);
  const filesystem = new TestCleanerFilesystem(root);
  const processProvider = new TestCleanerProcessProvider(filesystem);
  const applicationEvidenceProvider =
    new TestCleanerApplicationEvidenceProvider(filesystem);
  const driveProvider = new TestCleanerDriveProvider(filesystem);
  const clock = options.clock ?? { now: () => Date.now() };
  const detectors = options.detectors ?? createCleanerDetectors();
  const accountingWorkerFactory =
    options.accountingWorkerFactory ??
    new InProcessCleanerAccountingWorkerFactory(filesystem);
  const scanner = new CleanerScanner({
    filesystem,
    processProvider,
    applicationEvidenceProvider,
    driveProvider,
    persistence,
    clock,
    detectors,
    accountingWorkerFactory,
    detectorDelayMs: options.detectorDelayMs,
    standardActionableMeasurementPolicy:
      options.standardActionableMeasurementPolicy,
    standardInformationalMeasurementPolicy:
      options.standardInformationalMeasurementPolicy,
  });
  const cleanupExecutor = new CleanerCleanupExecutor({
    filesystem,
    processProvider,
    applicationEvidenceProvider,
    detectors,
    driveProvider,
    persistence,
    clock,
    accountingWorkerFactory,
  });
  return {
    environment,
    filesystem,
    processProvider,
    applicationEvidenceProvider,
    detectors,
    driveProvider,
    clock,
    scanner,
    cleanupExecutor,
    accountingWorkerFactory,
    persistence,
  };
}

export async function scanFixture(
  root: string,
  mode: CleanerScanMode,
  persistence = new TestMemoryPersistence(),
) {
  const harness = await createCleanerHarness(root, persistence);
  const session = new CleanerScanSession(mode, true, harness.clock);
  const progress: number[] = [];
  const progressEvents: import("../src/main/cleaner/types").CleanerScanProgress[] =
    [];
  const result = await harness.scanner.scan(
    session,
    harness.environment,
    (item) => {
      progress.push(item.percent);
      progressEvents.push(item);
    },
  );
  return { ...harness, session, result, progress, progressEvents };
}

export function createSessionManager(now = Date.now(), maxAgeMs?: number) {
  let current = now;
  const clock = { now: () => current };
  const manager = new CleanerScanSessionManager(clock, maxAgeMs);
  return {
    manager,
    clock,
    advance(ms: number) {
      current += ms;
    },
  };
}
