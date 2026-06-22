import React from "react";
import cx from "classnames";
import dayjs from "dayjs";
import { Clock, Folder, SquarePen, Trash, X } from "lucide-react";

type RecentScript = {
  id: string;
  type: "ahk" | "automator";
  scriptPath: string;
  scriptName: string;
  firstSeen: number;
  lastUsed: number;
  useCount: number;
};

type BusyState = {
  id: string;
  action: "start" | "delete";
};

export default function RecentScriptsDrawer({
  open,
  scripts,
  label,
  onClose,
  onStart,
  onReveal,
  onDelete,
}: {
  open: boolean;
  scripts: RecentScript[];
  label: string;
  onClose: () => void;
  onStart: (id: string) => Promise<void>;
  onReveal: (scriptPath: string) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<BusyState | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  React.useEffect(() => {
    if (!open) {
      setBusy(null);
      setError(null);
    }
  }, [open]);

  const start = async (id: string) => {
    if (busy) return;
    setBusy({ id, action: "start" });
    setError(null);
    try {
      await onStart(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start script.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    setBusy({ id, action: "delete" });
    setError(null);
    try {
      await onDelete(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete entry.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={cx(
        "fixed inset-0 z-40 transition pointer-events-none",
        open && "pointer-events-auto",
      )}
      aria-hidden={!open}
    >
      <div
        className={cx(
          "absolute inset-0 bg-night-100/70 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />

      <aside
        className={cx(
          "absolute right-0 top-0 h-full w-[390px] max-w-[calc(100vw-24px)] border-l border-gray-300 bg-gray-100 shadow-2xl transition-transform duration-300",
          open ? "translate-x-0" : "translate-x-full",
        )}
        role="dialog"
        aria-modal={open}
        aria-label={`Recently used ${label}`}
      >
        <div className="flex h-full flex-col">
          <header className="border-b border-gray-300 px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-celadon-500">
                  Recently Used
                </div>
                <h2 className="mt-1 text-lg font-semibold text-gray-900">
                  {label}
                </h2>
              </div>
              <button
                onClick={onClose}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-700 transition-colors hover:bg-gray-200 hover:text-gray-900"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 text-xs text-gray-600">
              {scripts.length} saved{" "}
              {scripts.length === 1 ? "script" : "scripts"}
            </div>
          </header>

          {error && (
            <div className="mx-5 mt-4 rounded-lg border border-mimi_pink-400/40 bg-mimi_pink-300/15 px-3 py-2 text-xs text-mimi_pink-500">
              {error}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {scripts.length === 0 ? (
              <div className="mt-16 text-center">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-gray-300 bg-gray-200 text-gray-700">
                  <Clock className="h-5 w-5" />
                </div>
                <div className="mt-4 text-sm font-medium text-gray-900">
                  No recent scripts yet
                </div>
                <p className="mt-1 text-xs leading-5 text-gray-600">
                  Scripts are saved here after the dashboard sees them running.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {scripts.map((script) => {
                  const isStarting =
                    busy?.id === script.id && busy.action === "start";
                  const isDeleting =
                    busy?.id === script.id && busy.action === "delete";

                  return (
                    <div
                      key={script.id}
                      className="rounded-lg border border-gray-300 bg-gray-200/70 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div
                            className="truncate text-sm font-semibold text-gray-900"
                            title={script.scriptName}
                          >
                            {script.scriptName}
                          </div>
                          <div className="mt-1 truncate text-[11px] text-gray-600">
                            {script.scriptPath}
                          </div>
                        </div>
                        <div className="shrink-0 rounded-full bg-celadon-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-celadon-600">
                          {script.type === "ahk" ? "AHK" : "Auto"}
                        </div>
                      </div>

                      <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-600">
                        <span>{dayjs(script.lastUsed).fromNow()}</span>
                        <span className="opacity-50">.</span>
                        <span>Used {script.useCount}x</span>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <button
                          onClick={() => start(script.id)}
                          disabled={Boolean(busy)}
                          className={cx(
                            "flex h-8 items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition-all",
                            isStarting
                              ? "bg-celadon-500 text-white"
                              : "bg-celadon-400 text-night-100 hover:bg-celadon-500",
                            busy && !isStarting && "opacity-60",
                          )}
                        >
                          <SquarePen className="h-3.5 w-3.5" />
                          {isStarting ? "Starting" : "Start"}
                        </button>
                        <button
                          onClick={() => onReveal(script.scriptPath)}
                          disabled={Boolean(busy)}
                          className="flex h-8 items-center justify-center gap-1.5 rounded-full bg-gray-300 text-xs font-semibold text-gray-900 transition-all hover:bg-gray-400 disabled:opacity-60"
                        >
                          <Folder className="h-3.5 w-3.5" />
                          Explorer
                        </button>
                        <button
                          onClick={() => remove(script.id)}
                          disabled={Boolean(busy)}
                          className={cx(
                            "flex h-8 items-center justify-center gap-1.5 rounded-full text-xs font-semibold transition-all",
                            isDeleting
                              ? "bg-mimi_pink-300 text-white"
                              : "bg-mimi_pink-300/25 text-mimi_pink-500 hover:bg-mimi_pink-300/40",
                            busy && !isDeleting && "opacity-60",
                          )}
                        >
                          <Trash className="h-3.5 w-3.5" />
                          {isDeleting ? "Deleting" : "Delete"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
