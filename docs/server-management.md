# Server management

## Implementation map

| Responsibility | Location |
| --- | --- |
| Public data and request validators | `src/shared/servers.ts` |
| Listener discovery and private process cache | `src/main/scanner.ts` |
| Runtime classification and successful-scan reconciliation | `src/main/projects/discovery.ts` |
| Project evidence and stable identifiers | `src/main/projects/identify.ts` |
| Project metadata, legacy notes, observed lifecycle | `src/main/projects/model.ts` |
| Versioned persistence and coalesced writes | `src/main/projects/store.ts` |
| Main-frame IPC handlers | `src/main/projects/ipc.ts` |
| Stop confirmation and identity revalidation | `src/main/projects/stop-controller.ts` |
| Native process inspection and existing restart engine | `src/main/server-restart/` |
| Project and service UI | `src/renderer/components/ServersTab.tsx`, `components/servers/` |
| CLI snapshot comparison | `src/main/clis/changes.ts`, `components/clis/CliChanges.tsx` |

## Identity and discovery

Discovery reads local TCP listeners without a port allowlist. Windows netstat and macOS lsof supplement systeminformation, including IPv6. PID and port identify a listener observation, never a project. Two successful absent observations retire a listener. A failed listener query retains the previous snapshot. Missing process metadata does not establish a stop.

Native process context is cached for 60 seconds and inspected for at most 12 processes per polling pass. Project identification walks at most 12 ancestors, caches up to 1,000 contexts, and never traverses a project tree. Package manifests, workspace markers, Python/Cargo/Go manifests, and repository boundaries establish roots. Nested repositories stay separate. Conflicting CWD and script roots remain unassigned. Global tool directories and a manifest in the user's home are not sufficient project evidence.

A project ID hashes the canonical directory, case-insensitively on Windows. Changing a port or process preserves the project; moving a directory produces a new identity. A service association hashes its working directory, executable, and private arguments, excluding explicit numeric `--port` and `-p` arguments. The arguments themselves are never persisted or exposed. Manual overrides apply to that launch identity. When launch context is unreadable, a manual override is limited to the observed process lifetime. Unknown ownership never grants a project stop action.

Native start time and executable establish process identity. `key` plus `firstSeen` identifies the renderer's observed instance. Neither a PID alone nor a port alone authorizes stopping or restarting.

## Persistence and migrations

`projects.json` stores a schema-version-1 state: up to 1,000 projects, 2,000 manual associations, 512 last observations, 100 recently stopped services, and 500 lifecycle events. Projects hold name, canonical directory, notes, pin/bookmark flags, and timestamps. History contains only allowlisted observed metadata, never commands, environments, output, exit codes, or guessed crash reasons. Observation writes coalesce over 30 seconds; user changes and clean shutdown flush immediately.

The existing `port-notes.json` remains a read-only backup. Its notes enter an unassigned legacy list once. The user must choose a project explicitly; a current port match never assigns a note. Project notes allow 4,000 characters; longer legacy notes remain copyable (up to 64,000 characters in the migrated view) and are not silently attached or truncated to fit. The original backup remains intact.

Automatic discovery sets `scanAllPorts` and the `__automaticDiscoveryVersion` migration marker. Old port configuration is retained for compatibility but no longer filters discovery. Other preferences are preserved.

The existing schema-version-2 CLI store gains an optional schema-version-1 `changes` field on its valid inventory, bounded to 200 allowlisted changes. Older inventories need no destructive migration. Only a completed manual scan compares snapshots. Cancellation and failed scans retain the prior snapshot. Removed claims require complete coverage and positive absence of every prior endpoint; permissions, partial sources, and failed verification produce uncertainty. Endpoint or ownership matching must be unique in both snapshots. Cached startup and server refresh never trigger a CLI scan.

## IPC and stop invariants

Preload and main validate `getProjects`, `editProject`, `addProject`, `associateService`, `attachLegacyNote`, `openProjectFolder`, `getServers`, `previewStopServers`, and `stopServers`. Subscriptions use `onProjectsUpdate` and return unsubscribe functions. Keep `src/types/preload.d.ts` synchronized. Main also rejects requests from any frame other than the dashboard's main frame.

Stop preview accepts explicit observed service references and an optional project ID. It captures every port owned by each selected process, its native identity, and a one-use token valid for 60 seconds. Main rejects unreadable identities, its own process/ancestors, and a process shared across project associations. Execution rechecks each selected instance, association, native identity, and exact port set immediately before the native helper revalidates and terminates that process. Stop does not terminate parents or process trees. A supervisor may start another process; the dashboard reports that as a separate observation. Results report each process independently. Restart and stop are mutually exclusive.

Filtering never selects services. Project stop includes only explicitly confirmed, verified services belonging to that project. The old `app:kill-pid`, `app:kill-all-servers`, and port-note mutation IPC no longer exist.

HTTP failure means an unresponsive HTTP endpoint, not a crashed process. Late health results cannot update a replacement instance. Listener disappearance, process change, port reuse, recovery, and restart are distinct events. The app cannot recover terminal output or determine why a process exited.

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
```

Unit tests cover project and monorepo evidence, conflicting roots, persistence, note migration, metadata failures, lifecycle deduplication, IPv6 parsers, health identity, CLI changes, and stop authorization. Live suites generate isolated dummy servers only. Set `DASHBOARD_TEST_PYTHON` to an absolute interpreter for the Python restart scenario. Never test destructive server actions against unrelated real processes. Windows runs do not prove native macOS behavior; run the native suites on macOS before claiming that coverage.

For UI checks, launch the built app with `LOCAL_DASHBOARD_CLIS_TEST_ROOT` set to a temporary fixture directory. This isolates Electron data and CLI operations; the server scanner still observes real local listeners. Select only generated dummy services. Verify project edits and manual associations after an app restart, hidden selections, exact stop previews, HTTP failure/recovery, recent history, cached CLI startup, minimum-width title bar, light/dark themes, and keyboard focus/Escape behavior.

Project menus (`servers/ProjectMenu.tsx`) support arrow keys, Home/End, Escape, Tab, and outside dismissal. Menu items are left-aligned. Service details (`servers/ServiceRow.tsx`) expand below the action row without moving its controls. Both use Framer Motion for entrance and exit, honor reduced motion, and make closing content inert. Check rapid toggles, focus restoration, and unchanged action positions in both themes.
