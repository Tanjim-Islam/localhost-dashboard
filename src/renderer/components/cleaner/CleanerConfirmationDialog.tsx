import { useCallback, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, ShieldCheck, X } from "lucide-react";
import { calculateUnionRecoverableBytes } from "../../cleaner-view-model";
import { formatCleanerBytes } from "../../cleaner-format";
import { CleanerStatusBadge } from "./CleanerStatus";
import type { CleanerFinding } from "./types";
import { useCleanerModalFocus } from "./useCleanerModalFocus";

export type CleanerConfirmationState = {
  findings: CleanerFinding[];
  conditional: boolean;
} | null;

export function CleanerConfirmationDialog({
  state,
  confirmationText,
  onConfirmationTextChange,
  onCancel,
  onConfirm,
}: {
  state: CleanerConfirmationState;
  confirmationText: string;
  onConfirmationTextChange(value: string): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const safeConfirmRef = useRef<HTMLButtonElement>(null);
  const conditionalInputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  const open = state !== null;
  const close = useCallback(() => onCancel(), [onCancel]);

  useCleanerModalFocus({
    open,
    containerRef: panelRef,
    initialFocusRef: state?.conditional ? conditionalInputRef : safeConfirmRef,
    onClose: close,
  });

  const findings = state?.findings ?? [];
  const conditional = state?.conditional ?? false;
  const total = calculateUnionRecoverableBytes(findings);
  const ready = !conditional || confirmationText === "CLEAN CONDITIONAL";
  const tone = conditional
    ? {
        border: "border-cleaner-conditional-border",
        surface: "bg-cleaner-conditional-surface",
        text: "text-cleaner-conditional-text",
        icon: "text-cleaner-conditional-icon",
        button:
          "bg-cleaner-conditional text-cleaner-conditional-contrast hover:bg-cleaner-conditional/90",
      }
    : {
        border: "border-cleaner-safe-border",
        surface: "bg-cleaner-safe-surface",
        text: "text-cleaner-safe-text",
        icon: "text-cleaner-safe-icon",
        button:
          "bg-cleaner-safe text-cleaner-safe-contrast hover:bg-cleaner-safe/90",
      };

  return (
    <AnimatePresence>
      {state && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-night/72 p-4 backdrop-blur-sm"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onCancel();
          }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cleaner-confirm-title"
            aria-describedby="cleaner-confirm-description"
            initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99 }}
            transition={{
              duration: reduceMotion ? 0 : 0.24,
              ease: [0.22, 1, 0.36, 1],
            }}
            className={`app-dialog app-scrollbar max-h-[88vh] w-full max-w-3xl overflow-y-auto border bg-gray-100 p-6 text-gray-900 shadow-2xl ${tone.border}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div
                  className={`mb-3 inline-flex rounded-2xl border p-3 ${tone.border} ${tone.surface} ${tone.icon}`}
                >
                  {conditional ? (
                    <AlertTriangle className="h-6 w-6" aria-hidden="true" />
                  ) : (
                    <ShieldCheck className="h-6 w-6" aria-hidden="true" />
                  )}
                </div>
                <h3
                  id="cleaner-confirm-title"
                  className="text-xl font-semibold"
                >
                  {conditional
                    ? "Confirm conditional cleanup"
                    : "Confirm safe cleanup"}
                </h3>
                <p
                  id="cleaner-confirm-description"
                  className="mt-2 text-sm text-gray-700"
                >
                  {findings.length} finding{findings.length === 1 ? "" : "s"},{" "}
                  {formatCleanerBytes(total)} estimated logical recovery.
                </p>
              </div>
              <button
                type="button"
                onClick={onCancel}
                aria-label="Close cleanup confirmation"
                className="rounded-full p-2 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {findings.map((finding) => (
                <div
                  key={finding.id}
                  className={`rounded-2xl border p-4 ${finding.safety === "conditional" ? "border-cleaner-conditional-border bg-cleaner-conditional-surface/58" : "border-cleaner-safe-border bg-cleaner-safe-surface/55"}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold">{finding.displayName}</div>
                      <div className="mt-0.5 text-xs text-gray-700">
                        {finding.applicationName ?? finding.detectorId}
                      </div>
                    </div>
                    <CleanerStatusBadge safety={finding.safety} />
                  </div>
                  <code className="app-scrollbar mt-2 block max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-gray-100/70 p-2 font-mono text-xs text-gray-800">
                    {finding.path}
                  </code>
                  <div className="mt-2 text-sm text-gray-800">
                    {formatCleanerBytes(finding.recoverableBytes)} recoverable.{" "}
                    {finding.consequences.join(" ")}
                  </div>
                  {finding.restoration && (
                    <div className="mt-1 text-xs text-gray-700">
                      Restoration: {finding.restoration}
                    </div>
                  )}
                  {finding.relatedProcesses.length > 0 && (
                    <div className="mt-2 rounded-lg border border-cleaner-blocked-border bg-cleaner-blocked-surface p-2 text-xs text-cleaner-blocked-text">
                      Related processes:{" "}
                      {finding.relatedProcesses
                        .map((item) => item.name)
                        .join(", ")}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-gray-700">
                    {finding.regeneration.summary}
                  </div>
                </div>
              ))}
            </div>

            {conditional && (
              <label className="mt-5 block rounded-2xl border border-cleaner-conditional-border bg-cleaner-conditional-surface/72 p-4 text-cleaner-conditional-text">
                <span className="block text-sm font-semibold">
                  Conditional cleanup can remove development dependencies or
                  expensive downloads.
                </span>
                <span className="mt-1 block text-xs">
                  Type CLEAN CONDITIONAL to confirm.
                </span>
                <input
                  ref={conditionalInputRef}
                  value={confirmationText}
                  onChange={(event) =>
                    onConfirmationTextChange(event.target.value)
                  }
                  aria-label="Type CLEAN CONDITIONAL to confirm conditional cleanup"
                  className="mt-3 w-full rounded-xl border border-cleaner-conditional-border bg-gray-100 px-3 py-2 font-mono text-sm text-gray-900 outline-none focus:ring-2 focus:ring-cleaner-conditional-border"
                />
              </label>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-xl border border-gray-300 bg-gray-200 px-4 py-2 font-medium outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                Cancel
              </button>
              <button
                ref={safeConfirmRef}
                type="button"
                onClick={onConfirm}
                disabled={!ready}
                className={`rounded-xl px-4 py-2 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-night disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-700 ${tone.button}`}
              >
                Confirm cleanup
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
