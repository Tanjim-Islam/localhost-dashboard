import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronRight, Copy } from "lucide-react";

export function CleanerDetailsAccordion({
  path,
  children,
  actions,
}: {
  path: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const contentId = useId();
  const reduceMotion = useReducedMotion();

  const copyPath = () => {
    window.api.copyText(path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="mt-3 border-t border-gray-300/80 pt-2 text-sm text-gray-800">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-gray-900 outline-none transition-colors hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
        >
          <motion.span
            aria-hidden="true"
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
          >
            <ChevronRight className="h-4 w-4" />
          </motion.span>
          <span>Details</span>
        </button>
        {actions}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={contentId}
            role="region"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={
              reduceMotion ? { display: "none" } : { height: 0, opacity: 0 }
            }
            transition={{
              height: {
                duration: reduceMotion ? 0 : 0.22,
                ease: [0.22, 1, 0.36, 1],
              },
              opacity: { duration: reduceMotion ? 0 : 0.16 },
            }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-4 rounded-xl bg-gray-200/46 p-3">
              {children}
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-700">
                    Exact path
                  </div>
                  <button
                    type="button"
                    onClick={copyPath}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-800 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
                    aria-label={`Copy exact path for ${path}`}
                  >
                    {copied ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copied ? "Copied" : "Copy path"}
                  </button>
                </div>
                <code className="app-scrollbar block max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-gray-100/75 p-2 font-mono text-xs leading-5 text-gray-900">
                  {path}
                </code>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
