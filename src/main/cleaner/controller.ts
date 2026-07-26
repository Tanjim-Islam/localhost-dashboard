import { EventEmitter } from "node:events";
import type {
  CleanCleanerFindingsInput,
  CleanerCleanupProgress,
  CleanerCleanupResult,
  CleanerEnvironment,
  CleanerExclusion,
  CleanerHistorySnapshot,
  CleanerPersistence,
  CleanerPreferences,
  CleanerScanProgress,
  CleanerScanResult,
  CleanerScanState,
  StartCleanerScanInput,
  UpdateCleanerExclusionsInput,
} from "./types";
import { CleanerScanSessionManager } from "./scan-session";
import { CleanerScanner } from "./scanner";
import {
  calculateNonExcludedSafetyBytes,
  calculateUnionLogicalBytes,
  calculateUnionRecoverableBytes,
} from "./scanner";
import { CleanerCleanupExecutor } from "./cleanup-executor";
import { CleanerCancelledError } from "./cancellation";
import {
  createCleanerExclusion,
  isFindingExcluded,
  synchronizeHistoryExclusions,
} from "./exclusions";

export type CleanerControllerEvents = {
  "scan-progress": [CleanerScanProgress];
  "scan-complete": [CleanerScanResult];
  "scan-error": [{ scanSessionId?: string; message: string }];
  "cleanup-progress": [CleanerCleanupProgress];
  "cleanup-complete": [CleanerCleanupResult];
  "history-update": [CleanerHistorySnapshot];
};

export class CleanerController extends EventEmitter<CleanerControllerEvents> {
  private lastTerminalState?: CleanerScanState;
  private cleanupActive = false;

  constructor(
    private readonly environment: CleanerEnvironment,
    private readonly testMode: boolean,
    private readonly persistence: CleanerPersistence,
    private readonly sessions: CleanerScanSessionManager,
    private readonly scanner: CleanerScanner,
    private readonly cleanupExecutor: CleanerCleanupExecutor,
    private readonly now: () => number,
  ) {
    super();
  }

  getState(): CleanerScanState {
    const active = this.sessions.getActive();
    if (!active)
      return (
        this.lastTerminalState ?? { status: "idle", testMode: this.testMode }
      );
    if (active.status === "scanning" && active.progress) {
      return {
        status: "scanning",
        testMode: this.testMode,
        progress: active.progress,
      };
    }
    if (active.status === "complete" && active.result) {
      active.result.summary.freeSpaceIsStale =
        this.now() - active.result.summary.freeDiskSpaceMeasuredAt >
        2 * 60 * 1000;
      return {
        status: "complete",
        testMode: this.testMode,
        result: active.result,
      };
    }
    if (active.status === "cancelled") {
      return {
        status: "cancelled",
        testMode: this.testMode,
        scanSessionId: active.id,
        message: "Cleaner scan was cancelled.",
      };
    }
    return { status: "idle", testMode: this.testMode };
  }

  startScan(input: StartCleanerScanInput): CleanerScanState {
    const active = this.sessions.getActive();
    if (active?.status === "scanning") {
      throw new Error("A Cleaner scan is already running.");
    }
    if (this.cleanupActive) {
      throw new Error("Cleaner cannot scan while cleanup is running.");
    }
    this.lastTerminalState = undefined;
    const session = this.sessions.create(input.mode, this.testMode);
    session.progress = {
      scanSessionId: session.id,
      mode: input.mode,
      stage: "preparing",
      currentCategory: "Windows environment",
      completedUnits: 0,
      totalUnits: 1,
      percent: 0,
      findingCount: 0,
      measuredSizeBytes: 0,
      startedAt: session.createdAt,
      elapsedMs: 0,
      progressKind: "stage",
      completedTargets: 0,
      totalTargets: 0,
      processedFiles: 0,
      processedDirectories: 0,
      uniqueFileRecords: 0,
      logicalBytesScanned: 0,
      workerActive: false,
    };

    void this.scanner
      .scan(session, this.environment, (progress) => {
        if (!session.cancellation.isCancelled)
          this.emit("scan-progress", progress);
      })
      .then((result) => {
        if (session.cancellation.isCancelled || session.status !== "complete")
          return;
        this.emit("scan-complete", result);
      })
      .catch((error: unknown) => {
        if (
          error instanceof CleanerCancelledError ||
          session.cancellation.isCancelled
        ) {
          session.status = "cancelled";
          this.lastTerminalState = {
            status: "cancelled",
            testMode: this.testMode,
            scanSessionId: session.id,
            message: "Cleaner scan was cancelled.",
          };
          return;
        }
        session.status = "invalidated";
        const message =
          error instanceof Error ? error.message : "Cleaner scan failed.";
        this.lastTerminalState = {
          status: "error",
          testMode: this.testMode,
          scanSessionId: session.id,
          message,
        };
        this.emit("scan-error", { scanSessionId: session.id, message });
      });
    return this.getState();
  }

  cancelScan(sessionId: string): CleanerScanState {
    if (!this.sessions.cancel(sessionId)) {
      throw new Error("Cleaner scan session cannot be cancelled.");
    }
    this.lastTerminalState = {
      status: "cancelled",
      testMode: this.testMode,
      scanSessionId: sessionId,
      message: "Cleaner scan was cancelled.",
    };
    return this.lastTerminalState;
  }

  async refreshFreeSpace(sessionId: string): Promise<CleanerScanResult> {
    const session = this.sessions.requireCompleted(sessionId);
    const result = await this.scanner.refreshFreeSpace(
      session,
      this.environment,
    );
    this.emit("scan-complete", result);
    return result;
  }

  async cleanFindings(
    input: CleanCleanerFindingsInput,
  ): Promise<CleanerCleanupResult> {
    if (this.cleanupActive)
      throw new Error("Cleaner cleanup is already running.");
    const session = this.sessions.requireCompleted(input.scanSessionId);
    this.cleanupActive = true;
    try {
      const result = await this.cleanupExecutor.clean(
        session,
        input,
        this.environment,
        (progress) => this.emit("cleanup-progress", progress),
      );
      this.lastTerminalState = { status: "idle", testMode: this.testMode };
      this.emit("cleanup-complete", result);
      this.emit("history-update", this.getHistory());
      return result;
    } finally {
      this.cleanupActive = false;
    }
  }

  getExclusions(): CleanerExclusion[] {
    return this.persistence.read().exclusions;
  }

  updateExclusions(input: UpdateCleanerExclusionsInput): CleanerExclusion[] {
    const state = this.persistence.read();
    if (input.action === "add") {
      const exclusion = createCleanerExclusion(input.exclusion, this.now());
      state.exclusions = [
        exclusion,
        ...state.exclusions.filter((item) => item.id !== exclusion.id),
      ].slice(0, 500);
    } else {
      state.exclusions = state.exclusions.filter(
        (item) => item.id !== input.exclusionId,
      );
    }
    synchronizeHistoryExclusions(state);
    this.persistence.write(state);
    this.applyExclusionsToCurrentScan(state.exclusions);
    return state.exclusions;
  }

  getHistory(): CleanerHistorySnapshot {
    const state = this.persistence.read();
    return {
      itemHistory: state.itemHistory,
      cleanupEvents: state.cleanupEvents,
      cleanupReceipts: state.cleanupReceipts,
      migrationNotices: state.migrationNotices,
    };
  }

  getPreferences(): CleanerPreferences {
    return this.persistence.read().preferences;
  }

  updatePreferences(preferences: CleanerPreferences): CleanerPreferences {
    const state = this.persistence.read();
    state.preferences = preferences;
    this.persistence.write(state);
    return preferences;
  }

  private applyExclusionsToCurrentScan(exclusions: CleanerExclusion[]): void {
    const active = this.sessions.getActive();
    if (!active?.result || active.status !== "complete") return;
    for (const finding of active.result.findings) {
      finding.excluded = isFindingExcluded(finding, exclusions);
      finding.selected = false;
      finding.recoverableBytes =
        finding.canDelete &&
        !finding.excluded &&
        !finding.relatedProcesses.some((processInfo) => processInfo.blocking) &&
        (finding.safety === "safe-now" || finding.safety === "conditional")
          ? (finding.estimatedReclaimableBytes ?? 0)
          : 0;
    }
    active.result.summary.excludedBytes = calculateUnionLogicalBytes(
      active.result.findings.filter((finding) => finding.excluded),
    );
    active.result.summary.safeNowBytes = calculateNonExcludedSafetyBytes(
      active.result.findings,
      "safe-now",
    );
    active.result.summary.safeAfterCloseBytes = calculateNonExcludedSafetyBytes(
      active.result.findings,
      "safe-after-close",
    );
    active.result.summary.conditionalBytes = calculateNonExcludedSafetyBytes(
      active.result.findings,
      "conditional",
    );
    active.result.summary.protectedBytes = calculateNonExcludedSafetyBytes(
      active.result.findings,
      "protected",
    );
    active.result.summary.manualReviewBytes = calculateNonExcludedSafetyBytes(
      active.result.findings,
      "manual-review",
    );
    active.result.summary.estimatedRecoverableBytes =
      calculateUnionRecoverableBytes(active.result.findings, "safe-now");
    active.result.summary.conditionalRecoverableBytes =
      calculateUnionRecoverableBytes(active.result.findings, "conditional");
    active.result.summary.unknownRecoverableFindingCount =
      active.result.findings.filter(
        (finding) =>
          !finding.excluded && finding.accountingActionabilityBlocked,
      ).length;
    active.result.summary.unknownRecoverableLogicalBytes =
      calculateUnionLogicalBytes(
        active.result.findings.filter(
          (finding) =>
            !finding.excluded && finding.accountingActionabilityBlocked,
        ),
      );
    active.result.summary.partialLogicalBytes = calculateUnionLogicalBytes(
      active.result.findings.filter(
        (finding) =>
          !finding.excluded && finding.measurementCompleteness !== "complete",
      ),
    );
    active.findings.clear();
    for (const finding of active.result.findings) {
      active.findings.set(finding.id, finding);
    }
    this.emit("scan-complete", active.result);
  }
}
