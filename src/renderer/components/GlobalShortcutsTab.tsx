import React, { useCallback, useEffect, useMemo, useState } from "react";
import cx from "classnames";
import dayjs from "dayjs";

// Local mirrors of the IPC payload shapes (matches src/types/preload.d.ts).
type ShortcutSourceType =
  | "this-app"
  | "windows-reserved"
  | "lnk"
  | "ahk"
  | "cache"
  | "probe";

type ShortcutStatus =
  | "active"
  | "taken"
  | "available"
  | "previously-seen"
  | "now-free"
  | "reserved"
  | "used-by-app"
  | "unknown-owner"
  | "invalid";

type ShortcutRecord = {
  shortcut: string;
  accelerator: string;
  sourceType: ShortcutSourceType;
  sourceName?: string;
  sourcePath?: string;
  status: ShortcutStatus;
  firstSeen: number;
  lastSeen: number;
  lastChecked: number;
  ownerKnown: boolean;
  confidence: "low" | "medium" | "high";
};

type ShortcutCheckResult = {
  shortcut: string;
  accelerator: string;
  status: ShortcutStatus;
  source?: { type: ShortcutSourceType; name?: string; path?: string };
  reason?: string;
};

type RecommendationEntry = {
  shortcut: string;
  accelerator: string;
  reason: string;
  previouslySeen: boolean;
  includesWin: boolean;
};

type GlobalShortcutsSnapshot = {
  platform: string;
  supported: boolean;
  records: ShortcutRecord[];
};

type KeyCount = 2 | 3 | 4;

const STATUS_BADGE: Record<
  ShortcutStatus,
  { label: string; cls: string; dot: string }
> = {
  active: {
    label: "Active",
    cls: "bg-celadon-300/30 text-celadon-700 border-celadon-400/40",
    dot: "bg-celadon-400",
  },
  taken: {
    label: "Taken",
    cls: "bg-mimi_pink-400/20 text-mimi_pink-200 border-mimi_pink-400/30",
    dot: "bg-mimi_pink-300",
  },
  available: {
    label: "Available",
    cls: "bg-night-700/30 text-night-800 border-night-700/30",
    dot: "bg-night-700",
  },
  "previously-seen": {
    label: "Previously seen",
    cls: "bg-pale_dogwood-400/20 text-pale_dogwood-200 border-pale_dogwood-400/30",
    dot: "bg-pale_dogwood-400",
  },
  "now-free": {
    label: "Now free",
    cls: "bg-celadon-400/20 text-celadon-700 border-celadon-400/30",
    dot: "bg-celadon-300",
  },
  reserved: {
    label: "Reserved by Windows",
    cls: "bg-gray-300/30 text-gray-800 border-gray-400/40",
    dot: "bg-gray-500",
  },
  "used-by-app": {
    label: "Used by this app",
    cls: "bg-night-700/40 text-night-900 border-night-700/40",
    dot: "bg-night-700",
  },
  "unknown-owner": {
    label: "Unknown owner",
    cls: "bg-gray-300/40 text-gray-700 border-gray-400/30",
    dot: "bg-gray-400",
  },
  invalid: {
    label: "Invalid",
    cls: "bg-mimi_pink-300/20 text-mimi_pink-200 border-mimi_pink-300/30",
    dot: "bg-mimi_pink-300",
  },
};

function StatusBadge({ status }: { status: ShortcutStatus }) {
  const meta = STATUS_BADGE[status];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-semibold whitespace-nowrap",
        meta.cls
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

function KeyChips({ shortcut }: { shortcut: string }) {
  const parts = shortcut.split("+").map((p) => p.trim()).filter(Boolean);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {parts.map((p, i) => (
        <React.Fragment key={`${p}-${i}`}>
          <kbd className="font-mono text-[11px] px-2 py-0.5 rounded-md bg-gray-200 border border-gray-300 text-gray-900 shadow-sm">
            {p}
          </kbd>
          {i < parts.length - 1 && (
            <span className="text-gray-600 text-xs select-none">+</span>
          )}
        </React.Fragment>
      ))}
    </span>
  );
}

function sourceLabel(record: ShortcutRecord): string {
  switch (record.sourceType) {
    case "this-app":
      return "Localhost Dashboard";
    case "windows-reserved":
      return "Windows";
    case "lnk":
      return "Windows shortcut (.lnk)";
    case "ahk":
      return "AutoHotkey script";
    case "cache":
      return "Cached";
    case "probe":
      return "Probe";
  }
}

// =============================================================================
// Shortcut recorder hook
// =============================================================================

const MOD_DISPLAY_FROM_EVENT = (e: KeyboardEvent): Set<string> => {
  const mods = new Set<string>();
  if (e.ctrlKey) mods.add("Ctrl");
  if (e.altKey) mods.add("Alt");
  if (e.shiftKey) mods.add("Shift");
  if (e.metaKey) mods.add("Win");
  return mods;
};

const MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "Meta",
  "OS",
  "ContextMenu",
]);

function normalizeFinalKeyFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key) return null;
  if (MODIFIER_KEYS.has(key)) return null;
  if (key === "Dead" || key === "Unidentified") return null;

  const map: Record<string, string> = {
    " ": "Space",
    Spacebar: "Space",
    Escape: "Escape",
    Esc: "Escape",
    Enter: "Return",
    Return: "Return",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Del: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    PrintScreen: "PrintScreen",
  };
  if (map[key]) return map[key];
  if (key.length === 1) return key.toUpperCase();
  if (/^F([1-9]|1\d|2[0-4])$/i.test(key)) return "F" + key.substring(1);
  return null;
}

function partsToAccelerator(parts: string[]): string | null {
  if (parts.length < 2 || parts.length > 4) return null;
  const finalKey = parts[parts.length - 1];
  if (!finalKey) return null;
  const mods = parts.slice(0, -1).map((m) => {
    if (m === "Ctrl" || m === "Control") return "CommandOrControl";
    if (m === "Win" || m === "Meta" || m === "Super") return "Super";
    return m;
  });
  const order = ["CommandOrControl", "Alt", "Shift", "Super"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, finalKey].join("+");
}

type RecorderState = {
  recording: boolean;
  liveMods: string[];
  captured: string[] | null;
};

function useShortcutRecorder(onCaptured: (parts: string[]) => void) {
  const [state, setState] = useState<RecorderState>({
    recording: false,
    liveMods: [],
    captured: null,
  });

  const start = useCallback(() => {
    setState({ recording: true, liveMods: [], captured: null });
  }, []);

  const cancel = useCallback(() => {
    setState({ recording: false, liveMods: [], captured: null });
  }, []);

  const clear = useCallback(() => {
    setState({ recording: false, liveMods: [], captured: null });
  }, []);

  useEffect(() => {
    if (!state.recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setState({ recording: false, liveMods: [], captured: null });
        return;
      }

      const liveMods = Array.from(MOD_DISPLAY_FROM_EVENT(e));

      // Modifier-only press: just update display
      if (MODIFIER_KEYS.has(e.key)) {
        setState((s) => ({ ...s, liveMods }));
        return;
      }

      const finalKey = normalizeFinalKeyFromEvent(e);
      if (!finalKey) return;
      if (liveMods.length === 0) {
        // Modifier-only shortcut not allowed
        return;
      }
      const total = liveMods.length + 1;
      if (total < 2 || total > 4) return;

      const parts = [...liveMods, finalKey];
      setState({ recording: false, liveMods: [], captured: parts });
      onCaptured(parts);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setState((s) =>
        s.recording
          ? { ...s, liveMods: Array.from(MOD_DISPLAY_FROM_EVENT(e)) }
          : s
      );
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [state.recording, onCaptured]);

  return { state, start, cancel, clear, setState };
}

// =============================================================================
// Recorder input
// =============================================================================

function ShortcutRecorderInput({
  onCheck,
  result,
  checking,
  onClear,
}: {
  onCheck: (parts: string[]) => void;
  result: ShortcutCheckResult | null;
  checking: boolean;
  onClear: () => void;
}) {
  const recorder = useShortcutRecorder((parts) => {
    onCheck(parts);
  });

  const display = (() => {
    if (recorder.state.recording) {
      return recorder.state.liveMods.length
        ? recorder.state.liveMods.join(" + ")
        : "";
    }
    if (recorder.state.captured) return recorder.state.captured.join(" + ");
    if (result?.shortcut) return result.shortcut;
    return "";
  })();

  const showPlaceholder = !recorder.state.recording && !display;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => {
            if (recorder.state.recording) recorder.cancel();
            else recorder.start();
          }}
          className={cx(
            "flex-1 min-w-[260px] min-h-[48px] px-4 py-2 rounded-xl border text-left transition-all duration-150 flex items-center gap-2 flex-wrap focus:outline-none",
            recorder.state.recording
              ? "border-celadon-400/60 bg-night-700/40 text-night-100"
              : "border-gray-300 bg-gray-200 hover:bg-gray-300/80 text-gray-900"
          )}
        >
          {showPlaceholder && (
            <span className="text-sm text-gray-700">
              Click and press a shortcut (Ctrl + Shift + K)…
            </span>
          )}
          {!showPlaceholder && display && <KeyChips shortcut={display} />}
          {recorder.state.recording && (
            <span className="ml-auto text-[11px] uppercase tracking-wider flex items-center gap-1 text-celadon-300">
              <span className="h-1.5 w-1.5 rounded-full bg-mimi_pink-400 animate-pulse" />
              Recording
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            recorder.clear();
            onClear();
          }}
          className="px-3 py-2 rounded-full bg-gray-200 hover:bg-gray-300 text-sm text-gray-900"
          title="Clear"
        >
          Clear
        </button>
      </div>

      <div className="text-xs text-gray-700 leading-relaxed">
        Press 2–4 keys including modifiers (Ctrl, Alt, Shift, Win). Esc cancels.
      </div>

      {checking && (
        <div className="text-xs text-gray-700 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-night-700 border-t-transparent rounded-full animate-spin" />
          Checking availability…
        </div>
      )}

      {result && !checking && (
        <div className="rounded-xl border border-gray-300 bg-gray-100 p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <KeyChips shortcut={result.shortcut} />
            <StatusBadge status={result.status} />
          </div>
          {result.reason && (
            <div className="text-xs text-gray-700 truncate" title={result.reason}>
              {result.reason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Recommendations panel
// =============================================================================

function RecommendationsPanel({
  recommendations,
  loading,
  keyCount,
  onKeyCountChange,
  onRecommend,
}: {
  recommendations: RecommendationEntry[];
  loading: boolean;
  keyCount: KeyCount;
  onKeyCountChange: (n: KeyCount) => void;
  onRecommend: () => void;
}) {
  return (
    <div className="rounded-xl border border-gray-300 bg-gray-100 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-night-900">
            Recommend a shortcut
          </div>
          <div className="text-xs text-gray-700">
            We'll probe a small candidate set and rank what looks safe.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center bg-gray-200 rounded-full p-0.5">
            {([2, 3, 4] as KeyCount[]).map((n) => (
              <button
                key={n}
                onClick={() => onKeyCountChange(n)}
                className={cx(
                  "px-3 py-1 text-xs font-semibold rounded-full transition-colors",
                  keyCount === n
                    ? "bg-night-700 text-night-100"
                    : "text-gray-800 hover:bg-gray-300"
                )}
              >
                {n} keys
              </button>
            ))}
          </div>
          <button
            onClick={onRecommend}
            disabled={loading}
            className={cx(
              "px-3 py-1.5 rounded-full text-sm font-medium transition-all",
              loading
                ? "bg-gray-300 text-gray-700 cursor-wait"
                : "bg-night-700 text-night-100 hover:bg-night-800 active:scale-95"
            )}
          >
            {loading ? "Recommending…" : "Recommend"}
          </button>
        </div>
      </div>

      {recommendations.length > 0 && (
        <div className="space-y-2">
          {recommendations.map((r) => (
            <div
              key={r.accelerator}
              className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-gray-200 border border-gray-300 flex-wrap"
            >
              <KeyChips shortcut={r.shortcut} />
              <span className="text-xs text-gray-700 ml-auto truncate">
                {r.reason}
              </span>
              <button
                className="px-2 py-1 rounded-full bg-gray-300 hover:bg-gray-400 text-[11px] font-semibold text-gray-900"
                onClick={() => window.api.copyText(r.shortcut)}
                title="Copy"
              >
                Copy
              </button>
            </div>
          ))}
        </div>
      )}

      {!loading && recommendations.length === 0 && (
        <div className="text-xs text-gray-600">
          No recommendations yet. Pick a key count and click Recommend.
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Shortcut list
// =============================================================================

function ShortcutRow({ rec }: { rec: ShortcutRecord }) {
  const lastSeen = dayjs(rec.lastSeen).fromNow();
  const lastChecked = dayjs(rec.lastChecked).fromNow();

  return (
    <div className="rounded-xl border border-gray-300/40 bg-gray-100 p-3.5 hover:bg-gray-100/90 transition-colors">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <KeyChips shortcut={rec.shortcut} />
            <StatusBadge status={rec.status} />
          </div>
          <div className="text-xs text-gray-700 flex items-center gap-1.5 flex-wrap">
            <span className="font-medium">{sourceLabel(rec)}</span>
            {rec.sourceName && (
              <>
                <span className="opacity-50">•</span>
                <span className="truncate max-w-[280px]" title={rec.sourceName}>
                  {rec.sourceName}
                </span>
              </>
            )}
          </div>
          {rec.sourcePath && (
            <div
              className="text-[11px] text-gray-600 truncate font-mono"
              title={rec.sourcePath}
            >
              {rec.sourcePath}
            </div>
          )}
        </div>
        <div className="text-[11px] text-gray-600 text-right shrink-0 leading-tight">
          <div>Last seen {lastSeen}</div>
          <div>Last checked {lastChecked}</div>
          <div className="opacity-70">Confidence: {rec.confidence}</div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Main tab component
// =============================================================================

export default function GlobalShortcutsTab({
  query,
}: {
  query: string;
}) {
  const [snapshot, setSnapshot] = useState<GlobalShortcutsSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checkResult, setCheckResult] = useState<ShortcutCheckResult | null>(
    null
  );
  const [checking, setChecking] = useState(false);
  const [keyCount, setKeyCount] = useState<KeyCount>(3);
  const [recommendations, setRecommendations] = useState<RecommendationEntry[]>(
    []
  );
  const [recommending, setRecommending] = useState(false);

  // Load initial + subscribe to updates
  useEffect(() => {
    let cancelled = false;
    window.api.getGlobalShortcuts().then((s) => {
      if (!cancelled) setSnapshot(s);
    });
    const off = window.api.onGlobalShortcutsUpdate((records) => {
      setSnapshot((prev) =>
        prev
          ? { ...prev, records }
          : { platform: "win32", supported: true, records }
      );
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await window.api.refreshGlobalShortcuts();
      setSnapshot(next);
    } finally {
      setTimeout(() => setRefreshing(false), 600);
    }
  }, [refreshing]);

  const onCheck = useCallback(async (parts: string[]) => {
    const accel = partsToAccelerator(parts);
    if (!accel) {
      setCheckResult({
        shortcut: parts.join(" + "),
        accelerator: parts.join("+"),
        status: "invalid",
        reason: "Need 2–4 keys with at least one modifier and a final key.",
      });
      return;
    }
    setChecking(true);
    try {
      const r = await window.api.checkGlobalShortcut(accel);
      setCheckResult(r);
    } finally {
      setChecking(false);
    }
  }, []);

  const onRecommend = useCallback(async () => {
    setRecommending(true);
    try {
      const recs = await window.api.recommendGlobalShortcuts({ keyCount });
      setRecommendations(recs);
    } finally {
      setRecommending(false);
    }
  }, [keyCount]);

  const records = snapshot?.records ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => {
      const hay = [
        r.shortcut,
        r.accelerator,
        r.sourceName ?? "",
        r.sourcePath ?? "",
        r.status,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [records, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, ShortcutRecord[]> = {};
    const order: ShortcutStatus[] = [
      "active",
      "used-by-app",
      "reserved",
      "now-free",
      "previously-seen",
      "taken",
      "unknown-owner",
      "invalid",
      "available",
    ];
    for (const r of filtered) {
      (groups[r.status] = groups[r.status] || []).push(r);
    }
    return order
      .filter((s) => groups[s]?.length)
      .map((s) => ({ status: s, items: groups[s] }));
  }, [filtered]);

  // Non-Windows fallback
  if (snapshot && !snapshot.supported) {
    return (
      <div className="max-w-3xl mx-auto rounded-xl border border-gray-300 bg-gray-100 p-6 text-center text-gray-800">
        <div className="text-lg font-semibold mb-1">
          Global Shortcuts (Windows only)
        </div>
        <div className="text-sm text-gray-700">
          This feature uses Windows-specific detection (PowerShell, .lnk files,
          AHK script paths). It's disabled on this platform.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="rounded-xl bg-gray-100 border border-gray-300 p-4 space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-base font-semibold text-night-900">
              Global Shortcuts
            </div>
            <div className="text-xs text-gray-700 leading-relaxed">
              Track which shortcuts are taken, available, or previously seen.
              Detection uses Windows reserved shortcuts, .lnk files, AutoHotkey
              scripts, and Electron probes.
            </div>
          </div>
          <RefreshNowButton onClick={refresh} refreshing={refreshing} />
        </div>
        <div className="text-[11px] text-gray-600 italic">
          Note: Windows does not always expose the owner app for taken
          shortcuts, so some shortcuts may show as unknown owner.
        </div>
      </div>

      {/* Recorder + result */}
      <div className="rounded-xl border border-gray-300 bg-gray-100 p-4 space-y-3">
        <div className="text-sm font-semibold text-night-900">
          Check a shortcut
        </div>
        <ShortcutRecorderInput
          onCheck={onCheck}
          result={checkResult}
          checking={checking}
          onClear={() => setCheckResult(null)}
        />
      </div>

      {/* Recommendations */}
      <RecommendationsPanel
        recommendations={recommendations}
        loading={recommending}
        keyCount={keyCount}
        onKeyCountChange={setKeyCount}
        onRecommend={onRecommend}
      />

      {/* Shortcut list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm text-gray-700">
            {filtered.length} shortcut{filtered.length === 1 ? "" : "s"} tracked
          </div>
        </div>
        {filtered.length === 0 ? (
          <div className="text-gray-600 text-center py-12 text-sm">
            No shortcuts detected yet. Try Refresh Now to scan sources.
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map((g) => (
              <div key={g.status} className="space-y-2">
                <div className="text-[11px] uppercase tracking-wider text-gray-700 font-semibold flex items-center gap-2">
                  <StatusBadge status={g.status} />
                  <span className="opacity-60">({g.items.length})</span>
                </div>
                <div
                  className="grid gap-2.5"
                  style={{
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
                  }}
                >
                  {g.items.map((rec) => (
                    <ShortcutRow key={rec.accelerator} rec={rec} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RefreshNowButton({
  onClick,
  refreshing,
}: {
  onClick: () => void;
  refreshing: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={refreshing}
      className={cx(
        "h-9 px-4 rounded-full text-sm font-medium flex items-center gap-1.5 transition-all",
        refreshing
          ? "bg-celadon-400/20 text-celadon-700 cursor-wait"
          : "bg-night-700 text-night-100 hover:bg-night-800 active:scale-95"
      )}
    >
      <svg
        className={cx(
          "w-3.5 h-3.5 transition-transform",
          refreshing && "animate-spin"
        )}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      {refreshing ? "Refreshing…" : "Refresh Now"}
    </button>
  );
}
