import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createPathSnapshot,
  enumerateCliPathEndpoints,
} from "../src/main/clis/adapters/path";
import { parseNodeManagerOutput } from "../src/main/clis/adapters/node-packages";
import {
  assembleInventory,
  finalizeHealth,
} from "../src/main/clis/inventory-builder";
import { matchInstallations } from "../src/main/clis/installation-matcher";
import { normalizeCliInventory } from "../src/main/clis/inventory-normalizer";
import { probeVersions } from "../src/main/clis/version-probes";
import { CliCancellationToken } from "../src/main/clis/session";
import type {
  CliCommandResult,
  CliExecutableEndpoint,
  CliInstallation,
  CliInventorySnapshot,
  CliPackageRecord,
  CliPathEndpointRecord,
  CliScanEnvironment,
} from "../src/main/clis/types";

test("npm package metadata groups cmd, PowerShell, and extensionless launchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-npm-group-"));
  try {
    const fixture = await createNpmFixture({
      root,
      packageId: "@openai/codex",
      commandName: "codex",
      relativeTarget: "bin/codex.js",
      version: "0.145.0",
    });
    const inventory = await buildInventory({
      environment: environment(root, fixture.globalRoot),
      directories: [fixture.globalRoot],
      packages: [fixture.packageRecord],
    });
    const product = requireProduct(inventory, "codex");
    assert.equal(product.currentInstallationIds.length, 1);
    assert.equal(product.removedInstallationIds.length, 0);
    assert.equal(product.health, "healthy");
    assert.equal(product.verificationStatus, "verified");
    assert.doesNotMatch(product.issueCodes.join(","), /path-conflict|duplicate/);

    const installation = requireInstallation(
      inventory,
      product.currentInstallationIds[0],
    );
    assert.equal(installation.endpointIds.length, 3);
    assert.equal(installation.packageIdentity?.source, "npm");
    assert.equal(installation.packageIdentity?.packageId, "@openai/codex");
    assert.equal(installation.version, "0.145.0");
    assert.equal(installation.versionSource, "package-metadata");
    assert.equal(installation.uninstallCapability.status, "supported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real product fixtures keep package installs distinct from genuine standalone installs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-products-"));
  try {
    const claude = await createNpmFixture({
      root,
      packageId: "@anthropic-ai/claude-code",
      commandName: "claude",
      relativeTarget: "bin/claude.exe",
      version: "2.1.220",
    });
    const localBin = path.join(root, ".local", "bin");
    await mkdir(localBin, { recursive: true });
    await writeFile(path.join(localBin, "claude.exe"), "native fixture");
    const eas = await createNpmFixture({
      root: path.join(root, "eas"),
      packageId: "eas-cli",
      commandName: "eas",
      relativeTarget: "bin/run",
      version: "16.19.1",
    });

    const inventory = await buildInventory({
      environment: environment(
        root,
        `${claude.globalRoot};${localBin};${eas.globalRoot}`,
      ),
      directories: [claude.globalRoot, localBin, eas.globalRoot],
      packages: [claude.packageRecord, eas.packageRecord],
    });
    const claudeProduct = requireProduct(inventory, "claude-code");
    assert.equal(claudeProduct.currentInstallationIds.length, 2);
    assert.equal(claudeProduct.health, "warning");
    assert(claudeProduct.issueCodes.includes("path-conflict"));
    assert(!claudeProduct.issueCodes.includes("duplicate-version"));
    const claudeInstallations = claudeProduct.currentInstallationIds.map((id) =>
      requireInstallation(inventory, id),
    );
    assert.equal(
      claudeInstallations.filter(
        (installation) => installation.packageIdentity?.source === "npm",
      ).length,
      1,
    );
    assert.equal(
      claudeInstallations.filter((installation) => !installation.packageIdentity)
        .length,
      1,
    );
    assert(
      claudeInstallations.every(
        (installation) => installation.health === "healthy",
      ),
    );

    const easProduct = requireProduct(inventory, "eas");
    assert.equal(easProduct.currentInstallationIds.length, 1);
    const easInstallation = requireInstallation(
      inventory,
      easProduct.currentInstallationIds[0],
    );
    assert.equal(easInstallation.endpointIds.length, 3);
    assert.equal(easInstallation.packageIdentity?.packageId, "eas-cli");
    assert.equal(easInstallation.version, "16.19.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate-version requires distinct installations with the same known version", () => {
  const active = endpoint({
    id: "docker-active",
    commandName: "docker",
    path: "C:\\DockerA\\docker.exe",
    pathIndex: 0,
  });
  const shadowed = endpoint({
    id: "docker-shadowed",
    commandName: "docker",
    path: "C:\\DockerB\\docker.exe",
    pathIndex: 1,
  });
  const inventory = buildFromRecords({
    records: [
      { productId: "docker", endpoint: active },
      { productId: "docker", endpoint: shadowed },
    ],
    packages: [],
    previous: null,
  });
  inventory.installations[0].version = "29.1.3";
  inventory.installations[1].version = "29.1.3";
  finalizeHealth(inventory);
  assert(
    requireProduct(inventory, "docker").issueCodes.includes("duplicate-version"),
  );

  inventory.installations[1].version = "28.0.0";
  finalizeHealth(inventory);
  assert(
    !requireProduct(inventory, "docker").issueCodes.includes("duplicate-version"),
  );
});

test("embedded Codex runtime tools are separate, hidden from current counts, and not PATH conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-embedded-"));
  try {
    const normal = path.join(root, "pnpm");
    const pnpmTarget = path.join(normal, ".tools", "pnpm-exe", "10.33.0", "pnpm.exe");
    await mkdir(path.dirname(pnpmTarget), { recursive: true });
    await writeFile(pnpmTarget, "pnpm fixture");
    await mkdir(normal, { recursive: true });
    await writeFile(path.join(normal, "pnpm.CMD"), `@"${pnpmTarget}" %*\n`);
    await writeFile(path.join(normal, "pnpm"), `#!/bin/sh\n"${pnpmTarget}" "$@"\n`);

    const embedded = path.join(
      root,
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "bin",
      "fallback",
    );
    const embeddedPackage = path.join(embedded, "node_modules", "pnpm");
    await mkdir(path.join(embeddedPackage, "bin"), { recursive: true });
    await writeFile(
      path.join(embeddedPackage, "package.json"),
      JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/pnpm.cjs" } }),
    );
    await writeFile(path.join(embeddedPackage, "bin", "pnpm.cjs"), "fixture");
    await writeFile(
      path.join(embedded, "pnpm.cmd"),
      `@"node" "${path.join(embeddedPackage, "bin", "pnpm.cjs")}" %*\n`,
    );

    const snapshot = createPathSnapshot({
      platform: "win32",
      pathValue: normal,
      pathExtValue: ".EXE;.CMD;.PS1",
      extraDirectories: [embedded],
    });
    const inventory = await buildInventory({
      environment: environment(root, normal),
      snapshot,
      packages: [],
    });
    const product = requireProduct(inventory, "pnpm");
    assert.equal(product.currentInstallationIds.length, 1);
    assert.equal(product.embeddedInstallationIds.length, 1);
    assert(!product.issueCodes.includes("path-conflict"));
    assert(!product.issueCodes.includes("duplicate-version"));
    const normalInstallation = requireInstallation(
      inventory,
      product.currentInstallationIds[0],
    );
    assert.equal(normalInstallation.endpointIds.length, 2);
    const embeddedInstallation = requireInstallation(
      inventory,
      product.embeddedInstallationIds[0],
    );
    assert.equal(embeddedInstallation.origin, "application-embedded");
    assert.equal(embeddedInstallation.uninstallCapability.status, "blocked");
    assert.equal(
      inventory.commands.find(
        (command) => command.installationId === embeddedInstallation.id,
      )?.pathRole,
      "not-on-path",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("equivalent Docker launchers form one healthy installation", () => {
  const dockerExe = endpoint({
    id: "docker-exe",
    commandName: "docker",
    path: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    pathIndex: 0,
    pathextIndex: 0,
  });
  const dockerScript = endpoint({
    id: "docker-script",
    commandName: "docker",
    path: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker",
    pathIndex: 0,
    kind: "script",
  });
  const inventory = buildFromRecords({
    records: [
      { productId: "docker", endpoint: dockerExe },
      { productId: "docker", endpoint: dockerScript },
    ],
    packages: [],
    previous: null,
  });
  const product = requireProduct(inventory, "docker");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(product.health, "healthy");
  assert.equal(product.verificationStatus, "ownership-unknown");
  assert(!product.issueCodes.includes("path-conflict"));
  assert.equal(
    requireInstallation(inventory, product.currentInstallationIds[0])
      .endpointIds.length,
    2,
  );
});

test("pip command variants group together and unowned Windows aliases are ignored", () => {
  const pip = endpoint({
    id: "pip",
    commandName: "pip",
    path: "C:\\Python313\\Scripts\\pip.exe",
    pathIndex: 10,
  });
  const pip3 = endpoint({
    id: "pip3",
    commandName: "pip3",
    path: "C:\\Python313\\Scripts\\pip3.exe",
    pathIndex: 10,
  });
  const storePip = endpoint({
    id: "store-pip",
    commandName: "pip",
    path: "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps\\pip.exe",
    pathIndex: 20,
    kind: "app-alias",
  });
  const storePip3 = endpoint({
    id: "store-pip3",
    commandName: "pip3",
    path: "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps\\pip3.exe",
    pathIndex: 20,
    kind: "app-alias",
  });
  const inventory = buildFromRecords({
    records: [
      { productId: "pip", endpoint: pip },
      { productId: "pip", endpoint: pip3 },
      { productId: "pip", endpoint: storePip },
      { productId: "pip", endpoint: storePip3 },
    ],
    packages: [],
    previous: null,
  });
  const product = requireProduct(inventory, "pip");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(product.health, "healthy");
  assert(!product.issueCodes.includes("path-conflict"));
  assert(!product.issueCodes.includes("missing-target"));
  const installation = requireInstallation(
    inventory,
    product.currentInstallationIds[0],
  );
  assert.equal(installation.endpointIds.length, 2);
  assert.deepEqual(
    inventory.commands
      .filter((command) => command.installationId === installation.id)
      .map((command) => command.name)
      .sort(),
    ["pip", "pip3"],
  );
});

test("package-only rows and unowned execution aliases do not become Python installations", () => {
  const python = endpoint({
    id: "python",
    commandName: "python",
    path: "C:\\Python313\\python.exe",
    pathIndex: 10,
  });
  const python3 = endpoint({
    id: "python3",
    commandName: "python3",
    path: "C:\\Python313\\python3.exe",
    pathIndex: 10,
  });
  const launcher = endpoint({
    id: "py",
    commandName: "py",
    path: "C:\\Windows\\py.exe",
    pathIndex: 12,
  });
  const storePython = endpoint({
    id: "store-python",
    commandName: "python",
    path: "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
    pathIndex: 20,
    kind: "app-alias",
  });
  const chocolateyPackage: CliPackageRecord = {
    productId: "python",
    sourceId: "chocolatey",
    commandNames: ["python", "python3", "py"],
    binEntries: [],
    version: "3.13.3",
    packageIdentity: {
      source: "chocolatey",
      packageId: "python",
      packageVersion: "3.13.3",
      scope: "machine",
      managerRoot: "C:\\ProgramData\\chocolatey",
      managerExecutablePath: "C:\\ProgramData\\chocolatey\\bin\\choco.exe",
      ownershipConfidence: "exact",
      uninstallEvidence: "manager-owned",
    },
  };
  const inventory = buildFromRecords({
    records: [
      { productId: "python", endpoint: python },
      { productId: "python", endpoint: python3 },
      { productId: "python", endpoint: launcher },
      { productId: "python", endpoint: storePython },
    ],
    packages: [chocolateyPackage],
    previous: null,
  });
  const product = requireProduct(inventory, "python");
  assert.equal(product.currentInstallationIds.length, 2);
  assert.equal(product.health, "healthy");
  assert(!product.issueCodes.includes("path-conflict"));
  assert(!product.issueCodes.includes("missing-target"));
  assert(
    product.currentInstallationIds
      .map((id) => requireInstallation(inventory, id))
      .every((installation) => !installation.packageIdentity),
  );
});

test("Winget-owned execution aliases group with package endpoints without false missing targets", () => {
  const alias = endpoint({
    id: "ngrok-alias",
    commandName: "ngrok",
    path: "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps\\ngrok.exe",
    pathIndex: 20,
    kind: "app-alias",
    accessible: false,
    executable: false,
  });
  const packageExecutable = endpoint({
    id: "ngrok-package",
    commandName: "ngrok",
    path:
      "C:\\Program Files\\WindowsApps\\ngrok.ngrok_3.39.8.0_x64__fixture\\ngrok.exe",
  });
  const packageRecord: CliPackageRecord = {
    productId: "ngrok",
    sourceId: "winget",
    commandNames: ["ngrok"],
    binEntries: [],
    version: "3.39.8.0",
    packageIdentity: {
      source: "winget",
      packageId: "9MVS1J51GMK6",
      packageVersion: "3.39.8.0",
      scope: "unknown",
      managerRoot:
        "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps",
      managerExecutablePath:
        "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
      ownershipConfidence: "corroborated",
      uninstallEvidence: "none",
    },
  };
  const inventory = buildFromRecords({
    records: [
      { productId: "ngrok", endpoint: alias },
      { productId: "ngrok", endpoint: packageExecutable },
    ],
    packages: [packageRecord],
    previous: null,
  });
  const product = requireProduct(inventory, "ngrok");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(product.health, "healthy");
  assert(!product.issueCodes.includes("missing-target"));
  const installation = requireInstallation(
    inventory,
    product.currentInstallationIds[0],
  );
  assert.equal(installation.endpointIds.length, 2);
  assert.equal(installation.version, "3.39.8.0");
  assert.equal(installation.packageIdentity?.source, "winget");
});

test("successful scans discard cached unowned execution aliases", () => {
  const current = endpoint({
    id: "pip-current",
    commandName: "pip",
    path: "C:\\Python313\\Scripts\\pip.exe",
    pathIndex: 10,
  });
  const oldAlias = endpoint({
    id: "pip-old-alias",
    commandName: "pip",
    path: "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps\\pip.exe",
    pathIndex: 20,
    kind: "app-alias",
    targetExists: false,
  });
  const previous = snapshotWithInstallations(
    [historicalInstallation("old-pip-alias", "pip", [oldAlias.id])],
    [oldAlias],
  );
  const inventory = buildFromRecords({
    records: [{ productId: "pip", endpoint: current }],
    packages: [],
    previous,
  });
  const product = requireProduct(inventory, "pip");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(product.removedInstallationIds.length, 0);
  assert.equal(product.installationIds.length, 1);
  assert.equal(product.health, "healthy");
});

test("successful scans discard cached package-only phantom installations", () => {
  const current = endpoint({
    id: "python-current",
    commandName: "python",
    path: "C:\\Python313\\python.exe",
    pathIndex: 10,
  });
  const phantom = historicalInstallation(
    "old-chocolatey-python",
    "python",
    [],
    "package-manager",
  );
  phantom.packageIdentity = {
    source: "chocolatey",
    packageId: "python",
    packageVersion: "3.13.3",
    scope: "machine",
    managerRoot: "C:\\ProgramData\\chocolatey",
    managerExecutablePath: "C:\\ProgramData\\chocolatey\\bin\\choco.exe",
    ownershipConfidence: "exact",
    uninstallEvidence: "manager-owned",
  };
  const previous = snapshotWithInstallations([phantom], []);
  const inventory = buildFromRecords({
    records: [{ productId: "python", endpoint: current }],
    packages: [],
    previous,
  });
  const product = requireProduct(inventory, "python");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(product.removedInstallationIds.length, 0);
  assert.equal(product.installationIds.length, 1);
});

test("a broken launcher is informational when an equivalent launcher works", () => {
  const broken = endpoint({
    id: "gcloud-cmd",
    commandName: "gcloud",
    path: "C:\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd",
    pathIndex: 0,
    pathextIndex: 0,
    kind: "shim",
    targetExists: false,
  });
  const working = endpoint({
    id: "gcloud-shell",
    commandName: "gcloud",
    path: "C:\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud",
    pathIndex: 0,
    kind: "script",
  });
  const inventory = buildFromRecords({
    records: [
      { productId: "gcloud", endpoint: broken },
      { productId: "gcloud", endpoint: working },
    ],
    packages: [],
    previous: null,
  });
  const product = requireProduct(inventory, "gcloud");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(product.health, "healthy");
  assert(!product.issueCodes.includes("broken-shim"));
});

test("Docker uses the curated CLI probe instead of the Docker Desktop package version", async () => {
  const dockerExe = endpoint({
    id: "docker-probe",
    commandName: "docker",
    path: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    pathIndex: 0,
  });
  const packageRecord: CliPackageRecord = {
    productId: "docker",
    sourceId: "windows-registry",
    commandNames: ["docker"],
    binEntries: [],
    version: "4.55.0",
    packageIdentity: {
      source: "registry",
      packageId: "Docker Desktop",
      packageVersion: "4.55.0",
      scope: "machine",
      installRoot: "C:\\Program Files\\Docker\\Docker",
      ownershipConfidence: "corroborated",
      uninstallEvidence: "none",
    },
  };
  const inventory = buildFromRecords({
    records: [{ productId: "docker", endpoint: dockerExe }],
    packages: [packageRecord],
    previous: null,
  });
  assert.equal(inventory.installations[0].version, undefined);
  inventory.installations[0].version = "4.55.0";
  inventory.installations[0].versionSource = "package-metadata";
  const rebuilt = buildFromRecords({
    records: [{ productId: "docker", endpoint: dockerExe }],
    packages: [packageRecord],
    previous: inventory,
  });
  assert.equal(rebuilt.installations[0].version, undefined);
  await probeVersions({
    environment: defaultEnvironment(),
    runner: {
      async run(): Promise<CliCommandResult> {
        return {
          executable: dockerExe.path,
          exitCode: 0,
          stdout: "Docker version 29.1.3, build fixture\n",
          stderr: "",
          timedOut: false,
          cancelled: false,
          outputExceeded: false,
        };
      },
    },
    cancellation: new CliCancellationToken(),
    installations: rebuilt.installations,
    endpoints: rebuilt.endpoints,
    previous: inventory,
    onProgress: () => undefined,
  });
  finalizeHealth(rebuilt);
  assert.equal(rebuilt.installations[0].version, "29.1.3");
  assert.equal(rebuilt.installations[0].versionSource, "version-probe");
  assert.equal(rebuilt.installations[0].health, "healthy");
});

test("cached shim duplicates are repaired while unrelated historical installs stay removed", () => {
  const currentEndpoint = endpoint({
    id: "codex-current-cmd",
    commandName: "codex",
    path: "C:\\Users\\fixture\\AppData\\Roaming\\npm\\codex.cmd",
    pathIndex: 0,
    kind: "shim",
    shimTarget:
      "C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    shimPackageRoot:
      "C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex",
  });
  const extensionless = endpoint({
    id: "codex-current-shell",
    commandName: "codex",
    path: "C:\\Users\\fixture\\AppData\\Roaming\\npm\\codex",
    pathIndex: 0,
    kind: "shim",
    shimTarget: currentEndpoint.shimTarget,
    shimPackageRoot: currentEndpoint.shimPackageRoot,
  });
  const appAlias = endpoint({
    id: "codex-old-app",
    commandName: "codex",
    path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_old\\codex.exe",
    pathIndex: 4,
    targetExists: false,
    accessible: false,
    executable: false,
    kind: "app-alias",
  });
  const packageRecord: CliPackageRecord = {
    productId: "codex",
    sourceId: "npm|fixture",
    commandNames: ["codex"],
    binEntries: [
      {
        commandName: "codex",
        targetPath: currentEndpoint.shimTarget as string,
      },
    ],
    version: "0.145.0",
    packageIdentity: {
      source: "npm",
      packageId: "@openai/codex",
      packageVersion: "0.145.0",
      scope: "user",
      managerRoot: "C:\\Users\\fixture\\AppData\\Roaming\\npm",
      managerExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      managerCommandPath:
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      installRoot:
        "C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex",
      ownershipConfidence: "exact",
      uninstallEvidence: "manager-owned",
    },
  };
  const previous = snapshotWithInstallations([
    historicalInstallation("old-cmd", "codex", [currentEndpoint.id]),
    historicalInstallation("old-shell", "codex", [extensionless.id]),
    historicalInstallation("old-app", "codex", [appAlias.id], "system"),
  ], [currentEndpoint, extensionless, appAlias]);
  const inventory = buildFromRecords({
    records: [
      { productId: "codex", endpoint: currentEndpoint },
      { productId: "codex", endpoint: extensionless },
    ],
    packages: [packageRecord],
    previous,
  });
  const product = requireProduct(inventory, "codex");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(product.removedInstallationIds.length, 1);
  assert.equal(product.installationIds.length, 2);
  assert.equal(product.health, "healthy");
  assert.equal(product.verificationStatus, "verified");
  assert(!product.issueCodes.includes("cached-missing"));
});

test("runtime health stays independent from ownership, version, and history", () => {
  const unknown = endpoint({
    id: "unknown-eas",
    commandName: "eas",
    path: "C:\\Tools\\eas.exe",
    pathIndex: 0,
  });
  const inventory = buildFromRecords({
    records: [{ productId: "eas", endpoint: unknown }],
    packages: [],
    previous: null,
  });
  const product = requireProduct(inventory, "eas");
  const installation = requireInstallation(
    inventory,
    product.currentInstallationIds[0],
  );
  assert.equal(installation.health, "healthy");
  assert.equal(installation.verificationStatus, "ownership-unknown");
  assert.equal(product.health, "healthy");
  assert.equal(product.verificationStatus, "ownership-unknown");

  const brokenEndpoint = endpoint({
    id: "broken-eas",
    commandName: "eas",
    path: "C:\\Broken\\eas.cmd",
    pathIndex: 0,
    kind: "shim",
    targetExists: false,
  });
  const broken = buildFromRecords({
    records: [{ productId: "eas", endpoint: brokenEndpoint }],
    packages: [],
    previous: null,
  });
  assert.equal(requireProduct(broken, "eas").health, "broken");

  const dotnetEndpoint = endpoint({
    id: "incomplete-dotnet",
    commandName: "dotnet",
    path: "C:\\Program Files\\dotnet\\dotnet.exe",
    pathIndex: 0,
  });
  const incomplete = buildFromRecords({
    records: [{ productId: "dotnet", endpoint: dotnetEndpoint }],
    packages: [],
    previous: null,
  });
  incomplete.installations[0].issueCodes.push("incomplete-installation");
  finalizeHealth(incomplete);
  assert.equal(incomplete.installations[0].health, "incomplete");
  assert.equal(requireProduct(incomplete, "dotnet").health, "warning");
});

test("version cache requires an unchanged fingerprint and probe timeouts do not break health", async () => {
  const docker = endpoint({
    id: "docker-cache",
    commandName: "docker",
    path: "C:\\Tools\\docker.exe",
    pathIndex: 0,
    fileSize: 100,
  });
  const initial = buildFromRecords({
    records: [{ productId: "docker", endpoint: docker }],
    packages: [],
    previous: null,
  });
  const initialInstallation = initial.installations[0];
  initialInstallation.version = "29.1.3";
  initialInstallation.versionSource = "version-probe";
  initialInstallation.issueCodes = [];

  const cached = buildFromRecords({
    records: [{ productId: "docker", endpoint: docker }],
    packages: [],
    previous: initial,
  });
  assert.equal(cached.installations[0].version, "29.1.3");
  assert.equal(cached.installations[0].versionSource, "cached");

  const changedEndpoint = { ...docker, fileSize: 101, fingerprint: "changed" };
  const changed = buildFromRecords({
    records: [{ productId: "docker", endpoint: changedEndpoint }],
    packages: [],
    previous: initial,
  });
  assert.equal(changed.installations[0].version, undefined);

  let runCount = 0;
  await probeVersions({
    environment: defaultEnvironment(),
    runner: {
      async run(): Promise<CliCommandResult> {
        runCount += 1;
        return {
          executable: docker.path,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          cancelled: false,
          outputExceeded: false,
          errorCode: "TIMEOUT",
        };
      },
    },
    cancellation: new CliCancellationToken(),
    installations: changed.installations,
    endpoints: changed.endpoints,
    previous: initial,
    onProgress: () => undefined,
  });
  finalizeHealth(changed);
  assert.equal(runCount, 1);
  assert.equal(changed.installations[0].health, "healthy");
  assert.equal(changed.installations[0].version, undefined);
  assert.equal(changed.installations[0].verificationStatus, "ownership-unknown");
});

test("Google Cloud SDK reads its bounded passive VERSION metadata without executing gcloud", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-gcloud-version-"));
  try {
    const sdkRoot = path.join(root, "google-cloud-sdk");
    const binRoot = path.join(sdkRoot, "bin");
    const launcher = path.join(binRoot, "gcloud.cmd");
    await mkdir(binRoot, { recursive: true });
    await Promise.all([
      writeFile(launcher, "@echo off\r\n"),
      writeFile(path.join(sdkRoot, "VERSION"), "532.0.0\n"),
    ]);
    const gcloud = endpoint({
      id: "gcloud-version",
      commandName: "gcloud",
      path: launcher,
      pathIndex: 0,
      kind: "script",
    });
    const inventory = buildFromRecords({
      environment: environment(root, binRoot),
      records: [{ productId: "gcloud", endpoint: gcloud }],
      packages: [],
      previous: null,
    });
    let runCount = 0;
    await probeVersions({
      environment: environment(root, binRoot),
      runner: {
        async run(): Promise<CliCommandResult> {
          runCount += 1;
          throw new Error("gcloud must not execute when VERSION exists");
        },
      },
      cancellation: new CliCancellationToken(),
      installations: inventory.installations,
      endpoints: inventory.endpoints,
      previous: null,
      onProgress: () => undefined,
    });
    finalizeHealth(inventory);
    assert.equal(runCount, 0);
    assert.equal(inventory.installations[0].version, "532.0.0");
    assert.equal(
      inventory.installations[0].versionSource,
      "executable-metadata",
    );
    assert.equal(inventory.installations[0].health, "healthy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema migration merges old shim-only duplicates without erasing current records", () => {
  const eas = endpoint({
    id: "old-eas",
    commandName: "eas",
    path: "C:\\Users\\fixture\\AppData\\Roaming\\npm\\eas",
    pathIndex: 0,
    kind: "shim",
  });
  const easCmd = endpoint({
    id: "old-eas-cmd",
    commandName: "eas",
    path: "C:\\Users\\fixture\\AppData\\Roaming\\npm\\eas.cmd",
    pathIndex: 0,
    kind: "shim",
  });
  const old = snapshotWithInstallations(
    [
      historicalInstallation("old-eas-a", "eas", [eas.id], "user", "present"),
      historicalInstallation(
        "old-eas-b",
        "eas",
        [easCmd.id],
        "user",
        "present",
      ),
    ],
    [eas, easCmd],
  );
  const migrated = normalizeCliInventory({
    ...old,
    schemaVersion: 1,
  });
  assert(migrated);
  const product = requireProduct(migrated, "eas");
  assert.equal(product.currentInstallationIds.length, 1);
  assert.equal(migrated.installations.length, 1);
  assert.equal(migrated.installations[0].endpointIds.length, 2);
  assert(!product.issueCodes.includes("path-conflict"));
});

async function createNpmFixture(input: {
  root: string;
  packageId: string;
  commandName: string;
  relativeTarget: string;
  version: string;
}): Promise<{ globalRoot: string; packageRecord: CliPackageRecord }> {
  const globalRoot = path.join(input.root, "npm");
  const packageRoot = path.join(
    globalRoot,
    "node_modules",
    ...input.packageId.split("/"),
  );
  const target = path.join(packageRoot, ...input.relativeTarget.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "fixture");
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: input.packageId,
      version: input.version,
      bin: { [input.commandName]: input.relativeTarget },
    }),
  );
  await Promise.all([
    writeFile(
      path.join(globalRoot, `${input.commandName}.cmd`),
      `@"node" "%~dp0node_modules\\${input.packageId}\\${input.relativeTarget.replaceAll("/", "\\")}" %*\n`,
    ),
    writeFile(
      path.join(globalRoot, `${input.commandName}.ps1`),
      `& "node" "$basedir/node_modules/${input.packageId}/${input.relativeTarget}" $args\n`,
    ),
    writeFile(
      path.join(globalRoot, input.commandName),
      `#!/bin/sh\nexec node "$basedir/node_modules/${input.packageId}/${input.relativeTarget}" "$@"\n`,
    ),
  ]);
  const parsed = parseNodeManagerOutput(
    "npm",
    {
      stdout: JSON.stringify({
        dependencies: {
          [input.packageId]: {
            version: input.version,
            path: packageRoot,
            bin: { [input.commandName]: input.relativeTarget },
          },
        },
      }),
    },
    "win32",
    path.join(input.root, "node"),
    path.join(input.root, "node", "node.exe"),
    path.join(input.root, "node", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  assert(parsed);
  return { globalRoot, packageRecord: parsed[0] };
}

async function buildInventory(input: {
  environment: CliScanEnvironment;
  directories?: string[];
  snapshot?: ReturnType<typeof createPathSnapshot>;
  packages: CliPackageRecord[];
}): Promise<CliInventorySnapshot> {
  const snapshot =
    input.snapshot ?? {
      directories: input.directories ?? [],
      pathExt: [".exe", ".cmd", ".ps1"],
      pathDirectoryCount: input.directories?.length ?? 0,
    };
  const records = await enumerateCliPathEndpoints({
    platform: "win32",
    snapshot,
    cancellation: new CliCancellationToken(),
  });
  return buildFromRecords({
    environment: input.environment,
    records,
    packages: input.packages,
    previous: null,
  });
}

function buildFromRecords(input: {
  environment?: CliScanEnvironment;
  records: CliPathEndpointRecord[];
  packages: CliPackageRecord[];
  previous: CliInventorySnapshot | null;
}): CliInventorySnapshot {
  const scanEnvironment = input.environment ?? defaultEnvironment();
  const mutable = matchInstallations(
    scanEnvironment,
    input.records,
    input.packages,
  );
  const assembled = assembleInventory({
    environment: scanEnvironment,
    mutable,
    previous: input.previous,
    failedSourceIds: new Set(),
    now: 1_800_000_000_000,
  });
  const snapshot: CliInventorySnapshot = {
    schemaVersion: 2,
    revision: "test-revision",
    platform: "win32",
    architecture: "x64",
    generatedAt: 1_800_000_000_000,
    completeness: "complete",
    cached: false,
    sourceResults: [],
    ...assembled,
  };
  finalizeHealth(snapshot);
  return snapshot;
}

function environment(root: string, pathValue: string): CliScanEnvironment {
  return {
    ...defaultEnvironment(),
    homeDirectory: root,
    pathValue,
    neutralWorkingDirectory: root,
  };
}

function defaultEnvironment(): CliScanEnvironment {
  return {
    platform: "win32",
    architecture: "x64",
    env: {},
    homeDirectory: "C:\\Users\\fixture",
    pathValue: "",
    pathExtValue: ".EXE;.CMD;.PS1",
    knownDirectories: [],
    neutralWorkingDirectory: "C:\\Temp",
    testMode: true,
  };
}

function endpoint(input: {
  id: string;
  commandName: string;
  path: string;
  pathIndex?: number;
  pathextIndex?: number;
  kind?: CliExecutableEndpoint["kind"];
  shimTarget?: string;
  shimPackageRoot?: string;
  targetExists?: boolean;
  accessible?: boolean;
  executable?: boolean;
  fileSize?: number;
}): CliExecutableEndpoint {
  return {
    id: input.id,
    commandName: input.commandName,
    kind: input.kind ?? "native",
    path: input.path,
    canonicalPath: input.path,
    ...(input.shimTarget ? { shimTarget: input.shimTarget } : {}),
    ...(input.shimPackageRoot
      ? { shimPackageRoot: input.shimPackageRoot }
      : {}),
    ...(input.pathIndex !== undefined ? { pathIndex: input.pathIndex } : {}),
    ...(input.pathextIndex !== undefined
      ? { pathextIndex: input.pathextIndex }
      : {}),
    accessible: input.accessible ?? true,
    executable: input.executable ?? true,
    targetExists: input.targetExists ?? true,
    ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
    fingerprint: `fingerprint-${input.id}`,
  };
}

function historicalInstallation(
  id: string,
  productId: string,
  endpointIds: string[],
  origin: CliInstallation["origin"] = "user",
  presence: CliInstallation["presence"] = "present",
): CliInstallation {
  return {
    id,
    productId,
    platform: "win32",
    architecture: "x64",
    scope: origin === "system" ? "system" : "user",
    origin,
    versionSource: "unknown",
    verificationStatus: "ownership-unknown",
    endpointIds,
    commandIds: [],
    fingerprint: `fingerprint-${id}`,
    presence,
    health: presence === "missing" ? "missing" : "healthy",
    issueCodes: ["version-unverified"],
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_000_000,
    lastVerifiedAt: 1_700_000_000_000,
    uninstallCapability: {
      status: "blocked",
      source: "standalone",
      reasonCode: "standalone-binary",
      reason: "Standalone binary.",
      warnings: [],
      requiresElevation: false,
      providedCommands: [productId === "claude-code" ? "claude" : productId],
    },
  };
}

function snapshotWithInstallations(
  installations: CliInstallation[],
  endpoints: CliExecutableEndpoint[],
): CliInventorySnapshot {
  return {
    schemaVersion: 2,
    revision: "old-revision",
    platform: "win32",
    architecture: "x64",
    generatedAt: 1_700_000_000_000,
    completeness: "complete",
    cached: true,
    products: [],
    installations,
    commands: [],
    endpoints,
    sourceResults: [],
  };
}

function requireProduct(
  inventory: CliInventorySnapshot,
  productId: string,
) {
  const product = inventory.products.find((candidate) => candidate.id === productId);
  assert(product);
  return product;
}

function requireInstallation(
  inventory: CliInventorySnapshot,
  installationId: string,
): CliInstallation {
  const installation = inventory.installations.find(
    (candidate) => candidate.id === installationId,
  );
  assert(installation);
  return installation;
}
