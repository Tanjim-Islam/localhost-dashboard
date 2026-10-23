import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  compareCliInventories,
  confirmedAbsent,
  sanitizeCliChanges,
} from "../src/main/clis/changes";
import { FixtureCliProvider } from "../src/main/clis/fixture";
import { CliCancellationToken } from "../src/main/clis/session";
import { migrateCliStore, DEFAULT_CLI_STORE } from "../src/main/clis/store";
import { normalizeCliInventory } from "../src/main/clis/inventory-normalizer";

async function fixture() {
  const provider = new FixtureCliProvider(
    path.join(process.cwd(), ".tmp-tests/cli-changes"),
    "win32",
    "x64",
    () => 1000,
  );
  return provider.scan({
    previous: null,
    cancellation: new CliCancellationToken(),
    scanSessionId: "changes",
    onProgress: () => {},
  });
}
test("normalizing standalone installation IDs does not invent additions or removals", async () => {
  const next = await fixture();
  const previous = normalizeCliInventory(next)!;
  const diff = compareCliInventories(previous, next)!;
  assert.deepEqual(diff.entries, []);
});

test("PATH position changes are reported even when the executable remains active", async () => {
  const previous = await fixture(),
    next = structuredClone(previous);
  const command = next.commands.find((c) => c.pathRole === "active")!;
  const endpoint = next.endpoints.find(
    (e) => e.id === command.activeEndpointId,
  )!;
  endpoint.pathIndex = (endpoint.pathIndex || 0) + 2;
  const changes = compareCliInventories(previous, next)!;
  assert.ok(
    changes.entries.some(
      (e) =>
        e.kind === "precedence" && e.installationId === command.installationId,
    ),
  );
  assert.ok(!changes.entries.some((e) => e.kind === "executable"));
});
test("CLI comparison records version, active executable, path, ownership and PATH role changes", async () => {
  const old = await fixture(),
    next = structuredClone(old);
  const item = next.installations.find(
    (i) => i.presence === "present" && i.origin !== "application-embedded",
  )!;
  item.version = "999.1";
  item.versionSource = "package-metadata";
  const command = next.commands.find((c) => c.installationId === item.id)!;
  const endpoint = next.endpoints.find(
    (e) => e.id === (command.activeEndpointId || item.endpointIds[0]),
  )!;
  endpoint.path += ".replacement";
  endpoint.canonicalPath = endpoint.path;
  const changes = compareCliInventories(old, next)!;
  assert.ok(changes.entries.some((e) => e.kind === "version"));
  assert.ok(changes.entries.some((e) => e.kind === "path"));
  if (command.activeEndpointId)
    assert.ok(changes.entries.some((e) => e.kind === "executable"));
  command.pathRole = command.pathRole === "active" ? "shadowed" : "active";
  if (item.packageIdentity) item.packageIdentity.packageId += "-changed";
  const more = compareCliInventories(old, next)!;
  assert.ok(more.entries.some((e) => e.kind === "precedence"));
  assert.ok(more.entries.some((e) => e.kind === "ownership"));
  const restored = migrateCliStore({
    ...DEFAULT_CLI_STORE,
    inventory: { ...next, changes: more },
  });
  assert.deepEqual(restored.inventory?.changes, more);
});
test("CLI missing inventory entries require positive absence and complete scan evidence", async () => {
  const old = await fixture(),
    next = structuredClone(old);
  const removed = next.installations.find((i) => i.presence === "present")!;
  next.installations = next.installations.filter((i) => i.id !== removed.id);
  assert.ok(
    compareCliInventories(old, next)!.entries.some(
      (e) => e.installationId === removed.id && e.kind === "uncertain",
    ),
  );
  next.completeness = "partial";
  assert.ok(
    !compareCliInventories(old, next, new Set([removed.id]))!.entries.some(
      (e) => e.kind === "removed",
    ),
  );
  next.completeness = "complete";
  assert.ok(
    compareCliInventories(old, next, new Set([removed.id]))!.entries.some(
      (e) => e.kind === "removed",
    ),
  );
  const reverse = compareCliInventories(next, old)!;
  assert.ok(reverse.entries.some((e) => e.kind === "added"));
});
test("an unavailable executable or failed source is uncertain rather than removed", async () => {
  const old = await fixture(),
    next = structuredClone(old);
  const item = next.installations.find((i) => i.presence === "present")!;
  item.presence = "unknown";
  item.issueCodes.push("package-source-unavailable");
  const diff = compareCliInventories(old, next)!;
  assert.ok(diff.entries.some((e) => e.kind === "uncertain"));
  assert.ok(!diff.entries.some((e) => e.kind === "removed"));
  next.completeness = "partial";
  assert.equal((await confirmedAbsent(old, next)).size, 0);
});
test("absence verification checks actual endpoints and never treats existing paths as removal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-cli-diff-"));
  try {
    const old = await fixture(),
      next = structuredClone(old),
      item = old.installations.find((i) => i.presence === "present")!;
    const endpoint = old.endpoints.find((e) =>
      item.endpointIds.includes(e.id),
    )!;
    item.endpointIds = [endpoint.id];
    endpoint.path = path.join(root, "tool.exe");
    next.installations = next.installations.filter((i) => i.id !== item.id);
    next.completeness = "complete";
    next.sourceResults = [];
    await fs.writeFile(endpoint.path, "fixture");
    assert.ok(!(await confirmedAbsent(old, next)).has(item.id));
    await fs.unlink(endpoint.path);
    assert.ok((await confirmedAbsent(old, next)).has(item.id));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("CLI change persistence is bounded and allowlisted", () => {
  const result = sanitizeCliChanges({
    schemaVersion: 1,
    comparedAt: 2,
    baselineAt: 1,
    entries: Array.from({ length: 300 }, () => ({
      kind: "version",
      productId: "node",
      name: "Node",
      before: "1",
      after: "2",
      rawOutput: "secret",
      env: { TOKEN: "secret" },
    })),
  })!;
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|rawOutput|TOKEN/);
});

test("a dangling endpoint link is unavailable rather than confidently removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-cli-link-"));
  try {
    const previous = await fixture(),
      next = structuredClone(previous);
    const item = previous.installations.find((i) => i.presence === "present")!;
    const endpoint = previous.endpoints.find((e) =>
      item.endpointIds.includes(e.id),
    )!;
    item.endpointIds = [endpoint.id];
    const target = path.join(root, "target");
    endpoint.path = path.join(root, "tool-link");
    await fs.mkdir(target);
    await fs.symlink(
      target,
      endpoint.path,
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.rmdir(target);
    next.installations = next.installations.filter((i) => i.id !== item.id);
    next.completeness = "complete";
    next.sourceResults = [];
    assert.ok(!(await confirmedAbsent(previous, next)).has(item.id));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
