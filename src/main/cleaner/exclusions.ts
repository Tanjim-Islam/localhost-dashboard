import { createHash } from "node:crypto";
import type {
  CleanerExclusion,
  CleanerFinding,
  CleanerStoreSchema,
} from "./types";
import { normalizeWindowsPath } from "./path-normalization";

export function createCleanerExclusion(
  input: Omit<CleanerExclusion, "id" | "createdAt">,
  now: number,
): CleanerExclusion {
  const value =
    input.scope === "path"
      ? normalizeWindowsPath(input.value)
      : input.value.trim();
  if (!value || !input.label.trim()) {
    throw new Error("Cleaner exclusion value and label are required.");
  }
  return {
    ...input,
    value,
    label: input.label.trim(),
    createdAt: now,
    id: createHash("sha256")
      .update(`${input.scope}\0${value.toLowerCase()}`)
      .digest("hex")
      .slice(0, 24),
  };
}

export function isFindingExcluded(
  finding: Pick<
    CleanerFinding,
    | "id"
    | "detectorId"
    | "category"
    | "applicationName"
    | "applicationId"
    | "dataRootId"
    | "normalizedPath"
  >,
  exclusions: CleanerExclusion[],
): boolean {
  return exclusions.some((exclusion) => {
    switch (exclusion.scope) {
      case "finding":
        return exclusion.value === finding.id;
      case "detector":
        return exclusion.value === finding.detectorId;
      case "category":
        return exclusion.value.toLowerCase() === finding.category.toLowerCase();
      case "application":
        return (
          exclusion.value.toLowerCase() ===
            (finding.applicationId ?? "").toLowerCase() ||
          exclusion.value.toLowerCase() ===
            (finding.applicationName ?? "").toLowerCase()
        );
      case "root":
        return exclusion.value === finding.dataRootId;
      case "path":
        return exclusion.value.toLowerCase() === finding.normalizedPath;
    }
  });
}

export function synchronizeHistoryExclusions(state: CleanerStoreSchema): void {
  for (const history of Object.values(state.itemHistory)) {
    history.excluded = state.exclusions.some(
      (exclusion) =>
        (exclusion.scope === "detector" &&
          exclusion.value === history.detectorId) ||
        (exclusion.scope === "finding" &&
          exclusion.value === history.findingId) ||
        (exclusion.scope === "category" &&
          exclusion.value.toLowerCase() ===
            (history.category ?? "").toLowerCase()) ||
        (exclusion.scope === "application" &&
          (exclusion.value.toLowerCase() ===
            (history.applicationId ?? "").toLowerCase() ||
            exclusion.value.toLowerCase() ===
              history.applicationName.toLowerCase())) ||
        (exclusion.scope === "root" &&
          exclusion.value === history.dataRootId) ||
        (exclusion.scope === "path" &&
          exclusion.value.toLowerCase() === history.normalizedPath),
    );
  }
}
