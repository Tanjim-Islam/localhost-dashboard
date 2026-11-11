# Resource and transition verification

Verified locally on Windows on 2026-11-07. The baseline is commit `c72c514eea85e57a1d2b6466816ab09b561f8465`; the comparison uses the working changes in this checkout. Nothing was committed, published, or deployed.

## Changes

- Share outstanding process enumeration between server and AutoHotkey scans. Server metadata keeps its existing five-second wait limit; a slow query is not repeatedly launched while still running.
- Collect resource metrics once per unique process, in bounded PID batches. Multiple ports retain independent histories. A failed batch falls back to individual queries for surviving processes.
- Prevent overlapping automation and health scans. Replace repeated linear searches and array construction with per-scan maps and sets.
- Keep unrelated CLI, environment, settings, and title-bar components from rendering on every server or health update.
- Minify the production renderer. Remove the continuous decorative background movement and permanent automation-card GPU layer hints, while retaining the background and interactive transitions.
- Use the existing Framer Motion dependency for opening and closing dialogs, drawers, tab surfaces, menus, and collapsible details. Respect reduced motion and make exiting controls inert.
- Keep Save and Reset to defaults in a fixed Settings footer, with a separate scrolling body and header.
- Remove five unused direct dependencies and avoid packaging duplicate renderer source packages. See [the complete dependency audit](dependency-audit.md).

## Measurements

| Measurement | Baseline | Optimized |
| --- | ---: | ---: |
| Renderer JavaScript, build-reported size | 1,357.19 kB | 566.96 kB |
| Packaged Windows app archive (`app.asar`) | 61,329,929 bytes | 16,736,082 bytes |
| Complete unpacked Windows application | 402,651,875 bytes | 358,058,028 bytes |
| Native metric queries for six rows across four dummy processes | 6 | 1 |
| Median native metric sampling time | 9,562 ms | 1,461 ms |
| Concurrent process enumeration launches | 2 | 1 |
| Median parent CPU time for process enumeration | 1,016 ms | 563 ms |
| Median process enumeration wall time | 6,186 ms | 6,574 ms |
| Direct dependencies including development | 39 | 34 |
| Production lockfile package entries | 204 | 137 |

Native measurements use three alternating samples per implementation on this Windows host. This is an 84.7% reduction in metric sampling time and a 44.6% reduction in parent CPU time for enumeration. Enumeration wall time did not improve. These are operation-specific results, not a claim that the whole app is 85% faster. The benchmark permits a longer observation wait to measure the underlying query; production time limits are unchanged.

The packaged app archive is 72.71% smaller, saving 44,593,847 bytes. This combines dependency cleanup and minification. The complete unpacked Windows application is 11.08% smaller. Local unpacked Windows packaging passed for both builds.

Twenty injected health updates caused 23 CLI renders on the baseline, including concurrent periodic updates, and zero on the optimized build. The optimized run used a populated five-product fixture. CLI events and its own controls still update normally.

Whole-app resident-memory savings were not established by a controlled long-running comparison. Electron's base runtime cost remains. The changes reduce repeated native work, rendering, and shipped package content without reducing scan frequency.

Raw local evidence is under `.cache/optimization/`, including `process-sampling-benchmark.json`, `baseline-render-commits.json`, `final-ui-result.json`, build logs, and light/dark Settings screenshots. Benchmark reproduction: `node scripts/benchmark-process-sampling.cjs`.

## Verification

- `npm test`: 201 passed, zero failures, two Windows-inapplicable symlink/POSIX checks skipped.
- `node --test scripts/scanner-sampling.test.cjs`: three passed, including multi-port histories, overlapping scans, and unavailable AHK metadata.
- `npm run test:startup`: 15 passed.
- Native Windows stop/discovery integration: seven scenarios passed, including IPv4/IPv6, selected and project stops, stale selection rejection, application stop, and external-stop retirement. Generated dummy processes were cleaned up. An earlier attempt ended with a native-helper inspection error during the tooling interruption; the completed rerun passed.
- TypeScript, ESLint, production build, and the full installed dependency graph passed.
- The packaged Windows executable passed startup, Settings, Radix font selection, all five active font assets, a five-product fixture CLI scan, and More services opening/closing, with zero renderer errors. The packaged test app was closed afterward.
- Native Electron UI: eight animation/focus checks passed, including populated CLI expansion, ENV editor cancellation, intermediate entrance/exit frames, and reduced motion. No renderer errors were recorded.
- Save changed the isolated profile's interval to 6,000 ms. Confirmed Reset restored it to 5,000 ms.
- At 900 by 600 pixels, the Settings footer stayed at the same vertical position when scrolling from top to bottom. Save and Reset remained visible. Both light and dark layouts were visually inspected.

CLI scans in UI verification used the existing simulated provider. No real CLI package was uninstalled. Native macOS behavior, update installation, and the separate live start/restart suites were not exercised in this shortened Windows verification run.
