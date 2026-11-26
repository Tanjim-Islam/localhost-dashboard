# Electron to Tauri verification

The comparison uses the published Windows x64 Electron 1.13.0 app and the `rust-build` rewrite. The baseline source commit is `f21d81c831a43402763d3bbea5fe39b779bc168e`. Both builds use the same React screens and assets. The new executable hosts WebView2 on Windows and WKWebView on macOS. Data migration, scanning, process actions, package inventory and OS integration run in Rust.

## Windows checks

| Area | What was exercised |
| --- | --- |
| Discovery and native actions | IPv4 and IPv6, arbitrary ports, slow and failed HTTP checks, shared processes, disappearing listeners, ignored projects and stale identities. Disposable Node, Vite, npm workspace, watcher and Python processes exercised stop, restart and start again. The tests checked working directories, arguments, sibling survival and ownership of replacement ports. |
| Project UI | Edited a project, saved notes, pinned it, searched with hidden selections, blocked stop on an ignored project, stopped selected services, restarted a stopped service from its drawer, and reopened the app to verify persistence. |
| CLI inventory | Ran both backends read-only on the same Windows machine. Each found 91 installed products, 187 bundled installations and the same 11 eligible package installations. Verified all 903 active command records against PATH. The native scanner recognized five additional Visual Studio helpers as unadmitted candidates and resolved an ambiguous Python owner using its wheel checksum. |
| CLI actions | Checked cancellation and cached inventory, a forced verification, exact uninstall preview and cancellation, and simulated failure and success through the actual WebView. Rust tests covered each supported manager, changed ownership, changed executable and expired, mismatched or replayed tokens. The tests left installed packages intact. |
| AutoHotkey | Used AutoHotkey v2.0.19 and a generated script with spaces in its path. Tracked distinct processes through discovery, card restart and stop, then started the script from Recently Used and removed its entry. Checked the script file remained intact. |
| Environment keys | Created, revealed, masked, renamed and deleted unique temporary user values through the WebView and native Windows registry. Exercised Unicode, deletion cancellation and scope permissions. |
| Desktop shell | Checked minimize, maximize, restore, close-to-tray, native tray callback, startup visibility and physical Windows registration APIs. Isolated window-station tests read and wrote a real clipboard and registered competing shortcuts without disturbing the interactive desktop. |
| Scan folders | Selected a generated directory through the real Windows folder picker, selected it again to check deduplication, cancelled another selection and removed it after restart. The directory contents survived. Repeated with a Windows short path for TEMP. |
| Existing installations | A hosted Windows runner installed the checksum-pinned Electron 1.13.0 release and upgraded it with NSIS. The native app started, imported the saved settings and removed the stale disabled login item. Local tests imported a read-only copy of the existing profile. WebView tests checked projects, legacy notes, stats, settings, recent scripts, CLI cache and Chromium preferences across launches. An unreadable optional Chromium database leaves the app usable. Temporary SQLite databases exercised the Mac settings schema and its JSON fallback on Windows. |
| Builds and updates | Built the x64 release executable and NSIS installer. Exercised the development launcher, Vite client, IPC and normal exit. The updater downloaded a harmless signed file from a loopback feed and rejected altered bytes and a mismatched signed version. Release feed tests checked both updater generations with disposable signing keys. |

On macOS 15, the Apple Silicon runner exercised the native process lifecycle, including Node, npm workspace hooks, a watcher, Vite and Python. It built the application bundle, observed its dashboard window, sent a native Quit request, verified exit status zero and read the flushed project store. Ubuntu 24.04 passed its native tests, including real IPv4 and IPv6 listener discovery, and built the desktop executable. Interactive testing on a physical Mac, Intel execution, Gatekeeper and a production-signed public update are separate from those runs. [macOS run](https://github.com/Tanjim-Islam/localhost-dashboard/actions/runs/45907676783/job/140208232731) · [Linux run](https://github.com/Tanjim-Islam/localhost-dashboard/actions/runs/45907676783/job/140208232636)

## Visual comparison

The Windows production stylesheet is byte-identical to the Electron build. Its SHA-256 is `96acee302bbc3e54422548a2c30b0b8c96f3b4fad6cbc4bf7935da01e64dcea1`. A WebView test compares the title-bar and Settings controls against captured Electron computed styles, including foreground and background colors, font families, corner radii and geometry. The renderer tests check semantic colors across every palette.

In the 1100 × 720 Settings screenshots, 59.34% of pixels matched exactly. Just 0.027% differed by more than 12 levels in any RGB channel. These measurements describe that Windows screen, DPI and browser runtime. Other screens received functional checks. The two rendering engines can produce small differences in the final pixels.

## Windows resource comparison

The benchmark alternated three launches per executable. Each launch used a fresh fixture profile. Both apps found the same 21 local listeners. The sample includes the desktop process and its browser children 15 seconds after listener discovery. No manual CLI scan ran during sampling.

| Measurement | Electron 1.13.0 | Rust and Tauri |
| --- | ---: | ---: |
| Windows x64 installer | 100,758,236 bytes | 5,598,810 bytes |
| Total private memory, median | 338.7 MiB | 203.0 MiB |
| Total working set, median | 487.0 MiB | 396.1 MiB |
| Window content ready, median | 898 ms | 534 ms |
| First listeners available, median | 925 ms | 575 ms |

Private memory was 40.1% lower in this run. Two earlier three-pair comparisons on this machine measured 39.6% and 40.7% lower private memory. Startup ordering varied. In the first comparison, median window readiness was 1,261 ms for Electron and 1,335 ms for Tauri. The small Tauri installer uses the Windows WebView2 runtime. Installing that runtime on a machine that lacks it requires an additional download.

To repeat the comparison on Windows, run `node scripts/benchmark-windows.mjs "<installed Electron executable>" "<Tauri release executable>"`. The script writes the six individual observations to a temporary results file. The sample covers one workload on one machine.

## Reproducing the checks

Use Node.js 24 and a stable Rust toolchain. Run these commands from the repository root.

```sh
npm ci
npm run lint
npx tsc --noEmit
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
npm test
node --test scripts/release.test.mjs
```

For the Windows GUI and development launcher, run `npm run test:desktop`, `node scripts/desktop-shell.mjs` and `node scripts/check-dev-launch.mjs`. The real AutoHotkey case requires an installed v2 interpreter. To include all opt-in native tests, set `DASHBOARD_LEGACY_PROFILE` to the absolute path of an existing Electron profile, then run `cargo test --locked --manifest-path src-tauri/Cargo.toml -- --include-ignored --test-threads=1`. The profile test copies data to a temporary directory. The live CLI scan reads the local inventory.

Build an installer with `npm run package -- --bundles nsis -- --locked`. The Windows release executable is under `src-tauri/target/release` and the installer is under `bundle/nsis` in that directory. The package and retained profile share the version number 1.13.0 for this branch comparison. A public update needs a newer version and the signing configuration in the [release procedure](RELEASING.md).
