export type CleanerPlatform = "win32";

export type CleanerScanMode = "standard" | "deep";

export type CleanerSafety =
  | "safe-now"
  | "safe-after-close"
  | "conditional"
  | "protected"
  | "manual-review";

export type CleanerRecommendation =
  | "recommended"
  | "useful-if-space-low"
  | "low-priority"
  | "frequently-regenerated"
  | "protected"
  | "manual-review";

export type CleanerRegenerationLabel =
  | "regenerated-quickly"
  | "frequently-regenerates"
  | "grows-slowly"
  | "worth-cleaning-occasionally"
  | "low-cleanup-value"
  | "regeneration-unknown"
  | "not-cleaned-before";

export type CleanerReparsePointStatus =
  "clear" | "contains-reparse-point" | "target-is-reparse-point" | "unknown";

export type CleanerMeasurementCompleteness =
  "complete" | "partial" | "unavailable";

export type CleanerAccountingConfidence =
  "exact" | "estimated" | "lower-bound" | "unknown";

export type CleanerMeasurementLimitReason =
  | "entry-limit"
  | "duration-limit"
  | "inaccessible-entries"
  | "metadata-limit"
  | "metadata-unavailable";

export type CleanerMeasurementFailureCategory =
  | "access-denied"
  | "path-disappeared"
  | "filesystem-io"
  | "unsupported-filesystem-metadata"
  | "filesystem-instability"
  | "worker-failed";

export type CleanerSizeAccounting = {
  logicalBytes: number;
  allocatedBytes: number | null;
  uniqueAllocatedBytes: number | null;
  estimatedReclaimableBytes: number | null;
  reclaimableLowerBoundBytes: number;
  reclaimableUpperBoundBytes: number | null;
  measurementCompleteness: CleanerMeasurementCompleteness;
  accountingConfidence: CleanerAccountingConfidence;
  hardlinkRecordCount: number;
  externalHardlinkRecordCount: number;
  sparseFileCount: number | null;
  compressedFileCount: number | null;
  measuredFileCount: number;
  measuredDirectoryCount: number;
  inaccessibleEntryCount: number;
  inspectedEntryCount: number;
  measurementStartedAt: number;
  measurementCompletedAt: number;
  measurementDurationMs: number;
  measurementLimitReason?: CleanerMeasurementLimitReason;
  logicalTraversalComplete: boolean;
  physicalAccountingComplete: boolean;
  measurementFailureCategory?: CleanerMeasurementFailureCategory;
  measurementFailureExplanation?: string;
};

export type CleanerOwnedDataKind =
  | "ordinary-cache"
  | "download-cache"
  | "build-cache"
  | "compiled-cache"
  | "updater-payload"
  | "extension-store"
  | "installed-runtime"
  | "settings"
  | "session-state"
  | "workspace-state"
  | "history"
  | "backup"
  | "database"
  | "local-storage"
  | "indexed-db"
  | "service-worker-cache"
  | "project-data"
  | "model-data"
  | "shared-dependency-store"
  | "unknown";

export type CleanerApplicationInstallState =
  | "confirmed-installed"
  | "probably-installed"
  | "portable-detected"
  | "ambiguous"
  | "probably-uninstalled"
  | "confirmed-uninstalled"
  | "shared-component"
  | "unknown";

export type CleanerApplicationRunningState =
  "confirmed-running" | "likely-running" | "not-running-observed" | "unknown";

export type CleanerProcessEvidenceStrength =
  "confirmed-consumer" | "likely-related" | "weak-name-only" | "none";

export type CleanerOwnershipConfidence = "high" | "medium" | "low" | "unknown";

export type CleanerOwnershipStatus =
  "exclusive" | "shared" | "ambiguous" | "unowned";

export type CleanerLeftoverCacheStatus =
  | "not-leftover"
  | "leftover-cache"
  | "uncertain"
  | "contains-recoverable-state"
  | "shared-cache";

export type CleanerEvidenceStrength = "strong" | "medium" | "weak";

export type CleanerEvidenceSourceType =
  | "uninstall-registry"
  | "app-path"
  | "exact-registry-key"
  | "executable"
  | "appx"
  | "shortcut"
  | "package-manager"
  | "process"
  | "service"
  | "scheduled-task"
  | "protocol"
  | "portable-root"
  | "observation";

export type CleanerApplicationChannel =
  "stable" | "insiders" | "beta" | "nightly" | "next" | "portable";

export type CleanerProcessReference = {
  name: string;
  pid?: number;
  createdAt?: number;
  evidenceStrength: CleanerProcessEvidenceStrength;
  blocking: boolean;
  reason: string;
};

export type CleanerProcessCommandCategory =
  | "npm-cache-operation"
  | "npx-execution"
  | "yarn-operation"
  | "pnpm-operation"
  | "bun-operation"
  | "corepack-operation"
  | "node-gyp-operation"
  | "electron-download"
  | "uv-operation"
  | "pip-operation"
  | "poetry-operation"
  | "pipenv-operation"
  | "jupyter-operation"
  | "conda-operation"
  | "go-build"
  | "browser"
  | "editor"
  | "updater"
  | "graphics"
  | "unknown";

export type CleanerProcessSnapshot = {
  name: string;
  pid?: number;
  executablePath?: string;
  parentPid?: number;
  createdAt?: number;
  commandCategory: CleanerProcessCommandCategory;
  packageIdentity?: string;
  applicationId?: string;
  referencedPaths: string[];
};

export type CleanerProcessMatchRule = {
  applicationIds?: string[];
  executableBasenames?: string[];
  commandCategories?: CleanerProcessCommandCategory[];
  allowExecutableInsideTarget?: boolean;
  allowReferencedTarget?: boolean;
  weakNameWarnings?: string[];
};

export type CleanerPathFingerprint = {
  kind: "file" | "directory";
  device?: number;
  inode?: number;
  modifiedMs?: number;
  reparsePoint: boolean;
};

export type CleanerRegenerationStatus = {
  label: CleanerRegenerationLabel;
  summary: string;
  firstReappearedAt?: number;
  mostRecentReappearedAt?: number;
  observedRegenerations: number;
  approximateRegenerationMs?: number;
  typicalSizeBytes?: number;
};

export type CleanerFindingHistorySummary = {
  lastCleanedAt?: number;
  lastCleanedSizeBytes?: number;
  successfulCleanups: number;
  observedRegenerations: number;
  approximateRegenerationMs?: number;
};

export interface CleanerFinding {
  id: string;
  detectorId: string;
  category: string;
  displayName: string;
  applicationName?: string;
  applicationId?: string;
  applicationFamilyId?: string;
  applicationChannel?: CleanerApplicationChannel;
  applicationInstallState: CleanerApplicationInstallState;
  applicationRunningState: CleanerApplicationRunningState;
  dataKind: CleanerOwnedDataKind;
  ownershipStatus: CleanerOwnershipStatus;
  ownershipConfidence: CleanerOwnershipConfidence;
  ownerApplicationIds: string[];
  sharedOwnership: boolean;
  leftoverCacheStatus: CleanerLeftoverCacheStatus;
  evidenceConfidence: CleanerOwnershipConfidence;
  strongEvidence: string[];
  supportingEvidence: string[];
  staleEvidence: string[];
  unavailableEvidenceSources: string[];
  verifiedExecutableBasename?: string;
  productChannel?: CleanerApplicationChannel;
  mixedDataWarnings: string[];
  statusExplanation: string;
  lastSeenInstalledAt?: number;
  applicationInstanceId?: string;
  definitionVersion: number;
  dataRootId: string;
  exactDataRoot: boolean;
  protectedParentBypass?: {
    applicationId: string;
    protectedAncestor: string;
    exactTarget: string;
    rootId: string;
  };
  path: string;
  normalizedPath: string;
  accounting: CleanerSizeAccounting;
  logicalBytes: number;
  allocatedBytes: number | null;
  uniqueAllocatedBytes: number | null;
  estimatedReclaimableBytes: number | null;
  reclaimableLowerBoundBytes: number;
  reclaimableUpperBoundBytes: number | null;
  measurementCompleteness: CleanerMeasurementCompleteness;
  accountingConfidence: CleanerAccountingConfidence;
  hardlinkRecordCount: number;
  externalHardlinkRecordCount: number;
  sparseFileCount: number | null;
  compressedFileCount: number | null;
  measuredFileCount: number;
  measuredDirectoryCount: number;
  measurementStartedAt: number;
  measurementCompletedAt: number;
  measurementDurationMs: number;
  measurementLimitReason?: CleanerMeasurementLimitReason;
  logicalTraversalComplete: boolean;
  physicalAccountingComplete: boolean;
  measurementFailureCategory?: CleanerMeasurementFailureCategory;
  measurementFailureExplanation?: string;
  accountingActionabilityBlocked: boolean;
  /** @deprecated Use logicalBytes. Retained for renderer compatibility. */
  sizeBytes: number;
  /** @deprecated Use estimatedReclaimableBytes. */
  recoverableBytes: number;
  fileCount?: number;
  sizeMeasurementComplete: boolean;
  sizeMeasurementWarnings: string[];
  safety: CleanerSafety;
  reason: string;
  consequences: string[];
  restoration?: string;
  relatedProcesses: CleanerProcessReference[];
  relatedProcessNames: string[];
  processMatchRules: CleanerProcessMatchRule[];
  excluded: boolean;
  selected: boolean;
  canDelete: boolean;
  requiresExplicitConfirmation: boolean;
  reparsePointStatus: CleanerReparsePointStatus;
  overlapGroup?: string;
  recommendation: CleanerRecommendation;
  recommendationReason: string;
  cleanupValueScore: number;
  regeneration: CleanerRegenerationStatus;
  history?: CleanerFindingHistorySummary;
  fingerprint: CleanerPathFingerprint;
}

export type CleanerScanProgress = {
  scanSessionId: string;
  mode: CleanerScanMode;
  stage: "preparing" | "detecting" | "measuring" | "classifying" | "finalizing";
  currentCategory: string;
  completedUnits: number;
  totalUnits: number;
  percent: number;
  findingCount: number;
  measuredSizeBytes: number;
  startedAt: number;
  elapsedMs: number;
  progressKind: "stage";
  currentTarget?: string;
  currentDetectorId?: string;
  completedTargets: number;
  totalTargets: number;
  processedFiles: number;
  processedDirectories: number;
  uniqueFileRecords: number;
  logicalBytesScanned: number;
  workerActive: boolean;
};

export type CleanerScanSummary = {
  safeNowBytes: number;
  safeAfterCloseBytes: number;
  conditionalBytes: number;
  protectedBytes: number;
  manualReviewBytes: number;
  excludedBytes: number;
  conditionalRecoverableBytes: number;
  estimatedRecoverableBytes: number;
  unknownRecoverableFindingCount: number;
  unknownRecoverableLogicalBytes: number;
  partialLogicalBytes: number;
  freeDiskSpaceBytes: number;
  freeDiskSpaceMeasuredAt: number;
  scanTimeFreeDiskSpaceBytes: number;
  scanTimeFreeDiskSpaceMeasuredAt: number;
  freeSpaceIsStale: boolean;
  sizeAccountingNotes: string[];
  scanIncomplete: boolean;
  scanWarnings: string[];
  durationMs: number;
  mode: CleanerScanMode;
};

export type CleanerScanResult = {
  scanSessionId: string;
  createdAt: number;
  completedAt: number;
  platform: CleanerPlatform;
  mode: CleanerScanMode;
  testMode: boolean;
  findings: CleanerFinding[];
  summary: CleanerScanSummary;
};

export type CleanerScanState =
  | { status: "idle"; testMode: boolean }
  | {
      status: "scanning";
      testMode: boolean;
      progress: CleanerScanProgress;
    }
  | { status: "complete"; testMode: boolean; result: CleanerScanResult }
  | {
      status: "cancelled" | "error";
      testMode: boolean;
      scanSessionId?: string;
      message: string;
    };

export type StartCleanerScanInput = {
  mode: CleanerScanMode;
};

export type CleanCleanerFindingsInput = {
  scanSessionId: string;
  findingIds: string[];
  confirmation: "safe" | "conditional";
};

export type CleanerCleanupItemStatus =
  "deleted" | "partial" | "skipped" | "failed";

export type CleanerCleanupReceiptStatus =
  "in-progress" | "completed" | "partial" | "failed" | "interrupted";

export type CleanerCleanupAttemptStatus =
  "not-attempted" | "deleted" | "partial" | "skipped" | "failed";

export type CleanerCleanupFailureCategory =
  | "access-denied"
  | "locked"
  | "not-empty"
  | "path-validation"
  | "state-changed"
  | "process-running"
  | "excluded"
  | "measurement-incomplete"
  | "verification-failed"
  | "reparse-removal-failed"
  | "filesystem-error"
  | "overlap-resolved";

export type CleanerDriveSpaceMeasurement = {
  freeBytes: number;
  measuredAt: number;
  driveIdentity: string;
};

export type CleanerCleanupReceiptFinding = {
  findingId: string;
  displayName: string;
  detectorId: string;
  category: string;
  applicationId?: string;
  dataRootId: string;
  normalizedPath: string;
  definitionVersion: number;
  preCleanupFingerprint: CleanerPathFingerprint;
  preCleanupSafety: CleanerSafety;
  preCleanupLogicalBytes: number;
  preCleanupAllocatedBytes: number | null;
  preCleanupEstimatedReclaimableBytes: number | null;
  preCleanupMeasurementCompleteness: CleanerMeasurementCompleteness;
  preCleanupAccountingConfidence: CleanerAccountingConfidence;
  attemptStatus: CleanerCleanupAttemptStatus;
  filesAttempted: number;
  filesSuccessfullyUnlinked: number;
  directoriesAttempted: number;
  directoriesSuccessfullyRemoved: number;
  reparseObjectsSuccessfullyRemoved: number;
  skippedEntryCount: number;
  failedEntryCount: number;
  logicalBytesRemoved: number;
  estimatedAllocatedBytesAddressed: number | null;
  postCleanupRootExists: boolean | null;
  postCleanupLogicalBytes: number | null;
  postCleanupAllocatedBytes: number | null;
  postCleanupEstimatedReclaimableBytes: number | null;
  postCleanupMeasurementCompleteness: CleanerMeasurementCompleteness;
  postCleanupFingerprint?: CleanerPathFingerprint;
  stateChangeReason?: string;
  failureCategories: CleanerCleanupFailureCategory[];
  postCleanupVerificationAt?: number;
  verificationCompleted: boolean;
  message: string;
};

export type CleanerCleanupItemResult = CleanerCleanupReceiptFinding & {
  status: CleanerCleanupItemStatus;
  logicalBytesDeleted: number;
  remainingBytes: number;
  skippedEntries: number;
};

export type CleanerCleanupProgress = {
  scanSessionId: string;
  cleanupRequestId?: string;
  currentFindingId?: string;
  completedItems: number;
  totalItems: number;
  logicalBytesDeleted: number;
};

export type CleanerCleanupReceipt = {
  schemaVersion: 1;
  cleanupRequestId: string;
  scanSessionId: string;
  requestedConfirmation: CleanCleanerFindingsInput["confirmation"];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: CleanerCleanupReceiptStatus;
  selectedFindingIds: string[];
  resolvedFindingIds: string[];
  freeSpaceBefore?: CleanerDriveSpaceMeasurement;
  freeSpaceAfter?: CleanerDriveSpaceMeasurement;
  signedFreeSpaceDeltaBytes?: number;
  aggregateLogicalBytesAddressed: number;
  aggregateEstimatedPhysicalBytesReclaimable: number | null;
  aggregateLogicalBytesRemoved: number;
  aggregateRemainingLogicalBytes: number;
  aggregateFilesUnlinked: number;
  aggregateDirectoriesRemoved: number;
  aggregateReparseObjectsRemoved: number;
  aggregateSkippedEntries: number;
  aggregateFailedEntries: number;
  postCleanupVerificationCompleted: boolean;
  interruptionReason?: string;
  findings: CleanerCleanupReceiptFinding[];
};

export type CleanerCleanupResult = CleanerCleanupReceipt & {
  items: CleanerCleanupItemResult[];
  logicalBytesDeleted: number;
  freeDiskSpaceBefore: number;
  freeDiskSpaceAfter: number | null;
  freeDiskSpaceBeforeMeasuredAt: number;
  freeDiskSpaceAfterMeasuredAt: number | null;
  observedDriveDifferenceBytes: number | null;
  recoveryExplanation: string;
};

export type CleanerExclusionScope =
  "category" | "detector" | "application" | "root" | "path" | "finding";

export type CleanerExclusion = {
  id: string;
  scope: CleanerExclusionScope;
  value: string;
  label: string;
  createdAt: number;
};

export type UpdateCleanerExclusionsInput =
  | { action: "add"; exclusion: Omit<CleanerExclusion, "id" | "createdAt"> }
  | { action: "remove"; exclusionId: string };

export type CleanerPreferences = {
  defaultScanMode: CleanerScanMode;
  showExcluded: boolean;
};

export type CleanerCleanupHistoryResult =
  "success" | "partial" | "failed" | "skipped";

export type CleanerItemHistory = {
  key: string;
  detectorId: string;
  findingId?: string;
  category?: string;
  applicationId?: string;
  dataRootId?: string;
  normalizedPath: string;
  applicationName: string;
  lastCleanedAt?: number;
  lastCleanedSizeBytes?: number;
  successfulCleanups: number;
  firstReappearedAt?: number;
  mostRecentReappearedAt?: number;
  observedRegenerations: number;
  currentObservedSizeBytes: number;
  typicalRegenerationSizeBytes?: number;
  approximateRegenerationMs?: number;
  lastCleanupResult?: CleanerCleanupHistoryResult;
  lastVerifiedCleanupRequestId?: string;
  verifiedPostCleanupBaselineLogicalBytes?: number;
  verifiedPostCleanupBaselineAt?: number;
  regenerationBaselineComplete: boolean;
  lastInterruptedCleanupAt?: number;
  lastObservedAt?: number;
  lastRegenerationCleanupAt?: number;
  excluded: boolean;
  repeatedlyRegenerated: boolean;
};

export type CleanerCleanupEvent = {
  id: string;
  detectorId: string;
  normalizedPath: string;
  applicationName: string;
  cleanedAt: number;
  sizeBeforeBytes: number;
  logicalBytesDeleted: number;
  remainingBytes: number;
  result: CleanerCleanupHistoryResult;
};

export type CleanerStoreSchema = {
  schemaVersion: 3;
  exclusions: CleanerExclusion[];
  itemHistory: Record<string, CleanerItemHistory>;
  cleanupEvents: CleanerCleanupEvent[];
  cleanupReceipts: CleanerCleanupReceipt[];
  applicationObservations: Record<string, CleanerApplicationObservation>;
  migrationNotices: string[];
  preferences: CleanerPreferences;
};

export type CleanerHistorySnapshot = Pick<
  CleanerStoreSchema,
  "itemHistory" | "cleanupEvents" | "cleanupReceipts" | "migrationNotices"
>;

export type CleanerDetectorCandidate = {
  detectorId: string;
  category: string;
  displayName: string;
  applicationName: string;
  applicationId?: string;
  dataRootId: string;
  definitionVersion: number;
  dataKind: CleanerOwnedDataKind;
  ownershipStatus: CleanerOwnershipStatus;
  ownerApplicationIds: string[];
  exactDataRoot: boolean;
  processMatchRules: CleanerProcessMatchRule[];
  protectedParentBypass?: {
    applicationId: string;
    protectedAncestor: string;
    exactTarget: string;
    rootId: string;
  };
  protectedMarkerScope?: "recursive" | "root-children";
  path: string;
  baseSafety: Exclude<CleanerSafety, "safe-after-close">;
  reason: string;
  consequences: string[];
  restoration?: string;
  relatedProcessNames: string[];
  canDelete: boolean;
  requiresExplicitConfirmation: boolean;
  supportedModes: CleanerScanMode[];
};

export type CleanerDetectorContext = {
  mode: CleanerScanMode;
  environment: CleanerEnvironment;
  filesystem: CleanerFilesystem;
  processes: CleanerProcessSnapshot[];
  applications: CleanerApplicationResolution[];
  evidenceSnapshot: CleanerApplicationEvidenceSnapshot;
  isCancelled(): boolean;
};

export interface CleanerDetector {
  id: string;
  category: string;
  supportedPlatform: CleanerPlatform;
  detect(context: CleanerDetectorContext): Promise<CleanerDetectorCandidate[]>;
}

export type CleanerEnvironment = {
  systemDrive: string;
  home: string;
  localAppData: string;
  roamingAppData: string;
  programData: string;
  windowsDir: string;
  tempDir: string;
  projectRoots: string[];
  goCache?: string;
  definitionVersion: number;
  testRoot?: string;
};

export type CleanerApplicationEvidence = {
  source: CleanerEvidenceSourceType;
  applicationId?: string;
  observedName?: string;
  publisher?: string;
  version?: string;
  executablePath?: string;
  installLocation?: string;
  packageFamilyName?: string;
  targetPath?: string;
  serviceName?: string;
  taskName?: string;
  protocolName?: string;
  current: boolean;
  verified: boolean;
  stale?: boolean;
  portable?: boolean;
  strength: CleanerEvidenceStrength;
  summary: string;
};

export type CleanerEvidenceSourceResult = {
  source: CleanerEvidenceSourceType;
  mandatory: boolean;
  completed: boolean;
  error?: string;
  evidence: CleanerApplicationEvidence[];
};

export type CleanerApplicationEvidenceSnapshot = {
  collectedAt: number;
  mode: CleanerScanMode;
  sources: CleanerEvidenceSourceResult[];
};

export type CleanerApplicationResolution = {
  id: string;
  familyId: string;
  channel: CleanerApplicationChannel;
  displayName: string;
  definitionVersion: number;
  installState: CleanerApplicationInstallState;
  runningState: CleanerApplicationRunningState;
  confidence: CleanerOwnershipConfidence;
  strongEvidence: string[];
  supportingEvidence: string[];
  staleEvidence: string[];
  unavailableEvidenceSources: string[];
  verifiedExecutableBasename?: string;
  lastSeenInstalledAt?: number;
  applicationInstanceId?: string;
  currentAuditComplete: boolean;
};

export type CleanerRegistrySignature = {
  displayNames: string[];
  publishers?: string[];
  keyNames?: string[];
};

export type CleanerExecutableSignature = {
  basenames: string[];
  knownPaths: (environment: CleanerEnvironment) => string[];
  productNames?: string[];
  publishers?: string[];
};

export type CleanerAppxSignature = {
  packageFamilyNames: string[];
  packageNames?: string[];
  publishers?: string[];
};

export type CleanerShortcutSignature = {
  targetBasenames: string[];
  productNames?: string[];
};

export type CleanerPackageSignature = {
  managers: string[];
  packageIds: string[];
  publishers?: string[];
};

export type CleanerProcessSignature = {
  executableBasenames: string[];
  productNames?: string[];
  packageIdentities?: string[];
};

export type CleanerServiceSignature = {
  serviceNames: string[];
};

export type CleanerScheduledTaskSignature = {
  taskNames: string[];
};

export type CleanerProtocolSignature = {
  protocolNames: string[];
  targetBasenames: string[];
};

export type CleanerApplicationDataRoot = {
  id: string;
  displayName: string;
  resolvePaths(environment: CleanerEnvironment): string[];
  dataKind: CleanerOwnedDataKind;
  ownership: "exclusive" | "shared";
  allowProtectedParentBypass?: boolean;
  cacheOnly: boolean;
};

export interface CleanerApplicationDefinition {
  id: string;
  familyId: string;
  channel: CleanerApplicationChannel;
  definitionVersion: number;
  displayName: string;
  registrySignatures: CleanerRegistrySignature[];
  executableSignatures: CleanerExecutableSignature[];
  appxSignatures: CleanerAppxSignature[];
  shortcutSignatures: CleanerShortcutSignature[];
  packageManagerSignatures: CleanerPackageSignature[];
  processSignatures: CleanerProcessSignature[];
  serviceSignatures: CleanerServiceSignature[];
  scheduledTaskSignatures: CleanerScheduledTaskSignature[];
  protocolSignatures: CleanerProtocolSignature[];
  dataRoots: CleanerApplicationDataRoot[];
  sharedComponents?: string[];
  protectedByDefault?: boolean;
}

export interface CleanerApplicationObservation {
  applicationId: string;
  definitionVersion: number;
  firstSeenInstalledAt?: number;
  lastSeenInstalledAt?: number;
  lastNegativeAuditAt?: number;
  lastInstallState: CleanerApplicationInstallState;
  lastEvidenceTypes: string[];
  lastKnownVersion?: string;
  lastKnownPublisher?: string;
  lastKnownRootIds: string[];
  portableExecutablePaths?: string[];
  updatedAt: number;
}

export type CleanerDirectoryEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

export type CleanerFileStat = {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  isReparsePoint: boolean;
  size: number;
  modifiedMs: number;
  device?: number;
  inode?: number;
  volumeIdentity?: string;
  fileIdentity?: string;
  hardlinkCount?: number;
  allocatedBytes?: number;
  allocationConfidence?: "exact" | "estimated";
  sparse?: boolean;
  compressed?: boolean;
};

export interface CleanerFilesystem {
  exists(targetPath: string): Promise<boolean>;
  lstat(targetPath: string): Promise<CleanerFileStat>;
  readDirectory(targetPath: string): Promise<CleanerDirectoryEntry[]>;
  readDirectoryBatches?(
    targetPath: string,
    batchSize?: number,
  ): AsyncIterable<CleanerDirectoryEntry[]>;
  realPath(targetPath: string): Promise<string>;
  unlink(targetPath: string): Promise<void>;
  removeReparsePoint(targetPath: string): Promise<void>;
  removeDirectory(targetPath: string): Promise<void>;
  getSizeOverride(targetPath: string): Promise<number | undefined>;
  getAccountingOverride?(
    targetPath: string,
    policyKind?: "standard-bounded" | "deep-exhaustive",
  ): Promise<Partial<CleanerSizeAccounting> | undefined>;
  getAllocationUnit?(targetPath: string): Promise<number | undefined>;
}

export interface CleanerProcessProvider {
  list(environment: CleanerEnvironment): Promise<CleanerProcessSnapshot[]>;
}

export interface CleanerApplicationEvidenceProvider {
  collect(
    mode: CleanerScanMode,
    environment: CleanerEnvironment,
    processes: CleanerProcessSnapshot[],
    observations: Record<string, CleanerApplicationObservation>,
    options?: {
      isCancelled?(): boolean;
      onSourceProgress?(
        source: CleanerEvidenceSourceType,
        completed: number,
        total: number,
      ): void;
    },
  ): Promise<CleanerApplicationEvidenceSnapshot>;
}

export interface CleanerDriveProvider {
  measureFreeSpace(
    systemDrive: string,
  ): Promise<Omit<CleanerDriveSpaceMeasurement, "measuredAt">>;
}

export interface CleanerClock {
  now(): number;
}

export interface CleanerPersistence {
  read(): CleanerStoreSchema;
  write(next: CleanerStoreSchema): void;
}
