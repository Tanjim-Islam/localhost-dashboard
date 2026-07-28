import { useRef, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight, History, X } from "lucide-react";
import {
  formatCleanerBytes,
  formatCleanerDate,
  formatCleanerSignedBytes,
} from "../../cleaner-format";
import type { CleanerCleanupHistoryEntry } from "./types";
import { useCleanerModalFocus } from "./useCleanerModalFocus";

export function CleanerHistoryDrawer({
  open,
  entries,
  returnFocusRef,
  onClose,
}: {
  open: boolean;
  entries: CleanerCleanupHistoryEntry[];
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();

  useCleanerModalFocus({
    open,
    containerRef: panelRef,
    initialFocusRef: closeRef,
    returnFocusRef,
    onClose,
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex justify-end bg-night/62 backdrop-blur-[2px]"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.22 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cleaner-history-title"
            initial={reduceMotion ? false : { opacity: 0, x: 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 28 }}
            transition={{
              duration: reduceMotion ? 0 : 0.26,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="app-scrollbar h-full w-full max-w-md overflow-y-auto border-l border-gray-300 bg-gray-100 p-5 text-gray-900 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3
                    id="cleaner-history-title"
                    className="text-lg font-semibold"
                  >
                    Cleanup history
                  </h3>
                  <span className="rounded-full border border-cleaner-safe-border bg-cleaner-safe-surface px-2 py-0.5 text-xs font-semibold text-cleaner-safe-text">
                    {entries.length}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-700">
                  Completed cleanup runs, newest first.
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close cleanup history"
                className="rounded-full p-2 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <p className="mt-5 rounded-2xl border border-gray-300 bg-gray-200/55 p-3 text-xs leading-5 text-gray-700">
              Recovered space uses the observed free-space change. Other disk
              activity can affect it.
            </p>

            <div className="mt-5 space-y-3">
              {entries.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-400 bg-gray-200/38 p-7 text-center text-gray-700">
                  <History
                    className="mx-auto mb-2 h-5 w-5"
                    aria-hidden="true"
                  />
                  No cleanup history yet.
                </div>
              ) : (
                entries.map((entry) => (
                  <details
                    key={entry.id}
                    className="group rounded-2xl border border-gray-300 bg-gray-200/45"
                  >
                    <summary className="cursor-pointer list-none rounded-2xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-cleaner-review-border">
                      <span className="flex items-start gap-3">
                        <ChevronRight
                          className="mt-0.5 h-4 w-4 shrink-0 text-gray-600 transition-transform group-open:rotate-90"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-gray-900">
                              {formatCleanerDate(entry.completedAt)}
                            </span>
                            <span className="rounded-full border border-cleaner-safe-border bg-cleaner-safe-surface px-2 py-0.5 text-[11px] font-semibold text-cleaner-safe-text">
                              {entry.mode === "deep"
                                ? "Deep Audit"
                                : "Standard Scan"}
                            </span>
                          </span>
                          <span className="mt-3 grid grid-cols-3 gap-2">
                            <HistoryMetric
                              label="Free before"
                              value={formatOptionalBytes(
                                entry.freeSpaceBeforeBytes,
                              )}
                            />
                            <HistoryMetric
                              label="Free after"
                              value={formatOptionalBytes(
                                entry.freeSpaceAfterBytes,
                              )}
                            />
                            <HistoryMetric
                              label="Recovered"
                              value={
                                entry.recoveredBytes === null
                                  ? "Unavailable"
                                  : formatCleanerSignedBytes(
                                      entry.recoveredBytes,
                                    )
                              }
                              positive={
                                entry.recoveredBytes !== null &&
                                entry.recoveredBytes > 0
                              }
                            />
                          </span>
                          <span className="mt-3 block text-xs font-medium text-gray-700">
                            {entry.deletedTargetNames.length} deleted{" "}
                            {entry.deletedTargetNames.length === 1
                              ? "target"
                              : "targets"}
                          </span>
                        </span>
                      </span>
                    </summary>

                    <div className="border-t border-gray-300 px-4 pb-4 pt-3">
                      {entry.deletedTargetNames.length === 0 ? (
                        <p className="text-xs text-gray-700">
                          No target was fully deleted.
                        </p>
                      ) : (
                        <ul
                          role="tree"
                          aria-label={`Deleted targets from ${formatCleanerDate(entry.completedAt)}`}
                          className="ml-2 border-l border-cleaner-safe-border/70"
                        >
                          {entry.deletedTargetNames.map((name, index) => (
                            <li
                              key={`${name}-${index}`}
                              role="treeitem"
                              className="relative py-1 pl-5 text-sm text-gray-800 before:absolute before:left-0 before:top-1/2 before:h-px before:w-3 before:bg-cleaner-safe-border"
                            >
                              {name}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </details>
                ))
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function HistoryMetric({
  label,
  value,
  positive = false,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <span className="min-w-0 rounded-xl border border-gray-300 bg-gray-100/72 px-2 py-2">
      <span className="block text-[10px] uppercase tracking-wide text-gray-600">
        {label}
      </span>
      <span
        className={`mt-0.5 block truncate text-xs font-semibold ${positive ? "text-cleaner-recovery" : "text-gray-900"}`}
        title={value}
      >
        {value}
      </span>
    </span>
  );
}

function formatOptionalBytes(value: number | null): string {
  return value === null ? "Unavailable" : formatCleanerBytes(value);
}
