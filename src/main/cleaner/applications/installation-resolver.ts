import path from "node:path";
import { createHash } from "node:crypto";
import type {
  CleanerApplicationDefinition,
  CleanerApplicationEvidence,
  CleanerApplicationEvidenceSnapshot,
  CleanerApplicationObservation,
  CleanerApplicationResolution,
  CleanerApplicationRunningState,
  CleanerProcessSnapshot,
} from "../types";
import { CLEANER_APPLICATION_DEFINITIONS } from "./definitions";

export function resolveCleanerApplications(
  snapshot: CleanerApplicationEvidenceSnapshot,
  processes: CleanerProcessSnapshot[],
  observations: Record<string, CleanerApplicationObservation>,
  definitions: CleanerApplicationDefinition[] = CLEANER_APPLICATION_DEFINITIONS,
): CleanerApplicationResolution[] {
  return definitions.map((definition) =>
    resolveCleanerApplication(
      definition,
      snapshot,
      processes,
      observations[definition.id],
    ),
  );
}

export function resolveCleanerApplication(
  definition: CleanerApplicationDefinition,
  snapshot: CleanerApplicationEvidenceSnapshot,
  processes: CleanerProcessSnapshot[],
  observation?: CleanerApplicationObservation,
): CleanerApplicationResolution {
  const evidence = snapshot.sources.flatMap((source) =>
    source.evidence.filter((item) => item.applicationId === definition.id),
  );
  const current = evidence.filter((item) => item.current && !item.stale);
  const strong = current.filter((item) => item.strength === "strong");
  const medium = current.filter((item) => item.strength === "medium");
  const stale = evidence.filter((item) => item.stale || !item.current);
  const conflictingStale = stale.some((item) => item.source !== "observation");
  const unavailable = snapshot.sources
    .filter((source) => !source.completed)
    .map((source) => source.source);
  const verifiedExecutable = current.find(
    (item) => item.source === "executable" && item.verified,
  );
  const registry = current.find((item) => item.source === "uninstall-registry");
  const appx = current.find((item) => item.source === "appx" && item.verified);
  const runningExecutable = current.find(
    (item) => item.source === "process" && item.verified,
  );
  const packageManager = current.find(
    (item) => item.source === "package-manager",
  );
  const shortcut = current.find(
    (item) => item.source === "shortcut" && item.verified,
  );
  const portable = current.find(
    (item) => item.source === "portable-root" && item.portable && item.verified,
  );
  const currentAuditComplete =
    snapshot.mode === "deep" &&
    snapshot.sources
      .filter((source) => source.mandatory)
      .every((source) => source.completed);

  let installState: CleanerApplicationResolution["installState"] = "unknown";
  const sharedComponentEvidence =
    definition.sharedComponents?.length &&
    current.length > 0 &&
    current.every(
      (item) => item.source === "service" || item.source === "scheduled-task",
    );
  if (sharedComponentEvidence) {
    installState = "shared-component";
  } else if (appx || runningExecutable || shortcut) {
    installState = "confirmed-installed";
  } else if (verifiedExecutable && (registry || packageManager || shortcut)) {
    installState = "confirmed-installed";
  } else if (portable && (shortcut || runningExecutable || portable.current)) {
    installState = "portable-detected";
  } else if (verifiedExecutable || medium.length >= 2) {
    installState = "probably-installed";
  } else if (current.length > 0 || conflictingStale) {
    installState = "ambiguous";
  } else if (unavailable.length > 0 || !currentAuditComplete) {
    installState = "ambiguous";
  } else if (
    observation?.lastSeenInstalledAt &&
    observation.definitionVersion === definition.definitionVersion
  ) {
    installState = "confirmed-uninstalled";
  } else {
    installState = "probably-uninstalled";
  }

  const runningState = resolveRunningState(definition, processes);
  return {
    id: definition.id,
    familyId: definition.familyId,
    channel: definition.channel,
    displayName: definition.displayName,
    definitionVersion: definition.definitionVersion,
    installState,
    runningState,
    confidence:
      installState === "confirmed-installed" ||
      installState === "confirmed-uninstalled"
        ? "high"
        : installState === "probably-installed" ||
            installState === "portable-detected" ||
            installState === "probably-uninstalled"
          ? "medium"
          : installState === "ambiguous"
            ? "low"
            : "unknown",
    strongEvidence: uniqueSummaries(strong),
    supportingEvidence: uniqueSummaries(medium),
    staleEvidence: uniqueSummaries(stale),
    unavailableEvidenceSources: [...new Set(unavailable)],
    verifiedExecutableBasename: verifiedExecutable?.executablePath
      ? path.win32.basename(verifiedExecutable.executablePath)
      : runningExecutable?.executablePath
        ? path.win32.basename(runningExecutable.executablePath)
        : undefined,
    lastSeenInstalledAt: observation?.lastSeenInstalledAt,
    applicationInstanceId:
      current.length > 0 ? createApplicationInstanceId(current) : undefined,
    currentAuditComplete,
  };
}

function resolveRunningState(
  definition: CleanerApplicationDefinition,
  processes: CleanerProcessSnapshot[],
): CleanerApplicationRunningState {
  if (
    processes.some((processInfo) => processInfo.applicationId === definition.id)
  )
    return "confirmed-running";
  const expected = new Set(
    definition.processSignatures.flatMap((signature) =>
      signature.executableBasenames.map((basename) => basename.toLowerCase()),
    ),
  );
  if (
    processes.some((processInfo) =>
      expected.has(path.win32.basename(processInfo.name).toLowerCase()),
    )
  ) {
    return "likely-running";
  }
  return processes.length > 0 ? "not-running-observed" : "unknown";
}

function uniqueSummaries(evidence: CleanerApplicationEvidence[]): string[] {
  return [...new Set(evidence.map((item) => item.summary))].slice(0, 12);
}

function createApplicationInstanceId(
  evidence: CleanerApplicationEvidence[],
): string {
  const identity = evidence
    .map((item) =>
      [
        item.source,
        item.executablePath,
        item.installLocation,
        item.packageFamilyName,
        item.version,
        item.publisher,
        item.targetPath,
        item.serviceName,
        item.taskName,
        item.protocolName,
      ]
        .filter(Boolean)
        .join("\0"),
    )
    .filter(Boolean)
    .sort()
    .join("\n");
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}
