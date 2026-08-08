import type {
  CleanerApplicationEvidenceSnapshot,
  CleanerApplicationObservation,
  CleanerApplicationResolution,
  CleanerStoreSchema,
} from "../types";

export const MAX_CLEANER_APPLICATION_OBSERVATIONS = 200;
export const CLEANER_APPLICATION_OBSERVATION_MAX_AGE_MS =
  365 * 24 * 60 * 60 * 1000;

const INSTALLED_STATES = new Set([
  "confirmed-installed",
  "probably-installed",
  "portable-detected",
]);

export function updateCleanerApplicationObservations(
  state: CleanerStoreSchema,
  resolutions: CleanerApplicationResolution[],
  snapshot: CleanerApplicationEvidenceSnapshot,
  now: number,
): void {
  for (const resolution of resolutions) {
    const current = state.applicationObservations[resolution.id];
    const installed = INSTALLED_STATES.has(resolution.installState);
    const evidence = snapshot.sources.flatMap((source) =>
      source.evidence.filter(
        (item) => item.applicationId === resolution.id && item.current,
      ),
    );
    const next: CleanerApplicationObservation = {
      applicationId: resolution.id,
      definitionVersion: resolution.definitionVersion,
      firstSeenInstalledAt:
        current?.definitionVersion === resolution.definitionVersion
          ? current.firstSeenInstalledAt
          : undefined,
      lastSeenInstalledAt:
        current?.definitionVersion === resolution.definitionVersion
          ? current.lastSeenInstalledAt
          : undefined,
      lastNegativeAuditAt:
        current?.definitionVersion === resolution.definitionVersion
          ? current.lastNegativeAuditAt
          : undefined,
      lastInstallState: resolution.installState,
      lastEvidenceTypes: [
        ...new Set(evidence.map((item) => item.source)),
      ].slice(0, 16),
      lastKnownVersion: evidence.find((item) => item.version)?.version,
      lastKnownPublisher: evidence.find((item) => item.publisher)?.publisher,
      lastKnownRootIds:
        current?.definitionVersion === resolution.definitionVersion
          ? current.lastKnownRootIds.slice(0, 32)
          : [],
      portableExecutablePaths: evidence
        .filter(
          (item) =>
            item.portable &&
            item.verified &&
            typeof item.executablePath === "string",
        )
        .map((item) => item.executablePath!)
        .slice(0, 8),
      updatedAt: now,
    };
    if (installed) {
      next.firstSeenInstalledAt ??= now;
      next.lastSeenInstalledAt = now;
    } else if (
      (resolution.installState === "probably-uninstalled" ||
        resolution.installState === "confirmed-uninstalled") &&
      resolution.currentAuditComplete
    ) {
      next.lastNegativeAuditAt = now;
    }
    state.applicationObservations[resolution.id] = next;
  }
  pruneCleanerApplicationObservations(state, now);
}

export function recordObservedCleanerRoot(
  state: CleanerStoreSchema,
  applicationId: string,
  rootId: string,
): void {
  const observation = state.applicationObservations[applicationId];
  if (!observation) return;
  observation.lastKnownRootIds = [
    rootId,
    ...observation.lastKnownRootIds.filter((item) => item !== rootId),
  ].slice(0, 32);
}

export function pruneCleanerApplicationObservations(
  state: CleanerStoreSchema,
  now: number,
): void {
  const entries = Object.entries(state.applicationObservations)
    .filter(
      ([, observation]) =>
        now - observation.updatedAt <=
        CLEANER_APPLICATION_OBSERVATION_MAX_AGE_MS,
    )
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_CLEANER_APPLICATION_OBSERVATIONS);
  state.applicationObservations = Object.fromEntries(entries);
}
