import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  buildCleanerIssueSummary,
  calculateCleanerSummaryMetrics,
  calculateSelectedRecoverableBytes,
  canApproveManualReviewFinding,
  canSelectCleanerFinding,
  cleanerTabAvailable,
  conditionalConfirmationRequired,
  filterCleanerFindings,
  getCleanerCompactReason,
  getCleanerCompactSize,
  getCleanerSelectionTone,
  resolveCleanerSummaryFilterTransition,
  selectAllSafeNow,
  type CleanerViewFinding,
} from "../src/renderer/cleaner-view-model";
import {
  CLEANER_STATUS_META,
  CLEANER_TONE_STYLES,
} from "../src/renderer/cleaner-semantics";
import { CLEANER_SEMANTIC_TOKENS_BY_MODE } from "../src/renderer/cleaner-theme-tokens";
import { THEME_REGISTRY } from "../src/renderer/theme/themeRegistry";
import {
  formatCleanerBytes,
  formatCleanerSignedBytes,
} from "../src/renderer/cleaner-format";

const findings: CleanerViewFinding[] = (
  [
    {
      id: "safe",
      detectorId: "dev.npm-cache",
      category: "Node",
      displayName: "npm cache",
      applicationName: "npm",
      path: "C:\\fixture\\npm",
      normalizedPath: "c:\\fixture\\npm",
      sizeBytes: 500,
      recoverableBytes: 500,
      cleanupValueScore: 80,
      safety: "safe-now",
      excluded: false,
      canDelete: true,
    },
    {
      id: "after-close",
      detectorId: "dev.uv-cache",
      category: "Python",
      displayName: "uv cache",
      applicationName: "uv",
      path: "C:\\fixture\\uv",
      normalizedPath: "c:\\fixture\\uv",
      sizeBytes: 600,
      recoverableBytes: 0,
      cleanupValueScore: 75,
      safety: "safe-after-close",
      excluded: false,
      canDelete: false,
    },
    {
      id: "conditional",
      detectorId: "dev.playwright",
      category: "Node",
      displayName: "Playwright",
      applicationName: "Playwright",
      path: "C:\\fixture\\playwright",
      normalizedPath: "c:\\fixture\\playwright",
      sizeBytes: 1_000,
      recoverableBytes: 1_000,
      cleanupValueScore: 65,
      safety: "conditional",
      excluded: false,
      canDelete: true,
    },
    {
      id: "manual",
      detectorId: "audit.unknown",
      category: "Audit",
      displayName: "Unknown build store",
      path: "C:\\fixture\\unknown",
      normalizedPath: "c:\\fixture\\unknown",
      sizeBytes: 700,
      recoverableBytes: 700,
      cleanupValueScore: 0,
      safety: "manual-review",
      excluded: false,
      canDelete: false,
      manualApprovalAllowed: true,
    },
    {
      id: "protected",
      detectorId: "browser.brave",
      category: "Browser",
      displayName: "Brave profile",
      applicationName: "Brave",
      path: "C:\\fixture\\brave",
      normalizedPath: "c:\\fixture\\brave",
      sizeBytes: 2_000,
      recoverableBytes: 0,
      cleanupValueScore: 0,
      safety: "protected",
      excluded: false,
      canDelete: false,
    },
    {
      id: "excluded",
      detectorId: "dev.yarn-cache",
      category: "Node",
      displayName: "Yarn cache",
      applicationName: "Yarn",
      path: "C:\\fixture\\yarn",
      normalizedPath: "c:\\fixture\\yarn",
      sizeBytes: 800,
      recoverableBytes: 0,
      cleanupValueScore: 70,
      safety: "safe-now",
      excluded: true,
      canDelete: true,
    },
  ] satisfies CleanerViewFinding[]
).map((finding) => ({
  ...finding,
  logicalBytes: finding.sizeBytes,
  estimatedReclaimableBytes: finding.recoverableBytes ?? null,
  measurementCompleteness: "complete",
  accountingConfidence: "exact",
}));

test("Cleaner tab is available only for guarded Windows metadata", () => {
  assert.equal(cleanerTabAvailable("win32", { cleaner: true }), true);
  assert.equal(cleanerTabAvailable("darwin", { cleaner: true }), false);
  assert.equal(cleanerTabAvailable("linux", { cleaner: true }), false);
  assert.equal(cleanerTabAvailable("win32", { cleaner: false }), false);
});

test("selection rules block protected and excluded items and bulk-select only safe-now", () => {
  assert.equal(canSelectCleanerFinding(findings[0]), true);
  assert.equal(canSelectCleanerFinding(findings[1]), false);
  assert.equal(canSelectCleanerFinding(findings[2]), true);
  assert.equal(canSelectCleanerFinding(findings[3]), false);
  assert.equal(canApproveManualReviewFinding(findings[3]), true);
  assert.equal(canSelectCleanerFinding(findings[3], true), true);
  assert.equal(
    canSelectCleanerFinding(
      {
        ...findings[3],
        estimatedReclaimableBytes: null,
        measurementCompleteness: "partial",
      },
      true,
    ),
    true,
  );
  assert.equal(canSelectCleanerFinding(findings[4]), false);
  assert.equal(canSelectCleanerFinding(findings[5]), false);
  assert.deepEqual(selectAllSafeNow(findings), ["safe"]);
  assert.equal(
    conditionalConfirmationRequired(findings, new Set(["conditional"])),
    true,
  );
  assert.equal(getCleanerSelectionTone(findings, new Set()), "none");
  assert.equal(getCleanerSelectionTone(findings, new Set(["safe"])), "safe");
  assert.equal(
    getCleanerSelectionTone(findings, new Set(["safe", "conditional"])),
    "conditional",
  );
  assert.equal(
    getCleanerSelectionTone(findings, new Set(["safe", "manual"])),
    "manual-review",
  );
});

test("summary and selected recovery calculations match the displayed labels", () => {
  const summary = calculateCleanerSummaryMetrics(findings);
  assert.deepEqual(summary, {
    safeNowBytes: 500,
    safeNowCount: 1,
    safeAfterCloseBytes: 600,
    safeAfterCloseCount: 1,
    conditionalBytes: 1_000,
    conditionalCount: 1,
    conditionalRecoverableBytes: 1_000,
    protectedBytes: 2_000,
    protectedCount: 1,
    manualReviewBytes: 700,
    manualReviewCount: 1,
    excludedBytes: 800,
    excludedCount: 1,
    estimatedRecoverableNowBytes: 500,
    unknownRecoverableCount: 0,
    unknownRecoverableLogicalBytes: 0,
    partialLogicalBytes: 0,
  });
  assert.equal(
    calculateSelectedRecoverableBytes(
      findings,
      new Set(["safe", "conditional"]),
    ),
    1_500,
  );
  assert.equal(
    calculateSelectedRecoverableBytes(
      findings,
      new Set(["safe", "conditional", "manual"]),
    ),
    2_200,
  );
});

test("compact finding sizes keep physical recovery separate from logical size", () => {
  const hardlinked: CleanerViewFinding = {
    ...findings[0],
    logicalBytes: 8 * 1024 ** 3,
    sizeBytes: 8 * 1024 ** 3,
    estimatedReclaimableBytes: 2 * 1024 ** 3,
    recoverableBytes: 2 * 1024 ** 3,
    measurementCompleteness: "complete",
    accountingConfidence: "estimated",
  };
  assert.deepEqual(getCleanerCompactSize(hardlinked), {
    estimatedRecoveryBytes: 2 * 1024 ** 3,
    logicalBytes: 8 * 1024 ** 3,
    showLogicalSize: true,
    accountingIndicator: "Hardlinks adjusted",
  });

  const partial: CleanerViewFinding = {
    ...hardlinked,
    measurementCompleteness: "partial",
    accountingActionabilityBlocked: true,
  };
  assert.equal(getCleanerCompactSize(partial).estimatedRecoveryBytes, null);
  assert.equal(
    getCleanerCompactSize(partial).accountingIndicator,
    "Incomplete measurement",
  );
  assert.equal(canSelectCleanerFinding(partial), false);
});

test("compact finding reasons stay short while preserving safety decisions", () => {
  assert.equal(
    getCleanerCompactReason(findings[0]),
    "Safe to remove. It can be recreated when needed.",
  );
  assert.equal(
    getCleanerCompactReason({
      ...findings[1],
      relatedProcesses: [{ name: "uv", blocking: true }],
    }),
    "Close the related app first, then scan again.",
  );
  assert.match(getCleanerCompactReason(findings[4]), /Cleanup is blocked/);
  assert.match(getCleanerCompactReason(findings[5]), /exclusion rule/);
});

test("scan issues are grouped and unknown recovery remains excluded", () => {
  const issueSummary = buildCleanerIssueSummary({
    summary: {
      scanIncomplete: true,
      scanWarnings: [
        "npm cache could not be measured completely. Access was denied.",
        "One or more otherwise actionable findings lacked complete physical-recovery metadata and were excluded from cleanup totals.",
      ],
      unknownRecoverableFindingCount: 2,
      unknownRecoverableLogicalBytes: 4 * 1024 ** 3,
    },
    findings: [
      {
        ...findings[0],
        measurementFailureCategory: "access-denied",
        accountingActionabilityBlocked: true,
      },
      {
        ...findings[2],
        accountingActionabilityBlocked: true,
        estimatedReclaimableBytes: null,
      },
    ],
  });

  assert.equal(issueSummary.count, 2);
  assert.deepEqual(
    issueSummary.groups.map((group) => group.label),
    ["Access denied", "Unsupported physical accounting"],
  );
  assert.equal(issueSummary.unknownRecoverableLogicalBytes, 4 * 1024 ** 3);
});

test("nested selected paths are not double-counted in recoverable totals", () => {
  const nested: CleanerViewFinding = {
    ...findings[0],
    id: "nested",
    path: "C:\\fixture\\npm\\nested",
    normalizedPath: "c:\\fixture\\npm\\nested",
    sizeBytes: 200,
    recoverableBytes: 200,
  };
  assert.equal(
    calculateSelectedRecoverableBytes(
      [...findings, nested],
      new Set(["safe", "nested"]),
    ),
    500,
  );
});

test("recommended order prioritizes actionability and keeps excluded findings last", () => {
  assert.deepEqual(
    filterCleanerFindings(findings, {
      query: "",
      category: "all",
      safety: "all",
      showExcluded: true,
      sort: "recommended",
    }).map((item) => item.id),
    ["safe", "after-close", "conditional", "manual", "protected", "excluded"],
  );
});

test("search, category, safety, excluded visibility, and explicit sorting are deterministic", () => {
  assert.deepEqual(
    filterCleanerFindings(findings, {
      query: "brave",
      category: "all",
      safety: "all",
      showExcluded: true,
      sort: "size",
    }).map((item) => item.id),
    ["protected"],
  );
  assert.deepEqual(
    filterCleanerFindings(findings, {
      query: "",
      category: "Node",
      safety: "all",
      showExcluded: false,
      sort: "safety",
    }).map((item) => item.id),
    ["safe", "conditional"],
  );
  assert.deepEqual(
    filterCleanerFindings(findings, {
      query: "",
      category: "all",
      safety: "excluded",
      showExcluded: true,
      sort: "recommended",
    }).map((item) => item.id),
    ["excluded"],
  );
});

test("summary filters preserve the requested safety when leaving Excluded", () => {
  assert.deepEqual(resolveCleanerSummaryFilterTransition("excluded", false), {
    safety: "excluded",
    showExcluded: true,
  });
  assert.deepEqual(resolveCleanerSummaryFilterTransition("protected", true), {
    safety: "protected",
    showExcluded: false,
  });
  assert.deepEqual(resolveCleanerSummaryFilterTransition("all", true), {
    safety: "all",
    showExcluded: true,
  });
});

test("Cleaner status metadata uses one text, icon, and tone mapping", () => {
  assert.deepEqual(Object.keys(CLEANER_STATUS_META), [
    "safe-now",
    "safe-after-close",
    "conditional",
    "protected",
    "manual-review",
    "excluded",
  ]);
  for (const meta of Object.values(CLEANER_STATUS_META)) {
    assert.ok(meta.label.length > 0);
    assert.ok(meta.description.length > 0);
    assert.ok(meta.icon.length > 0);
    assert.ok(CLEANER_TONE_STYLES[meta.tone].badge.includes("border-cleaner-"));
  }
});

test("Cleaner semantic text and button colors meet contrast targets in light and dark modes", () => {
  for (const [mode, tokens] of Object.entries(
    CLEANER_SEMANTIC_TOKENS_BY_MODE,
  )) {
    const surfacePairs = [
      [tokens.safeText, tokens.safeSurface, "safe"],
      [tokens.blockedText, tokens.blockedSurface, "blocked"],
      [tokens.conditionalText, tokens.conditionalSurface, "conditional"],
      [tokens.dangerText, tokens.dangerSurface, "danger"],
      [tokens.reviewText, tokens.reviewSurface, "review"],
      [tokens.excludedText, tokens.excludedSurface, "excluded"],
      [tokens.recoveryText, tokens.recoverySurface, "recovery"],
    ] as const;
    const buttonPairs = [
      [tokens.safeContrast, tokens.safe, "safe button"],
      [tokens.blockedContrast, tokens.blocked, "blocked button"],
      [tokens.conditionalContrast, tokens.conditional, "conditional button"],
      [tokens.dangerContrast, tokens.danger, "danger button"],
      [tokens.reviewContrast, tokens.review, "review button"],
      [tokens.excludedContrast, tokens.excluded, "excluded button"],
      [tokens.recoveryContrast, tokens.recovery, "recovery button"],
    ] as const;
    for (const [foreground, background, label] of [
      ...surfacePairs,
      ...buttonPairs,
    ]) {
      assert.ok(
        contrastRatio(foreground, background) >= 4.5,
        `${mode} ${label} contrast was ${contrastRatio(foreground, background)}`,
      );
    }
    assert.equal(
      new Set([
        tokens.safe,
        tokens.blocked,
        tokens.conditional,
        tokens.danger,
        tokens.review,
        tokens.excluded,
      ]).size,
      6,
    );
  }
});

test("every registered theme receives the correct Cleaner semantic token set", () => {
  assert.ok(THEME_REGISTRY.length > 1);
  for (const palette of THEME_REGISTRY) {
    const tokens = CLEANER_SEMANTIC_TOKENS_BY_MODE[palette.mode];
    assert.ok(contrastRatio(tokens.safeText, tokens.safeSurface) >= 4.5);
    assert.ok(contrastRatio(tokens.blockedText, tokens.blockedSurface) >= 4.5);
    assert.ok(
      contrastRatio(tokens.conditionalText, tokens.conditionalSurface) >= 4.5,
    );
    assert.ok(contrastRatio(tokens.dangerText, tokens.dangerSurface) >= 4.5);
    assert.ok(contrastRatio(tokens.reviewText, tokens.reviewSurface) >= 4.5);
    assert.ok(
      contrastRatio(tokens.excludedText, tokens.excludedSurface) >= 4.5,
    );
  }
});

test("Cleaner finding cards keep semantic styling without the thick left accent strip", () => {
  const card = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerFindingCard.tsx",
  );

  assert.doesNotMatch(card, /absolute inset-y-0 left-0 w-1/);
  assert.match(card, /\$\{styles\.border\}/);
  assert.match(card, /CleanerStatusBadge/);
  assert.match(card, /getCleanerCompactReason/);
  assert.match(card, /getCleanerCompactSize/);
  assert.match(card, /cleaner-line-clamp-2/);
});

test("Cleaner finding cards expose visible themed selection and blocked controls", () => {
  const card = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerFindingCard.tsx",
  );

  assert.match(card, /data-cleaner-selection-control="selectable"/);
  assert.match(card, /type="checkbox"/);
  assert.match(card, /className="peer sr-only"/);
  assert.match(card, /data-cleaner-checkbox-visual="true"/);
  assert.match(card, /h-5 w-5/);
  assert.match(card, /border-2/);
  assert.match(card, /focus-within:ring-2/);
  assert.match(card, /data-cleaner-selection-control="blocked"/);
  assert.match(card, /aria-disabled="true"/);
  assert.match(card, /finding\.safety === "protected"/);
  assert.match(card, /finding\.safety === "manual-review"/);
  assert.match(card, /canApproveManualReviewFinding/);
  assert.match(card, /data-cleaner-manual-review-action="true"/);
  assert.match(card, /approvalAllowed \? "Review" : "Unavailable"/);
  assert.match(card, /Size unknown/);
  assert.doesNotMatch(card, /I reviewed this item and approve cleanup/);
  assert.match(
    card,
    /getCleanerVisualStatus\(finding\.safety, finding\.excluded\)/,
  );

  for (const tone of ["safe", "conditional", "review"] as const) {
    assert.match(CLEANER_TONE_STYLES[tone].checkbox, /border-cleaner-/);
    assert.match(CLEANER_TONE_STYLES[tone].checkbox, /bg-gray-100/);
    assert.match(
      CLEANER_TONE_STYLES[tone].checkbox,
      /peer-checked:bg-cleaner-/,
    );
  }

  for (const palette of THEME_REGISTRY) {
    const tokens = CLEANER_SEMANTIC_TOKENS_BY_MODE[palette.mode];
    assert.ok(
      contrastRatio(tokens.safe, palette.semanticTokens.card) >= 3,
      `${palette.name} safe checkbox border was not distinct from the card`,
    );
    assert.ok(
      contrastRatio(tokens.conditional, palette.semanticTokens.card) >= 3,
      `${palette.name} conditional checkbox border was not distinct from the card`,
    );
  }
});

test("manual-review confirmation shows each selected name and path", () => {
  const dialog = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerConfirmationDialog.tsx",
  );

  assert.match(dialog, /Confirm manual-review cleanup/);
  assert.match(dialog, /CLEAN MANUAL REVIEW/);
  assert.match(dialog, /\{finding\.displayName\}/);
  assert.match(dialog, /\{finding\.path\}/);
  assert.match(dialog, /Yes, clean what can be cleaned/);
  assert.match(
    dialog,
    /Active builds, installs, or applications may be affected/,
  );
  assert.match(dialog, /skip files Windows/);
});

test("Cleaner renderer keeps technical evidence in collapsed grouped details", () => {
  const card = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerFindingCard.tsx",
  );
  const details = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerDetailsAccordion.tsx",
  );
  const summary = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerSummary.tsx",
  );
  const tab = readCleanerRendererSource("components", "CleanerTab.tsx");

  for (const label of [
    "Storage",
    "Safety",
    "Application",
    "History",
    "Installation",
    "Data kind",
    "Leftover cache",
    "Shared ownership",
    "Recommendation",
    "Strong evidence",
    "Supporting evidence",
    "Unavailable sources",
  ]) {
    assert.match(card, new RegExp(label));
  }
  assert.match(card, /finding\.history/);
  assert.doesNotMatch(card, /Process evidence/);
  assert.doesNotMatch(card, /finding\.relatedProcesses\.map/);
  assert.doesNotMatch(card, /formatCleanerRunningState/);
  assert.match(details, /useState\(false\)/);
  assert.match(details, /\{open &&/);
  assert.match(details, />Details</);
  assert.match(details, /Exact path/);
  assert.match(summary, /Free:/);
  assert.match(summary, /How estimates work/);
  assert.match(summary, /Scan-time free space/);
  assert.doesNotMatch(summary, /<strong>Size accounting:/);
  assert.doesNotMatch(card, /CleanerProcessWarning/);
  assert.match(tab, /refreshCleanerFreeSpace/);
  assert.equal(formatCleanerBytes(1024), "1.00 KiB");
  assert.equal(formatCleanerBytes(1024 ** 2), "1.00 MiB");
  assert.equal(formatCleanerBytes(2.34 * 1024 ** 3), "2.34 GiB");
  assert.doesNotMatch(formatCleanerBytes(1024 ** 3), /\bGB\b/);
});

test("Cleaner accounting UI separates physical recovery and uses one-time receipts plus compact history", () => {
  const card = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerFindingCard.tsx",
  );
  const summary = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerSummary.tsx",
  );
  const tab = readCleanerRendererSource("components", "CleanerTab.tsx");
  const historyDrawer = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerHistoryDrawer.tsx",
  );
  const actionBar = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerActionBar.tsx",
  );

  assert.match(summary, /Estimated recoverable/);
  assert.match(summary, /could not be included in recovery estimates/);
  assert.match(summary, /Recovery and logical size are separate measurements/);
  assert.match(summary, /View issues/);
  assert.doesNotMatch(summary, /Safe to recover now/);
  assert.match(card, /Estimated recovery/);
  assert.match(card, /"Logical size"/);
  assert.match(card, /"Hardlinks"/);
  assert.match(tab, /setCleanupHistory\(history\.cleanupHistory\)/);
  assert.match(tab, /dismissCleanerCleanupReceipt/);
  assert.doesNotMatch(tab, /setCleanupResult\(history\./);
  assert.doesNotMatch(tab, /Earlier cleanup receipts/);
  assert.doesNotMatch(tab, /Legacy cleanup history/);
  assert.match(tab, /Technical receipt details/);
  assert.match(tab, /aria-label="Dismiss cleanup receipt"/);
  assert.match(tab, /onDismiss=\{\(\) => void dismissCleanupResult\(\)\}/);
  assert.match(tab, /signedFreeSpaceDeltaBytes/);
  assert.match(tab, /status === "partial"/);
  assert.match(tab, /border-cleaner-conditional-border/);
  assert.match(actionBar, /> History \(/);
  assert.match(historyDrawer, /Cleanup history/);
  assert.match(historyDrawer, /Completed cleanup runs, newest first/);
  assert.match(historyDrawer, /entry\.freeSpaceBeforeBytes/);
  assert.match(historyDrawer, /entry\.freeSpaceAfterBytes/);
  assert.match(historyDrawer, /entry\.recoveredBytes/);
  assert.match(historyDrawer, /entry\.deletedTargetNames/);
  assert.match(historyDrawer, /role="tree"/);
  assert.match(historyDrawer, /Standard Scan/);
  assert.match(historyDrawer, /Deep Audit/);
  assert.doesNotMatch(
    historyDrawer,
    /normalizedPath|findingId|individualFiles|filesSuccessfullyUnlinked/,
  );
  assert.equal(formatCleanerSignedBytes(-(1024 ** 2)), "-1.00 MiB");
  assert.equal(formatCleanerSignedBytes(1024 ** 2), "+1.00 MiB");
});

test("Cleaner renderer Deep Audit progress and final accounting states remain distinct", () => {
  const tab = readCleanerRendererSource("components", "CleanerTab.tsx");
  const card = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerFindingCard.tsx",
  );
  const summary = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerSummary.tsx",
  );
  const completeLargeFinding: CleanerViewFinding = {
    ...findings[0],
    id: "complete-large",
    logicalBytes: 10_705_050_004,
    sizeBytes: 10_705_050_004,
    estimatedReclaimableBytes: 2_221_572_096,
    recoverableBytes: 2_221_572_096,
    measurementCompleteness: "complete",
    accountingConfidence: "estimated",
    accountingActionabilityBlocked: false,
  };

  assert.match(tab, /Deep Audit in progress/);
  assert.match(tab, /Read-only scan\. Nothing is changed\./);
  assert.match(tab, /progress\.currentTarget \?\? progress\.currentCategory/);
  assert.match(tab, /progress\.processedFiles/);
  assert.match(tab, /progress\.processedDirectories/);
  assert.match(tab, /progress\.completedTargets/);
  assert.match(tab, /progress\.totalTargets/);
  assert.match(tab, /formatElapsedDuration\(progress\.elapsedMs\)/);
  assert.match(tab, /aria-label="Stage progress"/);
  assert.match(tab, />\s*Cancel\s*</);
  assert.doesNotMatch(tab, /estimated time remaining|time remaining/i);
  assert.doesNotMatch(tab, /Calculating recoverable space/i);
  assert.doesNotMatch(tab, /Accounting still in progress/i);
  assert.doesNotMatch(tab, /Run another scan for the complete result/i);
  assert.match(summary, /completed with/);
  assert.match(summary, /View issues/);
  assert.match(card, /finding\.measurementFailureCategory/);
  assert.match(card, /finding\.measurementFailureExplanation/);
  assert.equal(canSelectCleanerFinding(completeLargeFinding), true);
});

test("Cleaner findings use a content-width grid with two columns at the default app size", () => {
  const tab = readCleanerRendererSource("components", "CleanerTab.tsx");
  const styles = readCleanerRendererSource("styles.css");

  assert.match(tab, /data-cleaner-grid="responsive"/);
  assert.match(tab, /cleaner-findings-shell/);
  assert.match(tab, /cleaner-findings-grid/);
  assert.doesNotMatch(tab, /xl:grid-cols-2/);
  assert.match(
    styles,
    /\.cleaner-findings-shell\s*\{[\s\S]*container-type: inline-size/,
  );
  assert.match(
    styles,
    /@container \(min-width: 760px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    styles,
    /@container \(min-width: 1180px\)[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/,
  );
});

test("Cleaner migration notice is singular, compact, and acknowledged in local storage", () => {
  const tab = readCleanerRendererSource("components", "CleanerTab.tsx");

  assert.match(tab, /CleanerStorageNotice/);
  assert.match(tab, /Cleaner storage updated/);
  assert.match(tab, /View details/);
  assert.match(tab, /dashboard:cleanerMigrationNoticeAcknowledged/);
  assert.match(tab, /localStorage\.getItem\(CLEANER_MIGRATION_ACK_KEY\)/);
  assert.match(tab, /localStorage\.setItem\(/);
  assert.doesNotMatch(tab, /migrationNotices\.map/);
  assert.doesNotMatch(tab, /Cleaner storage migration:/);
  assert.match(
    tab,
    /scanState\.status !== "scanning"[\s\S]*CleanerStorageNotice/,
  );
});

test("Cleaner scan issues use one compact summary and hide grouped details by default", () => {
  const summary = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerSummary.tsx",
  );

  assert.match(summary, /buildCleanerIssueSummary/);
  assert.match(summary, /useState\(false\)/);
  assert.match(summary, /View issues/);
  assert.match(summary, /open=\{issuesOpen\}/);
  assert.match(summary, /issues\.groups\.map/);
  assert.match(summary, /could not be included in recovery estimates/);
  assert.doesNotMatch(summary, /Physical recovery unknown:/);
  assert.doesNotMatch(summary, /scanWarnings\.join/);
});

test("Cleaner finding cards consolidate exclusion scopes into one keyboard menu", () => {
  const card = readCleanerRendererSource(
    "components",
    "cleaner",
    "CleanerFindingCard.tsx",
  );

  assert.match(card, /aria-haspopup="menu"/);
  assert.match(card, /role="menu"/);
  assert.match(card, /role="menuitem"/);
  assert.match(card, /event\.key === "ArrowDown"/);
  assert.match(card, /event\.key === "ArrowUp"/);
  assert.match(card, /event\.key === "Escape"/);
  assert.match(card, /data-exclusion-scope/);
  assert.match(card, /\{open &&/);
  assert.doesNotMatch(card, /mt-3 flex flex-wrap gap-2 text-xs/);
});

test("Cleaner search uses theme-aware readable icon, text, and placeholder styles", () => {
  const tab = readCleanerRendererSource("components", "CleanerTab.tsx");

  assert.match(tab, /placeholder="Search findings, tools, or paths"/);
  assert.match(tab, /text-gray-800\/80/);
  assert.match(tab, /text-gray-900/);
  assert.match(tab, /placeholder:text-gray-800\/75/);
  assert.match(tab, /focus:ring-2/);

  for (const palette of THEME_REGISTRY) {
    const { card, cardForeground, muted } = palette.semanticTokens;
    const fieldBackground = mixHexColors(muted, card, 0.8);
    const placeholder = mixHexColors(cardForeground, fieldBackground, 0.75);
    assert.ok(
      contrastRatio(placeholder, fieldBackground) >= 4.5,
      `${palette.name} search placeholder contrast was ${contrastRatio(placeholder, fieldBackground)}`,
    );
    assert.ok(
      contrastRatio(cardForeground, fieldBackground) >= 4.5,
      `${palette.name} search input contrast was ${contrastRatio(cardForeground, fieldBackground)}`,
    );
  }
});

test("Cleaner components use Radix dropdowns, animated accessible overlays, and no native selects", () => {
  const componentDirectory = path.join(
    process.cwd(),
    "src",
    "renderer",
    "components",
    "cleaner",
  );
  const componentSources = fs
    .readdirSync(componentDirectory)
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .map((name) => fs.readFileSync(path.join(componentDirectory, name), "utf8"))
    .join("\n");
  const tab = fs.readFileSync(
    path.join(process.cwd(), "src", "renderer", "components", "CleanerTab.tsx"),
    "utf8",
  );
  const sharedSelect = fs.readFileSync(
    path.join(
      process.cwd(),
      "src",
      "renderer",
      "components",
      "ui",
      "select.tsx",
    ),
    "utf8",
  );

  assert.doesNotMatch(tab, /<select(?:\s|>)/);
  assert.match(sharedSelect, /@radix-ui\/react-select/);
  assert.match(sharedSelect, /SelectPrimitive\.Portal/);
  assert.match(sharedSelect, /sideOffset = 6/);
  assert.match(componentSources, /sideOffset=\{8\}/);
  assert.match(componentSources, /aria-modal="true"/);
  assert.match(componentSources, /aria-expanded={open}/);
  assert.match(componentSources, /aria-controls={contentId}/);
  assert.match(componentSources, /event\.key === "Escape"/);
  assert.match(componentSources, /event\.key !== "Tab"/);
  assert.match(componentSources, /returnFocusRef/);
  assert.match(componentSources, /AnimatePresence/);
  assert.match(componentSources, /useReducedMotion/);
  assert.match(componentSources, /break-all/);
  assert.match(componentSources, /overflow-x-auto/);
  assert.match(componentSources, /aria-pressed={active}/);
});

test("Cleaner renderer preserves guarded IPC and never sends a raw deletion path", () => {
  const tab = fs.readFileSync(
    path.join(process.cwd(), "src", "renderer", "components", "CleanerTab.tsx"),
    "utf8",
  );
  const preload = fs.readFileSync(
    path.join(process.cwd(), "src", "preload", "index.ts"),
    "utf8",
  );
  assert.match(tab, /Cleaner Test Mode, using generated fixture data/);
  assert.match(tab, /focus-visible:ring/);
  const cleanerComponents = fs
    .readdirSync(
      path.join(process.cwd(), "src", "renderer", "components", "cleaner"),
    )
    .filter((name) => name.endsWith(".tsx"))
    .map((name) =>
      fs.readFileSync(
        path.join(
          process.cwd(),
          "src",
          "renderer",
          "components",
          "cleaner",
          name,
        ),
        "utf8",
      ),
    )
    .join("\n");
  assert.match(`${tab}\n${cleanerComponents}`, /Run Deep Audit/);
  assert.match(`${tab}\n${cleanerComponents}`, /Run Standard Scan/);
  assert.doesNotMatch(tab, /#[0-9a-f]{3,8}/i);
  assert.match(preload, /validateCleanCleanerFindingsInput/);
  assert.match(preload, /validatePrepareCleanerCleanupInput/);
  assert.match(tab, /prepareCleanerCleanup\(\{/);
  assert.doesNotMatch(preload, /cleanCleanerFindings:[\s\S]{0,250}path:/);
  assert.doesNotMatch(preload, /prepareCleanerCleanup:[\s\S]{0,250}path:/);
  assert.equal(
    fs
      .readFileSync(
        path.join(process.cwd(), "src", "renderer", "App.tsx"),
        "utf8",
      )
      .includes('localStorage.setItem("dashboard:activeTab", activeTab)'),
    true,
  );
});

function contrastRatio(foreground: string, background: string): number {
  const bright = relativeLuminance(foreground);
  const dark = relativeLuminance(background);
  return (Math.max(bright, dark) + 0.05) / (Math.min(bright, dark) + 0.05);
}

function mixHexColors(
  foreground: string,
  background: string,
  foregroundOpacity: number,
): string {
  const foregroundChannels = hexChannels(foreground);
  const backgroundChannels = hexChannels(background);
  return `#${foregroundChannels
    .map((value, index) =>
      Math.round(
        value * foregroundOpacity +
          backgroundChannels[index] * (1 - foregroundOpacity),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function hexChannels(hex: string): number[] {
  const normalized = hex.replace("#", "").slice(0, 6);
  return [0, 2, 4].map((offset) =>
    Number.parseInt(normalized.slice(offset, offset + 2), 16),
  );
}

function readCleanerRendererSource(...segments: string[]): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src", "renderer", ...segments),
    "utf8",
  );
}

function relativeLuminance(hex: string): number {
  const normalized = hex.replace("#", "").slice(0, 6);
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255,
  );
  const [red, green, blue] = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
