import path from "node:path";
import type {
  CleanerAccountingConfidence,
  CleanerFileStat,
  CleanerFilesystem,
  CleanerMeasurementCompleteness,
  CleanerMeasurementFailureCategory,
  CleanerMeasurementLimitReason,
  CleanerReparsePointStatus,
  CleanerSizeAccounting,
} from "./types";
import type { CleanerCancellationToken } from "./cancellation";
import {
  DEEP_EXHAUSTIVE_MEASUREMENT_POLICY,
  type CleanerMeasurementPolicy,
} from "./measurement-policy";
import { isCleanerProtectedMarkerName } from "./protected-markers";

export type CleanerMeasuredSize = CleanerSizeAccounting & {
  sizeBytes: number;
  fileCount: number;
  inaccessibleEntries: number;
  reparsePointStatus: CleanerReparsePointStatus;
  complete: boolean;
  inspectedEntries: number;
  protectedMarkers: string[];
  rootProtectedMarkers: string[];
  internalReparsePointCount: number;
  rootStat?: CleanerFileStat;
};

export type CleanerMeasurementProgress = {
  inspectedEntries: number;
  measuredFileCount: number;
  measuredDirectoryCount: number;
  uniqueFileRecords: number;
  logicalBytes: number;
  elapsedMs: number;
};

export type CleanerSizeCalculatorOptions = {
  policy: CleanerMeasurementPolicy;
  onProgress?(progress: CleanerMeasurementProgress): void;
};

type FileRecordAccounting = {
  allocatedBytes: number | null;
  allocationConfidence: "exact" | "estimated" | "unknown";
  totalHardlinkCount: number;
  observedLinks: number;
};

type PhysicalAccountingInput = {
  hardlinkRecords: Map<string, FileRecordAccounting>;
  singletonUniqueAllocatedBytes: number;
  singletonReclaimableBytes: number;
  unknownUniqueAllocation: boolean;
  unknownLinkOwnership: boolean;
  allAllocationExact: boolean;
  completeness: CleanerMeasurementCompleteness;
  metadataLimitReached: boolean;
};

const FAILURE_PRIORITY: CleanerMeasurementFailureCategory[] = [
  "access-denied",
  "path-disappeared",
  "filesystem-instability",
  "filesystem-io",
  "unsupported-filesystem-metadata",
  "worker-failed",
];

export class CleanerSizeCalculator {
  private readonly cache = new Map<string, CleanerMeasuredSize>();
  private readonly options: CleanerSizeCalculatorOptions;

  constructor(
    private readonly filesystem: CleanerFilesystem,
    private readonly cancellation: CleanerCancellationToken,
    options?: CleanerSizeCalculatorOptions,
  ) {
    this.options = options ?? {
      policy: DEEP_EXHAUSTIVE_MEASUREMENT_POLICY,
    };
  }

  async measure(targetPath: string): Promise<CleanerMeasuredSize> {
    const cacheKey = path.win32.normalize(targetPath).toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const measured = await this.walk(targetPath);
    const sizeOverride = await this.filesystem.getSizeOverride(targetPath);
    const accountingOverride = await this.filesystem.getAccountingOverride?.(
      targetPath,
      this.options.policy.kind,
    );
    const result = applyFixtureAccountingOverride(
      measured,
      sizeOverride,
      accountingOverride,
    );
    this.cache.set(cacheKey, result);
    return result;
  }

  private async walk(targetPath: string): Promise<CleanerMeasuredSize> {
    const measurementStartedAt = Date.now();
    const normalizedTargetPath = path.win32.normalize(targetPath).toLowerCase();
    const policy = this.options.policy;
    const bounded = policy.kind === "standard-bounded";
    const maxEntries =
      policy.kind === "standard-bounded" ? policy.maxEntries : undefined;
    const maxDurationMs =
      policy.kind === "standard-bounded" ? policy.maxDurationMs : undefined;
    const maxTrackedFileRecords =
      policy.kind === "standard-bounded"
        ? policy.maxTrackedFileRecords
        : undefined;
    const allocationUnit =
      await this.filesystem.getAllocationUnit?.(targetPath);

    let logicalBytes = 0;
    let pathAllocatedBytes = 0;
    let everyPathAllocationKnown = true;
    let measuredFileCount = 0;
    let measuredDirectoryCount = 0;
    let inaccessibleEntryCount = 0;
    let inspectedEntryCount = 0;
    let containsReparsePoint = false;
    let internalReparsePointCount = 0;
    let sparseFileCount = 0;
    let compressedFileCount = 0;
    let sparseMetadataComplete = true;
    let compressedMetadataComplete = true;
    let measurementLimitReason: CleanerMeasurementLimitReason | undefined;
    let metadataLimitReached = false;
    let singletonUniqueAllocatedBytes = 0;
    let singletonReclaimableBytes = 0;
    let singletonRecordCount = 0;
    let unknownUniqueAllocation = false;
    let unknownLinkOwnership = false;
    let allAllocationExact = true;
    const directoryStack: string[] = [];
    const hardlinkRecords = new Map<string, FileRecordAccounting>();
    const protectedMarkers = new Set<string>();
    const rootProtectedMarkers = new Set<string>();
    const failureCategories = new Set<CleanerMeasurementFailureCategory>();

    const uniqueRecordCount = (): number =>
      singletonRecordCount + hardlinkRecords.size;

    const emitProgress = (): void => {
      this.options.onProgress?.({
        inspectedEntries: inspectedEntryCount,
        measuredFileCount,
        measuredDirectoryCount,
        uniqueFileRecords: uniqueRecordCount(),
        logicalBytes,
        elapsedMs: Math.max(0, Date.now() - measurementStartedAt),
      });
    };

    const overLimit = (): boolean => {
      if (!bounded) return false;
      if (maxEntries !== undefined && inspectedEntryCount >= maxEntries) {
        measurementLimitReason = "entry-limit";
        return true;
      }
      if (
        maxDurationMs !== undefined &&
        Date.now() - measurementStartedAt >= maxDurationMs
      ) {
        measurementLimitReason = "duration-limit";
        return true;
      }
      return false;
    };

    const recordFile = (stat: CleanerFileStat): void => {
      const allocated = resolveAllocatedBytes(stat, allocationUnit);
      if (allocated.bytes === null) {
        everyPathAllocationKnown = false;
        allAllocationExact = false;
      } else {
        pathAllocatedBytes += allocated.bytes;
      }
      if (allocated.confidence !== "exact") allAllocationExact = false;

      const hardlinkCount =
        stat.hardlinkCount !== undefined && stat.hardlinkCount >= 1
          ? stat.hardlinkCount
          : null;
      const hasIdentity =
        stat.volumeIdentity !== undefined && stat.fileIdentity !== undefined;
      if (hardlinkCount === 1 && hasIdentity) {
        singletonRecordCount += 1;
        if (allocated.bytes === null) {
          unknownUniqueAllocation = true;
        } else {
          singletonUniqueAllocatedBytes += allocated.bytes;
          singletonReclaimableBytes += allocated.bytes;
        }
        return;
      }

      if (hardlinkCount === null || !hasIdentity) {
        unknownUniqueAllocation = true;
        unknownLinkOwnership = true;
        return;
      }

      const recordKey = `${stat.volumeIdentity}\0${stat.fileIdentity}`;
      const existing = hardlinkRecords.get(recordKey);
      if (existing) {
        existing.observedLinks += 1;
        return;
      }
      if (
        maxTrackedFileRecords !== undefined &&
        hardlinkRecords.size >= maxTrackedFileRecords
      ) {
        metadataLimitReached = true;
        unknownUniqueAllocation = true;
        unknownLinkOwnership = true;
        return;
      }
      hardlinkRecords.set(recordKey, {
        allocatedBytes: allocated.bytes,
        allocationConfidence: allocated.confidence,
        totalHardlinkCount: hardlinkCount,
        observedLinks: 1,
      });
    };

    const inspectPath = async (
      currentPath: string,
      root = false,
    ): Promise<CleanerFileStat | undefined> => {
      this.cancellation.throwIfCancelled();
      if (overLimit()) return undefined;
      try {
        const stat = await this.filesystem.lstat(currentPath);
        inspectedEntryCount += 1;
        if (stat.isSymbolicLink || stat.isReparsePoint) {
          containsReparsePoint = true;
          if (!root) internalReparsePointCount += 1;
          return stat;
        }
        if (stat.isDirectory) {
          measuredDirectoryCount += 1;
          directoryStack.push(currentPath);
          return stat;
        }
        if (stat.isFile) {
          measuredFileCount += 1;
          logicalBytes += Math.max(0, stat.size);
          if (stat.sparse === true) sparseFileCount += 1;
          if (stat.sparse === undefined) sparseMetadataComplete = false;
          if (stat.compressed === true) compressedFileCount += 1;
          if (stat.compressed === undefined) compressedMetadataComplete = false;
          recordFile(stat);
          return stat;
        }
        return stat;
      } catch (error) {
        inspectedEntryCount += 1;
        inaccessibleEntryCount += 1;
        failureCategories.add(classifyFilesystemFailure(error));
        return undefined;
      } finally {
        if (inspectedEntryCount > 0 && inspectedEntryCount % 128 === 0) {
          emitProgress();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    };

    const rootStat = await inspectPath(targetPath, true);
    const rootUnavailable =
      rootStat === undefined &&
      inaccessibleEntryCount > 0 &&
      inspectedEntryCount === 1;

    let stoppedEarly = measurementLimitReason !== undefined;
    while (directoryStack.length > 0 && !stoppedEarly) {
      this.cancellation.throwIfCancelled();
      const currentDirectory = directoryStack.pop()!;
      const currentDirectoryIsRoot =
        path.win32.normalize(currentDirectory).toLowerCase() ===
        normalizedTargetPath;
      let batches: AsyncIterable<import("./types").CleanerDirectoryEntry[]>;
      try {
        batches = readDirectoryBatches(this.filesystem, currentDirectory);
        for await (const entries of batches) {
          for (const entry of entries) {
            if (isCleanerProtectedMarkerName(entry.name)) {
              protectedMarkers.add(entry.name);
              if (currentDirectoryIsRoot) {
                rootProtectedMarkers.add(entry.name);
              }
            }
            if (overLimit()) {
              stoppedEarly = true;
              break;
            }
            await inspectPath(path.join(currentDirectory, entry.name));
            if (measurementLimitReason) {
              stoppedEarly = true;
              break;
            }
          }
          if (stoppedEarly) break;
        }
      } catch (error) {
        inaccessibleEntryCount += 1;
        failureCategories.add(classifyFilesystemFailure(error));
      }
    }

    if (
      !rootUnavailable &&
      !stoppedEarly &&
      this.options.policy.kind === "deep-exhaustive"
    ) {
      this.cancellation.throwIfCancelled();
      try {
        const finalRootStat = await this.filesystem.lstat(targetPath);
        if (rootStat && rootSnapshotChanged(rootStat, finalRootStat)) {
          failureCategories.add("filesystem-instability");
        }
      } catch (error) {
        failureCategories.add(classifyFilesystemFailure(error));
        inaccessibleEntryCount += 1;
      }
    }

    if (!measurementLimitReason && metadataLimitReached) {
      measurementLimitReason = "metadata-limit";
    } else if (!measurementLimitReason && inaccessibleEntryCount > 0) {
      measurementLimitReason = "inaccessible-entries";
    }

    const measurementCompleteness: CleanerMeasurementCompleteness =
      rootUnavailable
        ? "unavailable"
        : stoppedEarly ||
            metadataLimitReached ||
            inaccessibleEntryCount > 0 ||
            failureCategories.has("filesystem-instability")
          ? "partial"
          : "complete";
    const physical = finalizePhysicalAccounting({
      hardlinkRecords,
      singletonUniqueAllocatedBytes,
      singletonReclaimableBytes,
      unknownUniqueAllocation,
      unknownLinkOwnership,
      allAllocationExact,
      completeness: measurementCompleteness,
      metadataLimitReached,
    });
    if (
      measurementCompleteness === "complete" &&
      physical.estimatedReclaimableBytes === null
    ) {
      failureCategories.add("unsupported-filesystem-metadata");
    }
    const measurementCompletedAt = Date.now();
    const accountingConfidence = resolveAccountingConfidence(
      measurementCompleteness,
      physical.estimatedReclaimableBytes,
      physical.allAllocationExact,
    );
    const measurementFailureCategory =
      selectMeasurementFailure(failureCategories);

    emitProgress();
    return {
      logicalBytes,
      allocatedBytes: everyPathAllocationKnown ? pathAllocatedBytes : null,
      uniqueAllocatedBytes: physical.uniqueAllocatedBytes,
      estimatedReclaimableBytes: physical.estimatedReclaimableBytes,
      reclaimableLowerBoundBytes: physical.reclaimableLowerBoundBytes,
      reclaimableUpperBoundBytes: physical.reclaimableUpperBoundBytes,
      measurementCompleteness,
      accountingConfidence,
      hardlinkRecordCount: hardlinkRecords.size,
      externalHardlinkRecordCount: physical.externalHardlinkRecordCount,
      sparseFileCount: sparseMetadataComplete ? sparseFileCount : null,
      compressedFileCount: compressedMetadataComplete
        ? compressedFileCount
        : null,
      measuredFileCount,
      measuredDirectoryCount,
      inaccessibleEntryCount,
      inspectedEntryCount,
      measurementStartedAt,
      measurementCompletedAt,
      measurementDurationMs: Math.max(
        0,
        measurementCompletedAt - measurementStartedAt,
      ),
      measurementLimitReason:
        physical.estimatedReclaimableBytes === null &&
        measurementCompleteness === "complete" &&
        !measurementLimitReason
          ? "metadata-unavailable"
          : measurementLimitReason,
      logicalTraversalComplete: measurementCompleteness === "complete",
      physicalAccountingComplete:
        measurementCompleteness === "complete" &&
        physical.estimatedReclaimableBytes !== null,
      measurementFailureCategory,
      measurementFailureExplanation: measurementFailureCategory
        ? failureExplanation(measurementFailureCategory)
        : undefined,
      sizeBytes: logicalBytes,
      fileCount: measuredFileCount,
      inaccessibleEntries: inaccessibleEntryCount,
      reparsePointStatus: containsReparsePoint
        ? "contains-reparse-point"
        : rootUnavailable
          ? "unknown"
          : "clear",
      complete: measurementCompleteness === "complete",
      inspectedEntries: inspectedEntryCount,
      protectedMarkers: [...protectedMarkers].slice(0, 32),
      rootProtectedMarkers: [...rootProtectedMarkers].slice(0, 32),
      internalReparsePointCount,
      rootStat,
    };
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

function resolveAllocatedBytes(
  stat: CleanerFileStat,
  allocationUnit: number | undefined,
): {
  bytes: number | null;
  confidence: "exact" | "estimated" | "unknown";
} {
  if (stat.allocatedBytes !== undefined) {
    return {
      bytes: Math.max(0, stat.allocatedBytes),
      confidence: stat.allocationConfidence ?? "estimated",
    };
  }
  if (allocationUnit && allocationUnit > 0) {
    return {
      bytes:
        stat.size === 0
          ? 0
          : Math.ceil(Math.max(0, stat.size) / allocationUnit) * allocationUnit,
      confidence: "estimated",
    };
  }
  return { bytes: null, confidence: "unknown" };
}

function finalizePhysicalAccounting(input: PhysicalAccountingInput): {
  uniqueAllocatedBytes: number | null;
  estimatedReclaimableBytes: number | null;
  reclaimableLowerBoundBytes: number;
  reclaimableUpperBoundBytes: number | null;
  externalHardlinkRecordCount: number;
  allAllocationExact: boolean;
} {
  let uniqueAllocatedBytes = input.singletonUniqueAllocatedBytes;
  let reclaimableLowerBoundBytes = input.singletonReclaimableBytes;
  let reclaimableUpperBoundBytes = input.singletonReclaimableBytes;
  let externalHardlinkRecordCount = 0;
  let uniqueAllocationKnown = !input.unknownUniqueAllocation;
  let linkOwnershipKnown = !input.unknownLinkOwnership;
  let upperBoundKnown = true;
  let allAllocationExact = input.allAllocationExact;

  for (const record of input.hardlinkRecords.values()) {
    if (record.allocatedBytes === null) {
      uniqueAllocationKnown = false;
      upperBoundKnown = false;
      allAllocationExact = false;
    } else {
      uniqueAllocatedBytes += record.allocatedBytes;
      reclaimableUpperBoundBytes += record.allocatedBytes;
    }
    if (record.allocationConfidence !== "exact") allAllocationExact = false;
    if (input.completeness !== "complete") continue;
    if (record.totalHardlinkCount > record.observedLinks) {
      externalHardlinkRecordCount += 1;
      continue;
    }
    if (record.totalHardlinkCount < record.observedLinks) {
      linkOwnershipKnown = false;
      continue;
    }
    if (record.allocatedBytes !== null) {
      reclaimableLowerBoundBytes += record.allocatedBytes;
    }
  }

  const physicalComplete =
    input.completeness === "complete" &&
    uniqueAllocationKnown &&
    linkOwnershipKnown &&
    !input.metadataLimitReached;
  return {
    uniqueAllocatedBytes: uniqueAllocationKnown ? uniqueAllocatedBytes : null,
    estimatedReclaimableBytes: physicalComplete
      ? reclaimableLowerBoundBytes
      : null,
    reclaimableLowerBoundBytes:
      input.completeness === "complete" ? reclaimableLowerBoundBytes : 0,
    reclaimableUpperBoundBytes: upperBoundKnown
      ? reclaimableUpperBoundBytes
      : null,
    externalHardlinkRecordCount:
      input.completeness === "complete" ? externalHardlinkRecordCount : 0,
    allAllocationExact,
  };
}

function resolveAccountingConfidence(
  completeness: CleanerMeasurementCompleteness,
  estimatedReclaimableBytes: number | null,
  allAllocationExact: boolean,
): CleanerAccountingConfidence {
  if (completeness === "unavailable") return "unknown";
  if (completeness === "partial") return "lower-bound";
  if (estimatedReclaimableBytes === null) return "unknown";
  return allAllocationExact ? "exact" : "estimated";
}

function classifyFilesystemFailure(
  error: unknown,
): CleanerMeasurementFailureCategory {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
  if (code === "EACCES" || code === "EPERM") return "access-denied";
  if (code === "ENOENT" || code === "ENOTDIR") return "path-disappeared";
  return "filesystem-io";
}

function selectMeasurementFailure(
  failures: Set<CleanerMeasurementFailureCategory>,
): CleanerMeasurementFailureCategory | undefined {
  return FAILURE_PRIORITY.find((failure) => failures.has(failure));
}

function failureExplanation(
  category: CleanerMeasurementFailureCategory,
): string {
  switch (category) {
    case "access-denied":
      return "One or more entries could not be read because access was denied.";
    case "path-disappeared":
      return "The recognized target or one of its entries disappeared during measurement.";
    case "filesystem-instability":
      return "The recognized target changed while it was being measured.";
    case "unsupported-filesystem-metadata":
      return "The filesystem did not provide enough allocation or hardlink metadata for physical-recovery accounting.";
    case "worker-failed":
      return "The background accounting worker stopped unexpectedly.";
    default:
      return "A filesystem input or output operation failed during measurement.";
  }
}

function rootSnapshotChanged(
  before: CleanerFileStat,
  after: CleanerFileStat,
): boolean {
  return (
    before.isDirectory !== after.isDirectory ||
    before.isFile !== after.isFile ||
    before.isSymbolicLink !== after.isSymbolicLink ||
    before.isReparsePoint !== after.isReparsePoint ||
    before.device !== after.device ||
    before.inode !== after.inode ||
    before.modifiedMs !== after.modifiedMs
  );
}

function applyFixtureAccountingOverride(
  measured: CleanerMeasuredSize,
  sizeOverride: number | undefined,
  accountingOverride: Partial<CleanerSizeAccounting> | undefined,
): CleanerMeasuredSize {
  if (sizeOverride === undefined && accountingOverride === undefined) {
    return measured;
  }

  const logicalBytes = accountingOverride?.logicalBytes ?? sizeOverride;
  const normalizedLogicalBytes =
    logicalBytes === undefined ? measured.logicalBytes : logicalBytes;
  const syntheticPhysicalDefault =
    sizeOverride !== undefined && accountingOverride === undefined
      ? sizeOverride
      : undefined;
  const merged: CleanerSizeAccounting = {
    ...measured,
    ...accountingOverride,
    logicalBytes: normalizedLogicalBytes,
    allocatedBytes: hasAccountingOverride(accountingOverride, "allocatedBytes")
      ? accountingOverride.allocatedBytes!
      : (syntheticPhysicalDefault ?? measured.allocatedBytes),
    uniqueAllocatedBytes: hasAccountingOverride(
      accountingOverride,
      "uniqueAllocatedBytes",
    )
      ? accountingOverride.uniqueAllocatedBytes!
      : (syntheticPhysicalDefault ?? measured.uniqueAllocatedBytes),
    estimatedReclaimableBytes: hasAccountingOverride(
      accountingOverride,
      "estimatedReclaimableBytes",
    )
      ? accountingOverride.estimatedReclaimableBytes!
      : (syntheticPhysicalDefault ?? measured.estimatedReclaimableBytes),
    reclaimableLowerBoundBytes:
      accountingOverride?.reclaimableLowerBoundBytes ??
      syntheticPhysicalDefault ??
      measured.reclaimableLowerBoundBytes,
    reclaimableUpperBoundBytes:
      accountingOverride?.reclaimableUpperBoundBytes ??
      syntheticPhysicalDefault ??
      measured.reclaimableUpperBoundBytes,
    accountingConfidence:
      accountingOverride?.accountingConfidence ??
      (syntheticPhysicalDefault === undefined
        ? measured.accountingConfidence
        : "exact"),
    logicalTraversalComplete:
      accountingOverride?.logicalTraversalComplete ??
      (accountingOverride?.measurementCompleteness === undefined
        ? measured.logicalTraversalComplete
        : accountingOverride.measurementCompleteness === "complete"),
    physicalAccountingComplete:
      accountingOverride?.physicalAccountingComplete ??
      (accountingOverride?.measurementCompleteness === undefined
        ? measured.physicalAccountingComplete
        : accountingOverride.measurementCompleteness === "complete" &&
          accountingOverride.estimatedReclaimableBytes !== null),
  };
  const complete = merged.measurementCompleteness === "complete";
  return {
    ...merged,
    sizeBytes: merged.logicalBytes,
    fileCount: merged.measuredFileCount,
    inaccessibleEntries: merged.inaccessibleEntryCount,
    reparsePointStatus: measured.reparsePointStatus,
    complete,
    inspectedEntries: merged.inspectedEntryCount,
    protectedMarkers: measured.protectedMarkers,
    rootProtectedMarkers: measured.rootProtectedMarkers,
    internalReparsePointCount: measured.internalReparsePointCount,
    rootStat: measured.rootStat,
  };
}

function hasAccountingOverride<K extends keyof CleanerSizeAccounting>(
  override: Partial<CleanerSizeAccounting> | undefined,
  key: K,
): override is Partial<CleanerSizeAccounting> & Pick<CleanerSizeAccounting, K> {
  return override !== undefined && Object.hasOwn(override, key);
}
