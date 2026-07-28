import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPathSnapshot,
  enumerateCliPathEndpoints,
  groupEquivalentEndpointKey,
  isWindowsExecutionAliasPath,
} from "../src/main/clis/adapters/path";
import { CliCancellationToken } from "../src/main/clis/session";
import {
  collectNodePackageInventories,
  parseNodeManagerOutput,
} from "../src/main/clis/adapters/node-packages";
import { parsePipxOutput } from "../src/main/clis/adapters/tool-packages";
import {
  parseChocolateyOutput,
  parseWingetOutput,
} from "../src/main/clis/adapters/windows-packages";
import {
  parseHomebrewOutput,
  parseMacPortsOutput,
} from "../src/main/clis/adapters/macos-packages";
import type {
  CliCommandResult,
  CliExecutableEndpoint,
  CliScanEnvironment,
} from "../src/main/clis/types";

test("PATH snapshot normalizes duplicates and preserves PATHEXT precedence", () => {
  const snapshot = createPathSnapshot({
    platform: "win32",
    pathValue: "C:\\Tools;C:\\TOOLS;C:\\Other",
    pathExtValue: ".CMD;.EXE;.PS1;.TXT",
    extraDirectories: ["C:\\tools", "C:\\Extra"],
  });
  assert.deepEqual(snapshot.directories, [
    "C:\\Tools",
    "C:\\Other",
    "C:\\Extra",
  ]);
  assert.deepEqual(snapshot.pathExt, [".cmd", ".exe", ".ps1"]);
  assert.equal(snapshot.pathDirectoryCount, 2);
});

test("one directory pass groups npm launcher variants by package root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-path-"));
  try {
    const packageBin = path.join(
      root,
      "node_modules",
      "@openai",
      "codex",
      "bin",
    );
    await mkdir(packageBin, { recursive: true });
    await writeFile(path.join(packageBin, "codex.js"), "process.exit(0)\n");
    const target = path.join(packageBin, "codex.js");
    await Promise.all([
      writeFile(path.join(root, "codex.cmd"), `node "${target}"\n`),
      writeFile(path.join(root, "codex.ps1"), `node "${target}"\n`),
      writeFile(path.join(root, "codex"), `node "${target}"\n`),
    ]);
    const records = await enumerateCliPathEndpoints({
      platform: "win32",
      snapshot: {
        directories: [root],
        pathExt: [".cmd", ".exe", ".ps1"],
      },
      cancellation: new CliCancellationToken(),
    });
    assert.equal(records.length, 3);
    assert.equal(
      new Set(
        records.map((record) =>
          groupEquivalentEndpointKey(record, "win32"),
        ),
      ).size,
      1,
    );
    assert.equal(records[0].endpoint.pathIndex, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows launcher grouping treats product commands in one directory as one installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-command-group-"));
  try {
    await Promise.all([
      writeFile(path.join(root, "pip.exe"), "fixture"),
      writeFile(path.join(root, "pip3.exe"), "fixture"),
    ]);
    const records = await enumerateCliPathEndpoints({
      platform: "win32",
      snapshot: {
        directories: [root],
        pathExt: [".exe", ".cmd", ".ps1"],
      },
      cancellation: new CliCancellationToken(),
    });
    assert.equal(records.length, 2);
    assert.equal(
      new Set(
        records.map((record) => groupEquivalentEndpointKey(record, "win32")),
      ).size,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complex launch scripts are not misclassified as direct broken shims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-complex-shim-"));
  try {
    const script = [
      "@echo off",
      ...Array.from(
        { length: 80 },
        (_, index) =>
          `if exist "${path.join(root, `python-${index}.exe`)}" echo fallback`,
      ),
    ].join("\r\n");
    await Promise.all([
      writeFile(path.join(root, "gcloud.cmd"), script),
      writeFile(path.join(root, "gcloud"), script),
    ]);
    const records = await enumerateCliPathEndpoints({
      platform: "win32",
      snapshot: {
        directories: [root],
        pathExt: [".exe", ".cmd", ".ps1"],
      },
      cancellation: new CliCancellationToken(),
    });
    assert.equal(records.length, 2);
    assert(records.every((record) => record.endpoint.targetExists));
    assert(records.every((record) => !record.endpoint.shimTarget));
    assert.equal(
      new Set(
        records.map((record) => groupEquivalentEndpointKey(record, "win32")),
      ).size,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only per-user WindowsApps entries are execution aliases", () => {
  assert(
    isWindowsExecutionAliasPath(
      "C:\\Users\\fixture\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
    ),
  );
  assert(
    !isWindowsExecutionAliasPath(
      "C:\\Program Files\\WindowsApps\\ngrok.ngrok_3.39.8.0_x64__fixture\\ngrok.exe",
    ),
  );
});

test("node package inventory runs once for equivalent manager launchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-manager-group-"));
  try {
    const npmRoot = path.join(root, "node_modules", "npm");
    const npmCli = path.join(npmRoot, "bin", "npm-cli.js");
    const node = path.join(root, "node.exe");
    await mkdir(path.dirname(npmCli), { recursive: true });
    await writeFile(npmCli, "fixture");
    await writeFile(node, "fixture");
    await writeFile(
      path.join(npmRoot, "package.json"),
      JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }),
    );
    const managerEndpoints: Array<{
      productId: "npm";
      endpoint: CliExecutableEndpoint;
    }> = [
      {
        productId: "npm",
        endpoint: managerEndpoint("npm-cmd", path.join(root, "npm.cmd"), {
          shimTarget: npmCli,
          shimPackageRoot: npmRoot,
        }),
      },
      {
        productId: "npm",
        endpoint: managerEndpoint("npm-shell", path.join(root, "npm"), {
          shimTarget: node,
        }),
      },
    ];
    let calls = 0;
    const result = await collectNodePackageInventories({
      environment: {
        ...fakeEnvironment(),
        homeDirectory: root,
        neutralWorkingDirectory: root,
      },
      runner: {
        async run(): Promise<CliCommandResult> {
          calls += 1;
          return {
            executable: node,
            exitCode: 0,
            stdout: JSON.stringify({
              dependencies: {
                "@openai/codex": {
                  version: "0.145.0",
                  path: path.join(root, "global", "node_modules", "@openai", "codex"),
                  bin: { codex: "bin/codex.js" },
                },
              },
            }),
            stderr: "",
            timedOut: false,
            cancelled: false,
            outputExceeded: false,
          };
        },
      },
      managerEndpoints,
      nodeEndpoints: [
        managerEndpoint("node", node, { kind: "native" }),
      ],
      signal: new AbortController().signal,
      now: () => 1,
    });
    assert.equal(calls, 1);
    assert.equal(
      result.sourceResults.filter(
        (source) => source.label === "npm global packages",
      ).length,
      1,
    );
    assert.equal(result.packageRecords[0].packageIdentity.packageId, "@openai/codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("macOS enumeration requires executable access and resolves symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clis-mac-path-"));
  try {
    const target = path.join(root, "git-target");
    const link = path.join(root, "git");
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    await chmod(target, 0o755);
    try {
      await symlink(target, link, "file");
    } catch {
      t.skip("File symlink creation is unavailable on this Windows host.");
      return;
    }
    const records = await enumerateCliPathEndpoints({
      platform: "darwin",
      snapshot: { directories: [root], pathExt: [] },
      cancellation: new CliCancellationToken(),
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].endpoint.kind, "symlink");
    assert.equal(records[0].endpoint.canonicalPath, target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured node, pipx, Windows, and macOS parsers isolate malformed output", () => {
  const environment = fakeEnvironment();
  const npm = parseNodeManagerOutput(
    "npm",
    {
      stdout: JSON.stringify({
        dependencies: { "@openai/codex": { version: "1.2.3" } },
      }),
    },
    "win32",
    "C:\\npm",
    "C:\\node.exe",
  );
  assert.equal(npm?.[0].packageIdentity.packageId, "@openai/codex");
  assert.equal(
    parseNodeManagerOutput(
      "pnpm",
      { stdout: "localized text" },
      "win32",
      "C:\\pnpm",
      "C:\\pnpm.exe",
    ),
    null,
  );
  const yarn = parseNodeManagerOutput(
    "yarn",
    {
      stdout:
        '{"type":"tree","data":{"trees":[{"name":"@google/gemini-cli@0.9.0"}]}}\n',
    },
    "win32",
    "C:\\yarn",
    "C:\\yarn.cmd",
  );
  assert.equal(yarn?.[0].productId, "gemini-cli");

  const pipx = parsePipxOutput(
    JSON.stringify({
      venvs: {
        "poetry": {
          metadata: {
            main_package: {
              package: "poetry",
              package_version: "2.1.0",
              apps: ["poetry"],
            },
          },
        },
      },
    }),
    environment,
    "C:\\pipx.exe",
  );
  assert.equal(pipx?.[0].productId, "poetry");
  assert.equal(parsePipxOutput("not-json", environment, "C:\\pipx.exe"), null);

  const choco = parseChocolateyOutput("git|2.50.0\n", environment);
  assert.equal(choco?.[0].productId, "git");
  assert.equal(
    parseChocolateyOutput("Chocolatey v3 localized output", environment),
    null,
  );
  const winget = parseWingetOutput(
    "Name  Id  Version  Source\n--------------------------\nOpenAI Codex  OpenAI.Codex  0.8.0  winget\n",
    environment,
  );
  assert.equal(winget?.[0].productId, "codex");
  assert.equal(parseWingetOutput("No installed package found", environment), null);

  const brew = parseHomebrewOutput(
    JSON.stringify({
      formulae: [
        {
          name: "bun",
          full_name: "bun",
          linked_keg: "1.2.20",
          installed: [{ version: "1.2.20" }],
        },
      ],
      casks: [],
    }),
    "/opt/homebrew/bin/brew",
  );
  assert.equal(brew?.[0].packageIdentity.source, "homebrew-formula");
  assert.equal(parseHomebrewOutput("warning before json", "/usr/local/bin/brew"), null);

  const ports = parseMacPortsOutput(
    "git @2.50.0_0 (active)\n",
    "/opt/local/bin/port",
  );
  assert.equal(ports?.[0].productId, "git");
  assert.equal(
    parseMacPortsOutput("The following ports are installed:", "/opt/local/bin/port"),
    null,
  );
});

function fakeEnvironment(): CliScanEnvironment {
  return {
    platform: "win32",
    architecture: "x64",
    env: {
      APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
      PROGRAMDATA: "C:\\ProgramData",
    },
    homeDirectory: "C:\\Users\\fixture",
    pathValue: "",
    pathExtValue: ".EXE;.CMD",
    knownDirectories: [],
    neutralWorkingDirectory: "C:\\Temp",
    testMode: true,
  };
}

function managerEndpoint(
  id: string,
  endpointPath: string,
  overrides: Partial<CliExecutableEndpoint>,
): CliExecutableEndpoint {
  return {
    id,
    commandName: id === "node" ? "node" : "npm",
    kind: "shim",
    path: endpointPath,
    canonicalPath: endpointPath,
    pathIndex: 0,
    accessible: true,
    executable: true,
    targetExists: true,
    fingerprint: `fingerprint-${id}`,
    ...overrides,
  };
}
