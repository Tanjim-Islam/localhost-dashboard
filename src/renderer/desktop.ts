import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Api } from "../types/preload";
import { applyStoredThemePreferences } from "./theme/themeRuntime";

function request<T>(method: string, arg: unknown = null): Promise<T> {
  return invoke<T>("dashboard", { method, arg }).catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

function subscribe<T>(
  event: string,
  callback: (payload: T) => void,
): () => void {
  let active = true;
  const ready = listen<T>(event, ({ payload }) => {
    if (active) callback(payload);
  });
  return () => {
    active = false;
    void ready.then((unlisten) => unlisten());
  };
}

window.api = {
  getServers: () => request("getServers"),
  openProjectFolder: (value) => request("openProjectFolder", value),
  getProjects: () => request("getProjects"),
  editProject: (value) => request("editProject", value),
  associateService: (value) => request("associateService", value),
  attachLegacyNote: (value) => request("attachLegacyNote", value),
  onProjectsUpdate: (cb) => subscribe("onProjectsUpdate", cb),
  stopServers: (value) => request("stopServers", value),
  startServers: (value) => request("startServers", value),
  onScanUpdate: (cb) => subscribe("onScanUpdate", cb),
  onScanError: (cb) => subscribe("onScanError", cb),
  refresh: () => request("refresh"),
  openUrl: (value) => request("openUrl", value),
  restartServer: (value) => request("restartServer", value),
  getServerRestartState: () => request("getServerRestartState"),
  onServerRestartProgress: (cb) => subscribe("onServerRestartProgress", cb),
  copyText: (value) => request("copyText", value),
  openInVSCode: (value) => request("openInVSCode", value),
  openTerminal: (value) => request("openTerminal", value),
  openExplorer: (value) => request("openExplorer", value),
  getSettings: () => request("getSettings"),
  updateSettings: (value) => request("updateSettings", value),
  resetSettings: () => request("resetSettings"),
  onSettingsUpdate: (cb) => subscribe("onSettingsUpdate", cb),
  getStats: () => request("getStats"),
  onStatsUpdate: (cb) => subscribe("onStatsUpdate", cb),
  onHealthUpdate: (cb) => subscribe("onHealthUpdate", cb),
  getRecentScripts: () => request("getRecentScripts"),
  onRecentScriptsUpdate: (cb) => subscribe("onRecentScriptsUpdate", cb),
  startRecentScript: (value) => request("startRecentScript", value),
  deleteRecentScript: (value) => request("deleteRecentScript", value),
  onAHKUpdate: (cb) => subscribe("onAHKUpdate", cb),
  killAHK: (value) => request("killAHK", value),
  restartAHK: (value) => request("restartAHK", value),
  editAHK: (value) => request("editAHK", value),
  onAutomatorUpdate: (cb) => subscribe("onAutomatorUpdate", cb),
  refreshAutomator: () => request("refreshAutomator"),
  stopAutomator: (value) => request("stopAutomator", value),
  openAutomator: (value) => request("openAutomator", value),
  revealAutomator: (value) => request("revealAutomator", value),
  getEnvironmentKeys: () => request("getEnvironmentKeys"),
  getEnvironmentKeyValue: (value) => request("getEnvironmentKeyValue", value),
  saveEnvironmentKey: (value) => request("saveEnvironmentKey", value),
  deleteEnvironmentKey: (value) => request("deleteEnvironmentKey", value),
  getCliInventory: () => request("getCliInventory"),
  getCliScanDirectories: () => request("getCliScanDirectories"),
  chooseCliScanDirectory: () => request("chooseCliScanDirectory"),
  removeCliScanDirectory: (value) => request("removeCliScanDirectory", value),
  startCliScan: () => request("startCliScan"),
  cancelCliScan: (value) => request("cancelCliScan", value),
  getCliScanState: () => request("getCliScanState"),
  verifyCliInstallation: (value) => request("verifyCliInstallation", value),
  setCliInstallationIncluded: (value) =>
    request("setCliInstallationIncluded", value),
  revealCliInstallation: (value) => request("revealCliInstallation", value),
  getCliUninstallPreview: (value) => request("getCliUninstallPreview", value),
  uninstallCliInstallation: (value) =>
    request("uninstallCliInstallation", value),
  onCliScanProgress: (cb) => subscribe("onCliScanProgress", cb),
  onCliScanComplete: (cb) => subscribe("onCliScanComplete", cb),
  onCliScanError: (cb) => subscribe("onCliScanError", cb),
  onCliInventoryChanged: (cb) => subscribe("onCliInventoryChanged", cb),
  onCliUninstallProgress: (cb) => subscribe("onCliUninstallProgress", cb),
  onCliUninstallComplete: (cb) => subscribe("onCliUninstallComplete", cb),
  onToggleSettings: (cb) => subscribe("onToggleSettings", cb),
  getMeta: () => request("getMeta"),
  onUpdateStatus: (cb) => subscribe("onUpdateStatus", cb),
  checkForUpdates: () => request("checkForUpdates"),
  downloadUpdate: () => request("downloadUpdate"),
  installUpdate: () => request("installUpdate"),
  getUpdateStatus: () => request("getUpdateStatus"),
  dismissUpdate: () => request("dismissUpdate"),
} satisfies Api;

const desktop = getCurrentWindow();
window.windowControls = {
  minimize: () => void desktop.minimize(),
  maximize: () => void desktop.toggleMaximize(),
  close: () => void desktop.close(),
};

document.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const target = event.target;
  if (
    !target.closest(".title-bar") ||
    target.closest(
      "button, input, a, textarea, [data-nodrag=true], [style*='no-drag']",
    )
  )
    return;
  if (event.detail === 1) void desktop.startDragging();
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "F5" ||
    ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")
  ) {
    event.preventDefault();
    void window.api.refresh();
  } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
    event.preventDefault();
    void request("toggleSettings");
  }
});

async function start() {
  if (!localStorage.getItem("dashboard:nativePreferencesImported")) {
    try {
      const legacy = await request<Record<string, string>>(
        "getRendererPreferences",
      );
      for (const [key, value] of Object.entries(legacy)) {
        if (localStorage.getItem(key) === null)
          localStorage.setItem(key, value);
      }
      localStorage.setItem("dashboard:nativePreferencesImported", "1");
    } catch {
      // Old Chromium data may be locked or damaged. Retry on the next launch.
      console.warn(
        "Could not import the previous dashboard display preferences.",
      );
    }
  }
  applyStoredThemePreferences();
  await import("./main");
}
void start();
