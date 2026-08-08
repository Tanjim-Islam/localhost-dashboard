import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { calculateUnionRecoverableBytes } from "../src/main/cleaner/scanner";
import {
  createCleanerFixture,
  removeCleanerFixture,
  scanFixture,
  TestMemoryPersistence,
  updateFixtureManifest,
} from "./cleaner-test-helpers";

test("Cleaner standard detectors classify known data conservatively", async () => {
  const root = await createCleanerFixture();
  try {
    const { result } = await scanFixture(root, "standard");
    const byDetector = new Map(
      result.findings.map((item) => [item.detectorId, item]),
    );

    assert.equal(byDetector.get("dev.npm-cache")?.safety, "safe-now");
    assert.equal(byDetector.get("dev.uv-cache")?.safety, "manual-review");
    assert.equal(
      byDetector.get("dev.uv-cache")?.measurementCompleteness,
      "partial",
    );
    assert.equal(
      byDetector.get("dev.uv-cache")?.estimatedReclaimableBytes,
      null,
    );
    assert.equal(byDetector.get("dev.uv-cache")?.canDelete, false);
    assert.equal(byDetector.get("dev.uv-cache")?.manualApprovalAllowed, false);
    assert.match(
      byDetector.get("dev.uv-cache")?.reason ?? "",
      /Run Deep Audit for complete accounting/i,
    );
    assert.match(byDetector.get("dev.uv-cache")?.reason ?? "", /exact/i);
    assert.match(
      byDetector.get("dev.uv-cache")?.restoration ?? "",
      /recreates/i,
    );
    assert.deepEqual(
      byDetector.get("dev.uv-cache")?.relatedProcesses.map((item) => item.name),
      ["python.exe", "uv.exe"],
    );
    assert.equal(
      byDetector
        .get("dev.uv-cache")
        ?.relatedProcesses.find((item) => item.name === "uv.exe")
        ?.evidenceStrength,
      "confirmed-consumer",
    );
    assert.equal(
      byDetector
        .get("dev.uv-cache")
        ?.relatedProcesses.find((item) => item.name === "python.exe")?.blocking,
      false,
    );
    assert.equal(byDetector.get("dev.pnpm-store")?.safety, "conditional");
    assert.equal(byDetector.get("dev.playwright")?.safety, "protected");
    assert.equal(byDetector.get("dev.puppeteer")?.safety, "protected");
    assert.equal(
      byDetector.get("dev.miniconda.environments")?.safety,
      "protected",
    );
    assert.equal(byDetector.get("models.huggingface")?.safety, "protected");
    assert.equal(byDetector.get("dev.go-build-cache")?.safety, "safe-now");
    assert.equal(byDetector.get("dev.go-module-cache")?.safety, "conditional");
    assert.equal(byDetector.get("dev.gradle-cache")?.safety, "manual-review");
    assert.equal(
      byDetector.get("dev.gradle-cache")?.estimatedReclaimableBytes,
      null,
    );
    assert.equal(
      byDetector.get("dev.gradle-cache")?.manualApprovalAllowed,
      true,
    );
    assert.equal(byDetector.get("dev.rust-toolchains")?.safety, "protected");
    assert.equal(byDetector.get("sdk.android")?.safety, "protected");
    assert.equal(byDetector.get("browser.brave.profile")?.safety, "protected");
    assert.equal(byDetector.get("browser.chrome.profile")?.safety, "protected");
    assert.equal(
      byDetector.get("browser.firefox.profile")?.safety,
      "protected",
    );
    assert.equal(byDetector.get("app.codex-home")?.safety, "protected");
    assert.equal(byDetector.get("app.slack")?.safety, "protected");
    assert.equal(
      byDetector.get("virtualization.docker-vhdx")?.recoverableBytes,
      0,
    );
    assert.equal(
      byDetector.get("virtualization.wsl-vhdx")?.recoverableBytes,
      0,
    );
    assert.equal(byDetector.get("database.postgresql")?.canDelete, false);
    assert.equal(byDetector.get("windows.user-temp")?.safety, "manual-review");
    assert.equal(
      byDetector.get("windows.user-temp")?.manualApprovalAllowed,
      true,
    );
    assert.equal(
      byDetector.get("browser.brave.profile")?.manualApprovalAllowed,
      false,
    );
    assert.equal(byDetector.get("windows.winsxs")?.canDelete, false);
    assert.equal(byDetector.get("windows.installer")?.canDelete, false);
    assert.ok(result.summary.estimatedRecoverableBytes > 0);
    assert.equal(
      result.summary.estimatedRecoverableBytes,
      calculateUnionRecoverableBytes(result.findings, "safe-now"),
    );
    assert.equal(
      result.summary.conditionalRecoverableBytes,
      calculateUnionRecoverableBytes(result.findings, "conditional"),
    );
    assert.equal(result.testMode, true);
  } finally {
    await removeCleanerFixture(root);
  }
});

test("Cleaner deep audit finds bounded project artifacts and editor leftovers", async () => {
  const root = await createCleanerFixture();
  try {
    const { result } = await scanFixture(root, "deep");
    const find = (id: string) =>
      result.findings.find((item) => item.detectorId === id);
    assert.equal(find("project.node-modules")?.safety, "conditional");
    assert.equal(find("project.-next")?.safety, "conditional");
    assert.equal(find("project.-venv")?.safety, "protected");
    assert.match(
      find("project.node-modules")?.reason ?? "",
      /marker-confirmed/i,
    );
    assert.equal(find("editor.vscode.cache")?.safety, "protected");
    assert.equal(find("editor.vscode.extensions")?.safety, "protected");
    assert.equal(find("editor.windsurf.cache")?.safety, "safe-now");
    assert.equal(
      find("editor.windsurf.cache")?.leftoverCacheStatus,
      "leftover-cache",
    );
    assert.equal(find("editor.windsurf.extensions")?.safety, "conditional");
    assert.equal(find("editor.jetbrains.version-root")?.safety, "protected");
    assert.equal(find("editor.jetbrains.typed-cache")?.safety, "safe-now");
    assert.match(
      find("editor.cursor.history")?.reason ?? "",
      /recoverable state/i,
    );
    assert.equal(find("manual.profile-cache")?.safety, "manual-review");
    assert.equal(find("manual.profile-cache")?.manualApprovalAllowed, true);
    assert.equal(
      find("editor.antigravity.extensions")?.safety,
      "manual-review",
    );
    assert.equal(
      find("editor.antigravity.extensions")?.manualApprovalAllowed,
      true,
    );
    const uv = find("dev.uv-cache");
    assert.equal(uv?.measurementCompleteness, "complete");
    assert.equal(uv?.logicalTraversalComplete, true);
    assert.equal(uv?.physicalAccountingComplete, true);
    assert.equal(uv?.logicalBytes, 9_690_000_000);
    assert.equal(uv?.estimatedReclaimableBytes, 2_221_572_096);
    assert.equal(uv?.measuredFileCount, 479_669);
    assert.equal(uv?.measuredDirectoryCount, 71_185);
    assert.equal(uv?.accountingConfidence, "estimated");
    assert.equal(uv?.safety, "safe-after-close");
    assert.equal(uv?.canDelete, true);
    assert.equal(
      result.summary.scanWarnings.some((warning) =>
        /run Deep Audit for complete accounting/i.test(warning),
      ),
      false,
    );

    const sourcePath = path.join(
      root,
      "Projects",
      "sample-app",
      "src",
      "index.ts",
    );
    assert.equal(
      await fs.readFile(sourcePath, "utf8"),
      "export const fixture = true;\n",
    );
    assert.equal(
      result.findings.some((item) => item.path === sourcePath),
      false,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("related process matching avoids similarly named unrelated applications", async () => {
  const root = await createCleanerFixture();
  try {
    await updateFixtureManifest(root, (manifest) => {
      manifest.evidence.processes = [
        {
          name: "node-helper.exe",
          pid: 7001,
          commandCategory: "unknown",
          referencedPaths: [],
        },
      ];
    });
    const { result } = await scanFixture(root, "standard");
    assert.equal(
      result.findings.find((item) => item.detectorId === "dev.npm-cache")
        ?.safety,
      "safe-now",
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("detectors do not report nearby unrelated paths", async () => {
  const root = await createCleanerFixture();
  try {
    const unrelated = path.join(
      root,
      "User",
      "AppData",
      "Local",
      "npm-cache-copy",
    );
    await fs.mkdir(unrelated, { recursive: true });
    await fs.writeFile(path.join(unrelated, "personal.txt"), "keep\n");
    const { result } = await scanFixture(root, "standard");
    assert.equal(
      result.findings.some((item) => item.path === unrelated),
      false,
    );
    assert.equal(
      await fs.readFile(path.join(unrelated, "personal.txt"), "utf8"),
      "keep\n",
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("exclusions persist and apply after a new scan", async () => {
  const root = await createCleanerFixture();
  const persistence = new TestMemoryPersistence();
  try {
    const first = await scanFixture(root, "standard", persistence);
    const npm = first.result.findings.find(
      (item) => item.detectorId === "dev.npm-cache",
    )!;
    const state = persistence.read();
    state.exclusions.push({
      id: "1234567890abcdef12345678",
      scope: "detector",
      value: "dev.npm-cache",
      label: "npm cache",
      createdAt: Date.now(),
    });
    persistence.write(state);
    const second = await scanFixture(root, "standard", persistence);
    const excluded = second.result.findings.find((item) => item.id === npm.id)!;
    assert.equal(excluded.excluded, true);
    assert.equal(excluded.recoverableBytes, 0);
    assert.equal(
      second.result.summary.safeNowBytes,
      first.result.summary.safeNowBytes - npm.sizeBytes,
    );
    assert.equal(
      second.result.summary.estimatedRecoverableBytes <
        first.result.summary.estimatedRecoverableBytes,
      true,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});
