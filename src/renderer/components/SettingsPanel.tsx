import React, { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  settings: any;
  onSave: (next: any) => void | Promise<void>;
  onReset?: () => void | Promise<void>;
};

export default function SettingsPanel({
  open,
  onClose,
  settings,
  onSave,
  onReset,
}: Props) {
  const [scanIntervalMs, setScanIntervalMs] = useState(5000);
  const [portsText, setPortsText] = useState(
    "3000-3999, 8000, 8080, 5000, 4200, 5173-5199"
  );
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [notifyOnStart, setNotifyOnStart] = useState(true);
  const [notifyOnStop, setNotifyOnStop] = useState(true);
  const [scanAllPorts, setScanAllPorts] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);
  const [globalHotkey, setGlobalHotkey] = useState("Ctrl+Shift+D");
  const [recording, setRecording] = useState(false);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setScanIntervalMs(settings.scanIntervalMs ?? 5000);
      setPortsText(settings.portsText ?? portsToString(settings.ports || []));
      setStartAtLogin(Boolean(settings.startAtLogin));
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center no-drag">
      <div className="w-[560px] max-w-[95vw] bg-gray-100 text-gray-900 rounded-lg shadow-soft p-5">
        <div className="text-lg font-semibold mb-4">Settings</div>
        <div className="space-y-4">
          <label className="block">
            <div className="text-sm text-gray-700 mb-1">Scan interval (ms)</div>
            <input
              type="number"
              value={scanIntervalMs}
              onChange={(e) =>
                setScanIntervalMs(parseInt(e.target.value || "0", 10))
              }
              className="w-full rounded bg-gray-200 px-3 py-2 outline-none focus:ring-2 ring-night-700"
            />
          </label>
          <label className="block">
            <div className="text-sm text-gray-700 mb-1">
              Ports (comma separated, allow ranges like 3000-3999)
            </div>
            <input
              value={portsText}
              onChange={(e) => setPortsText(e.target.value)}
              className="w-full rounded bg-gray-200 px-3 py-2 outline-none focus:ring-2 ring-night-700"
            />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5 accent-night-700"
              checked={scanAllPorts}
              onChange={(e) => setScanAllPorts(e.target.checked)}
            />
            <span>Scan all ports (slower)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5 accent-night-700"
              checked={startAtLogin}
              onChange={(e) => setStartAtLogin(e.target.checked)}
            />
            <span>Start at system login</span>
          </label>
          <div>
            <div className="text-sm text-gray-700 mb-1">On window close</div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="closeBehavior"
                  className="h-4 w-4 accent-night-700"
                  checked={closeToTray}
                  onChange={() => setCloseToTray(true)}
                />
                <span>Minimize to tray (default)</span>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

          {/* Global hotkey recorder */}
          <div className="border border-gray-300 rounded-lg p-3 bg-gray-200 text-gray-900">
            <div className="flex items-center justify-between mb-2">
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
                    onClick={() => {
                      setRecording(true);
                      setRecordedKeys([]);
                      setHotkeyError(null);
                    }}
                    className="px-3 py-1.5 rounded-full bg-gray-300 hover:bg-gray-400 text-sm text-gray-900"
                  >
                    Edit
                  </button>
                )}
                {recording && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setRecordedKeys([]);
                        setRecording(false);
                        setHotkeyError(null);
                      }}
                      className="px-3 py-1.5 rounded-full bg-gray-300 hover:bg-gray-400 text-sm text-gray-900"
                    >
                      Cancel
                    </button>
                    <button
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
                      className={`px-3 py-1.5 rounded-full text-sm ${
                        !isValidHotkey(recordedKeys)
                          ? "bg-gray-300 text-gray-600 cursor-not-allowed"
                          : "bg-night-700 text-night-100 hover:bg-night-800"
                      }`}
                    >
                      Save
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap min-h-[36px]">
              {renderKeys(
                recording
                  ? recordedKeys
                  : parseAccelerator(globalHotkey || "Ctrl+Shift+D")
              )}
              {recording && (
                <span className="text-xs text-mimi_pink-700 flex items-center gap-1 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-mimi_pink-500"></span>
                  Recording...
                </span>
              )}
            </div>
            {recording && recordedKeys.length === 0 && (
              <div className="text-xs text-gray-700 mt-2">
                Press 2-4 keys (e.g., Ctrl, Shift, D)
              </div>
            )}
            {hotkeyError && (
              <div className="text-xs text-mimi_pink-700 mt-2">
                {hotkeyError}
              </div>
            )}
          </div>

          {/* Updates */}
          <div className="border border-gray-300 rounded-lg p-3 bg-gray-200 text-gray-900 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-gray-900">
                Check for updates
              </div>
              <div className="text-xs text-gray-700">
                Manually trigger an update check
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  await window.api.checkForUpdates();
                } catch (err) {
                  console.error("Failed to check for updates:", err);
                  // Optionally show user-facing error message
                }
              }}
              className="px-3 py-1.5 rounded-full bg-gray-300 hover:bg-gray-400 text-sm text-gray-900"
            >
              Check now
            </button>
          </div>
        </div>
        <div className="flex justify-between items-center gap-2 mt-5">
          <button
            onClick={async () => {
              if (!onReset) return;
              if (window.confirm("Reset all settings to defaults?")) {
                await onReset();
              }
            }}
            className="px-3 py-1.5 rounded-full bg-mimi_pink-600/20 text-mimi_pink-800 hover:bg-mimi_pink-600/30"
          >
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-full bg-gray-200 hover:bg-gray-300"
            >
              Cancel
            </button>
            <button
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
              className="px-3 py-1.5 rounded-full bg-night-700 text-night-100 hover:bg-night-800"
            >
              Save
            </button>
          </div>
        </div>
      </div>
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
