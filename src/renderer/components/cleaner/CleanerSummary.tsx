import { useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, HardDrive, Info, RefreshCw } from "lucide-react";
import {
  buildCleanerIssueSummary,
  calculateCleanerSummaryMetrics,
} from "../../cleaner-view-model";
import {
  CLEANER_STATUS_META,
  CLEANER_TONE_STYLES,
  type CleanerVisualStatus,
} from "../../cleaner-semantics";
import {
  formatCleanerBytes,
  formatCleanerDate,
  formatCleanerDuration,
} from "../../cleaner-format";
import { CleanerInfoDialog } from "./CleanerInfoDialog";
import { CleanerStatusIcon } from "./CleanerStatus";
import type { CleanerSafetyFilter, CleanerScanResult } from "./types";

type SummaryCardData = {
  status: CleanerVisualStatus;
  filter: CleanerSafetyFilter;
  value: number;
  count: number;
  sizeKind: "recovery" | "logical";
};

export function CleanerSummary({
  result,
  activeFilter,
  onFilterChange,
  onRefreshFreeSpace,
}: {
  result: CleanerScanResult;
  activeFilter: CleanerSafetyFilter;
  onFilterChange(filter: CleanerSafetyFilter): void;
  onRefreshFreeSpace(): Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const [refreshingFreeSpace, setRefreshingFreeSpace] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [accountingOpen, setAccountingOpen] = useState(false);
  const issuesButtonRef = useRef<HTMLButtonElement>(null);
  const accountingButtonRef = useRef<HTMLButtonElement>(null);
  const metrics = calculateCleanerSummaryMetrics(result.findings);
  const issues = buildCleanerIssueSummary(result);
  const scanLabel = result.mode === "deep" ? "Deep Audit" : "Standard Scan";
  const cards: SummaryCardData[] = [
    {
      status: "safe-now",
      filter: "safe-now",
      value: metrics.estimatedRecoverableNowBytes,
      count: metrics.safeNowCount,
      sizeKind: "recovery",
    },
    {
      status: "safe-after-close",
      filter: "safe-after-close",
      value: metrics.safeAfterCloseBytes,
      count: metrics.safeAfterCloseCount,
      sizeKind: "logical",
    },
    {
      status: "conditional",
      filter: "conditional",
      value: metrics.conditionalRecoverableBytes,
      count: metrics.conditionalCount,
      sizeKind: "recovery",
    },
    {
      status: "manual-review",
      filter: "manual-review",
      value: metrics.manualReviewBytes,
      count: metrics.manualReviewCount,
      sizeKind: "logical",
    },
    {
      status: "protected",
      filter: "protected",
      value: metrics.protectedBytes,
      count: metrics.protectedCount,
      sizeKind: "logical",
    },
    {
      status: "excluded",
      filter: "excluded",
      value: metrics.excludedBytes,
      count: metrics.excludedCount,
      sizeKind: "logical",
    },
  ];

  return (
    <section
      className="mb-3 rounded-2xl border border-gray-300 bg-gray-100/78 p-3"
      aria-labelledby="cleaner-results-title"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-700">
            {scanLabel}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2
              id="cleaner-results-title"
              className="text-lg font-semibold text-gray-900"
            >
              {result.findings.length} findings
            </h2>
            <span className="text-xs text-gray-700">
              Scanned in {formatCleanerDuration(result.summary.durationMs)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-700">
            <span
              title={`Measured ${formatCleanerDate(result.summary.freeDiskSpaceMeasuredAt)}`}
            >
              Free: {formatCleanerBytes(result.summary.freeDiskSpaceBytes)}
              {result.summary.freeSpaceIsStale ? " · may be stale" : ""}
            </span>
            <button
              type="button"
              disabled={refreshingFreeSpace}
              onClick={async () => {
                setRefreshingFreeSpace(true);
                try {
                  await onRefreshFreeSpace();
                } finally {
                  setRefreshingFreeSpace(false);
                }
              }}
              aria-label="Refresh free disk space"
              title="Refresh free disk space"
              className="grid h-7 w-7 place-items-center rounded-lg outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border disabled:opacity-60"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshingFreeSpace ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        <div className="min-w-[210px] text-right">
          <div className="flex items-center justify-end gap-1.5 text-xs font-semibold text-cleaner-recovery-text">
            Estimated recoverable
            <button
              ref={accountingButtonRef}
              type="button"
              onClick={() => setAccountingOpen(true)}
              aria-label="How recovery estimates work"
              className="grid h-7 w-7 place-items-center rounded-lg outline-none hover:bg-cleaner-recovery/10 focus-visible:ring-2 focus-visible:ring-cleaner-recovery-border"
            >
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <motion.div
            key={result.summary.estimatedRecoverableBytes}
            initial={reduceMotion ? false : { opacity: 0.5, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16 }}
            className="text-2xl font-semibold tracking-tight text-cleaner-recovery-text"
            aria-live="polite"
          >
            {formatCleanerBytes(result.summary.estimatedRecoverableBytes)}
          </motion.div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((card) => (
          <CleanerSummaryCard
            key={card.status}
            card={card}
            active={activeFilter === card.filter}
            onActivate={() =>
              onFilterChange(activeFilter === card.filter ? "all" : card.filter)
            }
          />
        ))}
      </div>

      {issues.count > 0 && (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-cleaner-review-border/75 bg-cleaner-review-surface/55 px-3 py-2 text-xs text-cleaner-review-text">
          <AlertTriangle
            className="h-4 w-4 shrink-0 text-cleaner-review-icon"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 leading-5">
            <strong>
              {scanLabel} completed with {issues.count} issue
              {issues.count === 1 ? "" : "s"}.
            </strong>
            {issues.unknownRecoverableFindingCount > 0 &&
              ` ${formatCleanerBytes(
                issues.unknownRecoverableLogicalBytes,
              )} could not be included in recovery estimates.`}
          </span>
          <button
            ref={issuesButtonRef}
            type="button"
            onClick={() => setIssuesOpen(true)}
            className="min-h-8 shrink-0 rounded-lg px-2.5 font-semibold outline-none hover:bg-cleaner-review/10 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
          >
            View issues
          </button>
        </div>
      )}

      <CleanerInfoDialog
        open={accountingOpen}
        title="How estimates work"
        description="Recovery and logical size are separate measurements."
        returnFocusRef={accountingButtonRef}
        onClose={() => setAccountingOpen(false)}
      >
        <div className="space-y-3 text-sm leading-5 text-gray-800">
          <div className="flex items-start gap-2.5 rounded-xl bg-cleaner-recovery-surface/58 p-3 text-cleaner-recovery-text">
            <HardDrive
              className="mt-0.5 h-4 w-4 shrink-0 text-cleaner-recovery"
              aria-hidden="true"
            />
            <p>
              The main total includes only complete, non-excluded Safe now
              findings with measurable physical recovery.
            </p>
          </div>
          <ul className="list-disc space-y-2 pl-5">
            {result.summary.sizeAccountingNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <dl className="grid gap-3 rounded-xl bg-gray-200/55 p-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-gray-700">Current free space</dt>
              <dd className="font-semibold text-gray-900">
                {formatCleanerBytes(result.summary.freeDiskSpaceBytes)}
              </dd>
              <dd className="text-xs text-gray-700">
                {formatCleanerDate(result.summary.freeDiskSpaceMeasuredAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-700">Scan-time free space</dt>
              <dd className="font-semibold text-gray-900">
                {formatCleanerBytes(result.summary.scanTimeFreeDiskSpaceBytes)}
              </dd>
              <dd className="text-xs text-gray-700">
                {formatCleanerDate(
                  result.summary.scanTimeFreeDiskSpaceMeasuredAt,
                )}
              </dd>
            </div>
          </dl>
        </div>
      </CleanerInfoDialog>

      <CleanerInfoDialog
        open={issuesOpen}
        title={`${issues.count} scan issue${issues.count === 1 ? "" : "s"}`}
        description="Affected findings stay visible, but uncertain recovery is excluded from cleanup totals."
        returnFocusRef={issuesButtonRef}
        onClose={() => setIssuesOpen(false)}
      >
        <div className="space-y-3">
          {issues.groups.map((group) => (
            <section
              key={group.key}
              className="rounded-xl border border-gray-300 bg-gray-200/45 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-semibold text-gray-900">{group.label}</h4>
                <span className="rounded-full bg-gray-300/70 px-2 py-0.5 text-xs font-semibold text-gray-800">
                  {group.items.length}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-gray-700">
                {group.description}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-5 text-gray-800">
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </CleanerInfoDialog>
    </section>
  );
}

function CleanerSummaryCard({
  card,
  active,
  onActivate,
}: {
  card: SummaryCardData;
  active: boolean;
  onActivate(): void;
}) {
  const meta = CLEANER_STATUS_META[card.status];
  const styles = CLEANER_TONE_STYLES[meta.tone];
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`Filter by ${meta.label}, ${card.count} findings, ${formatCleanerBytes(card.value)} ${card.sizeKind}`}
      title={`${card.sizeKind === "recovery" ? "Estimated recovery" : "Logical size"}: ${formatCleanerBytes(card.value)}`}
      onClick={onActivate}
      className={`min-w-0 rounded-xl border px-2.5 py-2 text-left outline-none transition-colors ${styles.surface} ${styles.border} ${active ? `ring-2 ${styles.selectedRing} ring-offset-1 ring-offset-night` : "hover:brightness-[1.04]"} focus-visible:ring-2 focus-visible:ring-cleaner-review-border`}
    >
      <span className={`flex min-w-0 items-center gap-1.5 ${styles.text}`}>
        <CleanerStatusIcon
          name={meta.icon}
          className={`h-3.5 w-3.5 shrink-0 ${styles.icon}`}
        />
        <span className="truncate text-xs font-semibold">
          {meta.shortLabel}
        </span>
        <span className="ml-auto text-xs font-semibold">{card.count}</span>
      </span>
      <span className="mt-1 block truncate text-[11px] font-medium text-gray-700">
        {formatCleanerBytes(card.value)}
      </span>
    </button>
  );
}
