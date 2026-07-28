import { useCallback, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Search, ShieldCheck, X } from "lucide-react";
import { calculateUnionRecoverableBytes } from "../../cleaner-view-model";
import { formatCleanerBytes } from "../../cleaner-format";
import { CleanerStatusBadge } from "./CleanerStatus";
import type { CleanerFinding } from "./types";
import { useCleanerModalFocus } from "./useCleanerModalFocus";

export type CleanerConfirmationState = {
  findings: CleanerFinding[];
  level: "safe" | "conditional" | "manual-review";
  inUseFindings: Array<{
    findingId: string;
    displayName: string;
    processes: Array<{ name: string; pid?: number }>;
  }>;
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
  const strongConfirmationInputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  const open = state !== null;
  const close = useCallback(() => onCancel(), [onCancel]);

  useCleanerModalFocus({
    open,
    containerRef: panelRef,
    initialFocusRef:
      state?.level === "safe" || state?.inUseFindings.length
        ? safeConfirmRef
        : strongConfirmationInputRef,
    onClose: close,
  });

  const findings = state?.findings ?? [];
  const level = state?.level ?? "safe";
  const inUseFindings = state?.inUseFindings ?? [];
  const hasInUseFindings = inUseFindings.length > 0;
  const strongConfirmation = hasInUseFindings
    ? null
    : level === "manual-review"
      ? {
          phrase: "CLEAN MANUAL REVIEW",
          title: "Confirm manual-review cleanup",
          warning:
            "Cleaner could not classify these items as automatically safe. Confirm only after reviewing each name and path.",
        }
      : level === "conditional"
        ? {
            phrase: "CLEAN CONDITIONAL",
            title: "Confirm conditional cleanup",
            warning:
              "Conditional cleanup can remove development dependencies or expensive downloads.",
          }
        : null;
  const total = calculateUnionRecoverableBytes(findings);
  const recoveryKnown = findings.every(
    (finding) => finding.estimatedReclaimableBytes !== null,
  );
  const ready =
    !strongConfirmation || confirmationText === strongConfirmation.phrase;
  const tone =
    level === "manual-review"
      ? {
          border: "border-cleaner-review-border",
          surface: "bg-cleaner-review-surface",
          text: "text-cleaner-review-text",
          icon: "text-cleaner-review-icon",
          focus: "focus:ring-cleaner-review-border",
          button:
            "bg-cleaner-review text-cleaner-review-contrast hover:bg-cleaner-review/90",
        }
      : level === "conditional"
        ? {
            border: "border-cleaner-conditional-border",
            surface: "bg-cleaner-conditional-surface",
            text: "text-cleaner-conditional-text",
            icon: "text-cleaner-conditional-icon",
            focus: "focus:ring-cleaner-conditional-border",
            button:
              "bg-cleaner-conditional text-cleaner-conditional-contrast hover:bg-cleaner-conditional/90",
          }
        : {
            border: "border-cleaner-safe-border",
            surface: "bg-cleaner-safe-surface",
            text: "text-cleaner-safe-text",
            icon: "text-cleaner-safe-icon",
            focus: "focus:ring-cleaner-safe-border",
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
                  {level === "manual-review" ? (
                    <Search className="h-6 w-6" aria-hidden="true" />
                  ) : level === "conditional" ? (
                    <AlertTriangle className="h-6 w-6" aria-hidden="true" />
                  ) : (
                    <ShieldCheck className="h-6 w-6" aria-hidden="true" />
                  )}
                </div>
                <h3
                  id="cleaner-confirm-title"
                  className="text-xl font-semibold"
                >
                  {hasInUseFindings
                    ? "Clean files that are not in use?"
                    : (strongConfirmation?.title ?? "Confirm safe cleanup")}
                </h3>
                <p
                  id="cleaner-confirm-description"
                  className="mt-2 text-sm text-gray-700"
                >
                  {findings.length} finding{findings.length === 1 ? "" : "s"},{" "}
                  {recoveryKnown
                    ? `${formatCleanerBytes(total)} estimated recovery.`
                    : "recovery size unknown."}
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

            {hasInUseFindings ? (
              <div className="mt-5 space-y-3">
                {findings.map((finding) => {
                  const usage = inUseFindings.find(
                    (item) => item.findingId === finding.id,
                  );
                  return (
                    <div
                      key={finding.id}
                      className={`rounded-2xl border p-4 ${
                        usage
                          ? "border-cleaner-blocked-border bg-cleaner-blocked-surface"
                          : "border-gray-300 bg-gray-200/55"
                      }`}
                    >
                      <div className="font-semibold text-gray-900">
                        {finding.displayName}
                      </div>
                      <code className="app-scrollbar mt-2 block max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-gray-100/70 p-2 font-mono text-xs text-gray-800">
                        {finding.path}
                      </code>
                      {usage && (
                        <div className="mt-2 text-sm text-cleaner-blocked-text">
                          May be in use by{" "}
                          {usage.processes
                            .map((processInfo) =>
                              processInfo.pid
                                ? `${processInfo.name} (PID ${processInfo.pid})`
                                : processInfo.name,
                            )
                            .join(", ")}
                          .
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="rounded-xl border border-cleaner-conditional-border bg-cleaner-conditional-surface p-3 text-sm text-cleaner-conditional-text">
                  Active builds, installs, or applications may be affected.
                  Cleaner will remove unlocked files and skip files Windows
                  still locks.
                </p>
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {findings.map((finding) => (
                  <div
                    key={finding.id}
                    className={`rounded-2xl border p-4 ${
                      finding.safety === "manual-review"
                        ? "border-cleaner-review-border bg-cleaner-review-surface/58"
                        : finding.safety === "conditional"
                          ? "border-cleaner-conditional-border bg-cleaner-conditional-surface/58"
                          : "border-cleaner-safe-border bg-cleaner-safe-surface/55"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold">
                          {finding.displayName}
                        </div>
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
                      {finding.estimatedReclaimableBytes === null
                        ? "Size unknown."
                        : `${formatCleanerBytes(finding.estimatedReclaimableBytes)} recoverable.`}{" "}
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
            )}

            {strongConfirmation && (
              <label
                className={`mt-5 block rounded-2xl border p-4 ${tone.border} ${tone.surface} ${tone.text}`}
              >
                <span className="block text-sm font-semibold">
                  {strongConfirmation.warning}
                </span>
                <span className="mt-1 block text-xs">
                  Type {strongConfirmation.phrase} to confirm.
                </span>
                <input
                  ref={strongConfirmationInputRef}
                  value={confirmationText}
                  onChange={(event) =>
                    onConfirmationTextChange(event.target.value)
                  }
                  aria-label={`Type ${strongConfirmation.phrase} to confirm cleanup`}
                  className={`mt-3 w-full rounded-xl border bg-gray-100 px-3 py-2 font-mono text-sm text-gray-900 outline-none focus:ring-2 ${tone.border} ${tone.focus}`}
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
                {hasInUseFindings
                  ? "Yes, clean what can be cleaned"
                  : "Confirm cleanup"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
