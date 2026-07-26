import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { CleanerCancellationToken } from "../src/main/cleaner/cancellation";
import { CleanerSizeCalculator } from "../src/main/cleaner/size-calculator";
import type {
  CleanerFileStat,
  CleanerFilesystem,
} from "../src/main/cleaner/types";
import {
  createCleanerFixture,
  removeCleanerFixture,
  updateFixtureManifest,
} from "./cleaner-test-helpers";
import { TestCleanerFilesystem } from "../src/main/cleaner/adapters/test-filesystem";

test("file-record accounting de-duplicates internal hardlinks and excludes external links from recovery", async (t) => {
  if (process.platform !== "win32") {
    t.skip("NTFS hardlink accounting is Windows-specific.");
    return;
  }
  const root = await createCleanerFixture();
  try {
    const target = path.join(root, "Accounting", "target");
    const external = path.join(root, "Accounting", "external");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(external, { recursive: true });
    await updateFixtureManifest(root, (manifest) => {
      manifest.createdPaths.push(target, external);
    });

    const normal = Buffer.alloc(1_113, 1);
    const internal = Buffer.alloc(4_777, 2);
    const externallyShared = Buffer.alloc(8_333, 3);
    await fs.writeFile(path.join(target, "normal.bin"), normal);
    const internalFirst = path.join(target, "internal-a.bin");
    await fs.writeFile(internalFirst, internal);
    await fs.link(internalFirst, path.join(target, "internal-b.bin"));
    const sharedInside = path.join(target, "shared-inside.bin");
    await fs.writeFile(sharedInside, externallyShared);
    await fs.link(sharedInside, path.join(external, "shared-outside.bin"));

    const measured = await new CleanerSizeCalculator(
      new TestCleanerFilesystem(root),
      new CleanerCancellationToken(),
    ).measure(target);

    assert.equal(
      measured.logicalBytes,
      normal.length + internal.length * 2 + externallyShared.length,
    );
    assert.equal(measured.measurementCompleteness, "complete");
    assert.equal(measured.hardlinkRecordCount, 2);
    assert.equal(measured.externalHardlinkRecordCount, 1);
    assert.ok(measured.allocatedBytes !== null);
    assert.ok(measured.uniqueAllocatedBytes !== null);
    assert.ok(
      (measured.allocatedBytes ?? 0) > (measured.uniqueAllocatedBytes ?? 0),
    );
    assert.ok(measured.estimatedReclaimableBytes !== null);
    assert.ok(
      (measured.estimatedReclaimableBytes ?? 0) <
        (measured.uniqueAllocatedBytes ?? 0),
    );
    assert.ok(
      measured.logicalBytes > (measured.estimatedReclaimableBytes ?? 0),
      "hardlinked logical bytes never become the physical recovery total",
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("complete logical measurement with unavailable file identity never invents physical recovery", async () => {
  const root = "C:\\fixture\\accounting";
  const file = `${root}\\file.bin`;
  const filesystem: CleanerFilesystem = mockFilesystem(
    root,
    new Map([
      [root, directoryStat()],
      [file, fileStat({ size: 512 })],
    ]),
  );
  const measured = await new CleanerSizeCalculator(
    filesystem,
    new CleanerCancellationToken(),
  ).measure(root);

  assert.equal(measured.logicalBytes, 512);
  assert.equal(measured.measurementCompleteness, "complete");
  assert.equal(measured.estimatedReclaimableBytes, null);
  assert.equal(measured.accountingConfidence, "unknown");
  assert.equal(measured.measurementLimitReason, "metadata-unavailable");
});

test("Deep accounting reports access denial as a genuine failure, not a timeout", async () => {
  const root = "C:\\fixture\\access-failure";
  const inaccessible = `${root}\\blocked.bin`;
  const baseFilesystem = mockFilesystem(
    root,
    new Map([
      [root, directoryStat()],
      [inaccessible, fileStat({ fileIdentity: "blocked" })],
    ]),
  );
  const filesystem: CleanerFilesystem = {
    ...baseFilesystem,
    async lstat(target) {
      if (target === inaccessible) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return baseFilesystem.lstat(target);
    },
  };
  const measured = await new CleanerSizeCalculator(
    filesystem,
    new CleanerCancellationToken(),
  ).measure(root);

  assert.equal(measured.measurementCompleteness, "partial");
  assert.equal(measured.logicalTraversalComplete, false);
  assert.equal(measured.physicalAccountingComplete, false);
  assert.equal(measured.measurementFailureCategory, "access-denied");
  assert.equal(measured.measurementLimitReason, "inaccessible-entries");
  assert.doesNotMatch(measured.measurementFailureExplanation ?? "", /time/i);
});

test("partial accounting is a logical lower bound and is never exact recovery", async () => {
  const root = "C:\\fixture\\bounded";
  const files = new Map<string, CleanerFileStat>([
    [root, directoryStat()],
    [
      `${root}\\a.bin`,
      fileStat({ size: 128, fileIdentity: "1", hardlinkCount: 2 }),
    ],
    [
      `${root}\\b.bin`,
      fileStat({ size: 256, fileIdentity: "2", hardlinkCount: 2 }),
    ],
  ]);
  const measured = await new CleanerSizeCalculator(
    mockFilesystem(root, files),
    new CleanerCancellationToken(),
    {
      policy: {
        kind: "standard-bounded",
        maxEntries: 2,
        maxDurationMs: 60_000,
        maxTrackedFileRecords: 10,
      },
    },
  ).measure(root);

  assert.equal(measured.measurementCompleteness, "partial");
  assert.equal(measured.accountingConfidence, "lower-bound");
  assert.equal(measured.estimatedReclaimableBytes, null);
  assert.equal(measured.measurementLimitReason, "entry-limit");
});

test("Standard measurement still respects its configured target duration", async () => {
  const root = "C:\\fixture\\duration-bounded";
  const file = `${root}\\file.bin`;
  const baseFilesystem = mockFilesystem(
    root,
    new Map([
      [root, directoryStat()],
      [file, fileStat({ size: 128, fileIdentity: "duration-file" })],
    ]),
  );
  const filesystem: CleanerFilesystem = {
    ...baseFilesystem,
    async lstat(target) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return baseFilesystem.lstat(target);
    },
  };
  const measured = await new CleanerSizeCalculator(
    filesystem,
    new CleanerCancellationToken(),
    {
      policy: {
        kind: "standard-bounded",
        maxEntries: 100,
        maxDurationMs: 1,
        maxTrackedFileRecords: 100,
      },
    },
  ).measure(root);

  assert.equal(measured.measurementCompleteness, "partial");
  assert.equal(measured.measurementLimitReason, "duration-limit");
  assert.equal(measured.logicalTraversalComplete, false);
  assert.equal(measured.estimatedReclaimableBytes, null);
});

test("file-record memory bounds make physical accounting partial", async () => {
  const root = "C:\\fixture\\metadata-bounded";
  const files = new Map<string, CleanerFileStat>([
    [root, directoryStat()],
    [
      `${root}\\a.bin`,
      fileStat({ size: 128, fileIdentity: "1", hardlinkCount: 2 }),
    ],
    [
      `${root}\\b.bin`,
      fileStat({ size: 256, fileIdentity: "2", hardlinkCount: 2 }),
    ],
  ]);
  const measured = await new CleanerSizeCalculator(
    mockFilesystem(root, files),
    new CleanerCancellationToken(),
    {
      policy: {
        kind: "standard-bounded",
        maxEntries: 100,
        maxDurationMs: 60_000,
        maxTrackedFileRecords: 1,
      },
    },
  ).measure(root);

  assert.equal(measured.logicalBytes, 384);
  assert.equal(measured.measurementCompleteness, "partial");
  assert.equal(measured.accountingConfidence, "lower-bound");
  assert.equal(measured.estimatedReclaimableBytes, null);
  assert.equal(measured.measurementLimitReason, "metadata-limit");
});

test("sparse and compressed accounting flags remain explicit when an adapter provides them", async () => {
  const root = "C:\\fixture\\special";
  const files = new Map<string, CleanerFileStat>([
    [root, directoryStat()],
    [
      `${root}\\sparse.bin`,
      fileStat({
        size: 8_192,
        allocatedBytes: 4_096,
        fileIdentity: "sparse",
        sparse: true,
        compressed: false,
      }),
    ],
    [
      `${root}\\compressed.bin`,
      fileStat({
        size: 8_192,
        allocatedBytes: 4_096,
        fileIdentity: "compressed",
        sparse: false,
        compressed: true,
      }),
    ],
  ]);
  const measured = await new CleanerSizeCalculator(
    mockFilesystem(root, files),
    new CleanerCancellationToken(),
  ).measure(root);

  assert.equal(measured.sparseFileCount, 1);
  assert.equal(measured.compressedFileCount, 1);
  assert.equal(measured.logicalBytes, 16_384);
  assert.equal(measured.uniqueAllocatedBytes, 8_192);
  assert.equal(measured.estimatedReclaimableBytes, 8_192);
});

function mockFilesystem(
  root: string,
  stats: Map<string, CleanerFileStat>,
): CleanerFilesystem {
  return {
    async exists(target) {
      return stats.has(target);
    },
    async lstat(target) {
      const stat = stats.get(target);
      if (!stat) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return stat;
    },
    async readDirectory(target) {
      if (target !== root) return [];
      return [...stats.entries()]
        .filter(([entryPath]) => entryPath !== root)
        .map(([entryPath, stat]) => ({
          name: path.win32.basename(entryPath),
          isFile: stat.isFile,
          isDirectory: stat.isDirectory,
          isSymbolicLink: stat.isSymbolicLink,
        }));
    },
    async realPath(target) {
      return target;
    },
    async unlink() {},
    async removeReparsePoint() {},
    async removeDirectory() {},
    async getSizeOverride() {
      return undefined;
    },
  };
}

function directoryStat(): CleanerFileStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    isReparsePoint: false,
    size: 0,
    modifiedMs: 1,
  };
}

function fileStat(overrides: Partial<CleanerFileStat>): CleanerFileStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    isReparsePoint: false,
    size: 1,
    modifiedMs: 1,
    volumeIdentity: "fixture-volume",
    hardlinkCount: 1,
    allocatedBytes: 4_096,
    allocationConfidence: "exact",
    sparse: false,
    compressed: false,
    ...overrides,
  };
}
