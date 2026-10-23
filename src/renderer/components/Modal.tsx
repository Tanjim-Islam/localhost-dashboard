import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

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
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
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
    </dialog>
  );
}
