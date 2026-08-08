import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { CleanerController } from "../src/main/cleaner/controller";
import {
  CleanerAccountingWorkerFailure,
  type CleanerAccountingWorkerFactory,
  type CleanerAccountingWorkerSession,
} from "../src/main/cleaner/accounting-worker";
import { NodeCleanerAccountingWorkerFactory } from "../src/main/cleaner/accounting-worker-client";
import {
  CleanerCancellationToken,
  CleanerCancelledError,
} from "../src/main/cleaner/cancellation";
import { candidate } from "../src/main/cleaner/detectors/helpers";
import { CleanerScanSession } from "../src/main/cleaner/scan-session";
import type {
  CleanerDetector,
  CleanerScanProgress,
} from "../src/main/cleaner/types";
import type {
  CleanerMeasuredSize,
  CleanerMeasurementProgress,
} from "../src/main/cleaner/size-calculator";
import {
  createCleanerFixture,
  createCleanerHarness,
  createSessionManager,
  removeCleanerFixture,
  scanFixture,
} from "./cleaner-test-helpers";

test("Standard Scan remains bounded while Deep Audit completes the uv-like virtual tree", async () => {
  const root = await createCleanerFixture();
  try {
    const standard = await scanFixture(root, "standard");
    const standardUv = standard.result.findings.find(
      (finding) => finding.detectorId === "dev.uv-cache",
    );
    assert.equal(standardUv?.measurementCompleteness, "partial");
    assert.equal(standardUv?.measurementLimitReason, "entry-limit");
    assert.equal(standardUv?.logicalTraversalComplete, false);
    assert.equal(standardUv?.estimatedReclaimableBytes, null);
    assert.equal(standardUv?.recoverableBytes, 0);
    assert.equal(standardUv?.canDelete, false);
    assert.ok(standard.result.summary.partialLogicalBytes > 0);

    const deep = await scanFixture(root, "deep");
    const deepUv = deep.result.findings.find(
      (finding) => finding.detectorId === "dev.uv-cache",
    );
    assert.equal(deepUv?.measurementCompleteness, "complete");
    assert.equal(deepUv?.measurementLimitReason, undefined);
    assert.equal(deepUv?.logicalTraversalComplete, true);
    assert.equal(deepUv?.physicalAccountingComplete, true);
    assert.equal(deepUv?.logicalBytes, 9_690_000_000);
    assert.equal(deepUv?.estimatedReclaimableBytes, 2_221_572_096);
    assert.equal(deepUv?.measuredFileCount, 479_669);
    assert.equal(deepUv?.measuredDirectoryCount, 71_185);
    assert.ok(
      deep.progressEvents.some(
        (progress) =>
          progress.currentDetectorId === "dev.uv-cache" &&
          progress.processedFiles > 50_000,
      ),
    );
    assert.equal(deep.progressEvents.at(-1)?.workerActive, false);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("Deep Audit ignores Standard measurement limits and has no elapsed-time completion budget", async () => {
  const root = await createCleanerFixture();
  try {
    let current = 0;
    const clock = {
      now: () => {
        current += 70_000;
        return current;
      },
    };
    const detector = fixtureDetector(root, [
      ["first", "User/AppData/Local/pip/Cache"],
      ["second", "User/AppData/Local/pypoetry/Cache"],
    ]);
    const harness = await createCleanerHarness(root, undefined, {
      clock,
      detectors: [detector],
      standardActionableMeasurementPolicy: {
        kind: "standard-bounded",
        maxEntries: 1,
        maxDurationMs: 1,
        maxTrackedFileRecords: 1,
      },
    });
    const session = new CleanerScanSession("deep", true, clock);
    const result = await harness.scanner.scan(
      session,
      harness.environment,
      () => undefined,
    );

    assert.equal(result.findings.length, 2);
    assert.equal(
      result.findings.every(
        (finding) => finding.measurementCompleteness === "complete",
      ),
      true,
    );
    assert.ok(result.summary.durationMs > 120_000);
    assert.doesNotMatch(
      result.summary.scanWarnings.join(" "),
      /global scan time budget/i,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("Deep Audit does not publish a completed result while accounting is active", async () => {
  const root = await createCleanerFixture();
  try {
    const deferred = createDeferred<CleanerMeasuredSize>();
    const worker = new ScriptedWorkerFactory([
      {
        onMeasure: (_targetPath, _cancellation, onProgress) => {
          onProgress?.(measurementProgress(4, 2));
          return deferred.promise;
        },
      },
    ]);
    const detector = fixtureDetector(root, [
      ["deferred", "User/AppData/Local/pip/Cache"],
    ]);
    const harness = await createCleanerHarness(root, undefined, {
      detectors: [detector],
      accountingWorkerFactory: worker,
    });
    const sessions = createSessionManager().manager;
    const controller = new CleanerController(
      harness.environment,
      true,
      harness.persistence,
      sessions,
      harness.scanner,
      harness.cleanupExecutor,
      () => Date.now(),
    );
    let completedCount = 0;
    controller.on("scan-complete", () => {
      completedCount += 1;
    });
    const completed = new Promise<void>((resolve) => {
      controller.once("scan-complete", () => resolve());
    });

    const state = controller.startScan({ mode: "deep" });
    assert.equal(state.status, "scanning");
    await worker.measureStarted.promise;
    await nextTurn();
    assert.equal(completedCount, 0);
    assert.equal(controller.getState().status, "scanning");

    deferred.resolve(completeMeasurement());
    await completed;
    assert.equal(completedCount, 1);
    assert.equal(controller.getState().status, "complete");
    assert.equal(worker.closedSessions, 1);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("slow but progressing Deep Audit work is not terminated", async () => {
  const root = await createCleanerFixture();
  try {
    const worker = new ScriptedWorkerFactory([
      {
        async onMeasure(_targetPath, _cancellation, onProgress) {
          for (let index = 1; index <= 4; index += 1) {
            onProgress?.(measurementProgress(index * 1_000, index * 250));
            await nextTurn();
          }
          return completeMeasurement({
            measuredFileCount: 4_000,
            measuredDirectoryCount: 1_000,
            inspectedEntryCount: 5_000,
            fileCount: 4_000,
            inspectedEntries: 5_000,
          });
        },
      },
    ]);
    let current = 0;
    const clock = {
      now: () => {
        current += 101;
        return current;
      },
    };
    const harness = await createCleanerHarness(root, undefined, {
      detectors: [
        fixtureDetector(root, [
          ["progressing", "User/AppData/Local/pip/Cache"],
        ]),
      ],
      accountingWorkerFactory: worker,
      clock,
    });
    const session = new CleanerScanSession("deep", true, harness.clock);
    const progress: CleanerScanProgress[] = [];
    const result = await harness.scanner.scan(
      session,
      harness.environment,
      (event) => progress.push(event),
    );

    assert.equal(result.findings[0]?.measurementCompleteness, "complete");
    assert.ok(
      progress.some(
        (event) => event.workerActive && event.processedFiles >= 3_000,
      ),
    );
    assert.equal(worker.closedSessions, 1);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("Deep Audit cancellation reaches active accounting and publishes no completed result", async () => {
  const root = await createCleanerFixture();
  try {
    const worker = new ScriptedWorkerFactory([
      {
        onMeasure(_targetPath, cancellation, onProgress) {
          onProgress?.(measurementProgress(1_000, 100));
          return new Promise<CleanerMeasuredSize>((_resolve, reject) => {
            cancellation.onCancelled(() => reject(new CleanerCancelledError()));
          });
        },
      },
    ]);
    const harness = await createCleanerHarness(root, undefined, {
      detectors: [
        fixtureDetector(root, [["cancelled", "User/AppData/Local/pip/Cache"]]),
      ],
      accountingWorkerFactory: worker,
    });
    const sessionFixture = createSessionManager();
    const controller = new CleanerController(
      harness.environment,
      true,
      harness.persistence,
      sessionFixture.manager,
      harness.scanner,
      harness.cleanupExecutor,
      () => Date.now(),
    );
    let completedCount = 0;
    controller.on("scan-complete", () => {
      completedCount += 1;
    });
    const state = controller.startScan({ mode: "deep" });
    assert.equal(state.status, "scanning");
    await worker.measureStarted.promise;
    if (state.status !== "scanning") {
      throw new Error("Deep Audit did not enter scanning state.");
    }
    controller.cancelScan(state.progress.scanSessionId);
    await nextTurn();
    await nextTurn();

    assert.equal(controller.getState().status, "cancelled");
    assert.equal(completedCount, 0);
    assert.equal(sessionFixture.manager.getActive()?.result, undefined);
    assert.equal(worker.closedSessions, 1);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("a failed accounting worker is isolated and the next Deep Audit target still completes", async () => {
  const root = await createCleanerFixture();
  try {
    const worker = new ScriptedWorkerFactory([
      {
        async onMeasure() {
          throw new CleanerAccountingWorkerFailure(
            "Simulated stalled worker failure.",
          );
        },
      },
      {
        async onMeasure() {
          return completeMeasurement();
        },
      },
    ]);
    const harness = await createCleanerHarness(root, undefined, {
      detectors: [
        fixtureDetector(root, [
          ["failed", "User/AppData/Local/pip/Cache"],
          ["continued", "User/AppData/Local/pypoetry/Cache"],
        ]),
      ],
      accountingWorkerFactory: worker,
    });
    const session = new CleanerScanSession("deep", true, harness.clock);
    const result = await harness.scanner.scan(
      session,
      harness.environment,
      () => undefined,
    );

    assert.equal(result.findings.length, 2);
    assert.equal(
      result.findings[0]?.measurementFailureCategory,
      "worker-failed",
    );
    assert.equal(result.findings[0]?.measurementCompleteness, "unavailable");
    assert.equal(result.findings[0]?.canDelete, false);
    assert.equal(result.findings[1]?.measurementCompleteness, "complete");
    assert.equal(result.summary.scanIncomplete, true);
    assert.match(
      result.summary.scanWarnings.join(" "),
      /background accounting worker stopped unexpectedly/i,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("Deep Audit retries a target once when it detects filesystem instability", async () => {
  const root = await createCleanerFixture();
  try {
    let measureCalls = 0;
    const worker = new ScriptedWorkerFactory([
      {
        async onMeasure() {
          measureCalls += 1;
          if (measureCalls === 1) {
            return completeMeasurement({
              estimatedReclaimableBytes: null,
              measurementCompleteness: "partial",
              accountingConfidence: "lower-bound",
              logicalTraversalComplete: false,
              physicalAccountingComplete: false,
              measurementFailureCategory: "filesystem-instability",
              measurementFailureExplanation:
                "The recognized target changed while it was being measured.",
              complete: false,
            });
          }
          return completeMeasurement();
        },
      },
    ]);
    const harness = await createCleanerHarness(root, undefined, {
      detectors: [
        fixtureDetector(root, [["unstable", "User/AppData/Local/pip/Cache"]]),
      ],
      accountingWorkerFactory: worker,
    });
    const session = new CleanerScanSession("deep", true, harness.clock);
    const progress: CleanerScanProgress[] = [];
    const result = await harness.scanner.scan(
      session,
      harness.environment,
      (event) => progress.push(event),
    );

    assert.equal(measureCalls, 2);
    assert.equal(result.findings[0]?.measurementCompleteness, "complete");
    assert.equal(result.findings[0]?.measurementFailureCategory, undefined);
    assert.ok(
      progress.some((event) =>
        /retrying after detected change/i.test(event.currentCategory),
      ),
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("root-scoped marker safety ignores cached payload names but still blocks root mixed state", async () => {
  const root = await createCleanerFixture();
  try {
    const target = path.join(root, "MarkerScope", "cache");
    await fsPromises.mkdir(path.join(target, "payload", "extensions"), {
      recursive: true,
    });
    await fsPromises.writeFile(
      path.join(target, "payload", "extensions", "cached.bin"),
      "fixture\n",
    );
    const detector: CleanerDetector = {
      id: "test.marker-scope",
      category: "Fixture",
      supportedPlatform: "win32",
      async detect() {
        return [
          candidate({
            detectorId: "test.marker-scope",
            category: "Fixture",
            displayName: "Marker scope fixture",
            applicationName: "Fixture",
            path: target,
            baseSafety: "safe-now",
            reason: "Exact fixture cache.",
            consequences: ["Fixture data can be regenerated."],
            restoration: "The fixture generator recreates this cache.",
            dataKind: "download-cache",
            relatedProcessNames: [],
            protectedMarkerScope: "root-children",
            canDelete: true,
          }),
        ];
      },
    };
    const firstHarness = await createCleanerHarness(root, undefined, {
      detectors: [detector],
    });
    const firstSession = new CleanerScanSession(
      "deep",
      true,
      firstHarness.clock,
    );
    const firstResult = await firstHarness.scanner.scan(
      firstSession,
      firstHarness.environment,
      () => undefined,
    );
    assert.equal(firstResult.findings[0]?.safety, "safe-now");
    assert.equal(firstResult.findings[0]?.canDelete, true);

    await fsPromises.mkdir(path.join(target, "settings"));
    const secondHarness = await createCleanerHarness(root, undefined, {
      detectors: [detector],
    });
    const secondSession = new CleanerScanSession(
      "deep",
      true,
      secondHarness.clock,
    );
    const secondResult = await secondHarness.scanner.scan(
      secondSession,
      secondHarness.environment,
      () => undefined,
    );
    assert.equal(secondResult.findings[0]?.safety, "manual-review");
    assert.equal(secondResult.findings[0]?.canDelete, false);
    assert.match(
      secondResult.findings[0]?.reason ?? "",
      /protected or inaccessible mixed-state markers/i,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("the production accounting client runs exhaustive fixture traversal in a worker thread", async () => {
  const root = await createCleanerFixture();
  const workerScript = path.join(
    process.cwd(),
    ".tmp-tests",
    "src",
    "main",
    "cleaner",
    "workers",
    "accounting-worker.js",
  );
  const factory = new NodeCleanerAccountingWorkerFactory(workerScript, root);
  const worker = factory.create();
  try {
    const target = path.join(root, "User", "AppData", "Local", "uv", "cache");
    const measurementCancellation = new CleanerCancellationToken();
    const progress: CleanerMeasurementProgress[] = [];
    let mainEventLoopResponsive = false;
    const pending = worker.measure(target, measurementCancellation, (event) => {
      progress.push(event);
    });
    setImmediate(() => {
      mainEventLoopResponsive = true;
    });
    await nextTurn();
    assert.equal(mainEventLoopResponsive, true);

    const result = await pending;
    assert.equal(result.measurementCompleteness, "complete");
    assert.equal(result.logicalTraversalComplete, true);
    assert.equal(result.physicalAccountingComplete, true);
    assert.equal(result.logicalBytes, 9_690_000_000);
    assert.equal(result.estimatedReclaimableBytes, 2_221_572_096);
    assert.ok(progress.some((event) => event.measuredFileCount > 50_000));

    const cancellation = new CleanerCancellationToken();
    let cancellationSent = false;
    const cancelledMeasurement = worker.measure(
      target,
      cancellation,
      (event) => {
        if (!cancellationSent && event.measuredFileCount >= 128) {
          cancellationSent = true;
          cancellation.cancel();
        }
      },
    );
    await assert.rejects(cancelledMeasurement, CleanerCancelledError);
    assert.equal(cancellationSent, true);
  } finally {
    await worker.close();
    await removeCleanerFixture(root);
  }
});

test("exhaustive accounting streams batches and retains only multi-link record state", () => {
  const calculatorSource = fs.readFileSync(
    path.join(process.cwd(), "src", "main", "cleaner", "size-calculator.ts"),
    "utf8",
  ) as string;
  const workerSource = fs.readFileSync(
    path.join(
      process.cwd(),
      "src",
      "main",
      "cleaner",
      "workers",
      "accounting-worker.ts",
    ),
    "utf8",
  ) as string;

  assert.match(calculatorSource, /readDirectoryBatches/);
  assert.match(calculatorSource, /hardlinkCount === 1 && hasIdentity/);
  assert.doesNotMatch(calculatorSource, /filePaths|allPaths|directoryListings/);
  assert.match(workerSource, /worker_threads/);
  assert.doesNotMatch(workerSource, /shell:\s*true|execFile|spawn/);
});

function fixtureDetector(
  root: string,
  definitions: Array<[id: string, relativePath: string]>,
): CleanerDetector {
  return {
    id: "test.deep-audit",
    category: "Fixture",
    supportedPlatform: "win32",
    async detect() {
      return definitions.map(([id, relativePath]) =>
        candidate({
          detectorId: `test.${id}`,
          category: "Fixture",
          displayName: `Fixture ${id}`,
          applicationName: "Fixture",
          path: path.join(root, ...relativePath.split("/")),
          baseSafety: "safe-now",
          reason: "Exact fixture cache.",
          consequences: ["Fixture data can be regenerated."],
          restoration: "The fixture generator recreates this cache.",
          dataKind: "ordinary-cache",
          relatedProcessNames: [],
          canDelete: true,
        }),
      );
    },
  };
}

class ScriptedWorkerFactory implements CleanerAccountingWorkerFactory {
  private sessionIndex = 0;
  readonly measureStarted = createDeferred<void>();
  closedSessions = 0;

  constructor(
    private readonly scripts: Array<{
      onMeasure(
        targetPath: string,
        cancellation: CleanerCancellationToken,
        onProgress?: (progress: CleanerMeasurementProgress) => void,
      ): Promise<CleanerMeasuredSize>;
    }>,
  ) {}

  create(): CleanerAccountingWorkerSession {
    const script = this.scripts[this.sessionIndex] ?? this.scripts.at(-1);
    this.sessionIndex += 1;
    if (!script) {
      throw new Error("No scripted accounting worker is available.");
    }
    return {
      measure: (targetPath, cancellation, onProgress) => {
        this.measureStarted.resolve();
        return script.onMeasure(targetPath, cancellation, onProgress);
      },
      close: async () => {
        this.closedSessions += 1;
      },
    };
  }
}

function completeMeasurement(
  overrides: Partial<CleanerMeasuredSize> = {},
): CleanerMeasuredSize {
  const now = Date.now();
  return {
    logicalBytes: 4_096,
    allocatedBytes: 4_096,
    uniqueAllocatedBytes: 4_096,
    estimatedReclaimableBytes: 4_096,
    reclaimableLowerBoundBytes: 4_096,
    reclaimableUpperBoundBytes: 4_096,
    measurementCompleteness: "complete",
    accountingConfidence: "exact",
    hardlinkRecordCount: 0,
    externalHardlinkRecordCount: 0,
    sparseFileCount: 0,
    compressedFileCount: 0,
    measuredFileCount: 1,
    measuredDirectoryCount: 1,
    inaccessibleEntryCount: 0,
    inspectedEntryCount: 2,
    measurementStartedAt: now,
    measurementCompletedAt: now,
    measurementDurationMs: 0,
    logicalTraversalComplete: true,
    physicalAccountingComplete: true,
    sizeBytes: 4_096,
    fileCount: 1,
    inaccessibleEntries: 0,
    reparsePointStatus: "clear",
    complete: true,
    inspectedEntries: 2,
    protectedMarkers: [],
    internalReparsePointCount: 0,
    rootStat: {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      isReparsePoint: false,
      size: 0,
      modifiedMs: 1,
      device: 1,
      inode: 1,
    },
    ...overrides,
    rootProtectedMarkers: overrides.rootProtectedMarkers ?? [],
  };
}

function measurementProgress(
  files: number,
  directories: number,
): CleanerMeasurementProgress {
  return {
    inspectedEntries: files + directories,
    measuredFileCount: files,
    measuredDirectoryCount: directories,
    uniqueFileRecords: files,
    logicalBytes: files * 4_096,
    elapsedMs: files,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
