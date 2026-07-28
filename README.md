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
- Windows ENV key management with masked reveal, copy, edit, rename, and confirmed deletion
- Manual Windows and macOS developer CLI inventory with duplicate, PATH conflict, and health detection
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

### Global Hotkey

Press `Ctrl+Shift+Alt+D` from anywhere to show/hide the dashboard.

### ENV Keys (Windows)

Shows persistent credential-like variables whose names include `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, or `PAT`. Values stay masked until explicitly revealed, copied, or edited. User and machine scopes are supported, and machine-level changes may require administrator access.

### CLIs (Windows and macOS)

The permanent CLIs tab loads its last saved inventory immediately. It never inspects the computer at startup. Press **Scan Now** to enumerate the current application PATH once, inspect bounded known developer bin directories, and query supported package managers. Results group commands into logical products and show:

- Active and shadowed installations for each command
- Duplicate versions and PATH conflicts
- Executable, shim, and canonical target paths
- Package source and exact package identity when known
- Separate runtime health and neutral ownership or version confidence
- Compact launcher lists grouped under one package installation
- Embedded application or SDK tools in an optional filter, excluded from normal installed totals
- Broken shims, missing targets, inaccessible endpoints, incomplete runtimes, and recently removed installations
- Isolated package-source failures without discarding the last valid inventory

The catalogue covers common AI coding tools, runtimes, package managers, build tools, cloud tools, containers, databases, and general developer utilities. Package inventories and exact package `bin` metadata supplement the catalogue. npm `.cmd`, `.ps1`, and extensionless launchers for one package are grouped as endpoints of one installation. Unknown PATH executables are not executed or displayed automatically.

In-app uninstall is intentionally narrow. npm global packages, pipx applications, Cargo packages, qualified Scoop applications, and Homebrew formulas can be enabled only when current exact ownership is revalidated. Other sources are blocked or manual-only. The renderer sends only an installation ID, inventory revision, one-use preview token, and fixed confirmation value. The app never offers cache cleanup, leftover removal, configuration deletion, credential deletion, installation, updating, or PATH editing.

Linux keeps its existing tabs and does not expose CLIs. macOS discovery and adapters are covered by fixtures and automated tests, but runtime verification must be performed on a macOS host.

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
│   ├── clis/        # Manual CLI inventory, adapters, store, and uninstall policy
│   ├── ahk-scanner.ts
│   ├── health-checker.ts
│   ├── settings.ts
│   ├── notes.ts
│   └── stats.ts
├── preload/        # IPC bridge
├── renderer/       # React UI
│   ├── App.tsx
│   └── components/
└── types/          # TypeScript declarations
```

## CLIs testing

```bash
npm run test:clis
npm run dev:clis-test
```

`test:clis` uses fake runners, temporary PATH directories, passive metadata, and simulated package inventories. It never invokes a real package-manager uninstall. `dev:clis-test` redirects `clis.json` to a temporary fixture root, supplies healthy, duplicate, broken, missing, and partial-source records, and simulates both uninstall success and failure. Fixture mode is visibly labeled and does not affect Cleaner fixture mode or the normal Electron profile.

## Known Limitations

- Killing Windows services (like PostgreSQL) requires running as admin
- Framework detection is heuristic-based, might not catch everything
- AHK features only work on Windows
- ENV key management only works on Windows
- CLIs are available on Windows and macOS, not Linux
- macOS CLIs behavior is fixture-tested in this repository but still needs runtime verification on macOS
