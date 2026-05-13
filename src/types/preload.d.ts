// Global typings for the preload-exposed APIs. Keep in sync with src/preload/index.ts

export type ServerInfo = {
  key: string;
  pid: number;
  port: number;
  protocol?: "tcp" | "udp";
  processName?: string;
  command?: string;
  path?: string;
  cwd?: string;
  firstSeen: number;
  lastSeen: number;
  url: string;
  cpu?: number;
  memory?: number;
  framework?: string;
  cpuHistory?: number[];
  memoryHistory?: number[];
};

export type AHKScriptInfo = {
  key: string; // pid as string
  pid: number;
  processName: string;
  scriptPath?: string;
  scriptName?: string;
  firstSeen: number;
  lastSeen: number;
  cpu?: number;
  memory?: number;
};

export type HealthStatus = {
  key: string;
  url: string;
  status: "healthy" | "slow" | "down";
  responseTime?: number;
  lastChecked: number;
  error?: string;
};

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; transferred: number; total: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export type AppSettings = {
  scanIntervalMs: number;
  ports: (number | [number, number])[];
  startAtLogin: boolean;
  notifyOnStart: boolean;
  notifyOnStop: boolean;
  scanAllPorts: boolean;
  closeToTray: boolean;
  // legacy retained only for migration
  notifications?: boolean;
  globalHotkey: string;
};

export type RendererSettings = AppSettings & { portsText?: string };

export interface StatsPayload {
  portCounts: Record<string, number>;
}

// ===== Global Shortcuts (Windows-only feature) =====

export type ShortcutSourceType =
  | "this-app"
  | "windows-reserved"
  | "lnk"
  | "ahk"
  | "cache"
  | "probe";

export type ShortcutStatus =
  | "active"
  | "taken"
  | "available"
  | "previously-seen"
  | "now-free"
  | "reserved"
  | "used-by-app"
  | "unknown-owner"
  | "invalid";

export interface ShortcutRecord {
  shortcut: string; // human display, e.g. "Ctrl + Shift + K"
  accelerator: string; // normalized Electron accelerator, e.g. "CommandOrControl+Shift+K"
  sourceType: ShortcutSourceType;
  sourceName?: string;
  sourcePath?: string;
  status: ShortcutStatus;
  firstSeen: number;
  lastSeen: number;
  lastChecked: number;
  ownerKnown: boolean;
  confidence: "low" | "medium" | "high";
}

export interface ShortcutCheckResult {
  shortcut: string;
  accelerator: string;
  status: ShortcutStatus;
  source?: {
    type: ShortcutSourceType;
    name?: string;
    path?: string;
  };
  reason?: string;
}

export interface RecommendationEntry {
  shortcut: string;
  accelerator: string;
  reason: string;
  previouslySeen: boolean;
  includesWin: boolean;
}

export interface GlobalShortcutsSnapshot {
  platform: NodeJS.Platform | string;
  supported: boolean;
  records: ShortcutRecord[];
}

export interface Api {
  // scanning
  onScanUpdate(cb: (items: ServerInfo[]) => void): () => void;
  onScanError(cb: (msg: string) => void): () => void;
  refresh(): Promise<void>;

  // actions
  openUrl(url: string): void;
  killPid(pid: number): void;
  killAllServers(): Promise<number>;
  copyText(text: string): void;
  openInVSCode(payload: any): Promise<void>;
  openTerminal(path: string): Promise<void>;
  openExplorer(path: string): void;

  // settings
  getSettings(): Promise<RendererSettings>;
  updateSettings(partial: Partial<RendererSettings>): Promise<RendererSettings>;
  resetSettings(): Promise<RendererSettings>;
  onSettingsUpdate(cb: (s: RendererSettings) => void): () => void;

  // stats
  getStats(): Promise<StatsPayload>;
  onStatsUpdate(cb: (s: StatsPayload) => void): () => void;

  // health checks
  onHealthUpdate(cb: (results: HealthStatus[]) => void): () => void;

  // port notes
  getNote(port: number | string): Promise<string>;
  setNote(port: number | string, note: string): Promise<Record<string, string>>;
  getAllNotes(): Promise<Record<string, string>>;

  // AHK scripts
  onAHKUpdate(cb: (items: AHKScriptInfo[]) => void): () => void;
  killAHK(pid: number): void;
  restartAHK(scriptPath: string): Promise<void>;
  editAHK(scriptPath: string): Promise<void>;

  // meta / ui
  onToggleSettings(cb: () => void): () => void;
  getMeta(): Promise<{ version: string; platform: string; arch: string }>;

  // auto-updater
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<{ success: boolean; error?: string }>;
  getUpdateStatus(): Promise<UpdateStatus>;
  dismissUpdate(): Promise<void>;

  // global shortcuts (Windows-only)
  getGlobalShortcuts(): Promise<GlobalShortcutsSnapshot>;
  refreshGlobalShortcuts(): Promise<GlobalShortcutsSnapshot>;
  checkGlobalShortcut(accelerator: string): Promise<ShortcutCheckResult>;
  recommendGlobalShortcuts(payload: {
    keyCount: number;
  }): Promise<RecommendationEntry[]>;
  onGlobalShortcutsUpdate(
    cb: (records: ShortcutRecord[]) => void
  ): () => void;
}

declare global {
  interface Window {
    api: Api;
    windowControls: {
      minimize(): void;
      maximize(): void;
      close(): void;
    };
  }
}
