import { app, BrowserWindow, nativeTheme, Menu, Tray, ipcMain, shell, Notification, nativeImage, globalShortcut } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { Scanner } from './scanner';
import { bumpPort, stats as statsStore } from './stats';
import { settings, parsePorts, portsToString, migrateLegacyNotifications } from './settings';
import AutoLaunch from 'auto-launch';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let autolaunch: AutoLaunch | null = null;
const scanner = new Scanner();

const isMac = process.platform === 'darwin';

function getTrayImage(): nativeImage {
  // Minimal vector-like dot using dataURL; replace with proper assets later.
  const dataUrl = nativeTheme.shouldUseDarkColors
    ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAALElEQVQoka3NsQkAMAgEwaz//5kQWq8Zg8oCqk2S0a5w3NL6kMZ0kq9fGk7NQ3hAHt2wRb2A1S0AAAAABJRU5ErkJggg=='
    : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAALElEQVQokWNgGAXUB8QwCkYtGIaB8R8WQ0g1GJYgQ1G9wIhQ1KMBf8AAmEDxgAAf0QK3a2y8p8AAAAASUVORK5CYII=';
  const img = nativeImage.createFromDataURL(dataUrl);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

async function createWindow() {
  Menu.setApplicationMenu(null);

  const preloadCandidateMjs = path.join(__dirname, '../preload/index.mjs');
  const preloadCandidateJs = path.join(__dirname, '../preload/index.js');
  const preloadPath = preloadCandidateMjs;

  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#01110a',
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.on('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));

  if (app.isPackaged) {
    await win.loadFile(path.join(__dirname, '../../dist/index.html'));
  } else {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
    await win.loadURL(devServerUrl!);
    win.webContents.openDevTools({ mode: 'detach' });
  }

  setupShortcuts();
}

function setupShortcuts() {
  globalShortcut.register('CommandOrControl+R', () => {
    win?.webContents.send('scanner:refresh');
  });
  globalShortcut.register('F5', () => {
    win?.webContents.send('scanner:refresh');
  });
  globalShortcut.register('CommandOrControl+,', () => {
    win?.webContents.send('ui:toggle-settings');
  });
}

function setupTray() {
  tray = new Tray(getTrayImage());
  const context = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => win?.show() },
    { type: 'separator' },
    { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.send('scanner:refresh') },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: settings.get('startAtLogin'),
      click: async (menuItem) => {
        await setAutoLaunch(menuItem.checked);
        win?.webContents.send('settings:update', { startAtLogin: menuItem.checked });
      }
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ]);
  tray.setToolTip('Local Dashboard');
  tray.setContextMenu(context);
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.show();
  });
}

async function setAutoLaunch(enabled: boolean) {
  try {
    if (!autolaunch) {
      autolaunch = new AutoLaunch({
        name: 'Local Dashboard',
        isHidden: true
      });
    }
    if (enabled) await autolaunch.enable();
    else await autolaunch.disable();
    settings.set('startAtLogin', enabled);
  } catch (e) {
    // fallback to built-in for mac/win
    if (process.platform === 'darwin' || process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: enabled });
      settings.set('startAtLogin', enabled);
    }
  }
}

app.whenReady().then(async () => {
  await createWindow();
  setupTray();
  migrateLegacyNotifications();
  scanner.start();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});

// Scanner events → renderer
scanner.on('update', (items) => {
  win?.webContents.send('scanner:update', items);
});

scanner.on('new', (item) => {
  bumpPort(item.port);
  if (settings.get('notifyOnStart')) {
    new Notification({
      title: 'New local server',
      body: `${item.processName ?? 'Process'} on :${item.port}`
    }).show();
  }
  win?.webContents.send('stats:update', statsStore.store);
});

scanner.on('stopped', (item) => {
  if (settings.get('notifyOnStop')) {
    new Notification({
      title: 'Server stopped',
      body: `${item.processName ?? 'Process'} on :${item.port}`
    }).show();
  }
});

scanner.on('error', (err) => {
  win?.webContents.send('scanner:error', String(err));
});

// IPC
ipcMain.handle('scanner:refresh', async () => scanner.scan());
ipcMain.on('app:open-url', (_evt, url: string) => shell.openExternal(url));
ipcMain.on('app:kill-pid', (_evt, pid: number) => {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    if (process.platform === 'win32') {
      const { exec } = require('node:child_process');
      exec(`taskkill /PID ${pid} /T /F`);
    }
  }
});
ipcMain.handle('settings:get', () => settings.store);
ipcMain.handle('stats:get', () => statsStore.store);
ipcMain.handle('settings:update', async (_evt, incoming: any) => {
  // Type helper not available at runtime; trust payload shape from preload validation.
  if (typeof incoming.scanIntervalMs === 'number') settings.set('scanIntervalMs', incoming.scanIntervalMs);
  if (typeof incoming.startAtLogin === 'boolean') await setAutoLaunch(incoming.startAtLogin);
  if (typeof incoming.notifyOnStart === 'boolean') settings.set('notifyOnStart', incoming.notifyOnStart);
  if (typeof incoming.notifyOnStop === 'boolean') settings.set('notifyOnStop', incoming.notifyOnStop);
  if (typeof incoming.scanAllPorts === 'boolean') settings.set('scanAllPorts', incoming.scanAllPorts);
  if (typeof (incoming as any).portsText === 'string') {
    const ports = parsePorts((incoming as any).portsText);
    settings.set('ports', ports);
  }
  scanner.start();
  return { ...settings.store, portsText: portsToString(settings.get('ports')) };
});

ipcMain.handle('app:get-meta', () => ({
  version: app.getVersion(),
  platform: os.platform(),
  arch: os.arch()
}));

// window control handlers
ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win?.close());

ipcMain.handle('app:open-vscode', async (_evt, payload: any) => {
  // payload may contain path, command, pid
  const hint: string | undefined = payload?.path || extractDirFromCommand(payload?.command);
  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Visual Studio Code', hint || '.'], { detached: true });
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'code', hint || '.'], { detached: true, windowsHide: true });
    } else {
      spawn('sh', ['-lc', `code ${hint ? `'${hint.replace(/'/g, "'\\''")}'` : '.'}`], { detached: true });
    }
  } catch {
    // ignore
  }
});

function extractDirFromCommand(cmd?: string): string | undefined {
  if (!cmd) return undefined;
  // crude heuristic: take first existing path-like token
  const parts = cmd.split(/\s+/);
  for (const p of parts) {
    if (p.includes('/') || p.includes('\\')) {
      const dir = path.dirname(p.replace(/^"|"$/g, ''));
      return dir;
    }
  }
  return undefined;
}
