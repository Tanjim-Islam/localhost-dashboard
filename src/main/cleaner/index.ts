import type { CleanerClock, CleanerPersistence } from "./types";
import { createCleanerEnvironment } from "./environment";
import { RealCleanerFilesystem } from "./adapters/real-filesystem";
import { TestCleanerFilesystem } from "./adapters/test-filesystem";
import {
  RealCleanerProcessProvider,
  TestCleanerProcessProvider,
} from "./adapters/process-provider";
import {
  RealCleanerApplicationEvidenceProvider,
  TestCleanerApplicationEvidenceProvider,
} from "./adapters/registry-provider";
import {
  RealCleanerDriveProvider,
  TestCleanerDriveProvider,
} from "./adapters/drive-provider";
import {
  ElectronCleanerPersistence,
  MemoryCleanerPersistence,
} from "./cleaner-store";
import { createCleanerDetectors } from "./detectors";
import { CleanerScanSessionManager } from "./scan-session";
import { CleanerScanner } from "./scanner";
import { CleanerCleanupExecutor } from "./cleanup-executor";
import { CleanerController } from "./controller";
import { NodeCleanerAccountingWorkerFactory } from "./accounting-worker-client";

export async function createCleanerController(options?: {
  platform?: NodeJS.Platform;
  persistence?: CleanerPersistence;
  clock?: CleanerClock;
}): Promise<CleanerController> {
  const platform = options?.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("Cleaner is available only on Windows.");
  }
  const clock = options?.clock ?? { now: () => Date.now() };
  const environment = await createCleanerEnvironment();
  const testMode = Boolean(environment.testRoot);
  const filesystem = testMode
    ? new TestCleanerFilesystem(environment.testRoot!)
    : new RealCleanerFilesystem();
  const processProvider = testMode
    ? new TestCleanerProcessProvider(filesystem as TestCleanerFilesystem)
    : new RealCleanerProcessProvider();
  const applicationEvidenceProvider = testMode
    ? new TestCleanerApplicationEvidenceProvider(
        filesystem as TestCleanerFilesystem,
      )
    : new RealCleanerApplicationEvidenceProvider();
  const driveProvider = testMode
    ? new TestCleanerDriveProvider(filesystem as TestCleanerFilesystem)
    : new RealCleanerDriveProvider();
  const persistence =
    options?.persistence ??
    (testMode
      ? new MemoryCleanerPersistence()
      : new ElectronCleanerPersistence());
  const configuredTestDelay = Number(
    process.env["LOCAL_DASHBOARD_CLEANER_TEST_DELAY_MS"] ?? 0,
  );
  const detectorDelayMs =
    testMode && Number.isFinite(configuredTestDelay) && configuredTestDelay > 0
      ? Math.min(10_000, Math.floor(configuredTestDelay))
      : 0;
  const sessions = new CleanerScanSessionManager(clock);
  const detectors = createCleanerDetectors();
  const accountingWorkerFactory = new NodeCleanerAccountingWorkerFactory(
    new URL("./cleaner-accounting-worker.js", import.meta.url),
    environment.testRoot,
  );
  const scanner = new CleanerScanner({
    filesystem,
    processProvider,
    applicationEvidenceProvider,
    driveProvider,
    persistence,
    clock,
    detectors,
    detectorDelayMs,
    accountingWorkerFactory,
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
  return new CleanerController(
    environment,
    testMode,
    persistence,
    sessions,
    scanner,
    cleanupExecutor,
    () => clock.now(),
  );
}

export * from "./types";
export { CleanerController } from "./controller";
