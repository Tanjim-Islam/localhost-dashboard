import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  expandWindowsEnvironmentPath,
  isWindowsPathInside,
  normalizeWindowsPath,
  sameWindowsPath,
} from "../src/main/cleaner/path-normalization";
import { validateCleanerTargetPath } from "../src/main/cleaner/path-safety";
import {
  createCleanerFixture,
  createCleanerHarness,
  createSessionManager,
  removeCleanerFixture,
  scanFixture,
} from "./cleaner-test-helpers";

test("normalizes Windows paths case-insensitively and removes trailing separators", () => {
  assert.equal(
    normalizeWindowsPath("C:\\Users\\Test\\Cache\\"),
    "c:\\users\\test\\cache",
  );
  assert.equal(sameWindowsPath("C:\\USERS\\Test", "c:\\users\\test\\"), true);
  assert.equal(
    isWindowsPathInside("C:\\Users\\Test\\Cache", "c:\\users\\test"),
    true,
  );
  assert.equal(
    expandWindowsEnvironmentPath("%LOCALAPPDATA%\\npm-cache", {
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
    }),
    "C:\\Users\\Test\\AppData\\Local\\npm-cache",
  );
  assert.throws(() => normalizeWindowsPath("relative\\cache"));
  assert.throws(() => normalizeWindowsPath("C:\\Temp\\*"));
});

test("path safety rejects broad, external, UNC, wildcard, protected, missing, and reparse targets", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await createCleanerHarness(root);
    const invalid = [
      harness.environment.systemDrive,
      harness.environment.home,
      harness.environment.localAppData,
      "Z:\\external\\cache",
      "\\\\server\\share\\cache",
      path.join(root, "missing-cache"),
      path.join(root, "User", ".codex"),
      path.join(root, "User", "AppData", "Local", "Google"),
      path.join(
        root,
        "User",
        "AppData",
        "Local",
        "Google",
        "Chrome",
        "User Data",
        "Default",
        "History",
      ),
    ];
    for (const target of invalid) {
      const result = await validateCleanerTargetPath(
        target,
        harness.environment,
        harness.filesystem,
      );
      assert.equal(result.safe, false, target);
    }
    const safe = await validateCleanerTargetPath(
      path.join(root, "User", "AppData", "Local", "npm-cache", "_cacache"),
      harness.environment,
      harness.filesystem,
    );
    assert.equal(safe.safe, true);

    const junction = path.join(
      root,
      "User",
      ".cache",
      "mystery-tool",
      "junction",
    );
    if (await harness.filesystem.exists(junction)) {
      const reparse = await validateCleanerTargetPath(
        junction,
        harness.environment,
        harness.filesystem,
      );
      assert.equal(reparse.safe, false);
    }
  } finally {
    await removeCleanerFixture(root);
  }
});

test("test filesystem refuses deletion outside the exact sentinel root", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await createCleanerHarness(root);
    const outside = path.join(os.tmpdir(), "cleaner-outside-refusal.txt");
    await assert.rejects(() => harness.filesystem.unlink(outside));
    assert.equal(await fs.stat(root).then(() => true), true);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("scan sessions reject unknown, expired, cancelled, stale, and previous scans", () => {
  const fixture = createSessionManager(1_000, 100);
  const first = fixture.manager.create("standard", true);
  assert.equal(fixture.manager.getActive()?.id, first.id);
  assert.equal(fixture.manager.cancel("not-a-session"), false);
  assert.equal(fixture.manager.cancel(first.id), true);
  assert.throws(() => fixture.manager.requireCompleted(first.id));

  const second = fixture.manager.create("deep", true);
  assert.equal(first.status, "invalidated");
  fixture.advance(101);
  assert.equal(fixture.manager.getActive(), undefined);
  assert.throws(() => fixture.manager.requireCompleted(second.id));
});

test("scan cancellation emits no completed result", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await createCleanerHarness(root);
    const session = new (
      await import("../src/main/cleaner/scan-session")
    ).CleanerScanSession("deep", true, harness.clock);
    session.cancel();
    await assert.rejects(() =>
      harness.scanner.scan(session, harness.environment, () => undefined),
    );
    assert.equal(session.result, undefined);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("deep scan never traverses outside its injected fixture root", async () => {
  const root = await createCleanerFixture();
  try {
    const { result } = await scanFixture(root, "deep");
    assert.equal(
      result.findings.every((finding) =>
        isWindowsPathInside(finding.path, root),
      ),
      true,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});
