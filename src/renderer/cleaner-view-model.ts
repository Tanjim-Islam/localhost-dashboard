export type CleanerViewFinding = {
  id: string;
  detectorId: string;
  category: string;
  displayName: string;
  applicationName?: string;
  path: string;
  normalizedPath?: string;
  sizeBytes: number;
  logicalBytes?: number;
  allocatedBytes?: number | null;
  uniqueAllocatedBytes?: number | null;
  estimatedReclaimableBytes?: number | null;
  measurementCompleteness?: "complete" | "partial" | "unavailable";
  accountingConfidence?: "exact" | "estimated" | "lower-bound" | "unknown";
  accountingActionabilityBlocked?: boolean;
  measurementFailureCategory?:
    | "access-denied"
    | "path-disappeared"
    | "filesystem-io"
    | "unsupported-filesystem-metadata"
    | "filesystem-instability"
    | "worker-failed";
  measurementFailureExplanation?: string;
  sizeMeasurementWarnings?: string[];
  recoverableBytes?: number;
  overlapGroup?: string;
  cleanupValueScore?: number;
  dataKind?: string;
  recommendation?: string;
  relatedProcesses?: Array<{
    name: string;
    blocking: boolean;
  }>;
  safety:
    | "safe-now"
    | "safe-after-close"
    | "conditional"
    | "protected"
    | "manual-review";
  excluded: boolean;
  canDelete: boolean;
  manualApprovalAllowed?: boolean;
};

export type CleanerFindingFilters = {
  query: string;
  category: string;
  safety: string;
  showExcluded: boolean;
  sort: "recommended" | "size" | "safety";
};

export type CleanerSummarySafetyFilter =
  | "all"
  | "safe-now"
  | "safe-after-close"
  | "conditional"
  | "protected"
  | "manual-review"
  | "excluded";

export function resolveCleanerSummaryFilterTransition(
  safety: CleanerSummarySafetyFilter,
  showExcluded: boolean,
): { safety: CleanerSummarySafetyFilter; showExcluded: boolean } {
  return {
    safety,
    showExcluded:
      safety === "excluded" ? true : safety === "all" ? showExcluded : false,
  };
}

const SAFETY_ORDER: Record<CleanerViewFinding["safety"], number> = {
  "safe-now": 0,
  "safe-after-close": 1,
  conditional: 2,
  "manual-review": 3,
  protected: 4,
};

const CLEANER_ISSUE_ORDER: CleanerIssueGroup["key"][] = [
  "access-denied",
  "target-changed",
  "physical-accounting",
  "inaccessible-location",
  "accounting-worker",
  "scan-limits",
  "other",
];

const CLEANER_ISSUE_META: Record<
  CleanerIssueGroup["key"],
  Pick<CleanerIssueGroup, "label" | "description">
> = {
  "access-denied": {
    label: "Access denied",
    description: "Cleaner could not read one or more entries.",
  },
  "target-changed": {
    label: "Target changed during scan",
    description: "The target changed or disappeared while it was measured.",
  },
  "physical-accounting": {
    label: "Unsupported physical accounting",
    description:
      "Physical recovery could not be calculated, so these findings are excluded from recovery totals.",
  },
  "inaccessible-location": {
    label: "Inaccessible system location",
    description: "The filesystem returned an input or output error.",
  },
  "accounting-worker": {
    label: "Accounting worker",
    description: "The background accounting worker stopped unexpectedly.",
  },
  "scan-limits": {
    label: "Scan limits",
    description: "The bounded Standard Scan did not finish every check.",
  },
  other: {
    label: "Other scan issues",
    description: "Cleaner reported an issue that needs review.",
  },
};

function measurementIssueKey(
  category: NonNullable<CleanerViewFinding["measurementFailureCategory"]>,
): CleanerIssueGroup["key"] {
  switch (category) {
    case "access-denied":
      return "access-denied";
    case "path-disappeared":
    case "filesystem-instability":
      return "target-changed";
    case "unsupported-filesystem-metadata":
      return "physical-accounting";
    case "filesystem-io":
      return "inaccessible-location";
    case "worker-failed":
      return "accounting-worker";
  }
}

function classifyCleanerWarning(warning: string): CleanerIssueGroup["key"] {
  if (/access denied|permission/i.test(warning)) return "access-denied";
  if (/changed|disappeared|instability/i.test(warning)) {
    return "target-changed";
  }
  if (/physical|allocation|hardlink|metadata/i.test(warning)) {
    return "physical-accounting";
  }
  if (/input or output|filesystem|system location/i.test(warning)) {
    return "inaccessible-location";
  }
  if (/worker/i.test(warning)) return "accounting-worker";
  if (/time budget|bounded|limit/i.test(warning)) return "scan-limits";
  return "other";
}

export type CleanerSummaryMetrics = {
  safeNowBytes: number;
  safeNowCount: number;
  safeAfterCloseBytes: number;
  safeAfterCloseCount: number;
  conditionalBytes: number;
  conditionalCount: number;
  conditionalRecoverableBytes: number;
  protectedBytes: number;
  protectedCount: number;
  manualReviewBytes: number;
  manualReviewCount: number;
  excludedBytes: number;
  excludedCount: number;
  estimatedRecoverableNowBytes: number;
  unknownRecoverableCount: number;
  unknownRecoverableLogicalBytes: number;
  partialLogicalBytes: number;
};

export type CleanerSelectionTone =
  "none" | "safe" | "conditional" | "manual-review";

export type CleanerCompactSize = {
  estimatedRecoveryBytes: number | null;
  logicalBytes: number;
  showLogicalSize: boolean;
  accountingIndicator: string | null;
};

export type CleanerIssueGroup = {
  key:
    | "access-denied"
    | "target-changed"
    | "physical-accounting"
    | "inaccessible-location"
    | "accounting-worker"
    | "scan-limits"
    | "other";
  label: string;
  description: string;
  items: string[];
};

export type CleanerIssueSummary = {
  count: number;
  groups: CleanerIssueGroup[];
  unknownRecoverableFindingCount: number;
  unknownRecoverableLogicalBytes: number;
};

export function cleanerTabAvailable(
  platform: string,
  features: { cleaner: boolean },
): boolean {
  return platform === "win32" && features.cleaner;
}

export function canApproveManualReviewFinding(
  finding: CleanerViewFinding,
): boolean {
  return (
    finding.safety === "manual-review" &&
    !finding.excluded &&
    finding.manualApprovalAllowed === true
  );
}

export function canSelectCleanerFinding(
  finding: CleanerViewFinding,
  manualReviewApproved = false,
): boolean {
  if (finding.safety === "manual-review") {
    return manualReviewApproved && canApproveManualReviewFinding(finding);
  }
  return (
    !finding.excluded &&
    finding.canDelete &&
    finding.measurementCompleteness === "complete" &&
    typeof finding.estimatedReclaimableBytes === "number" &&
    (finding.safety === "safe-now" || finding.safety === "conditional")
  );
}

export function getCleanerCompactSize(
  finding: CleanerViewFinding,
): CleanerCompactSize {
  const logicalBytes = finding.logicalBytes ?? finding.sizeBytes;
  const measurementComplete =
    finding.measurementCompleteness === undefined ||
    finding.measurementCompleteness === "complete";
  const fallbackRecovery =
    finding.estimatedReclaimableBytes === undefined &&
    typeof finding.recoverableBytes === "number"
      ? finding.recoverableBytes
      : null;
  const estimatedRecoveryBytes =
    measurementComplete &&
    typeof (finding.estimatedReclaimableBytes ?? fallbackRecovery) === "number"
      ? (finding.estimatedReclaimableBytes ?? fallbackRecovery)
      : null;
  const meaningfulDifference =
    estimatedRecoveryBytes === null ||
    Math.abs(logicalBytes - estimatedRecoveryBytes) >=
      Math.max(1024 ** 2, logicalBytes * 0.1);

  let accountingIndicator: string | null = null;
  if (!measurementComplete) {
    accountingIndicator = "Incomplete measurement";
  } else if (estimatedRecoveryBytes === null) {
    accountingIndicator = "Recovery unknown";
  } else if (finding.accountingConfidence === "lower-bound") {
    accountingIndicator = "Lower-bound estimate";
  } else if (
    (finding.logicalBytes ?? finding.sizeBytes) >
    estimatedRecoveryBytes * 1.1
  ) {
    accountingIndicator = "Hardlinks adjusted";
  }

  return {
    estimatedRecoveryBytes,
    logicalBytes,
    showLogicalSize: meaningfulDifference,
    accountingIndicator,
  };
}

export function getCleanerCompactReason(finding: CleanerViewFinding): string {
  if (finding.excluded) {
    return "Hidden from cleanup by an exclusion rule.";
  }

  if (finding.safety === "safe-after-close") {
    return "Close the related app first, then scan again.";
  }

  if (finding.safety === "conditional") {
    if (
      finding.dataKind === "download-cache" ||
      finding.dataKind === "installed-runtime" ||
      finding.dataKind === "model-data"
    ) {
      return "May need to be downloaded again. Review details before cleaning.";
    }
    if (
      finding.dataKind === "build-cache" ||
      finding.dataKind === "compiled-cache"
    ) {
      return "May require a rebuild. Review details before cleaning.";
    }
    return "Review the restore cost before selecting this item.";
  }

  if (finding.safety === "protected") {
    return "Protected app, project, user, or system data. Cleanup is blocked.";
  }

  if (finding.safety === "manual-review") {
    return finding.manualApprovalAllowed
      ? "Review and approve this item before selecting it."
      : "Safety or accounting requirements are not complete, so cleanup remains blocked.";
  }

  if (
    finding.measurementCompleteness === "partial" ||
    finding.measurementCompleteness === "unavailable"
  ) {
    return "Recovery could not be measured completely, so cleanup is blocked.";
  }

  return "Safe to remove. It can be recreated when needed.";
}

export function buildCleanerIssueSummary(result: {
  summary: {
    scanIncomplete: boolean;
    scanWarnings: string[];
    unknownRecoverableFindingCount: number;
    unknownRecoverableLogicalBytes: number;
  };
  findings: CleanerViewFinding[];
}): CleanerIssueSummary {
  const groups = new Map<CleanerIssueGroup["key"], CleanerIssueGroup>();
  const issueKeys = new Set<string>();

  const addIssue = (
    key: CleanerIssueGroup["key"],
    item: string,
    issueKey: string,
  ) => {
    const meta = CLEANER_ISSUE_META[key];
    const group = groups.get(key) ?? { key, ...meta, items: [] };
    if (!group.items.includes(item)) group.items.push(item);
    groups.set(key, group);
    issueKeys.add(issueKey);
  };

  for (const finding of result.findings) {
    if (finding.measurementFailureCategory) {
      addIssue(
        measurementIssueKey(finding.measurementFailureCategory),
        finding.displayName,
        `finding:${finding.id}`,
      );
      continue;
    }
    if (finding.accountingActionabilityBlocked) {
      addIssue(
        "physical-accounting",
        finding.displayName,
        `finding:${finding.id}`,
      );
    }
  }

  const findingNames = result.findings.map((finding) =>
    finding.displayName.toLowerCase(),
  );
  for (const warning of [...new Set(result.summary.scanWarnings)]) {
    const normalized = warning.trim().replace(/\s+/g, " ");
    const warningLower = normalized.toLowerCase();
    const referencesKnownFinding = findingNames.some((name) =>
      warningLower.includes(name),
    );
    const key = classifyCleanerWarning(normalized);
    if (
      referencesKnownFinding ||
      (groups.has(key) && /one or more|could not be measured/i.test(normalized))
    ) {
      continue;
    }
    addIssue(key, normalized, `warning:${normalized.toLowerCase()}`);
  }

  if (
    result.summary.scanIncomplete &&
    groups.size === 0 &&
    result.summary.scanWarnings.length === 0
  ) {
    addIssue(
      "other",
      "The scan did not finish every requested check.",
      "scan:incomplete",
    );
  }

  return {
    count: Math.max(
      issueKeys.size,
      result.summary.unknownRecoverableFindingCount,
    ),
    groups: CLEANER_ISSUE_ORDER.flatMap((key) => {
      const group = groups.get(key);
      return group ? [group] : [];
    }),
    unknownRecoverableFindingCount:
      result.summary.unknownRecoverableFindingCount,
    unknownRecoverableLogicalBytes:
      result.summary.unknownRecoverableLogicalBytes,
  };
}

export function selectAllSafeNow(findings: CleanerViewFinding[]): string[] {
  return findings
    .filter(
      (finding) =>
        finding.safety === "safe-now" && canSelectCleanerFinding(finding),
    )
    .map((finding) => finding.id);
}

export function conditionalConfirmationRequired(
  findings: CleanerViewFinding[],
  selectedIds: ReadonlySet<string>,
): boolean {
  return findings.some(
    (finding) =>
      selectedIds.has(finding.id) && finding.safety === "conditional",
  );
}

function normalizeComparablePath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
}

function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = normalizeComparablePath(child);
  const normalizedParent = normalizeComparablePath(parent);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}\\`)
  );
}

export function calculateUnionRecoverableBytes(
  findings: CleanerViewFinding[],
): number {
  const included: CleanerViewFinding[] = [];
  let total = 0;
  for (const finding of [...findings]
    .filter((item) => (item.recoverableBytes ?? 0) > 0)
    .sort(
      (left, right) =>
        (left.normalizedPath ?? left.path).length -
        (right.normalizedPath ?? right.path).length,
    )) {
    const findingPath = finding.normalizedPath ?? finding.path;
    if (
      included.some((parent) =>
        isPathInside(findingPath, parent.normalizedPath ?? parent.path),
      )
    ) {
      continue;
    }
    included.push(finding);
    total += finding.recoverableBytes ?? 0;
  }
  return total;
}

export function calculateUnionLogicalBytes(
  findings: CleanerViewFinding[],
): number {
  const included: CleanerViewFinding[] = [];
  let total = 0;
  for (const finding of [...findings].sort(
    (left, right) =>
      (left.normalizedPath ?? left.path).length -
      (right.normalizedPath ?? right.path).length,
  )) {
    const findingPath = finding.normalizedPath ?? finding.path;
    if (
      included.some((parent) =>
        isPathInside(findingPath, parent.normalizedPath ?? parent.path),
      )
    ) {
      continue;
    }
    included.push(finding);
    total += finding.logicalBytes ?? finding.sizeBytes;
  }
  return total;
}

export function calculateCleanerSummaryMetrics(
  findings: CleanerViewFinding[],
): CleanerSummaryMetrics {
  const included = findings.filter((finding) => !finding.excluded);
  const bySafety = (safety: CleanerViewFinding["safety"]) =>
    included.filter((finding) => finding.safety === safety);
  const sumSize = (items: CleanerViewFinding[]) =>
    calculateUnionLogicalBytes(items);
  const safeNow = bySafety("safe-now");
  const safeAfterClose = bySafety("safe-after-close");
  const conditional = bySafety("conditional");
  const protectedItems = bySafety("protected");
  const manualReview = bySafety("manual-review");
  const excluded = findings.filter((finding) => finding.excluded);

  return {
    safeNowBytes: sumSize(safeNow),
    safeNowCount: safeNow.length,
    safeAfterCloseBytes: sumSize(safeAfterClose),
    safeAfterCloseCount: safeAfterClose.length,
    conditionalBytes: sumSize(conditional),
    conditionalCount: conditional.length,
    conditionalRecoverableBytes: calculateUnionRecoverableBytes(conditional),
    protectedBytes: sumSize(protectedItems),
    protectedCount: protectedItems.length,
    manualReviewBytes: sumSize(manualReview),
    manualReviewCount: manualReview.length,
    excludedBytes: sumSize(excluded),
    excludedCount: excluded.length,
    estimatedRecoverableNowBytes: calculateUnionRecoverableBytes(safeNow),
    unknownRecoverableCount: included.filter(
      (finding) => finding.accountingActionabilityBlocked,
    ).length,
    unknownRecoverableLogicalBytes: calculateUnionLogicalBytes(
      included.filter((finding) => finding.accountingActionabilityBlocked),
    ),
    partialLogicalBytes: calculateUnionLogicalBytes(
      included.filter(
        (finding) =>
          finding.measurementCompleteness === "partial" ||
          finding.measurementCompleteness === "unavailable",
      ),
    ),
  };
}

export function calculateSelectedRecoverableBytes(
  findings: CleanerViewFinding[],
  selectedIds: ReadonlySet<string>,
): number {
  return calculateUnionRecoverableBytes(
    findings.filter((finding) => selectedIds.has(finding.id)),
  );
}

export function getCleanerSelectionTone(
  findings: CleanerViewFinding[],
  selectedIds: ReadonlySet<string>,
): CleanerSelectionTone {
  const selected = findings.filter((finding) => selectedIds.has(finding.id));
  if (selected.length === 0) return "none";
  if (selected.some((finding) => finding.safety === "manual-review")) {
    return "manual-review";
  }
  return selected.some((finding) => finding.safety === "conditional")
    ? "conditional"
    : "safe";
}

export function filterCleanerFindings<T extends CleanerViewFinding>(
  findings: T[],
  filters: CleanerFindingFilters,
): T[] {
  const query = filters.query.trim().toLowerCase();
  return findings
    .filter((finding) =>
      filters.safety === "excluded"
        ? finding.excluded
        : filters.showExcluded || !finding.excluded,
    )
    .filter(
      (finding) =>
        filters.category === "all" || finding.category === filters.category,
    )
    .filter(
      (finding) =>
        filters.safety === "all" ||
        filters.safety === "excluded" ||
        finding.safety === filters.safety,
    )
    .filter((finding) => {
      if (!query) return true;
      return [
        finding.displayName,
        finding.applicationName ?? "",
        finding.detectorId,
        finding.category,
        finding.path,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((left, right) => {
      if (filters.sort === "size") return right.sizeBytes - left.sizeBytes;
      const leftPriority = left.excluded ? 5 : SAFETY_ORDER[left.safety];
      const rightPriority = right.excluded ? 5 : SAFETY_ORDER[right.safety];
      const priority = leftPriority - rightPriority;
      if (priority !== 0) return priority;
      if (filters.sort === "recommended") {
        const score =
          (right.cleanupValueScore ?? 0) - (left.cleanupValueScore ?? 0);
        if (score !== 0) return score;
      }
      return right.sizeBytes - left.sizeBytes;
    });
}
