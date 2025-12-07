import { contextBridge, ipcRenderer, clipboard } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // scanning
  onScanUpdate: (cb: (items: any[]) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on('scanner:update', listener);
    return () => ipcRenderer.removeListener('scanner:update', listener);
  },
  onScanError: (cb: (msg: string) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on('scanner:error', listener);
    return () => ipcRenderer.removeListener('scanner:error', listener);
  },
  refresh: () => ipcRenderer.invoke('scanner:refresh'),
  // actions
  openUrl: (url: string) => ipcRenderer.send('app:open-url', url),
  killPid: (pid: number) => ipcRenderer.send('app:kill-pid', pid),
  copyText: (text: string) => clipboard.writeText(text),
  openInVSCode: (payload: any) => ipcRenderer.invoke('app:open-vscode', payload),
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial: any) => ipcRenderer.invoke('settings:update', partial),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  onSettingsUpdate: (cb: (s: any) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on('settings:update', listener);
    return () => ipcRenderer.removeListener('settings:update', listener);
  },
  getStats: () => ipcRenderer.invoke('stats:get'),
  onStatsUpdate: (cb: (s: any) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on('stats:update', listener);
    return () => ipcRenderer.removeListener('stats:update', listener);
  },
  // AHK scripts
  onAHKUpdate: (cb: (items: any[]) => void) => {
    const listener = (_: any, payload: any) => cb(payload);
    ipcRenderer.on('ahk:update', listener);
    return () => ipcRenderer.removeListener('ahk:update', listener);
  },
  killAHK: (pid: number) => ipcRenderer.send('ahk:kill', pid),
  restartAHK: (scriptPath: string) => ipcRenderer.invoke('ahk:restart', scriptPath),
  editAHK: (scriptPath: string) => ipcRenderer.invoke('ahk:edit', scriptPath),
  // UI events from main
  onToggleSettings: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('ui:toggle-settings', listener);
    return () => ipcRenderer.removeListener('ui:toggle-settings', listener);
  },
  // meta
  getMeta: () => ipcRenderer.invoke('app:get-meta')
});
// window controls
contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close')
});
