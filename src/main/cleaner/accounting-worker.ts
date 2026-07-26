import type { CleanerCancellationToken } from "./cancellation";
import {
  CleanerSizeCalculator,
  type CleanerMeasuredSize,
  type CleanerMeasurementProgress,
} from "./size-calculator";
import type { CleanerFilesystem } from "./types";
import { DEEP_EXHAUSTIVE_MEASUREMENT_POLICY } from "./measurement-policy";

export class CleanerAccountingWorkerFailure extends Error {
  constructor(message = "The background accounting worker failed.") {
    super(message);
    this.name = "CleanerAccountingWorkerFailure";
  }
}

export interface CleanerAccountingWorkerSession {
  measure(
    targetPath: string,
    cancellation: CleanerCancellationToken,
    onProgress?: (progress: CleanerMeasurementProgress) => void,
  ): Promise<CleanerMeasuredSize>;
  close(): Promise<void>;
}

export interface CleanerAccountingWorkerFactory {
  create(): CleanerAccountingWorkerSession;
}

export class InProcessCleanerAccountingWorkerFactory implements CleanerAccountingWorkerFactory {
  constructor(private readonly filesystem: CleanerFilesystem) {}

  create(): CleanerAccountingWorkerSession {
    return new InProcessCleanerAccountingWorkerSession(this.filesystem);
  }
}

class InProcessCleanerAccountingWorkerSession implements CleanerAccountingWorkerSession {
  constructor(private readonly filesystem: CleanerFilesystem) {}

  measure(
    targetPath: string,
    cancellation: CleanerCancellationToken,
    onProgress?: (progress: CleanerMeasurementProgress) => void,
  ): Promise<CleanerMeasuredSize> {
    return new CleanerSizeCalculator(this.filesystem, cancellation, {
      policy: DEEP_EXHAUSTIVE_MEASUREMENT_POLICY,
      onProgress,
    }).measure(targetPath);
  }

  async close(): Promise<void> {}
}

export function createWorkerFailureMeasurement(
  now: number,
): CleanerMeasuredSize {
  return {
    logicalBytes: 0,
    allocatedBytes: null,
    uniqueAllocatedBytes: null,
    estimatedReclaimableBytes: null,
    reclaimableLowerBoundBytes: 0,
    reclaimableUpperBoundBytes: null,
    measurementCompleteness: "unavailable",
    accountingConfidence: "unknown",
    hardlinkRecordCount: 0,
    externalHardlinkRecordCount: 0,
    sparseFileCount: null,
    compressedFileCount: null,
    measuredFileCount: 0,
    measuredDirectoryCount: 0,
    inaccessibleEntryCount: 0,
    inspectedEntryCount: 0,
    measurementStartedAt: now,
    measurementCompletedAt: now,
    measurementDurationMs: 0,
    logicalTraversalComplete: false,
    physicalAccountingComplete: false,
    measurementFailureCategory: "worker-failed",
    measurementFailureExplanation:
      "The background accounting worker stopped unexpectedly.",
    sizeBytes: 0,
    fileCount: 0,
    inaccessibleEntries: 0,
    reparsePointStatus: "unknown",
    complete: false,
    inspectedEntries: 0,
    protectedMarkers: [],
    rootProtectedMarkers: [],
    internalReparsePointCount: 0,
    rootStat: undefined,
  };
}
