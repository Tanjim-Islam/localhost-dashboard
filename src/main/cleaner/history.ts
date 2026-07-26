import { createHash, randomUUID } from "node:crypto";
import type {
  CleanerCleanupEvent,
  CleanerCleanupHistoryResult,
  CleanerFinding,
  CleanerItemHistory,
  CleanerRegenerationStatus,
  CleanerStoreSchema,
} from "./types";

export const MAX_CLEANER_EVENTS = 200;
export const MAX_CLEANER_ITEMS = 500;

export function cleanerHistoryKey(
  detectorId: string,
  normalizedPath: string,
): string {
  return createHash("sha256")
    .update(`${detectorId}\0${normalizedPath}`)
    .digest("hex")
    .slice(0, 32);
}

export function observeCleanerFinding(
  state: CleanerStoreSchema,
  finding: Pick<
    CleanerFinding,
    | "detectorId"
    | "id"
    | "category"
    | "normalizedPath"
    | "applicationName"
    | "applicationId"
    | "dataRootId"
    | "sizeBytes"
    | "measurementCompleteness"
    | "excluded"
  >,
  now: number,
): CleanerItemHistory {
  const key = cleanerHistoryKey(finding.detectorId, finding.normalizedPath);
  const existing = state.itemHistory[key];
  const history: CleanerItemHistory = existing ?? {
    key,
    detectorId: finding.detectorId,
    findingId: finding.id,
    category: finding.category,
    applicationId: finding.applicationId,
    dataRootId: finding.dataRootId,
    normalizedPath: finding.normalizedPath,
    applicationName: finding.applicationName ?? finding.detectorId,
    successfulCleanups: 0,
    observedRegenerations: 0,
    currentObservedSizeBytes: finding.sizeBytes,
    regenerationBaselineComplete: false,
    excluded: finding.excluded,
    repeatedlyRegenerated: false,
  };

  if (
    history.lastCleanedAt !== undefined &&
    history.regenerationBaselineComplete &&
    finding.measurementCompleteness === "complete" &&
    finding.sizeBytes >
      (history.verifiedPostCleanupBaselineLogicalBytes ?? 0) &&
    history.lastRegenerationCleanupAt !== history.lastCleanedAt
  ) {
    const regenerationMs = Math.max(0, now - history.lastCleanedAt);
    history.firstReappearedAt ??= now;
    history.mostRecentReappearedAt = now;
    history.observedRegenerations += 1;
    history.approximateRegenerationMs = regenerationMs;
    history.typicalRegenerationSizeBytes = rollingAverage(
      history.typicalRegenerationSizeBytes,
      finding.sizeBytes,
      history.observedRegenerations,
    );
    history.lastRegenerationCleanupAt = history.lastCleanedAt;
  }

  history.currentObservedSizeBytes = finding.sizeBytes;
  history.findingId = finding.id;
  history.category = finding.category;
  history.applicationId = finding.applicationId;
  history.dataRootId = finding.dataRootId;
  history.lastObservedAt = now;
  history.excluded = finding.excluded;
  history.repeatedlyRegenerated = history.observedRegenerations >= 2;
  state.itemHistory[key] = history;
  pruneCleanerHistory(state);
  return history;
}

export function getRegenerationStatus(
  history: CleanerItemHistory | undefined,
): CleanerRegenerationStatus {
  if (
    !history?.lastCleanedAt &&
    history?.lastCleanupResult !== "partial" &&
    history?.lastCleanupResult !== "failed"
  ) {
    return {
      label: "not-cleaned-before",
      summary: "Not cleaned before.",
      observedRegenerations: 0,
    };
  }
  const base = {
    firstReappearedAt: history.firstReappearedAt,
    mostRecentReappearedAt: history.mostRecentReappearedAt,
    observedRegenerations: history.observedRegenerations,
    approximateRegenerationMs: history.approximateRegenerationMs,
    typicalSizeBytes: history.typicalRegenerationSizeBytes,
  };
  if (!history.regenerationBaselineComplete) {
    return {
      ...base,
      label: "regeneration-unknown",
      summary:
        "Regeneration is unknown because the latest cleanup did not establish a complete verified baseline.",
    };
  }
  if (history.observedRegenerations >= 2) {
    return {
      ...base,
      label: "frequently-regenerates",
      summary:
        "Frequently regenerated. Usually not worth cleaning unless you need space now.",
    };
  }
  if (
    history.observedRegenerations >= 1 &&
    (history.approximateRegenerationMs ?? Number.POSITIVE_INFINITY) <=
      24 * 60 * 60 * 1000
  ) {
    return {
      ...base,
      label: "regenerated-quickly",
      summary: "Regenerated quickly after the previous cleanup.",
    };
  }
  if (
    history.approximateRegenerationMs !== undefined &&
    history.approximateRegenerationMs >= 30 * 24 * 60 * 60 * 1000
  ) {
    return {
      ...base,
      label: "grows-slowly",
      summary: "Grows slowly and may only need occasional cleanup.",
    };
  }
  if (history.currentObservedSizeBytes < 100 * 1024 * 1024) {
    return {
      ...base,
      label: "low-cleanup-value",
      summary: "Low cleanup value at its current size.",
    };
  }
  return {
    ...base,
    label: "worth-cleaning-occasionally",
    summary: "Worth cleaning occasionally when you need disk space.",
  };
}

export function recordCleanerCleanup(
  state: CleanerStoreSchema,
  input: {
    finding: CleanerFinding;
    cleanedAt: number;
    logicalBytesDeleted: number;
    remainingBytes: number;
    result: CleanerCleanupHistoryResult;
  },
): void {
  const key = cleanerHistoryKey(
    input.finding.detectorId,
    input.finding.normalizedPath,
  );
  const history = state.itemHistory[key] ?? {
    key,
    detectorId: input.finding.detectorId,
    findingId: input.finding.id,
    category: input.finding.category,
    applicationId: input.finding.applicationId,
    dataRootId: input.finding.dataRootId,
    normalizedPath: input.finding.normalizedPath,
    applicationName: input.finding.applicationName ?? input.finding.detectorId,
    successfulCleanups: 0,
    observedRegenerations: 0,
    currentObservedSizeBytes: input.remainingBytes,
    regenerationBaselineComplete: false,
    excluded: input.finding.excluded,
    repeatedlyRegenerated: false,
  };
  history.lastCleanupResult = input.result;
  history.currentObservedSizeBytes = input.remainingBytes;
  if (input.result === "success" && input.remainingBytes === 0) {
    history.lastCleanedAt = input.cleanedAt;
    history.lastCleanedSizeBytes = input.finding.sizeBytes;
    history.successfulCleanups += 1;
    history.verifiedPostCleanupBaselineLogicalBytes = 0;
    history.verifiedPostCleanupBaselineAt = input.cleanedAt;
    history.regenerationBaselineComplete = true;
  }
  state.itemHistory[key] = history;

  const event: CleanerCleanupEvent = {
    id: randomUUID(),
    detectorId: input.finding.detectorId,
    normalizedPath: input.finding.normalizedPath,
    applicationName: input.finding.applicationName ?? input.finding.detectorId,
    cleanedAt: input.cleanedAt,
    sizeBeforeBytes: input.finding.sizeBytes,
    logicalBytesDeleted: input.logicalBytesDeleted,
    remainingBytes: input.remainingBytes,
    result: input.result,
  };
  state.cleanupEvents = [event, ...state.cleanupEvents].slice(
    0,
    MAX_CLEANER_EVENTS,
  );
  pruneCleanerHistory(state);
}

export function pruneCleanerHistory(state: CleanerStoreSchema): void {
  const entries = Object.entries(state.itemHistory);
  if (entries.length <= MAX_CLEANER_ITEMS) return;
  entries.sort(
    (left, right) =>
      (right[1].lastObservedAt ?? right[1].lastCleanedAt ?? 0) -
      (left[1].lastObservedAt ?? left[1].lastCleanedAt ?? 0),
  );
  state.itemHistory = Object.fromEntries(entries.slice(0, MAX_CLEANER_ITEMS));
}

function rollingAverage(
  previous: number | undefined,
  current: number,
  count: number,
): number {
  if (previous === undefined || count <= 1) return current;
  return Math.round((previous * (count - 1) + current) / count);
}
