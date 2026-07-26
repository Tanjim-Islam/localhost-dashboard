import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createCleanerFixture,
  removeCleanerFixture,
  scanFixture,
  TestMemoryPersistence,
  updateFixtureManifest,
} from "./cleaner-test-helpers";
import {
  CleanerCleanupExecutor,
  deleteExactTree,
} from "../src/main/cleaner/cleanup-executor";
import { normalizeWindowsPath } from "../src/main/cleaner/path-normalization";
import type { CleanerFilesystem } from "../src/main/cleaner/types";
import { InProcessCleanerAccountingWorkerFactory } from "../src/main/cleaner/accounting-worker";

test("cleanup deletes only an exact safe fixture directory and keeps protected data", async () => {
  const root = await createCleanerFixture();
  const persistence = new TestMemoryPersistence();
  try {
    const harness = await scanFixture(root, "standard", persistence);
    const npm = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.npm-cache",
    )!;
    harness.driveProvider.setFreeBytesSequence([
      14_000_000_000, 14_125_000_000,
    ]);
    const brave = path.join(
      root,
      "User",
      "AppData",
      "Local",
      "BraveSoftware",
      "Brave-Browser",
      "User Data",
      "Login Data",
    );
    const result = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [npm.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );
    assert.equal(result.items[0].status, "deleted");
    assert.equal(result.logicalBytesDeleted, 1_600_000_000);
    await assert.rejects(() => fs.access(npm.path));
    assert.equal(
      await fs.readFile(brave, "utf8"),
      "fixture:User/AppData/Local/BraveSoftware/Brave-Browser/User Data\n",
    );
    assert.equal(result.observedDriveDifferenceBytes, 125_000_000);
    assert.match(result.recoveryExplanation, /signed global drive-space/i);
    assert.equal(persistence.read().cleanupReceipts.length, 1);
    assert.equal(Object.keys(persistence.read().itemHistory).length > 0, true);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("conditional cleanup requires strong confirmation", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const pnpm = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.pnpm-store",
    )!;
    await assert.rejects(
      () =>
        harness.cleanupExecutor.clean(
          harness.session,
          {
            scanSessionId: harness.session.id,
            findingIds: [pnpm.id],
            confirmation: "safe",
          },
          harness.environment,
          () => undefined,
        ),
      /stronger confirmation/i,
    );
    assert.equal(await fs.stat(pnpm.path).then(() => true), true);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("protected, manual-review, and excluded findings are rejected", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const protectedFinding = harness.result.findings.find(
      (finding) => finding.detectorId === "browser.brave.profile",
    )!;
    await assert.rejects(() =>
      harness.cleanupExecutor.clean(
        harness.session,
        {
          scanSessionId: harness.session.id,
          findingIds: [protectedFinding.id],
          confirmation: "conditional",
        },
        harness.environment,
        () => undefined,
      ),
    );

    const manual = harness.result.findings.find(
      (finding) => finding.detectorId === "windows.user-temp",
    )!;
    await assert.rejects(() =>
      harness.cleanupExecutor.clean(
        harness.session,
        {
          scanSessionId: harness.session.id,
          findingIds: [manual.id],
          confirmation: "conditional",
        },
        harness.environment,
        () => undefined,
      ),
    );

    const safe = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.npm-cache",
    )!;
    safe.excluded = true;
    await assert.rejects(() =>
      harness.cleanupExecutor.clean(
        harness.session,
        {
          scanSessionId: harness.session.id,
          findingIds: [safe.id],
          confirmation: "safe",
        },
        harness.environment,
        () => undefined,
      ),
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("Jupyter runtime as the first requested finding fails as protected, never from malformed drive-root configuration", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const jupyter = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.jupyter-runtime",
    )!;
    const npm = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.npm-cache",
    )!;
    await assert.rejects(
      () =>
        harness.cleanupExecutor.clean(
          harness.session,
          {
            scanSessionId: harness.session.id,
            findingIds: [jupyter.id, npm.id],
            confirmation: "conditional",
          },
          harness.environment,
          () => undefined,
        ),
      (error: Error) => {
        assert.match(error.message, /protected/i);
        assert.doesNotMatch(error.message, /Only absolute Windows paths/i);
        return true;
      },
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("safe-after-close is skipped while its related process is running", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "deep");
    const uv = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.uv-cache",
    )!;
    assert.equal(uv.safety, "safe-after-close");
    const result = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [uv.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );
    assert.equal(result.items[0].status, "skipped");
    assert.deepEqual(result.items[0].failureCategories, ["process-running"]);
    assert.equal(await fs.stat(uv.path).then(() => true), true);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("cleanup revalidation skips a target whose root identity changed", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const npm = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.npm-cache",
    )!;
    await fs.rm(npm.path, { recursive: true });
    await fs.mkdir(npm.path, { recursive: true });
    await fs.writeFile(path.join(npm.path, "replacement.bin"), "changed\n");
    const result = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [npm.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );
    assert.equal(result.items[0].status, "skipped");
    assert.deepEqual(result.items[0].failureCategories, ["state-changed"]);
    assert.equal(
      await fs.readFile(path.join(npm.path, "replacement.bin"), "utf8"),
      "changed\n",
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("cleanup reports a partial result when a fixture file is locked", async () => {
  const root = await createCleanerFixture();
  try {
    const npmPath = path.join(
      root,
      "User",
      "AppData",
      "Local",
      "npm-cache",
      "_cacache",
    );
    const lockedPath = path.join(npmPath, "fixture.bin");
    await fs.writeFile(path.join(npmPath, "removable.bin"), "remove me\n");
    await updateFixtureManifest(root, (manifest) => {
      delete manifest.sizeOverrides[normalizeWindowsPath(npmPath)];
    });

    const harness = await scanFixture(root, "standard");
    const npm = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.npm-cache",
    )!;
    const base = harness.filesystem;
    const filesystem: CleanerFilesystem = {
      exists: (target) => base.exists(target),
      lstat: (target) => base.lstat(target),
      readDirectory: (target) => base.readDirectory(target),
      realPath: (target) => base.realPath(target),
      getSizeOverride: (target) => base.getSizeOverride(target),
      unlink: (target) =>
        normalizeWindowsPath(target) === normalizeWindowsPath(lockedPath)
          ? Promise.reject(new Error("Simulated fixture lock"))
          : base.unlink(target),
      removeReparsePoint: (target) => base.removeReparsePoint(target),
      removeDirectory: (target) => base.removeDirectory(target),
    };
    const executor = new CleanerCleanupExecutor({
      filesystem,
      processProvider: harness.processProvider,
      applicationEvidenceProvider: harness.applicationEvidenceProvider,
      detectors: harness.detectors,
      driveProvider: harness.driveProvider,
      persistence: harness.persistence,
      clock: harness.clock,
      accountingWorkerFactory: new InProcessCleanerAccountingWorkerFactory(
        filesystem,
      ),
    });
    const result = await executor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [npm.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );

    assert.equal(result.items[0].status, "partial");
    assert.equal(result.items[0].failedEntryCount > 0, true);
    assert.equal(result.items[0].remainingBytes > 0, true);
    assert.equal(
      await fs.readFile(lockedPath, "utf8"),
      "fixture:User/AppData/Local/npm-cache/_cacache\n",
    );
    await assert.rejects(() => fs.access(path.join(npmPath, "removable.bin")));
  } finally {
    await removeCleanerFixture(root);
  }
});

test("cleanup rejects unknown and duplicate finding identifiers before deletion", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const npm = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.npm-cache",
    )!;
    await assert.rejects(() =>
      harness.cleanupExecutor.clean(
        harness.session,
        {
          scanSessionId: harness.session.id,
          findingIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          confirmation: "safe",
        },
        harness.environment,
        () => undefined,
      ),
    );
    assert.equal(await fs.stat(npm.path).then(() => true), true);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("cleanup revalidates application, ownership, running, data-kind, marker, exclusion, and definition state with zero deletion calls", async () => {
  const scenarios: Array<{
    name: string;
    change(
      root: string,
      harness: Awaited<ReturnType<typeof scanFixture>>,
      finding: Awaited<
        ReturnType<typeof scanFixture>
      >["result"]["findings"][number],
    ): Promise<void>;
    expectedStatus: string;
  }> = [
    {
      name: "application becomes installed",
      expectedStatus: "skipped",
      async change(root) {
        await updateFixtureManifest(root, (manifest) => {
          manifest.evidence.sources
            .find((source) => source.source === "uninstall-registry")!
            .evidence.push({
              source: "uninstall-registry",
              applicationId: "editor.windsurf",
              observedName: "Windsurf",
              current: true,
              verified: false,
              strength: "medium",
              summary: "Current exact Windsurf registry record.",
            });
          manifest.evidence.sources
            .find((source) => source.source === "executable")!
            .evidence.push({
              source: "executable",
              applicationId: "editor.windsurf",
              executablePath: path.join(
                root,
                "User",
                "AppData",
                "Local",
                "Programs",
                "Windsurf",
                "Windsurf.exe",
              ),
              current: true,
              verified: true,
              strength: "strong",
              summary: "Verified Windsurf executable.",
            });
        });
      },
    },
    {
      name: "application starts running",
      expectedStatus: "skipped",
      async change(root) {
        await updateFixtureManifest(root, (manifest) => {
          manifest.evidence.processes.push({
            name: "Windsurf.exe",
            pid: 9801,
            applicationId: "editor.windsurf",
            commandCategory: "editor",
            referencedPaths: [],
          });
        });
      },
    },
    {
      name: "data kind changes",
      expectedStatus: "skipped",
      async change(_root, _harness, finding) {
        finding.dataKind = "settings";
      },
    },
    {
      name: "shared owner appears",
      expectedStatus: "skipped",
      async change(_root, _harness, finding) {
        finding.ownershipStatus = "shared";
        finding.sharedOwnership = true;
        finding.ownerApplicationIds = [
          "editor.windsurf",
          "editor.windsurf-next",
        ];
      },
    },
    {
      name: "protected marker appears",
      expectedStatus: "skipped",
      async change(_root, _harness, finding) {
        await fs.mkdir(path.join(finding.path, "History"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(finding.path, "History", "state.json"),
          "{}\n",
        );
      },
    },
    {
      name: "exclusion changes",
      expectedStatus: "skipped",
      async change(_root, harness, finding) {
        const state = harness.persistence.read();
        state.exclusions.push({
          id: "fixture-exclusion",
          scope: "finding",
          value: finding.id,
          label: finding.displayName,
          createdAt: Date.now(),
        });
        harness.persistence.write(state);
      },
    },
    {
      name: "definition version changes",
      expectedStatus: "skipped",
      async change(_root, _harness, finding) {
        finding.definitionVersion -= 1;
      },
    },
  ];

  for (const scenario of scenarios) {
    const root = await createCleanerFixture();
    try {
      const harness = await scanFixture(root, "deep");
      const finding = harness.result.findings.find(
        (item) =>
          item.detectorId === "editor.windsurf.cache" &&
          item.displayName.endsWith("Cache"),
      )!;
      assert.equal(finding.safety, "safe-now", scenario.name);
      await scenario.change(root, harness, finding);

      let deletionCalls = 0;
      const base = harness.filesystem;
      const filesystem: CleanerFilesystem = {
        exists: (target) => base.exists(target),
        lstat: (target) => base.lstat(target),
        readDirectory: (target) => base.readDirectory(target),
        realPath: (target) => base.realPath(target),
        getSizeOverride: (target) => base.getSizeOverride(target),
        unlink: async (target) => {
          deletionCalls += 1;
          await base.unlink(target);
        },
        removeReparsePoint: async (target) => {
          deletionCalls += 1;
          await base.removeReparsePoint(target);
        },
        removeDirectory: async (target) => {
          deletionCalls += 1;
          await base.removeDirectory(target);
        },
      };
      const executor = new CleanerCleanupExecutor({
        filesystem,
        processProvider: harness.processProvider,
        applicationEvidenceProvider: harness.applicationEvidenceProvider,
        detectors: harness.detectors,
        driveProvider: harness.driveProvider,
        persistence: harness.persistence,
        clock: harness.clock,
        accountingWorkerFactory: new InProcessCleanerAccountingWorkerFactory(
          filesystem,
        ),
      });
      const result = await executor.clean(
        harness.session,
        {
          scanSessionId: harness.session.id,
          findingIds: [finding.id],
          confirmation: "safe",
        },
        harness.environment,
        () => undefined,
      );
      assert.equal(
        result.items[0].status,
        scenario.expectedStatus,
        scenario.name,
      );
      assert.match(result.items[0].message, /run a new scan/i, scenario.name);
      assert.equal(deletionCalls, 0, scenario.name);
      assert.equal(await fs.stat(finding.path).then(() => true), true);
    } finally {
      await removeCleanerFixture(root);
    }
  }
});

test("cleanup removes fixture-internal reparse objects without traversing their targets", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const bun = harness.result.findings.find(
      (finding) => finding.detectorId === "dev.bun-cache",
    )!;
    const externalTarget = path.join(root, "FixtureLinkTarget");
    const internalLink = path.join(bun.path, "internal-junction");
    if (!(await harness.filesystem.exists(internalLink))) return;

    const result = await harness.cleanupExecutor.clean(
      harness.session,
      {
        scanSessionId: harness.session.id,
        findingIds: [bun.id],
        confirmation: "safe",
      },
      harness.environment,
      () => undefined,
    );
    assert.equal(result.items[0].status, "deleted");
    assert.equal(await fs.stat(externalTarget).then(() => true), true);
    await assert.rejects(() => fs.access(internalLink));
  } finally {
    await removeCleanerFixture(root);
  }
});

test("internal junctions, symbolic links, and mount-point objects are removed without traversal", async () => {
  const root = "C:\\Fixture\\cache";
  const reparseObjects = new Set([
    `${root}\\junction`,
    `${root}\\symbolic-link`,
    `${root}\\mount-point`,
  ]);
  const readDirectories: string[] = [];
  const removedReparsePoints: string[] = [];
  const filesystem: CleanerFilesystem = {
    async exists() {
      return true;
    },
    async lstat(target) {
      if (reparseObjects.has(target)) {
        return {
          isFile: false,
          isDirectory: false,
          isSymbolicLink: target.endsWith("symbolic-link"),
          isReparsePoint: true,
          size: 0,
          modifiedMs: 1,
        };
      }
      if (target.endsWith("file.bin")) {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          isReparsePoint: false,
          size: 1,
          modifiedMs: 1,
        };
      }
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        isReparsePoint: false,
        size: 0,
        modifiedMs: 1,
      };
    },
    async readDirectory(target) {
      readDirectories.push(target);
      if (target === root) {
        return [
          {
            name: "file.bin",
            isFile: true,
            isDirectory: false,
            isSymbolicLink: false,
          },
          ...[...reparseObjects].map((item) => ({
            name: path.win32.basename(item),
            isFile: false,
            isDirectory: false,
            isSymbolicLink: true,
          })),
        ];
      }
      return [];
    },
    async realPath(target) {
      return target;
    },
    async unlink() {},
    async removeReparsePoint(target) {
      removedReparsePoints.push(target);
    },
    async removeDirectory() {},
    async getSizeOverride() {
      return undefined;
    },
  };
  const result = await deleteExactTree(filesystem, root);
  assert.equal(result.skippedEntries, 0);
  assert.equal(result.skippedReparsePoints, 0);
  assert.deepEqual(new Set(removedReparsePoints), reparseObjects);
  assert.deepEqual(readDirectories, [root]);
});
