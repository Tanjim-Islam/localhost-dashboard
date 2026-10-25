import {
  app,
  dialog,
  BrowserWindow,
  nativeTheme,
  Menu,
  Tray,
  ipcMain,
  shell,
  Notification,
  nativeImage,
  globalShortcut,
  type NativeImage,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import { Scanner } from "./scanner";
import { createRestartDependencies, ServerRestartController } from "./server-restart/controller";
import { AHKScanner } from "./ahk-scanner";
import { AutomatorScanner } from "./automator-scanner";
import { HealthChecker } from "./health-checker";
import { initUpdater } from "./updater";
import {
  getElectronLoginItemSettings,
  shouldManageSystemLoginItem,
  shouldSynchronizeSystemLoginItemAtLaunch,
  shouldStartInTray,
} from "./startup-visibility";
import { bumpPort, stats as statsStore } from "./stats";
import { createProjectStore } from "./projects/store";
import { registerProjectIpc } from "./projects/ipc";
import { ServerStopController } from "./projects/stop-controller";
import { NativeProcessHost } from "./server-restart/native-host";
import { readListeners } from "./server-restart/listeners";
import type { ServerInfo } from "../shared/servers";
import { getPlatformFeatures } from "./platform-features";
import {
  deleteEnvironmentVariable,
  getEnvironmentVariableValue,
  listEnvironmentVariables,
  saveEnvironmentVariable,
} from "./environment-variables";
import {
  APP_DISPLAY_NAME,
  getRendererLoadMode,
  shouldEnableAutoUpdater,
  shouldCreateTrayIcon,
  shouldShowDockForWindowState,
} from "./app-identity";
import {
  deleteRecentScript,
  getPlatformRecentScriptType,
  getRecentScriptById,
  getRecentScripts,
  rememberRecentScript,
  type RecentScriptInfo,
} from "./recent-scripts";
import {
  settings,
  portsToString,
  migrateLegacyNotifications,
  applyPlatformSettingsDefaults,
  seedDefaultsIfNeeded,
  resetToDefaults,
} from "./settings";
import AutoLaunch from "auto-launch";
import { openProjectTerminal } from "./project-terminal";
import { createCliController, type CliController } from "./clis";
import {
  validateCliInstallationRef,
  validateCliInclusionRequest,
  validateCliSessionId,
  validateCliUninstallRequest,
} from "./clis/ipc-validation";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let autolaunch: AutoLaunch | null = null;
let currentGlobalHotkey: string | null = null;
let cliController: CliController | null = null;
const serverResourceDir = app.isPackaged ? path.join(process.resourcesPath, "server-restart") : path.join(app.getAppPath(), "resources/server-restart");
const projectStore = createProjectStore();
const scanner = new Scanner(serverResourceDir, (item, evidence, key) => projectStore.model.decorate(item, evidence, key), projectStore.model.state.lastObserved);
const serverRestarter = new ServerRestartController(createRestartDependencies(
  app.isPackaged
    ? path.join(process.resourcesPath, "server-restart")
    : path.join(app.getAppPath(), "resources/server-restart"),
  {
    getServer: (ref) => scanner.getItems().find((item) => item.key === ref.key && item.firstSeen === ref.firstSeen && item.discovery === "development" && item.canStop && !item.ignored),
    progress: (state) => {
      win?.webContents.send("servers:restart-progress", state);
    },
    completed: async (_oldPids, replacement) => {
      // Two successful observations retire vanished listeners without deleting a reused PID.
      await scanner.scanFresh();
      await scanner.scanFresh();
      for (const item of scanner.getItems()) {
        if (replacement?.some(p => p.pid === item.pid && new Date(p.startedMs).toISOString() === item.processStarted)) projectStore.model.restarted(item);
      }
      projectStore.flush();
      win?.webContents.send("projects:update", projectStore.model.snapshot());
    },
  },
));
const serverStopper = new ServerStopController({
  items: () => scanner.getItems(), identity: pid => scanner.getInspection(pid)?.identity,
  projectName: id => projectStore.model.state.projects.find(p => p.id === id)?.name,
  createHost: () => {
    const host = new NativeProcessHost(serverResourceDir);
    return { snapshot: (pid) => host.snapshot(pid), stop: (targets) => host.stop(targets, true), dispose: () => host.dispose() };
  }, listeners: readListeners,
  ownPid: process.pid, restartBusy: () => serverRestarter.isBusy(),
  refresh: async (refs) => { scanner.confirmStopped(refs); projectStore.flush(); },
  now: Date.now, pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
});
registerProjectIpc(() => win, projectStore.model, scanner, serverStopper, projectStore.flush);
const healthChecker = new HealthChecker();
let isQuitting = false;

const isMac = process.platform === "darwin";
const platformFeatures = getPlatformFeatures(process.platform);
const ahkScanner = platformFeatures.ahkScripts ? new AHKScanner() : null;
const automatorScanner = platformFeatures.automatorScripts
  ? new AutomatorScanner()
  : null;

function requireCliController(): CliController {
  if (!platformFeatures.clis) {
    throw new Error("CLIs are available only on Windows and macOS.");
  }
  if (!cliController) throw new Error("CLI inventory is not ready yet.");
  return cliController;
}

async function initializeClis(): Promise<void> {
  if (!platformFeatures.clis) return;
  const created = await createCliController();
  cliController = created.controller;
  cliController.on("scan-progress", (payload) => {
    win?.webContents.send("clis:scan-progress", payload);
  });
  cliController.on("scan-complete", (payload) => {
    win?.webContents.send("clis:scan-complete", payload);
  });
  cliController.on("scan-error", (payload) => {
    win?.webContents.send("clis:scan-error", payload);
  });
  cliController.on("inventory-changed", (payload) => {
    win?.webContents.send("clis:inventory-changed", payload);
  });
  cliController.on("uninstall-progress", (payload) => {
    win?.webContents.send("clis:uninstall-progress", payload);
  });
  cliController.on("uninstall-complete", (payload) => {
    win?.webContents.send("clis:uninstall-complete", payload);
  });
}

app.setName(APP_DISPLAY_NAME);

const ahkExecutablePaths = [
  "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe",
  "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe",
  "C:\\Program Files\\AutoHotkey\\AutoHotkey.exe",
  "C:\\Program Files (x86)\\AutoHotkey\\AutoHotkey.exe",
];

function getPlatformRecentScripts(): RecentScriptInfo[] {
  const type = getPlatformRecentScriptType();
  return type ? getRecentScripts(type) : [];
}

function sendRecentScriptsUpdate() {
  win?.webContents.send("scripts:recent:update", getPlatformRecentScripts());
}

function ensureScriptFile(scriptPath: string, extensions: string[]) {
  const ext = path.extname(scriptPath).toLowerCase();
  if (!extensions.includes(ext)) {
    throw new Error("Unsupported script file type.");
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error("Script file was not found.");
  }
}

function spawnDetached(command: string, args: string[], windowsHide = false) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide,
  });
  child.on("error", (err) => {
    console.error(`Failed to start ${command}:`, err);
  });
  child.unref();
}

async function resolveAutoHotkeyExecutable(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("where", ["AutoHotkey"]);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) return lines[0];
  } catch {
    // Fall through to known install paths.
  }

  const knownPath = ahkExecutablePaths.find((candidate) =>
    fs.existsSync(candidate),
  );
  return knownPath || "AutoHotkey";
}

async function startAHKScript(scriptPath: string) {
  if (process.platform !== "win32") {
    throw new Error("AutoHotkey scripts can only be started on Windows.");
  }

  ensureScriptFile(scriptPath, [".ahk"]);
  const ahkExe = await resolveAutoHotkeyExecutable();
  spawnDetached(ahkExe, [scriptPath], true);
  rememberRecentScript("ahk", scriptPath);
  sendRecentScriptsUpdate();
}

async function startAutomatorScript(scriptPath: string) {
  if (process.platform !== "darwin") {
    throw new Error("Automator scripts can only be started on macOS.");
  }

  ensureScriptFile(scriptPath, [".workflow", ".app", ".scpt"]);
  const ext = path.extname(scriptPath).toLowerCase();
  const command =
    ext === ".workflow" ? "automator" : ext === ".scpt" ? "osascript" : "open";
  spawnDetached(command, [scriptPath]);
  rememberRecentScript("automator", scriptPath);
  sendRecentScriptsUpdate();
}

async function startRecentScript(id: string) {
  const script = getRecentScriptById(id);
  if (!script) {
    throw new Error("Recent script was not found.");
  }

  if (script.type === "ahk") {
    await startAHKScript(script.scriptPath);
  } else {
    await startAutomatorScript(script.scriptPath);
  }
}

const allowedHotkeyModifiers = new Set([
  "commandorcontrol",
  "command",
  "control",
  "ctrl",
  "shift",
  "alt",
  "super",
  "meta",
]);

const letterHotkeyKeys = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
);
const numberHotkeyKeys = Array.from({ length: 10 }, (_, i) => `${i}`);
const functionHotkeyKeys = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const numpadHotkeyKeys = [
  ...Array.from({ length: 10 }, (_, i) => `Num${i}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadEnter",
];
const namedHotkeyKeys = [
  "Space",
  "Tab",
  "Enter",
  "Return",
  "Escape",
  "Esc",
  "Backspace",
  "Delete",
  "Del",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
  "Pause",
  "Break",
  "VolumeUp",
  "VolumeDown",
  "VolumeMute",
  "MediaNextTrack",
  "MediaPreviousTrack",
  "MediaStop",
  "MediaPlayPause",
];
const punctuationHotkeyKeys = [
  "Plus",
  "Minus",
  "Equals",
  "Equal",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "Semicolon",
  "Quote",
  "Tilde",
  ",",
  ".",
  "/",
  "\\",
  ";",
  "'",
  '"',
  "`",
  "~",
  "-",
  "=",
  "[",
  "]",
];

const allowedHotkeyKeys = new Set<string>(
  [
    ...letterHotkeyKeys,
    ...numberHotkeyKeys,
    ...functionHotkeyKeys,
    ...numpadHotkeyKeys,
    ...namedHotkeyKeys,
    ...punctuationHotkeyKeys,
  ].map((key) => key.toLowerCase()),
);

function splitHotkeyParts(hotkey: string): string[] {
  return hotkey
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeHotkey(hotkey: string): string {
  return splitHotkeyParts(hotkey).join("+");
}

function isValidHotkey(hotkey: string): boolean {
  const parts = splitHotkeyParts(hotkey);
  if (parts.length < 2 || parts.length > 4) return false;
  const keyPart = parts[parts.length - 1];
  if (!keyPart) return false;
  const modifierParts = parts.slice(0, -1);
  const modifiersValid = modifierParts.every((mod) =>
    allowedHotkeyModifiers.has(mod.toLowerCase()),
  );
  if (!modifiersValid) return false;
  const keyPartNormalized = keyPart.toLowerCase();
  if (allowedHotkeyModifiers.has(keyPartNormalized)) return false;
  return allowedHotkeyKeys.has(keyPartNormalized);
}

function resolveResource(rel: string): string | null {
  const candidates = [
    path.join(process.resourcesPath || "", rel),
    path.join(__dirname, "../../", rel), // dev + packaged (asar)
    path.join(process.cwd(), rel), // fallback in dev
  ];
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function applyApplicationIdentity() {
  app.setName(APP_DISPLAY_NAME);
  app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME });

  if (process.platform !== "darwin" || !app.dock) return;

  const iconPath =
    resolveResource("resources/icon-dock.png") ||
    resolveResource("resources/icon.png");
  if (!iconPath) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

function getTrayImage(): NativeImage {
  const p = resolveResource("resources/icon.png");
  if (p) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  // Fallback tiny dot if icon is missing
  const dataUrl = nativeTheme.shouldUseDarkColors
    ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAALElEQVQoka3NsQkAMAgEwaz//5kQWq8Zg8oCqk2S0a5w3NL6kMZ0kq9fGk7NQ3hAHt2wRb2A1S0AAAAABJRU5ErkJggg=="
    : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAALElEQVQokWNgGAXUB8QwCkYtGIaB8R8WQ0g1GJYgQ1G9wIhQ1KMBf8AAmEDxgAAf0QK3a2y8p8AAAAASUVORK5CYII=";
  return nativeImage.createFromDataURL(dataUrl);
}

async function createWindow(showWhenReady = true) {
  configureApplicationMenu();

  const preloadCandidateMjs = path.join(__dirname, "../preload/index.mjs");
  const preloadPath = preloadCandidateMjs;

  win = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#01110a",
    frame: false,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    show: false,
    icon:
      process.platform === "darwin"
        ? undefined
        : resolveResource("resources/icon.png") || undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on("ready-to-show", () => {
    if (showWhenReady) showDashboard();
  });
  win.on("closed", () => (win = null));
  win.on("close", (e) => {
    try {
      if (!isQuitting && settings.get("closeToTray")) {
        e.preventDefault();
        hideDashboard();
      }
    } catch {
      // ignore
    }
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (getRendererLoadMode(app.isPackaged, devServerUrl) === "file") {
    await win.loadFile(path.join(__dirname, "../../dist/index.html"));
  } else {
    await win.loadURL(devServerUrl!);
    if (process.env["LOCAL_DASHBOARD_OPEN_DEVTOOLS"] === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  }

  setupShortcuts();
}

function configureApplicationMenu() {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: APP_DISPLAY_NAME,
          submenu: [
            { role: "about", label: `About ${APP_DISPLAY_NAME}` },
            { type: "separator" },
            { role: "hide", label: `Hide ${APP_DISPLAY_NAME}` },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: `Quit ${APP_DISPLAY_NAME}` },
          ],
        },
      ]),
    );
    return;
  }

  Menu.setApplicationMenu(null);
}

async function updateMacDockVisibility(windowVisible: boolean) {
  if (process.platform !== "darwin" || !app.dock) return;

  if (shouldShowDockForWindowState(process.platform, windowVisible)) {
    app.dock.show();
  } else {
    app.dock.hide();
  }
}

function hideDashboard() {
  win?.hide();
  void updateMacDockVisibility(false);
}

function showDashboard() {
  void updateMacDockVisibility(true);
  win?.show();
  win?.focus();
}

function setupShortcuts() {
  globalShortcut.register("CommandOrControl+R", () => {
    win?.webContents.send("scanner:refresh");
  });
  globalShortcut.register("F5", () => {
    win?.webContents.send("scanner:refresh");
  });
  globalShortcut.register("CommandOrControl+,", () => {
    win?.webContents.send("ui:toggle-settings");
  });
  registerGlobalHotkey();
}

function registerGlobalHotkey(acceleratorOverride?: string) {
  const acceleratorRaw =
    acceleratorOverride || settings.get("globalHotkey") || "Ctrl+Shift+D";
  if (!isValidHotkey(acceleratorRaw)) {
    console.error("Skipping invalid global hotkey", acceleratorRaw);
    return;
  }
  const accelerator = normalizeHotkey(acceleratorRaw);
  // Unregister previous
  if (currentGlobalHotkey) {
    try {
      globalShortcut.unregister(currentGlobalHotkey);
    } catch {
      // ignore
    }
  }
  try {
    globalShortcut.register(accelerator, () => {
      if (!win) return;
      if (win.isVisible() && win.isFocused()) {
        hideDashboard();
      } else {
        showDashboard();
      }
    });
    currentGlobalHotkey = accelerator;
  } catch (err) {
    console.error("Failed to register global hotkey", accelerator, err);
  }
}

function setupTray() {
  if (!shouldCreateTrayIcon(process.platform)) return;

  tray = new Tray(getTrayImage());
  const context = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: showDashboard },
    { type: "separator" },
    {
      label: "Refresh",
      accelerator: "CmdOrCtrl+R",
      click: () => win?.webContents.send("scanner:refresh"),
    },
    {
      label: "Start at Login",
      type: "checkbox",
      checked: settings.get("startAtLogin"),
      click: async (menuItem) => {
        await setAutoLaunch(menuItem.checked);
        win?.webContents.send("settings:update", {
          startAtLogin: menuItem.checked,
        });
      },
    },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]);
  tray.setToolTip(APP_DISPLAY_NAME);
  tray.setContextMenu(context);
  tray.on("click", () => {
    if (!win) return;
    if (win.isVisible()) hideDashboard();
    else showDashboard();
  });
}

async function setAutoLaunch(
  enabled: boolean,
  openInTrayAtLogin = settings.get("openInTrayAtLogin"),
) {
  if (!shouldManageSystemLoginItem(app.isPackaged)) {
    settings.set("startAtLogin", enabled);
    settings.set("openInTrayAtLogin", openInTrayAtLogin);
    return;
  }

  try {
    const electronLoginItemSettings = getElectronLoginItemSettings({
      platform: process.platform,
      isPackaged: app.isPackaged,
      enabled,
      openInTrayAtLogin,
      executablePath: process.execPath,
    });

    if (electronLoginItemSettings) {
      await removeLegacyAutoLaunchRegistration();
      app.setLoginItemSettings(electronLoginItemSettings);
    } else {
      autolaunch = new AutoLaunch({
        name: APP_DISPLAY_NAME,
        isHidden: false,
      });
      if (enabled) await autolaunch.enable();
      else await autolaunch.disable();
    }
    settings.set("startAtLogin", enabled);
    settings.set("openInTrayAtLogin", openInTrayAtLogin);
  } catch (e) {
    console.error("Failed to update system login settings", e);
    throw e;
  }
}

async function removeLegacyAutoLaunchRegistration() {
  try {
    const legacyAutoLaunch = new AutoLaunch({
      name: "Localhost Dashboard",
      isHidden: true,
    });
    if (await legacyAutoLaunch.isEnabled()) {
      await legacyAutoLaunch.disable();
    }
  } catch (error) {
    console.warn("Could not remove the legacy login item", error);
  }
}

function wasOpenedAtSystemLogin(): boolean {
  if (!isMac) return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  applyApplicationIdentity();
  await initializeClis();
  // First-run seeding from resources/default-settings.json if present
  const seeded = seedDefaultsIfNeeded();
  settings.set("scanAllPorts", true);
  settings.set("__automaticDiscoveryVersion", 1);
  migrateLegacyNotifications();
  applyPlatformSettingsDefaults();
  if (
    shouldSynchronizeSystemLoginItemAtLaunch({
      platform: process.platform,
      isPackaged: app.isPackaged,
      settingsWereSeeded: seeded.seeded,
    })
  ) {
    // Repair stale Windows development registrations. Other packaged platforms
    // retain their existing first-run login-item synchronization.
    await setAutoLaunch(
      settings.get("startAtLogin"),
      settings.get("openInTrayAtLogin"),
    );
  }
  const startInTray = shouldStartInTray({
    platform: process.platform,
    argv: process.argv,
    startAtLogin: settings.get("startAtLogin"),
    openInTrayAtLogin: settings.get("openInTrayAtLogin"),
    wasOpenedAtLogin: wasOpenedAtSystemLogin(),
  });
  await createWindow(!startInTray);
  setupTray();
  if (startInTray) void updateMacDockVisibility(false);
  scanner.start();
  ahkScanner?.start();
  automatorScanner?.start();
  healthChecker.start();
  // Initialize auto-updater (IPC handlers registered always, but actual update checking only in packaged app)
  if (win) {
    initUpdater(
      win,
      shouldEnableAutoUpdater(
        app.isPackaged,
        process.env["ELECTRON_RENDERER_URL"],
      ),
    );
  }
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  else showDashboard();
});

app.on("before-quit", () => {
  isQuitting = true;
  projectStore.flush();
});

// Scanner events → renderer
scanner.on("update", (items: ServerInfo[]) => {
  projectStore.model.reconcile(items);
  win?.webContents.send("projects:update", projectStore.model.snapshot());
  win?.webContents.send("scanner:update", items);
  // Update health checker with current servers
  healthChecker.setServers(items.filter(i => i.discovery !== "unidentified" && !i.ignored).map(i => ({ key: i.key, url: i.url, firstSeen: i.firstSeen })));
});

scanner.on("new", (item) => {
  bumpPort(item.port);
  if (settings.get("notifyOnStart") && !item.ignored) {
    new Notification({
      title: "New local server",
      body: `${item.processName ?? "Process"} on :${item.port}`,
    }).show();
  }
  win?.webContents.send("stats:update", statsStore.store);
});

scanner.on("stopped", (item) => {
  if (settings.get("notifyOnStop") && !item.ignored) {
    new Notification({
      title: "Listener disappeared",
      body: `${item.processName ?? "Process"} on :${item.port}`,
    }).show();
  }
});

scanner.on("error", (err) => {
  win?.webContents.send("scanner:error", String(err));
});

// AHK Scanner events, Windows only
if (ahkScanner) {
  ahkScanner.on("update", (items) => {
    win?.webContents.send("ahk:update", items);
  });

  ahkScanner.on("new", (item) => {
    if (item.scriptPath) {
      rememberRecentScript("ahk", item.scriptPath, item.scriptName);
      sendRecentScriptsUpdate();
    }
    if (settings.get("notifyOnStart")) {
      new Notification({
        title: "AHK Script Started",
        body: item.scriptName || item.processName || "AutoHotkey script",
      }).show();
    }
  });

  ahkScanner.on("stopped", (item) => {
    if (settings.get("notifyOnStop")) {
      new Notification({
        title: "AHK Script Stopped",
        body: item.scriptName || item.processName || "AutoHotkey script",
      }).show();
    }
  });

  ahkScanner.on("error", (err) => {
    win?.webContents.send("scanner:error", String(err));
  });
}

// Automator Scanner events, macOS only
if (automatorScanner) {
  automatorScanner.on("update", (items) => {
    win?.webContents.send("automator:update", items);
  });

  automatorScanner.on("new", (item) => {
    if (item.scriptPath) {
      rememberRecentScript("automator", item.scriptPath, item.scriptName);
      sendRecentScriptsUpdate();
    }
    if (settings.get("notifyOnStart")) {
      new Notification({
        title: "Automator Script Started",
        body: item.scriptName || item.processName || "Automator script",
      }).show();
    }
  });

  automatorScanner.on("stopped", (item) => {
    if (settings.get("notifyOnStop")) {
      new Notification({
        title: "Automator Script Stopped",
        body: item.scriptName || item.processName || "Automator script",
      }).show();
    }
  });

  automatorScanner.on("error", (err) => {
    win?.webContents.send("scanner:error", String(err));
  });
}

// Health checker events → renderer
healthChecker.on("update", (results) => {
  for (const result of results) {
    const item = scanner.getItems().find(i => i.key === result.key && i.firstSeen === result.firstSeen);
    if (item?.discovery === "development") projectStore.model.updateHealth(item, result.status, result.lastChecked);
  }
  win?.webContents.send("health:update", results);
  win?.webContents.send("projects:update", projectStore.model.snapshot());
});

// IPC
ipcMain.handle("scanner:refresh", async () => {
  await scanner.scan();
  await ahkScanner?.scan();
  await automatorScanner?.scan();
});
ipcMain.on("app:open-url", (_evt, url: string) => shell.openExternal(url));
ipcMain.handle("servers:restart", async (event, ref: unknown) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error("Server restart is only available from the dashboard.");
  }
  if (serverStopper.isBusy()) throw new Error("A stop operation is already running.");
  return serverRestarter.restart(ref);
});
ipcMain.handle("servers:restart-state", () => serverRestarter.getState());
ipcMain.handle("app:open-terminal", async (event, directory: unknown) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("Terminal is only available from the dashboard.");
  await openProjectTerminal(directory);
});
ipcMain.on("app:open-explorer", (_evt, dirPath: string) => {
  if (dirPath) {
    shell.showItemInFolder(dirPath);
  }
});
ipcMain.handle("scripts:recent:get", () => getPlatformRecentScripts());
ipcMain.handle("scripts:recent:start", async (_evt, id: string) => {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Recent script id is required.");
  }
  await startRecentScript(id);
  return getPlatformRecentScripts();
});
ipcMain.handle("scripts:recent:delete", (_evt, id: string) => {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Recent script id is required.");
  }
  deleteRecentScript(id);
  sendRecentScriptsUpdate();
  return getPlatformRecentScripts();
});
ipcMain.handle("environment:list", () => listEnvironmentVariables());
ipcMain.handle("environment:get-value", (_evt, input: unknown) =>
  getEnvironmentVariableValue(input),
);
ipcMain.handle("environment:save", (_evt, input: unknown) =>
  saveEnvironmentVariable(input),
);
ipcMain.handle("environment:delete", (_evt, input: unknown) =>
  deleteEnvironmentVariable(input),
);
ipcMain.handle("settings:get", () => settings.store);
ipcMain.handle("stats:get", () => statsStore.store);
ipcMain.handle("settings:update", async (_evt, incoming: any) => {
  // Type helper not available at runtime; trust payload shape from preload validation.
  let hotkeyError: string | null = null;
  if (typeof incoming.scanIntervalMs === "number")
    settings.set("scanIntervalMs", incoming.scanIntervalMs);
  if (typeof incoming.startAtLogin === "boolean")
    await setAutoLaunch(
      incoming.startAtLogin,
      typeof incoming.openInTrayAtLogin === "boolean"
        ? incoming.openInTrayAtLogin
        : settings.get("openInTrayAtLogin"),
    );
  else if (typeof incoming.openInTrayAtLogin === "boolean")
    await setAutoLaunch(
      settings.get("startAtLogin"),
      incoming.openInTrayAtLogin,
    );
  if (typeof incoming.notifyOnStart === "boolean")
    settings.set("notifyOnStart", incoming.notifyOnStart);
  if (typeof incoming.notifyOnStop === "boolean")
    settings.set("notifyOnStop", incoming.notifyOnStop);
  if (typeof incoming.closeToTray === "boolean")
    settings.set("closeToTray", incoming.closeToTray);
  if (
    typeof incoming.globalHotkey === "string" &&
    incoming.globalHotkey.trim()
  ) {
    const trimmed = incoming.globalHotkey.trim();
    if (!isValidHotkey(trimmed)) {
      hotkeyError =
        "Global hotkey must use 2-4 keys with valid modifiers and a final key.";
    } else {
      const normalizedHotkey = normalizeHotkey(trimmed);
      settings.set("globalHotkey", normalizedHotkey);
      registerGlobalHotkey(normalizedHotkey);
    }
  }
  scanner.start();
  ahkScanner?.start();
  automatorScanner?.start();
  const payload = {
    ...settings.store,
    portsText: portsToString(settings.get("ports")),
  };
  if (hotkeyError) {
    return { ...payload, error: hotkeyError };
  }
  return payload;
});

ipcMain.handle("settings:reset", async () => {
  const next = resetToDefaults();
  await setAutoLaunch(next.startAtLogin);
  registerGlobalHotkey();
  scanner.start();
  ahkScanner?.start();
  automatorScanner?.start();
  const payload = {
    ...settings.store,
    portsText: portsToString(settings.get("ports")),
  };
  win?.webContents.send("settings:update", payload);
  return payload;
});

ipcMain.handle("app:get-meta", () => ({
  version: app.getVersion(),
  platform: os.platform(),
  arch: os.arch(),
  features: platformFeatures,
  clisTestMode:
    platformFeatures.clis &&
    Boolean(process.env["LOCAL_DASHBOARD_CLIS_TEST_ROOT"]),
}));

ipcMain.handle("clis:inventory-get", () =>
  requireCliController().getInventory(),
);
ipcMain.handle("clis:scan-start", () =>
  requireCliController().startScan(),
);
ipcMain.handle("clis:scan-directories", () => requireCliController().getScanDirectories());
ipcMain.handle("clis:choose-scan-directory", async () => {
  const controller = requireCliController();
  const selected = await dialog.showOpenDialog({ title: "Add a folder to CLI scans", properties: ["openDirectory"] });
  return selected.canceled || !selected.filePaths[0] ? controller.getScanDirectories() : controller.addScanDirectory(selected.filePaths[0]);
});
ipcMain.handle("clis:remove-scan-directory", (_event, id: string) => requireCliController().removeScanDirectory(id));
ipcMain.handle("clis:scan-cancel", (_event, scanSessionId: unknown) =>
  requireCliController().cancelScan(validateCliSessionId(scanSessionId)),
);
ipcMain.handle("clis:scan-state", () =>
  requireCliController().getScanState(),
);
ipcMain.handle("clis:installation-verify", (_event, input: unknown) =>
  requireCliController().verifyInstallation(
    validateCliInstallationRef(input),
  ),
);
ipcMain.handle("clis:installation-included", (_event, input: unknown) => {
  const value = validateCliInclusionRequest(input);
  return requireCliController().setInstallationIncluded(value, value.included);
});
ipcMain.handle("clis:installation-reveal", (_event, input: unknown) => {
  const target = requireCliController().resolveRevealPath(
    validateCliInstallationRef(input),
  );
  shell.showItemInFolder(target);
});
ipcMain.handle("clis:uninstall-preview", (_event, input: unknown) =>
  requireCliController().getUninstallPreview(
    validateCliInstallationRef(input),
  ),
);
ipcMain.handle("clis:uninstall", (_event, input: unknown) =>
  requireCliController().uninstall(validateCliUninstallRequest(input)),
);

// window control handlers
ipcMain.on("window:minimize", () => win?.minimize());
ipcMain.on("window:maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("window:close", () => win?.close());

// AHK IPC handlers
ipcMain.on("ahk:kill", (_evt, pid: number) => {
  if (process.platform !== "win32") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    exec(`taskkill /PID ${pid} /T /F`);
  }
});

ipcMain.handle("ahk:restart", async (_evt, scriptPath: string) => {
  if (process.platform !== "win32") return;
  if (!scriptPath) return;
  try {
    await startAHKScript(scriptPath);
  } catch (err) {
    console.error("Failed to restart AHK script:", err);
    throw err; // Re-throw so renderer can handle the error
  }
});

ipcMain.handle("ahk:edit", async (_evt, scriptPath: string) => {
  if (process.platform !== "win32") return;
  if (!scriptPath) return;
  try {
    // Open the script file in VSCode explicitly (not with default handler which would run AHK)
    if (process.platform === "win32") {
      // Use execAsync to properly handle paths with spaces
      await execAsync(`code "${scriptPath}"`);
    } else {
      spawn("code", [scriptPath], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Fallback: open containing folder
    shell.showItemInFolder(scriptPath);
  }
});

// Automator IPC handlers
ipcMain.handle("automator:refresh", async () => {
  if (process.platform !== "darwin") return;
  await automatorScanner?.scan();
});

ipcMain.on("automator:stop", (_evt, pid: number) => {
  if (process.platform !== "darwin") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore, the runner may have already exited
  }
});

ipcMain.handle("automator:open", async (_evt, scriptPath: string) => {
  if (process.platform !== "darwin" || !scriptPath) return;
  spawn("open", ["-a", "Automator", scriptPath], {
    detached: true,
    stdio: "ignore",
  }).unref();
});

ipcMain.handle("automator:reveal", async (_evt, targetPath: string) => {
  if (process.platform !== "darwin" || !targetPath) return;
  shell.showItemInFolder(targetPath);
});

ipcMain.handle("app:open-vscode", async (_evt, payload: any) => {
  const projectPath: string | undefined = payload?.path;
  if (!projectPath) return;

  try {
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Visual Studio Code", projectPath], {
        detached: true,
      }).unref();
    } else if (process.platform === "win32") {
      await shell.openExternal("vscode://file/" + projectPath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/"));
    } else {
      spawn("code", [projectPath], { detached: true }).unref();
    }
  } catch {
    // ignore
  }
});
