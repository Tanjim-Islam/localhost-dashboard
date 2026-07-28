import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CleanCleanerFindingsInput,
  CleanerApplicationEvidenceProvider,
  CleanerCleanupFailureCategory,
  CleanerCleanupItemResult,
  CleanerCleanupProgress,
  CleanerCleanupReceipt,
  CleanerCleanupReceiptFinding,
  CleanerCleanupResult,
  CleanerCleanupUsageCheck,
  CleanerClock,
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDriveSpaceMeasurement,
  CleanerDriveProvider,
  CleanerEnvironment,
  CleanerFileStat,
  CleanerFilesystem,
  CleanerFinding,
  CleanerPersistence,
  CleanerProcessProvider,
  PrepareCleanerCleanupInput,
} from "./types";
import type { CleanerScanSession } from "./scan-session";
import { fingerprintsMatch, validateCleanerTargetPath } from "./path-safety";
import { findRelatedCleanerProcesses } from "./process-checker";
import { CleanerCancellationToken } from "./cancellation";
import { type CleanerMeasuredSize } from "./size-calculator";
import { isFindingExcluded } from "./exclusions";
import { resolveCleanerApplications } from "./applications/installation-resolver";
import {
  hasMoreRestrictiveCleanerOwnershipState,
  resolveCleanerCandidateOwnership,
  resolveCleanerLeftoverCacheStatus,
} from "./applications/ownership-resolver";
import {
  getCleanerApplicationDataRoot,
  getCleanerApplicationDefinition,
} from "./applications/definitions";
import { isWindowsPathInside, sameWindowsPath } from "./path-normalization";
import {
  recordFinalizedCleanupReceipt,
  upsertCleanerCleanupReceipt,
} from "./cleanup-receipts";
import {
  applyOwnedDataPolicy,
  canManuallyApproveCleanerCandidate,
  calculateNonExcludedSafetyBytes,
  calculateUnionLogicalBytes,
  calculateUnionRecoverableBytes,
} from "./scanner";
import type {
  CleanerAccountingWorkerFactory,
  CleanerAccountingWorkerSession,
} from "./accounting-worker";

export type CleanerCleanupDependencies = {
  filesystem: CleanerFilesystem;
  processProvider: CleanerProcessProvider;
  applicationEvidenceProvider: CleanerApplicationEvidenceProvider;
  detectors: CleanerDetector[];
  driveProvider: CleanerDriveProvider;
  persistence: CleanerPersistence;
  clock: CleanerClock;
  accountingWorkerFactory: CleanerAccountingWorkerFactory;
};

type DeleteExactTreeResult = {
  filesAttempted: number;
  filesSuccessfullyUnlinked: number;
  directoriesAttempted: number;
  directoriesSuccessfullyRemoved: number;
  reparseObjectsSuccessfullyRemoved: number;
  skippedEntries: number;
  lockedBytesSkipped: number;
  failedEntries: number;
  failureCategories: CleanerCleanupFailureCategory[];
  skippedReparsePoints: number;
};

export class CleanerCleanupExecutor {
  constructor(private readonly dependencies: CleanerCleanupDependencies) {}

  async inspectUsage(
    session: CleanerScanSession,
    input: PrepareCleanerCleanupInput,
    environment: CleanerEnvironment,
  ): Promise<CleanerCleanupUsageCheck> {
    const findings = input.findingIds.map((id) => {
      const finding = session.findings.get(id);
      if (!finding) {
        throw new Error(`Cleaner finding ${id} is unknown or stale.`);
      }
      return finding;
    });
    if (
      findings.some(
        (finding) => finding.safety === "protected" || finding.excluded,
      )
    ) {
      throw new Error(
        "Protected or excluded Cleaner findings cannot be prepared for cleanup.",
      );
    }
    const processes = await this.dependencies.processProvider.list(environment);
    return {
      scanSessionId: session.id,
      checkedAt: this.dependencies.clock.now(),
      findings: findings
        .map((finding) => ({
          findingId: finding.id,
          displayName: finding.displayName,
          processes: findRelatedCleanerProcesses(
            finding.processMatchRules,
            processes,
            finding.path,
          )
            .filter((processInfo) => processInfo.blocking)
            .map((processInfo) => ({
              name: processInfo.name,
              ...(processInfo.pid === undefined
                ? {}
                : { pid: processInfo.pid }),
            })),
        }))
        .filter((finding) => finding.processes.length > 0),
    };
  }

  async clean(
    session: CleanerScanSession,
    input: CleanCleanerFindingsInput,
    environment: CleanerEnvironment,
    onProgress: (progress: CleanerCleanupProgress) => void,
  ): Promise<CleanerCleanupResult> {
    const { clock, driveProvider, persistence } = this.dependencies;
    const selectedFindings = input.findingIds.map((id) => {
      const finding = session.findings.get(id);
      if (!finding) {
        throw new Error(`Cleaner finding ${id} is unknown or stale.`);
      }
      return finding;
    });
    validateSelectedFindings(selectedFindings, input);
    const approvedManualReviewFindingIds = new Set(
      input.approvedManualReviewFindingIds ?? [],
    );
    const approvedInUseFindingIds = new Set(
      input.approvedInUseFindingIds ?? [],
    );
    const { resolved, overlapSkippedIds } =
      resolveOverlappingSelectedFindings(selectedFindings);
    const beforeDrive = await measureDriveSpace(
      driveProvider,
      environment.systemDrive,
      clock,
    );
    const cleanupRequestId = randomUUID();
    const createdAt = clock.now();
    const receipt: CleanerCleanupReceipt = {
      schemaVersion: 1,
      cleanupRequestId,
      scanSessionId: input.scanSessionId,
      requestedConfirmation: input.confirmation,
      createdAt,
      startedAt: createdAt,
      status: "in-progress",
      selectedFindingIds: [...input.findingIds],
      resolvedFindingIds: resolved.map((finding) => finding.id),
      freeSpaceBefore: beforeDrive,
      aggregateLogicalBytesAddressed: 0,
      aggregateEstimatedPhysicalBytesReclaimable: 0,
      aggregateLogicalBytesRemoved: 0,
      aggregateRemainingLogicalBytes: 0,
      aggregateFilesUnlinked: 0,
      aggregateDirectoriesRemoved: 0,
      aggregateReparseObjectsRemoved: 0,
      aggregateSkippedEntries: 0,
      aggregateFailedEntries: 0,
      postCleanupVerificationCompleted: false,
      findings: selectedFindings.map((finding) =>
        createInitialReceiptFinding(finding, overlapSkippedIds.has(finding.id)),
      ),
    };
    persistInProgressReceipt(persistence, receipt);

    let globalFailure: string | undefined;
    const accountingWorker = this.dependencies.accountingWorkerFactory.create();
    try {
      for (let index = 0; index < resolved.length; index += 1) {
        const finding = resolved[index];
        onProgress({
          scanSessionId: session.id,
          cleanupRequestId,
          currentFindingId: finding.id,
          completedItems: index,
          totalItems: resolved.length,
          logicalBytesDeleted: receipt.aggregateLogicalBytesRemoved,
        });
        try {
          const item = await this.cleanOne(
            finding,
            environment,
            session.mode,
            accountingWorker,
            approvedManualReviewFindingIds.has(finding.id),
            approvedInUseFindingIds.has(finding.id),
            (startedItem) => {
              replaceReceiptFinding(receipt, startedItem);
              recomputeReceiptAggregates(receipt);
              persistInProgressReceipt(persistence, receipt);
            },
          );
          replaceReceiptFinding(receipt, item);
          recomputeReceiptAggregates(receipt);
          persistInProgressReceipt(persistence, receipt);
        } catch (error) {
          globalFailure = sanitizeGlobalFailure(error);
          const failed = createUnexpectedFailureReceiptFinding(
            finding,
            globalFailure,
          );
          replaceReceiptFinding(receipt, failed);
          recomputeReceiptAggregates(receipt);
          persistInProgressReceipt(persistence, receipt);
          break;
        }
      }
    } finally {
      await accountingWorker.close();
    }

    let afterDrive: CleanerDriveSpaceMeasurement | undefined;
    try {
      afterDrive = await measureDriveSpace(
        driveProvider,
        environment.systemDrive,
        clock,
      );
      receipt.freeSpaceAfter = afterDrive;
      if (afterDrive.driveIdentity === beforeDrive.driveIdentity) {
        receipt.signedFreeSpaceDeltaBytes =
          afterDrive.freeBytes - beforeDrive.freeBytes;
      } else {
        globalFailure ??=
          "The cleanup drive identity changed before the final free-space measurement.";
      }
    } catch {
      globalFailure ??=
        "The final drive free-space measurement could not be completed.";
    }

    receipt.completedAt = clock.now();
    receipt.interruptionReason = globalFailure;
    recomputeReceiptAggregates(receipt);
    receipt.status = resolveFinalReceiptStatus(receipt, globalFailure);
    const finalState = persistence.read();
    recordFinalizedCleanupReceipt(finalState, receipt, session.mode);
    persistence.write(finalState);
    applyReceiptToSession(session, receipt, afterDrive);

    onProgress({
      scanSessionId: session.id,
      cleanupRequestId,
      completedItems: resolved.length,
      totalItems: resolved.length,
      logicalBytesDeleted: receipt.aggregateLogicalBytesRemoved,
    });
    return toCleanupResult(receipt);
  }

  private async cleanOne(
    finding: CleanerFinding,
    environment: CleanerEnvironment,
    mode: import("./types").CleanerScanMode,
    accountingWorker: CleanerAccountingWorkerSession,
    manualReviewApproved: boolean,
    inUseApproved: boolean,
    onAttemptStarted: (item: CleanerCleanupReceiptFinding) => void,
  ): Promise<CleanerCleanupReceiptFinding> {
    const before = await accountingWorker.measure(
      finding.path,
      new CleanerCancellationToken(),
    );
    if (
      !before.logicalTraversalComplete ||
      (!manualReviewApproved &&
        (before.measurementCompleteness !== "complete" ||
          before.estimatedReclaimableBytes === null))
    ) {
      return skippedReceiptFinding(
        finding,
        "Physical and logical accounting became incomplete before deletion.",
        "measurement-incomplete",
        before,
      );
    }
    const preflightFailure = await this.revalidateFinding(
      finding,
      environment,
      mode,
      before,
      manualReviewApproved,
      inUseApproved,
    );
    if (preflightFailure) return preflightFailure;

    const startedItem = createInitialReceiptFinding(finding, false);
    applyPreCleanupMeasurement(startedItem, before);
    startedItem.attemptStatus = "partial";
    startedItem.message =
      "Cleanup started. Post-cleanup verification has not completed yet.";
    onAttemptStarted(startedItem);

    const operations = await deleteExactTree(
      this.dependencies.filesystem,
      finding.path,
    );
    return this.verifyCleanupResult(
      finding,
      before,
      operations,
      accountingWorker,
    );
  }

  private async revalidateFinding(
    finding: CleanerFinding,
    environment: CleanerEnvironment,
    mode: import("./types").CleanerScanMode,
    measurement: CleanerMeasuredSize,
    manualReviewApproved: boolean,
    inUseApproved: boolean,
  ): Promise<CleanerCleanupReceiptFinding | undefined> {
    const { filesystem } = this.dependencies;
    const currentStore = this.dependencies.persistence.read();
    if (isFindingExcluded(finding, currentStore.exclusions)) {
      return skippedReceiptFinding(
        finding,
        "Exclusion state changed. Run a new scan.",
        "excluded",
      );
    }
    let pathSafety;
    try {
      pathSafety = await validateCleanerTargetPath(
        finding.path,
        environment,
        filesystem,
        { protectedParentBypass: finding.protectedParentBypass },
      );
    } catch {
      return skippedReceiptFinding(
        finding,
        "Cleaner path configuration changed. Run a new scan.",
        "path-validation",
      );
    }
    if (!pathSafety.safe) {
      return skippedReceiptFinding(
        finding,
        pathSafety.reason,
        "path-validation",
      );
    }
    if (
      pathSafety.normalizedPath !== finding.normalizedPath ||
      !fingerprintsMatch(finding.fingerprint, pathSafety.fingerprint)
    ) {
      return skippedReceiptFinding(
        finding,
        "The target identity changed after the scan. Run a new scan.",
        "state-changed",
      );
    }

    const currentProcesses =
      await this.dependencies.processProvider.list(environment);
    const running = findRelatedCleanerProcesses(
      finding.processMatchRules,
      currentProcesses,
      finding.path,
    );
    if (running.some((processInfo) => processInfo.blocking) && !inUseApproved) {
      return skippedReceiptFinding(
        finding,
        "Application running state changed. Run a new scan.",
        "process-running",
      );
    }

    const evidence =
      await this.dependencies.applicationEvidenceProvider.collect(
        mode,
        environment,
        currentProcesses,
        currentStore.applicationObservations,
      );
    const applications = resolveCleanerApplications(
      evidence,
      currentProcesses,
      currentStore.applicationObservations,
    );
    const currentApplication = finding.applicationId
      ? applications.find(
          (application) => application.id === finding.applicationId,
        )
      : undefined;
    const currentCandidates = [];
    try {
      for (const detector of this.dependencies.detectors) {
        currentCandidates.push(
          ...(await detector.detect({
            mode,
            environment,
            filesystem,
            processes: currentProcesses,
            applications,
            evidenceSnapshot: evidence,
            isCancelled: () => false,
          })),
        );
      }
    } catch {
      return skippedReceiptFinding(
        finding,
        "Current detector ownership could not be revalidated. Run a new scan.",
        "state-changed",
      );
    }
    const currentCandidate = currentCandidates.find((candidate) => {
      if (candidate.detectorId !== finding.detectorId) return false;
      try {
        return sameWindowsPath(candidate.path, finding.path);
      } catch {
        return false;
      }
    });
    if (!currentCandidate) {
      return skippedReceiptFinding(
        finding,
        "The exact detector-owned data root changed. Run a new scan.",
        "state-changed",
      );
    }
    const currentOwnership = resolveCleanerCandidateOwnership(
      currentCandidate,
      applications,
    );
    const currentOwnerApplications = currentOwnership.ownerApplicationIds
      .map((ownerId) =>
        applications.find((application) => application.id === ownerId),
      )
      .filter((application) => application !== undefined);
    const currentProtectedMarkers = selectProtectedMarkers(
      currentCandidate,
      measurement,
    );
    if (
      currentProtectedMarkers.length > 0 ||
      !measurement.logicalTraversalComplete
    ) {
      return skippedReceiptFinding(
        finding,
        "Protected or mixed-state data appeared. Run a new scan.",
        "state-changed",
      );
    }
    const currentLeftoverCacheStatus = resolveCleanerLeftoverCacheStatus({
      dataKind: currentCandidate.dataKind,
      ownership: currentOwnership,
      ownerResolutions: currentOwnerApplications,
      exactDataRoot: currentCandidate.exactDataRoot,
      hasBlockingProcess: running.some((processInfo) => processInfo.blocking),
      hasProtectedMarkers: currentProtectedMarkers.length > 0,
      hasInternalReparsePoints: measurement.internalReparsePointCount > 0,
    });
    const currentPolicy = applyOwnedDataPolicy({
      candidate: currentCandidate,
      safety: currentCandidate.baseSafety,
      canDelete: currentCandidate.canDelete,
      application: currentApplication,
      ownershipStatus: currentOwnership.status,
      leftoverCacheStatus: currentLeftoverCacheStatus,
    });
    const currentManualApprovalAllowed = canManuallyApproveCleanerCandidate({
      candidate: currentCandidate,
      safety:
        finding.safety === "manual-review" &&
        currentPolicy.safety !== "protected"
          ? "manual-review"
          : currentPolicy.safety,
      rootIsReparsePoint:
        Boolean(measurement.rootStat?.isSymbolicLink) ||
        Boolean(measurement.rootStat?.isReparsePoint),
      protectedMarkerCount: currentProtectedMarkers.length,
      markerInspectionComplete: measurement.logicalTraversalComplete,
    });
    const definition = finding.applicationId
      ? getCleanerApplicationDefinition(finding.applicationId)
      : undefined;
    const definedRoot =
      finding.applicationId && definition
        ? getCleanerApplicationDataRoot(
            finding.applicationId,
            finding.dataRootId,
          )
        : undefined;
    if (
      finding.applicationId &&
      (!definition ||
        definition.definitionVersion !== finding.definitionVersion ||
        (definedRoot &&
          !definedRoot
            .resolvePaths(environment)
            .some((targetPath) => sameWindowsPath(targetPath, finding.path))))
    ) {
      return skippedReceiptFinding(
        finding,
        "Application definition or exact data-root ownership changed. Run a new scan.",
        "state-changed",
      );
    }
    const currentIdentity = {
      applicationInstallState:
        currentApplication?.installState ?? finding.applicationInstallState,
      applicationRunningState:
        currentApplication?.runningState ?? finding.applicationRunningState,
      dataKind: currentCandidate.dataKind,
      ownershipStatus: currentOwnership.status,
      ownerApplicationIds: currentOwnership.ownerApplicationIds,
      sharedOwnership: currentOwnership.shared,
      definitionVersion:
        definition?.definitionVersion ?? currentCandidate.definitionVersion,
      applicationInstanceId: currentApplication?.applicationInstanceId,
      dataRootId: currentCandidate.dataRootId,
      exactDataRoot: currentCandidate.exactDataRoot,
    };
    if (
      currentCandidate.applicationId !== finding.applicationId ||
      currentPolicy.safety === "protected" ||
      (manualReviewApproved
        ? !currentManualApprovalAllowed
        : currentPolicy.safety === "manual-review" ||
          !currentPolicy.canDelete) ||
      hasMoreRestrictiveCleanerOwnershipState(finding, {
        ...currentIdentity,
        applicationRunningState: inUseApproved
          ? "not-running-observed"
          : currentIdentity.applicationRunningState,
      })
    ) {
      return skippedReceiptFinding(
        finding,
        "Application ownership or installation state changed. Run a new scan.",
        "state-changed",
      );
    }

    return undefined;
  }

  private async verifyCleanupResult(
    finding: CleanerFinding,
    before: CleanerMeasuredSize,
    operations: DeleteExactTreeResult,
    accountingWorker: CleanerAccountingWorkerSession,
  ): Promise<CleanerCleanupReceiptFinding> {
    const item = createInitialReceiptFinding(finding, false);
    applyPreCleanupMeasurement(item, before);
    applyDeleteOperations(item, operations);
    const verifiedAt = this.dependencies.clock.now();
    item.postCleanupVerificationAt = verifiedAt;

    let rootStat: CleanerFileStat | undefined;
    try {
      rootStat = await this.dependencies.filesystem.lstat(finding.path);
      item.postCleanupRootExists = true;
    } catch (error) {
      if (isMissingFilesystemError(error)) {
        item.postCleanupRootExists = false;
      } else {
        item.postCleanupRootExists = null;
        item.failureCategories = uniqueFailureCategories([
          ...item.failureCategories,
          "verification-failed",
        ]);
      }
    }

    if (item.postCleanupRootExists === false) {
      item.postCleanupLogicalBytes = 0;
      item.postCleanupAllocatedBytes = 0;
      item.postCleanupEstimatedReclaimableBytes = 0;
      item.postCleanupMeasurementCompleteness = "complete";
      item.verificationCompleted = true;
    } else if (item.postCleanupRootExists === true && rootStat) {
      if (rootStat.isSymbolicLink || rootStat.isReparsePoint) {
        item.postCleanupMeasurementCompleteness = "unavailable";
        item.verificationCompleted = false;
        item.failureCategories = uniqueFailureCategories([
          ...item.failureCategories,
          "verification-failed",
        ]);
      } else {
        const after = await accountingWorker.measure(
          finding.path,
          new CleanerCancellationToken(),
        );
        item.postCleanupLogicalBytes = after.logicalBytes;
        item.postCleanupAllocatedBytes = after.allocatedBytes;
        item.postCleanupEstimatedReclaimableBytes =
          after.estimatedReclaimableBytes;
        item.postCleanupMeasurementCompleteness = after.measurementCompleteness;
        item.postCleanupFingerprint = fingerprintFromStat(rootStat);
        item.verificationCompleted =
          after.measurementCompleteness === "complete";
        if (!item.verificationCompleted) {
          item.failureCategories = uniqueFailureCategories([
            ...item.failureCategories,
            "verification-failed",
          ]);
        }
      }
    }

    item.logicalBytesRemoved =
      item.postCleanupLogicalBytes === null
        ? 0
        : Math.max(0, before.logicalBytes - item.postCleanupLogicalBytes);
    item.estimatedAllocatedBytesAddressed = before.estimatedReclaimableBytes;
    const successfulOperations =
      operations.filesSuccessfullyUnlinked +
      operations.directoriesSuccessfullyRemoved +
      operations.reparseObjectsSuccessfullyRemoved;
    const strictSuccess =
      item.postCleanupRootExists === false &&
      operations.skippedEntries === 0 &&
      operations.failedEntries === 0 &&
      item.verificationCompleted;
    if (strictSuccess) {
      item.attemptStatus = "deleted";
      item.message = "Deleted and verified. The exact root no longer exists.";
    } else if (
      successfulOperations > 0 ||
      item.postCleanupRootExists === true ||
      operations.skippedEntries > 0 ||
      !item.verificationCompleted
    ) {
      item.attemptStatus = "partial";
      item.message =
        operations.lockedBytesSkipped > 0
          ? "Cleaned unlocked files. Windows kept files that were still locked."
          : "Cleanup was only partial or could not be verified completely.";
    } else {
      item.attemptStatus = "failed";
      item.message =
        "Cleanup was attempted, but no reliable successful result was achieved.";
    }
    return item;
  }
}

function selectProtectedMarkers(
  candidate: CleanerDetectorCandidate,
  measurement: CleanerMeasuredSize,
): string[] {
  return candidate.protectedMarkerScope === "root-children"
    ? measurement.rootProtectedMarkers
    : measurement.protectedMarkers;
}

export async function deleteExactTree(
  filesystem: CleanerFilesystem,
  targetPath: string,
): Promise<DeleteExactTreeResult> {
  const result: DeleteExactTreeResult = {
    filesAttempted: 0,
    filesSuccessfullyUnlinked: 0,
    directoriesAttempted: 0,
    directoriesSuccessfullyRemoved: 0,
    reparseObjectsSuccessfullyRemoved: 0,
    skippedEntries: 0,
    lockedBytesSkipped: 0,
    failedEntries: 0,
    failureCategories: [],
    skippedReparsePoints: 0,
  };
  let processed = 0;

  const removeEntry = async (currentPath: string): Promise<void> => {
    let stat: CleanerFileStat;
    try {
      stat = await filesystem.lstat(currentPath);
    } catch (error) {
      result.skippedEntries += 1;
      result.failureCategories.push(classifyFilesystemFailure(error));
      return;
    }

    if (stat.isSymbolicLink || stat.isReparsePoint) {
      try {
        await filesystem.removeReparsePoint(currentPath);
        result.reparseObjectsSuccessfullyRemoved += 1;
      } catch (error) {
        const category = classifyRemovalFailure(
          error,
          "reparse-removal-failed",
        );
        if (category === "locked") result.skippedEntries += 1;
        else result.failedEntries += 1;
        result.skippedReparsePoints += 1;
        result.failureCategories.push(category);
      }
      return;
    }

    if (stat.isFile) {
      result.filesAttempted += 1;
      try {
        await filesystem.unlink(currentPath);
        result.filesSuccessfullyUnlinked += 1;
      } catch (error) {
        const category = classifyRemovalFailure(error);
        if (category === "locked") {
          result.skippedEntries += 1;
          result.lockedBytesSkipped += Math.max(0, stat.size);
        } else {
          result.failedEntries += 1;
        }
        result.failureCategories.push(category);
      }
      return;
    }

    if (!stat.isDirectory) {
      result.skippedEntries += 1;
      result.failureCategories.push("filesystem-error");
      return;
    }

    try {
      for await (const entries of readDirectoryBatches(
        filesystem,
        currentPath,
      )) {
        for (const entry of entries) {
          await removeEntry(path.join(currentPath, entry.name));
          processed += 1;
          if (processed % 128 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      }
    } catch (error) {
      result.skippedEntries += 1;
      result.failureCategories.push(classifyFilesystemFailure(error));
    }

    result.directoriesAttempted += 1;
    try {
      await filesystem.removeDirectory(currentPath);
      result.directoriesSuccessfullyRemoved += 1;
    } catch (error) {
      const category = classifyRemovalFailure(error);
      if (category === "locked" || category === "not-empty") {
        result.skippedEntries += 1;
      } else {
        result.failedEntries += 1;
      }
      result.failureCategories.push(category);
    }
  };

  await removeEntry(targetPath);
  result.failureCategories = uniqueFailureCategories(result.failureCategories);
  return result;
}

function validateSelectedFindings(
  findings: CleanerFinding[],
  input: CleanCleanerFindingsInput,
): void {
  if (new Set(input.findingIds).size !== input.findingIds.length) {
    throw new Error("Duplicate Cleaner finding identifiers are not allowed.");
  }
  if (
    findings.some((finding) => finding.safety === "conditional") &&
    input.confirmation === "safe"
  ) {
    throw new Error(
      "Conditional Cleaner findings require stronger confirmation.",
    );
  }
  const approvedManualReviewFindingIds = new Set(
    input.approvedManualReviewFindingIds ?? [],
  );
  const approvedInUseFindingIds = new Set(input.approvedInUseFindingIds ?? []);
  const selectedManualReviewFindingIds = findings
    .filter((finding) => finding.safety === "manual-review")
    .map((finding) => finding.id);
  if (selectedManualReviewFindingIds.length > 0) {
    if (input.confirmation !== "manual-review") {
      throw new Error(
        "Manual-review Cleaner findings require manual-review confirmation.",
      );
    }
    if (
      selectedManualReviewFindingIds.some(
        (findingId) => !approvedManualReviewFindingIds.has(findingId),
      ) ||
      approvedManualReviewFindingIds.size !==
        selectedManualReviewFindingIds.length
    ) {
      throw new Error(
        "Every selected manual-review finding must be explicitly approved.",
      );
    }
  } else if (approvedManualReviewFindingIds.size > 0) {
    throw new Error(
      "Manual-review approvals do not match the selected Cleaner findings.",
    );
  }
  if (
    [...approvedInUseFindingIds].some(
      (findingId) => !input.findingIds.includes(findingId),
    )
  ) {
    throw new Error(
      "In-use approvals do not match the selected Cleaner findings.",
    );
  }
  for (const finding of findings) {
    if (finding.safety === "protected") {
      throw new Error("Protected Cleaner findings cannot be selected.");
    }
    const cleanupUnavailable =
      finding.safety === "manual-review"
        ? !finding.manualApprovalAllowed
        : !finding.canDelete ||
          finding.measurementCompleteness !== "complete" ||
          finding.estimatedReclaimableBytes === null;
    if (cleanupUnavailable) {
      throw new Error(
        "This Cleaner finding is incomplete or is not eligible for cleanup.",
      );
    }
    if (finding.excluded) {
      throw new Error("Excluded Cleaner findings cannot be deleted.");
    }
  }
}

export function resolveOverlappingSelectedFindings(
  findings: CleanerFinding[],
): { resolved: CleanerFinding[]; overlapSkippedIds: Set<string> } {
  const resolved: CleanerFinding[] = [];
  const overlapSkippedIds = new Set<string>();
  for (const finding of [...findings].sort(
    (left, right) => left.normalizedPath.length - right.normalizedPath.length,
  )) {
    if (
      resolved.some((parent) => isWindowsPathInside(finding.path, parent.path))
    ) {
      overlapSkippedIds.add(finding.id);
      continue;
    }
    resolved.push(finding);
  }
  return { resolved, overlapSkippedIds };
}

function createInitialReceiptFinding(
  finding: CleanerFinding,
  overlapSkipped: boolean,
): CleanerCleanupReceiptFinding {
  return {
    findingId: finding.id,
    displayName: finding.displayName,
    detectorId: finding.detectorId,
    category: finding.category,
    applicationId: finding.applicationId,
    dataRootId: finding.dataRootId,
    normalizedPath: finding.normalizedPath,
    definitionVersion: finding.definitionVersion,
    preCleanupFingerprint: structuredClone(finding.fingerprint),
    preCleanupSafety: finding.safety,
    preCleanupLogicalBytes: finding.logicalBytes,
    preCleanupAllocatedBytes: finding.allocatedBytes,
    preCleanupEstimatedReclaimableBytes: finding.estimatedReclaimableBytes,
    preCleanupMeasurementCompleteness: finding.measurementCompleteness,
    preCleanupAccountingConfidence: finding.accountingConfidence,
    attemptStatus: overlapSkipped ? "skipped" : "not-attempted",
    filesAttempted: 0,
    filesSuccessfullyUnlinked: 0,
    directoriesAttempted: 0,
    directoriesSuccessfullyRemoved: 0,
    reparseObjectsSuccessfullyRemoved: 0,
    skippedEntryCount: 0,
    lockedBytesSkipped: 0,
    failedEntryCount: 0,
    logicalBytesRemoved: 0,
    estimatedAllocatedBytesAddressed: null,
    postCleanupRootExists: null,
    postCleanupLogicalBytes: null,
    postCleanupAllocatedBytes: null,
    postCleanupEstimatedReclaimableBytes: null,
    postCleanupMeasurementCompleteness: "unavailable",
    stateChangeReason: overlapSkipped
      ? "A selected ancestor already authoritatively covers this target."
      : undefined,
    failureCategories: overlapSkipped ? ["overlap-resolved"] : [],
    verificationCompleted: false,
    message: overlapSkipped
      ? "Not cleaned independently because a selected ancestor covers this path."
      : "Waiting for cleanup preflight.",
  };
}

function skippedReceiptFinding(
  finding: CleanerFinding,
  reason: string,
  category: CleanerCleanupFailureCategory,
  measured?: CleanerMeasuredSize,
): CleanerCleanupReceiptFinding {
  const item = createInitialReceiptFinding(finding, false);
  if (measured) applyPreCleanupMeasurement(item, measured);
  item.attemptStatus = "skipped";
  item.stateChangeReason = reason.slice(0, 256);
  item.failureCategories = [category];
  item.message = reason.slice(0, 512);
  return item;
}

function createUnexpectedFailureReceiptFinding(
  finding: CleanerFinding,
  reason: string,
): CleanerCleanupReceiptFinding {
  const item = createInitialReceiptFinding(finding, false);
  item.attemptStatus = "failed";
  item.stateChangeReason = reason;
  item.failureCategories = ["filesystem-error", "verification-failed"];
  item.failedEntryCount = 1;
  item.message =
    "Cleanup stopped after an unexpected error and could not be verified.";
  return item;
}

function applyPreCleanupMeasurement(
  item: CleanerCleanupReceiptFinding,
  measured: CleanerMeasuredSize,
): void {
  item.preCleanupLogicalBytes = measured.logicalBytes;
  item.preCleanupAllocatedBytes = measured.allocatedBytes;
  item.preCleanupEstimatedReclaimableBytes = measured.estimatedReclaimableBytes;
  item.preCleanupMeasurementCompleteness = measured.measurementCompleteness;
  item.preCleanupAccountingConfidence = measured.accountingConfidence;
}

function applyDeleteOperations(
  item: CleanerCleanupReceiptFinding,
  operations: DeleteExactTreeResult,
): void {
  item.filesAttempted = operations.filesAttempted;
  item.filesSuccessfullyUnlinked = operations.filesSuccessfullyUnlinked;
  item.directoriesAttempted = operations.directoriesAttempted;
  item.directoriesSuccessfullyRemoved =
    operations.directoriesSuccessfullyRemoved;
  item.reparseObjectsSuccessfullyRemoved =
    operations.reparseObjectsSuccessfullyRemoved;
  item.skippedEntryCount = operations.skippedEntries;
  item.lockedBytesSkipped = operations.lockedBytesSkipped;
  item.failedEntryCount = operations.failedEntries;
  item.failureCategories = uniqueFailureCategories([
    ...item.failureCategories,
    ...operations.failureCategories,
  ]);
}

function recomputeReceiptAggregates(receipt: CleanerCleanupReceipt): void {
  const resolvedIds = new Set(receipt.resolvedFindingIds);
  const resolvedFindings = receipt.findings.filter((finding) =>
    resolvedIds.has(finding.findingId),
  );
  const attempted = resolvedFindings.filter(
    (finding) =>
      finding.attemptStatus === "deleted" ||
      finding.attemptStatus === "partial" ||
      finding.attemptStatus === "failed",
  );
  receipt.aggregateLogicalBytesAddressed = resolvedFindings.reduce(
    (total, finding) => total + finding.preCleanupLogicalBytes,
    0,
  );
  const allPhysicalKnown = resolvedFindings.every(
    (finding) => finding.preCleanupEstimatedReclaimableBytes !== null,
  );
  receipt.aggregateEstimatedPhysicalBytesReclaimable = allPhysicalKnown
    ? resolvedFindings.reduce(
        (total, finding) =>
          total + (finding.preCleanupEstimatedReclaimableBytes ?? 0),
        0,
      )
    : null;
  receipt.aggregateLogicalBytesRemoved = resolvedFindings.reduce(
    (total, finding) => total + finding.logicalBytesRemoved,
    0,
  );
  receipt.aggregateRemainingLogicalBytes = resolvedFindings.reduce(
    (total, finding) =>
      total +
      (finding.postCleanupLogicalBytes ?? finding.preCleanupLogicalBytes),
    0,
  );
  receipt.aggregateFilesUnlinked = resolvedFindings.reduce(
    (total, finding) => total + finding.filesSuccessfullyUnlinked,
    0,
  );
  receipt.aggregateDirectoriesRemoved = resolvedFindings.reduce(
    (total, finding) => total + finding.directoriesSuccessfullyRemoved,
    0,
  );
  receipt.aggregateReparseObjectsRemoved = resolvedFindings.reduce(
    (total, finding) => total + finding.reparseObjectsSuccessfullyRemoved,
    0,
  );
  receipt.aggregateSkippedEntries = resolvedFindings.reduce(
    (total, finding) => total + finding.skippedEntryCount,
    0,
  );
  receipt.aggregateFailedEntries = resolvedFindings.reduce(
    (total, finding) => total + finding.failedEntryCount,
    0,
  );
  receipt.postCleanupVerificationCompleted =
    attempted.length > 0 &&
    attempted.every((finding) => finding.verificationCompleted);
}

function resolveFinalReceiptStatus(
  receipt: CleanerCleanupReceipt,
  globalFailure: string | undefined,
): CleanerCleanupReceipt["status"] {
  if (globalFailure) {
    return receipt.findings.some(
      (finding) =>
        finding.attemptStatus === "deleted" ||
        finding.attemptStatus === "partial",
    )
      ? "partial"
      : "failed";
  }
  if (
    receipt.findings.every((finding) => finding.attemptStatus === "deleted") &&
    receipt.postCleanupVerificationCompleted
  ) {
    return "completed";
  }
  if (
    receipt.findings.every(
      (finding) =>
        finding.attemptStatus === "failed" ||
        finding.attemptStatus === "not-attempted",
    )
  ) {
    return "failed";
  }
  return "partial";
}

function persistInProgressReceipt(
  persistence: CleanerPersistence,
  receipt: CleanerCleanupReceipt,
): void {
  const state = persistence.read();
  upsertCleanerCleanupReceipt(state, receipt);
  persistence.write(state);
}

function replaceReceiptFinding(
  receipt: CleanerCleanupReceipt,
  item: CleanerCleanupReceiptFinding,
): void {
  const index = receipt.findings.findIndex(
    (existing) => existing.findingId === item.findingId,
  );
  if (index < 0)
    throw new Error("Cleaner receipt finding was not initialized.");
  receipt.findings[index] = item;
}

async function measureDriveSpace(
  provider: CleanerDriveProvider,
  systemDrive: string,
  clock: CleanerClock,
): Promise<CleanerDriveSpaceMeasurement> {
  const measured = await provider.measureFreeSpace(systemDrive);
  return {
    ...measured,
    measuredAt: clock.now(),
  };
}

function toCleanupResult(receipt: CleanerCleanupReceipt): CleanerCleanupResult {
  const items: CleanerCleanupItemResult[] = receipt.findings.map((finding) => ({
    ...finding,
    status:
      finding.attemptStatus === "deleted"
        ? "deleted"
        : finding.attemptStatus === "partial"
          ? "partial"
          : finding.attemptStatus === "skipped" ||
              finding.attemptStatus === "not-attempted"
            ? "skipped"
            : "failed",
    logicalBytesDeleted: finding.logicalBytesRemoved,
    remainingBytes:
      finding.postCleanupLogicalBytes ?? finding.preCleanupLogicalBytes,
    skippedEntries: finding.skippedEntryCount,
  }));
  return {
    ...structuredClone(receipt),
    items,
    logicalBytesDeleted: receipt.aggregateLogicalBytesRemoved,
    freeDiskSpaceBefore: receipt.freeSpaceBefore?.freeBytes ?? 0,
    freeDiskSpaceAfter: receipt.freeSpaceAfter?.freeBytes ?? null,
    freeDiskSpaceBeforeMeasuredAt: receipt.freeSpaceBefore?.measuredAt ?? 0,
    freeDiskSpaceAfterMeasuredAt: receipt.freeSpaceAfter?.measuredAt ?? null,
    observedDriveDifferenceBytes: receipt.signedFreeSpaceDeltaBytes ?? null,
    recoveryExplanation:
      "Logical bytes removed, expected physical recovery, and the signed global drive-space change are separate measurements. Unrelated disk activity can affect the drive change.",
  };
}

function applyReceiptToSession(
  session: CleanerScanSession,
  receipt: CleanerCleanupReceipt,
  afterDrive: CleanerDriveSpaceMeasurement | undefined,
): void {
  if (!session.result || session.status !== "complete") return;
  const deletedRoots = receipt.findings
    .filter((finding) => finding.attemptStatus === "deleted")
    .map((finding) => finding.normalizedPath);
  const receiptByFindingId = new Map(
    receipt.findings.map((finding) => [finding.findingId, finding]),
  );
  session.result.findings = session.result.findings.filter((finding) => {
    const receiptFinding = receiptByFindingId.get(finding.id);
    const coveredByDeletedAncestor = deletedRoots.some(
      (deletedPath) =>
        finding.normalizedPath === deletedPath ||
        isWindowsPathInside(finding.normalizedPath, deletedPath),
    );
    if (coveredByDeletedAncestor) return false;
    if (!receiptFinding) return true;
    finding.selected = false;
    finding.canDelete = false;
    if (
      receiptFinding.postCleanupLogicalBytes !== null &&
      receiptFinding.postCleanupRootExists === true
    ) {
      finding.logicalBytes = receiptFinding.postCleanupLogicalBytes;
      finding.sizeBytes = receiptFinding.postCleanupLogicalBytes;
      finding.allocatedBytes = receiptFinding.postCleanupAllocatedBytes;
      finding.estimatedReclaimableBytes =
        receiptFinding.postCleanupEstimatedReclaimableBytes;
      finding.recoverableBytes = 0;
      finding.measurementCompleteness =
        receiptFinding.postCleanupMeasurementCompleteness;
      finding.sizeMeasurementComplete =
        receiptFinding.postCleanupMeasurementCompleteness === "complete";
    }
    finding.safety = "manual-review";
    finding.manualApprovalAllowed = false;
    finding.accountingActionabilityBlocked = true;
    finding.reason = `${finding.reason} Cleanup state changed. Run a new scan before selecting this finding again.`;
    return true;
  });
  session.findings.clear();
  for (const finding of session.result.findings) {
    session.findings.set(finding.id, finding);
  }
  const summary = session.result.summary;
  summary.safeNowBytes = calculateNonExcludedSafetyBytes(
    session.result.findings,
    "safe-now",
  );
  summary.safeAfterCloseBytes = calculateNonExcludedSafetyBytes(
    session.result.findings,
    "safe-after-close",
  );
  summary.conditionalBytes = calculateNonExcludedSafetyBytes(
    session.result.findings,
    "conditional",
  );
  summary.protectedBytes = calculateNonExcludedSafetyBytes(
    session.result.findings,
    "protected",
  );
  summary.manualReviewBytes = calculateNonExcludedSafetyBytes(
    session.result.findings,
    "manual-review",
  );
  summary.excludedBytes = calculateUnionLogicalBytes(
    session.result.findings.filter((finding) => finding.excluded),
  );
  summary.estimatedRecoverableBytes = calculateUnionRecoverableBytes(
    session.result.findings,
    "safe-now",
  );
  summary.conditionalRecoverableBytes = calculateUnionRecoverableBytes(
    session.result.findings,
    "conditional",
  );
  summary.unknownRecoverableFindingCount = session.result.findings.filter(
    (finding) => !finding.excluded && finding.accountingActionabilityBlocked,
  ).length;
  summary.unknownRecoverableLogicalBytes = calculateUnionLogicalBytes(
    session.result.findings.filter(
      (finding) => !finding.excluded && finding.accountingActionabilityBlocked,
    ),
  );
  summary.partialLogicalBytes = calculateUnionLogicalBytes(
    session.result.findings.filter(
      (finding) =>
        !finding.excluded && finding.measurementCompleteness !== "complete",
    ),
  );
  if (afterDrive) {
    summary.freeDiskSpaceBytes = afterDrive.freeBytes;
    summary.freeDiskSpaceMeasuredAt = afterDrive.measuredAt;
    summary.freeSpaceIsStale = false;
  }
}

async function* readDirectoryBatches(
  filesystem: CleanerFilesystem,
  targetPath: string,
): AsyncIterable<import("./types").CleanerDirectoryEntry[]> {
  if (filesystem.readDirectoryBatches) {
    yield* filesystem.readDirectoryBatches(targetPath, 256);
    return;
  }
  yield await filesystem.readDirectory(targetPath);
}

function fingerprintFromStat(
  stat: CleanerFileStat,
): import("./types").CleanerPathFingerprint {
  return {
    kind: stat.isDirectory ? "directory" : "file",
    device: stat.device,
    inode: stat.inode,
    modifiedMs: stat.modifiedMs,
    reparsePoint: stat.isSymbolicLink || stat.isReparsePoint,
  };
}

function classifyFilesystemFailure(
  error: unknown,
  fallback: CleanerCleanupFailureCategory = "filesystem-error",
): CleanerCleanupFailureCategory {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "EACCES" || code === "EPERM") return "access-denied";
  if (code === "EBUSY") return "locked";
  if (code === "ENOTEMPTY") return "not-empty";
  return fallback;
}

function classifyRemovalFailure(
  error: unknown,
  fallback: CleanerCleanupFailureCategory = "filesystem-error",
): CleanerCleanupFailureCategory {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "EPERM") return "locked";
  return classifyFilesystemFailure(error, fallback);
}

function isMissingFilesystemError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function uniqueFailureCategories(
  values: CleanerCleanupFailureCategory[],
): CleanerCleanupFailureCategory[] {
  return [...new Set(values)].slice(0, 8);
}

function sanitizeGlobalFailure(error: unknown): string {
  if (error instanceof Error) {
    const category = classifyFilesystemFailure(error);
    return `Cleanup stopped because of a ${category.replaceAll("-", " ")} error.`;
  }
  return "Cleanup stopped because of an unexpected filesystem error.";
}
