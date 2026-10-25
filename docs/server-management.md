# Server management

## Implementation map

| Responsibility | Location |
| --- | --- |
| Public data and request validators | `src/shared/servers.ts` |
| Listener discovery and private process cache | `src/main/scanner.ts` |
| Runtime classification and successful-scan reconciliation | `src/main/projects/discovery.ts` |
| Application ownership and development-listener classification | `src/main/projects/classify.ts` |
| Project evidence and stable identifiers | `src/main/projects/identify.ts` |
| Project metadata, legacy notes, observed lifecycle | `src/main/projects/model.ts` |
| Versioned persistence and coalesced writes | `src/main/projects/store.ts` |
| Main-frame IPC handlers | `src/main/projects/ipc.ts` |
| One-click stop and identity revalidation | `src/main/projects/stop-controller.ts` |
| Native process inspection and existing restart engine | `src/main/server-restart/` |
| Safe native terminal launch | `src/main/project-terminal.ts` |
| Project and service UI | `src/renderer/components/ServersTab.tsx`, `components/servers/` |
| CLI snapshot comparison | `src/main/clis/changes.ts`, `components/clis/CliChanges.tsx` |

## Identity and discovery

Discovery reads local TCP listeners without a port allowlist. Windows netstat and macOS lsof supplement systeminformation, including IPv6. PID and port identify a listener observation, never a project. A separate one-second Windows/macOS presence check retires listeners after two successful absent observations without waiting for metadata or metrics. A failed listener query retains the previous snapshot. Missing process metadata does not establish a stop. A verified native stop retires the exact observed references immediately. Retirement during an in-flight metadata scan suppresses its stale rows, preventing resurrection.

Network and process metadata queries have time limits. In particular, a macOS systeminformation query that never settles cannot block a successful native lsof table. Native and coarse process start timestamps are reconciled without inventing replacement events when inspection arrives or the app restarts. Exact native identities still authorize destructive actions.

Python.org and Command Line Tools interpreter bundles (`Python.app` inside a Python framework) are runtimes, so their HTTP/Flask projects retain grouping and safe controls. Homebrew and MacPorts installation directories cannot supply project roots merely because the package manager has a Git repository.

Native process context is cached for 60 seconds and inspected for at most 12 processes per polling pass. Project identification walks at most 12 ancestors, caches up to 1,000 contexts, and never traverses a project tree. Package manifests, workspace markers, Python/Cargo/Go manifests, and repository boundaries establish roots. Nested repositories stay separate. Conflicting CWD and script roots remain unassigned. Global tool directories and a manifest in the user's home are not sufficient project evidence.

A project ID hashes the canonical directory, case-insensitively on Windows. Changing a port or process preserves the project; moving a directory produces a new identity. A service association hashes its working directory, executable, and private arguments, excluding explicit numeric `--port` and `-p` arguments. The arguments themselves are never persisted or exposed. Manual overrides apply to that launch identity. When launch context is unreadable, a manual override is limited to the observed process lifetime. Unknown ownership never grants a project stop action.

Native start time and executable establish process identity. `key` plus `firstSeen` identifies the renderer's observed instance. Neither a PID alone nor a port alone authorizes stopping or restarting.

Classification checks the executable, private launch context, project evidence, and bounded process ancestry. A runtime name alone does not establish a development server. macOS bundles and Windows executables sharing an installation with a verified application ancestor identify application services, including bundled Node helpers such as Raycast. Parent start times prevent reused PIDs from proving ownership. An IDE or terminal ancestor never absorbs a runtime outside its installation. Portable Electron and browser debugging listeners also remain application services. No port number establishes an application identity. Missing evidence stays under Other local listeners.

Application services, recently stopped services, other local listeners, and legacy notes appear in the animated More services drawer (`components/servers/ServicesDrawer.tsx`). Verified application services can be stopped individually, but cannot be associated with development projects or restarted. Dashboard processes, its ancestors and helpers, and native system processes remain protected. Exact replacement identities recorded by Restart remain stoppable while Dashboard is their parent; reused PIDs never inherit that exception. Odoo, Flask, FastAPI, and Python HTTP commands supplement existing framework heuristics.

## Persistence and migrations

`projects.json` stores a schema-version-2 state: up to 1,000 projects, 2,000 manual associations, 512 last observations, 100 recently stopped services, and 500 lifecycle events. Projects hold name, canonical directory, notes, pin/bookmark/ignored flags, and timestamps. Version 1 migrates in place with `ignored: false`, preserving notes, associations, and history. History contains only allowlisted observed metadata, never commands, environments, output, exit codes, or guessed crash reasons. Observation writes coalesce over 30 seconds; user changes and clean shutdown flush immediately.

Ignored projects retain their identity and metadata across port changes and restarts. They stay in the Ignored view, including while stopped. Ignore suppresses normal counts, notifications, health probes, and destructive actions; observed lifecycle remains available in that view. Restore reverses the preference. The renderer clears selection when ignoring a project or changing views. Main rechecks eligibility before stop/restart, including when ignoring races with process inspection. The UI-only view preference uses `dashboard:serversView` in localStorage.

The existing `port-notes.json` remains a read-only backup. Its notes enter an unassigned legacy list once. The user must choose a project explicitly; a current port match never assigns a note. Project notes allow 4,000 characters; longer legacy notes remain copyable (up to 64,000 characters in the migrated view) and are not silently attached or truncated to fit. The original backup remains intact.

Automatic discovery sets `scanAllPorts` and the `__automaticDiscoveryVersion` migration marker. Old port configuration is retained for compatibility but no longer filters discovery. Other preferences are preserved.

The existing schema-version-2 CLI store gains an optional schema-version-1 `changes` field on its valid inventory, bounded to 200 allowlisted changes. Older inventories need no destructive migration. Only a completed manual scan compares snapshots. Cancellation and failed scans retain the prior snapshot. Removed claims require complete coverage and positive absence of every prior endpoint; permissions, partial sources, and failed verification produce uncertainty. Endpoint or ownership matching must be unique in both snapshots. Cached startup and server refresh never trigger a CLI scan.

The optional `comparisonBaseline` retains one bounded, normalized inventory independently of the displayed partial inventory. Partial scans cannot erase the evidence needed to identify a returning CLI or confirm its later removal. A complete manual scan advances this baseline. Existing stores seed it from their complete inventory without changing other preferences.

macOS version probes invoke the observed launcher path, preserving filename-based proxy behavior such as Rustup's `rustc` and `cargo` symlinks. Canonical targets remain ownership evidence. Alias fingerprints invalidate versions cached by the earlier target-based probes on the next manual scan.

## IPC and stop invariants

Preload and main validate `getProjects`, `editProject`, `associateService`, `attachLegacyNote`, `openProjectFolder`, `getServers`, and `stopServers`. Add Project and stop-preview IPC have been removed. Subscriptions use `onProjectsUpdate` and return unsubscribe functions. Keep `src/types/preload.d.ts` synchronized. Main also rejects requests from any frame other than the dashboard's main frame.

`stopServers({ refs, projectId? })` accepts explicit observed references. Main prepares and executes the validated plan using one native helper and one operation lock, without a renderer confirmation step. The internal plan captures every port owned by each selected process, its native identity, and a one-use token valid for 60 seconds. Main rejects unreadable identities, protected processes, and processes shared across project associations. Execution rechecks each selected instance, association, classification, native identity, and exact port set immediately before the native helper revalidates and terminates that process. Each verified success updates the scanner and lifecycle history immediately. Stop does not terminate parents or process trees. A supervisor may start another process; the dashboard reports that as a separate observation. Results report each process independently. Restart and stop are mutually exclusive.

Filtering never selects services. The selection toolbar displays how many selected services are hidden by search. Project stop includes only verified services belonging to that project. The old `app:kill-pid`, `app:kill-all-servers`, and port-note mutation IPC no longer exist.

HTTP failure means an unresponsive HTTP endpoint, not a crashed process. Late health results cannot update a replacement instance. Listener disappearance, process change, port reuse, recovery, and restart are distinct events. The app cannot recover terminal output or determine why a process exited.

HTTP status and protocol evidence appear in service Details. A 426 response is reachable but requires an upgrade; only an explicit WebSocket Upgrade header labels it WebSocket. Neither an HTTP error nor reclassifying a live application helper produces a stopped-process claim.

`openTerminal` validates an absolute local folder in preload and main. Windows uses a fixed PowerShell launcher to open a visible `cmd /d /k` console in the canonical folder. The path travels as an environment value, never interpolated shell text; the temporary variable is removed before launching the console. macOS uses `/usr/bin/open -a Terminal -- <folder>` with a literal argument. Launch failures reject the IPC request rather than reporting success on spawn alone.

## Verification

```text
npm test
npm run test:servers:stop-live
npm run test:servers:live
npm run test:startup
npm run test:env-keys
npx tsc --noEmit
npm run lint
npm run build
npm run test:servers:ui
```

Unit tests cover project and monorepo evidence, conflicting roots, persistence, note migration, metadata failures, lifecycle deduplication, IPv6 parsers, health identity, CLI changes, and stop authorization. Live suites generate isolated dummy servers only. Set `DASHBOARD_TEST_PYTHON` to an absolute interpreter for the Python restart scenario. Never test destructive server actions against unrelated real processes. Windows runs do not prove native macOS behavior; run the native suites on macOS before claiming that coverage.

Ownership, portable browser helpers, misleading runtime/ancestor names, macOS bundles, ignore migration, stale stop authorization, HTTP upgrade responses, and literal terminal paths have focused `server-classification`, `server-projects`, `server-stop`, `server-health`, and `server-terminal` tests. Verify Terminal through the actual project button, including a visible console and the intended working directory; process spawn alone is insufficient.

For UI checks, launch the built app with `LOCAL_DASHBOARD_CLIS_TEST_ROOT` set to a temporary fixture directory. This isolates Electron data and CLI operations; the server scanner still observes real local listeners. Select only generated dummy services. Verify project edits and manual associations after an app restart, hidden selections, one-click stopping and error retention, HTTP failure/recovery, recent history, cached CLI startup, two-column cards at minimum width, light/dark themes, and drawer keyboard focus/Escape behavior.

Project menus (`servers/ProjectMenu.tsx`) support arrow keys, Home/End, Escape, Tab, and outside dismissal. Menu items are left-aligned. Service details (`servers/ServiceRow.tsx`) expand below the action row without moving its controls. Both use Framer Motion for entrance and exit, honor reduced motion, and make closing content inert. Check rapid toggles, focus restoration, and unchanged action positions in both themes.

Recently stopped entries use `servers/StoppedServiceRow.tsx`: spaced identity/timestamp lines, inline actions, and full-width animated details. Keep the section-level `ServerDisclosure` out of individual rows. Check a populated history with long project names and missing project metadata at the minimum window width, not only collapsed or empty states.

`scripts/server-ui.integration.cjs` runs the native macOS Electron flow with generated Node/Python servers, a compiled dummy macOS app bundle, and an isolated profile. It covers real project and note migration, ignore/restore persistence, manual associations, keyboard menus, terminal CWD, HTTP recovery, timed one-click selected/project/application stopping, stopping a restarted child, external-stop disappearance, CLI caching and populated history in both themes at 900 and 1100px. Set `DASHBOARD_PLAYWRIGHT_MODULE` to an available Playwright module path when it is bundled outside this project. Set `DASHBOARD_ELECTRON_EXECUTABLE` to a packaged app's executable to verify the same flow with shipping native resources. Only recorded fixture identities are eligible for cleanup. Screenshots remain in the printed temporary QA directory.

The branded development Electron bundle can report `app.isPackaged=true` while `process.defaultApp=true`. `isPackagedApplication` in `app-identity.ts` distinguishes this case, so repository launches use repository helpers and do not initialize Sparkle or alter login items. Real packaged apps retain their existing behavior.

Packaging includes only `dist/index.html` and `dist/assets` from the renderer output. Electron-builder also writes installers into `dist`, so including all of that directory recursively would bundle intermediate apps and break universal merges.
