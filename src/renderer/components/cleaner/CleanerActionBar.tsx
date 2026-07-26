import { forwardRef } from "react";
import { Eraser, RefreshCw, ScanSearch, SlidersHorizontal } from "lucide-react";
import { formatCleanerBytes } from "../../cleaner-format";
import type { CleanerSelectionTone } from "../../cleaner-view-model";

export const CleanerActionBar = forwardRef<
  HTMLButtonElement,
  {
    mode: "standard" | "deep";
    selectedCount: number;
    selectedBytes: number;
    selectionTone: CleanerSelectionTone;
    safeRecoverableBytes: number;
    exclusionCount: number;
    onSelectSafe(): void;
    onClearSelection(): void;
    onRescan(): void;
    onAlternateScan(): void;
    onOpenExclusions(): void;
    onCleanSafe(): void;
    onCleanSelected(): void;
  }
>(function CleanerActionBar(
  {
    mode,
    selectedCount,
    selectedBytes,
    selectionTone,
    safeRecoverableBytes,
    exclusionCount,
    onSelectSafe,
    onClearSelection,
    onRescan,
    onAlternateScan,
    onOpenExclusions,
    onCleanSafe,
    onCleanSelected,
  },
  exclusionsButtonRef,
) {
  const selectedButtonTone =
    selectionTone === "conditional"
      ? "bg-cleaner-conditional text-cleaner-conditional-contrast hover:bg-cleaner-conditional/90"
      : selectionTone === "safe"
        ? "bg-cleaner-safe text-cleaner-safe-contrast hover:bg-cleaner-safe/90"
        : "bg-gray-300 text-gray-700";
  return (
    <section
      className="mt-3 border-t border-gray-300 pt-3"
      aria-label="Cleaner actions"
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSelectSafe}
            className="min-h-9 rounded-xl border border-cleaner-safe-border bg-cleaner-safe-surface px-3 text-sm font-semibold text-cleaner-safe-text outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-cleaner-safe-border"
          >
            Select all safe now
          </button>
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selectedCount === 0}
            className="min-h-9 rounded-xl border border-gray-300 bg-gray-200 px-3 text-sm font-medium text-gray-800 outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-cleaner-review-border disabled:cursor-not-allowed disabled:opacity-45"
          >
            Clear selection
          </button>
          <button
            type="button"
            onClick={onRescan}
            className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-gray-300 bg-gray-200 px-3 text-sm font-medium text-gray-800 outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Rescan
          </button>
          <button
            type="button"
            onClick={onAlternateScan}
            className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-gray-300 bg-gray-200 px-3 text-sm font-medium text-gray-800 outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
          >
            <ScanSearch className="h-4 w-4" aria-hidden="true" />
            {mode === "standard" ? "Run Deep Audit" : "Run Standard Scan"}
          </button>
          <button
            ref={exclusionsButtonRef}
            type="button"
            onClick={onOpenExclusions}
            className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-cleaner-excluded-border bg-cleaner-excluded-surface px-3 text-sm font-medium text-cleaner-excluded-text outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />{" "}
            Exclusions ({exclusionCount})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <div
            className="mr-1 text-right text-xs text-gray-700"
            aria-live="polite"
          >
            <div className="font-semibold text-gray-900">
              {selectedCount} selected
            </div>
            <div>{formatCleanerBytes(selectedBytes)} recoverable</div>
          </div>
          <button
            type="button"
            onClick={onCleanSafe}
            disabled={safeRecoverableBytes === 0}
            className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-cleaner-safe px-4 text-sm font-semibold text-cleaner-safe-contrast outline-none transition hover:bg-cleaner-safe/90 focus-visible:ring-2 focus-visible:ring-cleaner-safe-border focus-visible:ring-offset-2 focus-visible:ring-offset-night disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-700"
          >
            <Eraser className="h-4 w-4" aria-hidden="true" />
            Clean safe items, {formatCleanerBytes(safeRecoverableBytes)}
          </button>
          <button
            type="button"
            onClick={onCleanSelected}
            disabled={selectedCount === 0}
            className={`min-h-9 rounded-xl px-4 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-cleaner-review-border focus-visible:ring-offset-2 focus-visible:ring-offset-night disabled:cursor-not-allowed ${selectedButtonTone}`}
          >
            Clean selected items
          </button>
        </div>
      </div>
    </section>
  );
});
