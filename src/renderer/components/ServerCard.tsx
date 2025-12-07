import React from "react";
import cx from "classnames";
import dayjs from "dayjs";

type ButtonState = "idle" | "active" | "done";

type HealthStatus = {
  key: string;
  url: string;
  status: "healthy" | "slow" | "down";
  responseTime?: number;
  lastChecked: number;
  error?: string;
};

// Framework color mapping
const FRAMEWORK_COLORS: Record<string, string> = {
  Vite: "#646CFF",
  "Next.js": "#000000",
  Nuxt: "#00DC82",
  Angular: "#DD0031",
  CRA: "#61DAFB",
  Remix: "#121212",
  Astro: "#FF5D01",
  "Webpack Dev Server": "#8DD6F9",
  Django: "#092E20",
  Rails: "#CC0000",
  ".NET": "#512BD4",
  Go: "#00ADD8",
  Uvicorn: "#499848",
  Gunicorn: "#499848",
  PHP: "#777BB4",
  Deno: "#000000",
};

function getFrameworkColor(framework?: string): string {
  if (!framework) return "#6B7280"; // gray-500
  return FRAMEWORK_COLORS[framework] || "#6B7280";
}

export default function ServerCard({
  item,
  health,
  note,
  onNoteChange,
  onOptimisticKill,
}: {
  item: any;
  health?: HealthStatus;
  note?: string;
  onNoteChange?: (port: number, note: string) => void;
  onOptimisticKill?: (key: string) => void;
}) {
  const uptime = dayjs(item.lastSeen).from(item.firstSeen, true);
  const cpu = item.cpu ? `${item.cpu.toFixed(1)}%` : "—";
  const mem = item.memory ? readableBytes(item.memory) : "—";
  const projectDir = item.cwd || null;

  const healthColor =
    health?.status === "healthy"
      ? "bg-celadon-400"
      : health?.status === "slow"
      ? "bg-yellow-400"
      : health?.status === "down"
      ? "bg-mimi_pink-400"
      : "bg-gray-400";
  const responseTimeText =
    health?.responseTime !== undefined ? `${health.responseTime}ms` : null;

  const ref = React.useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = React.useState<null | "left" | "right">(null);
  const [editingNote, setEditingNote] = React.useState(false);
  const [noteValue, setNoteValue] = React.useState(note || "");

  // Sync note value when prop changes
  React.useEffect(() => {
    setNoteValue(note || "");
  }, [note]);

  // Button states for animations
  const [openState, setOpenState] = React.useState<ButtonState>("idle");
  const [copyState, setCopyState] = React.useState<ButtonState>("idle");

  const open = () => {
    if (openState !== "idle") return;
    setOpenState("active");
    window.api.openUrl(item.url);

    setTimeout(() => {
      setOpenState("done");
      setTimeout(() => setOpenState("idle"), 1500);
    }, 300);
  };

  const copy = () => {
    if (copyState !== "idle") return;
    setCopyState("active");
    window.api.copyText(item.url);

    setTimeout(() => {
      setCopyState("done");
      setTimeout(() => setCopyState("idle"), 2000);
    }, 150);
  };

  const kill = () => {
    if (exiting) return;
    const rect = ref.current?.getBoundingClientRect();
    const centerX = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
    const dir = centerX < window.innerWidth / 2 ? "left" : "right";
    setExiting(dir);
    window.api.killPid(item.pid);
    window.setTimeout(() => onOptimisticKill?.(item.key), 260);
  };

  const openTerminal = () => {
    if (projectDir) window.api.openTerminal(projectDir);
  };

  const openExplorer = () => {
    if (projectDir) window.api.openExplorer(projectDir);
  };

  const openVSCode = () => {
    if (projectDir) window.api.openInVSCode({ path: projectDir });
  };

  const [stats, setStats] = React.useState<any>(null);
  React.useEffect(() => {
    window.api.getStats().then(setStats);
    const off = window.api.onStatsUpdate(setStats);
    return () => off?.();
  }, []);

  const seenCount = stats?.portCounts?.[String(item.port)] ?? 0;
  const frameworkColor = getFrameworkColor(item.framework);

  return (
    <div
      ref={ref}
      className={cx(
        "rounded-xl border border-gray-300/40 bg-gray-100 p-4 shadow-soft transition-all duration-300 will-change-transform border-l-4",
        exiting === "left" && "-translate-x-[120%] opacity-0",
        exiting === "right" && "translate-x-[120%] opacity-0"
      )}
      style={{ borderLeftColor: frameworkColor }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={cx(
              "w-2.5 h-2.5 rounded-full transition-colors",
              healthColor,
              health?.status === "down" && "animate-pulse"
            )}
            title={health?.status || "checking..."}
          />
          <div className="text-2xl font-mono text-night-900">:{item.port}</div>
          {responseTimeText && (
            <span
              className={cx(
                "text-xs px-1.5 py-0.5 rounded-md",
                health?.status === "healthy" &&
                  "text-celadon-700 bg-celadon-400/20",
                health?.status === "slow" && "text-yellow-700 bg-yellow-400/20",
                health?.status === "down" &&
                  "text-mimi_pink-200 bg-mimi_pink-400/20"
              )}
            >
              {responseTimeText}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-600">
          PID {item.pid} • Seen {seenCount}x
        </div>
      </div>
      <div
        className="text-sm text-gray-700 mt-1 truncate"
        title={item.command || item.processName}
      >
        {item.processName || "Process"}
      </div>

      {/* Quick Actions Row */}
      <div className="flex items-center gap-1 mt-2">
        <QuickActionButton
          onClick={openTerminal}
          disabled={!projectDir}
          title="Open Terminal"
          icon={<TerminalIcon />}
        />
        <QuickActionButton
          onClick={openExplorer}
          disabled={!projectDir}
          title="Open in Explorer"
          icon={<FolderIcon />}
        />
        <QuickActionButton
          onClick={openVSCode}
          disabled={!projectDir}
          title="Open in VS Code"
          icon={<CodeIcon />}
        />
      </div>

      {/* Port Note */}
      {editingNote ? (
        <div className="mt-2">
          <input
            type="text"
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            onBlur={() => {
              setEditingNote(false);
              onNoteChange?.(item.port, noteValue);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setEditingNote(false);
                onNoteChange?.(item.port, noteValue);
              } else if (e.key === "Escape") {
                setEditingNote(false);
                setNoteValue(note || "");
              }
            }}
            autoFocus
            placeholder="Add a note for this port..."
            className="w-full px-2 py-1 text-xs bg-gray-200 rounded border border-gray-400/50 outline-none focus:border-celadon-400 text-gray-800"
          />
        </div>
      ) : (
        <div
          onClick={() => setEditingNote(true)}
          className={cx(
            "mt-2 text-xs cursor-pointer rounded px-2 py-1 transition-colors",
            note
              ? "text-gray-700 bg-pale_dogwood-300/30 hover:bg-pale_dogwood-300/50"
              : "text-gray-500 hover:bg-gray-200/50"
          )}
          title="Click to edit note"
        >
          {note || "+ Add note"}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700 mt-3">
        <span className="flex items-center gap-1.5">
          CPU {cpu}
          {item.cpuHistory && item.cpuHistory.length > 1 && (
            <Sparkline data={item.cpuHistory} color="#6EC4A8" />
          )}
        </span>
        <span className="opacity-50">•</span>
        <span className="flex items-center gap-1.5">
          MEM {mem}
          {item.memoryHistory && item.memoryHistory.length > 1 && (
            <Sparkline data={item.memoryHistory} color="#E0AFA0" />
          )}
        </span>
        <span className="opacity-50">•</span>
        <span>Up {uptime}</span>
      </div>
      <div className="mt-4 flex items-center gap-4 justify-between">
        <div className="flex items-center gap-3">
          {/* Open Button */}
          <button
            onClick={open}
            disabled={openState !== "idle"}
            className={cx(
              "h-12 px-5 rounded-full text-sm font-medium transition-all duration-200 transform",
              openState === "idle" &&
                "bg-night-700 text-night-100 hover:bg-night-800 hover:scale-105 active:scale-95",
              openState === "active" && "bg-night-800 text-night-100 scale-95",
              openState === "done" && "bg-night-600 text-celadon-300 scale-100"
            )}
          >
            <span className="flex items-center gap-1.5">
              {openState === "idle" && "Open"}
              {openState === "active" && (
                <>
                  <span className="inline-block w-3 h-3 border-2 border-night-100 border-t-transparent rounded-full animate-spin"></span>
                  Opening...
                </>
              )}
              {openState === "done" && (
                <>
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                  Opened
                </>
              )}
            </span>
          </button>

          {/* Copy URL Button */}
          <button
            onClick={copy}
            disabled={copyState !== "idle"}
            className={cx(
              "h-12 px-5 rounded-full text-sm font-medium transition-all duration-200 transform",
              copyState === "idle" &&
                "bg-gray-200 text-gray-900 hover:bg-gray-300 hover:scale-105 active:scale-95",
              copyState === "active" && "bg-gray-300 text-gray-900 scale-110",
              copyState === "done" && "bg-celadon-400 text-white scale-100"
            )}
          >
            <span className="flex items-center gap-1.5 min-w-[72px] justify-center">
              {copyState === "idle" && "Copy URL"}
              {copyState === "active" && (
                <span className="inline-block animate-ping">📋</span>
              )}
              {copyState === "done" && (
                <>
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  Copied!
                </>
              )}
            </span>
          </button>
        </div>

        {/* Kill Button */}
        <button
          onClick={kill}
          className="h-12 px-5 rounded-full bg-mimi_pink-300 text-mimi_pink-100 hover:bg-mimi_pink-200 hover:scale-105 active:scale-95 transition-all duration-200 transform text-sm font-medium"
        >
          Kill
        </button>
      </div>
    </div>
  );
}

function QuickActionButton({
  onClick,
  disabled,
  title,
  icon,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  icon: React.ReactNode;
}) {
  const [clicked, setClicked] = React.useState(false);

  const handleClick = () => {
    if (disabled) return;
    setClicked(true);
    onClick();
    setTimeout(() => setClicked(false), 300);
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      title={title}
      className={cx(
        "w-7 h-7 rounded-md flex items-center justify-center transition-all duration-150",
        disabled
          ? "text-gray-400 cursor-not-allowed opacity-50"
          : "text-gray-600 hover:bg-gray-300/60 hover:text-gray-900 active:scale-90",
        clicked && !disabled && "bg-celadon-400/30 text-celadon-700 scale-110"
      )}
    >
      {icon}
    </button>
  );
}

function TerminalIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
      />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
      />
    </svg>
  );
}

function Sparkline({
  data,
  color,
  width = 40,
  height = 14,
}: {
  data: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className="inline-block opacity-80">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
