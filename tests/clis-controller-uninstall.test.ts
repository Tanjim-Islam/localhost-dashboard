import { once } from "node:events";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliController } from "../src/main/clis/controller";
import {
  FixtureCliCommandRunner,
  FixtureCliProvider,
} from "../src/main/clis/fixture";
import { CliScanner } from "../src/main/clis/scanner";
import { MemoryCliPersistence } from "../src/main/clis/store";
import type { CliClock } from "../src/main/clis/types";
import type { CliInventorySnapshot } from "../src/main/clis/types";

test("cached inventory is read without scanning and cancellation never publishes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-cancel-"));
  try {
    const harness = createHarness(root);
    assert.equal(harness.controller.getInventory(), null);
    assert.equal(harness.scanCount.value, 0);
    const terminal = once(harness.controller, "scan-error");
    const session = harness.controller.startScan();
    harness.controller.cancelScan(session.id);
    const [event] = await terminal;
    assert.equal(event.status, "cancelled");
    assert.equal(harness.controller.getInventory(), null);
    assert.equal(harness.persistence.read().lastScanStatus, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual scan publishes fixture conflicts and bounds package-source failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-scan-"));
  try {
    const harness = createHarness(root);
    const completed = once(harness.controller, "scan-complete");
    harness.controller.startScan();
    const [rawSnapshot] = await completed;
    const snapshot = rawSnapshot as CliInventorySnapshot;
    assert.equal(snapshot.completeness, "partial");
    assert(snapshot.products.some((product) => product.id === "codex"));
    const bun = snapshot.products.find((product) => product.id === "bun");
    assert(bun?.issueCodes.includes("path-conflict"));
    assert.equal(
      snapshot.sourceResults.filter((source) => source.status === "failed")
        .length,
      1,
    );
    assert.equal(harness.controller.getInventory()?.cached, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan completion publishes the finalized snapshot used by the store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-publish-"));
  try {
    const harness = createHarness(root, true);
    const completed = once(harness.controller, "scan-complete");
    harness.controller.startScan();
    const [rawSnapshot] = await completed;
    const snapshot = rawSnapshot as CliInventorySnapshot;
    const stored = harness.persistence.read();

    assert.equal(snapshot.completeness, "complete");
    assert.equal(snapshot.cached, false);
    assert.equal(snapshot.lastSuccessfulScanAt, stored.lastSuccessfulScanAt);
    assert.equal(
      snapshot.lastSuccessfulScanAt,
      stored.inventory?.lastSuccessfulScanAt,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact npm uninstall consumes one-use preview and refreshes inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-uninstall-"));
  try {
    const harness = createHarness(root);
    const completed = once(harness.controller, "scan-complete");
    harness.controller.startScan();
    const [rawSnapshot] = await completed;
    const snapshot = rawSnapshot as CliInventorySnapshot;
    const installation = snapshot.installations.find(
      (item) => item.productId === "codex",
    );
    assert(installation);
    const preview = await harness.controller.getUninstallPreview({
      installationId: installation.id,
      inventoryRevision: snapshot.revision,
    });
    assert.equal(preview.source, "npm");
    assert.equal(preview.packageId, "@openai/codex");
    const request = {
      installationId: installation.id,
      inventoryRevision: snapshot.revision,
      previewToken: preview.token,
      confirmation: "uninstall-exact-cli-installation" as const,
    };
    const result = await harness.controller.uninstall(request);
    assert.equal(result.status, "succeeded");
    assert.equal(result.verifiedRemoved, true);
    assert.equal(
      harness.controller
        .getInventory()
        ?.installations.some((item) => item.id === installation.id),
      false,
    );
    await assert.rejects(
      () => harness.controller.uninstall(request),
      /preview is stale/i,
    );
    assert.equal(
      harness.persistence.read().uninstallAudits[0].status,
      "succeeded",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manager failure is simulated and stale revisions are rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-uninstall-fail-"));
  try {
    const harness = createHarness(root);
    const completed = once(harness.controller, "scan-complete");
    harness.controller.startScan();
    const [rawSnapshot] = await completed;
    const snapshot = rawSnapshot as CliInventorySnapshot;
    const installation = snapshot.installations.find(
      (item) => item.productId === "opencode",
    );
    assert(installation);
    await assert.rejects(
      () =>
        harness.controller.getUninstallPreview({
          installationId: installation.id,
          inventoryRevision: "revision-stale",
        }),
      /inventory changed/i,
    );
    const preview = await harness.controller.getUninstallPreview({
      installationId: installation.id,
      inventoryRevision: snapshot.revision,
    });
    const result = await harness.controller.uninstall({
      installationId: installation.id,
      inventoryRevision: snapshot.revision,
      previewToken: preview.token,
      confirmation: "uninstall-exact-cli-installation",
    });
    assert.equal(result.status, "failed");
    assert.equal(result.verifiedRemoved, false);
    assert.equal(
      harness.persistence.read().uninstallAudits[0].status,
      "failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall preview tokens reject installation mismatches and expiry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-preview-token-"));
  try {
    const harness = createHarness(root);
    const completed = once(harness.controller, "scan-complete");
    harness.controller.startScan();
    const [rawSnapshot] = await completed;
    const snapshot = rawSnapshot as CliInventorySnapshot;
    const codex = snapshot.installations.find(
      (item) => item.productId === "codex",
    );
    const opencode = snapshot.installations.find(
      (item) => item.productId === "opencode",
    );
    assert(codex);
    assert(opencode);
    const preview = await harness.controller.getUninstallPreview({
      installationId: codex.id,
      inventoryRevision: snapshot.revision,
    });
    await assert.rejects(
      () =>
        harness.controller.uninstall({
          installationId: opencode.id,
          inventoryRevision: snapshot.revision,
          previewToken: preview.token,
          confirmation: "uninstall-exact-cli-installation",
        }),
      /preview is stale/i,
    );
    harness.advanceClock(2 * 60 * 1000 + 1);
    await assert.rejects(
      () =>
        harness.controller.uninstall({
          installationId: codex.id,
          inventoryRevision: snapshot.revision,
          previewToken: preview.token,
          confirmation: "uninstall-exact-cli-installation",
        }),
      /preview is stale/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createHarness(root: string, complete = false) {
  let now = 1_750_000_000_000;
  const clock: CliClock = { now: () => ++now };
  const runner = new FixtureCliCommandRunner();
  const provider = new FixtureCliProvider(root, "win32", "x64", clock.now);
  const scanCount = { value: 0 };
  const scanner = new CliScanner({
    createEnvironment: async () => {
      throw new Error("Fixture scans must not read the host environment.");
    },
    runner,
    clock,
    fixtureProvider: {
      scan: async (input) => {
        scanCount.value += 1;
        const snapshot = await provider.scan(input);
        if (!complete) return snapshot;
        return {
          ...snapshot,
          completeness: "complete",
          sourceResults: snapshot.sourceResults.map((source) => {
            if (source.status !== "failed") return source;
            return {
              sourceId: source.sourceId,
              label: source.label,
              status: "success",
              startedAt: source.startedAt,
              finishedAt: source.finishedAt,
              recordCount: source.recordCount,
            };
          }),
        };
      },
      markUninstalled: (id) => provider.markUninstalled(id),
    },
  });
  const persistence = new MemoryCliPersistence();
  return {
    controller: new CliController({ scanner, persistence, clock, runner }),
    persistence,
    scanCount,
    advanceClock: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
