/**
 * Auto-updater module for Localhost Dashboard
 * Uses electron-updater to check for and apply updates from GitHub Releases
 */

import { autoUpdater, type UpdateInfo, type ProgressInfo } from "electron-updater";
import { BrowserWindow, ipcMain } from "electron";

// Disable auto-download - we want user control
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; transferred: number; total: number }
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

export function initUpdater(win: BrowserWindow, isPackaged: boolean = true) {
  mainWindow = win;

  // Register IPC handlers (always, even in dev mode to prevent errors)
  registerIpcHandlers(isPackaged);

  // Only set up auto-updater events in packaged mode
  if (!isPackaged) return;

  // Event: Checking for update
  autoUpdater.on("checking-for-update", () => {
    setStatus({ state: "checking" });
  });

  // Event: Update available
  autoUpdater.on("update-available", (info: UpdateInfo) => {
    setStatus({
      state: "available",
      version: info.version,
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
    });
  });

  // Event: No update available
  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    setStatus({
      state: "not-available",
      version: info.version,
    });
    // Reset to idle after a few seconds
    setTimeout(() => setStatus({ state: "idle" }), 3000);
  });

  // Event: Download progress
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    setStatus({
      state: "downloading",
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  // Event: Update downloaded
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    setStatus({
      state: "downloaded",
      version: info.version,
    });
  });

  // Event: Error
  autoUpdater.on("error", (err: Error) => {
    setStatus({
      state: "error",
      message: err.message || "Unknown error occurred",
    });
    // Reset to idle after a few seconds
    setTimeout(() => setStatus({ state: "idle" }), 5000);
  });

  // Check for updates on startup (after a short delay to let the app initialize)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Silently fail on startup check
    });
  }, 5000);
}

function registerIpcHandlers(isPackaged: boolean) {
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
      setStatus({ state: "error", message: err.message || "Failed to check for updates" });
    }
  });

  // IPC: Download update
  ipcMain.handle("updater:download", async () => {
    if (!isPackaged) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err: any) {
      setStatus({ state: "error", message: err.message || "Failed to download update" });
    }
  });

  // IPC: Install update (quit and install)
  ipcMain.handle("updater:install", () => {
    if (!isPackaged) return;
    autoUpdater.quitAndInstall(false, true);
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

