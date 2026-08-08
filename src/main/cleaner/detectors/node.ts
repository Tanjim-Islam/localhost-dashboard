import path from "node:path";
import type { CleanerDetector, CleanerDetectorContext } from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

export class NodeCacheDetector implements CleanerDetector {
  readonly id = "dev.node";
  readonly category = "Node.js and JavaScript";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const { home, localAppData } = context.environment;
    return keepExistingCandidates(context, [
      candidate({
        detectorId: "dev.npm-cache",
        category: this.category,
        displayName: "npm content cache",
        applicationName: "npm",
        path: path.join(localAppData, "npm-cache", "_cacache"),
        baseSafety: "safe-now",
        reason:
          "Exact npm content-addressed cache path. It contains downloaded package data, not installed project dependencies.",
        consequences: [
          "Packages will be downloaded again when npm needs them.",
        ],
        restoration: "npm recreates this cache automatically.",
        relatedProcessNames: ["node", "npm", "npx"],
        dataKind: "download-cache",
        processMatchRules: [
          {
            commandCategories: ["npm-cache-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "npm", "npx"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.npx-cache",
        category: this.category,
        displayName: "npx execution cache",
        applicationName: "npx",
        path: path.join(localAppData, "npm-cache", "_npx"),
        baseSafety: "safe-now",
        reason:
          "Exact npx cache path containing temporary downloaded command packages.",
        consequences: ["npx commands may download their packages again."],
        restoration: "npx recreates entries on demand.",
        relatedProcessNames: ["node", "npm", "npx"],
        dataKind: "download-cache",
        processMatchRules: [
          {
            commandCategories: ["npx-execution"],
            allowExecutableInsideTarget: true,
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "npm", "npx"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.yarn-cache",
        category: this.category,
        displayName: "Yarn package cache",
        applicationName: "Yarn",
        path: path.join(localAppData, "Yarn", "Cache"),
        baseSafety: "safe-now",
        reason:
          "Exact Yarn package cache path used for downloaded package archives.",
        consequences: ["Yarn may redownload packages."],
        restoration: "Yarn recreates the cache automatically.",
        relatedProcessNames: ["node", "yarn"],
        dataKind: "download-cache",
        processMatchRules: [
          {
            commandCategories: ["yarn-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "yarn"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.pnpm-cache",
        category: this.category,
        displayName: "pnpm metadata cache",
        applicationName: "pnpm",
        path: path.join(localAppData, "pnpm-cache"),
        baseSafety: "safe-now",
        reason:
          "Exact pnpm cache path containing regenerable metadata and downloads.",
        consequences: ["pnpm may redownload metadata or packages."],
        restoration: "pnpm recreates this cache on demand.",
        relatedProcessNames: ["node", "pnpm"],
        dataKind: "ordinary-cache",
        processMatchRules: [
          {
            commandCategories: ["pnpm-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "pnpm"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.pnpm-store",
        category: this.category,
        displayName: "pnpm content-addressable store",
        applicationName: "pnpm",
        path: path.join(localAppData, "pnpm", "store"),
        baseSafety: "conditional",
        reason:
          "Recognized pnpm package store. Projects can reference this shared store, so it is not an ordinary temporary cache.",
        consequences: [
          "Packages may be downloaded again.",
          "Existing projects may need pnpm install before they work normally.",
        ],
        restoration: "Run pnpm install in affected projects.",
        relatedProcessNames: ["node", "pnpm"],
        dataKind: "shared-dependency-store",
        ownershipStatus: "shared",
        processMatchRules: [
          {
            commandCategories: ["pnpm-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "pnpm"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.bun-cache",
        category: this.category,
        displayName: "Bun package cache",
        applicationName: "Bun",
        path: path.join(home, ".bun", "install", "cache"),
        baseSafety: "safe-now",
        reason:
          "Exact Bun download cache path. Installed project files are not included.",
        consequences: ["Bun will redownload packages when needed."],
        restoration: "Bun recreates this cache automatically.",
        relatedProcessNames: ["bun"],
        dataKind: "download-cache",
        processMatchRules: [
          {
            commandCategories: ["bun-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["bun"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.corepack-cache",
        category: this.category,
        displayName: "Corepack package-manager cache",
        applicationName: "Corepack",
        path: path.join(localAppData, "node", "corepack"),
        baseSafety: "safe-now",
        reason:
          "Exact Corepack download cache for package-manager distributions.",
        consequences: ["Corepack may redownload a package-manager version."],
        restoration: "Corepack restores distributions on demand.",
        relatedProcessNames: ["node", "corepack"],
        dataKind: "download-cache",
        processMatchRules: [
          {
            commandCategories: ["corepack-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "corepack"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.node-gyp-cache",
        category: this.category,
        displayName: "node-gyp header cache",
        applicationName: "node-gyp",
        path: path.join(localAppData, "node-gyp", "Cache"),
        baseSafety: "safe-now",
        reason: "Exact node-gyp downloaded header cache.",
        consequences: ["Native module builds may redownload Node headers."],
        restoration: "node-gyp recreates the cache during a future build.",
        relatedProcessNames: ["node", "node-gyp", "msbuild"],
        dataKind: "download-cache",
        processMatchRules: [
          {
            commandCategories: ["node-gyp-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "node-gyp", "msbuild"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.electron-download-cache",
        category: this.category,
        displayName: "Electron download cache",
        applicationName: "Electron",
        path: path.join(localAppData, "electron", "Cache"),
        baseSafety: "safe-now",
        reason:
          "Exact Electron binary download cache, separate from installed applications and app state.",
        consequences: ["Electron packages may download binaries again."],
        restoration: "A future Electron install recreates the cache.",
        relatedProcessNames: ["node", "electron"],
        dataKind: "download-cache",
        processMatchRules: [
          {
            commandCategories: ["electron-download"],
            allowReferencedTarget: true,
            weakNameWarnings: ["node", "electron"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "dev.playwright",
        category: this.category,
        displayName: "Playwright browser downloads",
        applicationName: "Playwright",
        path: path.join(localAppData, "ms-playwright"),
        baseSafety: "protected",
        reason:
          "Protected by default. These downloaded browsers are executable test dependencies, not ordinary temporary data.",
        consequences: [
          "Playwright tests may fail until browsers are reinstalled.",
        ],
        restoration:
          "Run the project's Playwright browser installation command.",
        relatedProcessNames: [
          "node",
          "playwright",
          "chrome",
          "chromium",
          "firefox",
          "webkit",
        ],
        dataKind: "installed-runtime",
        canDelete: false,
      }),
      candidate({
        detectorId: "dev.puppeteer",
        category: this.category,
        displayName: "Puppeteer browser downloads",
        applicationName: "Puppeteer",
        path: path.join(home, ".cache", "puppeteer"),
        baseSafety: "protected",
        reason:
          "Protected by default. These browser binaries are development dependencies, not ordinary temporary data.",
        consequences: [
          "Puppeteer workflows may fail until the browser is downloaded again.",
        ],
        restoration:
          "Reinstall the Puppeteer browser dependency through the project package manager.",
        relatedProcessNames: ["node", "chrome", "chromium"],
        dataKind: "installed-runtime",
        canDelete: false,
      }),
    ]);
  }
}
