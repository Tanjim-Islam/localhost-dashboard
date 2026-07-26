import type {
  CleanerApplicationResolution,
  CleanerDetectorCandidate,
  CleanerFinding,
  CleanerLeftoverCacheStatus,
  CleanerOwnedDataKind,
  CleanerOwnershipConfidence,
  CleanerOwnershipStatus,
} from "../types";

const CACHE_ONLY_KINDS = new Set<CleanerOwnedDataKind>([
  "ordinary-cache",
  "download-cache",
  "build-cache",
  "compiled-cache",
  "updater-payload",
]);

const RECOVERABLE_STATE_KINDS = new Set<CleanerOwnedDataKind>([
  "extension-store",
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

export type CleanerOwnershipResolution = {
  status: CleanerOwnershipStatus;
  confidence: CleanerOwnershipConfidence;
  ownerApplicationIds: string[];
  shared: boolean;
};

export function resolveCleanerCandidateOwnership(
  candidate: CleanerDetectorCandidate,
  applications: CleanerApplicationResolution[],
): CleanerOwnershipResolution {
  const owners = [...new Set(candidate.ownerApplicationIds)];
  if (owners.length === 0) {
    return {
      status: candidate.ownershipStatus,
      confidence: candidate.exactDataRoot ? "high" : "unknown",
      ownerApplicationIds: [],
      shared: candidate.ownershipStatus === "shared",
    };
  }
  const missingDefinition = owners.some(
    (owner) => !applications.some((application) => application.id === owner),
  );
  const shared = candidate.ownershipStatus === "shared" || owners.length > 1;
  return {
    status: missingDefinition ? "ambiguous" : shared ? "shared" : "exclusive",
    confidence:
      candidate.exactDataRoot && !missingDefinition
        ? "high"
        : missingDefinition
          ? "low"
          : "medium",
    ownerApplicationIds: owners,
    shared,
  };
}

export function resolveCleanerLeftoverCacheStatus(input: {
  dataKind: CleanerOwnedDataKind;
  ownership: CleanerOwnershipResolution;
  ownerResolutions: CleanerApplicationResolution[];
  exactDataRoot: boolean;
  hasBlockingProcess: boolean;
  hasProtectedMarkers: boolean;
  hasInternalReparsePoints: boolean;
}): CleanerLeftoverCacheStatus {
  if (RECOVERABLE_STATE_KINDS.has(input.dataKind))
    return "contains-recoverable-state";
  if (input.ownership.shared) return "shared-cache";
  if (!CACHE_ONLY_KINDS.has(input.dataKind)) return "not-leftover";
  if (
    !input.exactDataRoot ||
    input.ownership.status !== "exclusive" ||
    input.ownership.confidence !== "high"
  ) {
    return "uncertain";
  }
  if (
    input.hasBlockingProcess ||
    input.hasProtectedMarkers ||
    input.hasInternalReparsePoints
  ) {
    return "uncertain";
  }
  if (input.ownerResolutions.length !== 1) return "uncertain";
  const owner = input.ownerResolutions[0];
  if (
    (owner.installState === "probably-uninstalled" ||
      owner.installState === "confirmed-uninstalled") &&
    owner.currentAuditComplete &&
    owner.unavailableEvidenceSources.length === 0
  ) {
    return "leftover-cache";
  }
  if (owner.installState === "ambiguous" || owner.installState === "unknown") {
    return "uncertain";
  }
  return "not-leftover";
}

export function hasMoreRestrictiveCleanerOwnershipState(
  scanned: Pick<
    CleanerFinding,
    | "applicationInstallState"
    | "applicationRunningState"
    | "dataKind"
    | "ownershipStatus"
    | "ownerApplicationIds"
    | "sharedOwnership"
    | "definitionVersion"
    | "applicationInstanceId"
    | "dataRootId"
    | "exactDataRoot"
  >,
  current: {
    applicationInstallState: CleanerFinding["applicationInstallState"];
    applicationRunningState: CleanerFinding["applicationRunningState"];
    dataKind: CleanerFinding["dataKind"];
    ownershipStatus: CleanerFinding["ownershipStatus"];
    ownerApplicationIds: string[];
    sharedOwnership: boolean;
    definitionVersion: number;
    applicationInstanceId?: string;
    dataRootId: string;
    exactDataRoot: boolean;
  },
): boolean {
  if (
    scanned.definitionVersion !== current.definitionVersion ||
    scanned.applicationInstanceId !== current.applicationInstanceId ||
    scanned.dataRootId !== current.dataRootId ||
    scanned.dataKind !== current.dataKind ||
    scanned.ownershipStatus !== current.ownershipStatus ||
    scanned.sharedOwnership !== current.sharedOwnership ||
    scanned.exactDataRoot !== current.exactDataRoot
  ) {
    return true;
  }
  if (
    [...scanned.ownerApplicationIds].sort().join("\0") !==
    [...current.ownerApplicationIds].sort().join("\0")
  ) {
    return true;
  }
  if (
    current.applicationInstallState === "confirmed-installed" ||
    current.applicationInstallState === "probably-installed" ||
    current.applicationInstallState === "portable-detected" ||
    current.applicationInstallState === "ambiguous"
  ) {
    return current.applicationInstallState !== scanned.applicationInstallState;
  }
  return (
    current.applicationRunningState === "confirmed-running" ||
    current.applicationRunningState === "likely-running"
  );
}

export function applicationStatusLabel(
  state: CleanerFinding["applicationInstallState"],
): string {
  const labels: Record<CleanerFinding["applicationInstallState"], string> = {
    "confirmed-installed": "Application installed",
    "probably-installed": "Application probably installed",
    "portable-detected": "Portable application detected",
    ambiguous: "Installation status uncertain",
    "probably-uninstalled": "Application not found",
    "confirmed-uninstalled": "Application confirmed uninstalled",
    "shared-component": "Shared component",
    unknown: "Installation status unknown",
  };
  return labels[state];
}
