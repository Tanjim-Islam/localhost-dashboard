import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import AppearanceSettings from "./AppearanceSettings";
import { useThemePreferences } from "../theme/ThemeProvider";

type Props = {
  open: boolean;
  onClose: () => void;
  settings: any;
  platform?: string;
  onSave: (next: any) => void | Promise<void>;
  onReset?: () => void | Promise<void>;
};

export default function SettingsPanel({
  open,
  onClose,
  settings,
  platform,
  onSave,
  onReset,
}: Props) {
  const { resetPreferences } = useThemePreferences();
  const [scanIntervalMs, setScanIntervalMs] = useState(5000);
  const [portsText, setPortsText] = useState(
    "3000-3999, 8000, 8080, 5000, 4200, 5173-5199"
  );
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [openInTrayAtLogin, setOpenInTrayAtLogin] = useState(true);
  const [notifyOnStart, setNotifyOnStart] = useState(true);
  const [notifyOnStop, setNotifyOnStop] = useState(true);
  const [scanAllPorts, setScanAllPorts] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);
  const [globalHotkey, setGlobalHotkey] = useState("Ctrl+Shift+D");
  const [recording, setRecording] = useState(false);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const supportsTrayStartup = platform === "darwin" || platform === "win32";
  const minimizedLocation = platform === "darwin" ? "background" : "tray";

  useEffect(() => {
    if (settings) {
      setScanIntervalMs(settings.scanIntervalMs ?? 5000);
      setPortsText(settings.portsText ?? portsToString(settings.ports || []));
      setStartAtLogin(Boolean(settings.startAtLogin));
      setOpenInTrayAtLogin(
        typeof settings.openInTrayAtLogin === "boolean"
          ? settings.openInTrayAtLogin
          : true,
      );
      setScanAllPorts(Boolean(settings.scanAllPorts));
      setCloseToTray(
        typeof settings.closeToTray === "boolean" ? settings.closeToTray : true
      );
      // handle legacy single toggle too
      const legacy = settings.notifications;
      setNotifyOnStart(
        typeof settings.notifyOnStart === "boolean"
          ? settings.notifyOnStart
          : typeof legacy === "boolean"
          ? legacy
          : true
      );
      setNotifyOnStop(
        typeof settings.notifyOnStop === "boolean"
          ? settings.notifyOnStop
          : typeof legacy === "boolean"
          ? legacy
          : true
      );
      setGlobalHotkey(settings.globalHotkey || "Ctrl+Shift+D");
      setRecordedKeys([]);
      setHotkeyError(null);
    }
  }, [settings]);

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const key = normalizeKey(e);
      if (!key) return;
      setRecordedKeys((prev) => {
        if (prev.length >= 4) return prev;
        if (prev.includes(key)) return prev;
        return [...prev, key];
      });
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [recording]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4 no-drag backdrop-blur-[2px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="app-dialog flex max-h-[calc(100dvh-2rem)] w-[720px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden border border-gray-300 bg-gray-100 text-gray-900 shadow-soft"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-300 px-4 py-3.5">
          <div>
            <h2 id="settings-title" className="text-base font-semibold">
              Settings
            </h2>
            <div className="mt-0.5 text-[11px] text-gray-600">
              Tune the dashboard without leaving your workspace.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close settings"
            aria-label="Close settings"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-700 transition-colors hover:bg-mimi_pink-300 hover:text-mimi_pink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mimi_pink-400"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="settings-scroll app-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          <div className="space-y-4 pt-4">
            <AppearanceSettings />

            <section aria-label="Server scanning" className="space-y-3.5">
              <label className="block space-y-1.5 pb-1">
                <span className="block text-sm text-gray-700">
                  Scan interval (ms)
                </span>
                <input
                  type="number"
                  value={scanIntervalMs}
                  onChange={(e) =>
                    setScanIntervalMs(parseInt(e.target.value || "0", 10))
                  }
                  className="w-full rounded-xl bg-gray-200 px-3 py-2 outline-none ring-night-700 focus:ring-2"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block text-sm text-gray-700">
                  Ports (comma separated, allow ranges like 3000-3999)
                </span>
                <input
                  value={portsText}
                  onChange={(e) => setPortsText(e.target.value)}
                  className="w-full rounded-xl bg-gray-200 px-3 py-2 outline-none ring-night-700 focus:ring-2"
                />
              </label>
              <label className="flex items-center gap-2.5 pt-0.5">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-night-700"
                  checked={scanAllPorts}
                  onChange={(e) => setScanAllPorts(e.target.checked)}
                />
                <span>Scan all ports (slower)</span>
              </label>
            </section>

            <section className="settings-section p-3.5 text-gray-900">
              <div className="mb-3 text-sm font-semibold text-gray-900">
                System startup
              </div>
              <div className="space-y-3">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-night-700"
                    checked={startAtLogin}
                    onChange={(e) => setStartAtLogin(e.target.checked)}
                  />
                  <span className="text-sm font-medium">
                    Start at system login
                  </span>
                </label>
                <label
                  className={`flex items-center gap-3 rounded-xl border border-gray-300 px-3 py-2 transition-opacity ${
                    startAtLogin && supportsTrayStartup
                      ? "opacity-100"
                      : "opacity-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-celadon-600"
                    checked={openInTrayAtLogin}
                    onChange={(e) => setOpenInTrayAtLogin(e.target.checked)}
                    disabled={!startAtLogin || !supportsTrayStartup}
                  />
                  <span className="text-sm font-medium">
                    Open in {minimizedLocation} at login
                  </span>
                </label>
              </div>
            </section>

            <section className="space-y-3.5" aria-label="Window behavior">
              <div className="space-y-2">
                <div className="text-sm text-gray-700">On window close</div>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="closeBehavior"
                      className="h-4 w-4 accent-night-700"
                      checked={closeToTray}
                      onChange={() => setCloseToTray(true)}
                    />
                    <span>Minimize to {minimizedLocation} (default)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="closeBehavior"
                      className="h-4 w-4 accent-night-700"
                      checked={!closeToTray}
                      onChange={() => setCloseToTray(false)}
                    />
                    <span>Quit the application</span>
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-night-700"
                    checked={notifyOnStart}
                    onChange={(e) => setNotifyOnStart(e.target.checked)}
                  />
                  <span>Notify when server starts</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-night-700"
                    checked={notifyOnStop}
                    onChange={(e) => setNotifyOnStop(e.target.checked)}
                  />
                  <span>Notify when server stops</span>
                </label>
              </div>
            </section>

            <section className="settings-section p-3.5 text-gray-900">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    Global hotkey
                  </div>
                  <div className="text-xs text-gray-700">
                    Toggle the dashboard from anywhere
                  </div>
                </div>
                <div className="flex gap-2">
                  {!recording && (
                    <button
                      type="button"
                      onClick={() => {
                        setRecording(true);
                        setRecordedKeys([]);
                        setHotkeyError(null);
                      }}
                      className="rounded-full bg-gray-300 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-400"
                    >
                      Edit
                    </button>
                  )}
                  {recording && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setRecordedKeys([]);
                          setRecording(false);
                          setHotkeyError(null);
                        }}
                        className="rounded-full bg-gray-300 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-400"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!isValidHotkey(recordedKeys)) {
                            setHotkeyError("Shortcut must be 2-4 keys.");
                            return;
                          }
                          const accel = keysToAccelerator(recordedKeys);
                          if (!accel) return;
                          setGlobalHotkey(accel);
                          setRecording(false);
                          setHotkeyError(null);
                        }}
                        disabled={!isValidHotkey(recordedKeys)}
                        className={`rounded-full px-3 py-1.5 text-sm ${
                          !isValidHotkey(recordedKeys)
                            ? "cursor-not-allowed bg-gray-300 text-gray-600"
                            : "bg-night-700 text-night-100 hover:bg-night-800"
                        }`}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex min-h-[36px] flex-wrap items-center gap-2">
                {renderKeys(
                  recording
                    ? recordedKeys
                    : parseAccelerator(globalHotkey || "Ctrl+Shift+D"),
                )}
                {recording && (
                  <span className="flex items-center gap-1 text-xs text-mimi_pink-700 animate-pulse">
                    <span className="h-2 w-2 rounded-full bg-mimi_pink-500"></span>
                    Recording...
                  </span>
                )}
              </div>
              {recording && recordedKeys.length === 0 && (
                <div className="mt-2 text-xs text-gray-700">
                  Press 2-4 keys (e.g., Ctrl, Shift, D)
                </div>
              )}
              {hotkeyError && (
                <div className="mt-2 text-xs text-mimi_pink-700">
                  {hotkeyError}
                </div>
              )}
            </section>

            <section className="settings-section flex items-center justify-between gap-3 p-3.5 text-gray-900">
              <div className="text-sm font-semibold text-gray-900">
                Check for updates
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await window.api.checkForUpdates();
                  } catch (err) {
                    console.error("Failed to check for updates:", err);
                  }
                }}
                className="rounded-full bg-gray-300 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-400"
              >
                Check now
              </button>
            </section>
          </div>

          <footer className="mt-4 flex items-center justify-between gap-2 border-t border-gray-300 pt-4">
            <button
              type="button"
              onClick={async () => {
                if (!onReset) return;
                if (window.confirm("Reset all settings to defaults?")) {
                  resetPreferences();
                  await onReset();
                }
              }}
              className="rounded-full bg-mimi_pink-600/20 px-3 py-1.5 text-mimi_pink-800 hover:bg-mimi_pink-600/30"
            >
              Reset to defaults
            </button>
            <button
              type="button"
              onClick={() => {
                const keysForSave = recording
                  ? recordedKeys
                  : parseAccelerator(globalHotkey);
                if (!isValidHotkey(keysForSave)) {
                  setHotkeyError("Shortcut must be 2-4 keys.");
                  return;
                }
                const accel = keysToAccelerator(keysForSave);
                if (!accel) return;
                onSave({
                  scanIntervalMs,
                  portsText,
                  startAtLogin,
                  openInTrayAtLogin,
                  notifyOnStart,
                  notifyOnStop,
                  scanAllPorts,
                  closeToTray,
                  globalHotkey: accel,
                });
                setRecording(false);
                setGlobalHotkey(accel);
                setHotkeyError(null);
              }}
              className="rounded-full bg-night-700 px-3 py-1.5 text-night-100 hover:bg-night-800"
            >
              Save
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}

function portsToString(ports: (number | [number, number])[]) {
  return (ports || [])
    .map((p) => (Array.isArray(p) ? `${p[0]}-${p[1]}` : String(p)))
    .join(", ");
}

function normalizeKey(e: KeyboardEvent): string | null {
  const map: Record<string, string> = {
    Control: "Ctrl",
    Meta: "Super",
    Alt: "Alt",
    Shift: "Shift",
    " ": "Space",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Enter: "Enter",
    Tab: "Tab",
  };
  const raw = e.key;
  if (!raw) return null;
  const name = raw.length === 1 ? raw.toUpperCase() : raw;
  const resolved = map[name] || name;
  if (resolved.toLowerCase() === "dead" || resolved === "Unidentified")
    return null;
  return resolved;
}

function keysToAccelerator(keys: string[]): string | null {
  if (!keys.length) return null;
  const mapped = keys.map((k) => {
    if (k === "Ctrl") return "CommandOrControl";
    if (k === "Super") return "Super";
    return k;
  });
  return mapped.join("+");
}

function parseAccelerator(accel: string): string[] {
  if (!accel) return [];
  return accel.split("+").map((p) => {
    if (p === "CommandOrControl") return "Ctrl";
    if (p === "Super") return "Win";
    return p;
  });
}

function renderKeys(keys: string[]) {
  if (!keys.length) {
    return <span className="text-sm text-gray-700">No shortcut set</span>;
  }
  return keys.map((k) => (
    <span
      key={k}
      className="px-2.5 py-1 rounded-full bg-gray-300 text-gray-900 text-xs font-semibold shadow-sm border border-gray-400"
    >
      {k}
    </span>
  ));
}

function isValidHotkey(keys: string[]): boolean {
  if (!keys) return false;
  return keys.length >= 2 && keys.length <= 4;
}
