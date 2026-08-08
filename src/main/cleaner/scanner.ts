import { createHash } from "node:crypto";
import type {
  CleanerClock,
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDriveProvider,
  CleanerFinding,
  CleanerFilesystem,
  CleanerApplicationEvidenceProvider,
  CleanerApplicationResolution,
  CleanerLeftoverCacheStatus,
  CleanerOwnershipStatus,
  CleanerPersistence,
  CleanerProcessProvider,
  CleanerScanProgress,
  CleanerScanResult,
  CleanerScanSummary,
  CleanerSafety,
} from "./types";
import type { CleanerScanSession } from "./scan-session";
import { CleanerSizeCalculator } from "./size-calculator";
import {
  findRelatedCleanerProcesses,
  hasBlockingCleanerProcess,
} from "./process-checker";
import {
  normalizeWindowsPath,
  isWindowsPathInside,
} from "./path-normalization";
import { isFindingExcluded } from "./exclusions";
import { getRegenerationStatus, observeCleanerFinding } from "./history";
import { applyCleanerScore } from "./scoring";
import { resolveCleanerApplications } from "./applications/installation-resolver";
import {
  applicationStatusLabel,
  resolveCleanerCandidateOwnership,
  resolveCleanerLeftoverCacheStatus,
} from "./applications/ownership-resolver";
import {
  recordObservedCleanerRoot,
  updateCleanerApplicationObservations,
} from "./applications/observation-store";
import { scanCleanerProtectedMarkers } from "./protected-markers";
import {
  CleanerAccountingWorkerFailure,
  createWorkerFailureMeasurement,
  type CleanerAccountingWorkerFactory,
  type CleanerAccountingWorkerSession,
} from "./accounting-worker";
import {
  STANDARD_ACTIONABLE_MEASUREMENT_POLICY,
  STANDARD_INFORMATIONAL_MEASUREMENT_POLICY,
  STANDARD_PROTECTED_MARKER_LIMITS,
  type CleanerStandardMeasurementPolicy,
} from "./measurement-policy";
import { CleanerCancelledError } from "./cancellation";

export type CleanerScannerDependencies = {
  filesystem: CleanerFilesystem;
  processProvider: CleanerProcessProvider;
  applicationEvidenceProvider: CleanerApplicationEvidenceProvider;
  driveProvider: CleanerDriveProvider;
  persistence: CleanerPersistence;
  clock: CleanerClock;
  detectors: CleanerDetector[];
  detectorDelayMs?: number;
  accountingWorkerFactory: CleanerAccountingWorkerFactory;
  standardActionableMeasurementPolicy?: CleanerStandardMeasurementPolicy;
  standardInformationalMeasurementPolicy?: CleanerStandardMeasurementPolicy;
};

export class CleanerScanner {
  constructor(private readonly dependencies: CleanerScannerDependencies) {}

  async refreshFreeSpace(
    session: CleanerScanSession,
    environment: import("./types").CleanerEnvironment,
  ): Promise<CleanerScanResult> {
    if (!session.result || session.status !== "complete") {
      throw new Error("Cleaner scan session is not ready.");
    }
    session.result.summary.freeDiskSpaceBytes = (
      await this.dependencies.driveProvider.measureFreeSpace(
        environment.systemDrive,
      )
    ).freeBytes;
    session.result.summary.freeDiskSpaceMeasuredAt =
      this.dependencies.clock.now();
    session.result.summary.freeSpaceIsStale = false;
    return session.result;
  }

  async scan(
    session: CleanerScanSession,
    environment: import("./types").CleanerEnvironment,
    onProgress: (progress: CleanerScanProgress) => void,
  ): Promise<CleanerScanResult> {
    const { clock, detectors, filesystem, persistence } = this.dependencies;
    const startedAt = clock.now();
    let findingCount = 0;
    let measuredSizeBytes = 0;
    let completedMeasurementSizeBytes = 0;
    let activeMeasurementCategory = "";
    let activeMeasurementIndex = 0;
    let activeMeasurementTotal = 0;
    let currentTarget: string | undefined;
    let currentDetectorId: string | undefined;
    let processedFiles = 0;
    let processedDirectories = 0;
    let uniqueFileRecords = 0;
    let logicalBytesScanned = 0;
    let workerActive = false;
    let lastProgressAt = 0;
    let lastStage = "";
    const emitProgress = (
      stage: CleanerScanProgress["stage"],
      currentCategory: string,
      completedUnits: number,
      totalUnits: number,
      force = false,
    ) => {
      const now = clock.now();
      if (!force && stage === lastStage && now - lastProgressAt < 100) return;
      lastProgressAt = now;
      lastStage = stage;
      const progress: CleanerScanProgress = {
        scanSessionId: session.id,
        mode: session.mode,
        stage,
        currentCategory,
        completedUnits,
        totalUnits,
        percent:
          totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0,
        findingCount,
        measuredSizeBytes,
        startedAt,
        elapsedMs: Math.max(0, now - startedAt),
        progressKind: "stage",
        currentTarget,
        currentDetectorId,
        completedTargets: activeMeasurementIndex,
        totalTargets: activeMeasurementTotal,
        processedFiles,
        processedDirectories,
        uniqueFileRecords,
        logicalBytesScanned,
        workerActive,
      };
      session.progress = progress;
      onProgress(progress);
    };

    emitProgress("preparing", "Windows environment", 0, detectors.length, true);
    const scanWarnings: string[] = [];
    const standardScanDeadline =
      session.mode === "standard" ? startedAt + 60_000 : undefined;
    session.cancellation.throwIfCancelled();
    const storeState = persistence.read();
    const processes = await this.dependencies.processProvider.list(environment);
    const evidenceSnapshot =
      await this.dependencies.applicationEvidenceProvider.collect(
        session.mode,
        environment,
        processes,
        storeState.applicationObservations,
        {
          isCancelled: () => session.cancellation.isCancelled,
          onSourceProgress: (source, completed, total) =>
            emitProgress(
              "preparing",
              `Application evidence: ${source}`,
              completed,
              total,
              true,
            ),
        },
      );
    const applications = resolveCleanerApplications(
      evidenceSnapshot,
      processes,
      storeState.applicationObservations,
    );
    session.applicationEvidence = evidenceSnapshot;
    session.applicationResolutions = applications;
    updateCleanerApplicationObservations(
      storeState,
      applications,
      evidenceSnapshot,
      clock.now(),
    );
    const scanTimeFreeDiskSpaceMeasuredAt = clock.now();
    const scanTimeFreeDiskSpaceBytes = (
      await this.dependencies.driveProvider.measureFreeSpace(
        environment.systemDrive,
      )
    ).freeBytes;
    const candidates: CleanerDetectorCandidate[] = [];

    for (let index = 0; index < detectors.length; index += 1) {
      session.cancellation.throwIfCancelled();
      if (
        standardScanDeadline !== undefined &&
        clock.now() >= standardScanDeadline
      ) {
        scanWarnings.push(
          "The global scan time budget expired before every detector completed.",
        );
        break;
      }
      const detector = detectors[index];
      emitProgress(
        "detecting",
        detector.category,
        index,
        detectors.length,
        true,
      );
      if (this.dependencies.detectorDelayMs) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.dependencies.detectorDelayMs),
        );
        session.cancellation.throwIfCancelled();
      }
      const detected = await detector.detect({
        mode: session.mode,
        environment,
        filesystem,
        processes,
        applications,
        evidenceSnapshot,
        isCancelled: () => session.cancellation.isCancelled,
      });
      candidates.push(...detected);
      findingCount = candidates.length;
    }

    const uniqueCandidates = deduplicateCandidates(candidates);
    const onMeasurementProgress = (
      progress: import("./size-calculator").CleanerMeasurementProgress,
    ): void => {
      measuredSizeBytes = completedMeasurementSizeBytes + progress.logicalBytes;
      logicalBytesScanned = progress.logicalBytes;
      processedFiles = progress.measuredFileCount;
      processedDirectories = progress.measuredDirectoryCount;
      uniqueFileRecords = progress.uniqueFileRecords;
      emitProgress(
        "measuring",
        activeMeasurementCategory,
        activeMeasurementIndex,
        activeMeasurementTotal,
      );
    };
    const sizeCalculator = new CleanerSizeCalculator(
      filesystem,
      session.cancellation,
      {
        policy:
          this.dependencies.standardActionableMeasurementPolicy ??
          STANDARD_ACTIONABLE_MEASUREMENT_POLICY,
        onProgress: onMeasurementProgress,
      },
    );
    const informationalSizeCalculator = new CleanerSizeCalculator(
      filesystem,
      session.cancellation,
      {
        policy:
          this.dependencies.standardInformationalMeasurementPolicy ??
          STANDARD_INFORMATIONAL_MEASUREMENT_POLICY,
        onProgress: onMeasurementProgress,
      },
    );
    let deepWorker: CleanerAccountingWorkerSession | undefined =
      session.mode === "deep"
        ? this.dependencies.accountingWorkerFactory.create()
        : undefined;
    const restartDeepWorker = async (): Promise<void> => {
      try {
        await deepWorker?.close();
      } catch {
        // The failed worker may already be gone.
      }
      deepWorker = this.dependencies.accountingWorkerFactory.create();
    };
    const measureDeepTarget = async (
      targetPath: string,
    ): Promise<import("./size-calculator").CleanerMeasuredSize> => {
      if (!deepWorker) {
        throw new CleanerAccountingWorkerFailure(
          "Deep Audit accounting worker is unavailable.",
        );
      }
      try {
        let measured = await deepWorker.measure(
          targetPath,
          session.cancellation,
          onMeasurementProgress,
        );
        if (measured.measurementFailureCategory === "filesystem-instability") {
          activeMeasurementCategory = `${activeMeasurementCategory}, retrying after detected change`;
          emitProgress(
            "measuring",
            activeMeasurementCategory,
            activeMeasurementIndex,
            activeMeasurementTotal,
            true,
          );
          measured = await deepWorker.measure(
            targetPath,
            session.cancellation,
            onMeasurementProgress,
          );
        }
        return measured;
      } catch (error) {
        if (
          error instanceof CleanerCancelledError ||
          session.cancellation.isCancelled
        ) {
          throw error;
        }
        await restartDeepWorker();
        return createWorkerFailureMeasurement(clock.now());
      }
    };
    const findings: CleanerFinding[] = [];
    try {
      for (let index = 0; index < uniqueCandidates.length; index += 1) {
        session.cancellation.throwIfCancelled();
        if (
          standardScanDeadline !== undefined &&
          clock.now() >= standardScanDeadline
        ) {
          scanWarnings.push(
            "The global scan time budget expired before every finding was measured.",
          );
          break;
        }
        const item = uniqueCandidates[index];
        completedMeasurementSizeBytes = measuredSizeBytes;
        activeMeasurementCategory = item.category;
        activeMeasurementIndex = index;
        activeMeasurementTotal = uniqueCandidates.length;
        currentTarget = item.displayName;
        currentDetectorId = item.detectorId;
        processedFiles = 0;
        processedDirectories = 0;
        uniqueFileRecords = 0;
        logicalBytesScanned = 0;
        workerActive = session.mode === "deep";
        emitProgress(
          "measuring",
          item.category,
          index,
          uniqueCandidates.length,
        );
        const measured =
          session.mode === "deep"
            ? await measureDeepTarget(item.path)
            : await (
                item.canDelete ? sizeCalculator : informationalSizeCalculator
              ).measure(item.path);
        workerActive = false;
        processedFiles = measured.measuredFileCount;
        processedDirectories = measured.measuredDirectoryCount;
        logicalBytesScanned = measured.logicalBytes;
        measuredSizeBytes =
          completedMeasurementSizeBytes + measured.logicalBytes;
        emitProgress(
          "measuring",
          item.category,
          index,
          uniqueCandidates.length,
          true,
        );
        if (!measured.complete) {
          scanWarnings.push(
            session.mode === "standard"
              ? "Standard Scan bounded one or more large findings. Run Deep Audit for complete accounting."
              : `${item.displayName} could not be measured completely. ${measured.measurementFailureExplanation ?? "A genuine filesystem failure interrupted this target."}`,
          );
        } else if (
          item.canDelete &&
          measured.estimatedReclaimableBytes === null
        ) {
          scanWarnings.push(
            "One or more otherwise actionable findings lacked complete physical-recovery metadata and were excluded from cleanup totals.",
          );
        }
        const stat = measured.rootStat ?? {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          isReparsePoint: false,
          size: 0,
          modifiedMs: 0,
        };
        const relatedProcesses = findRelatedCleanerProcesses(
          item.processMatchRules,
          processes,
          item.path,
        );
        const blockingProcess = hasBlockingCleanerProcess(relatedProcesses);
        const measuredProtectedMarkers =
          item.protectedMarkerScope === "root-children"
            ? measured.rootProtectedMarkers
            : measured.protectedMarkers;
        const markerScan =
          item.canDelete ||
          item.manualApprovalEligible === true ||
          item.baseSafety === "manual-review" ||
          item.dataKind === "unknown"
            ? session.mode === "deep"
              ? {
                  markers: measuredProtectedMarkers,
                  internalReparsePoints: measured.internalReparsePointCount,
                  inaccessibleEntries: measured.inaccessibleEntryCount,
                  complete: measured.logicalTraversalComplete,
                }
              : await scanCleanerProtectedMarkers(
                  filesystem,
                  item.path,
                  item.protectedMarkerScope === "root-children"
                    ? { ...STANDARD_PROTECTED_MARKER_LIMITS, maxDepth: 1 }
                    : STANDARD_PROTECTED_MARKER_LIMITS,
                )
            : {
                markers: [],
                internalReparsePoints: 0,
                inaccessibleEntries: 0,
                complete: true,
              };
        const ownership = resolveCleanerCandidateOwnership(item, applications);
        const ownerApplications = ownership.ownerApplicationIds
          .map((ownerId) =>
            applications.find((application) => application.id === ownerId),
          )
          .filter((application) => application !== undefined);
        const primaryApplication =
          (item.applicationId
            ? applications.find(
                (application) => application.id === item.applicationId,
              )
            : undefined) ?? ownerApplications[0];
        const leftoverCacheStatus = resolveCleanerLeftoverCacheStatus({
          dataKind: item.dataKind,
          ownership,
          ownerResolutions: ownerApplications,
          exactDataRoot: item.exactDataRoot,
          hasBlockingProcess: blockingProcess,
          hasProtectedMarkers: markerScan.markers.length > 0,
          hasInternalReparsePoints: markerScan.internalReparsePoints > 0,
        });
        let safety: CleanerSafety = item.baseSafety;
        let canDelete = item.canDelete;
        let reason = item.reason;
        const policy = applyOwnedDataPolicy({
          candidate: item,
          safety,
          canDelete,
          application: primaryApplication,
          ownershipStatus: ownership.status,
          leftoverCacheStatus,
        });
        safety = policy.safety;
        canDelete = policy.canDelete;
        reason = policy.reason ? `${reason} ${policy.reason}` : reason;
        if (
          (stat.isSymbolicLink || stat.isReparsePoint) &&
          safety !== "protected"
        ) {
          safety = "manual-review";
          canDelete = false;
          reason = `${reason} The target root is a reparse point, so automatic cleanup is disabled.`;
        } else if (!measured.complete && safety !== "protected") {
          safety = "manual-review";
          canDelete = false;
          reason =
            session.mode === "standard" &&
            (measured.measurementLimitReason === "entry-limit" ||
              measured.measurementLimitReason === "duration-limit" ||
              measured.measurementLimitReason === "metadata-limit")
              ? `${reason} Standard Scan reached its bounded measurement policy. Run Deep Audit for complete accounting before cleanup.`
              : `${reason} ${measured.measurementFailureExplanation ?? "A genuine filesystem failure prevented complete accounting."} Automatic cleanup is disabled.`;
        } else if (
          item.canDelete &&
          measured.estimatedReclaimableBytes === null &&
          safety !== "protected"
        ) {
          safety = "manual-review";
          canDelete = false;
          reason = `${reason} Physical recovery accounting could not be completed safely, so automatic cleanup is disabled.`;
        } else if (
          (markerScan.markers.length > 0 || !markerScan.complete) &&
          safety !== "protected"
        ) {
          safety = "manual-review";
          canDelete = false;
          reason = `${reason} Protected or inaccessible mixed-state markers were found: ${markerScan.markers.join(", ") || "inaccessible entries"}.`;
        } else if (safety === "safe-now" && blockingProcess) {
          safety = "safe-after-close";
        }
        if (safety === "protected" || safety === "manual-review")
          canDelete = false;
        const manualApprovalAllowed = canManuallyApproveCleanerCandidate({
          candidate: item,
          safety,
          rootIsReparsePoint: stat.isSymbolicLink || stat.isReparsePoint,
          protectedMarkerCount: markerScan.markers.length,
          markerInspectionComplete: markerScan.complete,
        });

        const normalizedPath = normalizeWindowsPath(item.path);
        const id = createFindingId(item.detectorId, normalizedPath);
        const finding: CleanerFinding = {
          id,
          detectorId: item.detectorId,
          category: item.category,
          displayName: item.displayName,
          applicationName: item.applicationName,
          applicationId: item.applicationId,
          applicationFamilyId: primaryApplication?.familyId,
          applicationChannel: primaryApplication?.channel,
          applicationInstallState:
            primaryApplication?.installState ?? "unknown",
          applicationRunningState:
            primaryApplication?.runningState ??
            (blockingProcess ? "likely-running" : "unknown"),
          dataKind: item.dataKind,
          ownershipStatus: ownership.status,
          ownershipConfidence: ownership.confidence,
          ownerApplicationIds: ownership.ownerApplicationIds,
          sharedOwnership: ownership.shared,
          leftoverCacheStatus,
          evidenceConfidence:
            primaryApplication?.confidence ?? ownership.confidence,
          strongEvidence: primaryApplication?.strongEvidence ?? [],
          supportingEvidence: primaryApplication?.supportingEvidence ?? [],
          staleEvidence: primaryApplication?.staleEvidence ?? [],
          unavailableEvidenceSources:
            primaryApplication?.unavailableEvidenceSources ?? [],
          verifiedExecutableBasename:
            primaryApplication?.verifiedExecutableBasename,
          productChannel: primaryApplication?.channel,
          mixedDataWarnings: [
            ...markerScan.markers.map(
              (marker) => `Contains protected marker ${marker}.`,
            ),
            ...(markerScan.internalReparsePoints > 0
              ? [
                  `${markerScan.internalReparsePoints} internal reparse object(s) will never be traversed.`,
                ]
              : []),
            ...(markerScan.inaccessibleEntries > 0
              ? [
                  `${markerScan.inaccessibleEntries} entry or entries could not be inspected.`,
                ]
              : []),
          ],
          statusExplanation: buildStatusExplanation(
            item,
            primaryApplication,
            leftoverCacheStatus,
            blockingProcess,
          ),
          lastSeenInstalledAt: primaryApplication?.lastSeenInstalledAt,
          applicationInstanceId: primaryApplication?.applicationInstanceId,
          definitionVersion: item.definitionVersion,
          dataRootId: item.dataRootId,
          exactDataRoot: item.exactDataRoot,
          protectedParentBypass: item.protectedParentBypass,
          path: item.path,
          normalizedPath,
          accounting: toFindingAccounting(measured),
          logicalBytes: measured.logicalBytes,
          allocatedBytes: measured.allocatedBytes,
          uniqueAllocatedBytes: measured.uniqueAllocatedBytes,
          estimatedReclaimableBytes: measured.estimatedReclaimableBytes,
          reclaimableLowerBoundBytes: measured.reclaimableLowerBoundBytes,
          reclaimableUpperBoundBytes: measured.reclaimableUpperBoundBytes,
          measurementCompleteness: measured.measurementCompleteness,
          accountingConfidence: measured.accountingConfidence,
          hardlinkRecordCount: measured.hardlinkRecordCount,
          externalHardlinkRecordCount: measured.externalHardlinkRecordCount,
          sparseFileCount: measured.sparseFileCount,
          compressedFileCount: measured.compressedFileCount,
          measuredFileCount: measured.measuredFileCount,
          measuredDirectoryCount: measured.measuredDirectoryCount,
          measurementStartedAt: measured.measurementStartedAt,
          measurementCompletedAt: measured.measurementCompletedAt,
          measurementDurationMs: measured.measurementDurationMs,
          measurementLimitReason: measured.measurementLimitReason,
          logicalTraversalComplete: measured.logicalTraversalComplete,
          physicalAccountingComplete: measured.physicalAccountingComplete,
          measurementFailureCategory: measured.measurementFailureCategory,
          measurementFailureExplanation: measured.measurementFailureExplanation,
          accountingActionabilityBlocked:
            item.canDelete &&
            (!measured.complete || measured.estimatedReclaimableBytes === null),
          sizeBytes: measured.sizeBytes,
          recoverableBytes: 0,
          fileCount: measured.fileCount,
          sizeMeasurementComplete: measured.complete,
          sizeMeasurementWarnings: [
            ...(!measured.complete
              ? [
                  session.mode === "standard" &&
                  (measured.measurementLimitReason === "entry-limit" ||
                    measured.measurementLimitReason === "duration-limit" ||
                    measured.measurementLimitReason === "metadata-limit")
                    ? `Standard Scan stopped at its configured bound after ${measured.inspectedEntries} entries. Run Deep Audit for a complete result.`
                    : (measured.measurementFailureExplanation ??
                      "The target could not be measured completely because of a filesystem failure."),
                  "The displayed logical size is a partial lower bound and is not reclaimable space.",
                ]
              : []),
            ...(measured.complete &&
            measured.estimatedReclaimableBytes === null &&
            item.canDelete
              ? [
                  "Physical allocation or hardlink ownership metadata was unavailable. This logical size is excluded from recovery totals.",
                ]
              : []),
          ],
          safety,
          reason,
          consequences: [...item.consequences],
          restoration: item.restoration,
          relatedProcesses,
          relatedProcessNames: [...item.relatedProcessNames],
          processMatchRules: structuredClone(item.processMatchRules),
          excluded: false,
          selected: false,
          canDelete,
          manualApprovalAllowed,
          requiresExplicitConfirmation:
            item.requiresExplicitConfirmation || safety === "conditional",
          reparsePointStatus:
            stat.isSymbolicLink || stat.isReparsePoint
              ? "target-is-reparse-point"
              : measured.reparsePointStatus,
          recommendation: "low-priority",
          recommendationReason: "Pending cleanup-value calculation.",
          cleanupValueScore: 0,
          regeneration: {
            label: "not-cleaned-before",
            summary: "Not cleaned before.",
            observedRegenerations: 0,
          },
          fingerprint: {
            kind: stat.isDirectory ? "directory" : "file",
            device: stat.device,
            inode: stat.inode,
            modifiedMs: stat.modifiedMs,
            reparsePoint: stat.isSymbolicLink || stat.isReparsePoint,
          },
        };
        finding.excluded = isFindingExcluded(finding, storeState.exclusions);
        finding.recoverableBytes =
          canDelete &&
          !finding.excluded &&
          !blockingProcess &&
          (safety === "safe-now" || safety === "conditional")
            ? (measured.estimatedReclaimableBytes ?? 0)
            : 0;
        const history = observeCleanerFinding(storeState, finding, clock.now());
        finding.regeneration = getRegenerationStatus(history);
        finding.history = {
          lastCleanedAt: history.lastCleanedAt,
          lastCleanedSizeBytes: history.lastCleanedSizeBytes,
          successfulCleanups: history.successfulCleanups,
          observedRegenerations: history.observedRegenerations,
          approximateRegenerationMs: history.approximateRegenerationMs,
        };
        applyCleanerScore(finding, scanTimeFreeDiskSpaceBytes, history);
        if (finding.applicationId) {
          recordObservedCleanerRoot(
            storeState,
            finding.applicationId,
            finding.dataRootId,
          );
        }
        measuredSizeBytes = completedMeasurementSizeBytes + measured.sizeBytes;
        findings.push(finding);
      }
    } finally {
      workerActive = false;
      await deepWorker?.close();
    }

    markFindingOverlaps(findings);
    persistence.write(storeState);
    activeMeasurementIndex = findings.length;
    activeMeasurementTotal = uniqueCandidates.length;
    currentTarget = undefined;
    currentDetectorId = undefined;
    workerActive = false;
    emitProgress(
      "finalizing",
      "Safety and cleanup value",
      findings.length,
      uniqueCandidates.length,
      true,
    );
    session.cancellation.throwIfCancelled();
    const completedAt = clock.now();
    const freeDiskSpaceMeasuredAt = clock.now();
    const freeDiskSpaceBytes = (
      await this.dependencies.driveProvider.measureFreeSpace(
        environment.systemDrive,
      )
    ).freeBytes;
    const result: CleanerScanResult = {
      scanSessionId: session.id,
      createdAt: session.createdAt,
      completedAt,
      platform: "win32",
      mode: session.mode,
      testMode: session.testMode,
      findings,
      summary: buildScanSummary(
        findings,
        freeDiskSpaceBytes,
        freeDiskSpaceMeasuredAt,
        scanTimeFreeDiskSpaceBytes,
        scanTimeFreeDiskSpaceMeasuredAt,
        completedAt - startedAt,
        session.mode,
        scanWarnings,
      ),
    };
    session.findings.clear();
    for (const finding of findings) session.findings.set(finding.id, finding);
    session.result = result;
    session.status = "complete";
    return result;
  }
}

export function applyOwnedDataPolicy(input: {
  candidate: CleanerDetectorCandidate;
  safety: CleanerSafety;
  canDelete: boolean;
  application?: CleanerApplicationResolution;
  ownershipStatus: CleanerOwnershipStatus;
  leftoverCacheStatus: CleanerLeftoverCacheStatus;
}): { safety: CleanerSafety; canDelete: boolean; reason?: string } {
  if (PROTECTED_CLEANER_DATA_KINDS.has(input.candidate.dataKind)) {
    return {
      safety:
        input.candidate.baseSafety === "manual-review"
          ? "manual-review"
          : "protected",
      canDelete: false,
      reason:
        "This data kind can contain installed capability or recoverable state and is never part of safe bulk cleanup.",
    };
  }
  if (input.candidate.dataKind === "unknown") {
    return input.safety === "protected"
      ? { safety: "protected", canDelete: false }
      : {
          safety: "manual-review",
          canDelete: false,
          reason: "The owned-data kind is unknown.",
        };
  }
  if (
    input.candidate.dataKind === "shared-dependency-store" ||
    input.ownershipStatus === "shared"
  ) {
    return {
      safety: input.safety === "protected" ? "protected" : "conditional",
      canDelete: input.safety !== "protected" && input.canDelete,
      reason: "Shared ownership prevents safe leftover-cache classification.",
    };
  }
  if (input.candidate.dataKind === "service-worker-cache") {
    return {
      safety: input.safety === "protected" ? "protected" : "conditional",
      canDelete: input.safety !== "protected" && input.canDelete,
      reason:
        "Service Worker cache stays separate from ordinary browser cache and requires confirmation.",
    };
  }
  if (input.candidate.dataKind === "extension-store") {
    const canBeConditional =
      input.ownershipStatus === "exclusive" &&
      (input.application?.installState === "probably-uninstalled" ||
        input.application?.installState === "confirmed-uninstalled") &&
      input.application.currentAuditComplete &&
      input.application.unavailableEvidenceSources.length === 0;
    if (canBeConditional) {
      return {
        safety: "conditional",
        canDelete: input.canDelete,
        reason:
          "The current complete audit did not find the exclusively owning application. Extensions still require explicit confirmation.",
      };
    }
    const canBeManuallyApproved =
      input.candidate.manualApprovalEligible === true &&
      input.candidate.exactDataRoot &&
      input.ownershipStatus === "exclusive" &&
      Boolean(
        input.application &&
        (input.application.installState === "confirmed-installed" ||
          input.application.installState === "probably-installed" ||
          input.application.installState === "portable-detected"),
      );
    return canBeManuallyApproved
      ? {
          safety: "manual-review",
          canDelete: false,
          reason:
            "This exact extension store can be cleaned only after explicit manual approval.",
        }
      : {
          safety: "protected",
          canDelete: false,
          reason:
            "Extension stores stay protected while installation evidence is incomplete, ambiguous, or protected by product policy.",
        };
  }
  if (
    input.application &&
    (input.application.installState === "ambiguous" ||
      input.application.installState === "unknown") &&
    input.candidate.applicationId
  ) {
    return {
      safety: "protected",
      canDelete: false,
      reason:
        "Application ownership is known, but current installation evidence is incomplete or ambiguous.",
    };
  }
  if (
    input.application &&
    input.candidate.applicationId &&
    input.application.installState === "probably-uninstalled" &&
    input.leftoverCacheStatus !== "leftover-cache"
  ) {
    return {
      safety: "protected",
      canDelete: false,
      reason:
        "The application was not found, but the strict leftover-cache proof is incomplete.",
    };
  }
  return { safety: input.safety, canDelete: input.canDelete };
}

const PROTECTED_CLEANER_DATA_KINDS = new Set<
  CleanerDetectorCandidate["dataKind"]
>([
  "settings",
  "session-state",
  "workspace-state",
  "history",
  "backup",
  "database",
  "local-storage",
  "indexed-db",
  "project-data",
  "model-data",
  "installed-runtime",
]);

export function canManuallyApproveCleanerCandidate(input: {
  candidate: CleanerDetectorCandidate;
  safety: CleanerSafety;
  rootIsReparsePoint: boolean;
  protectedMarkerCount: number;
  markerInspectionComplete: boolean;
}): boolean {
  return (
    input.safety === "manual-review" &&
    (input.candidate.baseSafety !== "protected" ||
      input.candidate.manualApprovalEligible === true) &&
    !PROTECTED_CLEANER_DATA_KINDS.has(input.candidate.dataKind) &&
    !input.rootIsReparsePoint &&
    input.protectedMarkerCount === 0 &&
    input.markerInspectionComplete
  );
}

function buildStatusExplanation(
  candidate: CleanerDetectorCandidate,
  application: CleanerApplicationResolution | undefined,
  leftoverStatus: CleanerLeftoverCacheStatus,
  blockingProcess: boolean,
): string {
  if (leftoverStatus === "leftover-cache") {
    return `Leftover cache. A complete current audit did not find ${candidate.applicationName}, and this exact exclusive root contains only regenerable ${candidate.dataKind.replaceAll("-", " ")} data.`;
  }
  if (leftoverStatus === "contains-recoverable-state") {
    return `Contains recoverable state. ${candidate.dataKind.replaceAll("-", " ")} is protected from safe cleanup.`;
  }
  if (leftoverStatus === "shared-cache") {
    return "Shared cache. Another owner may still need this data.";
  }
  if (blockingProcess) {
    return "A confirmed or likely active consumer is using this exact data root.";
  }
  if (application) {
    return `${applicationStatusLabel(application.installState)}. ${application.unavailableEvidenceSources.length > 0 ? "One or more evidence sources were unavailable." : "The status uses current source-specific evidence."}`;
  }
  return "This exact detector-owned path was classified without inferring an application installation state.";
}

export function createFindingId(
  detectorId: string,
  normalizedPath: string,
): string {
  return createHash("sha256")
    .update(`${detectorId}\0${normalizedPath}`)
    .digest("hex")
    .slice(0, 32);
}

function deduplicateCandidates(
  candidates: CleanerDetectorCandidate[],
): CleanerDetectorCandidate[] {
  const rank: Record<CleanerSafety, number> = {
    protected: 5,
    "manual-review": 4,
    conditional: 3,
    "safe-after-close": 2,
    "safe-now": 1,
  };
  const byPath = new Map<string, CleanerDetectorCandidate>();
  for (const candidate of candidates) {
    const key = normalizeWindowsPath(candidate.path);
    const existing = byPath.get(key);
    if (!existing || rank[candidate.baseSafety] > rank[existing.baseSafety]) {
      byPath.set(key, candidate);
    }
  }
  return [...byPath.values()];
}

function markFindingOverlaps(findings: CleanerFinding[]): void {
  const ordered = [...findings].sort(
    (left, right) => left.normalizedPath.length - right.normalizedPath.length,
  );
  for (let parentIndex = 0; parentIndex < ordered.length; parentIndex += 1) {
    const parent = ordered[parentIndex];
    for (
      let childIndex = parentIndex + 1;
      childIndex < ordered.length;
      childIndex += 1
    ) {
      const child = ordered[childIndex];
      if (
        parent.normalizedPath !== child.normalizedPath &&
        isWindowsPathInside(child.path, parent.path)
      ) {
        const group = parent.overlapGroup ?? `overlap:${parent.id}`;
        parent.overlapGroup = group;
        child.overlapGroup = group;
      }
    }
  }
}

function buildScanSummary(
  findings: CleanerFinding[],
  freeDiskSpaceBytes: number,
  freeDiskSpaceMeasuredAt: number,
  scanTimeFreeDiskSpaceBytes: number,
  scanTimeFreeDiskSpaceMeasuredAt: number,
  durationMs: number,
  mode: "standard" | "deep",
  scanWarnings: string[],
): CleanerScanSummary {
  return {
    safeNowBytes: calculateNonExcludedSafetyBytes(findings, "safe-now"),
    safeAfterCloseBytes: calculateNonExcludedSafetyBytes(
      findings,
      "safe-after-close",
    ),
    conditionalBytes: calculateNonExcludedSafetyBytes(findings, "conditional"),
    protectedBytes: calculateNonExcludedSafetyBytes(findings, "protected"),
    manualReviewBytes: calculateNonExcludedSafetyBytes(
      findings,
      "manual-review",
    ),
    excludedBytes: calculateUnionLogicalBytes(
      findings.filter((finding) => finding.excluded),
    ),
    conditionalRecoverableBytes: calculateUnionRecoverableBytes(
      findings,
      "conditional",
    ),
    estimatedRecoverableBytes: calculateUnionRecoverableBytes(
      findings,
      "safe-now",
    ),
    unknownRecoverableFindingCount: findings.filter(
      (finding) => !finding.excluded && finding.accountingActionabilityBlocked,
    ).length,
    unknownRecoverableLogicalBytes: calculateUnionLogicalBytes(
      findings.filter(
        (finding) =>
          !finding.excluded && finding.accountingActionabilityBlocked,
      ),
    ),
    partialLogicalBytes: calculateUnionLogicalBytes(
      findings.filter(
        (finding) =>
          !finding.excluded && finding.measurementCompleteness !== "complete",
      ),
    ),
    freeDiskSpaceBytes,
    freeDiskSpaceMeasuredAt,
    scanTimeFreeDiskSpaceBytes,
    scanTimeFreeDiskSpaceMeasuredAt,
    freeSpaceIsStale: false,
    sizeAccountingNotes: [
      "Estimated recoverable space uses unique file records and excludes hardlinks that also exist outside the target.",
      "Logical size counts visible file lengths and can be much larger than physical recovery.",
      "Incomplete or unavailable physical accounting is excluded from recoverable totals.",
      "Protected VHDX logical sizes are informational and are never reclaimable totals.",
    ],
    scanIncomplete: scanWarnings.length > 0,
    scanWarnings: [...new Set(scanWarnings)],
    durationMs,
    mode,
  };
}

export function calculateNonExcludedSafetyBytes(
  findings: CleanerFinding[],
  safety: CleanerSafety,
): number {
  return findings
    .filter((finding) => !finding.excluded && finding.safety === safety)
    .sort(
      (left, right) => left.normalizedPath.length - right.normalizedPath.length,
    )
    .reduce<{ included: CleanerFinding[]; total: number }>(
      (state, finding) => {
        if (
          state.included.some((parent) =>
            isWindowsPathInside(finding.path, parent.path),
          )
        ) {
          return state;
        }
        state.included.push(finding);
        state.total += finding.logicalBytes;
        return state;
      },
      { included: [], total: 0 },
    ).total;
}

export function calculateUnionLogicalBytes(findings: CleanerFinding[]): number {
  const included: CleanerFinding[] = [];
  let total = 0;
  for (const finding of [...findings].sort(
    (left, right) => left.normalizedPath.length - right.normalizedPath.length,
  )) {
    if (
      included.some((parent) => isWindowsPathInside(finding.path, parent.path))
    ) {
      continue;
    }
    included.push(finding);
    total += finding.logicalBytes;
  }
  return total;
}

function toFindingAccounting(
  measured: import("./size-calculator").CleanerMeasuredSize,
): import("./types").CleanerSizeAccounting {
  return {
    logicalBytes: measured.logicalBytes,
    allocatedBytes: measured.allocatedBytes,
    uniqueAllocatedBytes: measured.uniqueAllocatedBytes,
    estimatedReclaimableBytes: measured.estimatedReclaimableBytes,
    reclaimableLowerBoundBytes: measured.reclaimableLowerBoundBytes,
    reclaimableUpperBoundBytes: measured.reclaimableUpperBoundBytes,
    measurementCompleteness: measured.measurementCompleteness,
    accountingConfidence: measured.accountingConfidence,
    hardlinkRecordCount: measured.hardlinkRecordCount,
    externalHardlinkRecordCount: measured.externalHardlinkRecordCount,
    sparseFileCount: measured.sparseFileCount,
    compressedFileCount: measured.compressedFileCount,
    measuredFileCount: measured.measuredFileCount,
    measuredDirectoryCount: measured.measuredDirectoryCount,
    inaccessibleEntryCount: measured.inaccessibleEntryCount,
    inspectedEntryCount: measured.inspectedEntryCount,
    measurementStartedAt: measured.measurementStartedAt,
    measurementCompletedAt: measured.measurementCompletedAt,
    measurementDurationMs: measured.measurementDurationMs,
    measurementLimitReason: measured.measurementLimitReason,
    logicalTraversalComplete: measured.logicalTraversalComplete,
    physicalAccountingComplete: measured.physicalAccountingComplete,
    measurementFailureCategory: measured.measurementFailureCategory,
    measurementFailureExplanation: measured.measurementFailureExplanation,
  };
}

export function calculateUnionRecoverableBytes(
  findings: CleanerFinding[],
  safety?: CleanerSafety,
): number {
  const included: CleanerFinding[] = [];
  let total = 0;
  for (const finding of [...findings]
    .filter(
      (item) =>
        item.recoverableBytes > 0 && (!safety || item.safety === safety),
    )
    .sort(
      (left, right) => left.normalizedPath.length - right.normalizedPath.length,
    )) {
    if (
      included.some((parent) => isWindowsPathInside(finding.path, parent.path))
    ) {
      continue;
    }
    included.push(finding);
    total += finding.recoverableBytes;
  }
  return total;
}
