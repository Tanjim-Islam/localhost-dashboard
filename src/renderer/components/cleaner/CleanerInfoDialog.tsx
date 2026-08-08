import { useRef, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { useCleanerModalFocus } from "./useCleanerModalFocus";

export function CleanerInfoDialog({
  open,
  title,
  description,
  returnFocusRef,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const titleId = `cleaner-dialog-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;

  useCleanerModalFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    returnFocusRef,
    onClose,
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-night/68 p-4 backdrop-blur-[2px]"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99 }}
            transition={{
              duration: reduceMotion ? 0 : 0.2,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="app-dialog app-scrollbar max-h-[min(78vh,640px)] w-full max-w-xl overflow-y-auto border border-gray-300 bg-gray-100 p-5 text-gray-900 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 id={titleId} className="text-lg font-semibold">
                  {title}
                </h3>
                {description && (
                  <p className="mt-1 text-sm leading-5 text-gray-700">
                    {description}
                  </p>
                )}
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label={`Close ${title}`}
                className="shrink-0 rounded-full p-2 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-4">{children}</div>
            {footer && (
              <div className="mt-5 flex justify-end border-t border-gray-300 pt-4">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
