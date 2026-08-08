import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  Search,
} from "lucide-react";
import {
  CLEANER_RECOMMENDATION_LABELS,
  CLEANER_REGENERATION_META,
  CLEANER_STATUS_META,
  CLEANER_TONE_STYLES,
  getCleanerVisualStatus,
  type CleanerStatusIconName,
  type CleanerTone,
} from "../../cleaner-semantics";
import type { CleanerFinding } from "./types";

export function CleanerStatusIcon({
  name,
  className = "h-4 w-4",
}: {
  name: CleanerStatusIconName;
  className?: string;
}) {
  const props = { className, "aria-hidden": true } as const;
  switch (name) {
    case "check":
      return <CheckCircle2 {...props} />;
    case "clock":
      return <Clock3 {...props} />;
    case "warning":
      return <AlertTriangle {...props} />;
    case "lock":
      return <LockKeyhole {...props} />;
    case "search":
      return <Search {...props} />;
    case "excluded":
      return <Ban {...props} />;
  }
}

export function CleanerStatusBadge({
  safety,
  excluded = false,
}: {
  safety: CleanerFinding["safety"];
  excluded?: boolean;
}) {
  const status = getCleanerVisualStatus(safety, excluded);
  const meta = CLEANER_STATUS_META[status];
  const styles = CLEANER_TONE_STYLES[meta.tone];
  return (
    <span
      aria-label={meta.label}
      title={meta.description}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles.badge}`}
    >
      <CleanerStatusIcon name={meta.icon} className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

export function CleanerRecommendationBadge({
  recommendation,
  score,
}: {
  recommendation: CleanerFinding["recommendation"];
  score: number;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-gray-200/65 px-2.5 py-1 text-[11px] font-medium text-gray-800"
      aria-label={`${CLEANER_RECOMMENDATION_LABELS[recommendation]}, cleanup value ${score} out of 100`}
    >
      {CLEANER_RECOMMENDATION_LABELS[recommendation]}
      <span aria-hidden="true">{score}/100</span>
    </span>
  );
}

export function CleanerHistoryBadge({
  regeneration,
}: {
  regeneration: CleanerFinding["regeneration"];
}) {
  const meta = CLEANER_REGENERATION_META[regeneration.label];
  const styles = CLEANER_TONE_STYLES[meta.tone];
  return (
    <span
      title={regeneration.summary}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${styles.badge}`}
    >
      <span
        className="h-1.5 w-1.5 rounded-full bg-current"
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
}

export function getCleanerToneForFinding(finding: CleanerFinding): CleanerTone {
  return CLEANER_STATUS_META[
    getCleanerVisualStatus(finding.safety, finding.excluded)
  ].tone;
}
