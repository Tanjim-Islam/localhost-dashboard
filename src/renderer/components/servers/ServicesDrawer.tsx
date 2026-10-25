import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";

// Native dialog provides focus trapping and makes background controls inert.
export default function ServicesDrawer({
  open,
  onClose,
  children,
  error,
}: {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
  }, [open]);
  return createPortal(
    <dialog
      ref={ref}
      aria-label="More services"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-transparent p-0 text-gray-900 backdrop:bg-transparent"
    >
      <AnimatePresence
        onExitComplete={() => {
          if (!open) ref.current?.close();
        }}
      >
        {open && (
          <motion.div
            key="drawer"
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
          >
            <div
              className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
              onClick={onClose}
            />
            <motion.aside
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
              className="app-dialog absolute right-0 top-0 flex h-full w-[440px] max-w-[calc(100vw-24px)] flex-col border-l border-gray-300 bg-gray-100 shadow-soft"
            >
              <header className="flex items-center justify-between border-b border-gray-300 px-5 py-4">
                <h2 className="text-base font-semibold">More services</h2>
                <button
                  autoFocus
                  onClick={onClose}
                  aria-label="Close more services"
                  className="rounded-full p-2 text-gray-700 hover:bg-gray-200"
                >
                  <X size={16} />
                </button>
              </header>
              {error && (
                <p role="alert" className="px-5 pt-4 text-sm text-danger-text">
                  {error}
                </p>
              )}
              <div className="app-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                {children}
              </div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </dialog>,
    document.body,
  );
}
