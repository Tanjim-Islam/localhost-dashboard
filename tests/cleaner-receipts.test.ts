import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { CleanerCleanupExecutor } from "../src/main/cleaner/cleanup-executor";
import {
  MAX_CLEANER_RECEIPTS,
  recoverInterruptedCleanupReceipts,
} from "../src/main/cleaner/cleanup-receipts";
import { migrateCleanerStore } from "../src/main/cleaner/store-migration";
import { prepareCleanerStoreForAuditMigration } from "../src/main/cleaner/store-file-migration";
import { normalizeWindowsPath } from "../src/main/cleaner/path-normalization";
import { getRegenerationStatus } from "../src/main/cleaner/history";
import type {
  CleanerCleanupReceipt,
  CleanerFilesystem,
} from "../src/main/cleaner/types";
import {
  createCleanerFixture,
  removeCleanerFixture,
  scanFixture,
  TestMemoryPersistence,
  updateFixtureManifest,
} from "./cleaner-test-helpers";
import { InProcessCleanerAccountingWorkerFactory } from "../src/main/cleaner/accounting-worker";

test("cleanup persists an in-progress receipt before unlink and finalizes exact operation counts", async () => {
  const root = await createCleanerFixture();
  const persistence = new TestMemoryPersistence();
  try {
    const harness = await scanFixture(root, "standard", persistence);
    const finding = harness.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    harness.driveProvider.setFreeBytesSequence([
      10_000_000_000, 10_050_000_000,
    ]);
    let sawPreDeleteReceipt = false;
    const filesystem = delegateFilesystem(harness.filesystem, {
      async unlink(target) {
        const receipt = persistence.read().cleanupReceipts[0];
        assert.equal(receipt.status, "in-progress");
        assert.equal(receipt.selectedFindingIds[0], finding.id);
        assert.equal(receipt.findings[0].attemptStatus, "partial");
        sawPreDeleteReceipt = true;
        await harness.filesystem.unlink(target);
      },
    });
    const executor = createExecutor(harness, filesystem);
    const result = await executor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [finding.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );

    assert.equal(sawPreDeleteReceipt, true);
    assert.equal(result.status, "completed");
    assert.equal(result.findings[0].attemptStatus, "deleted");
    assert.equal(result.findings[0].filesAttempted, 1);
    assert.equal(result.findings[0].filesSuccessfullyUnlinked, 1);
    assert.equal(
      result.findings[0].directoriesAttempted,
      result.findings[0].directoriesSuccessfullyRemoved,
    );
    assert.equal(result.findings[0].postCleanupRootExists, false);
    assert.equal(result.findings[0].verificationCompleted, true);
    assert.equal(result.signedFreeSpaceDeltaBytes, 50_000_000);
    const stored = persistence.read().cleanupReceipts[0];
    assert.equal(stored.status, "completed");
    assert.equal(stored.cleanupRequestId, result.cleanupRequestId);
    assert.doesNotMatch(
      JSON.stringify(stored),
      /fixture\.bin|directoryListings|rawCommand|registryDump|secret/i,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("signed drive deltas remain negative and are never attributed per finding", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const findings = harness.result.findings.filter((item) =>
      ["dev.npm-cache", "dev.npx-cache"].includes(item.detectorId),
    );
    assert.equal(findings.length, 2);
    harness.driveProvider.setFreeBytesSequence([5_000_000, 4_250_000]);
    const result = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: findings.map((finding) => finding.id),
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );

    assert.equal(result.signedFreeSpaceDeltaBytes, -750_000);
    assert.equal(result.observedDriveDifferenceBytes, -750_000);
    assert.equal(result.findings.length, 2);
    for (const finding of result.findings) {
      assert.equal(Object.hasOwn(finding, "signedFreeSpaceDeltaBytes"), false);
    }
  } finally {
    await removeCleanerFixture(root);
  }
});

test("cleanup preserves an explicit zero drive delta instead of deriving it from logical deletion", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const finding = harness.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    harness.driveProvider.setFreeBytesSequence([8_000_000, 8_000_000]);
    const result = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [finding.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );

    assert.equal(result.aggregateLogicalBytesRemoved, 1_600_000_000);
    assert.equal(result.signedFreeSpaceDeltaBytes, 0);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("nested selected findings produce one authoritative cleanup and one path-union receipt total", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const parent = harness.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    const nestedPath = path.join(parent.path, "fixture.bin");
    const nested = {
      ...structuredClone(parent),
      id: "nested-receipt-fixture",
      path: nestedPath,
      normalizedPath: normalizeWindowsPath(nestedPath),
      logicalBytes: 100,
      sizeBytes: 100,
      allocatedBytes: 100,
      uniqueAllocatedBytes: 100,
      estimatedReclaimableBytes: 100,
      reclaimableLowerBoundBytes: 100,
      reclaimableUpperBoundBytes: 100,
      recoverableBytes: 100,
      accounting: {
        ...structuredClone(parent.accounting),
        logicalBytes: 100,
        allocatedBytes: 100,
        uniqueAllocatedBytes: 100,
        estimatedReclaimableBytes: 100,
        reclaimableLowerBoundBytes: 100,
        reclaimableUpperBoundBytes: 100,
      },
    };
    harness.session.findings.set(nested.id, nested);
    harness.session.result!.findings.push(nested);
    harness.driveProvider.setFreeBytesSequence([9_000_000, 9_000_000]);

    const result = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [parent.id, nested.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );

    assert.equal(result.selectedFindingIds.length, 2);
    assert.deepEqual(result.resolvedFindingIds, [parent.id]);
    assert.equal(result.aggregateLogicalBytesAddressed, parent.logicalBytes);
    assert.equal(
      result.aggregateEstimatedPhysicalBytesReclaimable,
      parent.estimatedReclaimableBytes,
    );
    const nestedReceipt = result.findings.find(
      (item) => item.findingId === nested.id,
    )!;
    assert.equal(nestedReceipt.attemptStatus, "skipped");
    assert.deepEqual(nestedReceipt.failureCategories, ["overlap-resolved"]);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("post-cleanup verification failure produces partial, never deleted", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const finding = harness.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    let deletionCompleted = false;
    const filesystem = delegateFilesystem(harness.filesystem, {
      async unlink(target) {
        await harness.filesystem.unlink(target);
        deletionCompleted = true;
      },
      async lstat(target) {
        if (
          deletionCompleted &&
          normalizeWindowsPath(target) === finding.normalizedPath
        ) {
          throw Object.assign(new Error("verification unavailable"), {
            code: "EACCES",
          });
        }
        return harness.filesystem.lstat(target);
      },
    });
    const result = await createExecutor(harness, filesystem).clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [finding.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );

    assert.equal(result.status, "partial");
    assert.equal(result.findings[0].attemptStatus, "partial");
    assert.equal(result.findings[0].postCleanupRootExists, null);
    assert.equal(result.findings[0].verificationCompleted, false);
    assert.ok(
      result.findings[0].failureCategories.includes("verification-failed"),
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("zero measured remaining bytes with an inaccessible entry is still partial", async () => {
  const root = await createCleanerFixture();
  try {
    const target = path.join(
      root,
      "User",
      "AppData",
      "Local",
      "npm-cache",
      "_cacache",
    );
    const locked = path.join(target, "fixture.bin");
    await updateFixtureManifest(root, (manifest) => {
      delete manifest.sizeOverrides[normalizeWindowsPath(target)];
    });
    const harness = await scanFixture(root, "standard");
    const finding = harness.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    let deleteAttempted = false;
    const filesystem = delegateFilesystem(harness.filesystem, {
      async unlink(filePath) {
        if (normalizeWindowsPath(filePath) === normalizeWindowsPath(locked)) {
          deleteAttempted = true;
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        }
        await harness.filesystem.unlink(filePath);
      },
      async lstat(filePath) {
        if (
          deleteAttempted &&
          normalizeWindowsPath(filePath) === normalizeWindowsPath(locked)
        ) {
          throw Object.assign(new Error("inaccessible"), { code: "EACCES" });
        }
        return harness.filesystem.lstat(filePath);
      },
    });
    const result = await createExecutor(harness, filesystem).clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [finding.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );

    assert.equal(result.findings[0].postCleanupRootExists, true);
    assert.equal(result.findings[0].postCleanupLogicalBytes, 0);
    assert.equal(
      result.findings[0].postCleanupMeasurementCompleteness,
      "partial",
    );
    assert.equal(result.findings[0].attemptStatus, "partial");
    assert.equal(result.findings[0].verificationCompleted, false);
    let history = Object.values(harness.persistence.read().itemHistory).find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    assert.equal(history.successfulCleanups, 0);
    assert.equal(history.observedRegenerations, 0);
    assert.equal(getRegenerationStatus(history).label, "regeneration-unknown");
    await scanFixture(root, "standard", harness.persistence);
    history = Object.values(harness.persistence.read().itemHistory).find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    assert.equal(history.successfulCleanups, 0);
    assert.equal(history.observedRegenerations, 0);
    assert.equal(getRegenerationStatus(history).label, "regeneration-unknown");
  } finally {
    await removeCleanerFixture(root);
  }
});

test("regeneration is recorded only after a verified deletion baseline", async () => {
  const root = await createCleanerFixture();
  const persistence = new TestMemoryPersistence();
  try {
    const first = await scanFixture(root, "standard", persistence);
    const finding = first.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    const receipt = await first.cleanupExecutor.clean(
      first.session,
      {
        scanSessionId: first.session.id,
        findingIds: [finding.id],
        confirmation: "safe",
      },
      first.environment,
      () => undefined,
    );
    assert.equal(receipt.findings[0].attemptStatus, "deleted");
    let history = Object.values(persistence.read().itemHistory).find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    assert.equal(history.successfulCleanups, 1);
    assert.equal(history.regenerationBaselineComplete, true);

    await fs.mkdir(finding.path, { recursive: true });
    await fs.writeFile(path.join(finding.path, "regenerated.bin"), "new\n");
    await updateFixtureManifest(root, (manifest) => {
      if (!manifest.createdPaths.includes(finding.path)) {
        manifest.createdPaths.push(finding.path);
      }
      manifest.sizeOverrides[finding.normalizedPath] = 640_000_000;
    });
    await scanFixture(root, "standard", persistence);
    history = Object.values(persistence.read().itemHistory).find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    assert.equal(history.observedRegenerations, 1);
    assert.equal(history.currentObservedSizeBytes, 640_000_000);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("in-progress receipts recover as interrupted without successful-cleanup credit", async () => {
  const root = await createCleanerFixture();
  const persistence = new TestMemoryPersistence();
  try {
    const harness = await scanFixture(root, "standard", persistence);
    const finding = harness.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    const complete = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [finding.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );
    const state = persistence.read();
    const interrupted: CleanerCleanupReceipt = {
      ...structuredClone(complete),
      cleanupRequestId: "interrupted-receipt",
      status: "in-progress",
      completedAt: undefined,
      findings: complete.findings.map((item) => ({
        ...item,
        attemptStatus: "partial",
        verificationCompleted: false,
      })),
    };
    state.cleanupReceipts = [interrupted];
    const successfulBefore = Object.values(state.itemHistory).reduce(
      (total, item) => total + item.successfulCleanups,
      0,
    );
    assert.equal(recoverInterruptedCleanupReceipts(state, 123_456), true);

    assert.equal(state.cleanupReceipts[0].status, "interrupted");
    assert.equal(state.cleanupReceipts[0].completedAt, 123_456);
    assert.equal(
      state.cleanupReceipts[0].postCleanupVerificationCompleted,
      false,
    );
    assert.equal(
      Object.values(state.itemHistory).reduce(
        (total, item) => total + item.successfulCleanups,
        0,
      ),
      successfulBefore,
    );
    const history = Object.values(state.itemHistory).find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    assert.equal(history.regenerationBaselineComplete, false);
    assert.equal(getRegenerationStatus(history).label, "regeneration-unknown");
  } finally {
    await removeCleanerFixture(root);
  }
});

test("schema migration retains bounded receipts and strips unknown audit payloads", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const finding = harness.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    const receipt = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [finding.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );
    const migrated = migrateCleanerStore({
      schemaVersion: 2,
      exclusions: [],
      itemHistory: {},
      cleanupEvents: [],
      cleanupReceipts: Array.from(
        { length: MAX_CLEANER_RECEIPTS + 5 },
        (_, index) => ({
          ...structuredClone(receipt),
          cleanupRequestId: `receipt-${index}`,
          rawCommand: "--token secret",
          directoryListing: ["private.bin"],
        }),
      ),
      applicationObservations: {},
      migrationNotices: [],
      preferences: { defaultScanMode: "standard", showExcluded: false },
      registryDump: ["secret"],
    });

    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.cleanupReceipts.length, MAX_CLEANER_RECEIPTS);
    assert.doesNotMatch(
      JSON.stringify(migrated),
      /rawCommand|directoryListing|private\.bin|registryDump|--token|secret/i,
    );
    assert.match(
      migrated.migrationNotices.join(" "),
      /durable cleanup receipts/i,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("store-file migration preserves the previous audit representation before rewriting", async () => {
  const root = await createCleanerFixture();
  try {
    const legacy = {
      schemaVersion: 2,
      exclusions: [],
      itemHistory: {},
      cleanupEvents: [
        {
          id: "legacy-event",
          detectorId: "dev.npm-cache",
          normalizedPath: normalizeWindowsPath(
            path.join(root, "User", "AppData", "Local", "npm-cache"),
          ),
          applicationName: "npm",
          cleanedAt: 10,
          sizeBeforeBytes: 100,
          logicalBytesDeleted: 80,
          remainingBytes: 20,
          result: "partial",
        },
      ],
      applicationObservations: {},
      migrationNotices: [],
      preferences: { defaultScanMode: "standard", showExcluded: false },
    };
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    await fs.writeFile(path.join(root, "cleaner.json"), raw);

    prepareCleanerStoreForAuditMigration(root);

    const names = await fs.readdir(root);
    const backupName = names.find((name) =>
      /^cleaner\.audit-backup\.\d+\.json$/.test(name),
    );
    assert.ok(backupName);
    assert.equal(await fs.readFile(path.join(root, backupName), "utf8"), raw);
    const migrated = JSON.parse(
      await fs.readFile(path.join(root, "cleaner.json"), "utf8"),
    );
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.cleanupEvents[0].id, "legacy-event");
    assert.match(migrated.migrationNotices.join(" "), /previous.*preserved/i);
  } finally {
    await removeCleanerFixture(root);
  }
});

function createExecutor(
  harness: Awaited<ReturnType<typeof scanFixture>>,
  filesystem: CleanerFilesystem,
) {
  return new CleanerCleanupExecutor({
    filesystem,
    processProvider: harness.processProvider,
    applicationEvidenceProvider: harness.applicationEvidenceProvider,
    detectors: harness.detectors,
    driveProvider: harness.driveProvider,
    persistence: harness.persistence,
    clock: harness.clock,
    accountingWorkerFactory: new InProcessCleanerAccountingWorkerFactory(
      filesystem,
    ),
  });
}

function delegateFilesystem(
  base: CleanerFilesystem,
  overrides: Partial<CleanerFilesystem>,
): CleanerFilesystem {
  return {
    exists: overrides.exists ?? ((target) => base.exists(target)),
    lstat: overrides.lstat ?? ((target) => base.lstat(target)),
    readDirectory:
      overrides.readDirectory ?? ((target) => base.readDirectory(target)),
    realPath: overrides.realPath ?? ((target) => base.realPath(target)),
    unlink: overrides.unlink ?? ((target) => base.unlink(target)),
    removeReparsePoint:
      overrides.removeReparsePoint ??
      ((target) => base.removeReparsePoint(target)),
    removeDirectory:
      overrides.removeDirectory ?? ((target) => base.removeDirectory(target)),
    getSizeOverride:
      overrides.getSizeOverride ?? ((target) => base.getSizeOverride(target)),
    getAccountingOverride:
      overrides.getAccountingOverride ??
      (async (target) => base.getAccountingOverride?.(target)),
    getAllocationUnit:
      overrides.getAllocationUnit ??
      (async (target) => base.getAllocationUnit?.(target)),
  };
}
