import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  isWindowsPathInside,
  normalizeWindowsPath,
  sameWindowsPath,
} from "../path-normalization";
import type { CleanerFilesystem } from "../types";
import {
  CLEANER_TEST_MANIFEST,
  CLEANER_TEST_SENTINEL,
  type CleanerFixtureManifest,
} from "./filesystem";
import { RealCleanerFilesystem } from "./real-filesystem";

export class TestCleanerFilesystem implements CleanerFilesystem {
  private readonly real = new RealCleanerFilesystem();
  private readonly normalizedRoot: string;
  private manifestCache?: CleanerFixtureManifest;

  constructor(private readonly testRoot: string) {
    this.normalizedRoot = normalizeWindowsPath(testRoot);
  }

  async exists(targetPath: string): Promise<boolean> {
    this.assertReadable(targetPath);
    if (await this.getVirtualFileStat(targetPath)) return true;
    return this.real.exists(targetPath);
  }

  async lstat(targetPath: string) {
    this.assertReadable(targetPath);
    const virtual = await this.getVirtualFileStat(targetPath);
    if (virtual) return virtual;
    return this.real.lstat(targetPath);
  }

  async readDirectory(targetPath: string) {
    this.assertReadable(targetPath);
    const virtual = await this.getVirtualTree(targetPath);
    if (virtual) {
      return Array.from({ length: virtual.fileCount }, (_, index) => ({
        name: virtualFileName(index),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }));
    }
    return this.real.readDirectory(targetPath);
  }

  async *readDirectoryBatches(targetPath: string, batchSize = 256) {
    this.assertReadable(targetPath);
    const virtual = await this.getVirtualTree(targetPath);
    if (virtual) {
      for (let offset = 0; offset < virtual.fileCount; offset += batchSize) {
        const count = Math.min(batchSize, virtual.fileCount - offset);
        yield Array.from({ length: count }, (_, index) => ({
          name: virtualFileName(offset + index),
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        }));
      }
      return;
    }
    yield* this.real.readDirectoryBatches(targetPath, batchSize);
  }

  async realPath(targetPath: string): Promise<string> {
    this.assertReadable(targetPath);
    return this.real.realPath(targetPath);
  }

  async unlink(targetPath: string): Promise<void> {
    await this.assertDeletable(targetPath);
    await this.real.unlink(targetPath);
  }

  async removeReparsePoint(targetPath: string): Promise<void> {
    await this.assertDeletable(targetPath);
    await this.real.removeReparsePoint(targetPath);
  }

  async removeDirectory(targetPath: string): Promise<void> {
    await this.assertDeletable(targetPath);
    await this.real.removeDirectory(targetPath);
  }

  async getSizeOverride(targetPath: string): Promise<number | undefined> {
    this.assertReadable(targetPath);
    const manifest = await this.readManifest();
    return manifest.sizeOverrides[normalizeWindowsPath(targetPath)];
  }

  async getAccountingOverride(
    targetPath: string,
    policyKind?: "standard-bounded" | "deep-exhaustive",
  ) {
    this.assertReadable(targetPath);
    const manifest = await this.readManifest();
    const normalizedPath = normalizeWindowsPath(targetPath);
    if (policyKind === "standard-bounded") {
      return (
        manifest.standardAccountingOverrides?.[normalizedPath] ??
        manifest.accountingOverrides?.[normalizedPath]
      );
    }
    return manifest.accountingOverrides?.[normalizedPath];
  }

  async getAllocationUnit(targetPath: string): Promise<number | undefined> {
    this.assertReadable(targetPath);
    return this.real.getAllocationUnit(targetPath);
  }

  async readManifest(fresh = false): Promise<CleanerFixtureManifest> {
    if (!fresh && this.manifestCache) return this.manifestCache;
    const raw = await fs.readFile(
      path.join(this.testRoot, CLEANER_TEST_MANIFEST),
      "utf8",
    );
    const parsed = JSON.parse(raw) as CleanerFixtureManifest;
    if (
      parsed.version !== 2 ||
      !Array.isArray(parsed.createdPaths) ||
      !parsed.evidence ||
      !Array.isArray(parsed.evidence.sources) ||
      !Array.isArray(parsed.evidence.processes)
    ) {
      throw new Error("Cleaner fixture manifest is invalid.");
    }
    this.manifestCache = parsed;
    return parsed;
  }

  private assertReadable(targetPath: string): void {
    if (!isWindowsPathInside(targetPath, this.testRoot)) {
      throw new Error(
        "Cleaner test mode refused a path outside its fixture root.",
      );
    }
  }

  private async getVirtualTree(targetPath: string) {
    const manifest = await this.readManifest();
    return manifest.virtualTrees?.[normalizeWindowsPath(targetPath)];
  }

  private async getVirtualFileStat(targetPath: string) {
    const manifest = await this.readManifest();
    for (const [root, definition] of Object.entries(
      manifest.virtualTrees ?? {},
    )) {
      if (!isWindowsPathInside(targetPath, root)) continue;
      if (
        normalizeWindowsPath(path.dirname(targetPath)) !==
        normalizeWindowsPath(root)
      ) {
        continue;
      }
      const match = /^virtual-(\d{6})\.bin$/i.exec(path.basename(targetPath));
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index >= definition.fileCount) continue;
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        isReparsePoint: false,
        size: definition.logicalBytesPerFile,
        modifiedMs: manifest.createdAt,
        volumeIdentity: definition.volumeIdentity,
        fileIdentity: `virtual-${index}`,
        hardlinkCount: 1,
        allocatedBytes: definition.allocatedBytesPerFile,
        allocationConfidence: "estimated" as const,
        sparse: false,
        compressed: false,
      };
    }
    return undefined;
  }

  private async assertDeletable(targetPath: string): Promise<void> {
    this.assertReadable(targetPath);
    const configuredRoot = process.env["LOCAL_DASHBOARD_CLEANER_TEST_ROOT"];
    if (!configuredRoot || !sameWindowsPath(configuredRoot, this.testRoot)) {
      throw new Error("Cleaner test root environment guard failed.");
    }
    const sentinelPath = path.join(this.testRoot, CLEANER_TEST_SENTINEL);
    if (!(await this.real.exists(sentinelPath))) {
      throw new Error("Cleaner test sentinel is missing.");
    }

    const normalizedTarget = normalizeWindowsPath(targetPath);
    if (normalizedTarget === this.normalizedRoot) {
      throw new Error("Cleaner tests cannot delete the fixture root itself.");
    }
    const profile = normalizeWindowsPath(os.homedir());
    const appData = process.env["APPDATA"];
    const localAppData = process.env["LOCALAPPDATA"];
    if (
      normalizedTarget === profile ||
      (appData && sameWindowsPath(targetPath, appData)) ||
      (localAppData && sameWindowsPath(targetPath, localAppData))
    ) {
      throw new Error("Cleaner tests cannot delete profile or AppData roots.");
    }

    const manifest = await this.readManifest();
    const createdByThisFixture = manifest.createdPaths.some((createdPath) =>
      isWindowsPathInside(targetPath, createdPath),
    );
    if (!createdByThisFixture) {
      throw new Error(
        "Cleaner tests can delete only paths created by this fixture.",
      );
    }
  }
}

function virtualFileName(index: number): string {
  return `virtual-${String(index).padStart(6, "0")}.bin`;
}
