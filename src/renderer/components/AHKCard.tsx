import React from "react";
import cx from "classnames";
import dayjs from "dayjs";
import { Copy, Folder, RotateCcw, SquarePen, X } from "lucide-react";
import { ScriptDestructiveButton } from "./ScriptDestructiveButton";

type AHKItem = {
  key: string;
  pid: number;
  processName: string;
  scriptPath?: string;
  scriptName?: string;
  firstSeen: number;
  lastSeen: number;
  cpu?: number;
  memory?: number;
};

type ButtonState = "idle" | "active" | "done";

export default function AHKCard({
  item,
  onOptimisticKill,
}: {
  item: AHKItem;
  onOptimisticKill?: (key: string) => void;
}) {
  const uptime = dayjs(item.lastSeen).from(item.firstSeen, true);
  const cpu = typeof item.cpu === "number" ? `${item.cpu.toFixed(1)}%` : "n/a";
  const mem =
    typeof item.memory === "number" ? readableBytes(item.memory) : "n/a";

  const ref = React.useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = React.useState<null | "left" | "right">(null);
  const [copyState, setCopyState] = React.useState<ButtonState>("idle");
  const [restartState, setRestartState] = React.useState<ButtonState>("idle");
  const [editState, setEditState] = React.useState<ButtonState>("idle");

  const kill = () => {
    if (exiting) return;
    const rect = ref.current?.getBoundingClientRect();
    const centerX = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
    const dir = centerX < window.innerWidth / 2 ? "left" : "right";
    setExiting(dir);
    window.api.killAHK(item.pid);
    window.setTimeout(() => onOptimisticKill?.(item.key), 260);
  };

  const restart = async () => {
    if (!item.scriptPath || restartState !== "idle") return;
    setRestartState("active");

    try {
      window.api.killAHK(item.pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await window.api.restartAHK(item.scriptPath);

      setRestartState("done");
      setTimeout(() => setRestartState("idle"), 2000);
    } catch {
      setRestartState("idle");
    }
  };

  const edit = () => {
    if (!item.scriptPath || editState !== "idle") return;
    setEditState("active");
    window.api.editAHK(item.scriptPath);

    setTimeout(() => {
      setEditState("done");
      setTimeout(() => setEditState("idle"), 1500);
    }, 300);
  };

  const openExplorer = () => {
    if (!item.scriptPath) return;
    window.api.openExplorer(item.scriptPath);
  };

  const copyPath = () => {
    if (!item.scriptPath || copyState !== "idle") return;
    setCopyState("active");
    window.api.copyText(item.scriptPath);

    setTimeout(() => {
      setCopyState("done");
      setTimeout(() => setCopyState("idle"), 2000);
    }, 150);
  };

  return (
    <div
      ref={ref}
      className={cx(
        "app-card rounded-xl border border-pale_dogwood-400/40 bg-gray-100/94 p-4 shadow-soft transition-all duration-300 will-change-transform",
        exiting === "left" && "-translate-x-[120%] opacity-0",
        exiting === "right" && "translate-x-[120%] opacity-0",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-celadon-400 animate-pulse" />
          <div
            className="truncate text-lg font-semibold text-night-900"
            title={item.scriptName || item.processName}
          >
            {item.scriptName || item.processName}
          </div>
        </div>
        <div className="shrink-0 text-xs text-gray-600">PID {item.pid}</div>
      </div>

      {item.scriptPath && (
        <button
          className="mt-1.5 flex w-full items-center gap-1.5 text-left text-xs text-gray-600 transition-colors hover:text-gray-800"
          title={item.scriptPath}
          onClick={copyPath}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{item.scriptPath}</span>
        </button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700">
        <span>CPU {cpu}</span>
        <span className="opacity-50">.</span>
        <span>MEM {mem}</span>
        <span className="opacity-50">.</span>
        <span>Up {uptime}</span>
      </div>

      <div className="mt-4 flex items-center gap-2.5 overflow-hidden whitespace-nowrap">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {item.scriptPath && (
            <>
              <button
                onClick={edit}
                disabled={editState !== "idle"}
                className={cx(
                  "flex h-8 w-[56px] shrink-0 items-center justify-center gap-1 rounded-full text-xs font-semibold transition-all duration-200",
                  editState === "idle" &&
                    "bg-night-700 text-night-100 hover:bg-night-800 active:scale-95",
                  editState === "active" && "bg-night-800 text-night-100",
                  editState === "done" && "bg-night-600 text-celadon-300",
                )}
                title="Edit script"
              >
                {editState === "idle" && (
                  <>
                    <SquarePen className="h-3.5 w-3.5" />
                    Edit
                  </>
                )}
                {editState === "active" && (
                  <Spinner className="border-night-100" />
                )}
                {editState === "done" && <SquarePen className="h-3.5 w-3.5" />}
              </button>

              <button
                onClick={openExplorer}
                className="flex h-8 w-[84px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-gray-200 text-xs font-semibold text-gray-900 transition-all duration-200 hover:bg-gray-300 active:scale-95"
                title="Open in Explorer"
              >
                <Folder className="h-3.5 w-3.5" />
                Explorer
              </button>

              <button
                onClick={restart}
                disabled={restartState !== "idle"}
                className={cx(
                  "flex h-8 w-[92px] shrink-0 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-semibold transition-all duration-200",
                  restartState === "idle" &&
                    "bg-celadon-400/80 text-night-900 hover:bg-celadon-400 active:scale-95",
                  restartState === "active" &&
                    "bg-celadon-500 text-night-900 animate-pulse",
                  restartState === "done" && "bg-celadon-500 text-white",
                )}
                title="Restart script"
              >
                {restartState === "idle" && (
                  <>
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restart
                  </>
                )}
                {restartState === "active" && (
                  <>
                    <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                    Restarting
                  </>
                )}
                {restartState === "done" && (
                  <>
                    <RotateCcw className="h-3.5 w-3.5" />
                    Done
                  </>
                )}
              </button>
            </>
          )}

          <button
            onClick={copyPath}
            disabled={!item.scriptPath || copyState !== "idle"}
            className={cx(
              "flex h-8 w-[64px] shrink-0 items-center justify-center gap-1 rounded-full text-xs font-semibold transition-all duration-200",
              copyState === "idle" &&
                "bg-gray-200 text-gray-900 hover:bg-gray-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50",
              copyState === "active" && "bg-gray-300 text-gray-900",
              copyState === "done" && "bg-celadon-400 text-white",
            )}
            title="Copy path"
          >
            {copyState === "idle" && (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
            {copyState === "active" && <Copy className="h-3.5 w-3.5" />}
            {copyState === "done" && "Copied"}
          </button>
        </div>

        <ScriptDestructiveButton
          onClick={kill}
          disabled={Boolean(exiting)}
          aria-busy={Boolean(exiting)}
          className="ml-auto h-8 w-[54px] gap-1 text-xs font-semibold"
          title="Kill script"
        >
          <X className="h-3.5 w-3.5" />
          Kill
        </ScriptDestructiveButton>
      </div>
    </div>
  );
}

function readableBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function Spinner({ className }: { className: string }) {
  return (
    <span
      className={cx(
        "inline-block h-3 w-3 rounded-full border-2 border-t-transparent animate-spin",
        className,
      )}
    />
  );
}
