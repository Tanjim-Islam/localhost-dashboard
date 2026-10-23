# Localhost Dashboard

A simple Electron app that shows all my running local dev servers in one place. I got tired of forgetting which ports were running what, so I built this.

![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)

## What it does

- Automatically discovers local development servers on any TCP port, including IPv6
- Groups services by project, with saved names, notes, pins, bookmarks, and manual corrections
- Retains recently stopped services and bounded observed lifecycle history
- Shows process name, CPU/memory usage, uptime
- Detects frameworks (Vite, Next.js, Angular, etc.) and color-codes them
- Quick actions: open in browser, copy URL, restart a service, safely stop selected processes
- Project actions: open terminal, explorer, or VS Code at project directory
- Health monitoring with response time indicators
- AutoHotkey script detection (Windows) with kill/restart/edit
- Windows ENV key management with masked reveal, copy, edit, rename, and confirmed deletion
- Manual Windows and macOS developer CLI inventory with duplicate, PATH conflict, and health detection
- Global hotkey `Ctrl+Shift+Alt+D` to toggle visibility
- Runs in system tray

## Screenshots

The app has a custom frameless window with light and dark palettes. Project cards group running services, health, resource readings, and quick actions.

Success and completed actions use green. Errors and destructive actions use red. These status colors are independent of the selected palette, with readable shades for light and dark modes.

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
- **Notifications** - Get notified when a listener appears or disappears
- **Start at login** - Launch on system startup
- **Close to tray** - Minimize to tray instead of quitting

Settings persist via `electron-store`.

## Features

### Projects and Services

Discovery combines systeminformation with Windows netstat or macOS lsof. It automatically observes local TCP listeners on arbitrary ports. Project detection uses native working directories, script paths, manifests, and repository/workspace boundaries. Uncertain services remain unassigned; other listeners are available in a collapsed section.

Projects have persistent names, notes, pins, and bookmarks. Use **Change project** in service details to correct an association, or **Add project** to choose a folder. Multiple services share one project, including monorepo packages. Project identity survives process and port changes; moving a project directory creates a new identity.

### Service Actions

- **Open** and **Copy URL** use the exact IPv4/IPv6 localhost address.
- **Restart** recovers and verifies the existing launch context on Windows and macOS.
- **Stop Selected** uses explicit checkboxes. Search never implicitly selects anything.
- **Stop This Project** previews verified services associated with that project.

Every stop confirmation lists affected processes and all their listening ports. Main and the native helper revalidate identities before stopping. A changed or unreadable process is refused. Stop targets only those processes, without killing parents or trees. A supervisor may start a replacement process. The former Kill All action and IPC have been removed.

### Recently Stopped and Activity

Recently Stopped retains the last observed service, port, process, project, status, and timestamps. Project folder, terminal, and editor actions remain available. Activity can be inspected globally or per project and is capped at 500 events. Listener disappearance, HTTP failure/recovery, process changes, port reuse, and verified restart are recorded separately. These observations do not establish crash reasons or exit codes. Transient listener query failures retain the previous results.

### Restarting a server

**Restart** starts a fresh process, so boot-time configuration and code are loaded again. It recovers the executable, arguments, working directory, and environment from the running process. For npm scripts, it follows the script's launcher so hooks, workspace selection, and forwarded arguments run again. It also follows development watchers and Python reloaders when their process tree can be identified.

The original process and its children must stop before a replacement starts. Success requires the replacement process tree to own every original listening port for at least one second. Duplicate restart clicks and Stop actions are blocked while restart is in progress. A shared launcher with another server on a different port is left running, with an explanation.

The replacement runs in the background independently of the dashboard. It does not reconnect to the original terminal or its output. Environment values and launch commands are held in memory only for the operation. Package scripts reread their configuration on launch. Directly launched processes that modify their own environment can retain those values on Windows; use the original terminal if a dotenv loader would need those values cleared.

Windows attempts Ctrl+C only when the console contains exclusively the selected process tree. Otherwise it uses termination of the verified processes. macOS sends SIGINT. Processes that do not stop within five seconds are terminated. System services, containers, persistent service supervisors, unreadable launch details, and ambiguous arguments require restarting through their original owner. A TCP listener alone cannot prove how to restart every application.

If a project exits or its port does not return within 45 seconds, the dashboard reports that failure. A slow replacement may still be starting; check it before launching another copy.

Restart checks:

```bash
npm run test:servers
npm run test:servers:live
npm run test:servers:stop-live
```

The live checks create temporary Node, npm, npm workspace, watcher, and Vite projects, including multiple ports, separate projects, shared-launcher refusal, startup failure, special characters, and repeated clicks. Set `DASHBOARD_TEST_PYTHON` to an absolute Python interpreter to include the Python case. All fixture processes and directories are removed afterward. Run the suite on each target OS before claiming native verification.

The macOS build compiles `native/server-process.m` into a universal helper using Apple Command Line Tools. The packaged app includes that helper and needs no compiler at runtime. Windows uses its built-in 64-bit PowerShell helper. The implementation lives in `src/main/server-restart/`; private process contexts never cross preload IPC.

### Project Actions

- **Terminal** - Opens a terminal at the project directory
- **Explorer** - Opens folder in file manager
- **VS Code** - Opens project in VS Code

### Project Notes and Migration

Notes belong to persistent projects. Existing port notes appear under **Unassigned legacy notes** and require explicit association, so port reuse cannot transfer a note to an unrelated project. The original `port-notes.json` is retained. Old port filters remain on disk but no longer restrict automatic discovery; other preferences are preserved.

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
- Installed status after file checks, Verified only after a successful known command probe, one Checked timestamp, and a New badge for the first 24 hours
- Compact launcher lists grouped under one package installation
- Embedded application or SDK tools in an optional filter, excluded from normal installed totals
- Broken shims, missing targets, inaccessible endpoints, incomplete runtimes, and multiple current installations
- Isolated package-source failures without discarding the last valid inventory

After a manual scan, a compact expandable summary shows additions, verified removals, versions, executable/path changes, ownership, availability, and PATH precedence. Incomplete coverage or failed verification shows **Could not verify**, never an assumed removal. Up to 200 sanitized changes are saved with the inventory.

The catalogue supplies names and curated version probes. Discovery also finds unfamiliar console executables and scripts, declared package commands, Windows application folders, and inactive Node/Python versions. Only recognized commands and commands declared by CLI package sources enter the main list automatically. Application ownership, PATH placement, and a console executable header alone do not qualify a file as a CLI. Undeclared files appear only under **State > Other discoveries**, where **Add to CLI list** and **Remove from CLI list** save a reversible preference without running or deleting the file. Documented application commands such as PowerToys and BCUninstaller console appear under **Bundled tools**, separately from internal helpers.

The scanner reads Node package manifests, Python console entry points, Windows file metadata, and installed-application ownership without executing unfamiliar tools. npm `.cmd`, `.ps1`, and extensionless companion files remain one installation, including through nvm directory links. Windows POSIX companion scripts do not count as runnable Windows launchers. **Copy command** quotes the exact installation path for PowerShell, Command Prompt, or a macOS shell, avoiding PATH differences and shell aliases. **Check again** repeats file checks and, where a curated probe is available, checks the selected command even when a package version is already known. Verified evidence expires when the executable fingerprint changes.

Use **Scan folders > Add folder** for portable tools in other locations. These saved folders are inspected only during a manual scan, including up to 8 levels and 2,000 directories. Dependency, cache, and linked subfolders are skipped. Inaccessible folders or exceeded limits produce a partial scan notice. The app does not promise an exhaustive drive search. Publisher attribution and permission to uninstall are separate facts. Unsupported uninstall actions are omitted from installation cards.

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

See [server management architecture and verification](docs/server-management.md) for identities, safety boundaries, persistence schemas, migrations, and tests.

## CLIs testing

```bash
npm run test:clis
npm run dev:clis-test
```

`test:clis` uses fake runners, temporary PATH directories, passive metadata, and simulated package inventories. It never invokes a real package-manager uninstall. `dev:clis-test` redirects `clis.json` to a temporary fixture root, supplies healthy, multiple-installation, broken, incomplete, and partial-source records, and simulates both uninstall success and failure. Fixture mode is visibly labeled and does not affect the normal Electron profile.

## Known Limitations

- Unreadable process identities cannot be stopped from the dashboard; system services and supervisors should be managed through their owners
- Project/framework detection is conservative; unreadable or conflicting evidence requires manual association
- Native stop/restart verification requires Windows or macOS; Linux retains discovery and project management
- AHK features only work on Windows
- ENV key management only works on Windows
- CLIs are available on Windows and macOS, not Linux
- macOS CLIs behavior is fixture-tested in this repository but still needs runtime verification on macOS
