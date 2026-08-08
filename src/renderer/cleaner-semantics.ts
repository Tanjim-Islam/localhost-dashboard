export type CleanerSafety =
  | "safe-now"
  | "safe-after-close"
  | "conditional"
  | "protected"
  | "manual-review";

export type CleanerTone =
  "safe" | "blocked" | "conditional" | "danger" | "review" | "excluded";

export type CleanerStatusIconName =
  "check" | "clock" | "warning" | "lock" | "search" | "excluded";

export type CleanerVisualStatus = CleanerSafety | "excluded";

export const CLEANER_STATUS_META: Record<
  CleanerVisualStatus,
  {
    label: string;
    shortLabel: string;
    description: string;
    tone: CleanerTone;
    icon: CleanerStatusIconName;
  }
> = {
  "safe-now": {
    label: "Safe now",
    shortLabel: "Safe now",
    description: "Recognized, regenerable data that is ready to clean.",
    tone: "safe",
    icon: "check",
  },
  "safe-after-close": {
    label: "Close apps first",
    shortLabel: "Close apps",
    description: "Otherwise safe data that is temporarily in use.",
    tone: "blocked",
    icon: "clock",
  },
  conditional: {
    label: "Conditional",
    shortLabel: "Conditional",
    description: "Requires understanding the redownload or rebuild cost.",
    tone: "conditional",
    icon: "warning",
  },
  protected: {
    label: "Protected",
    shortLabel: "Protected",
    description: "Application, project, database, or system data is blocked.",
    tone: "danger",
    icon: "lock",
  },
  "manual-review": {
    label: "Manual review",
    shortLabel: "Manual review",
    description: "Cleaner cannot prove that automatic deletion is safe.",
    tone: "review",
    icon: "search",
  },
  excluded: {
    label: "Excluded",
    shortLabel: "Excluded",
    description: "Intentionally ignored until its exclusion is removed.",
    tone: "excluded",
    icon: "excluded",
  },
};

export const CLEANER_TONE_STYLES: Record<
  CleanerTone,
  {
    surface: string;
    border: string;
    text: string;
    icon: string;
    badge: string;
    selectedRing: string;
    checkbox: string;
    button: string;
  }
> = {
  safe: {
    surface: "bg-cleaner-safe-surface/72",
    border: "border-cleaner-safe-border/85",
    text: "text-cleaner-safe-text",
    icon: "text-cleaner-safe-icon",
    badge:
      "border-cleaner-safe-border bg-cleaner-safe-surface text-cleaner-safe-text",
    selectedRing: "ring-cleaner-safe-border",
    checkbox:
      "border-cleaner-safe bg-gray-100 text-cleaner-safe-contrast peer-checked:bg-cleaner-safe",
    button:
      "bg-cleaner-safe text-cleaner-safe-contrast hover:bg-cleaner-safe/90",
  },
  blocked: {
    surface: "bg-cleaner-blocked-surface/72",
    border: "border-cleaner-blocked-border/85",
    text: "text-cleaner-blocked-text",
    icon: "text-cleaner-blocked-icon",
    badge:
      "border-cleaner-blocked-border bg-cleaner-blocked-surface text-cleaner-blocked-text",
    selectedRing: "ring-cleaner-blocked-border",
    checkbox: "accent-cleaner-blocked",
    button:
      "bg-cleaner-blocked text-cleaner-blocked-contrast hover:bg-cleaner-blocked/90",
  },
  conditional: {
    surface: "bg-cleaner-conditional-surface/72",
    border: "border-cleaner-conditional-border/85",
    text: "text-cleaner-conditional-text",
    icon: "text-cleaner-conditional-icon",
    badge:
      "border-cleaner-conditional-border bg-cleaner-conditional-surface text-cleaner-conditional-text",
    selectedRing: "ring-cleaner-conditional-border",
    checkbox:
      "border-cleaner-conditional bg-gray-100 text-cleaner-conditional-contrast peer-checked:bg-cleaner-conditional",
    button:
      "bg-cleaner-conditional text-cleaner-conditional-contrast hover:bg-cleaner-conditional/90",
  },
  danger: {
    surface: "bg-cleaner-danger-surface/64",
    border: "border-cleaner-danger-border/85",
    text: "text-cleaner-danger-text",
    icon: "text-cleaner-danger-icon",
    badge:
      "border-cleaner-danger-border bg-cleaner-danger-surface text-cleaner-danger-text",
    selectedRing: "ring-cleaner-danger-border",
    checkbox: "accent-cleaner-danger",
    button:
      "bg-cleaner-danger text-cleaner-danger-contrast hover:bg-cleaner-danger/90",
  },
  review: {
    surface: "bg-cleaner-review-surface/70",
    border: "border-cleaner-review-border/85",
    text: "text-cleaner-review-text",
    icon: "text-cleaner-review-icon",
    badge:
      "border-cleaner-review-border bg-cleaner-review-surface text-cleaner-review-text",
    selectedRing: "ring-cleaner-review-border",
    checkbox:
      "border-cleaner-review bg-gray-100 text-cleaner-review-contrast peer-checked:bg-cleaner-review",
    button:
      "bg-cleaner-review text-cleaner-review-contrast hover:bg-cleaner-review/90",
  },
  excluded: {
    surface: "bg-cleaner-excluded-surface/58",
    border: "border-cleaner-excluded-border/75",
    text: "text-cleaner-excluded-text",
    icon: "text-cleaner-excluded-icon",
    badge:
      "border-cleaner-excluded-border bg-cleaner-excluded-surface text-cleaner-excluded-text",
    selectedRing: "ring-cleaner-excluded-border",
    checkbox: "accent-cleaner-excluded",
    button:
      "bg-cleaner-excluded text-cleaner-excluded-contrast hover:bg-cleaner-excluded/90",
  },
};

export const CLEANER_RECOMMENDATION_LABELS = {
  recommended: "Recommended",
  "useful-if-space-low": "Useful if space is low",
  "low-priority": "Low priority",
  "frequently-regenerated": "Frequently regenerated",
  protected: "Protected",
  "manual-review": "Manual review",
} as const;

export const CLEANER_REGENERATION_META = {
  "regenerated-quickly": { label: "Regenerated quickly", tone: "blocked" },
  "frequently-regenerates": {
    label: "Frequently regenerates",
    tone: "conditional",
  },
  "grows-slowly": { label: "Grows slowly", tone: "review" },
  "worth-cleaning-occasionally": {
    label: "Worth cleaning occasionally",
    tone: "safe",
  },
  "low-cleanup-value": { label: "Low cleanup value", tone: "excluded" },
  "regeneration-unknown": {
    label: "Regeneration unknown",
    tone: "review",
  },
  "not-cleaned-before": { label: "Not cleaned before", tone: "excluded" },
} as const satisfies Record<string, { label: string; tone: CleanerTone }>;

export function getCleanerVisualStatus(
  safety: CleanerSafety,
  excluded: boolean,
): CleanerVisualStatus {
  return excluded ? "excluded" : safety;
}
