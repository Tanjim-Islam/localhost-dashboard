import React from "react";
import cx from "classnames";
import dayjs from "dayjs";
import { ScriptDestructiveButton } from "./ScriptDestructiveButton";

type AutomatorItem = {
  key: string;
  pid?: number;
  ppid?: number;
  processName?: string;
  scriptName: string;
  sourceKind: string;
  sourceLabel: string;
  status: "running" | "installed";
  firstSeen: number;
  lastSeen: number;
  command?: string;
  scriptPath?: string;
  processPath?: string;
  runtimeSeconds?: number;
  canOpenInAutomator: boolean;
  cpu?: number;
  memory?: number;
};

type ButtonState = "idle" | "active" | "done";

export default function AutomatorCard({
  item,
  onOptimisticStop,
}: {
  item: AutomatorItem;
  onOptimisticStop?: (key: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = React.useState<null | "left" | "right">(null);
  const [copyState, setCopyState] = React.useState<ButtonState>("idle");
  const [openState, setOpenState] = React.useState<ButtonState>("idle");
  const [revealState, setRevealState] = React.useState<ButtonState>("idle");

  const targetPath = item.scriptPath || item.processPath;
  const runtime =
    typeof item.runtimeSeconds === "number"
      ? readableDuration(item.runtimeSeconds)
      : dayjs(item.lastSeen).from(item.firstSeen, true);
  const cpu = typeof item.cpu === "number" ? `${item.cpu.toFixed(1)}%` : "n/a";
  const mem =
    typeof item.memory === "number" ? readableBytes(item.memory) : "n/a";
  const isRunning = item.status === "running" && typeof item.pid === "number";

  const stop = () => {
    if (exiting || !isRunning) return;
    const rect = ref.current?.getBoundingClientRect();
    const centerX = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
    const dir = centerX < window.innerWidth / 2 ? "left" : "right";
    setExiting(dir);
    window.api.stopAutomator(item.pid!);
    window.setTimeout(() => onOptimisticStop?.(item.key), 260);
  };

  const copyPath = () => {
    if (!targetPath || copyState !== "idle") return;
    setCopyState("active");
    window.api.copyText(targetPath);
    setTimeout(() => {
      setCopyState("done");
      setTimeout(() => setCopyState("idle"), 1600);
    }, 150);
  };

  const reveal = async () => {
    if (!targetPath || revealState !== "idle") return;
    setRevealState("active");
    await window.api.revealAutomator(targetPath);
    setTimeout(() => {
      setRevealState("done");
      setTimeout(() => setRevealState("idle"), 1400);
    }, 150);
  };

  const openInAutomator = async () => {
    if (!item.scriptPath || !item.canOpenInAutomator || openState !== "idle")
      return;
    setOpenState("active");
    await window.api.openAutomator(item.scriptPath);
    setTimeout(() => {
      setOpenState("done");
      setTimeout(() => setOpenState("idle"), 1600);
    }, 200);
  };

  return (
    <div
      ref={ref}
      className={cx(
        "app-card rounded-xl border border-gray-300/40 bg-gray-100/94 p-4 shadow-soft transition-all duration-300 will-change-transform border-l-4 border-l-celadon-400",
        !isRunning && "border-l-gray-400",
        exiting === "left" && "-translate-x-[120%] opacity-0",
        exiting === "right" && "translate-x-[120%] opacity-0",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-2.5 w-2.5 rounded-full bg-celadon-400 animate-pulse shrink-0"></div>
            <div
              className="text-lg font-semibold text-night-900 truncate"
              title={item.scriptName}
            >
              {item.scriptName}
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
            <span
              className={cx(
                "rounded-md px-2 py-0.5",
                isRunning
                  ? "bg-celadon-400/20 text-celadon-700"
                  : "bg-gray-300/70 text-gray-700",
              )}
            >
              {isRunning ? "Running" : "Installed"}
            </span>
            <span className="rounded-md bg-night-700/10 px-2 py-0.5 text-night-800">
              {item.sourceLabel}
            </span>
            {typeof item.pid === "number" && <span>PID {item.pid}</span>}
            <span className="opacity-50">•</span>
            <span>
              {isRunning ? "Runtime" : "First seen"} {runtime}
            </span>
          </div>
        </div>
        <div className="text-xs text-gray-600 whitespace-nowrap">
          Seen {dayjs(item.lastSeen).format("HH:mm:ss")}
        </div>
      </div>

      {item.scriptPath ? (
        <PathLine label="Path" value={item.scriptPath} onClick={copyPath} />
      ) : item.processPath ? (
        <PathLine label="Runner" value={item.processPath} onClick={copyPath} />
      ) : (
        <div className="mt-2 text-xs text-gray-600">
          Source path not reported by macOS.
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700">
        <span>CPU {cpu}</span>
        <span className="opacity-50">•</span>
        <span>MEM {mem}</span>
        {item.processName && (
          <>
            <span className="opacity-50">•</span>
            <span title={item.processName}>Process {item.processName}</span>
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {item.canOpenInAutomator && item.scriptPath && (
          <ActionButton
            state={openState}
            idleLabel="Automator"
            activeLabel="Opening..."
            doneLabel="Opened"
            onClick={openInAutomator}
            tone="primary"
          />
        )}

        <ActionButton
          state={revealState}
          idleLabel="Finder"
          activeLabel="Revealing..."
          doneLabel="Revealed"
          onClick={reveal}
          disabled={!targetPath}
          tone="neutral"
        />

        <ActionButton
          state={copyState}
          idleLabel="Copy Path"
          activeLabel="Copying..."
          doneLabel="Copied"
          onClick={copyPath}
          disabled={!targetPath}
          tone="neutral"
        />

        {isRunning && (
          <ScriptDestructiveButton
            onClick={stop}
            disabled={Boolean(exiting)}
            aria-busy={Boolean(exiting)}
            className="ml-auto h-10 px-4 text-sm font-medium"
            title="Stop script"
          >
            Stop
          </ScriptDestructiveButton>
        )}
      </div>
    </div>
  );
}

function PathLine({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={value}
      className="mt-2 block w-full truncate rounded-md px-0 py-0 text-left text-xs text-gray-600 transition-colors hover:text-gray-800"
    >
      <span className="font-medium text-gray-700">{label} </span>
      {value}
    </button>
  );
}

function ActionButton({
  state,
  idleLabel,
  activeLabel,
  doneLabel,
  onClick,
  disabled,
  tone,
}: {
  state: ButtonState;
  idleLabel: string;
  activeLabel: string;
  doneLabel: string;
  onClick: () => void;
  disabled?: boolean;
  tone: "primary" | "neutral";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || state !== "idle"}
      className={cx(
        "h-10 px-4 rounded-full text-sm font-medium transition-all duration-200 transform",
        tone === "primary" &&
          state === "idle" &&
          "bg-night-700 text-night-100 hover:bg-night-800 hover:scale-105 active:scale-95",
        tone === "neutral" &&
          state === "idle" &&
          "bg-gray-200 text-gray-900 hover:bg-gray-300 hover:scale-105 active:scale-95",
        state === "active" && "bg-gray-300 text-gray-900 scale-95",
        state === "done" && "bg-celadon-400 text-white scale-100",
        disabled && "opacity-50 cursor-not-allowed hover:scale-100",
      )}
    >
      <span className="flex min-w-[76px] items-center justify-center gap-1.5">
        {state === "idle" && idleLabel}
        {state === "active" && (
          <>
            <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-700 border-t-transparent animate-spin"></span>
            {activeLabel}
          </>
        )}
        {state === "done" && doneLabel}
      </span>
    </button>
  );
}

function readableDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(0, Math.floor(totalSeconds))}s`;
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
