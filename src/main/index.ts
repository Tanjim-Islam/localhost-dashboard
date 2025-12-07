import {
  app,
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
import os from "node:os";
import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import { Scanner } from "./scanner";
import { AHKScanner } from "./ahk-scanner";
import { HealthChecker } from "./health-checker";
import { initUpdater } from "./updater";
import { bumpPort, stats as statsStore } from "./stats";
import { getNote, setNote, getAllNotes } from "./notes";
import {
  settings,
  parsePorts,
  portsToString,
  migrateLegacyNotifications,
  seedDefaultsIfNeeded,
  resetToDefaults,
} from "./settings";
import AutoLaunch from "auto-launch";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let autolaunch: AutoLaunch | null = null;
let currentGlobalHotkey: string | null = null;
const scanner = new Scanner();
const ahkScanner = new AHKScanner();
const healthChecker = new HealthChecker();
let isQuitting = false;

const isMac = process.platform === "darwin";

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
  String.fromCharCode(65 + i)
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
  ].map((key) => key.toLowerCase())
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
    allowedHotkeyModifiers.has(mod.toLowerCase())
  );
  if (!modifiersValid) return false;
  const keyPartNormalized = keyPart.toLowerCase();
  if (allowedHotkeyModifiers.has(keyPartNormalized)) return false;
  return allowedHotkeyKeys.has(keyPartNormalized);
}

function resolveResource(rel: string): string | null {
  const candidates = [
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

async function createWindow() {
  Menu.setApplicationMenu(null);

  const preloadCandidateMjs = path.join(__dirname, "../preload/index.mjs");
  const preloadCandidateJs = path.join(__dirname, "../preload/index.js");
  const preloadPath = preloadCandidateMjs;

  win = new BrowserWindow({
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

  win.on("ready-to-show", () => win?.show());
  win.on("closed", () => (win = null));
  win.on("close", (e) => {
    try {
      if (!isQuitting && settings.get("closeToTray")) {
        e.preventDefault();
        win?.hide();
      }
    } catch {
      // ignore
    }
  });

  if (app.isPackaged) {
    await win.loadFile(path.join(__dirname, "../../dist/index.html"));
  } else {
    const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
    await win.loadURL(devServerUrl!);
    win.webContents.openDevTools({ mode: "detach" });
  }

  setupShortcuts();
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
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    });
    currentGlobalHotkey = accelerator;
  } catch (err) {
    console.error("Failed to register global hotkey", accelerator, err);
  }
}

function setupTray() {
  tray = new Tray(getTrayImage());
  const context = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => win?.show() },
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
  tray.setToolTip("Localhost Dashboard");
  tray.setContextMenu(context);
  tray.on("click", () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.show();
  });
}

async function setAutoLaunch(enabled: boolean) {
  try {
    if (!autolaunch) {
      autolaunch = new AutoLaunch({
        name: "Localhost Dashboard",
        isHidden: true,
      });
    }
    if (enabled) await autolaunch.enable();
    else await autolaunch.disable();
    settings.set("startAtLogin", enabled);
  } catch (e) {
    // fallback to built-in for mac/win
    if (process.platform === "darwin" || process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: enabled });
      settings.set("startAtLogin", enabled);
    }
  }
}

app.whenReady().then(async () => {
  await createWindow();
  setupTray();
  // First-run seeding from resources/default-settings.json if present
  const seeded = seedDefaultsIfNeeded();
  if (seeded.seeded) {
    // Ensure OS autostart setting reflects seeded startAtLogin value
    await setAutoLaunch(settings.get("startAtLogin"));
  }
  migrateLegacyNotifications();
  scanner.start();
  ahkScanner.start();
  healthChecker.start();
  // Initialize auto-updater (IPC handlers registered always, but actual update checking only in packaged app)
  if (win) {
    initUpdater(win, app.isPackaged);
  }
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
});

// Scanner events → renderer
scanner.on("update", (items) => {
  win?.webContents.send("scanner:update", items);
  // Update health checker with current servers
  healthChecker.setServers(items.map((i: any) => ({ key: i.key, url: i.url })));
});

scanner.on("new", (item) => {
  bumpPort(item.port);
  if (settings.get("notifyOnStart")) {
    new Notification({
      title: "New local server",
      body: `${item.processName ?? "Process"} on :${item.port}`,
    }).show();
  }
  win?.webContents.send("stats:update", statsStore.store);
});

scanner.on("stopped", (item) => {
  if (settings.get("notifyOnStop")) {
    new Notification({
      title: "Server stopped",
      body: `${item.processName ?? "Process"} on :${item.port}`,
    }).show();
  }
});

scanner.on("error", (err) => {
  win?.webContents.send("scanner:error", String(err));
});

// AHK Scanner events → renderer
ahkScanner.on("update", (items) => {
  win?.webContents.send("ahk:update", items);
});

ahkScanner.on("new", (item) => {
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

// Health checker events → renderer
healthChecker.on("update", (results) => {
  win?.webContents.send("health:update", results);
});

// IPC
ipcMain.handle("scanner:refresh", async () => scanner.scan());
ipcMain.on("app:open-url", (_evt, url: string) => shell.openExternal(url));
ipcMain.on("app:kill-pid", (_evt, pid: number) => {
  if (process.platform === "win32") {
    // On Windows, use taskkill directly with /F (force) and /T (tree - kill child processes)
    // This is more reliable than process.kill() for Windows processes
    exec(`taskkill /PID ${pid} /T /F`, (err) => {
      if (err) {
        // If taskkill fails (e.g., access denied for services), try process.kill as fallback
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process might be a protected service - requires admin privileges
          console.error(`Failed to kill PID ${pid}:`, err.message);
        }
      }
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore - process may have already exited
    }
  }
});
ipcMain.handle("app:kill-all-servers", async () => {
  const pids = scanner.getAllPids();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      if (process.platform === "win32") {
        exec(`taskkill /PID ${pid} /T /F`);
      }
    }
  }
  return pids.length;
});
ipcMain.handle("app:open-terminal", async (_evt, dirPath: string) => {
  if (!dirPath) return;
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "cmd", "/k", `cd /d "${dirPath}"`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", dirPath], { detached: true }).unref();
    } else {
      spawn("x-terminal-emulator", [], {
        cwd: dirPath,
        detached: true,
      }).unref();
    }
  } catch {
    // ignore
  }
});
ipcMain.on("app:open-explorer", (_evt, dirPath: string) => {
  if (dirPath) {
    shell.showItemInFolder(dirPath);
  }
});
// Port notes
ipcMain.handle("notes:get", (_evt, port: number | string) => getNote(port));
ipcMain.handle("notes:set", (_evt, port: number | string, note: string) => {
  setNote(port, note);
  return getAllNotes();
});
ipcMain.handle("notes:all", () => getAllNotes());
ipcMain.handle("settings:get", () => settings.store);
ipcMain.handle("stats:get", () => statsStore.store);
ipcMain.handle("settings:update", async (_evt, incoming: any) => {
  // Type helper not available at runtime; trust payload shape from preload validation.
  let hotkeyError: string | null = null;
  if (typeof incoming.scanIntervalMs === "number")
    settings.set("scanIntervalMs", incoming.scanIntervalMs);
  if (typeof incoming.startAtLogin === "boolean")
    await setAutoLaunch(incoming.startAtLogin);
  if (typeof incoming.notifyOnStart === "boolean")
    settings.set("notifyOnStart", incoming.notifyOnStart);
  if (typeof incoming.notifyOnStop === "boolean")
    settings.set("notifyOnStop", incoming.notifyOnStop);
  if (typeof incoming.scanAllPorts === "boolean")
    settings.set("scanAllPorts", incoming.scanAllPorts);
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
  if (typeof (incoming as any).portsText === "string") {
    const ports = parsePorts((incoming as any).portsText);
    settings.set("ports", ports);
  }
  scanner.start();
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
}));

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
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    if (process.platform === "win32") {
      exec(`taskkill /PID ${pid} /T /F`);
    }
  }
});

ipcMain.handle("ahk:restart", async (_evt, scriptPath: string) => {
  if (!scriptPath) return;
  try {
    // Find AutoHotkey executable - try common locations
    const ahkPaths = [
      "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe",
      "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe",
      "C:\\Program Files\\AutoHotkey\\AutoHotkey.exe",
      "C:\\Program Files (x86)\\AutoHotkey\\AutoHotkey.exe",
    ];

    // Try to find AHK executable via where command
    let ahkExe: string | null = null;
    try {
      const { stdout } = await execAsync("where AutoHotkey");
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) ahkExe = lines[0];
    } catch {
      // Try known paths
      for (const p of ahkPaths) {
        try {
          await execAsync(`if exist "${p}" echo found`);
          ahkExe = p;
          break;
        } catch {
          // continue
        }
      }
    }

    if (!ahkExe) {
      // Fall back to just "AutoHotkey" and hope it's in PATH
      ahkExe = "AutoHotkey";
    }

    spawn(ahkExe, [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch (err) {
    console.error("Failed to restart AHK script:", err);
    throw err; // Re-throw so renderer can handle the error
  }
});

ipcMain.handle("ahk:edit", async (_evt, scriptPath: string) => {
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

ipcMain.handle("app:open-vscode", async (_evt, payload: any) => {
  const projectPath: string | undefined = payload?.path;
  if (!projectPath) return;

  try {
    if (process.platform === "darwin") {
      spawn("open", ["-a", "Visual Studio Code", projectPath], {
        detached: true,
      }).unref();
    } else if (process.platform === "win32") {
      // Use spawn with shell:false and proper quoting for paths with spaces
      const child = spawn("code", [projectPath], {
        detached: true,
        shell: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      spawn("code", [projectPath], { detached: true }).unref();
    }
  } catch {
    // ignore
  }
});
