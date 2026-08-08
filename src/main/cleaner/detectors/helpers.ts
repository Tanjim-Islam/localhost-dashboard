import type {
  CleanerDetectorCandidate,
  CleanerDetectorContext,
  CleanerSafety,
  CleanerScanMode,
} from "../types";
import { CLEANER_APPLICATION_DEFINITION_VERSION } from "../applications/definitions";

export type CandidateInput = Omit<
  CleanerDetectorCandidate,
  | "supportedModes"
  | "relatedProcessNames"
  | "requiresExplicitConfirmation"
  | "dataRootId"
  | "definitionVersion"
  | "dataKind"
  | "ownershipStatus"
  | "ownerApplicationIds"
  | "exactDataRoot"
  | "processMatchRules"
> & {
  supportedModes?: CleanerScanMode[];
  relatedProcessNames?: string[];
  requiresExplicitConfirmation?: boolean;
  dataRootId?: string;
  definitionVersion?: number;
  dataKind?: CleanerDetectorCandidate["dataKind"];
  ownershipStatus?: CleanerDetectorCandidate["ownershipStatus"];
  ownerApplicationIds?: string[];
  exactDataRoot?: boolean;
  processMatchRules?: CleanerDetectorCandidate["processMatchRules"];
};

export function candidate(input: CandidateInput): CleanerDetectorCandidate {
  return {
    ...input,
    dataRootId: input.dataRootId ?? input.detectorId,
    definitionVersion:
      input.definitionVersion ?? CLEANER_APPLICATION_DEFINITION_VERSION,
    dataKind: input.dataKind ?? "unknown",
    ownershipStatus: input.ownershipStatus ?? "exclusive",
    ownerApplicationIds:
      input.ownerApplicationIds ??
      (input.applicationId ? [input.applicationId] : []),
    exactDataRoot: input.exactDataRoot ?? true,
    processMatchRules:
      input.processMatchRules ??
      (input.relatedProcessNames?.length
        ? [{ weakNameWarnings: input.relatedProcessNames }]
        : []),
    relatedProcessNames: input.relatedProcessNames ?? [],
    supportedModes: input.supportedModes ?? ["standard", "deep"],
    requiresExplicitConfirmation:
      input.requiresExplicitConfirmation ?? input.baseSafety === "conditional",
  };
}

export async function keepExistingCandidates(
  context: CleanerDetectorContext,
  candidates: CleanerDetectorCandidate[],
): Promise<CleanerDetectorCandidate[]> {
  const results: CleanerDetectorCandidate[] = [];
  for (const item of candidates) {
    if (context.isCancelled()) break;
    if (!item.supportedModes.includes(context.mode)) continue;
    if (await context.filesystem.exists(item.path)) results.push(item);
  }
  return results;
}

export function safetyCanDelete(safety: CleanerSafety): boolean {
  return (
    safety === "safe-now" ||
    safety === "safe-after-close" ||
    safety === "conditional"
  );
}
