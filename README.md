# Localhost Dashboard

A simple Electron app that shows all my running local dev servers in one place. I got tired of forgetting which ports were running what, so I built this.

![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)

## What it does

- Scans for TCP listeners on common dev ports (3000, 5173, 8080, etc.)
- Shows process name, CPU/memory usage, uptime
- Detects frameworks (Vite, Next.js, Angular, etc.) and color-codes them
- Quick actions: open in browser, copy URL, kill the process
- Project actions: open terminal, explorer, or VS Code at project directory
- Health monitoring with response time indicators
- AutoHotkey script detection (Windows) with kill/restart/edit
- Global Shortcuts tab (Windows) — see which shortcuts are taken/free, record + check a shortcut, get smart recommendations
- Global hotkey `Ctrl+Shift+Alt+D` to toggle visibility
- Runs in system tray

## Screenshots

The app has a custom frameless window with a dark theme. Server cards show port, process info, framework badge, and quick action buttons.

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

If you want some test servers to play with:

```bash
npm run start:test-servers
```

## Build & Package

```bash
npm run package
```

Outputs:

- Windows: `dist/Localhost Dashboard Setup 1.0.0.exe` (installer) + portable exe

## Configuration

Click the gear icon to open settings:

- **Scan interval** - How often to check for servers (default 5s)
- **Ports** - Which ports to watch. Supports ranges like `3000-3999`
- **Notifications** - Get notified when servers start/stop
- **Start at login** - Launch on system startup
- **Close to tray** - Minimize to tray instead of quitting

Settings persist via `electron-store`.

## Features

### Server Detection

Uses `systeminformation` to find listening TCP connections. On Windows, falls back to parsing `netstat` output if needed. Each server shows:

- Port and URL
- Process name and PID
- CPU/Memory with sparkline history
- Framework detection (Vite, Next.js, CRA, Angular, etc.)
- Health status (green/yellow/red dot with response time)

### Quick Actions

- **Open** - Opens the URL in default browser
- **Copy URL** - Copies `http://localhost:PORT` to clipboard
- **Kill** - Terminates the process
- **Kill All** - Batch kill all detected servers

### Project Actions

- **Terminal** - Opens PowerShell/Terminal at project directory
- **Explorer** - Opens folder in file manager
- **VS Code** - Opens project in VS Code

### Port Notes

Attach persistent notes to ports. Useful for documenting what each port is for when you come back to a project after a while.

### AutoHotkey Scripts (Windows)

Detects running AHK scripts and shows them in a separate tab. You can:

- Kill the script
- Restart it
- Edit in VS Code
- Copy the script path

### Global Shortcuts (Windows)

A dedicated tab to keep track of which keyboard shortcuts are already in use, free, or were used by something I forgot about.

Detection sources (best-effort; Windows doesn't expose every shortcut owner cleanly):

- Shortcuts this app itself registered → **Used by this app**
- Hardcoded list of well-known Windows reserved shortcuts (Win+D, Win+E, Win+L, Win+R, Win+I, Win+X, Win+Tab, Alt+Tab, Ctrl+Alt+Delete, …) → **Reserved by Windows**
- `.lnk` shortcut hotkeys from Desktop / Public Desktop / Start Menu / ProgramData Start Menu, scanned via PowerShell + `WScript.Shell`
- Hotkeys parsed out of running AutoHotkey script files (`^!+#` syntax)
- An Electron `globalShortcut` register/unregister probe to confirm whether a given accelerator is currently free

Cache:

- Persisted via `electron-store` (`global-shortcuts.json`).
- Records remember the past owner even after a source disappears, so you can see which app/script *used to* hold a shortcut.
- A previously-seen shortcut that is currently free shows as **Now free**.

Shortcut recorder + checker:

- Click the recorder, press the actual key combination (e.g. Ctrl + Shift + K), and the result appears immediately.
- 2–4 keys, must include at least one modifier. Esc cancels.

Recommend a shortcut:

- Pick 2, 3, or 4 keys, click Recommend, get up to 5 suggestions ranked by ergonomics and conflict risk.
- Avoids common app shortcuts (Ctrl+C/V/S/A/F/X/Z/Y) and Win-key combos for safety, but they can still appear if everything safer is taken.

Refresh:

- Auto every 1 hour. Manual refresh from the Refresh Now button. Set `GLOBAL_SHORTCUTS_REFRESH=30m` to drop the interval to 30 minutes.

### Global Hotkey

Press `Ctrl+Shift+Alt+D` from anywhere to show/hide the dashboard.

## Tech Stack

- Electron + electron-vite + electron-builder
- React 19 + TypeScript
- Tailwind CSS
- electron-store for persistence
- systeminformation + pidusage for process data

## Project Structure

```
src/
├── main/           # Electron main process
│   ├── index.ts    # Window, tray, IPC handlers
│   ├── scanner.ts  # Server detection
│   ├── ahk-scanner.ts
│   ├── health-checker.ts
│   ├── global-shortcuts.ts  # Windows shortcut detection + cache + recommend
│   ├── settings.ts
│   ├── notes.ts
│   └── stats.ts
├── preload/        # IPC bridge
├── renderer/       # React UI
│   ├── App.tsx
│   └── components/
└── types/          # TypeScript declarations
```

## Known Limitations

- Killing Windows services (like PostgreSQL) requires running as admin
- Framework detection is heuristic-based, might not catch everything
- AHK features only work on Windows
