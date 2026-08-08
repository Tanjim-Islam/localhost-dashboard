import fs from "node:fs/promises";
import path from "node:path";
import type {
  CleanerDirectoryEntry,
  CleanerFileStat,
  CleanerFilesystem,
} from "../types";

export class RealCleanerFilesystem implements CleanerFilesystem {
  async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async lstat(targetPath: string): Promise<CleanerFileStat> {
    const stat = await fs.lstat(targetPath, { bigint: true });
    const size = toSafeNumber(stat.size);
    const blockBytes = toSafeNumber(stat.blocks * 512n);
    const blockSize = toSafeNumber(stat.blksize);
    const device = toPositiveSafeNumber(stat.dev);
    const inode = toPositiveSafeNumber(stat.ino);
    const hardlinkCount = toPositiveSafeNumber(stat.nlink);
    const hasFileIdentity = stat.ino > 0n;
    const driveRoot = path.win32
      .parse(path.win32.normalize(targetPath))
      .root.toLowerCase();
    const estimatedAllocatedBytes =
      size === 0
        ? 0
        : blockSize > 0
          ? Math.ceil(size / blockSize) * blockSize
          : undefined;
    const hasAuthoritativeBlockCount = blockBytes > 0 || size === 0;
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      isReparsePoint: stat.isSymbolicLink(),
      size,
      modifiedMs: Number(stat.mtimeMs),
      device,
      inode,
      volumeIdentity:
        driveRoot.length > 0
          ? `${driveRoot}\0${stat.dev.toString()}`
          : undefined,
      fileIdentity: hasFileIdentity ? stat.ino.toString() : undefined,
      hardlinkCount,
      allocatedBytes: hasAuthoritativeBlockCount
        ? blockBytes
        : estimatedAllocatedBytes,
      allocationConfidence: hasAuthoritativeBlockCount
        ? "exact"
        : estimatedAllocatedBytes === undefined
          ? undefined
          : "estimated",
      sparse:
        hasAuthoritativeBlockCount && size > 0 ? blockBytes < size : undefined,
      compressed: undefined,
    };
  }

  async readDirectory(targetPath: string): Promise<CleanerDirectoryEntry[]> {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async *readDirectoryBatches(
    targetPath: string,
    batchSize = 256,
  ): AsyncIterable<CleanerDirectoryEntry[]> {
    const directory = await fs.opendir(targetPath);
    let batch: CleanerDirectoryEntry[] = [];
    for await (const entry of directory) {
      batch.push({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      });
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  realPath(targetPath: string): Promise<string> {
    return fs.realpath(targetPath);
  }

  unlink(targetPath: string): Promise<void> {
    return fs.unlink(targetPath);
  }

  removeReparsePoint(targetPath: string): Promise<void> {
    return fs.rm(targetPath, { recursive: false, force: false });
  }

  removeDirectory(targetPath: string): Promise<void> {
    return fs.rmdir(targetPath);
  }

  async getSizeOverride(_targetPath: string): Promise<number | undefined> {
    return undefined;
  }

  async getAllocationUnit(targetPath: string): Promise<number | undefined> {
    try {
      const stat = await fs.statfs(targetPath, { bigint: true });
      return toSafeNumber(stat.bsize);
    } catch {
      return undefined;
    }
  }
}

export function joinCleanerPath(...parts: string[]): string {
  return path.win32.join(...parts);
}

function toSafeNumber(value: bigint): number {
  const converted = Number(value);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : 0;
}

function toPositiveSafeNumber(value: bigint): number | undefined {
  const converted = Number(value);
  return Number.isSafeInteger(converted) && converted > 0
    ? converted
    : undefined;
}
