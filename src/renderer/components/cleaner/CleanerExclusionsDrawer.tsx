import { useMemo, useRef, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Ban, Info, X } from "lucide-react";
import { formatCleanerBytes } from "../../cleaner-format";
import type { CleanerExclusion } from "./types";
import { useCleanerModalFocus } from "./useCleanerModalFocus";

export function CleanerExclusionsDrawer({
  open,
  exclusions,
  excludedSize,
  returnFocusRef,
  onClose,
  onRemove,
}: {
  open: boolean;
  exclusions: CleanerExclusion[];
  excludedSize: number;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onRemove(id: string): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const groups = useMemo(() => {
    const next = new Map<CleanerExclusion["scope"], CleanerExclusion[]>();
    for (const exclusion of exclusions) {
      next.set(exclusion.scope, [
        ...(next.get(exclusion.scope) ?? []),
        exclusion,
      ]);
    }
    return [...next.entries()];
  }, [exclusions]);

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
            aria-labelledby="cleaner-exclusions-title"
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
                    id="cleaner-exclusions-title"
                    className="text-lg font-semibold"
                  >
                    Cleaner exclusions
                  </h3>
                  <span className="rounded-full border border-cleaner-excluded-border bg-cleaner-excluded-surface px-2 py-0.5 text-xs font-semibold text-cleaner-excluded-text">
                    {exclusions.length}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-700">
                  {formatCleanerBytes(excludedSize)} currently excluded across
                  persistent rules.
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close Cleaner exclusions"
                className="rounded-full p-2 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-5 rounded-2xl border border-cleaner-excluded-border bg-cleaner-excluded-surface/62 p-4 text-sm text-cleaner-excluded-text">
              <Info
                className="mb-2 h-5 w-5 text-cleaner-excluded-icon"
                aria-hidden="true"
              />
              Exclusions are ignored by bulk cleanup. Remove a rule here to make
              matching findings actionable again.
            </div>

            <div className="mt-5 space-y-5">
              {groups.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-gray-400 bg-gray-200/38 p-7 text-center text-gray-700">
                  <Ban className="mx-auto mb-2 h-5 w-5" aria-hidden="true" />
                  No Cleaner exclusions yet.
                </div>
              ) : (
                groups.map(([scope, items]) => (
                  <section
                    key={scope}
                    aria-labelledby={`cleaner-exclusion-${scope}`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <h4
                        id={`cleaner-exclusion-${scope}`}
                        className="text-xs font-semibold uppercase tracking-wider text-gray-700"
                      >
                        {scope} rules
                      </h4>
                      <span className="text-xs text-gray-600">
                        {items.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <AnimatePresence initial={false}>
                        {items.map((exclusion) => (
                          <motion.div
                            layout={!reduceMotion}
                            key={exclusion.id}
                            initial={
                              reduceMotion ? false : { opacity: 0, x: 8 }
                            }
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 14, height: 0 }}
                            className="overflow-hidden rounded-2xl border border-cleaner-excluded-border bg-cleaner-excluded-surface/52 p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="break-words font-medium text-gray-900">
                                  {exclusion.label}
                                </div>
                                <div className="mt-1 break-all font-mono text-[11px] leading-4 text-gray-700">
                                  {exclusion.value}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => onRemove(exclusion.id)}
                                className="shrink-0 rounded-lg border border-cleaner-danger-border bg-cleaner-danger-surface px-2.5 py-1.5 text-xs font-medium text-cleaner-danger-text outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
                                aria-label={`Remove exclusion ${exclusion.label}`}
                              >
                                Remove
                              </button>
                            </div>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </section>
                ))
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
