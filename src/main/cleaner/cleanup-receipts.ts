import type {
  CleanerCleanupReceipt,
  CleanerCleanupReceiptFinding,
  CleanerScanMode,
  CleanerStoreSchema,
} from "./types";
import { cleanerHistoryKey, pruneCleanerHistory } from "./history";

export const MAX_CLEANER_RECEIPTS = 100;
export const MAX_CLEANER_HISTORY_ENTRIES = 100;

export function upsertCleanerCleanupReceipt(
  state: CleanerStoreSchema,
  receipt: CleanerCleanupReceipt,
): void {
  state.cleanupReceipts = [
    structuredClone(receipt),
    ...state.cleanupReceipts.filter(
      (existing) => existing.cleanupRequestId !== receipt.cleanupRequestId,
    ),
  ].slice(0, MAX_CLEANER_RECEIPTS);
}

export function recoverInterruptedCleanupReceipts(
  state: CleanerStoreSchema,
  now: number,
  reason = "The app exited before this cleanup receipt was finalized.",
): boolean {
  let changed = false;
  for (const receipt of state.cleanupReceipts) {
    if (receipt.status !== "in-progress") continue;
    receipt.status = "interrupted";
    receipt.completedAt = now;
    receipt.interruptionReason = reason;
    receipt.postCleanupVerificationCompleted = false;
    for (const finding of receipt.findings) {
      if (finding.attemptStatus === "deleted") {
        finding.attemptStatus = "partial";
      } else if (finding.attemptStatus === "not-attempted") {
        finding.attemptStatus = "skipped";
      }
      finding.verificationCompleted = false;
      finding.failureCategories = [
        ...new Set([
          ...finding.failureCategories,
          "verification-failed" as const,
        ]),
      ].slice(0, 8);
      finding.message =
        "Cleanup was interrupted before its result could be verified.";
      recordInterruptedFinding(state, finding, now);
    }
    changed = true;
  }
  return changed;
}

export function dismissCleanerCleanupReceipt(
  state: CleanerStoreSchema,
  cleanupRequestId: string,
  now: number,
): boolean {
  const receipt = state.cleanupReceipts.find(
    (item) => item.cleanupRequestId === cleanupRequestId,
  );
  if (
    !receipt ||
    receipt.status === "in-progress" ||
    receipt.dismissedAt !== undefined
  ) {
    return false;
  }
  receipt.dismissedAt = now;
  return true;
}

export function recordFinalizedCleanupReceipt(
  state: CleanerStoreSchema,
  receipt: CleanerCleanupReceipt,
  mode: CleanerScanMode,
): void {
  upsertCleanerCleanupReceipt(state, receipt);
  recordCompactCleanupHistory(state, receipt, mode);
  for (const finding of receipt.findings) {
    const key = cleanerHistoryKey(finding.detectorId, finding.normalizedPath);
    const history = state.itemHistory[key] ?? {
      key,
      detectorId: finding.detectorId,
      findingId: finding.findingId,
      category: finding.category,
      applicationId: finding.applicationId,
      dataRootId: finding.dataRootId,
      normalizedPath: finding.normalizedPath,
      applicationName: finding.displayName,
      successfulCleanups: 0,
      observedRegenerations: 0,
      currentObservedSizeBytes: finding.postCleanupLogicalBytes ?? 0,
      regenerationBaselineComplete: false,
      excluded: false,
      repeatedlyRegenerated: false,
    };

    history.findingId = finding.findingId;
    history.category = finding.category;
    history.applicationId = finding.applicationId;
    history.dataRootId = finding.dataRootId;
    history.currentObservedSizeBytes =
      finding.postCleanupLogicalBytes ?? finding.preCleanupLogicalBytes;
    history.lastCleanupResult = toHistoryResult(finding.attemptStatus);

    const fullyVerifiedDeletion =
      finding.attemptStatus === "deleted" &&
      finding.verificationCompleted &&
      finding.postCleanupRootExists === false &&
      finding.skippedEntryCount === 0 &&
      finding.failedEntryCount === 0;
    if (fullyVerifiedDeletion) {
      const verifiedAt =
        finding.postCleanupVerificationAt ??
        receipt.completedAt ??
        receipt.startedAt ??
        receipt.createdAt;
      history.lastCleanedAt = verifiedAt;
      history.lastCleanedSizeBytes = finding.preCleanupLogicalBytes;
      history.successfulCleanups += 1;
      history.lastVerifiedCleanupRequestId = receipt.cleanupRequestId;
      history.verifiedPostCleanupBaselineLogicalBytes =
        finding.postCleanupLogicalBytes ?? 0;
      history.verifiedPostCleanupBaselineAt = verifiedAt;
      history.regenerationBaselineComplete =
        finding.postCleanupMeasurementCompleteness === "complete";
      history.lastRegenerationCleanupAt = undefined;
    } else if (
      finding.attemptStatus === "partial" ||
      finding.attemptStatus === "failed" ||
      receipt.status === "interrupted"
    ) {
      history.regenerationBaselineComplete = false;
      history.lastRegenerationCleanupAt = history.lastCleanedAt;
    }
    if (receipt.status === "interrupted") {
      history.lastInterruptedCleanupAt =
        receipt.completedAt ?? receipt.startedAt ?? receipt.createdAt;
    }
    state.itemHistory[key] = history;
  }
  pruneCleanerHistory(state);
}

function recordCompactCleanupHistory(
  state: CleanerStoreSchema,
  receipt: CleanerCleanupReceipt,
  mode: CleanerScanMode,
): void {
  const deletedTargetNames = receipt.findings
    .filter(
      (finding) =>
        finding.attemptStatus === "deleted" &&
        finding.verificationCompleted &&
        finding.postCleanupRootExists === false &&
        finding.skippedEntryCount === 0 &&
        finding.failedEntryCount === 0,
    )
    .map((finding) => finding.displayName.trim().slice(0, 256))
    .filter(Boolean)
    .slice(0, 200);
  const entry = {
    id: receipt.cleanupRequestId,
    completedAt: receipt.completedAt ?? receipt.startedAt ?? receipt.createdAt,
    mode,
    freeSpaceBeforeBytes: receipt.freeSpaceBefore?.freeBytes ?? null,
    freeSpaceAfterBytes: receipt.freeSpaceAfter?.freeBytes ?? null,
    recoveredBytes: receipt.signedFreeSpaceDeltaBytes ?? null,
    deletedTargetNames,
  };
  state.cleanupHistory = [
    entry,
    ...state.cleanupHistory.filter((item) => item.id !== entry.id),
  ]
    .sort((left, right) => right.completedAt - left.completedAt)
    .slice(0, MAX_CLEANER_HISTORY_ENTRIES);
}

function recordInterruptedFinding(
  state: CleanerStoreSchema,
  finding: CleanerCleanupReceiptFinding,
  now: number,
): void {
  const key = cleanerHistoryKey(finding.detectorId, finding.normalizedPath);
  const history = state.itemHistory[key];
  if (!history) return;
  history.lastCleanupResult = "failed";
  history.lastInterruptedCleanupAt = now;
  history.regenerationBaselineComplete = false;
  history.lastRegenerationCleanupAt = history.lastCleanedAt;
}

function toHistoryResult(
  status: CleanerCleanupReceiptFinding["attemptStatus"],
): "success" | "partial" | "failed" | "skipped" {
  if (status === "deleted") return "success";
  if (status === "partial") return "partial";
  if (status === "skipped" || status === "not-attempted") return "skipped";
  return "failed";
}
