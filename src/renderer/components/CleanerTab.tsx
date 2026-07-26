import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowDownWideNarrow,
  Check,
  Eraser,
  FolderSearch,
  Info,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  calculateCleanerSummaryMetrics,
  calculateSelectedRecoverableBytes,
  conditionalConfirmationRequired,
  filterCleanerFindings,
  getCleanerSelectionTone,
  resolveCleanerSummaryFilterTransition,
  selectAllSafeNow,
} from "../cleaner-view-model";
import {
  formatCleanerBytes,
  formatCleanerDate,
  formatCleanerSignedBytes,
  humanizeCleanerValue,
} from "../cleaner-format";
import { CleanerActionBar } from "./cleaner/CleanerActionBar";
import {
  CleanerConfirmationDialog,
  type CleanerConfirmationState,
} from "./cleaner/CleanerConfirmationDialog";
import { CleanerExclusionsDrawer } from "./cleaner/CleanerExclusionsDrawer";
import { CleanerFindingCard } from "./cleaner/CleanerFindingCard";
import { CleanerInfoDialog } from "./cleaner/CleanerInfoDialog";
import {
  CleanerSelect,
  type CleanerSelectOption,
} from "./cleaner/CleanerSelect";
import { CleanerSummary } from "./cleaner/CleanerSummary";
import type {
  CleanerCleanupReceipt,
  CleanerExclusion,
  CleanerFinding,
  CleanerLegacyCleanupEvent,
  CleanerPreferences,
  CleanerSafetyFilter,
  CleanerScanResult,
  CleanerScanState,
  CleanerSort,
} from "./cleaner/types";

type CleanerTabProps = {
  active: boolean;
  testMode: boolean;
  query: string;
  onQueryChange(value: string): void;
};

type ConfirmationSelection = {
  findingIds: string[];
  conditional: boolean;
} | null;

const CLEANER_MIGRATION_ACK_KEY =
  "dashboard:cleanerMigrationNoticeAcknowledged";

const SAFETY_OPTIONS: CleanerSelectOption[] = [
  {
    value: "all",
    label: "All safety states",
    description: "Show the full result set",
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
  },
  { value: "safe-now", label: "Safe now", status: "safe-now" },
  {
    value: "safe-after-close",
    label: "Safe after closing apps",
    status: "safe-after-close",
  },
  { value: "conditional", label: "Conditional", status: "conditional" },
  { value: "manual-review", label: "Manual review", status: "manual-review" },
  { value: "protected", label: "Protected", status: "protected" },
  { value: "excluded", label: "Excluded", status: "excluded" },
];

const SORT_OPTIONS: CleanerSelectOption[] = [
  {
    value: "recommended",
    label: "Recommended order",
    description: "Actionable first, then cleanup value and size",
    icon: <Sparkles className="h-3.5 w-3.5" />,
  },
  {
    value: "size",
    label: "Largest first",
    description: "Sort by current measured size",
    icon: <ArrowDownWideNarrow className="h-3.5 w-3.5" />,
  },
  {
    value: "safety",
    label: "Safety priority",
    description: "Group by safety, then sort by size",
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
  },
];

export default function CleanerTab({
  active,
  testMode,
  query,
  onQueryChange,
}: CleanerTabProps) {
  const [scanState, setScanState] = useState<CleanerScanState>({
    status: "idle",
    testMode,
  });
  const [result, setResult] = useState<CleanerScanResult | null>(null);
  const [preferences, setPreferences] = useState<CleanerPreferences>({
    defaultScanMode: "standard",
    showExcluded: false,
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [safetyFilter, setSafetyFilter] = useState<CleanerSafetyFilter>("all");
  const [sort, setSort] = useState<CleanerSort>("recommended");
  const [exclusions, setExclusions] = useState<CleanerExclusion[]>([]);
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationSelection>(null);
  const [confirmationText, setConfirmationText] = useState("");
  const [cleanupProgress, setCleanupProgress] = useState<{
    completedItems: number;
    totalItems: number;
    logicalBytesDeleted: number;
  } | null>(null);
  const [cleanupResult, setCleanupResult] =
    useState<CleanerCleanupReceipt | null>(null);
  const [cleanupReceipts, setCleanupReceipts] = useState<
    CleanerCleanupReceipt[]
  >([]);
  const [legacyCleanupEvents, setLegacyCleanupEvents] = useState<
    CleanerLegacyCleanupEvent[]
  >([]);
  const [message, setMessage] = useState<string | null>(null);
  const [migrationNotices, setMigrationNotices] = useState<string[]>([]);
  const [migrationNoticeAcknowledged, setMigrationNoticeAcknowledged] =
    useState(true);
  const exclusionsButtonRef = useRef<HTMLButtonElement>(null);

  const syncMigrationNotices = useCallback((notices: string[]) => {
    setMigrationNotices(notices);
    if (notices.length === 0) {
      setMigrationNoticeAcknowledged(true);
      return;
    }
    const signature = notices.join("\u001f");
    try {
      setMigrationNoticeAcknowledged(
        localStorage.getItem(CLEANER_MIGRATION_ACK_KEY) === signature,
      );
    } catch {
      setMigrationNoticeAcknowledged(false);
    }
  }, []);

  const acknowledgeMigrationNotice = useCallback(() => {
    try {
      localStorage.setItem(
        CLEANER_MIGRATION_ACK_KEY,
        migrationNotices.join("\u001f"),
      );
    } catch {
      // Acknowledgement remains effective for this session.
    }
    setMigrationNoticeAcknowledged(true);
  }, [migrationNotices]);

  useEffect(() => {
    if (!active) return;
    void Promise.all([
      window.api.getCleanerScanState(),
      window.api.getCleanerExclusions(),
      window.api.getCleanerPreferences(),
      window.api.getCleanerHistory(),
    ]).then(([nextState, nextExclusions, nextPreferences, history]) => {
      setScanState(nextState);
      setExclusions(nextExclusions);
      setPreferences(nextPreferences);
      syncMigrationNotices(history.migrationNotices);
      setCleanupReceipts(history.cleanupReceipts);
      setLegacyCleanupEvents(history.cleanupEvents);
      setCleanupResult(history.cleanupReceipts[0] ?? null);
      if (nextState.status === "complete") setResult(nextState.result);
    });

    const offProgress = window.api.onCleanerScanProgress((progress) => {
      setScanState({ status: "scanning", testMode, progress });
    });
    const offComplete = window.api.onCleanerScanComplete((nextResult) => {
      setResult(nextResult);
      setScanState({ status: "complete", testMode, result: nextResult });
      setSelectedIds(new Set());
      setMessage(null);
    });
    const offError = window.api.onCleanerScanError((error) => {
      setScanState({
        status: "error",
        testMode,
        scanSessionId: error.scanSessionId,
        message: error.message,
      });
      setMessage(error.message);
    });
    const offCleanupProgress = window.api.onCleanerCleanupProgress((progress) =>
      setCleanupProgress(progress),
    );
    const offCleanupComplete = window.api.onCleanerCleanupComplete(
      (nextResult) => {
        setCleanupResult(nextResult);
        setCleanupProgress(null);
        setSelectedIds(new Set());
        void window.api.getCleanerScanState().then((nextState) => {
          setScanState(nextState);
          setResult(nextState.status === "complete" ? nextState.result : null);
        });
      },
    );
    const offHistoryUpdate = window.api.onCleanerHistoryUpdate((history) => {
      syncMigrationNotices(history.migrationNotices);
      setCleanupReceipts(history.cleanupReceipts);
      setLegacyCleanupEvents(history.cleanupEvents);
      setCleanupResult(history.cleanupReceipts[0] ?? null);
    });
    return () => {
      offProgress();
      offComplete();
      offError();
      offCleanupProgress();
      offCleanupComplete();
      offHistoryUpdate();
    };
  }, [active, syncMigrationNotices, testMode]);

  const startScan = useCallback(
    async (mode: "standard" | "deep") => {
      setMessage(null);
      setResult(null);
      setSelectedIds(new Set());
      setSafetyFilter("all");
      const nextPreferences = { ...preferences, defaultScanMode: mode };
      setPreferences(nextPreferences);
      void window.api.updateCleanerPreferences(nextPreferences);
      try {
        setScanState(await window.api.startCleanerScan({ mode }));
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : "Cleaner scan could not start.",
        );
      }
    },
    [preferences],
  );

  useEffect(() => {
    if (!active) return;
    const rescan = () => {
      if (result && scanState.status !== "scanning") {
        void startScan(result.mode);
      }
    };
    window.addEventListener("dashboard:cleaner-rescan", rescan);
    return () => window.removeEventListener("dashboard:cleaner-rescan", rescan);
  }, [active, result, scanState.status, startScan]);

  const categories = useMemo(
    () =>
      [
        ...new Set((result?.findings ?? []).map((item) => item.category)),
      ].sort(),
    [result],
  );
  const categoryOptions = useMemo<CleanerSelectOption[]>(
    () => [
      {
        value: "all",
        label: "All categories",
        icon: <FolderSearch className="h-3.5 w-3.5" />,
      },
      ...categories.map((category) => ({
        value: category,
        label: category,
        icon: <FolderSearch className="h-3.5 w-3.5" />,
      })),
    ],
    [categories],
  );
  const visibleFindings = useMemo(
    () =>
      filterCleanerFindings(result?.findings ?? [], {
        query,
        category: categoryFilter,
        safety: safetyFilter,
        showExcluded: preferences.showExcluded,
        sort,
      }),
    [
      result,
      query,
      categoryFilter,
      safetyFilter,
      preferences.showExcluded,
      sort,
    ],
  );
  const selectedFindings = useMemo(
    () =>
      (result?.findings ?? []).filter((finding) => selectedIds.has(finding.id)),
    [result, selectedIds],
  );
  const selectedBytes = useMemo(
    () =>
      calculateSelectedRecoverableBytes(result?.findings ?? [], selectedIds),
    [result, selectedIds],
  );
  const selectionTone = useMemo(
    () => getCleanerSelectionTone(result?.findings ?? [], selectedIds),
    [result, selectedIds],
  );
  const summaryMetrics = useMemo(
    () => calculateCleanerSummaryMetrics(result?.findings ?? []),
    [result],
  );
  const confirmationState = useMemo<CleanerConfirmationState>(() => {
    if (!confirmation || !result) return null;
    return {
      findings: result.findings.filter((finding) =>
        confirmation.findingIds.includes(finding.id),
      ),
      conditional: confirmation.conditional,
    };
  }, [confirmation, result]);

  const persistShowExcluded = useCallback(
    (showExcluded: boolean) => {
      const next = { ...preferences, showExcluded };
      setPreferences(next);
      void window.api.updateCleanerPreferences(next);
    },
    [preferences],
  );

  const toggleShowExcluded = useCallback(
    (showExcluded: boolean) => {
      persistShowExcluded(showExcluded);
      if (!showExcluded && safetyFilter === "excluded") setSafetyFilter("all");
    },
    [persistShowExcluded, safetyFilter],
  );

  const handleSummaryFilter = (filter: CleanerSafetyFilter) => {
    const next = resolveCleanerSummaryFilterTransition(
      filter,
      preferences.showExcluded,
    );
    setSafetyFilter(next.safety);
    if (next.showExcluded !== preferences.showExcluded) {
      persistShowExcluded(next.showExcluded);
    }
  };

  const refreshFreeSpace = async () => {
    if (!result) return;
    try {
      const nextResult = await window.api.refreshCleanerFreeSpace(
        result.scanSessionId,
      );
      setResult(nextResult);
      setScanState({ status: "complete", testMode, result: nextResult });
      setMessage(null);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Free disk space could not be refreshed.",
      );
    }
  };

  const openSafeConfirmation = () => {
    if (!result) return;
    const findingIds = selectAllSafeNow(result.findings);
    setSelectedIds(new Set(findingIds));
    if (findingIds.length === 0) {
      setMessage("No currently safe, non-excluded findings are available.");
      return;
    }
    setConfirmation({ findingIds, conditional: false });
  };

  const openSelectedConfirmation = () => {
    if (!result || selectedIds.size === 0) return;
    setConfirmation({
      findingIds: [...selectedIds],
      conditional: conditionalConfirmationRequired(
        result.findings,
        selectedIds,
      ),
    });
  };

  const closeConfirmation = useCallback(() => {
    setConfirmation(null);
    setConfirmationText("");
  }, []);

  const closeExclusions = useCallback(() => setExclusionsOpen(false), []);

  const runCleanup = async () => {
    if (!result || !confirmation) return;
    try {
      setCleanupProgress({
        completedItems: 0,
        totalItems: confirmation.findingIds.length,
        logicalBytesDeleted: 0,
      });
      const cleanupSelection = confirmation;
      closeConfirmation();
      await window.api.cleanCleanerFindings({
        scanSessionId: result.scanSessionId,
        findingIds: cleanupSelection.findingIds,
        confirmation: cleanupSelection.conditional ? "conditional" : "safe",
      });
    } catch (error) {
      setCleanupProgress(null);
      setMessage(error instanceof Error ? error.message : "Cleanup failed.");
    }
  };

  const excludeFinding = async (
    finding: CleanerFinding,
    scope:
      "finding" | "detector" | "category" | "application" | "root" | "path",
  ) => {
    const values = {
      finding: finding.id,
      detector: finding.detectorId,
      category: finding.category,
      application: finding.applicationId ?? finding.detectorId,
      root: finding.dataRootId,
      path: finding.normalizedPath,
    };
    const labels = {
      finding: finding.displayName,
      detector: `${finding.detectorId} detector`,
      category: `${finding.category} category`,
      application: finding.applicationName ?? finding.detectorId,
      root: `${finding.displayName} data root`,
      path: finding.path,
    };
    setExclusions(
      await window.api.updateCleanerExclusions({
        action: "add",
        exclusion: { scope, value: values[scope], label: labels[scope] },
      }),
    );
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(finding.id);
      return next;
    });
  };

  if (!active) return null;

  return (
    <section
      className="cleaner-motion-root min-w-0 pb-8"
      aria-label="Windows Cleaner"
    >
      {testMode && <CleanerTestModeBanner />}
      {message && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-cleaner-danger-border bg-cleaner-danger-surface px-4 py-3 text-cleaner-danger-text">
          <span>{message}</span>
          <button
            type="button"
            aria-label="Dismiss Cleaner message"
            onClick={() => setMessage(null)}
            className="rounded-full p-1 outline-none hover:bg-cleaner-danger/10 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {scanState.status === "scanning" && (
        <ScanningState
          progress={scanState.progress}
          onCancel={async () => {
            setScanState(
              await window.api.cancelCleanerScan(
                scanState.progress.scanSessionId,
              ),
            );
          }}
        />
      )}

      {scanState.status !== "scanning" &&
        migrationNotices.length > 0 &&
        !migrationNoticeAcknowledged && (
          <CleanerStorageNotice
            details={migrationNotices}
            onAcknowledge={acknowledgeMigrationNotice}
          />
        )}

      {scanState.status !== "scanning" && !result && !cleanupResult && (
        <EmptyState
          selectedMode={preferences.defaultScanMode}
          onSelectMode={(mode) => {
            const next = { ...preferences, defaultScanMode: mode };
            setPreferences(next);
            void window.api.updateCleanerPreferences(next);
          }}
          onScan={() => startScan(preferences.defaultScanMode)}
        />
      )}

      {cleanupResult && (
        <CleanupResultPanel
          result={cleanupResult}
          onRescan={() => startScan(preferences.defaultScanMode)}
          onDismiss={() => setCleanupResult(null)}
        />
      )}

      {cleanupReceipts.length > 1 && (
        <CleanupReceiptHistory receipts={cleanupReceipts.slice(1)} />
      )}

      {legacyCleanupEvents.length > 0 && (
        <LegacyCleanupHistory events={legacyCleanupEvents} />
      )}

      {result && scanState.status !== "scanning" && (
        <>
          <CleanerSummary
            result={result}
            activeFilter={safetyFilter}
            onFilterChange={handleSummaryFilter}
            onRefreshFreeSpace={refreshFreeSpace}
          />

          <section
            className="mb-3 rounded-2xl border border-gray-300 bg-gray-100/78 p-3"
            aria-label="Cleaner filters and actions"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <label className="relative min-w-[220px] flex-1 lg:max-w-[360px]">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-800/80"
                  aria-hidden="true"
                />
                <span className="sr-only">Search Cleaner findings</span>
                <input
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder="Search findings, tools, or paths"
                  className="h-9 w-full rounded-xl border border-gray-400/80 bg-gray-200/80 pl-9 pr-3 text-sm text-gray-900 caret-cleaner-review outline-none transition placeholder:text-gray-800/75 hover:border-gray-400 focus:border-cleaner-review-border focus:ring-2 focus:ring-cleaner-review-border/35"
                />
              </label>
              <CleanerSelect
                label="Category"
                value={categoryFilter}
                onChange={setCategoryFilter}
                options={categoryOptions}
                className="w-[170px]"
              />
              <CleanerSelect
                label="Safety"
                value={safetyFilter}
                onChange={(value) =>
                  handleSummaryFilter(value as CleanerSafetyFilter)
                }
                options={SAFETY_OPTIONS}
                className="w-[180px]"
              />
              <CleanerSelect
                label="Sort"
                value={sort}
                onChange={(value) => setSort(value as CleanerSort)}
                options={SORT_OPTIONS}
                className="w-[180px]"
              />
              <label className="flex h-9 items-center gap-2 rounded-xl border border-cleaner-excluded-border bg-cleaner-excluded-surface/65 px-3 text-sm text-cleaner-excluded-text">
                <input
                  type="checkbox"
                  checked={preferences.showExcluded}
                  onChange={(event) => toggleShowExcluded(event.target.checked)}
                  className="h-4 w-4 accent-cleaner-excluded"
                />
                Show excluded
              </label>
            </div>

            <CleanerActionBar
              ref={exclusionsButtonRef}
              mode={result.mode}
              selectedCount={selectedFindings.length}
              selectedBytes={selectedBytes}
              selectionTone={selectionTone}
              safeRecoverableBytes={result.summary.estimatedRecoverableBytes}
              exclusionCount={exclusions.length}
              onSelectSafe={() =>
                setSelectedIds(new Set(selectAllSafeNow(result.findings)))
              }
              onClearSelection={() => setSelectedIds(new Set())}
              onRescan={() => startScan(result.mode)}
              onAlternateScan={() =>
                startScan(result.mode === "standard" ? "deep" : "standard")
              }
              onOpenExclusions={() => setExclusionsOpen(true)}
              onCleanSafe={openSafeConfirmation}
              onCleanSelected={openSelectedConfirmation}
            />
          </section>

          {visibleFindings.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-400 bg-gray-100/70 p-10 text-center text-gray-700">
              No findings match the current filters.
            </div>
          ) : (
            <div className="cleaner-findings-shell min-w-0">
              <motion.div
                layout
                data-cleaner-grid="responsive"
                className="cleaner-findings-grid min-w-0"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {visibleFindings.map((finding) => (
                    <CleanerFindingCard
                      key={finding.id}
                      finding={finding}
                      selected={selectedIds.has(finding.id)}
                      onSelect={(selected) =>
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (selected) next.add(finding.id);
                          else next.delete(finding.id);
                          return next;
                        })
                      }
                      onExclude={(scope) => excludeFinding(finding, scope)}
                      onManageExclusions={() => setExclusionsOpen(true)}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            </div>
          )}

          <CleanerExclusionsDrawer
            open={exclusionsOpen}
            exclusions={exclusions}
            excludedSize={summaryMetrics.excludedBytes}
            returnFocusRef={exclusionsButtonRef}
            onClose={closeExclusions}
            onRemove={async (exclusionId) =>
              setExclusions(
                await window.api.updateCleanerExclusions({
                  action: "remove",
                  exclusionId,
                }),
              )
            }
          />
        </>
      )}

      <CleanerConfirmationDialog
        state={confirmationState}
        confirmationText={confirmationText}
        onConfirmationTextChange={setConfirmationText}
        onCancel={closeConfirmation}
        onConfirm={runCleanup}
      />

      {cleanupProgress && <CleanupProgressOverlay progress={cleanupProgress} />}
    </section>
  );
}

function CleanerTestModeBanner() {
  return (
    <div className="mb-4 flex items-center gap-3 rounded-2xl border border-cleaner-safe-border bg-cleaner-safe-surface px-4 py-3 text-cleaner-safe-text shadow-soft">
      <ShieldCheck
        className="h-5 w-5 shrink-0 text-cleaner-safe-icon"
        aria-hidden="true"
      />
      <div>
        <div className="font-semibold">
          Cleaner Test Mode, using generated fixture data
        </div>
        <p className="mt-0.5 text-xs opacity-85">
          Profile, registry, process, drive, scan, and cleanup inputs are
          isolated from this PC.
        </p>
      </div>
    </div>
  );
}

function CleanerStorageNotice({
  details,
  onAcknowledge,
}: {
  details: string[];
  onAcknowledge(): void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div
        className="mb-3 flex min-w-0 items-center gap-2 rounded-xl border border-gray-300 bg-gray-100/72 px-3 py-2 text-sm text-gray-800"
        role="status"
      >
        <Check
          className="h-4 w-4 shrink-0 text-cleaner-safe-icon"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 font-medium">
          Cleaner storage updated
        </span>
        <button
          ref={detailsButtonRef}
          type="button"
          onClick={() => setDetailsOpen(true)}
          className="min-h-8 shrink-0 rounded-lg px-2 text-xs font-semibold outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
        >
          View details
        </button>
        <button
          type="button"
          onClick={onAcknowledge}
          aria-label="Dismiss Cleaner storage update"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <CleanerInfoDialog
        open={detailsOpen}
        title="Cleaner storage updated"
        description="Technical migration details are kept here for audit."
        returnFocusRef={detailsButtonRef}
        onClose={() => setDetailsOpen(false)}
        footer={
          <button
            type="button"
            onClick={() => {
              setDetailsOpen(false);
              onAcknowledge();
            }}
            className="min-h-9 rounded-xl bg-cleaner-safe px-4 text-sm font-semibold text-cleaner-safe-contrast outline-none hover:bg-cleaner-safe/90 focus-visible:ring-2 focus-visible:ring-cleaner-safe-border"
          >
            Got it
          </button>
        }
      >
        <ul className="list-disc space-y-2 pl-5 text-sm leading-5 text-gray-800">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </CleanerInfoDialog>
    </>
  );
}

function EmptyState({
  selectedMode,
  onSelectMode,
  onScan,
}: {
  selectedMode: "standard" | "deep";
  onSelectMode(mode: "standard" | "deep"): void;
  onScan(): void;
}) {
  return (
    <div className="mx-auto max-w-5xl py-6">
      <div className="app-card relative overflow-hidden border border-gray-300 bg-gray-100/90 p-7 shadow-soft">
        <div className="pointer-events-none absolute -right-12 -top-16 h-52 w-52 rounded-full bg-cleaner-safe/10 blur-3xl" />
        <div className="relative max-w-2xl">
          <div className="mb-4 inline-flex rounded-2xl border border-cleaner-safe-border bg-cleaner-safe-surface p-3 text-cleaner-safe-icon">
            <ScanSearch className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-gray-900">
            Conservative Windows cleanup, only when you ask
          </h2>
          <p className="mt-3 leading-6 text-gray-700">
            Cleaner checks exact, recognized locations and explains every
            result. It never schedules background scans, guesses from file size,
            stops processes, or treats unknown data as safe.
          </p>
        </div>
        <div className="relative mt-7 grid gap-3 md:grid-cols-2">
          <ModeCard
            mode="standard"
            selected={selectedMode === "standard"}
            title="Standard Scan"
            description="Quickly checks known caches, updater payloads, temporary stores, and protected application data without crawling the system drive."
            icon={<ScanSearch className="h-5 w-5" />}
            onSelect={onSelectMode}
          />
          <ModeCard
            mode="deep"
            selected={selectedMode === "deep"}
            title="Deep Audit"
            description="Exhaustively measures every recognized target, including large hardlink-heavy caches. It may take several minutes or longer."
            icon={<FolderSearch className="h-5 w-5" />}
            onSelect={onSelectMode}
          />
        </div>
        <div className="relative mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-gray-300 pt-5">
          <div className="flex items-center gap-2 text-xs text-gray-700">
            <Info className="h-4 w-4" aria-hidden="true" /> Scanning is
            read-only. Scan findings stay in this session. Cleanup receipts
            persist for audit.
          </div>
          <button
            type="button"
            onClick={onScan}
            className="rounded-xl bg-cleaner-safe px-5 py-2.5 font-semibold text-cleaner-safe-contrast shadow-soft outline-none transition hover:bg-cleaner-safe/90 focus-visible:ring-2 focus-visible:ring-cleaner-safe-border focus-visible:ring-offset-2 focus-visible:ring-offset-night"
          >
            Full Scan
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({
  mode,
  selected,
  title,
  description,
  icon,
  onSelect,
}: {
  mode: "standard" | "deep";
  selected: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onSelect(mode: "standard" | "deep"): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(mode)}
      className={`min-w-0 rounded-2xl border p-4 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-cleaner-safe-border ${selected ? "border-cleaner-safe-border bg-cleaner-safe-surface text-cleaner-safe-text" : "border-gray-300 bg-gray-200/55 text-gray-900 hover:bg-gray-200"}`}
    >
      <span className="flex items-center gap-2 font-semibold">
        {icon}
        {title}
        {selected && (
          <Check
            className="ml-auto h-4 w-4 text-cleaner-safe-icon"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="mt-2 block text-sm leading-5 text-gray-700">
        {description}
      </span>
    </button>
  );
}

function ScanningState({
  progress,
  onCancel,
}: {
  progress: Extract<CleanerScanState, { status: "scanning" }>["progress"];
  onCancel(): void;
}) {
  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="app-card border border-gray-300 bg-gray-100/90 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cleaner-safe-surface text-cleaner-safe-icon">
              <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">
                {progress.mode === "deep"
                  ? "Deep Audit in progress"
                  : "Standard Scan in progress"}
              </h2>
              <p className="mt-1 text-xs text-gray-700">
                Read-only scan. Nothing is changed.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-9 rounded-xl border border-cleaner-danger-border bg-cleaner-danger-surface px-3 text-sm font-medium text-cleaner-danger-text outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
          >
            Cancel
          </button>
        </div>
        <div
          className="mt-5 h-2 overflow-hidden rounded-full bg-gray-200"
          aria-label="Stage progress"
        >
          <div
            className="h-full rounded-full bg-cleaner-safe transition-all"
            style={{ width: `${Math.max(4, progress.percent)}%` }}
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Metric label="Stage" value={humanizeCleanerValue(progress.stage)} />
          <Metric
            label="Target"
            value={progress.currentTarget ?? progress.currentCategory}
          />
          <Metric
            label="Targets"
            value={
              progress.totalTargets > 0
                ? `${progress.completedTargets} of ${progress.totalTargets}`
                : "Discovering"
            }
          />
          <Metric
            label="Elapsed"
            value={formatElapsedDuration(progress.elapsedMs)}
          />
          <Metric
            label="Files"
            value={progress.processedFiles.toLocaleString()}
          />
          <Metric
            label="Directories"
            value={progress.processedDirectories.toLocaleString()}
          />
        </div>
      </div>
    </div>
  );
}

function CleanupProgressOverlay({
  progress,
}: {
  progress: {
    completedItems: number;
    totalItems: number;
    logicalBytesDeleted: number;
  };
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center bg-night/72 p-4 backdrop-blur-sm"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      role="status"
      aria-live="polite"
    >
      <div className="app-dialog w-full max-w-md border border-cleaner-safe-border bg-gray-100 p-6 text-gray-900 shadow-2xl">
        <RefreshCw
          className="mb-4 h-7 w-7 animate-spin text-cleaner-safe-icon"
          aria-hidden="true"
        />
        <h3 className="text-lg font-semibold">Cleaning validated paths</h3>
        <p className="mt-2 text-sm text-gray-700">
          {progress.completedItems} of {progress.totalItems} complete.{" "}
          {formatCleanerBytes(progress.logicalBytesDeleted)} removed logically.
        </p>
      </div>
    </motion.div>
  );
}

function CleanupResultPanel({
  result,
  onRescan,
  onDismiss,
}: {
  result: CleanerCleanupReceipt;
  onRescan(): void;
  onDismiss(): void;
}) {
  const counts = countReceiptStatuses(result);
  const tone = receiptTone(result.status);
  return (
    <div className="mx-auto max-w-4xl py-6">
      <div
        className={`app-card border bg-gray-100/90 p-6 shadow-soft ${tone.border}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div
              className={`mb-3 inline-flex rounded-2xl p-3 ${tone.surface} ${tone.text}`}
            >
              <Eraser className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="text-xl font-semibold">
              Cleanup receipt, {humanizeCleanerValue(result.status)}
            </h2>
            <p className="mt-2 text-sm text-gray-700">
              {result.selectedFindingIds.length} requested, {counts.deleted}{" "}
              deleted, {counts.partial} partial, {counts.skipped} skipped,{" "}
              {counts.failed} failed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRescan}
              className="rounded-xl bg-cleaner-safe px-4 py-2 font-semibold text-cleaner-safe-contrast outline-none hover:bg-cleaner-safe/90 focus-visible:ring-2 focus-visible:ring-cleaner-safe-border"
            >
              Run a fresh scan
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss cleanup receipt"
              title="Dismiss"
              className="grid h-9 w-9 place-items-center rounded-xl border border-gray-300 bg-gray-200 text-gray-800 outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Logical bytes removed"
            value={formatCleanerBytes(result.aggregateLogicalBytesRemoved)}
          />
          <Metric
            label="Estimated physical addressed"
            value={
              result.aggregateEstimatedPhysicalBytesReclaimable === null
                ? "Unknown"
                : formatCleanerBytes(
                    result.aggregateEstimatedPhysicalBytesReclaimable,
                  )
            }
          />
          <Metric
            label="Observed drive change"
            value={
              result.signedFreeSpaceDeltaBytes === undefined
                ? "Unavailable"
                : formatCleanerSignedBytes(result.signedFreeSpaceDeltaBytes)
            }
          />
          <Metric
            label="Verification"
            value={
              result.postCleanupVerificationCompleted
                ? "Completed"
                : "Incomplete"
            }
          />
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Metric
            label="Free space before"
            value={
              result.freeSpaceBefore
                ? `${formatCleanerBytes(result.freeSpaceBefore.freeBytes)} at ${formatCleanerDate(result.freeSpaceBefore.measuredAt)}`
                : "Unavailable"
            }
          />
          <Metric
            label="Free space after verification"
            value={
              result.freeSpaceAfter
                ? `${formatCleanerBytes(result.freeSpaceAfter.freeBytes)} at ${formatCleanerDate(result.freeSpaceAfter.measuredAt)}`
                : "Unavailable"
            }
          />
        </div>
        <p className="mt-4 rounded-xl border border-gray-300 bg-gray-200/55 p-3 text-xs leading-5 text-gray-700">
          The drive change is global and signed. Unrelated writes can change it,
          so it is not assigned to individual findings. Logical removal and
          estimated physical recovery are separate measurements.
        </p>
        {result.interruptionReason && (
          <p className="mt-3 rounded-xl border border-cleaner-danger-border bg-cleaner-danger-surface p-3 text-xs text-cleaner-danger-text">
            {result.interruptionReason}
          </p>
        )}
        <details className="mt-3 rounded-xl border border-gray-300 bg-gray-200/45 p-3 text-xs text-gray-700">
          <summary className="cursor-pointer font-medium text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-cleaner-review-border">
            Receipt identity and timing
          </summary>
          <div className="mt-2 grid gap-1 leading-5 sm:grid-cols-2">
            <div className="break-all">
              Cleanup request: {result.cleanupRequestId}
            </div>
            <div className="break-all">
              Scan session: {result.scanSessionId}
            </div>
            <div>Created: {formatCleanerDate(result.createdAt)}</div>
            <div>
              Started:{" "}
              {result.startedAt
                ? formatCleanerDate(result.startedAt)
                : "Not started"}
            </div>
            <div>
              Completed:{" "}
              {result.completedAt
                ? formatCleanerDate(result.completedAt)
                : "Not completed"}
            </div>
            <div>
              Confirmation: {humanizeCleanerValue(result.requestedConfirmation)}
            </div>
            <div>Selected findings: {result.selectedFindingIds.length}</div>
            <div>Resolved findings: {result.resolvedFindingIds.length}</div>
          </div>
        </details>
        <div className="mt-4 space-y-2">
          {result.findings.map((item) => {
            const itemTone = receiptFindingTone(item.attemptStatus);
            return (
              <div
                key={item.findingId}
                className={`rounded-xl border p-3 ${itemTone.border} ${itemTone.surface}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{item.displayName}</div>
                    <div className={`mt-1 text-xs ${itemTone.text}`}>
                      {humanizeCleanerValue(item.attemptStatus)}
                    </div>
                    <div className="mt-1 text-xs text-gray-700">
                      {item.message}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-medium">
                      {formatCleanerBytes(item.logicalBytesRemoved)} logical
                      removed
                    </div>
                    <div className="text-xs text-gray-700">
                      {item.postCleanupLogicalBytes === null
                        ? "Remaining size unknown"
                        : `${formatCleanerBytes(item.postCleanupLogicalBytes)} remains`}
                    </div>
                  </div>
                </div>
                <details className="mt-3 border-t border-gray-300 pt-2 text-xs text-gray-700">
                  <summary className="cursor-pointer font-medium text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-cleaner-review-border">
                    Technical receipt details
                  </summary>
                  <div className="mt-2 grid gap-1 leading-5 sm:grid-cols-2">
                    <div>
                      Expected physical recovery:{" "}
                      {item.preCleanupEstimatedReclaimableBytes === null
                        ? "Unknown"
                        : formatCleanerBytes(
                            item.preCleanupEstimatedReclaimableBytes,
                          )}
                    </div>
                    <div>
                      Files removed: {item.filesSuccessfullyUnlinked} of{" "}
                      {item.filesAttempted} attempted
                    </div>
                    <div>
                      Directories removed: {item.directoriesSuccessfullyRemoved}{" "}
                      of {item.directoriesAttempted} attempted
                    </div>
                    <div>
                      Link objects removed:{" "}
                      {item.reparseObjectsSuccessfullyRemoved}
                    </div>
                    <div>Skipped entries: {item.skippedEntryCount}</div>
                    <div>Failed entries: {item.failedEntryCount}</div>
                    <div>
                      Root after cleanup:{" "}
                      {item.postCleanupRootExists === null
                        ? "Unknown"
                        : item.postCleanupRootExists
                          ? "Still exists"
                          : "Absent"}
                    </div>
                    <div>
                      Verification time:{" "}
                      {item.postCleanupVerificationAt
                        ? formatCleanerDate(item.postCleanupVerificationAt)
                        : "Not completed"}
                    </div>
                    <div className="sm:col-span-2">
                      Failure categories:{" "}
                      {item.failureCategories.length > 0
                        ? item.failureCategories
                            .map(humanizeCleanerValue)
                            .join(", ")
                        : "None"}
                    </div>
                    <div className="break-all sm:col-span-2">
                      Recognized target: {item.normalizedPath}
                    </div>
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CleanupReceiptHistory({
  receipts,
}: {
  receipts: CleanerCleanupReceipt[];
}) {
  return (
    <section className="mx-auto mb-6 max-w-4xl rounded-2xl border border-gray-300 bg-gray-100/72 p-4">
      <h2 className="font-semibold text-gray-900">Earlier cleanup receipts</h2>
      <div className="mt-3 space-y-2">
        {receipts.map((receipt) => {
          const counts = countReceiptStatuses(receipt);
          return (
            <details
              key={receipt.cleanupRequestId}
              className="rounded-xl border border-gray-300 bg-gray-200/45 p-3 text-sm"
            >
              <summary className="cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-cleaner-review-border">
                {formatCleanerDate(receipt.createdAt)},{" "}
                {humanizeCleanerValue(receipt.status)},{" "}
                {receipt.selectedFindingIds.length} requested
              </summary>
              <div className="mt-2 space-y-1 text-xs leading-5 text-gray-700">
                <div>
                  {counts.deleted} deleted, {counts.partial} partial,{" "}
                  {counts.skipped} skipped, {counts.failed} failed
                </div>
                <div>
                  Logical removed:{" "}
                  {formatCleanerBytes(receipt.aggregateLogicalBytesRemoved)}
                </div>
                <div>
                  Observed drive change:{" "}
                  {receipt.signedFreeSpaceDeltaBytes === undefined
                    ? "Unavailable"
                    : formatCleanerSignedBytes(
                        receipt.signedFreeSpaceDeltaBytes,
                      )}
                </div>
                <div>
                  Verification:{" "}
                  {receipt.postCleanupVerificationCompleted
                    ? "Completed"
                    : "Incomplete"}
                </div>
                <div>
                  Free space before:{" "}
                  {receipt.freeSpaceBefore
                    ? `${formatCleanerBytes(receipt.freeSpaceBefore.freeBytes)} at ${formatCleanerDate(receipt.freeSpaceBefore.measuredAt)}`
                    : "Unavailable"}
                </div>
                <div>
                  Free space after:{" "}
                  {receipt.freeSpaceAfter
                    ? `${formatCleanerBytes(receipt.freeSpaceAfter.freeBytes)} at ${formatCleanerDate(receipt.freeSpaceAfter.measuredAt)}`
                    : "Unavailable"}
                </div>
                {receipt.interruptionReason && (
                  <div className="text-cleaner-danger-text">
                    {receipt.interruptionReason}
                  </div>
                )}
                <ul className="mt-2 list-disc pl-4">
                  {receipt.findings.map((finding) => (
                    <li key={finding.findingId}>
                      {finding.displayName}:{" "}
                      {humanizeCleanerValue(finding.attemptStatus)},{" "}
                      {formatCleanerBytes(finding.logicalBytesRemoved)} logical
                      removed,{" "}
                      {finding.postCleanupLogicalBytes === null
                        ? "remaining unknown"
                        : `${formatCleanerBytes(finding.postCleanupLogicalBytes)} remaining`}
                      , {finding.filesSuccessfullyUnlinked} files removed,{" "}
                      {finding.skippedEntryCount} skipped,{" "}
                      {finding.failedEntryCount} failed
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function LegacyCleanupHistory({
  events,
}: {
  events: CleanerLegacyCleanupEvent[];
}) {
  return (
    <details className="mx-auto mb-6 max-w-4xl rounded-2xl border border-cleaner-review-border bg-cleaner-review-surface/45 p-4 text-sm">
      <summary className="cursor-pointer font-semibold text-cleaner-review-text outline-none focus-visible:ring-2 focus-visible:ring-cleaner-review-border">
        Legacy cleanup history, {events.length} records
      </summary>
      <p className="mt-2 text-xs leading-5 text-gray-700">
        These records predate cleanup receipts. They preserve aggregate logical
        values, but they cannot prove individual file removal or observed drive
        recovery.
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-gray-700">
        {events.map((event) => (
          <li key={event.id}>
            {formatCleanerDate(event.cleanedAt)}, {event.applicationName},{" "}
            {humanizeCleanerValue(event.result)},{" "}
            {formatCleanerBytes(event.logicalBytesDeleted)} logical removed,{" "}
            {formatCleanerBytes(event.remainingBytes)} recorded remaining
          </li>
        ))}
      </ul>
    </details>
  );
}

function countReceiptStatuses(receipt: CleanerCleanupReceipt) {
  return {
    deleted: receipt.findings.filter(
      (finding) => finding.attemptStatus === "deleted",
    ).length,
    partial: receipt.findings.filter(
      (finding) => finding.attemptStatus === "partial",
    ).length,
    skipped: receipt.findings.filter(
      (finding) =>
        finding.attemptStatus === "skipped" ||
        finding.attemptStatus === "not-attempted",
    ).length,
    failed: receipt.findings.filter(
      (finding) => finding.attemptStatus === "failed",
    ).length,
  };
}

function receiptTone(status: CleanerCleanupReceipt["status"]) {
  if (status === "completed") {
    return {
      border: "border-cleaner-safe-border",
      surface: "bg-cleaner-safe-surface",
      text: "text-cleaner-safe-icon",
    };
  }
  if (status === "partial" || status === "in-progress") {
    return {
      border: "border-cleaner-conditional-border",
      surface: "bg-cleaner-conditional-surface",
      text: "text-cleaner-conditional-icon",
    };
  }
  return {
    border: "border-cleaner-danger-border",
    surface: "bg-cleaner-danger-surface",
    text: "text-cleaner-danger-icon",
  };
}

function receiptFindingTone(
  status: CleanerCleanupReceipt["findings"][number]["attemptStatus"],
) {
  if (status === "deleted") {
    return {
      border: "border-cleaner-safe-border",
      surface: "bg-cleaner-safe-surface/48",
      text: "text-cleaner-safe-text",
    };
  }
  if (status === "partial") {
    return {
      border: "border-cleaner-conditional-border",
      surface: "bg-cleaner-conditional-surface/55",
      text: "text-cleaner-conditional-text",
    };
  }
  if (status === "skipped" || status === "not-attempted") {
    return {
      border: "border-cleaner-review-border",
      surface: "bg-cleaner-review-surface/55",
      text: "text-cleaner-review-text",
    };
  }
  return {
    border: "border-cleaner-danger-border",
    surface: "bg-cleaner-danger-surface/55",
    text: "text-cleaner-danger-text",
  };
}

function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-gray-300 bg-gray-200/55 p-3">
      <div className="text-[11px] uppercase tracking-wider text-gray-700">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium text-gray-900">
        {value}
      </div>
    </div>
  );
}
