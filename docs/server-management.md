# Server management

## Discovery and identity

The native host reads the local IPv4 and IPv6 TCP listener tables. Windows uses IP Helper and the Service Control Manager, macOS uses a bounded `lsof` query, and Linux uses procfs. Process inspection and resource sampling run outside the UI thread. HTTP health checks connect to loopback. A listener disappearing and a listener failing an HTTP check produce different lifecycle events.

`src-tauri/src/servers/mod.rs` coordinates observation and reconciliation. A failed listener enumeration retains prior observations. Two successful missing observations retire an externally stopped listener. An internally verified stop retires its exact instances. A service reference pairs the PID and port with the first observation timestamp. Native process start identity and executable are checked again before destructive actions.

`classify.rs` and `project.rs` combine executable identity, project markers, working directories and arguments to identify projects. Canonical directory identity keeps project names, pins, bookmarks, ignored status and notes stable as ports change. Conflicting evidence can be resolved by an explicit association. An association does not authorize stopping an application helper or protected system process.

## Persistent data

`projects.json` contains versioned project metadata, manual associations, recent observations, up to 100 stopped services and up to 500 lifecycle events. The store accepts older project state and imports legacy port notes for explicit reassignment. Rust coalesces scan-driven writes, flushes user edits immediately and flushes again on clean exit. Writes use a temporary file in the same directory and atomic replacement.

On the first Tauri launch, `storage.rs` imports the dashboard's existing settings, stats, projects, CLI inventory, recent scripts and legacy notes into the application's own data directory. On macOS the SQLite settings take precedence over the JSON migration source. Supported Chromium file-origin localStorage preferences are recovered from a temporary copy of its LevelDB. The original files remain available.

## Native actions

The React renderer calls the typed bridge in `src/renderer/desktop.ts`. `src-tauri/src/main.rs` admits dashboard commands only from the local main window. The public types live in `src/shared/servers.ts`. Process arguments, environments and launch recipes stay in native memory.

`control.rs` handles project edits and validated actions. A start, stop or restart holds the lifecycle operation lock. Stop requires an explicit selection, current association, eligible process identity and coverage of all affected listeners. Windows checks the native process handle before termination. macOS checks identity before signalling. A changed identity or unrelated live port rejects the operation.

`launch.rs` resolves the eligible launcher, captures launch context in memory and verifies replacement listeners. Recently stopped records can only start if their original recipe is still available in this session and the ports are free. The window receives success after the replacement process owns the expected listeners. Server commands, shell fragments and replacement executable paths cannot be supplied through the renderer.

Opening a terminal requires a known canonical project directory. Windows opens `cmd.exe /d /k` in a new console with the directory supplied as the process working directory. macOS passes the folder as a literal argument to Terminal through `/usr/bin/open`.

## Verification

Run `npm run test:servers` for project identity, lifecycle, HTTP and live disposable listener cases. Node must be available to launch the test fixtures. Run `npm run test:desktop` on Windows for WebView2 UI and IPC checks. Run native tests on each supported OS before making platform-specific claims.
