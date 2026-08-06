import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  filterCliProducts,
  getVisibleCliInstallations,
  summarizeCliInventory,
} from "../src/renderer/cli-view-model";
import { FixtureCliProvider } from "../src/main/clis/fixture";
import { CliCancellationToken } from "../src/main/clis/session";

test("renderer view model summarizes and searches products, commands, package IDs, and paths", async () => {
  const provider = new FixtureCliProvider(
    path.join(process.cwd(), ".tmp-tests", "clis-renderer-fixture"),
    "win32",
    "x64",
    () => 1_750_000_000_000,
  );
  const inventory = await provider.scan({
    previous: null,
    cancellation: new CliCancellationToken(),
    scanSessionId: "scan-renderer",
    onProgress: () => undefined,
  });
  const summary = summarizeCliInventory(inventory);
  assert.equal(summary.installed, 5);
  assert.equal(summary.duplicates, 1);
  assert.equal(
    summary.duplicates,
    inventory.products.filter((product) =>
      product.issueCodes.some((issue) =>
        ["duplicate-version", "path-conflict"].includes(issue),
      ),
    ).length,
  );
  assert.equal(summary.broken, 1);
  for (const query of ["Codex", "codex", "@openai/codex", "path-a"]) {
    assert(
      filterCliProducts(inventory, {
        query,
        category: "all",
        health: "all",
        source: "all",
        presence: "all",
        duplicatesOnly: false,
      }).length > 0,
    );
  }
  const duplicateProducts = filterCliProducts(inventory, {
    query: "",
    category: "all",
    health: "all",
    source: "all",
    presence: "installed",
    duplicatesOnly: true,
  });
  assert(
    duplicateProducts.every((product) =>
      product.issueCodes.some((issue) =>
        ["duplicate-version", "path-conflict"].includes(issue),
      ),
    ),
  );
});

test("renderer keeps embedded tools out of installed state and includes them in all state", async () => {
  const provider = new FixtureCliProvider(
    path.join(process.cwd(), ".tmp-tests", "clis-renderer-origin-fixture"),
    "win32",
    "x64",
    () => 1_750_000_000_000,
  );
  const inventory = await provider.scan({
    previous: null,
    cancellation: new CliCancellationToken(),
    scanSessionId: "scan-renderer-origin",
    onProgress: () => undefined,
  });
  const product = inventory.products.find(
    (candidate) => candidate.currentInstallationIds.length === 1,
  );
  assert(product);
  const installationId = product.currentInstallationIds[0];
  const installation = inventory.installations.find(
    (candidate) => candidate.id === installationId,
  );
  assert(installation);
  product.currentInstallationIds = [];
  product.embeddedInstallationIds = [installationId];
  installation.origin = "application-embedded";

  const defaults = filterCliProducts(inventory, {
    query: product.displayName,
    category: "all",
    health: "all",
    source: "all",
    presence: "all",
    duplicatesOnly: false,
  });
  assert.equal(
    defaults.some((candidate) => candidate.id === product.id),
    true,
  );
  const installed = filterCliProducts(inventory, {
    query: product.displayName,
    category: "all",
    health: "all",
    source: "all",
    presence: "installed",
    duplicatesOnly: false,
  });
  assert.equal(
    installed.some((candidate) => candidate.id === product.id),
    false,
  );
  const embedded = filterCliProducts(inventory, {
    query: product.displayName,
    category: "all",
    health: "all",
    source: "all",
    presence: "embedded",
    duplicatesOnly: false,
  });
  assert.equal(
    embedded.some((candidate) => candidate.id === product.id),
    true,
  );
  assert.equal(
    getVisibleCliInstallations(inventory, product, "embedded").length,
    1,
  );
  assert.equal(
    summarizeCliInventory(inventory).installed,
    inventory.products.filter(
      (candidate) => candidate.currentInstallationIds.length > 0,
    ).length,
  );
});

test("tab, preload, and modal contracts expose no raw destructive input", async () => {
  const [app, preload, types, tab, row, dialog] = await Promise.all([
    readFile(path.join(process.cwd(), "src/renderer/App.tsx"), "utf8"),
    readFile(path.join(process.cwd(), "src/preload/index.ts"), "utf8"),
    readFile(path.join(process.cwd(), "src/main/clis/types.ts"), "utf8"),
    readFile(
      path.join(process.cwd(), "src/renderer/components/ClisTab.tsx"),
      "utf8",
    ),
    readFile(
      path.join(
        process.cwd(),
        "src/renderer/components/clis/CliProductRow.tsx",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        process.cwd(),
        "src/renderer/components/clis/CliUninstallDialog.tsx",
      ),
      "utf8",
    ),
  ]);
  assert.match(app, /saved === "clis"/);
  assert.match(app, /showRefresh=\{activeTab !== "clis"\}/);
  assert.match(preload, /validateCliUninstallRequest/);
  assert.match(types, /confirmation: "uninstall-exact-cli-installation"/);
  assert.doesNotMatch(
    types.slice(
      types.indexOf("export type CliUninstallRequest"),
      types.indexOf("export type CliUninstallProgress"),
    ),
    /path|arguments|manager/i,
  );
  assert.match(tab, /Nothing is scanned automatically/);
  assert.match(tab, /Embedded tools/);
  assert.match(tab, /Multiple installs/);
  assert.match(tab, /const DEFAULT_FILTERS:[\s\S]*?presence: "installed"/);
  assert.doesNotMatch(tab, /label="Missing"|value: "removed"/);
  assert.doesNotMatch(
    tab,
    /cache cleanup|leftover removal|delete configuration/i,
  );
  assert.match(row, /Launchers/);
  assert.match(row, /CopyablePathsDetail/);
  assert.match(row, /cursor-copy/);
  assert.match(row, /copyWithFeedback/);
  assert.match(row, /confirmed=\{copiedKey === "command"\}/);
  assert.match(row, /confirmed=\{copiedKey === "primary-path"\}/);
  assert.match(row, /VerificationPill/);
  assert.match(row, /Runtime only, no SDK/);
  assert.doesNotMatch(row, /removedCount|current installations/);
  assert.doesNotMatch(row, /installation\.issueCodes\.map/);
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /event.key === "Escape"/);
});
