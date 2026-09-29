import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { classifyCliAdmission } from "../src/main/clis/admission";
import {
  assembleInventory,
  finalizeHealth,
} from "../src/main/clis/inventory-builder";
import { matchInstallations } from "../src/main/clis/installation-matcher";
import { normalizeCliInventory } from "../src/main/clis/inventory-normalizer";
import { CliController } from "../src/main/clis/controller";
import {
  MemoryCliPersistence,
  DEFAULT_CLI_STORE,
} from "../src/main/clis/store";
import { CliScanner } from "../src/main/clis/scanner";
import { CliCancellationToken } from "../src/main/clis/session";
import { probeVersions } from "../src/main/clis/version-probes";
import { validateCliInclusionRequest } from "../src/main/clis/ipc-validation";
import { getCliInvocation } from "../src/renderer/cli-invocation";
import {
  filterCliProducts,
  formatCliHealth,
  summarizeCliInventory,
  type CliFilters,
} from "../src/renderer/cli-view-model";
import type {
  CliExecutableEndpoint,
  CliInventorySnapshot,
  CliPackageIdentity,
  CliPackageRecord,
  CliPathEndpointRecord,
  CliScanEnvironment,
} from "../src/main/clis/types";

const environment: CliScanEnvironment = {
  platform: "win32",
  architecture: "x64",
  env: {},
  homeDirectory: "C:\\Users\\test",
  pathValue: "",
  pathExtValue: ".EXE;.CMD;.BAT;.PS1",
  knownDirectories: [],
  neutralWorkingDirectory: process.cwd(),
  testMode: true,
};
function endpoint(
  commandName: string,
  file = `C:\\Tools\\${commandName}.exe`,
): CliExecutableEndpoint {
  return {
    id: `endpoint-${commandName}`,
    commandName,
    path: file,
    canonicalPath: file,
    kind: "native",
    accessible: true,
    executable: true,
    targetExists: true,
    fingerprint: `fingerprint-${commandName}`,
  };
}
function build(
  records: CliPathEndpointRecord[],
  packages: CliPackageRecord[] = [],
  previous: CliInventorySnapshot | null = null,
): CliInventorySnapshot {
  const assembled = assembleInventory({
    environment,
    mutable: matchInstallations(environment, records, packages),
    previous,
    failedSourceIds: new Set(),
    now: 2000,
  });
  finalizeHealth(assembled);
  return {
    schemaVersion: 2,
    revision: "revision-admission",
    platform: "win32",
    architecture: "x64",
    generatedAt: 2000,
    completeness: "complete",
    cached: false,
    sourceResults: [],
    ...assembled,
  };
}
const filters: CliFilters = {
  query: "",
  category: "all",
  health: "all",
  source: "all",
  presence: "installed",
  duplicatesOnly: false,
};

test("an owner, version or PATH position does not qualify an undeclared file as a CLI", () => {
  for (const source of [
    "registry",
    "winget",
    "chocolatey",
    "homebrew-cask",
    "unknown",
  ] as const) {
    assert.equal(
      classifyCliAdmission({
        productId: "discovered-app",
        packageIdentity: {
          source,
          packageId: "An installed desktop app",
          scope: "machine",
          ownershipConfidence: "exact",
        },
      }),
      "candidate",
    );
  }
  for (const source of [
    "npm",
    "pip",
    "pipx",
    "uv",
    "cargo",
    "scoop",
    "homebrew-formula",
  ] as const) {
    assert.equal(
      classifyCliAdmission({
        productId: "new-package",
        packageIdentity: {
          source,
          packageId: "new-package",
          scope: "user",
          ownershipConfidence: "exact",
        },
      }),
      "package-command",
    );
  }
  const names = [
    "pingsender",
    "nmhproxy",
    "GPUChecker",
    "InstallPSCorePolicyDefinitions",
    "SteamHelper",
    "tool",
  ];
  const records = names.map((name) => ({
    productId: `discovered-command:${name.toLowerCase()}`,
    endpoint: {
      ...endpoint(name),
      pathIndex: 0,
      ownerName: "Known owner",
      fileVersion: "1.0",
    },
  }));
  const inventory = build(records);
  for (const presence of ["installed", "all", "embedded"] as const)
    assert.equal(
      filterCliProducts(inventory, { ...filters, presence }).length,
      0,
    );
  assert.equal(
    filterCliProducts(inventory, { ...filters, presence: "candidates" }).length,
    names.length,
  );
  assert.equal(summarizeCliInventory(inventory).installed, 0);
  assert.equal(
    formatCliHealth(inventory.installations[0], inventory),
    "Discovered",
  );
  const restored = normalizeCliInventory(inventory)!;
  assert.equal(summarizeCliInventory(restored).installed, 0);
});

test("documented app commands stay bundled; ownership cannot absorb their helper programs", () => {
  const root = "C:\\Program Files\\BCUninstaller";
  const records = [
    {
      productId: "bcu-console",
      endpoint: endpoint("bcu-console", `${root}\\BCU-console.exe`),
    },
    {
      productId: "discovered-command:steamhelper",
      endpoint: endpoint("steamhelper", `${root}\\SteamHelper.exe`),
    },
    { productId: "powertoys-cli", endpoint: endpoint("filelocksmithcli") },
    { productId: "fd", endpoint: endpoint("fd") },
    { productId: "ast-grep", endpoint: endpoint("ast-grep") },
  ];
  const packages: CliPackageRecord[] = [
    {
      productId: "bcu-console",
      sourceId: "windows-registry",
      commandNames: ["bcu-console", "steamhelper"],
      binEntries: [],
      packageIdentity: {
        source: "registry",
        packageId: "BCUninstaller",
        installRoot: root,
        scope: "machine",
        ownershipConfidence: "exact",
      },
    },
  ];
  const inventory = build(records, packages);
  assert.deepEqual(
    filterCliProducts(inventory, filters)
      .map((item) => item.id)
      .sort(),
    ["ast-grep", "fd"],
  );
  assert.deepEqual(
    filterCliProducts(inventory, { ...filters, presence: "embedded" })
      .map((item) => item.id)
      .sort(),
    ["bcu-console", "powertoys-cli"],
  );
  const bcu = inventory.installations.find(
    (item) => item.productId === "bcu-console",
  )!;
  assert.equal(bcu.endpointIds.length, 1);
  assert.deepEqual(
    inventory.commands
      .filter((item) => item.installationId === bcu.id)
      .map((item) => item.name),
    ["bcu-console"],
  );
  assert.equal(bcu.uninstallCapability.status, "blocked");
  // Migrate older cached grouping without enumerating files or running commands.
  bcu.endpointIds.push(records[1].endpoint.id);
  bcu.uninstallCapability.providedCommands.push("steamhelper");
  const normalized = normalizeCliInventory(inventory)!;
  assert.equal(
    normalized.installations.find((item) => item.productId === "bcu-console")!
      .endpointIds.length,
    1,
  );
});

test("manual inclusion survives persistence and rescans and does not run the tool", () => {
  const records = [
    { productId: "discovered-command:my-tool", endpoint: endpoint("my-tool") },
  ];
  const inventory = build(records);
  const persistence = new MemoryCliPersistence({
    ...structuredClone(DEFAULT_CLI_STORE),
    inventory,
  });
  const runner = {
    run: async () => {
      throw new Error("No command may run when changing list preferences.");
    },
  };
  const controller = new CliController({
    persistence,
    runner,
    clock: { now: () => 2000 },
    scanner: new CliScanner({
      runner,
      clock: { now: () => 2000 },
      createEnvironment: async () => {
        throw new Error("No scan expected.");
      },
    }),
  });
  const ref = {
    installationId: inventory.installations[0].id,
    inventoryRevision: inventory.revision,
  };
  const included = controller.setInstallationIncluded(ref, true);
  assert.equal(summarizeCliInventory(included).installed, 1);
  assert.equal(included.installations[0].discoveryKind, "user");
  assert.equal(
    summarizeCliInventory(normalizeCliInventory(persistence.read().inventory)!)
      .installed,
    1,
  );
  assert.equal(
    summarizeCliInventory(build(records, [], included)).installed,
    1,
  );
  assert.throws(
    () => controller.setInstallationIncluded(ref, false),
    /changed|stale/i,
  );
  const removed = controller.setInstallationIncluded(
    { ...ref, inventoryRevision: included.revision },
    false,
  );
  assert.equal(summarizeCliInventory(removed).installed, 0);
  assert.equal(removed.endpoints[0].targetExists, true);
  assert.equal(persistence.read().scanAttempts.length, 0);
  assert.throws(
    () => validateCliInclusionRequest({ ...ref, included: "yes" }),
    /Invalid/,
  );
  assert.deepEqual(
    validateCliInclusionRequest({
      ...ref,
      included: true,
      path: "C:\\arbitrary",
    }),
    { ...ref, included: true },
  );
});

test("copy command targets the exact installation with shell quoting, independently of PATH and aliases", () => {
  const file = "C:\\Tool's & files\\bcu-console.exe";
  const inventory = build([
    { productId: "bcu-console", endpoint: endpoint("bcu-console", file) },
  ]);
  const installation = inventory.installations[0];
  assert.equal(inventory.commands[0].pathRole, "not-on-path");
  assert.equal(
    getCliInvocation(inventory, installation, "powershell"),
    "& 'C:\\Tool''s & files\\bcu-console.exe'",
  );
  assert.equal(getCliInvocation(inventory, installation, "cmd"), `"${file}"`);
  const other = endpoint("bcu-console", "C:\\Other\\bcu-console.exe");
  other.id = "endpoint-other";
  other.pathIndex = 0;
  inventory.endpoints.push(other);
  assert.equal(
    getCliInvocation(inventory, installation, "powershell"),
    "& 'C:\\Tool''s & files\\bcu-console.exe'",
  );
  inventory.endpoints[0].path = "C:\\%TEMP%\\bcu-console.exe";
  assert.equal(getCliInvocation(inventory, installation, "cmd"), undefined);
  inventory.endpoints[0].targetExists = false;
  assert.equal(
    getCliInvocation(inventory, installation, "powershell"),
    undefined,
  );
});

test("Windows copy prefers runnable shims and never copies a POSIX companion or raw JS target", () => {
  const inventory = build([
    {
      productId: "claude-code",
      endpoint: endpoint("claude", "C:\\Tools\\claude.cmd"),
    },
  ]);
  const installation = inventory.installations[0];
  assert.equal(
    getCliInvocation(inventory, installation, "powershell"),
    "& 'C:\\Tools\\claude.cmd'",
  );
  inventory.endpoints[0].path = "C:\\Tools\\claude";
  assert.equal(
    getCliInvocation(inventory, installation, "powershell"),
    undefined,
  );
  inventory.endpoints[0].path = "C:\\Tools\\cli.js";
  assert.equal(
    getCliInvocation(inventory, installation, "powershell"),
    undefined,
  );
  installation.packageIdentity = {
    source: "npm",
    packageId: "cli",
    scope: "user",
    ownershipConfidence: "exact",
    managerExecutablePath: "C:\\Tools\\node.exe",
  };
  assert.equal(
    getCliInvocation(inventory, installation, "powershell"),
    "& 'C:\\Tools\\node.exe' 'C:\\Tools\\cli.js'",
  );
  installation.platform = "darwin";
  inventory.endpoints[0].path = "/Users/test/My tools/tool's-cli";
  assert.equal(
    getCliInvocation(inventory, installation, "posix"),
    "'/Users/test/My tools/tool'\"'\"'s-cli'",
  );
});

test("Verified requires a successful known probe, not a package version or a readable file", async () => {
  const inventory = build([
    { productId: "claude-code", endpoint: endpoint("claude") },
  ]);
  const installation = inventory.installations[0];
  installation.version = "1.0.0";
  installation.versionSource = "package-metadata";
  assert.equal(formatCliHealth(installation, inventory), "Installed");
  let calls = 0;
  let exitCode = 0;
  const options = {
    environment,
    ...inventory,
    previous: null,
    cancellation: new CliCancellationToken(),
    onProgress: () => undefined,
    now: () => 3000,
    runner: {
      run: async (spec: { executable: string }) => {
        calls++;
        return {
          executable: spec.executable,
          stdout: "1.0.0",
          stderr: "",
          exitCode,
          timedOut: false,
          cancelled: false,
          outputExceeded: false,
        };
      },
    },
  };
  await probeVersions(options);
  assert.equal(calls, 0);
  await probeVersions({
    ...options,
    verificationInstallationId: installation.id,
  });
  assert.equal(calls, 1);
  assert.equal(formatCliHealth(installation, inventory), "Verified");
  assert.equal(
    formatCliHealth(
      normalizeCliInventory(inventory)!.installations[0],
      inventory,
    ),
    "Verified",
  );
  inventory.endpoints[0].fingerprint = "file-replaced";
  assert.equal(formatCliHealth(installation, inventory), "Installed");
  assert.equal(
    normalizeCliInventory(inventory)!.installations[0].commandVerification,
    undefined,
  );
  exitCode = 1;
  await probeVersions({
    ...options,
    verificationInstallationId: installation.id,
  });
  assert.equal(installation.commandVerification, undefined);
  installation.productId = "discovered-command:do-not-run";
  await probeVersions({
    ...options,
    verificationInstallationId: installation.id,
  });
  assert.equal(calls, 2);
});

test(
  "the copied PowerShell invocation launches a real known runtime even outside PATH",
  { skip: process.platform !== "win32" },
  async () => {
    const inventory = build([
      { productId: "node", endpoint: endpoint("node", process.execPath) },
    ]);
    const invocation = getCliInvocation(
      inventory,
      inventory.installations[0],
      "powershell",
    )!;
    const script = `${invocation} --version`;
    const { stdout } = await promisify(execFile)(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 10000 },
    );
    assert.equal(stdout.trim(), process.version);
  },
);
