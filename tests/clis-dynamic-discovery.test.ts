import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createPathSnapshot,
  enumerateCliPathEndpoints,
  collectPackageEndpoints,
  isConsoleLauncher,
} from "../src/main/clis/adapters/path";
import {
  collectNodePackageInventories,
  parseNodeManagerOutput,
} from "../src/main/clis/adapters/node-packages";
import {
  collectShimPackageMetadata,
  attributeDiscoveredFiles,
  discoverAdditionalDirectories,
  discoverVersionedBinDirectories,
} from "../src/main/clis/adapters/discovered-files";
import {
  collectPythonEntryPoints,
  collectUvToolReceipts,
  parseUvEntrypoints,
} from "../src/main/clis/adapters/python-metadata";
import { matchInstallations } from "../src/main/clis/installation-matcher";
import {
  assembleInventory,
  finalizeHealth,
} from "../src/main/clis/inventory-builder";
import { normalizeCliInventory } from "../src/main/clis/inventory-normalizer";
import { MemoryCliPersistence, migrateCliStore } from "../src/main/clis/store";
import { CliCancellationToken } from "../src/main/clis/session";
import { validateCliCommandSpec } from "../src/main/clis/command-runner";
import { normalizeCliPath } from "../src/main/clis/fingerprint";
import { probeVersions } from "../src/main/clis/version-probes";
import {
  CLI_NEW_BADGE_MS,
  getPrimaryCliCommand,
  isNewCliProduct,
} from "../src/renderer/cli-view-model";
import type {
  CliCommandRunner,
  CliInventorySnapshot,
  CliPackageRecord,
  CliPathEndpointRecord,
  CliScanEnvironment,
} from "../src/main/clis/types";

function environment(root: string): CliScanEnvironment {
  return {
    platform: "win32",
    architecture: "x64",
    homeDirectory: root,
    env: {},
    pathValue: root,
    pathExtValue: ".EXE;.CMD;.PS1",
    knownDirectories: [],
    neutralWorkingDirectory: root,
    testMode: true,
  };
}
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-discovery-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function consolePe(subsystem = 3): Buffer {
  const buffer = Buffer.alloc(512);
  buffer.write("MZ");
  buffer.writeUInt32LE(128, 60);
  buffer.writeUInt32LE(0x4550, 128);
  buffer.writeUInt16LE(0x20b, 152);
  buffer.writeUInt16LE(subsystem, 220);
  return buffer;
}
async function enumerate(root: string): Promise<CliPathEndpointRecord[]> {
  return enumerateCliPathEndpoints({
    platform: "win32",
    snapshot: createPathSnapshot({
      platform: "win32",
      pathValue: root,
      pathExtValue: ".EXE;.CMD",
      extraDirectories: [],
    }),
    cancellation: new CliCancellationToken(),
  });
}
function build(
  env: CliScanEnvironment,
  records: CliPathEndpointRecord[],
  packages: CliPackageRecord[],
  now: number,
  previous: CliInventorySnapshot | null = null,
): CliInventorySnapshot {
  const assembled = assembleInventory({
    environment: env,
    mutable: matchInstallations(env, records, packages),
    now,
    previous,
    failedSourceIds: new Set(),
  });
  finalizeHealth(assembled);
  return {
    schemaVersion: 2,
    revision: `revision-${now}`,
    platform: env.platform,
    architecture: env.architecture,
    generatedAt: now,
    completeness: "complete",
    cached: false,
    sourceResults: [],
    ...assembled,
  };
}

test("dynamic discovery accepts unfamiliar console executables and scripts, excludes GUI and malformed PE files", () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, "unlisted-tool.exe"), consolePe());
    await writeFile(path.join(root, "desktop-app.exe"), consolePe(2));
    await writeFile(path.join(root, "invalid.exe"), "MZ");
    await writeFile(
      path.join(root, "unlisted-script.cmd"),
      "@echo off\r\necho hello\r\n",
    );
    const result = await enumerate(root);
    assert.deepEqual(
      result.map((record) => record.endpoint.commandName).sort(),
      ["unlisted-script", "unlisted-tool"],
    );
    const malformed = consolePe();
    malformed.writeUInt32LE(0x7fffffff, 60);
    await writeFile(path.join(root, "offset.exe"), malformed);
    assert.equal(
      await isConsoleLauncher(path.join(root, "offset.exe"), "win32"),
      false,
    );
    const inventory = build(environment(root), result, [], 1000);
    assert.equal(inventory.products.length, 2);
    assert.equal(normalizeCliInventory(inventory)?.products.length, 2);
    let probes = 0;
    await probeVersions({
      environment: environment(root),
      ...inventory,
      previous: null,
      cancellation: new CliCancellationToken(),
      onProgress: () => undefined,
      runner: {
        run: async () => {
          probes++;
          throw new Error("An unfamiliar tool must not run.");
        },
      },
    });
    assert.equal(probes, 0);
  }));

test("unlisted npm packages join their declared commands and reject bin traversal", () =>
  withRoot(async (root) => {
    const packageRoot = path.join(root, "node_modules", "unlisted-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "run.js"), "console.log('fixture')");
    const manifest = {
      name: "unlisted-package",
      version: "1.2.3",
      path: packageRoot,
      bin: { "unlisted-tool": "run.js", escape: "../outside.js" },
    };
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      path.join(root, "unlisted-tool.cmd"),
      '@echo off\r\nnode "%~dp0node_modules\\unlisted-package\\run.js" %*\r\n',
    );
    const records = await enumerate(root);
    const packages = parseNodeManagerOutput(
      "npm",
      {
        stdout: JSON.stringify({
          dependencies: { "unlisted-package": manifest },
        }),
      },
      "win32",
      root,
      path.join(root, "node.exe"),
    )!;
    assert.equal(packages.length, 1);
    assert.deepEqual(packages[0].commandNames, ["unlisted-tool"]);
    const inventory = build(environment(root), records, packages, 1000);
    assert.equal(inventory.products.length, 1);
    assert.equal(inventory.products[0].displayName, "unlisted-package");
    assert.equal(inventory.installations[0].endpointIds.length, 1);
    const passive = await collectShimPackageMetadata(
      records,
      environment(root),
      [],
      new AbortController().signal,
    );
    assert.equal(passive[0].packageIdentity.packageId, "unlisted-package");
    assert.equal(
      build(environment(root), records, passive, 1000).installations[0]
        .uninstallCapability.status,
      "blocked",
    );
  }));

test("npm native bins without an extension resolve the real Windows executable", () =>
  withRoot(async (root) => {
    const packageRoot = path.join(root, "node_modules", "native-tool");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "native-tool.exe"), consolePe());
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "native-tool",
        version: "1.0.0",
        bin: { "native-tool": "native-tool" },
      }),
    );
    await writeFile(
      path.join(root, "native-tool.cmd"),
      '@echo off\r\n"%~dp0node_modules\\native-tool\\native-tool" %*',
    );
    const records = await enumerate(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].endpoint.targetExists, true);
    assert.equal(
      records[0].endpoint.shimTarget,
      path.join(packageRoot, "native-tool.exe"),
    );
    const packages = await collectShimPackageMetadata(
      records,
      environment(root),
      [],
      new AbortController().signal,
    );
    const inventory = build(environment(root), records, packages, 1000);
    assert.equal(inventory.installations[0].health, "healthy");
    assert.equal(inventory.products[0].currentInstallationIds.length, 1);
  }));

test("a Windows POSIX companion cannot create an extra standalone npm or npx installation", () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, "npm.cmd"), "@echo off\r\necho fixture");
    await writeFile(path.join(root, "npm"), "#!/bin/sh\necho fixture");
    await writeFile(path.join(root, "npx"), "#!/bin/sh\necho fixture");
    const inventory = build(environment(root), await enumerate(root), [], 1000);
    assert.equal(inventory.products.length, 1);
    assert.equal(inventory.products[0].id, "npm");
    assert.equal(inventory.installations[0].health, "healthy");
    const command = inventory.commands.find((item) => item.name === "npm")!;
    assert.equal(
      inventory.endpoints.find((item) => item.id === command.activeEndpointId)
        ?.path,
      path.join(root, "npm.cmd"),
    );
  }));

test("package executables outside PATH are discovered without inventing an active launcher", () =>
  withRoot(async (root) => {
    const target = path.join(root, "unlisted-tool.exe");
    await writeFile(target, consolePe());
    const packages = parseNodeManagerOutput(
      "npm",
      {
        stdout: JSON.stringify({
          dependencies: {
            "unlisted-package": {
              version: "1.0.0",
              path: root,
              bin: { "unlisted-tool": "unlisted-tool.exe" },
            },
          },
        }),
      },
      "win32",
      root,
      path.join(root, "node.exe"),
    )!;
    const endpoints = await collectPackageEndpoints({
      platform: "win32",
      packageRecords: packages,
      pathRecords: [],
      cancellation: new CliCancellationToken(),
    });
    const inventory = build(environment(root), endpoints, packages, 1000);
    assert.equal(inventory.installations[0].health, "healthy");
    assert.equal(inventory.commands[0].pathRole, "not-on-path");
    assert.equal(inventory.endpoints[0].pathIndex, undefined);
    assert.equal(
      (
        await collectPackageEndpoints({
          platform: "win32",
          packageRecords: packages,
          pathRecords: endpoints,
          cancellation: new CliCancellationToken(),
        })
      ).length,
      0,
    );
  }));

test("New badge survives rescans, ownership joins and persistence, then expires at 24 hours", () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, "unlisted-tool.exe"), consolePe());
    const records = await enumerate(root);
    const env = environment(root);
    const first = build(env, records, [], 1000);
    assert(isNewCliProduct(first, first.products[0], 1000));
    const packages = parseNodeManagerOutput(
      "npm",
      {
        stdout: JSON.stringify({
          dependencies: {
            "unlisted-package": {
              version: "1.0.0",
              path: root,
              bin: { "unlisted-tool": "unlisted-tool.exe" },
            },
          },
        }),
      },
      "win32",
      root,
      path.join(root, "node.exe"),
    )!;
    const joined = build(env, records, packages, 4000, first);
    assert.equal(joined.installations[0].firstSeenAt, 1000);
    const persistence = new MemoryCliPersistence();
    persistence.write({ ...persistence.read(), inventory: joined });
    const restored = persistence.read().inventory!;
    assert(
      isNewCliProduct(
        restored,
        restored.products[0],
        1000 + CLI_NEW_BADGE_MS - 1,
      ),
    );
    assert(
      !isNewCliProduct(restored, restored.products[0], 1000 + CLI_NEW_BADGE_MS),
    );
    packages[0].version = "2.0.0";
    assert.equal(
      build(env, records, packages, 1000 + CLI_NEW_BADGE_MS, restored)
        .installations[0].firstSeenAt,
      1000,
    );
    await writeFile(path.join(root, "brand-new-tool.exe"), consolePe());
    const next = build(
      env,
      await enumerate(root),
      packages,
      1000 + CLI_NEW_BADGE_MS,
      restored,
    );
    assert(
      isNewCliProduct(
        next,
        next.products.find((item) => item.displayName === "brand-new-tool")!,
        next.generatedAt,
      ),
    );
  }));

test("saved scan folders cover nested portable tools, skip dependency folders and honor cancellation", () =>
  withRoot(async (root) => {
    await mkdir(path.join(root, "portable", "bin"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
    const external = path.join(root, "linked");
    await symlink(path.join(root, "portable"), external, "junction");
    const result = await discoverAdditionalDirectories(
      [root],
      new CliCancellationToken(),
    );
    assert(result.directories.includes(path.join(root, "portable", "bin")));
    assert(
      !result.directories.some(
        (directory) =>
          directory.includes("node_modules") || directory === external,
      ),
    );
    const token = new CliCancellationToken();
    token.cancel();
    await assert.rejects(
      discoverAdditionalDirectories([root], token),
      /cancelled/,
    );
    const migrated = migrateCliStore({
      scanDirectories: [root, root, "relative", 4],
    });
    assert.deepEqual(migrated.scanDirectories, [root]);
    assert.equal(migrated.inventory, null);
  }));

test("versioned tool roots are found without adding them to the effective PATH", () =>
  withRoot(async (root) => {
    await mkdir(path.join(root, "nvm", "v24.0.0"), { recursive: true });
    await mkdir(path.join(root, "nvm", "unrelated"), { recursive: true });
    const env = {
      ...environment(root),
      env: { NVM_HOME: path.join(root, "nvm") },
    };
    const directories = await discoverVersionedBinDirectories(env);
    assert(directories.includes(path.join(root, "nvm", "v24.0.0")));
    assert(!directories.includes(path.join(root, "nvm", "unrelated")));
    const snapshot = createPathSnapshot({
      platform: "win32",
      pathValue: root,
      pathExtValue: ".EXE",
      extraDirectories: directories,
    });
    assert.equal(snapshot.pathDirectoryCount, 1);
  }));

test("Corepack proxies are never run as global package inventory commands", () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, "yarn.cmd"), "@echo off\r\necho fixture");
    const record = (await enumerate(root))[0];
    record.endpoint.shimTarget = path.join(
      root,
      "node_modules",
      "corepack",
      "dist",
      "yarn.js",
    );
    let calls = 0;
    await collectNodePackageInventories({
      environment: environment(root),
      managerEndpoints: [{ productId: "yarn", endpoint: record.endpoint }],
      runner: {
        run: async () => {
          calls++;
          throw new Error("Corepack must not run.");
        },
      },
      signal: new AbortController().signal,
      now: () => 1000,
    });
    assert.equal(calls, 0);
  }));

test("Python console entry points prove ownership without importing packages or treating GUI entry points as CLIs", () =>
  withRoot(async (root) => {
    const scripts = path.join(root, "Scripts");
    const metadata = path.join(
      root,
      "Lib",
      "site-packages",
      "unlisted-1.0.dist-info",
    );
    await mkdir(scripts, { recursive: true });
    await mkdir(metadata, { recursive: true });
    await writeFile(path.join(scripts, "unlisted-tool.exe"), consolePe());
    await writeFile(
      path.join(metadata, "entry_points.txt"),
      "[console_scripts]\nunlisted-tool = package.main:run\n[gui_scripts]\ndesktop = package.gui:run\n",
    );
    await writeFile(
      path.join(metadata, "METADATA"),
      "Name: unlisted-python-package\r\nVersion: 1.2.3\r\n",
    );
    const records = await enumerate(scripts);
    const result = await collectPythonEntryPoints({
      records,
      environment: environment(root),
      signal: new AbortController().signal,
      now: () => 1000,
    });
    assert.equal(result.packageRecords.length, 1);
    const inventory = build(
      environment(root),
      records,
      result.packageRecords,
      1000,
    );
    assert.equal(inventory.installations.length, 1);
    assert.equal(inventory.installations[0].version, "1.2.3");
    assert.equal(inventory.installations[0].packageIdentity?.source, "pip");
    assert.equal(
      inventory.installations[0].uninstallCapability.status,
      "blocked",
    );
  }));

test("Windows ownership does not promote unknown application helpers or assign interpreter metadata to wrappers", () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, "unlisted-tool.exe"), consolePe());
    await writeFile(path.join(root, "unlisted-helper.exe"), consolePe());
    await writeFile(
      path.join(root, "unlisted-script.cmd"),
      "@echo off\r\necho fixture",
    );
    const records = await enumerate(root);
    records.find(
      (record) => record.endpoint.commandName === "unlisted-script",
    )!.endpoint.shimTarget = path.join(root, "node.exe");
    const runner: CliCommandRunner = {
      run: async (spec) => {
        validateCliCommandSpec(spec);
        const decoded = Buffer.from(spec.args.at(-1)!, "base64").toString(
          "utf16le",
        );
        assert(!decoded.includes("node.exe"));
        return {
          executable: spec.executable,
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          outputExceeded: false,
          stderr: "",
          stdout: JSON.stringify(
            records
              .filter(({ endpoint }) => endpoint.path.endsWith(".exe"))
              .map(({ endpoint }) => ({
                path: endpoint.path,
                publisher: "Fixture Publisher",
                version: "3.0.0",
              })),
          ),
        };
      },
    };
    const env = { ...environment(root), env: { SystemRoot: "C:\\Windows" } };
    const result = await attributeDiscoveredFiles({
      records,
      environment: env,
      applicationRoots: [
        { path: root, name: "Fixture Suite", version: "2.0.0" },
      ],
      runner,
      signal: new AbortController().signal,
      now: () => 1000,
    });
    const inventory = build(env, records, result.packageRecords, 1000);
    assert.equal(inventory.products.length, 3);
    assert(
      inventory.products.every(
        (product) => product.currentInstallationIds.length === 0,
      ),
    );
    assert(
      inventory.installations.every(
        (item) => item.discoveryKind === "candidate",
      ),
    );
    assert(
      records.every(({ endpoint }) => endpoint.ownerName === "Fixture Suite"),
    );
    assert.equal(
      records.find(
        ({ endpoint }) => endpoint.commandName === "unlisted-script",
      )!.endpoint.fileVersion,
      undefined,
    );
    assert.equal(
      inventory.installations[0].uninstallCapability.status,
      "blocked",
    );
  }));

test("registry roots with trailing separators join public commands while keeping helpers separate", () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, "git.exe"), consolePe());
    await writeFile(path.join(root, "git-helper.exe"), consolePe());
    const records = await enumerate(root);
    const result = await attributeDiscoveredFiles({
      records,
      environment: environment(root),
      applicationRoots: [
        { path: `${root}${path.sep}`, name: "Git", version: "2.50.0" },
      ],
      runner: {
        run: async () => {
          throw new Error(
            "No metadata subprocess expected without SystemRoot.",
          );
        },
      },
      signal: new AbortController().signal,
      now: () => 1000,
    });
    // The normal package matcher must also accept an uncanonicalized registry root.
    const packages: CliPackageRecord[] = [
      {
        productId: "git",
        sourceId: "windows-registry",
        commandNames: ["git", "git-helper"],
        binEntries: [],
        packageIdentity: {
          source: "registry",
          packageId: "Git",
          scope: "machine",
          installRoot: `${root}${path.sep}`,
          ownershipConfidence: "corroborated",
        },
      },
      ...result.packageRecords,
    ];
    const inventory = build(environment(root), records, packages, 1000);
    assert.equal(inventory.products.length, 2);
    assert.equal(
      inventory.products.filter(
        (item) => item.currentInstallationIds.length > 0,
      ).length,
      1,
    );
    assert.equal(
      inventory.installations.find((item) => item.productId === "git")
        ?.endpointIds.length,
      1,
    );
    assert.equal(
      inventory.installations.find(
        (item) => item.productId === "discovered-command:git-helper",
      )?.discoveryKind,
      "candidate",
    );
    assert.equal(normalizeCliPath("C:\\", "win32"), "c:\\");
    assert.equal(normalizeCliPath("/", "darwin"), "/");
  }));

test("metadata batches stay inside the command boundary even with many long paths", () =>
  withRoot(async (root) => {
    await writeFile(path.join(root, "unlisted-tool.exe"), consolePe());
    const template = (await enumerate(root))[0];
    const records = Array.from({ length: 100 }, (_, index) => {
      const file = path.join(
        root,
        `${"long-directory-".repeat(30)}${index}`,
        "unlisted-tool.exe",
      );
      return {
        ...template,
        endpoint: {
          ...template.endpoint,
          id: `endpoint-${index}`,
          path: file,
          canonicalPath: file,
        },
      };
    });
    let calls = 0;
    const result = await attributeDiscoveredFiles({
      records,
      environment: { ...environment(root), env: { SystemRoot: "C:\\Windows" } },
      applicationRoots: [],
      signal: new AbortController().signal,
      now: () => 1000,
      runner: {
        run: async (spec) => {
          validateCliCommandSpec(spec);
          calls++;
          return {
            executable: spec.executable,
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            outputExceeded: false,
            stdout: "[]",
            stderr: "",
          };
        },
      },
    });
    assert(calls > 1);
    assert.equal(result.sourceResults[0].status, "success");
  }));

test("uv receipts group every tool alias and reject paths outside the declared command format", () =>
  withRoot(async (root) => {
    const toolRoot = path.join(root, "tools", "fixture-monitor");
    const bin = path.join(root, "bin");
    await mkdir(toolRoot, { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(bin, "fixture-monitor.exe"), consolePe());
    await writeFile(path.join(bin, "fmon.exe"), consolePe());
    const receipt = `[tool]\nrequirements = [{ name = "fixture-monitor" }]\nentrypoints = [\n{ name = "fixture-monitor.exe", install-path = ${JSON.stringify(path.join(bin, "fixture-monitor.exe"))} },\n{ name = "fmon.exe", install-path = ${JSON.stringify(path.join(bin, "fmon.exe"))} }\n]\n`;
    await writeFile(path.join(toolRoot, "uv-receipt.toml"), receipt);
    const records = await enumerate(bin);
    const result = await collectUvToolReceipts({
      records,
      environment: {
        ...environment(root),
        env: { UV_TOOL_DIR: path.join(root, "tools") },
      },
      signal: new AbortController().signal,
      now: () => 1000,
    });
    const inventory = build(
      environment(root),
      records,
      result.packageRecords,
      1000,
    );
    assert.equal(inventory.products.length, 1);
    assert.equal(inventory.installations[0].endpointIds.length, 2);
    assert.equal(inventory.installations[0].packageIdentity?.source, "uv");
    assert.equal(
      getPrimaryCliCommand(inventory.products[0], inventory.commands)?.name,
      "fixture-monitor",
    );
    assert.equal(
      parseUvEntrypoints(
        'entrypoints = [{ name = "bad/name", install-path = "relative" }]',
      ).length,
      0,
    );
  }));
