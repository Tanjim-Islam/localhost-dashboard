export type CleanerStandardMeasurementPolicy = {
  kind: "standard-bounded";
  maxEntries: number;
  maxDurationMs: number;
  maxTrackedFileRecords: number;
};

export type CleanerDeepMeasurementPolicy = {
  kind: "deep-exhaustive";
};

export type CleanerMeasurementPolicy =
  CleanerStandardMeasurementPolicy | CleanerDeepMeasurementPolicy;

export const STANDARD_ACTIONABLE_MEASUREMENT_POLICY: CleanerStandardMeasurementPolicy =
  {
    kind: "standard-bounded",
    maxEntries: 50_000,
    maxDurationMs: 1_500,
    maxTrackedFileRecords: 50_000,
  };

export const STANDARD_INFORMATIONAL_MEASUREMENT_POLICY: CleanerStandardMeasurementPolicy =
  {
    kind: "standard-bounded",
    maxEntries: 5_000,
    maxDurationMs: 250,
    maxTrackedFileRecords: 5_000,
  };

export const DEEP_EXHAUSTIVE_MEASUREMENT_POLICY: CleanerDeepMeasurementPolicy =
  {
    kind: "deep-exhaustive",
  };

export const STANDARD_PROTECTED_MARKER_LIMITS = {
  maxEntries: 2_000,
  maxDepth: 8,
  maxDurationMs: 1_500,
} as const;
