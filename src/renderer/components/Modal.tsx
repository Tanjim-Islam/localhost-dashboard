import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { motion, useIsPresent, useReducedMotion } from "framer-motion";

export default function Modal({
  title,
  children,
  onClose,
  busy = false,
  error,
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <motion.dialog
      ref={ref}
      inert={!present}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: reduceMotion ? 0 : 0.2 }}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="app-modal w-[min(640px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-2xl border border-gray-300 bg-gray-100 p-5 text-gray-900 shadow-2xl backdrop:bg-black/50"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button
          type="button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
          className="rounded-full p-2 hover:bg-gray-200"
        >
          <X size={18} />
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger-text">
          {error}
        </p>
      )}
      {children}
    </motion.dialog>
  );
}
