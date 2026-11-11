# Dependency audit

Audited on 2026-11-07 against this checkout, including source imports, CSS imports, TypeScript declarations, npm scripts, build configuration, integration scripts, and GitHub workflows. A missing source import alone is not grounds to remove a build tool or a platform dependency.

## Changes

- Removed five unused direct dependencies: `@fontsource-variable/geist`, `find-process`, `lodash`, `concurrently`, and `cross-env`.
- Moved twelve renderer-only dependencies into `devDependencies`. Vite bundles their used code and font assets into `dist`, so the installed Electron app does not need a second copy of their source packages in `node_modules`.
- Kept all active font choices, native process metrics, login integration, and both platform update systems.
- Kept every retained package at its existing locked version.

| Measure | Before | After |
| --- | ---: | ---: |
| Direct dependencies, including development | 39 | 34 |
| Direct runtime dependencies | 21 | 6 |
| Direct development dependencies | 18 | 28 |
| Lockfile package entries, excluding the root | 749 | 738 |
| Lockfile package entries marked production | 204 | 137 |

The eleven packages removed from the lockfile occupied 5,418,049 bytes and 2,493 files in the Windows installation before pruning, excluding npm command shims. This is a disk reduction, not a measured RAM saving. `lodash` remains installed as a transitive dependency of maintained packages; only its unused direct declaration was removed.

## Every direct dependency

| Package | Decision | Evidence or purpose |
| --- | --- | --- |
| `@fontsource-variable/geist` | Remove | No CSS import or font preset uses the sans family. Geist Mono is a separate package. |
| `@fontsource-variable/geist-mono` | Keep, move to development | Imported by `styles.css`, used for monospace text and the font picker. |
| `@fontsource-variable/inter` | Keep, move to development | Imported by `styles.css`, current default font and a font preset. |
| `@fontsource-variable/manrope` | Keep, move to development | Imported by `styles.css`, selectable font preset. |
| `@fontsource-variable/noto-sans-bengali` | Keep, move to development | Imported by `styles.css`, selectable Bengali font preset. |
| `@fontsource-variable/plus-jakarta-sans` | Keep, move to development | Imported by `styles.css`, selectable font preset. |
| `@radix-ui/react-select` | Keep, move to development | Accessible select primitive in `components/ui/select.tsx`. |
| `auto-launch` | Keep at runtime | Linux login integration and cleanup of legacy login registration in `main/index.ts`. Its local type declaration is still used. |
| `classnames` | Keep, move to development | Conditional classes in script cards, buttons, drawer, and select. |
| `dayjs` | Keep, move to development | Relative times and formatted timestamps in script cards and the recent scripts drawer. |
| `electron-sparkle-updater` | Keep at runtime | Native macOS updates, universal bridge build, packaging hook, and signed appcast workflow. |
| `electron-store` | Keep at runtime | Settings, CLI inventory, projects, stats, recent scripts, and legacy notes. |
| `electron-updater` | Keep at runtime | Windows and Linux updates. It does not replace Sparkle on macOS. |
| `find-process` | Remove | No imports or script/config uses. Discovery uses systeminformation and native helpers. |
| `framer-motion` | Keep, move to development | Existing animation library, used for menus, drawers, dialogs, disclosures, and buttons. |
| `lodash` | Remove direct declaration | No application import. Transitive consumers keep their own dependency. |
| `lucide-react` | Keep, move to development | UI icons throughout the renderer. |
| `pidusage` | Keep at runtime | CPU and memory sampling, now shared and batched by `main/process-sampling.ts`. |
| `react` | Keep, move to development | Renderer components and hooks, bundled by Vite. |
| `react-dom` | Keep, move to development | Renderer root and portals, bundled by Vite. |
| `systeminformation` | Keep at runtime | Process and TCP inventory. Its role differs from pidusage's interval-based CPU sampling. |
| `@types/node` | Keep in development | Node APIs in main, scripts, and tests; explicitly enabled in tsconfig. |
| `@types/pidusage` | Keep in development | Types for the retained metric sampler. |
| `@types/react` | Keep in development | JSX, React hooks, component props, and Electron CSS augmentation. |
| `@types/react-dom` | Keep in development | React DOM root and portal types; explicitly enabled in tsconfig. |
| `@typescript-eslint/eslint-plugin` | Keep in development | Rules loaded by `eslint.config.js`. |
| `@typescript-eslint/parser` | Keep in development | TypeScript/TSX parser loaded by `eslint.config.js`. |
| `@vitejs/plugin-react` | Keep in development | React transformation and development refresh in `electron.vite.config.ts`. |
| `autoprefixer` | Keep in development | PostCSS plugin configured in `postcss.config.cjs`. |
| `concurrently` | Remove | No npm script, workflow, or source invokes it. |
| `cross-env` | Remove | No npm script, workflow, or source invokes it. |
| `electron` | Keep in development | Development runtime, Electron API types, integration launches, and the packaged runtime binary. |
| `electron-builder` | Keep in development | Windows/macOS/Linux packaging and release workflows. |
| `electron-vite` | Keep in development | Main/preload/renderer build and development orchestration. |
| `eslint` | Keep in development | `npm run lint`. |
| `postcss` | Keep in development | CSS transformation pipeline for Tailwind and Autoprefixer. |
| `tailwindcss` | Keep in development | CSS generation, theme configuration, and utilities. |
| `typescript` | Keep in development | Type checking and deterministic test compilation. |
| `vite` | Keep in development | Required electron-vite peer, renderer build, and live Vite restart fixtures. |

## Overlap and boundaries

- React and React DOM, ESLint and its TypeScript parser/plugin, and Vite and electron-vite each serve different layers.
- Radix Select handles keyboard/focus behavior. Framer Motion supplies transitions. They are not interchangeable.
- Font families are user-selectable features, not redundant libraries to remove. The older Geist-only sentence in AGENTS.md does not describe the current font picker.
- `auto-launch` still handles supported cases outside Electron's native login-item path and legacy registration removal.
- Native macOS dependencies are retained even though this audit runs on Windows. A Windows test cannot establish macOS runtime behavior.
- Transitive packages were pruned through npm's resolved graph. No manually selected transitive package was deleted.

Two existing tool assumptions remain: formatting scripts reference Prettier without declaring it, and native UI integration scripts accept Playwright through `DASHBOARD_PLAYWRIGHT_MODULE`. Neither was silently replaced or removed as part of this cleanup.

## Local validation

- `npm ls --all --json` completed with no dependency problems.
- npm removed eleven obsolete packages, without changing any retained locked version.
- Both the original source snapshot and optimized checkout packaged successfully as local Windows x64 unpacked applications. The baseline used a physical copy of its original production dependencies because a shared dependency junction confused the packaging collector.
- Combined dependency and bundle optimizations reduced `resources/app.asar` from 61,329,929 to 16,736,082 bytes, a 72.7% reduction. The full unpacked application, including the unchanged Electron runtime, decreased from 402,651,875 to 358,058,028 bytes, an 11.1% reduction.
- The optimized packaged executable passed startup, Settings, the Radix font picker, loading all five font families, a fixture-only CLI scan with five products, and opening/closing More services. No renderer errors occurred. These checks used isolated test data and did not run real package-manager mutations.
- These package-size measurements include the concurrent bundle-minification changes. They are not an isolated estimate of dependency cleanup alone and are not RAM measurements.

Local QA artifacts are under `.cache/optimization/`, outside version control. No installer was published or installed. macOS packaging and native runtime checks were not run on this Windows host.
