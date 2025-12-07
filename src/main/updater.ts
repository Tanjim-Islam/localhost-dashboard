/**
 * Auto-updater module for Localhost Dashboard
 * Uses electron-updater to check for and apply updates from GitHub Releases
 */

import {
  autoUpdater,
  type UpdateInfo,
  type ProgressInfo,
} from "electron-updater";
import { BrowserWindow, ipcMain } from "electron";

// Disable auto-download - we want user control
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | {
      state: "downloading";
      percent: number;
      transferred: number;
      total: number;
    }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

let mainWindow: BrowserWindow | null = null;
let currentStatus: UpdateStatus = { state: "idle" };

function sendStatusToRenderer() {
  mainWindow?.webContents.send("updater:status", currentStatus);
}

function setStatus(status: UpdateStatus) {
  currentStatus = status;
  sendStatusToRenderer();
}

const handleCheckingForUpdate = () => {
  setStatus({ state: "checking" });
};

const handleUpdateAvailable = (info: UpdateInfo) => {
  setStatus({
    state: "available",
    version: info.version,
    releaseNotes:
      typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
  });
};

const handleUpdateNotAvailable = (info: UpdateInfo) => {
  setStatus({
    state: "not-available",
    version: info.version,
  });
  // Reset to idle after a few seconds
  setTimeout(() => setStatus({ state: "idle" }), 3000);
};

const handleDownloadProgress = (progress: ProgressInfo) => {
  setStatus({
    state: "downloading",
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
  });
};

const handleUpdateDownloaded = (info: UpdateInfo) => {
  setStatus({
    state: "downloaded",
    version: info.version,
  });
};

const handleUpdateError = (err: Error) => {
  setStatus({
    state: "error",
    message: err.message || "Unknown error occurred",
  });
  // Reset to idle after a few seconds
  setTimeout(() => setStatus({ state: "idle" }), 5000);
};

export function initUpdater(win: BrowserWindow, isPackaged: boolean = true) {
  mainWindow = win;

  // Register IPC handlers (always, even in dev mode to prevent errors)
  registerIpcHandlers(isPackaged);

  // Only set up auto-updater events in packaged mode
  if (!isPackaged) return;

  // If an update flow is already in progress, avoid re-initializing listeners
  if (
    currentStatus.state === "checking" ||
    currentStatus.state === "downloading" ||
    currentStatus.state === "downloaded"
  ) {
    return;
  }

  // Avoid duplicate listeners when initUpdater is called multiple times
  autoUpdater.removeListener("checking-for-update", handleCheckingForUpdate);
  autoUpdater.removeListener("update-available", handleUpdateAvailable);
  autoUpdater.removeListener("update-not-available", handleUpdateNotAvailable);
  autoUpdater.removeListener("download-progress", handleDownloadProgress);
  autoUpdater.removeListener("update-downloaded", handleUpdateDownloaded);
  autoUpdater.removeListener("error", handleUpdateError);

  // Event: Checking for update
  autoUpdater.on("checking-for-update", handleCheckingForUpdate);

  // Event: Update available
  autoUpdater.on("update-available", handleUpdateAvailable);

  // Event: No update available
  autoUpdater.on("update-not-available", handleUpdateNotAvailable);

  // Event: Download progress
  autoUpdater.on("download-progress", handleDownloadProgress);

  // Event: Update downloaded
  autoUpdater.on("update-downloaded", handleUpdateDownloaded);

  // Event: Error
  autoUpdater.on("error", handleUpdateError);

  // Check for updates on startup (after a short delay to let the app initialize)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silently fail on startup check
    });
  }, 5000);
}

function registerIpcHandlers(isPackaged: boolean) {
  // Remove existing handlers to avoid duplicate registrations when re-initializing
  const channels = [
    "updater:check",
    "updater:download",
    "updater:install",
    "updater:get-status",
    "updater:dismiss",
  ];
  channels.forEach((channel) => ipcMain.removeHandler(channel));

  // IPC: Check for updates
  ipcMain.handle("updater:check", async () => {
    if (!isPackaged) {
      // In dev mode, just show a message
      setStatus({ state: "not-available", version: "dev" });
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err: any) {
      setStatus({
        state: "error",
        message: err.message || "Failed to check for updates",
      });
    }
  });

  // IPC: Download update
  ipcMain.handle("updater:download", async () => {
    if (!isPackaged) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err: any) {
      setStatus({
        state: "error",
        message: err.message || "Failed to download update",
      });
    }
  });

  // IPC: Install update (quit and install)
  ipcMain.handle("updater:install", () => {
    if (!isPackaged) {
      return {
        success: false,
        error: "Updates can only be installed in packaged builds",
      };
    }
    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (err: any) {
      const message = err?.message || "Failed to install update";
      setStatus({ state: "error", message });
      autoUpdater.logger?.error?.(
        `quitAndInstall failed: ${message} ${
          err?.stack ? `| ${err.stack}` : ""
        }`.trim()
      );
      return { success: false, error: message };
    }
  });

  // IPC: Get current status
  ipcMain.handle("updater:get-status", () => currentStatus);

  // IPC: Dismiss update notification
  ipcMain.handle("updater:dismiss", () => {
    setStatus({ state: "idle" });
  });
}

export function checkForUpdates() {
  return autoUpdater.checkForUpdates();
}
