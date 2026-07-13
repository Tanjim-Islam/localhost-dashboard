import { contextBridge, ipcRenderer, clipboard } from "electron";

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
};

type EnvironmentVariableScope = "user" | "machine";

type EnvironmentVariableRef = {
  name: string;
  scope: EnvironmentVariableScope;
};

type SaveEnvironmentVariableInput = EnvironmentVariableRef & {
  value: string;
  original?: EnvironmentVariableRef;
};

const requireEnvironmentVariableScope = (
  value: unknown,
): EnvironmentVariableScope => {
  if (value !== "user" && value !== "machine") {
    throw new Error("Environment variable scope must be user or machine.");
  }
  return value;
};

const requireEnvironmentVariableName = (value: unknown): string => {
  const name = requireString(value, "Environment variable name")
    .trim()
    .toUpperCase();
  if (name.length > 128 || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error("Environment variable name is invalid.");
  }
  return name;
};

const requireEnvironmentVariableRef = (
  value: unknown,
): EnvironmentVariableRef => {
  if (!value || typeof value !== "object") {
    throw new Error("Environment variable details are required.");
  }
  const input = value as Record<string, unknown>;
  return {
    name: requireEnvironmentVariableName(input.name),
    scope: requireEnvironmentVariableScope(input.scope),
  };
};

const requireSaveEnvironmentVariableInput = (
  value: unknown,
): SaveEnvironmentVariableInput => {
  const target = requireEnvironmentVariableRef(value);
  const input = value as Record<string, unknown>;
  if (
    typeof input.value !== "string" ||
    input.value.length === 0 ||
    input.value.length > 8192 ||
    input.value.includes("\0")
  ) {
    throw new Error("Environment variable value is invalid.");
  }
  return {
    ...target,
    value: input.value,
    ...(input.original
      ? { original: requireEnvironmentVariableRef(input.original) }
      : {}),
  };
};

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
  // Recent scripts
  getRecentScripts: () => ipcRenderer.invoke("scripts:recent:get"),
  onRecentScriptsUpdate: (cb: (items: any[]) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("scripts:recent:update", listener);
    return () => ipcRenderer.removeListener("scripts:recent:update", listener);
  },
  startRecentScript: (id: string) =>
    ipcRenderer.invoke("scripts:recent:start", requireString(id, "Script id")),
  deleteRecentScript: (id: string) =>
    ipcRenderer.invoke("scripts:recent:delete", requireString(id, "Script id")),
  killAHK: (pid: number) => ipcRenderer.send("ahk:kill", pid),
  restartAHK: (scriptPath: string) =>
    ipcRenderer.invoke("ahk:restart", scriptPath),
  editAHK: (scriptPath: string) => ipcRenderer.invoke("ahk:edit", scriptPath),
  // Automator scripts
  onAutomatorUpdate: (cb: (items: any[]) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on("automator:update", listener);
    return () => ipcRenderer.removeListener("automator:update", listener);
  },
  refreshAutomator: () => ipcRenderer.invoke("automator:refresh"),
  stopAutomator: (pid: number) => ipcRenderer.send("automator:stop", pid),
  openAutomator: (scriptPath: string) =>
    ipcRenderer.invoke("automator:open", scriptPath),
  revealAutomator: (targetPath: string) =>
    ipcRenderer.invoke("automator:reveal", targetPath),
  // Windows environment keys
  getEnvironmentKeys: () => ipcRenderer.invoke("environment:list"),
  getEnvironmentKeyValue: (input: EnvironmentVariableRef) =>
    ipcRenderer.invoke(
      "environment:get-value",
      requireEnvironmentVariableRef(input),
    ),
  saveEnvironmentKey: (input: SaveEnvironmentVariableInput) =>
    ipcRenderer.invoke(
      "environment:save",
      requireSaveEnvironmentVariableInput(input),
    ),
  deleteEnvironmentKey: (input: EnvironmentVariableRef) =>
    ipcRenderer.invoke(
      "environment:delete",
      requireEnvironmentVariableRef(input),
    ),
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
