export type CleanerScanState = Awaited<
  ReturnType<Window["api"]["getCleanerScanState"]>
>;

export type CleanerScanResult = Extract<
  CleanerScanState,
  { status: "complete" }
>["result"];

export type CleanerFinding = CleanerScanResult["findings"][number];

export type CleanerCleanupResult = Awaited<
  ReturnType<Window["api"]["cleanCleanerFindings"]>
>;

export type CleanerCleanupReceipt = Awaited<
  ReturnType<Window["api"]["getCleanerHistory"]>
>["cleanupReceipts"][number];

export type CleanerLegacyCleanupEvent = Awaited<
  ReturnType<Window["api"]["getCleanerHistory"]>
>["cleanupEvents"][number];

export type CleanerExclusion = Awaited<
  ReturnType<Window["api"]["getCleanerExclusions"]>
>[number];

export type CleanerPreferences = Awaited<
  ReturnType<Window["api"]["getCleanerPreferences"]>
>;

export type CleanerSafetyFilter = CleanerFinding["safety"] | "all" | "excluded";

export type CleanerSort = "recommended" | "size" | "safety";
