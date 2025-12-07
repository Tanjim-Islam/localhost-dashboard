import { contextBridge, ipcRenderer, clipboard } from "electron";

contextBridge.exposeInMainWorld("api", {
  // scanning
  onScanUpdate: (cb: (items: any[]) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("scanner:update", listener);
    return () => ipcRenderer.removeListener("scanner:update", listener);
  },
  onScanError: (cb: (msg: string) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("scanner:error", listener);
    return () => ipcRenderer.removeListener("scanner:error", listener);
  },
  refresh: () => ipcRenderer.invoke("scanner:refresh"),
  // actions
  openUrl: (url: string) => ipcRenderer.send("app:open-url", url),
  killPid: (pid: number) => ipcRenderer.send("app:kill-pid", pid),
  killAllServers: () => ipcRenderer.invoke("app:kill-all-servers"),
  copyText: (text: string) => clipboard.writeText(text),
  openInVSCode: (payload: any) =>
    ipcRenderer.invoke("app:open-vscode", payload),
  openTerminal: (path: string) => ipcRenderer.invoke("app:open-terminal", path),
  openExplorer: (path: string) => ipcRenderer.send("app:open-explorer", path),
  // settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (partial: any) =>
    ipcRenderer.invoke("settings:update", partial),
  resetSettings: () => ipcRenderer.invoke("settings:reset"),
  onSettingsUpdate: (cb: (s: any) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("settings:update", listener);
    return () => ipcRenderer.removeListener("settings:update", listener);
  },
  getStats: () => ipcRenderer.invoke("stats:get"),
  onStatsUpdate: (cb: (s: any) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("stats:update", listener);
    return () => ipcRenderer.removeListener("stats:update", listener);
  },
  // AHK scripts
  onAHKUpdate: (cb: (items: any[]) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("ahk:update", listener);
    return () => ipcRenderer.removeListener("ahk:update", listener);
  },
  // Health checks
  onHealthUpdate: (cb: (results: any[]) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("health:update", listener);
    return () => ipcRenderer.removeListener("health:update", listener);
  },
  // Port notes
  getNote: (port: number | string) => ipcRenderer.invoke("notes:get", port),
  setNote: (port: number | string, note: string) =>
    ipcRenderer.invoke("notes:set", port, note),
  getAllNotes: () => ipcRenderer.invoke("notes:all"),
  killAHK: (pid: number) => ipcRenderer.send("ahk:kill", pid),
  restartAHK: (scriptPath: string) =>
    ipcRenderer.invoke("ahk:restart", scriptPath),
  editAHK: (scriptPath: string) => ipcRenderer.invoke("ahk:edit", scriptPath),
  // UI events from main
  onToggleSettings: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("ui:toggle-settings", listener);
    return () => ipcRenderer.removeListener("ui:toggle-settings", listener);
  },
  // meta
  getMeta: () => ipcRenderer.invoke("app:get-meta"),
  // auto-updater
  onUpdateStatus: (cb: (status: any) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("updater:status", listener);
    return () => ipcRenderer.removeListener("updater:status", listener);
  },
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  getUpdateStatus: () => ipcRenderer.invoke("updater:get-status"),
  dismissUpdate: () => ipcRenderer.invoke("updater:dismiss"),
});
// window controls
contextBridge.exposeInMainWorld("windowControls", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
});
