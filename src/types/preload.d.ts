// Global typings for the preload-exposed APIs. Keep in sync with src/preload/index.ts

export type ServerInfo = import("../shared/servers").ServerInfo;

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

export type RecentScriptType = "ahk" | "automator";

export type RecentScriptInfo = {
  id: string;
  type: RecentScriptType;
  scriptPath: string;
  scriptName: string;
  firstSeen: number;
  lastUsed: number;
  useCount: number;
};

export type PlatformFeatures = {
  servers: true;
  ahkScripts: boolean;
  automatorScripts: boolean;
  environmentKeys: boolean;
  clis: boolean;
};

export type CliInventorySnapshot =
  import("../main/clis/types").CliInventorySnapshot;
export type CliScanSession = import("../main/clis/types").CliScanSession;
export type CliScanProgress = import("../main/clis/types").CliScanProgress;
export type CliInstallationRef =
  import("../main/clis/types").CliInstallationRef;
export type CliUninstallPreview =
  import("../main/clis/types").CliUninstallPreview;
export type CliUninstallRequest =
  import("../main/clis/types").CliUninstallRequest;
export type CliUninstallProgress =
  import("../main/clis/types").CliUninstallProgress;
export type CliUninstallResult =
  import("../main/clis/types").CliUninstallResult;

export type EnvironmentVariableScope = "user" | "machine";

export type EnvironmentVariableSummary = {
  id: string;
  name: string;
  scope: EnvironmentVariableScope;
  valueLength: number;
  sessionStatus: "active" | "restart-required" | "shadowed";
};

export type EnvironmentVariableRef = {
  name: string;
  scope: EnvironmentVariableScope;
};

export type SaveEnvironmentVariableInput = EnvironmentVariableRef & {
  value: string;
  original?: EnvironmentVariableRef;
};

export type AutomatorScriptInfo = {
  key: string;
  pid?: number;
  ppid?: number;
  processName?: string;
  scriptName: string;
  sourceKind:
    | "service-workflow"
    | "service-script"
    | "workflow-service-runner"
    | "automator-runner"
    | "automator-app"
    | "workflow"
    | "osascript";
  sourceLabel: string;
  status: "running" | "installed";
  firstSeen: number;
  lastSeen: number;
  command?: string;
  scriptPath?: string;
  processPath?: string;
  runtimeSeconds?: number;
  canOpenInAutomator: boolean;
  cpu?: number;
  memory?: number;
};

export type HealthStatus = {
  key: string;
  firstSeen?: number;
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
  | {
      state: "downloading";
      percent: number;
      transferred: number;
      total: number;
    }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export type AppSettings = {
  scanIntervalMs: number;
  ports: (number | [number, number])[];
  startAtLogin: boolean;
  openInTrayAtLogin: boolean;
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

export interface Api {
  getServers(): Promise<ServerInfo[]>;
  openProjectFolder(directory: string): Promise<void>;
  getProjects(): Promise<import("../shared/servers").ProjectSnapshot>;
  addProject(): Promise<import("../shared/servers").ProjectSnapshot>;
  editProject(value: import("../shared/servers").ProjectEdit): Promise<import("../shared/servers").ProjectSnapshot>;
  associateService(value: import("../shared/servers").AssociationEdit): Promise<import("../shared/servers").ProjectSnapshot>;
  attachLegacyNote(value: { noteId: string; projectId: string }): Promise<import("../shared/servers").ProjectSnapshot>;
  onProjectsUpdate(cb: (snapshot: import("../shared/servers").ProjectSnapshot) => void): () => void;
  previewStopServers(value: import("../shared/servers").StopScope): Promise<import("../shared/servers").StopPreview>;
  stopServers(token: string): Promise<import("../shared/servers").StopResult[]>;
  // scanning
  onScanUpdate(cb: (items: ServerInfo[]) => void): () => void;
  onScanError(cb: (msg: string) => void): () => void;
  refresh(): Promise<void>;

  // actions
  openUrl(url: string): void;
  restartServer(ref: { key: string; firstSeen: number }): Promise<import("../main/server-restart/types").RestartResult>;
  getServerRestartState(): Promise<import("../main/server-restart/types").RestartProgress | null>;
  onServerRestartProgress(cb: (state: import("../main/server-restart/types").RestartProgress) => void): () => void;
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


  // recent scripts
  getRecentScripts(): Promise<RecentScriptInfo[]>;
  onRecentScriptsUpdate(cb: (items: RecentScriptInfo[]) => void): () => void;
  startRecentScript(id: string): Promise<RecentScriptInfo[]>;
  deleteRecentScript(id: string): Promise<RecentScriptInfo[]>;

  // AHK scripts
  onAHKUpdate(cb: (items: AHKScriptInfo[]) => void): () => void;
  killAHK(pid: number): void;
  restartAHK(scriptPath: string): Promise<void>;
  editAHK(scriptPath: string): Promise<void>;

  // Automator scripts
  onAutomatorUpdate(cb: (items: AutomatorScriptInfo[]) => void): () => void;
  refreshAutomator(): Promise<void>;
  stopAutomator(pid: number): void;
  openAutomator(scriptPath: string): Promise<void>;
  revealAutomator(targetPath: string): Promise<void>;

  // Windows environment keys
  getEnvironmentKeys(): Promise<EnvironmentVariableSummary[]>;
  getEnvironmentKeyValue(input: EnvironmentVariableRef): Promise<string>;
  saveEnvironmentKey(
    input: SaveEnvironmentVariableInput,
  ): Promise<EnvironmentVariableSummary[]>;
  deleteEnvironmentKey(
    input: EnvironmentVariableRef,
  ): Promise<EnvironmentVariableSummary[]>;

  // Windows and macOS CLIs
  getCliInventory(): Promise<CliInventorySnapshot | null>;
  getCliScanDirectories(): Promise<Array<{ id: string; path: string }>>;
  chooseCliScanDirectory(): Promise<Array<{ id: string; path: string }>>;
  removeCliScanDirectory(
    id: string,
  ): Promise<Array<{ id: string; path: string }>>;
  startCliScan(): Promise<CliScanSession>;
  cancelCliScan(scanSessionId: string): Promise<CliScanSession>;
  getCliScanState(): Promise<CliScanSession>;
  verifyCliInstallation(
    input: CliInstallationRef,
  ): Promise<CliInventorySnapshot>;
  setCliInstallationIncluded(
    input: CliInstallationRef & { included: boolean },
  ): Promise<CliInventorySnapshot>;
  revealCliInstallation(input: CliInstallationRef): Promise<void>;
  getCliUninstallPreview(
    input: CliInstallationRef,
  ): Promise<CliUninstallPreview>;
  uninstallCliInstallation(
    input: CliUninstallRequest,
  ): Promise<CliUninstallResult>;
  onCliScanProgress(cb: (payload: CliScanProgress) => void): () => void;
  onCliScanComplete(cb: (payload: CliInventorySnapshot) => void): () => void;
  onCliScanError(
    cb: (payload: {
      scanSessionId?: string;
      status: "failed" | "cancelled";
      message: string;
    }) => void,
  ): () => void;
  onCliInventoryChanged(
    cb: (payload: CliInventorySnapshot) => void,
  ): () => void;
  onCliUninstallProgress(
    cb: (payload: CliUninstallProgress) => void,
  ): () => void;
  onCliUninstallComplete(cb: (payload: CliUninstallResult) => void): () => void;

  // meta / ui
  onToggleSettings(cb: () => void): () => void;
  getMeta(): Promise<{
    version: string;
    platform: string;
    arch: string;
    features: PlatformFeatures;
    clisTestMode: boolean;
  }>;

  // auto-updater
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<{ success: boolean; error?: string }>;
  getUpdateStatus(): Promise<UpdateStatus>;
  dismissUpdate(): Promise<void>;
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
