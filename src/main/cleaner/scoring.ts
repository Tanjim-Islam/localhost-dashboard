import type {
  CleanerFinding,
  CleanerItemHistory,
  CleanerRecommendation,
  CleanerSafety,
} from "./types";

export type CleanerScoreResult = {
  score: number;
  recommendation: CleanerRecommendation;
  reason: string;
};

export function scoreCleanerFinding(input: {
  safety: CleanerSafety;
  sizeBytes: number;
  freeDiskSpaceBytes: number;
  consequences: string[];
  history?: CleanerItemHistory;
}): CleanerScoreResult {
  if (input.safety === "protected") {
    return {
      score: 0,
      recommendation: "protected",
      reason: "Safety protection overrides cleanup value.",
    };
  }
  if (input.safety === "manual-review") {
    return {
      score: 0,
      recommendation: "manual-review",
      reason: "The detector cannot prove that deletion is safe.",
    };
  }

  let score =
    input.safety === "safe-now"
      ? 45
      : input.safety === "safe-after-close"
        ? 35
        : 20;
  if (input.sizeBytes >= 10 * 1024 ** 3) score += 35;
  else if (input.sizeBytes >= 2 * 1024 ** 3) score += 25;
  else if (input.sizeBytes >= 500 * 1024 ** 2) score += 15;
  else if (input.sizeBytes >= 100 * 1024 ** 2) score += 8;
  else score -= 8;

  const spacePressure =
    input.freeDiskSpaceBytes > 0 && input.freeDiskSpaceBytes < 20 * 1024 ** 3;
  if (spacePressure) score += 12;

  const expensive = input.consequences.some((item) =>
    /model|sdk|toolchain|environment|offline|unpublished|browser/i.test(item),
  );
  if (expensive) score -= 15;
  if ((input.history?.observedRegenerations ?? 0) >= 2) score -= 25;
  if (
    (input.history?.approximateRegenerationMs ?? Number.POSITIVE_INFINITY) <
    24 * 60 * 60 * 1000
  ) {
    score -= 20;
  }
  score = Math.max(0, Math.min(100, score));

  if ((input.history?.observedRegenerations ?? 0) >= 2) {
    return {
      score,
      recommendation: "frequently-regenerated",
      reason: "Repeated regeneration lowers the value of routine cleanup.",
    };
  }
  if (score >= 70 && input.safety === "safe-now") {
    return {
      score,
      recommendation: "recommended",
      reason: "Large, proven regenerable data with no active related process.",
    };
  }
  if (score >= 38) {
    return {
      score,
      recommendation: "useful-if-space-low",
      reason: spacePressure
        ? "Current free space is low enough to increase cleanup value."
        : "Useful space recovery with a known rebuild or download cost.",
    };
  }
  return {
    score,
    recommendation: "low-priority",
    reason:
      "Current size, safety, or regeneration behavior limits cleanup value.",
  };
}

export function applyCleanerScore(
  finding: CleanerFinding,
  freeDiskSpaceBytes: number,
  history?: CleanerItemHistory,
): void {
  const scored = scoreCleanerFinding({
    safety: finding.safety,
    sizeBytes: finding.estimatedReclaimableBytes ?? 0,
    freeDiskSpaceBytes,
    consequences: finding.consequences,
    history,
  });
  finding.cleanupValueScore = scored.score;
  finding.recommendation = scored.recommendation;
  finding.recommendationReason = scored.reason;
}
