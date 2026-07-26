import type {
  CleanerAccountingConfidence,
  CleanerCleanupAttemptStatus,
  CleanerCleanupFailureCategory,
  CleanerCleanupReceipt,
  CleanerCleanupReceiptFinding,
  CleanerCleanupReceiptStatus,
  CleanerItemHistory,
  CleanerMeasurementCompleteness,
  CleanerStoreSchema,
} from "./types";
import { MAX_CLEANER_EVENTS, pruneCleanerHistory } from "./history";
import { MAX_CLEANER_RECEIPTS } from "./cleanup-receipts";
import { pruneCleanerApplicationObservations } from "./applications/observation-store";

export function migrateCleanerStore(input: unknown): CleanerStoreSchema {
  const source = asRecord(input);
  const migrationNotices = stringArray(source["migrationNotices"], 20, 256);
  const sourceVersion = finiteNumber(source["schemaVersion"]);
  if (sourceVersion !== 3) {
    migrationNotices.unshift(
      sourceVersion === 2
        ? "Cleaner storage was upgraded to durable cleanup receipts. Legacy aggregate cleanup events were retained but cannot prove individual file deletion."
        : "Cleaner storage was upgraded. Broad legacy detector exclusions remain narrow and do not automatically apply to newly split child detectors.",
    );
  }

  const rawReceipts = Array.isArray(source["cleanupReceipts"])
    ? source["cleanupReceipts"]
    : [];
  const cleanupReceipts = rawReceipts
    .map(sanitizeCleanupReceipt)
    .filter((receipt): receipt is CleanerCleanupReceipt => receipt !== null)
    .slice(0, MAX_CLEANER_RECEIPTS);
  const droppedReceiptCount = rawReceipts.length - cleanupReceipts.length;
  if (droppedReceiptCount > 0) {
    migrationNotices.unshift(
      `${droppedReceiptCount} invalid cleanup receipt record(s) were excluded from active history. The pre-migration audit backup remains recoverable.`,
    );
  }

  const next: CleanerStoreSchema = {
    schemaVersion: 3,
    exclusions: sanitizeExclusions(source["exclusions"]),
    itemHistory: sanitizeItemHistory(source["itemHistory"]),
    cleanupEvents: sanitizeLegacyCleanupEvents(source["cleanupEvents"]),
    cleanupReceipts,
    applicationObservations: sanitizeApplicationObservations(
      source["applicationObservations"],
    ),
    migrationNotices: [...new Set(migrationNotices)].slice(0, 20),
    preferences: sanitizePreferences(source["preferences"]),
  };
  pruneCleanerHistory(next);
  pruneCleanerApplicationObservations(next, Date.now());
  return next;
}

function sanitizeCleanupReceipt(input: unknown): CleanerCleanupReceipt | null {
  const source = asRecord(input);
  const cleanupRequestId = boundedString(source["cleanupRequestId"], 64);
  const scanSessionId = boundedString(source["scanSessionId"], 64);
  const status = enumValue<CleanerCleanupReceiptStatus>(source["status"], [
    "in-progress",
    "completed",
    "partial",
    "failed",
    "interrupted",
  ]);
  const requestedConfirmation = enumValue(source["requestedConfirmation"], [
    "safe",
    "conditional",
  ] as const);
  const createdAt = finiteNumber(source["createdAt"]);
  if (
    source["schemaVersion"] !== 1 ||
    !cleanupRequestId ||
    !scanSessionId ||
    !status ||
    !requestedConfirmation ||
    createdAt === undefined
  ) {
    return null;
  }
  const rawFindings = Array.isArray(source["findings"])
    ? source["findings"]
    : [];
  const findings = rawFindings
    .map(sanitizeReceiptFinding)
    .filter(
      (finding): finding is CleanerCleanupReceiptFinding => finding !== null,
    )
    .slice(0, 200);
  if (findings.length !== rawFindings.length) return null;

  return {
    schemaVersion: 1,
    cleanupRequestId,
    scanSessionId,
    requestedConfirmation,
    createdAt,
    startedAt: finiteNumber(source["startedAt"]),
    completedAt: finiteNumber(source["completedAt"]),
    status,
    selectedFindingIds: stringArray(source["selectedFindingIds"], 200, 64),
    resolvedFindingIds: stringArray(source["resolvedFindingIds"], 200, 64),
    freeSpaceBefore: sanitizeDriveMeasurement(source["freeSpaceBefore"]),
    freeSpaceAfter: sanitizeDriveMeasurement(source["freeSpaceAfter"]),
    signedFreeSpaceDeltaBytes: finiteNumber(
      source["signedFreeSpaceDeltaBytes"],
      true,
    ),
    aggregateLogicalBytesAddressed: nonNegativeNumber(
      source["aggregateLogicalBytesAddressed"],
    ),
    aggregateEstimatedPhysicalBytesReclaimable: nullableNonNegativeNumber(
      source["aggregateEstimatedPhysicalBytesReclaimable"],
    ),
    aggregateLogicalBytesRemoved: nonNegativeNumber(
      source["aggregateLogicalBytesRemoved"],
    ),
    aggregateRemainingLogicalBytes: nonNegativeNumber(
      source["aggregateRemainingLogicalBytes"],
    ),
    aggregateFilesUnlinked: nonNegativeNumber(source["aggregateFilesUnlinked"]),
    aggregateDirectoriesRemoved: nonNegativeNumber(
      source["aggregateDirectoriesRemoved"],
    ),
    aggregateReparseObjectsRemoved: nonNegativeNumber(
      source["aggregateReparseObjectsRemoved"],
    ),
    aggregateSkippedEntries: nonNegativeNumber(
      source["aggregateSkippedEntries"],
    ),
    aggregateFailedEntries: nonNegativeNumber(source["aggregateFailedEntries"]),
    postCleanupVerificationCompleted:
      source["postCleanupVerificationCompleted"] === true,
    interruptionReason: boundedString(source["interruptionReason"], 256),
    findings,
  };
}

function sanitizeReceiptFinding(
  input: unknown,
): CleanerCleanupReceiptFinding | null {
  const source = asRecord(input);
  const findingId = boundedString(source["findingId"], 64);
  const displayName = boundedString(source["displayName"], 256);
  const detectorId = boundedString(source["detectorId"], 128);
  const category = boundedString(source["category"], 128);
  const dataRootId = boundedString(source["dataRootId"], 128);
  const normalizedPath = boundedString(source["normalizedPath"], 2048);
  const attemptStatus = enumValue<CleanerCleanupAttemptStatus>(
    source["attemptStatus"],
    ["not-attempted", "deleted", "partial", "skipped", "failed"],
  );
  const preCompleteness = measurementCompleteness(
    source["preCleanupMeasurementCompleteness"],
  );
  const postCompleteness = measurementCompleteness(
    source["postCleanupMeasurementCompleteness"],
  );
  const preConfidence = accountingConfidence(
    source["preCleanupAccountingConfidence"],
  );
  if (
    !findingId ||
    !displayName ||
    !detectorId ||
    !category ||
    !dataRootId ||
    !normalizedPath ||
    !attemptStatus ||
    !preCompleteness ||
    !postCompleteness ||
    !preConfidence
  ) {
    return null;
  }

  const failureCategories = stringArray(
    source["failureCategories"],
    8,
    64,
  ).filter((value): value is CleanerCleanupFailureCategory =>
    CLEANUP_FAILURE_CATEGORIES.includes(value as CleanerCleanupFailureCategory),
  );
  return {
    findingId,
    displayName,
    detectorId,
    category,
    applicationId: boundedString(source["applicationId"], 128),
    dataRootId,
    normalizedPath,
    definitionVersion: nonNegativeNumber(source["definitionVersion"]),
    preCleanupFingerprint: sanitizeFingerprint(source["preCleanupFingerprint"]),
    preCleanupSafety:
      enumValue(source["preCleanupSafety"], [
        "safe-now",
        "safe-after-close",
        "conditional",
        "protected",
        "manual-review",
      ] as const) ?? "manual-review",
    preCleanupLogicalBytes: nonNegativeNumber(source["preCleanupLogicalBytes"]),
    preCleanupAllocatedBytes: nullableNonNegativeNumber(
      source["preCleanupAllocatedBytes"],
    ),
    preCleanupEstimatedReclaimableBytes: nullableNonNegativeNumber(
      source["preCleanupEstimatedReclaimableBytes"],
    ),
    preCleanupMeasurementCompleteness: preCompleteness,
    preCleanupAccountingConfidence: preConfidence,
    attemptStatus,
    filesAttempted: nonNegativeNumber(source["filesAttempted"]),
    filesSuccessfullyUnlinked: nonNegativeNumber(
      source["filesSuccessfullyUnlinked"],
    ),
    directoriesAttempted: nonNegativeNumber(source["directoriesAttempted"]),
    directoriesSuccessfullyRemoved: nonNegativeNumber(
      source["directoriesSuccessfullyRemoved"],
    ),
    reparseObjectsSuccessfullyRemoved: nonNegativeNumber(
      source["reparseObjectsSuccessfullyRemoved"],
    ),
    skippedEntryCount: nonNegativeNumber(source["skippedEntryCount"]),
    failedEntryCount: nonNegativeNumber(source["failedEntryCount"]),
    logicalBytesRemoved: nonNegativeNumber(source["logicalBytesRemoved"]),
    estimatedAllocatedBytesAddressed: nullableNonNegativeNumber(
      source["estimatedAllocatedBytesAddressed"],
    ),
    postCleanupRootExists:
      typeof source["postCleanupRootExists"] === "boolean"
        ? source["postCleanupRootExists"]
        : null,
    postCleanupLogicalBytes: nullableNonNegativeNumber(
      source["postCleanupLogicalBytes"],
    ),
    postCleanupAllocatedBytes: nullableNonNegativeNumber(
      source["postCleanupAllocatedBytes"],
    ),
    postCleanupEstimatedReclaimableBytes: nullableNonNegativeNumber(
      source["postCleanupEstimatedReclaimableBytes"],
    ),
    postCleanupMeasurementCompleteness: postCompleteness,
    postCleanupFingerprint: source["postCleanupFingerprint"]
      ? sanitizeFingerprint(source["postCleanupFingerprint"])
      : undefined,
    stateChangeReason: boundedString(source["stateChangeReason"], 256),
    failureCategories,
    postCleanupVerificationAt: finiteNumber(
      source["postCleanupVerificationAt"],
    ),
    verificationCompleted: source["verificationCompleted"] === true,
    message:
      boundedString(source["message"], 512) ??
      "Cleanup result message was unavailable.",
  };
}

function sanitizeItemHistory(
  input: unknown,
): Record<string, CleanerItemHistory> {
  const source = asRecord(input);
  const result: Record<string, CleanerItemHistory> = {};
  for (const [rawKey, value] of Object.entries(source).slice(0, 500)) {
    const item = asRecord(value);
    const key = boundedString(item["key"], 64) ?? boundedString(rawKey, 64);
    const detectorId = boundedString(item["detectorId"], 128);
    const normalizedPath = boundedString(item["normalizedPath"], 2048);
    const applicationName = boundedString(item["applicationName"], 256);
    if (!key || !detectorId || !normalizedPath || !applicationName) continue;
    result[key] = {
      key,
      detectorId,
      findingId: boundedString(item["findingId"], 64),
      category: boundedString(item["category"], 128),
      applicationId: boundedString(item["applicationId"], 128),
      dataRootId: boundedString(item["dataRootId"], 128),
      normalizedPath,
      applicationName,
      lastCleanedAt: finiteNumber(item["lastCleanedAt"]),
      lastCleanedSizeBytes: finiteNumber(item["lastCleanedSizeBytes"]),
      successfulCleanups: nonNegativeNumber(item["successfulCleanups"]),
      firstReappearedAt: finiteNumber(item["firstReappearedAt"]),
      mostRecentReappearedAt: finiteNumber(item["mostRecentReappearedAt"]),
      observedRegenerations: nonNegativeNumber(item["observedRegenerations"]),
      currentObservedSizeBytes: nonNegativeNumber(
        item["currentObservedSizeBytes"],
      ),
      typicalRegenerationSizeBytes: finiteNumber(
        item["typicalRegenerationSizeBytes"],
      ),
      approximateRegenerationMs: finiteNumber(
        item["approximateRegenerationMs"],
      ),
      lastCleanupResult: enumValue(item["lastCleanupResult"], [
        "success",
        "partial",
        "failed",
        "skipped",
      ] as const),
      lastVerifiedCleanupRequestId: boundedString(
        item["lastVerifiedCleanupRequestId"],
        64,
      ),
      verifiedPostCleanupBaselineLogicalBytes: finiteNumber(
        item["verifiedPostCleanupBaselineLogicalBytes"],
      ),
      verifiedPostCleanupBaselineAt: finiteNumber(
        item["verifiedPostCleanupBaselineAt"],
      ),
      regenerationBaselineComplete:
        item["regenerationBaselineComplete"] === true,
      lastInterruptedCleanupAt: finiteNumber(item["lastInterruptedCleanupAt"]),
      lastObservedAt: finiteNumber(item["lastObservedAt"]),
      lastRegenerationCleanupAt: finiteNumber(
        item["lastRegenerationCleanupAt"],
      ),
      excluded: item["excluded"] === true,
      repeatedlyRegenerated: item["repeatedlyRegenerated"] === true,
    };
  }
  return result;
}

function sanitizeLegacyCleanupEvents(
  input: unknown,
): CleanerStoreSchema["cleanupEvents"] {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => {
      const item = asRecord(value);
      const id = boundedString(item["id"], 64);
      const detectorId = boundedString(item["detectorId"], 128);
      const normalizedPath = boundedString(item["normalizedPath"], 2048);
      const applicationName = boundedString(item["applicationName"], 256);
      const result = enumValue(item["result"], [
        "success",
        "partial",
        "failed",
        "skipped",
      ] as const);
      if (
        !id ||
        !detectorId ||
        !normalizedPath ||
        !applicationName ||
        !result
      ) {
        return null;
      }
      return {
        id,
        detectorId,
        normalizedPath,
        applicationName,
        cleanedAt: nonNegativeNumber(item["cleanedAt"]),
        sizeBeforeBytes: nonNegativeNumber(item["sizeBeforeBytes"]),
        logicalBytesDeleted: nonNegativeNumber(item["logicalBytesDeleted"]),
        remainingBytes: nonNegativeNumber(item["remainingBytes"]),
        result,
      };
    })
    .filter(
      (event): event is CleanerStoreSchema["cleanupEvents"][number] =>
        event !== null,
    )
    .slice(0, MAX_CLEANER_EVENTS);
}

function sanitizeExclusions(input: unknown): CleanerStoreSchema["exclusions"] {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => {
      const item = asRecord(value);
      const id = boundedString(item["id"], 64);
      const scope = enumValue(item["scope"], [
        "category",
        "detector",
        "application",
        "root",
        "path",
        "finding",
      ] as const);
      const exclusionValue = boundedString(item["value"], 2048);
      const label = boundedString(item["label"], 256);
      if (!id || !scope || !exclusionValue || !label) return null;
      return {
        id,
        scope,
        value: exclusionValue,
        label,
        createdAt: nonNegativeNumber(item["createdAt"]),
      };
    })
    .filter(
      (exclusion): exclusion is CleanerStoreSchema["exclusions"][number] =>
        exclusion !== null,
    )
    .slice(0, 500);
}

function sanitizeApplicationObservations(
  input: unknown,
): CleanerStoreSchema["applicationObservations"] {
  const source = asRecord(input);
  const result: CleanerStoreSchema["applicationObservations"] = {};
  for (const [applicationId, value] of Object.entries(source).slice(0, 200)) {
    const item = asRecord(value);
    const boundedApplicationId = boundedString(applicationId, 128);
    const installState = enumValue(item["lastInstallState"], [
      "confirmed-installed",
      "probably-installed",
      "portable-detected",
      "ambiguous",
      "probably-uninstalled",
      "confirmed-uninstalled",
      "shared-component",
      "unknown",
    ] as const);
    if (!boundedApplicationId || !installState) continue;
    result[boundedApplicationId] = {
      applicationId: boundedApplicationId,
      definitionVersion: nonNegativeNumber(item["definitionVersion"]),
      firstSeenInstalledAt: finiteNumber(item["firstSeenInstalledAt"]),
      lastSeenInstalledAt: finiteNumber(item["lastSeenInstalledAt"]),
      lastNegativeAuditAt: finiteNumber(item["lastNegativeAuditAt"]),
      lastInstallState: installState,
      lastEvidenceTypes: stringArray(item["lastEvidenceTypes"], 16, 64),
      lastKnownVersion: boundedString(item["lastKnownVersion"], 128),
      lastKnownPublisher: boundedString(item["lastKnownPublisher"], 256),
      lastKnownRootIds: stringArray(item["lastKnownRootIds"], 32, 128),
      portableExecutablePaths: stringArray(
        item["portableExecutablePaths"],
        8,
        2048,
      ),
      updatedAt: nonNegativeNumber(item["updatedAt"]),
    };
  }
  return result;
}

function sanitizePreferences(
  input: unknown,
): CleanerStoreSchema["preferences"] {
  const source = asRecord(input);
  return {
    defaultScanMode: source["defaultScanMode"] === "deep" ? "deep" : "standard",
    showExcluded: source["showExcluded"] === true,
  };
}

function sanitizeDriveMeasurement(input: unknown) {
  const source = asRecord(input);
  const driveIdentity = boundedString(source["driveIdentity"], 64);
  const freeBytes = finiteNumber(source["freeBytes"]);
  const measuredAt = finiteNumber(source["measuredAt"]);
  if (!driveIdentity || freeBytes === undefined || measuredAt === undefined) {
    return undefined;
  }
  return {
    driveIdentity,
    freeBytes: Math.max(0, freeBytes),
    measuredAt: Math.max(0, measuredAt),
  };
}

function sanitizeFingerprint(input: unknown) {
  const source = asRecord(input);
  return {
    kind:
      source["kind"] === "file" ? ("file" as const) : ("directory" as const),
    device: finiteNumber(source["device"]),
    inode: finiteNumber(source["inode"]),
    modifiedMs: finiteNumber(source["modifiedMs"]),
    reparsePoint: source["reparsePoint"] === true,
  };
}

function measurementCompleteness(
  input: unknown,
): CleanerMeasurementCompleteness | undefined {
  return enumValue<CleanerMeasurementCompleteness>(input, [
    "complete",
    "partial",
    "unavailable",
  ]);
}

function accountingConfidence(
  input: unknown,
): CleanerAccountingConfidence | undefined {
  return enumValue<CleanerAccountingConfidence>(input, [
    "exact",
    "estimated",
    "lower-bound",
    "unknown",
  ]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maxLength)
    : undefined;
}

function stringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, maxLength))
        .slice(0, maxItems)
    : [];
}

function finiteNumber(value: unknown, signed = false): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    (signed || value >= 0)
    ? Math.trunc(value)
    : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, finiteNumber(value) ?? 0);
}

function nullableNonNegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = finiteNumber(value);
  return number === undefined ? null : Math.max(0, number);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

const CLEANUP_FAILURE_CATEGORIES: CleanerCleanupFailureCategory[] = [
  "access-denied",
  "locked",
  "not-empty",
  "path-validation",
  "state-changed",
  "process-running",
  "excluded",
  "measurement-incomplete",
  "verification-failed",
  "reparse-removal-failed",
  "filesystem-error",
  "overlap-resolved",
];
