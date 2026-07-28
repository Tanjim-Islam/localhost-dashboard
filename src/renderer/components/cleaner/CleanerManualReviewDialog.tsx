import { useCallback, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, X } from "lucide-react";
import { formatCleanerBytes } from "../../cleaner-format";
import type { CleanerFinding } from "./types";
import { useCleanerModalFocus } from "./useCleanerModalFocus";

export function CleanerManualReviewDialog({
  finding,
  onCancel,
  onApprove,
}: {
  finding: CleanerFinding | null;
  onCancel(): void;
  onApprove(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const close = useCallback(() => onCancel(), [onCancel]);

  useCleanerModalFocus({
    open: finding !== null,
    containerRef: panelRef,
    initialFocusRef: approveRef,
    onClose: close,
  });

  return (
    <AnimatePresence>
      {finding && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-night/72 p-4 backdrop-blur-sm"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onCancel();
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cleaner-review-title"
            aria-describedby="cleaner-review-description"
            initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 5, scale: 0.99 }}
            className="app-dialog w-full max-w-md border border-cleaner-review-border bg-gray-100 p-5 text-gray-900 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="rounded-xl border border-cleaner-review-border bg-cleaner-review-surface p-2.5 text-cleaner-review-icon">
                  <Search className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h3 id="cleaner-review-title" className="font-semibold">
                    Approve manual cleanup
                  </h3>
                  <p className="mt-1 truncate text-sm font-medium">
                    {finding.displayName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onCancel}
                aria-label="Close manual review"
                className="rounded-full p-2 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <p
              id="cleaner-review-description"
              className="mt-4 text-sm leading-5 text-gray-700"
            >
              This target is outside automatic cleanup. Approving it makes the
              item selectable, but all cleanup safety checks still apply.
            </p>
            <div className="mt-3 text-sm font-medium text-gray-900">
              {finding.estimatedReclaimableBytes === null
                ? "Size unknown"
                : `${formatCleanerBytes(finding.estimatedReclaimableBytes)} estimated recovery`}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-xl border border-gray-300 bg-gray-200 px-4 py-2 font-medium outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                Cancel
              </button>
              <button
                ref={approveRef}
                type="button"
                onClick={onApprove}
                className="rounded-xl bg-cleaner-review px-4 py-2 font-semibold text-cleaner-review-contrast outline-none hover:bg-cleaner-review/90 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                Approve and select
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
