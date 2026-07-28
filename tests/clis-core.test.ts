import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import {
  CLI_CATALOGUE,
  findCliByCommand,
  findCliByPackage,
  getCliDefinition,
  getCliDefinitions,
} from "../src/main/clis/catalogue";
import {
  createEndpointFingerprint,
  createInstallationId,
  normalizeCliPath,
  stableCliId,
} from "../src/main/clis/fingerprint";
import {
  buildMinimalEnvironment,
  sanitizeProcessText,
  validateCliCommandSpec,
} from "../src/main/clis/command-runner";
import {
  DEFAULT_CLI_STORE,
  MAX_CLI_SCAN_ATTEMPTS,
  MemoryCliPersistence,
  migrateCliStore,
} from "../src/main/clis/store";
import { CliScanSessionManager } from "../src/main/clis/session";
import {
  validateCliInstallationRef,
  validateCliUninstallRequest,
} from "../src/main/clis/ipc-validation";
import { createCliUninstallPlan } from "../src/main/clis/uninstall-controller";
import { calculateUninstallCapability } from "../src/main/clis/uninstall-policy";
import { matchInstallations } from "../src/main/clis/installation-matcher";
import type {
  CliInstallation,
  CliPackageIdentity,
  CliPackageSource,
  CliPlatform,
} from "../src/main/clis/types";

test("catalogue covers every required CLI category", () => {
  const categories = new Set(CLI_CATALOGUE.map((item) => item.category));
  assert.deepEqual(
    [...categories].sort(),
    [
      "ai-coding",
      "build-tool",
      "cloud",
      "database",
      "developer-tool",
      "infrastructure",
      "package-manager",
      "runtime",
    ].sort(),
  );
  assert.ok(CLI_CATALOGUE.length >= 60);
});

test("catalogue maps commands and exact package aliases", () => {
  assert.equal(findCliByCommand("CODEX", "win32")?.id, "codex");
  assert.equal(
    findCliByPackage("npm", "@anthropic-ai/claude-code", "darwin")?.id,
    "claude-code",
  );
  assert.equal(
    findCliByPackage("npm", "@shopify/cli", "win32")?.id,
    "shopify",
  );
});

test("catalogue keeps Windows-only commands off macOS", () => {
  assert.equal(findCliByCommand("msbuild", "darwin"), undefined);
  assert.equal(findCliByCommand("msbuild", "win32")?.id, "msbuild");
  assert.ok(getCliDefinitions("darwin").every((item) => item.id !== "msbuild"));
});

test("catalogue excludes unsafe probes for npx, nvm, and Firebase", () => {
  for (const productId of ["npx", "nvm", "firebase"]) {
    const definition = CLI_CATALOGUE.find((item) => item.id === productId);
    assert.ok(definition);
    assert.equal(definition.versionProbe, undefined);
  }
});

test("stable installation IDs exclude package version", () => {
  const base = {
    platform: "win32" as const,
    productId: "codex",
    packageIdentity: {
      source: "npm" as const,
      packageId: "@openai/codex",
      packageVersion: "1.0.0",
      scope: "user" as const,
      managerRoot: "C:\\Users\\fixture\\npm",
      installRoot: "C:\\Users\\fixture\\npm\\node_modules\\@openai\\codex",
      ownershipConfidence: "exact" as const,
    },
  };
  const first = createInstallationId(base);
  const second = createInstallationId({
    ...base,
    packageIdentity: { ...base.packageIdentity, packageVersion: "2.0.0" },
  });
  assert.equal(first, second);
});

test("endpoint fingerprint changes when target metadata changes", () => {
  const endpoint = {
    commandName: "codex",
    kind: "native" as const,
    path: "C:\\fixture\\codex.exe",
    canonicalPath: "C:\\fixture\\codex.exe",
    accessible: true,
    executable: true,
    targetExists: true,
    fileSize: 10,
    modifiedAt: 100,
  };
  assert.notEqual(
    createEndpointFingerprint(endpoint, "win32"),
    createEndpointFingerprint({ ...endpoint, modifiedAt: 101 }, "win32"),
  );
});

test("Windows path normalization and stable serialization are deterministic", () => {
  assert.equal(
    normalizeCliPath("C:\\Tools\\CODEX.EXE", "win32"),
    "c:\\tools\\codex.exe",
  );
  assert.equal(
    stableCliId("test", { b: 2, a: 1 }),
    stableCliId("test", { a: 1, b: 2 }),
  );
});

test("minimal child environment omits credential-shaped variables", () => {
  const env = buildMinimalEnvironment({
    PATH: "C:\\fixture",
    GH_TOKEN: "secret",
    SAFE_SETTING: "allowed",
  });
  assert.equal(env.PATH, "C:\\fixture");
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.SAFE_SETTING, "allowed");
  assert.match(
    sanitizeProcessText("token=abc123 error"),
    /token=\[redacted\]/,
  );
});

test("command validation accepts the bounded Windows evidence payload", () => {
  const base = {
    executable: path.resolve("fixture-command"),
    args: ["x".repeat(6_920)],
    timeoutMs: 15_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  };
  assert.doesNotThrow(() => validateCliCommandSpec(base));
  assert.throws(
    () =>
      validateCliCommandSpec({
        ...base,
        args: ["x".repeat(16_385)],
      }),
    /arguments are invalid/i,
  );
  assert.throws(
    () =>
      validateCliCommandSpec({
        ...base,
        args: Array.from({ length: 4 }, () => "x".repeat(7_000)),
      }),
    /arguments are invalid/i,
  );
});

test("package ownership fallback never captures a different CLI product", () => {
  const matches = matchInstallations(
    {
      platform: "win32",
      architecture: "x64",
      env: {},
      homeDirectory: "C:\\fixture",
      pathValue: "C:\\fixture\\bin",
      pathExtValue: ".EXE",
      knownDirectories: [],
      neutralWorkingDirectory: "C:\\fixture\\neutral",
      testMode: true,
    },
    [
      {
        productId: "pip",
        endpoint: {
          id: "endpoint-pip",
          commandName: "pip",
          kind: "native",
          path: "C:\\Python313\\Scripts\\pip.exe",
          canonicalPath: "C:\\Python313\\Scripts\\pip.exe",
          pathIndex: 0,
          pathextIndex: 0,
          accessible: true,
          executable: true,
          targetExists: true,
          fingerprint: "fingerprint-pip",
        },
      },
    ],
    [
      {
        productId: "git",
        sourceId: "windows-registry",
        packageIdentity: makeIdentity({
          source: "registry",
          packageId: "Git",
          installRoot: "C:\\Program Files\\Git",
        }),
        commandNames: ["git"],
        binEntries: [],
        version: "2.49.0",
      },
    ],
  );
  assert.equal(
    matches.find((installation) => installation.productId === "git")?.endpoints
      .length,
    0,
  );
  assert.equal(
    matches.find((installation) => installation.productId === "pip")?.endpoints
      .length,
    1,
  );
});

test("store migration rejects invalid inventory and bounds history", () => {
  const migrated = migrateCliStore({
    ...DEFAULT_CLI_STORE,
    inventory: { unsafe: true },
    scanAttempts: Array.from(
      { length: MAX_CLI_SCAN_ATTEMPTS + 10 },
      (_, index) => ({
        scanSessionId: `session-${index}`,
        startedAt: index,
        finishedAt: index + 1,
        status: "complete",
        sourceFailureCount: 0,
      }),
    ),
  });
  assert.equal(migrated.inventory, null);
  assert.equal(migrated.scanAttempts.length, MAX_CLI_SCAN_ATTEMPTS);

  const persistence = new MemoryCliPersistence();
  persistence.write(migrated);
  assert.deepEqual(persistence.read(), migrated);
});

test("scan sessions permit one active scan and typed cancellation", () => {
  let now = 100;
  const sessions = new CliScanSessionManager({ now: () => now });
  const first = sessions.create();
  assert.throws(() => sessions.create(), /already running/);
  const cancelling = sessions.cancel(first.id);
  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.cancellation.isCancelled, true);
  now = 200;
  cancelling.status = "cancelled";
  cancelling.finishedAt = now;
  assert.equal(sessions.create().startedAt, 200);
});

test("IPC validators accept only IDs and fixed confirmation", () => {
  const ref = validateCliInstallationRef({
    installationId: "cli-12345678",
    inventoryRevision: "revision-12345678",
  });
  assert.equal(ref.installationId, "cli-12345678");
  assert.throws(() =>
    validateCliInstallationRef({
      installationId: "bad path",
      inventoryRevision: "revision-12345678",
    }),
  );
  assert.throws(() =>
    validateCliUninstallRequest({
      ...ref,
      previewToken: "token-12345678",
      confirmation: "yes",
    }),
  );
  assert.equal(
    validateCliUninstallRequest({
      ...ref,
      previewToken: "token-12345678",
      confirmation: "uninstall-exact-cli-installation",
    }).confirmation,
    "uninstall-exact-cli-installation",
  );
});

test("supported uninstall managers use fixed exact argument arrays", () => {
  const npm = createCliUninstallPlan(
    makeOwnedInstallation({
      source: "npm",
      packageId: "@openai/codex",
      managerExecutablePath: "C:\\fixture\\node.exe",
      managerRoot: "C:\\fixture\\npm",
      managerCommandPath:
        "C:\\fixture\\npm\\node_modules\\npm\\bin\\npm-cli.js",
    }),
  );
  assert.deepEqual(npm.args, [
    "C:\\fixture\\npm\\node_modules\\npm\\bin\\npm-cli.js",
    "uninstall",
    "--global",
    "--ignore-scripts",
    "@openai/codex",
  ]);
  assert.equal(npm.env?.npm_config_ignore_scripts, "true");

  const pipx = createCliUninstallPlan(
    makeOwnedInstallation({
      source: "pipx",
      packageId: "poetry",
      managerExecutablePath: "C:\\fixture\\pipx.exe",
      managerRoot: "C:\\fixture\\pipx",
    }),
  );
  assert.deepEqual(pipx.args, ["uninstall", "poetry"]);

  const cargo = createCliUninstallPlan(
    makeOwnedInstallation({
      source: "cargo",
      packageId: "cargo-edit",
      managerExecutablePath: "C:\\fixture\\cargo.exe",
      managerRoot: "C:\\fixture\\cargo-root",
    }),
  );
  assert.deepEqual(cargo.args, [
    "uninstall",
    "--root",
    "C:\\fixture\\cargo-root",
    "--package",
    "cargo-edit",
  ]);

  const scoop = createCliUninstallPlan(
    makeOwnedInstallation({
      source: "scoop",
      packageId: "opencode",
      managerExecutablePath: "C:\\fixture\\scoop\\shims\\scoop.ps1",
      managerRoot: "C:\\fixture\\scoop",
      uninstallEvidence: "simple-manifest",
    }),
  );
  assert.match(scoop.executable.toLowerCase(), /powershell\.exe$/);
  assert.deepEqual(scoop.args.slice(-3), [
    "C:\\fixture\\scoop\\shims\\scoop.ps1",
    "uninstall",
    "opencode",
  ]);

  const homebrew = createCliUninstallPlan(
    makeOwnedInstallation(
      {
        source: "homebrew-formula",
        packageId: "terraform",
        managerExecutablePath: "/opt/homebrew/bin/brew",
        managerRoot: "/opt/homebrew",
      },
      "darwin",
    ),
  );
  assert.deepEqual(homebrew.args, ["uninstall", "--formula", "terraform"]);
  assert.equal(homebrew.env?.HOMEBREW_NO_AUTO_UPDATE, "1");
});

test("uninstall policy blocks foundational and uncertain ownership", () => {
  assert.equal(
    calculateUninstallCapability({
      definition: getCliDefinition("node"),
      identity: makeIdentity({
        source: "homebrew-formula",
        packageId: "node",
        managerExecutablePath: "/opt/homebrew/bin/brew",
        managerRoot: "/opt/homebrew",
      }),
      commands: ["node"],
      presence: "present",
      sourceFailed: false,
    }).status,
    "manual-only",
  );
  assert.equal(
    calculateUninstallCapability({
      definition: getCliDefinition("codex"),
      identity: undefined,
      commands: ["codex"],
      presence: "present",
      sourceFailed: false,
    }).status,
    "blocked",
  );
  assert.equal(
    calculateUninstallCapability({
      definition: getCliDefinition("codex"),
      identity: {
        ...makeIdentity({
          source: "pnpm",
          packageId: "@openai/codex",
          managerExecutablePath: "C:\\fixture\\pnpm.exe",
          managerRoot: "C:\\fixture\\pnpm",
        }),
        ownershipConfidence: "uncertain",
      },
      commands: ["codex"],
      presence: "present",
      sourceFailed: false,
    }).status,
    "blocked",
  );
});

function makeOwnedInstallation(
  identity: Omit<
    CliPackageIdentity,
    "scope" | "ownershipConfidence"
  >,
  platform: CliPlatform = "win32",
): CliInstallation {
  const packageIdentity = makeIdentity(identity);
  return {
    id: "cli-installation-fixture",
    productId: "codex",
    platform,
    architecture: "x64",
    scope: "user",
    origin: "package-manager",
    version: "1.0.0",
    versionSource: "package-metadata",
    verificationStatus: "verified",
    packageIdentity,
    endpointIds: ["endpoint-fixture"],
    commandIds: ["command-fixture"],
    fingerprint: "fingerprint-fixture",
    presence: "present",
    health: "healthy",
    issueCodes: [],
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastVerifiedAt: 1,
    lastSuccessfulVerificationAt: 1,
    uninstallCapability: {
      status:
        identity.source === "npm" || identity.source === "pipx"
          ? "supported"
          : "requires-warning",
      source: identity.source,
      packageId: identity.packageId,
      reasonCode:
        identity.source === "npm" || identity.source === "pipx"
          ? "exact-manager-owned"
          : "multiple-commands",
      reason: "Fixture exact ownership.",
      warnings: [],
      requiresElevation: false,
      providedCommands: ["codex"],
    },
  };
}

function makeIdentity(
  identity: Omit<
    CliPackageIdentity,
    "scope" | "ownershipConfidence"
  >,
): CliPackageIdentity {
  return {
    ...identity,
    source: identity.source as CliPackageSource,
    scope: "user",
    ownershipConfidence: "exact",
  };
}
