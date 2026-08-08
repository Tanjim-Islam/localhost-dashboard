import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createCleanerExclusion,
  isFindingExcluded,
} from "../src/main/cleaner/exclusions";
import {
  getRegenerationStatus,
  MAX_CLEANER_EVENTS,
  observeCleanerFinding,
  recordCleanerCleanup,
} from "../src/main/cleaner/history";
import { scoreCleanerFinding } from "../src/main/cleaner/scoring";
import { calculateUnionRecoverableBytes } from "../src/main/cleaner/scanner";
import { resolveOverlappingSelectedFindings } from "../src/main/cleaner/cleanup-executor";
import {
  validateCleanerCleanupRequestId,
  validateCleanerPreferences,
  validateCleanCleanerFindingsInput,
  validatePrepareCleanerCleanupInput,
  validateStartCleanerScanInput,
  validateUpdateCleanerExclusionsInput,
} from "../src/main/cleaner/ipc-validation";
import { createEmptyCleanerState } from "./cleaner-test-helpers";
import type { CleanerFinding } from "../src/main/cleaner/types";

const finding = (overrides: Partial<CleanerFinding> = {}): CleanerFinding => ({
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  detectorId: "dev.npm-cache",
  category: "Node.js and JavaScript",
  displayName: "npm content cache",
  applicationName: "npm",
  applicationInstallState: "unknown",
  applicationRunningState: "not-running-observed",
  dataKind: "ordinary-cache",
  ownershipStatus: "exclusive",
  ownershipConfidence: "high",
  ownerApplicationIds: [],
  sharedOwnership: false,
  leftoverCacheStatus: "not-leftover",
  evidenceConfidence: "high",
  strongEvidence: [],
  supportingEvidence: ["Exact built-in npm cache definition."],
  staleEvidence: [],
  unavailableEvidenceSources: [],
  mixedDataWarnings: [],
  statusExplanation: "Exact ordinary cache.",
  definitionVersion: 2,
  dataRootId: "npm-content-cache",
  exactDataRoot: true,
  path: "C:\\Users\\Fixture\\AppData\\Local\\npm-cache\\_cacache",
  normalizedPath: "c:\\users\\fixture\\appdata\\local\\npm-cache\\_cacache",
  accounting: {
    logicalBytes: 1_000_000_000,
    allocatedBytes: 1_000_001_024,
    uniqueAllocatedBytes: 1_000_001_024,
    estimatedReclaimableBytes: 1_000_001_024,
    reclaimableLowerBoundBytes: 1_000_001_024,
    reclaimableUpperBoundBytes: 1_000_001_024,
    measurementCompleteness: "complete",
    accountingConfidence: "estimated",
    hardlinkRecordCount: 0,
    externalHardlinkRecordCount: 0,
    sparseFileCount: 0,
    compressedFileCount: 0,
    measuredFileCount: 2,
    measuredDirectoryCount: 1,
    inaccessibleEntryCount: 0,
    inspectedEntryCount: 3,
    measurementStartedAt: 1,
    measurementCompletedAt: 2,
    measurementDurationMs: 1,
    logicalTraversalComplete: true,
    physicalAccountingComplete: true,
  },
  logicalBytes: 1_000_000_000,
  allocatedBytes: 1_000_001_024,
  uniqueAllocatedBytes: 1_000_001_024,
  estimatedReclaimableBytes: 1_000_001_024,
  reclaimableLowerBoundBytes: 1_000_001_024,
  reclaimableUpperBoundBytes: 1_000_001_024,
  measurementCompleteness: "complete",
  accountingConfidence: "estimated",
  hardlinkRecordCount: 0,
  externalHardlinkRecordCount: 0,
  sparseFileCount: 0,
  compressedFileCount: 0,
  measuredFileCount: 2,
  measuredDirectoryCount: 1,
  measurementStartedAt: 1,
  measurementCompletedAt: 2,
  measurementDurationMs: 1,
  logicalTraversalComplete: true,
  physicalAccountingComplete: true,
  accountingActionabilityBlocked: false,
  sizeBytes: 1_000_000_000,
  recoverableBytes: 1_000_000_000,
  fileCount: 2,
  sizeMeasurementComplete: true,
  sizeMeasurementWarnings: [],
  safety: "safe-now",
  reason: "Exact recognized cache.",
  consequences: ["Packages download again."],
  restoration: "npm restores it.",
  relatedProcesses: [],
  relatedProcessNames: ["node", "npm"],
  processMatchRules: [],
  excluded: false,
  selected: false,
  canDelete: true,
  manualApprovalAllowed: false,
  requiresExplicitConfirmation: false,
  reparsePointStatus: "clear",
  recommendation: "recommended",
  recommendationReason: "Large cache.",
  cleanupValueScore: 80,
  regeneration: {
    label: "not-cleaned-before",
    summary: "Not cleaned before.",
    observedRegenerations: 0,
  },
  fingerprint: { kind: "directory", reparsePoint: false },
  ...overrides,
});

test("Cleaner IPC validation rejects arbitrary paths, extra fields, duplicates, and invalid confirmation", () => {
  assert.equal(
    validateCleanerCleanupRequestId("12345678-1234-1234-1234-123456789abc"),
    "12345678-1234-1234-1234-123456789abc",
  );
  assert.throws(() => validateCleanerCleanupRequestId("C:\\Users\\private"));
  assert.deepEqual(validateStartCleanerScanInput({ mode: "deep" }), {
    mode: "deep",
  });
  assert.throws(() => validateStartCleanerScanInput({ mode: "full" }));
  assert.throws(() =>
    validateStartCleanerScanInput({ mode: "standard", path: "C:\\" }),
  );
  assert.deepEqual(
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      confirmation: "safe",
    }).findingIds,
    ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  );
  assert.deepEqual(
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      confirmation: "safe",
      approvedInUseFindingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }).approvedInUseFindingIds,
    ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  );
  assert.deepEqual(
    validatePrepareCleanerCleanupInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }),
    {
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    },
  );
  assert.throws(() =>
    validatePrepareCleanerCleanupInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      path: "C:\\Users",
    }),
  );
  assert.deepEqual(
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      confirmation: "manual-review",
      approvedManualReviewFindingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }).approvedManualReviewFindingIds,
    ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  );
  assert.throws(() =>
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      confirmation: "safe",
      path: "C:\\Users",
    }),
  );
  assert.throws(() =>
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      confirmation: "safe",
    }),
  );
  assert.throws(() =>
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      confirmation: "everything",
    }),
  );
  assert.throws(() =>
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      confirmation: "manual-review",
      approvedManualReviewFindingIds: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    }),
  );
  assert.throws(() =>
    validateCleanCleanerFindingsInput({
      scanSessionId: "12345678-1234-1234-1234-123456789abc",
      findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      confirmation: "safe",
      approvedManualReviewFindingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }),
  );
});

test("Cleaner exclusion validation supports stable scopes and rejects raw extra data", () => {
  assert.equal(
    validateUpdateCleanerExclusionsInput({
      action: "add",
      exclusion: {
        scope: "detector",
        value: "dev.npm-cache",
        label: "npm",
      },
    }).action,
    "add",
  );
  assert.throws(() =>
    validateUpdateCleanerExclusionsInput({
      action: "add",
      exclusion: { scope: "directory", value: "C:\\", label: "unsafe" },
    }),
  );
  assert.throws(() =>
    validateUpdateCleanerExclusionsInput({
      action: "remove",
      exclusionId: "1234567890abcdef12345678",
      path: "C:\\",
    }),
  );
  assert.deepEqual(
    validateCleanerPreferences({
      defaultScanMode: "standard",
      showExcluded: true,
    }),
    { defaultScanMode: "standard", showExcluded: true },
  );
});

test("category, detector, application, path, and finding exclusions match exactly", () => {
  const item = finding();
  for (const [scope, value] of [
    ["category", item.category],
    ["detector", item.detectorId],
    ["application", item.applicationName!],
    ["path", item.path],
    ["finding", item.id],
  ] as const) {
    const exclusion = createCleanerExclusion(
      { scope, value, label: `${scope} exclusion` },
      100,
    );
    assert.equal(isFindingExcluded(item, [exclusion]), true, scope);
  }
  const unrelated = createCleanerExclusion(
    { scope: "detector", value: "dev.npm-cache-copy", label: "unrelated" },
    100,
  );
  assert.equal(isFindingExcluded(item, [unrelated]), false);
});

test("history records first cleanup, regeneration timing, repeated regeneration, and bounded events", () => {
  const state = createEmptyCleanerState();
  const item = finding();
  observeCleanerFinding(state, item, 1_000);
  recordCleanerCleanup(state, {
    finding: item,
    cleanedAt: 2_000,
    logicalBytesDeleted: item.sizeBytes,
    remainingBytes: 0,
    result: "success",
  });
  let history = observeCleanerFinding(state, item, 3_000);
  assert.equal(history.observedRegenerations, 1);
  assert.equal(history.approximateRegenerationMs, 1_000);
  assert.equal(getRegenerationStatus(history).label, "regenerated-quickly");

  recordCleanerCleanup(state, {
    finding: item,
    cleanedAt: 4_000,
    logicalBytesDeleted: item.sizeBytes,
    remainingBytes: 0,
    result: "success",
  });
  history = observeCleanerFinding(state, item, 5_000);
  assert.equal(history.observedRegenerations, 2);
  assert.equal(getRegenerationStatus(history).label, "frequently-regenerates");

  for (let index = 0; index < MAX_CLEANER_EVENTS + 20; index += 1) {
    recordCleanerCleanup(state, {
      finding: item,
      cleanedAt: 10_000 + index,
      logicalBytesDeleted: 1,
      remainingBytes: 0,
      result: "success",
    });
  }
  assert.equal(state.cleanupEvents.length, MAX_CLEANER_EVENTS);
  assert.equal(
    JSON.stringify(state).includes("fixture.bin"),
    false,
    "history never stores scanned filenames or deleted contents",
  );
});

test("cleanup-value scoring is transparent and never overrides safety", () => {
  const recommended = scoreCleanerFinding({
    safety: "safe-now",
    sizeBytes: 12 * 1024 ** 3,
    freeDiskSpaceBytes: 10 * 1024 ** 3,
    consequences: ["Packages download again."],
  });
  assert.equal(recommended.recommendation, "recommended");
  assert.ok(recommended.score >= 70);
  const frequent = scoreCleanerFinding({
    safety: "safe-now",
    sizeBytes: 5 * 1024 ** 3,
    freeDiskSpaceBytes: 100 * 1024 ** 3,
    consequences: [],
    history: {
      key: "k",
      detectorId: "dev.npm-cache",
      normalizedPath: "c:\\cache",
      applicationName: "npm",
      successfulCleanups: 2,
      observedRegenerations: 3,
      currentObservedSizeBytes: 5 * 1024 ** 3,
      regenerationBaselineComplete: true,
      excluded: false,
      repeatedlyRegenerated: true,
    },
  });
  assert.equal(frequent.recommendation, "frequently-regenerated");
  assert.equal(
    scoreCleanerFinding({
      safety: "protected",
      sizeBytes: 100 * 1024 ** 3,
      freeDiskSpaceBytes: 1,
      consequences: [],
    }).recommendation,
    "protected",
  );
});

test("recoverable totals do not double-count nested findings", () => {
  const parent = finding({
    id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    path: "C:\\cache",
    normalizedPath: "c:\\cache",
    recoverableBytes: 1_000,
  });
  const child = finding({
    id: "cccccccccccccccccccccccccccccccc",
    path: "C:\\cache\\nested",
    normalizedPath: "c:\\cache\\nested",
    recoverableBytes: 700,
  });
  const separate = finding({
    id: "dddddddddddddddddddddddddddddddd",
    path: "C:\\other-cache",
    normalizedPath: "c:\\other-cache",
    recoverableBytes: 500,
  });
  const conditional = finding({
    id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    path: "C:\\conditional-cache",
    normalizedPath: "c:\\conditional-cache",
    safety: "conditional",
    recoverableBytes: 900,
  });
  assert.equal(
    calculateUnionRecoverableBytes([child, separate, parent, conditional]),
    2_400,
  );
  assert.equal(
    calculateUnionRecoverableBytes(
      [child, separate, parent, conditional],
      "safe-now",
    ),
    1_500,
  );
  assert.equal(
    calculateUnionRecoverableBytes(
      [child, separate, parent, conditional],
      "conditional",
    ),
    900,
  );
});

test("main cleanup overlap resolution keeps only the authoritative ancestor", () => {
  const parent = finding({
    id: "parent",
    path: "C:\\cache",
    normalizedPath: "c:\\cache",
  });
  const child = finding({
    id: "child",
    path: "C:\\cache\\nested",
    normalizedPath: "c:\\cache\\nested",
  });
  const resolved = resolveOverlappingSelectedFindings([child, parent]);
  assert.deepEqual(
    resolved.resolved.map((item) => item.id),
    ["parent"],
  );
  assert.deepEqual([...resolved.overlapSkippedIds], ["child"]);
});

test("persisted Cleaner state contains preferences and metadata, never scan results", () => {
  const state = createEmptyCleanerState();
  const serialized = JSON.stringify(state);
  assert.equal(Object.hasOwn(state, "findings"), false);
  assert.equal(Object.hasOwn(state, "scanResult"), false);
  assert.equal(serialized.includes("normalizedPath"), false);
});
