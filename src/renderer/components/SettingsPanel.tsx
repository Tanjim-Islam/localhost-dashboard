import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import AppearanceSettings from "./AppearanceSettings";
import { useThemePreferences } from "../theme/ThemeProvider";
import type { UpdateStatus } from "../../types/preload";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { hotkeyParts, isValidHotkey, recordedAccelerator, sameHotkey } from "../../shared/hotkey";
import { AnimatedOverlay } from "./AnimatedPresence";

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
  const { preferences, resetPreferences } = useThemePreferences();
  const [appearanceBaseline, setAppearanceBaseline] = useState(preferences);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setAppearanceBaseline(preferences);
    wasOpen.current = open;
  }, [open, preferences]);
  const reduceMotion = useReducedMotion();
  const [scanIntervalMs, setScanIntervalMs] = useState(5000);
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [openInTrayAtLogin, setOpenInTrayAtLogin] = useState(true);
  const [notifyOnStart, setNotifyOnStart] = useState(true);
  const [notifyOnStop, setNotifyOnStop] = useState(true);
  const [closeToTray, setCloseToTray] = useState(true);
  const [globalHotkey, setGlobalHotkey] = useState("Ctrl+Shift+D");
  const [recordingState, setRecordingState] = useState<"idle" | "starting" | "ready">("idle");
  const recording = recordingState !== "idle";
  useEffect(() => { if (!open) setRecordingState("idle"); }, [open]);
  const [recordedHotkey, setRecordedHotkey] = useState("");
  const [saving, setSaving] = useState(false);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  useEffect(() => {
    if (!open) return;
    void window.api.getUpdateStatus().then(setUpdateStatus);
    return window.api.onUpdateStatus(setUpdateStatus);
  }, [open]);
  const supportsTrayStartup = platform === "darwin" || platform === "win32";
  const minimizedLocation = platform === "darwin" ? "background" : "tray";
  const savedHotkey = settings?.globalHotkey || "Ctrl+Shift+D";
  const editedHotkey = recording && recordedHotkey ? recordedHotkey : globalHotkey;
  const hotkeyChanged = !sameHotkey(editedHotkey, savedHotkey, platform);
  const canAcceptRecording = isValidHotkey(recordedHotkey) && !sameHotkey(recordedHotkey, globalHotkey, platform);
  const legacyNotifications = typeof settings?.notifications === "boolean"
    ? settings.notifications : true;
  const hasChanges = Boolean(settings) && (
    scanIntervalMs !== (settings.scanIntervalMs ?? 5000) ||
    startAtLogin !== Boolean(settings.startAtLogin) ||
    openInTrayAtLogin !== (settings.openInTrayAtLogin ?? true) ||
    notifyOnStart !== (settings.notifyOnStart ?? legacyNotifications) ||
    notifyOnStop !== (settings.notifyOnStop ?? legacyNotifications) ||
    closeToTray !== (settings.closeToTray ?? true) ||
    hotkeyChanged ||
    preferences.mode !== appearanceBaseline.mode ||
    preferences.lightPalette !== appearanceBaseline.lightPalette ||
    preferences.darkPalette !== appearanceBaseline.darkPalette ||
    preferences.font !== appearanceBaseline.font
  );

  const canSave = hasChanges && isValidHotkey(editedHotkey) && !saving;

  useEffect(() => {
    if (settings && open) {
      setScanIntervalMs(settings.scanIntervalMs ?? 5000);
      setStartAtLogin(Boolean(settings.startAtLogin));
      setOpenInTrayAtLogin(
        typeof settings.openInTrayAtLogin === "boolean"
          ? settings.openInTrayAtLogin
          : true,
      );
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
      setRecordedHotkey("");
      setHotkeyError(null);
    }
  }, [settings, open]);

  useEffect(() => {
    if (!recording || !open) return;
    let active = true;
    let nativeChordHeld = false;
    const session = window.api.onRecordGlobalHotkey((accelerator) => {
      nativeChordHeld = true;
      setRecordedHotkey(accelerator);
    });
    void session.ready.then(() => {
      if (active) setRecordingState("ready");
    }).catch(() => {
      if (active) {
        setRecordingState("idle");
        setHotkeyError("Could not start shortcut recording. Try again.");
      }
    });
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const accelerator = recordedAccelerator(event, platform);
      // Windows can deliver the registered chord before WebView2 delivers its modifiers.
      if (nativeChordHeld && !isValidHotkey(accelerator)) return;
      setRecordedHotkey(accelerator);
    };
    const release = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) nativeChordHeld = false;
    };
    window.addEventListener("keydown", handler, { capture: true });
    window.addEventListener("keyup", release, { capture: true });
    return () => {
      active = false;
      window.removeEventListener("keydown", handler, { capture: true });
      window.removeEventListener("keyup", release, { capture: true });
      session.stop();
    };
  }, [recording, open, platform]);

  return (
    <AnimatePresence>
    {open && <AnimatedOverlay
      key="settings"
      onClose={() => { setRecordingState("idle"); onClose(); }}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4 no-drag backdrop-blur-[2px]"
    >
      <motion.section
        initial={{ y: 8, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 8, scale: 0.98 }}
        transition={{ duration: reduceMotion ? 0 : 0.2 }}
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
                  min={2000}
                  step={1000}
                  value={scanIntervalMs}
                  onChange={(e) =>
                    setScanIntervalMs(parseInt(e.target.value || "0", 10))
                  }
                  className="w-full rounded-xl bg-gray-200 px-3 py-2 outline-none ring-night-700 focus:ring-2"
                />
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
                    <span>Minimize to {minimizedLocation}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="closeBehavior"
                      className="h-4 w-4 accent-night-700"
                      checked={!closeToTray}
                      onChange={() => setCloseToTray(false)}
                    />
                    <span>Quit</span>
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
                  <span>Notify when listener disappears</span>
                </label>
              </div>
            </section>

            <section className="settings-section p-3.5 text-gray-900">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    Global hotkey
                  </div>
                </div>
                <div className="flex gap-2">
                  {!recording && (
                    <button
                      type="button"
                      onClick={() => {
                        setRecordingState("starting");
                        setRecordedHotkey("");
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
                          setRecordedHotkey("");
                          setRecordingState("idle");
                          setHotkeyError(null);
                        }}
                        className="rounded-full bg-gray-300 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-400"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setGlobalHotkey(recordedHotkey);
                          setRecordingState("idle");
                          setHotkeyError(null);
                        }}
                        disabled={!canAcceptRecording}
                        className={`rounded-full px-3 py-1.5 text-sm ${
                          !canAcceptRecording
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
                  hotkeyParts(recording ? recordedHotkey : globalHotkey, platform),
                  platform,
                )}
                {recordingState === "ready" && (
                  <span className="flex items-center gap-1 text-xs text-danger-text animate-pulse">
                    <span className="h-2 w-2 rounded-full bg-mimi_pink-500"></span>
                    Recording...
                  </span>
                )}
              </div>
              {recordingState === "ready" && !recordedHotkey && (
                <div className="mt-2 text-xs text-gray-700">
                  Press a modifier and a key together.
                </div>
              )}
              {hotkeyError && (
                <div role="alert" className="mt-2 text-xs text-danger-text">
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
                disabled={updateStatus.state === "checking"}
                onClick={async () => {
                  try {
                    await window.api.checkForUpdates();
                  } catch (err) {
                    console.error("Failed to check for updates:", err);
                  }
                }}
                className="rounded-full bg-gray-300 px-3 py-1.5 text-sm text-gray-900 hover:bg-gray-400"
              >
                {updateStatus.state === "checking" ? "Checking..." : updateStatus.state === "not-available" ? "Up to date" : "Check now"}
              </button>
            </section>
          </div>

        </div>
          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-300 bg-gray-100 px-4 py-3">
            <button
              type="button"
              onClick={async () => {
                if (!onReset) return;
                if (window.confirm("Reset all settings to defaults?")) {
                  resetPreferences();
                  await onReset();
                }
              }}
              className="rounded-full bg-danger-surface px-3 py-1.5 text-danger-text hover:brightness-95"
            >
              Reset to defaults
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={async () => {
                if (!canSave) return;
                setSaving(true);
                setHotkeyError(null);
                try {
                  await onSave({
                    scanIntervalMs,
                    startAtLogin,
                    openInTrayAtLogin,
                    notifyOnStart,
                    notifyOnStop,
                    closeToTray,
                    ...(hotkeyChanged ? { globalHotkey: editedHotkey } : {}),
                  });
                  setRecordingState("idle");
                } catch (error) {
                  setHotkeyError(error instanceof Error ? error.message : "Could not save settings.");
                } finally {
                  setSaving(false);
                }
              }}
              className={`rounded-full px-3 py-1.5 transition-colors ${canSave
                ? "bg-night-700 text-night-100 hover:bg-night-800"
                : "cursor-not-allowed bg-gray-300 text-gray-600"}`}
            >
              Save
            </button>
          </footer>
      </motion.section>
    </AnimatedOverlay>}
    </AnimatePresence>
  );
}

function renderKeys(keys: string[], platform?: string) {
  if (!keys.length) {
    return <span className="text-sm text-gray-700">No shortcut set</span>;
  }
  return keys.map((k) => (
    <span
      key={k}
      className="px-2.5 py-1 rounded-full bg-gray-300 text-gray-900 text-xs font-semibold shadow-sm border border-gray-400"
    >
      {platform !== "darwin" && k === "Super" ? "Win" : k}
    </span>
  ));
}
