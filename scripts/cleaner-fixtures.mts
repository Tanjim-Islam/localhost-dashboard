import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLEANER_TEST_MANIFEST,
  CLEANER_TEST_SENTINEL,
  type CleanerFixtureManifest,
} from "../src/main/cleaner/adapters/filesystem.ts";
import type {
  CleanerApplicationEvidence,
  CleanerEvidenceSourceType,
} from "../src/main/cleaner/types.ts";
import { normalizeWindowsPath } from "../src/main/cleaner/path-normalization.ts";

const FIXTURE_PREFIX = "local-dashboard-cleaner-fixture-";

function fixtureEvidence(
  source: CleanerEvidenceSourceType,
  applicationId: string,
  summary: string,
  overrides: Partial<CleanerApplicationEvidence> = {},
): CleanerApplicationEvidence {
  return {
    source,
    applicationId,
    current: true,
    verified: false,
    strength: "medium",
    summary,
    ...overrides,
  };
}

function fixtureExecutableEvidence(
  applicationId: string,
  executablePath: string,
): CleanerApplicationEvidence {
  return fixtureEvidence(
    "executable",
    applicationId,
    `Verified fixture executable ${path.win32.basename(executablePath)}.`,
    {
      executablePath,
      verified: true,
      strength: "strong",
    },
  );
}

export async function createCleanerFixtureRoot(
  requestedRoot?: string,
): Promise<string> {
  const root = requestedRoot
    ? path.resolve(requestedRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX));
  if (requestedRoot) await fs.mkdir(root, { recursive: true });

  const createdPaths: string[] = [];
  const sizeOverrides: Record<string, number> = {};
  const accountingOverrides: NonNullable<
    CleanerFixtureManifest["accountingOverrides"]
  > = {};
  const standardAccountingOverrides: NonNullable<
    CleanerFixtureManifest["standardAccountingOverrides"]
  > = {};
  const virtualTrees: NonNullable<CleanerFixtureManifest["virtualTrees"]> = {};
  const makeCandidate = async (
    relativePath: string,
    logicalSizeBytes: number,
    fileName = "fixture.bin",
  ) => {
    const target = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(
      path.join(target, fileName),
      `fixture:${relativePath}\n`,
    );
    createdPaths.push(target);
    sizeOverrides[normalizeWindowsPath(target)] = logicalSizeBytes;
    return target;
  };
  const makeFileCandidate = async (
    relativePath: string,
    logicalSizeBytes: number,
  ) => {
    const target = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${relativePath}\n`);
    createdPaths.push(target);
    sizeOverrides[normalizeWindowsPath(target)] = logicalSizeBytes;
    return target;
  };

  await fs.writeFile(path.join(root, CLEANER_TEST_SENTINEL), "fixture-only\n");
  await makeCandidate("User/AppData/Local/npm-cache/_cacache", 1_600_000_000);
  await makeCandidate("User/AppData/Local/npm-cache/_npx", 420_000_000);
  await makeCandidate("User/AppData/Local/Yarn/Cache", 310_000_000);
  await makeCandidate("User/AppData/Local/pnpm-cache", 180_000_000);
  await makeCandidate("User/AppData/Local/pnpm/store", 2_200_000_000);
  await makeCandidate("User/.bun/install/cache", 260_000_000);
  await makeCandidate("User/AppData/Local/node/corepack", 140_000_000);
  await makeCandidate("User/AppData/Local/node-gyp/Cache", 95_000_000);
  await makeCandidate("User/AppData/Local/electron/Cache", 230_000_000);
  await makeCandidate("User/AppData/Local/cursor-compile-cache", 460_000_000);
  await makeCandidate("User/AppData/Local/ms-playwright", 2_250_000_000);
  await makeCandidate("User/.cache/puppeteer", 1_100_000_000);

  const uvCache = await makeCandidate(
    "User/AppData/Local/uv/cache",
    9_690_000_000,
  );
  accountingOverrides[normalizeWindowsPath(uvCache)] = {
    logicalBytes: 9_690_000_000,
    allocatedBytes: null,
    uniqueAllocatedBytes: 2_594_893_824,
    estimatedReclaimableBytes: 2_221_572_096,
    reclaimableLowerBoundBytes: 2_221_572_096,
    reclaimableUpperBoundBytes: 2_221_572_096,
    accountingConfidence: "estimated",
    hardlinkRecordCount: 26_099,
    externalHardlinkRecordCount: 11_809,
    measuredFileCount: 479_669,
    measuredDirectoryCount: 71_185,
    inspectedEntryCount: 550_854,
    measurementCompleteness: "complete",
    logicalTraversalComplete: true,
    physicalAccountingComplete: true,
  };
  standardAccountingOverrides[normalizeWindowsPath(uvCache)] = {
    logicalBytes: 320_751_952,
    allocatedBytes: null,
    uniqueAllocatedBytes: null,
    estimatedReclaimableBytes: null,
    reclaimableLowerBoundBytes: 0,
    reclaimableUpperBoundBytes: null,
    accountingConfidence: "lower-bound",
    hardlinkRecordCount: 0,
    externalHardlinkRecordCount: 0,
    measuredFileCount: 49_999,
    measuredDirectoryCount: 1,
    inspectedEntryCount: 50_000,
    measurementCompleteness: "partial",
    measurementLimitReason: "entry-limit",
    logicalTraversalComplete: false,
    physicalAccountingComplete: false,
  };
  virtualTrees[normalizeWindowsPath(uvCache)] = {
    fileCount: 60_000,
    logicalBytesPerFile: 16_384,
    allocatedBytesPerFile: 4_096,
    volumeIdentity: "fixture-uv-volume",
  };
  await makeCandidate("User/AppData/Local/pip/Cache", 740_000_000);
  await makeCandidate("User/AppData/Local/pypoetry/Cache", 210_000_000);
  await makeCandidate("User/AppData/Local/pipenv/Cache", 80_000_000);
  await makeCandidate("User/miniconda3/pkgs", 3_300_000_000);
  await makeCandidate("User/miniconda3/conda-meta", 2_000_000);
  await makeFileCandidate(
    "User/miniconda3/pkgs/example-1.0-0.conda",
    55_000_000,
  );
  await makeCandidate("User/anaconda3/pkgs", 2_900_000_000);
  await makeCandidate("User/anaconda3/conda-meta", 2_000_000);
  await makeFileCandidate(
    "User/anaconda3/pkgs/example-2.0-0.tar.bz2",
    60_000_000,
  );
  await makeCandidate("User/miniconda3/envs", 4_400_000_000);
  await makeCandidate("User/AppData/Roaming/jupyter/runtime", 12_000_000);
  await makeCandidate("User/.cache/huggingface", 5_500_000_000);
  await makeCandidate("User/.cache/torch", 1_300_000_000);

  await makeCandidate("User/AppData/Local/go-build", 920_000_000);
  await makeCandidate("User/go/pkg/mod", 1_800_000_000);
  await makeCandidate("User/.cargo/registry", 1_100_000_000);
  await makeCandidate("User/.rustup/toolchains", 2_800_000_000);
  const gradleCache = await makeCandidate("User/.gradle/caches", 2_600_000_000);
  standardAccountingOverrides[normalizeWindowsPath(gradleCache)] = {
    logicalBytes: 2_600_000_000,
    allocatedBytes: null,
    uniqueAllocatedBytes: null,
    estimatedReclaimableBytes: null,
    reclaimableLowerBoundBytes: 0,
    reclaimableUpperBoundBytes: null,
    accountingConfidence: "lower-bound",
    hardlinkRecordCount: 0,
    externalHardlinkRecordCount: 0,
    measuredFileCount: 1,
    measuredDirectoryCount: 1,
    inspectedEntryCount: 2,
    measurementCompleteness: "partial",
    measurementLimitReason: "metadata-limit",
    logicalTraversalComplete: true,
    physicalAccountingComplete: false,
  };
  await makeCandidate("User/.gradle/wrapper/dists", 1_000_000_000);
  await makeCandidate("User/.m2/repository", 2_100_000_000);
  await makeCandidate("User/.nuget/packages", 980_000_000);
  await makeCandidate("User/AppData/Local/Android/Sdk", 7_500_000_000);

  await makeCandidate("User/AppData/Roaming/Cursor/Cache", 450_000_000);
  await makeCandidate("User/AppData/Roaming/Cursor/Code Cache", 210_000_000);
  await makeCandidate("User/AppData/Roaming/Cursor/Local Storage", 45_000_000);
  await makeCandidate("User/AppData/Roaming/Cursor/User/History", 60_000_000);
  await makeCandidate("User/.cursor/extensions", 1_400_000_000);
  await makeCandidate("User/AppData/Roaming/Windsurf/Cache", 360_000_000);
  await makeCandidate(
    "User/AppData/Roaming/Windsurf/User/workspaceStorage",
    300_000_000,
  );
  await makeCandidate("User/.windsurf/extensions", 900_000_000);
  await makeCandidate("User/.antigravity/extensions", 640_000_000);
  await makeCandidate("User/AppData/Roaming/Code/Cache", 1_700_000_000);
  await makeCandidate("User/.vscode/extensions", 1_200_000_000);
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1",
    1_500_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1/caches",
    620_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1/index",
    440_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1/LocalHistory",
    180_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1/plugins",
    120_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1/projects",
    90_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1/settings",
    25_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/JetBrains/IntelliJIdea2025.1/vcs",
    30_000_000,
  );
  await fs.mkdir(
    path.join(
      root,
      "User",
      "AppData",
      "Local",
      "JetBrains",
      "IntelliJIdea2025.1",
      "projects",
      "sample",
      ".git",
    ),
    { recursive: true },
  );
  await makeCandidate(
    "User/AppData/Local/Google/AndroidStudio2025.1",
    1_400_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Google/AndroidStudio2025.1/caches",
    500_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Google/AndroidStudio2025.1/index",
    350_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Google/AndroidStudio2025.1/LocalHistory",
    100_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Google/AndroidStudio2025.1/plugins",
    180_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Google/AndroidStudio2025.1/projects",
    70_000_000,
  );

  await makeCandidate("User/AppData/Local/SquirrelTemp", 680_000_000);
  await makeCandidate(
    "User/AppData/Local/electron-updater/pending",
    510_000_000,
  );
  await makeCandidate("User/AppData/Local/D3DSCache", 330_000_000);
  await makeCandidate("User/AppData/LocalLow/NVIDIA/DXCache", 780_000_000);
  await makeCandidate(
    "User/AppData/Local/stealth-coder-updater/pending",
    510_000_000,
  );
  await makeFileCandidate(
    "User/AppData/Local/stealth-coder-updater/Stealth-Coder-4.0.0.exe",
    120_000_000,
  );
  await makeFileCandidate(
    "User/AppData/Local/stealth-coder-updater/Stealth-Coder-4.0.0.exe.blockmap",
    200_000,
  );
  await makeCandidate(
    "User/AppData/Local/@zcodedesktop-updater/downloads",
    390_000_000,
  );
  await makeCandidate("User/AppData/Local/CrashDumps", 250_000_000);
  await makeCandidate("User/AppData/Local/Temp", 200_000_000);
  await makeCandidate("Windows/Temp", 300_000_000);
  await makeCandidate("Windows/SoftwareDistribution/Download", 1_400_000_000);
  await makeCandidate("Windows/Logs", 620_000_000);
  await makeCandidate("Windows/WinSxS", 8_000_000_000);
  await makeCandidate("Windows/Installer", 4_000_000_000);
  await makeFileCandidate(
    "User/AppData/Local/Microsoft/Windows/Explorer/thumbcache_256.db",
    170_000_000,
  );

  await makeCandidate(
    "User/AppData/Local/BraveSoftware/Brave-Browser/User Data",
    4_800_000_000,
    "Login Data",
  );
  await makeCandidate(
    "User/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Cache",
    600_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Code Cache",
    220_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/BraveSoftware/Brave-Browser/User Data/Default/Service Worker/CacheStorage",
    250_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Google/Chrome/User Data",
    3_900_000_000,
    "Cookies",
  );
  await makeCandidate(
    "User/AppData/Local/Google/Chrome/User Data/Default/Cache",
    500_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Google/Chrome/User Data/Default/GPUCache",
    160_000_000,
  );
  await makeCandidate(
    "User/AppData/Local/Microsoft/Edge/User Data",
    2_600_000_000,
    "Cookies",
  );
  await makeCandidate(
    "User/AppData/Local/Microsoft/Edge/User Data/Default/Cache",
    450_000_000,
  );
  await makeCandidate(
    "User/AppData/Roaming/Mozilla/Firefox/Profiles",
    2_900_000_000,
    "places.sqlite",
  );
  await makeCandidate(
    "User/AppData/Local/Mozilla/Firefox/Profiles/fixture.default-release/cache2",
    420_000_000,
  );
  await makeCandidate("User/.codex", 1_600_000_000, "sessions.db");
  await makeCandidate("User/AppData/Roaming/ChatGPT", 800_000_000, "state.db");
  await makeCandidate(
    "User/AppData/Roaming/Slack",
    1_900_000_000,
    "storage.db",
  );
  await makeCandidate(
    "User/AppData/Local/Packages/91750D7E.Slack_8she8kybcnzg4/LocalCache",
    900_000_000,
    "state.db",
  );
  await makeCandidate(
    "User/AppData/Local/Packages/OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0/LocalCache",
    700_000_000,
    "state.db",
  );
  await makeCandidate(
    "User/AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache",
    650_000_000,
    "state.db",
  );

  await makeFileCandidate(
    "User/AppData/Local/Docker/wsl/data/ext4.vhdx",
    12_000_000_000,
  );
  await makeFileCandidate(
    "User/AppData/Local/Docker/wsl/disk/docker_data.vhdx",
    14_000_000_000,
  );
  await makeFileCandidate(
    "User/AppData/Local/Docker/wsl/main/ext4.vhdx",
    11_000_000_000,
  );
  await makeFileCandidate(
    "User/AppData/Local/Packages/CanonicalGroupLimited.Ubuntu/LocalState/ext4.vhdx",
    9_000_000_000,
  );
  await makeCandidate("ProgramData/PostgreSQL", 6_000_000_000, "database.bin");
  await makeCandidate("ProgramData/MongoDB", 3_000_000_000, "collection.bin");
  await makeCandidate("User/.ollama/models", 10_000_000_000, "model.gguf");
  await makeCandidate(
    "User/.cache/lm-studio/models",
    8_000_000_000,
    "model.gguf",
  );
  await makeCandidate("User/.lmstudio/models", 7_000_000_000, "model.gguf");
  await makeCandidate("User/.paddlex", 3_000_000_000, "model.pdparams");
  await makeCandidate("User/.codex/runtimes", 900_000_000, "runtime.exe");
  await makeCandidate("User/.cache/mystery-tool", 770_000_000);
  await makeCandidate(
    "Windows/ServiceProfiles/NetworkService/AppData/Local/Microsoft/Windows/DeliveryOptimization/Cache",
    1_200_000_000,
  );

  const codeExecutable = await makeFileCandidate(
    "User/AppData/Local/Programs/Microsoft VS Code/Code.exe",
    1,
  );
  const cursorExecutable = await makeFileCandidate(
    "User/AppData/Local/Programs/cursor/Cursor.exe",
    1,
  );
  const antigravityExecutable = await makeFileCandidate(
    "User/AppData/Local/Programs/Antigravity/Antigravity.exe",
    1,
  );
  const antigravityToolsExecutable = await makeFileCandidate(
    "User/AppData/Local/Antigravity Tools/antigravity_tools.exe",
    1,
  );
  const chromeExecutable = await makeFileCandidate(
    "User/AppData/Local/Google/Chrome/Application/chrome.exe",
    1,
  );
  const braveExecutable = await makeFileCandidate(
    "User/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe",
    1,
  );
  const edgeExecutable = await makeFileCandidate(
    "User/AppData/Local/Microsoft/Edge/Application/msedge.exe",
    1,
  );
  const firefoxExecutable = await makeFileCandidate(
    "Programs/Mozilla Firefox/firefox.exe",
    1,
  );
  const anacondaExecutable = await makeFileCandidate(
    "User/anaconda3/Scripts/conda.exe",
    1,
  );
  const minicondaExecutable = await makeFileCandidate(
    "User/miniconda3/Scripts/conda.exe",
    1,
  );

  const project = path.join(root, "Projects", "sample-app");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(project, "package.json"),
    '{"name":"fixture"}\n',
  );
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.writeFile(
    path.join(project, "src", "index.ts"),
    "export const fixture = true;\n",
  );
  for (const [name, size] of [
    ["node_modules", 2_700_000_000],
    [".next", 820_000_000],
    [".turbo", 410_000_000],
    ["dist", 560_000_000],
    ["build", 630_000_000],
    ["out", 290_000_000],
    ["coverage", 120_000_000],
    [".pytest_cache", 30_000_000],
    [".mypy_cache", 80_000_000],
    [".ruff_cache", 25_000_000],
    [".tox", 740_000_000],
    [".nox", 510_000_000],
    [".venv", 1_200_000_000],
  ] as const) {
    await makeCandidate(`Projects/sample-app/${name}`, size);
  }

  const linkTarget = await makeCandidate("FixtureLinkTarget", 5_000_000);
  const linkPath = path.join(
    root,
    "User",
    ".cache",
    "mystery-tool",
    "junction",
  );
  try {
    await fs.symlink(linkTarget, linkPath, "junction");
  } catch {
    // Junction creation may require a Windows policy or elevated developer mode.
  }
  for (const [relativePath, kind] of [
    ["User/.bun/install/cache/internal-junction", "junction"],
    ["User/AppData/Local/pnpm-cache/internal-symbolic-link", "file"],
  ] as const) {
    const internalLink = path.join(root, ...relativePath.split("/"));
    try {
      await fs.symlink(linkTarget, internalLink, kind);
    } catch {
      // The mocked reparse tests cover policies when Windows link creation is unavailable.
    }
  }

  const manifest: CleanerFixtureManifest = {
    version: 2,
    createdAt: Date.now(),
    createdPaths,
    sizeOverrides,
    accountingOverrides,
    standardAccountingOverrides,
    virtualTrees,
    evidence: {
      collectedAt: Date.now(),
      mode: "deep",
      processes: [
        {
          name: "node.exe",
          pid: 4100,
          executablePath: path.join(root, "Tools", "node.exe"),
          parentPid: 1,
          createdAt: Date.now() - 30_000,
          commandCategory: "unknown",
          referencedPaths: [],
        },
        {
          name: "python.exe",
          pid: 4101,
          executablePath: path.join(root, "Tools", "python.exe"),
          parentPid: 1,
          createdAt: Date.now() - 20_000,
          commandCategory: "unknown",
          referencedPaths: [],
        },
        {
          name: "uv.exe",
          pid: 4102,
          executablePath: path.join(root, "Tools", "uv.exe"),
          parentPid: 1,
          createdAt: Date.now() - 10_000,
          commandCategory: "uv-operation",
          referencedPaths: [
            normalizeWindowsPath(
              path.join(root, "User", "AppData", "Local", "uv", "cache"),
            ),
          ],
        },
        {
          name: "Cursor.exe",
          pid: 4103,
          executablePath: cursorExecutable,
          parentPid: 1,
          createdAt: Date.now() - 5_000,
          commandCategory: "editor",
          applicationId: "editor.cursor",
          referencedPaths: [],
        },
      ],
      sources: [
        {
          source: "uninstall-registry",
          mandatory: true,
          completed: true,
          evidence: [
            fixtureEvidence(
              "uninstall-registry",
              "editor.vscode",
              "Current Visual Studio Code registry record.",
              { observedName: "Microsoft Visual Studio Code (User)" },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "editor.cursor",
              "Current Cursor registry record.",
              { observedName: "Cursor (User)" },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "editor.antigravity",
              "Current Gemini Antigravity registry record.",
              {
                observedName: "Gemini Antigravity",
                publisher: "Google LLC",
              },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "tool.antigravity-tools",
              "Current Antigravity Tools 4.2.2 registry record.",
              {
                observedName: "Antigravity Tools",
                publisher: "lbjlaq",
                version: "4.2.2",
              },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "browser.chrome",
              "Current Google Chrome registry record.",
              { observedName: "Google Chrome" },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "browser.brave",
              "Current Brave registry record.",
              { observedName: "Brave" },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "browser.edge",
              "Current Microsoft Edge registry record.",
              { observedName: "Microsoft Edge" },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "browser.firefox",
              "Current Mozilla Firefox registry record.",
              { observedName: "Mozilla Firefox" },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "runtime.anaconda",
              "Current Anaconda registry record.",
              { observedName: "Anaconda3" },
            ),
            fixtureEvidence(
              "uninstall-registry",
              "runtime.miniconda",
              "Current Miniconda registry record.",
              { observedName: "Miniconda3" },
            ),
          ],
        },
        {
          source: "app-path",
          mandatory: true,
          completed: true,
          evidence: [],
        },
        {
          source: "exact-registry-key",
          mandatory: true,
          completed: true,
          evidence: [],
        },
        {
          source: "executable",
          mandatory: true,
          completed: true,
          evidence: [
            fixtureExecutableEvidence("editor.vscode", codeExecutable),
            fixtureExecutableEvidence("editor.cursor", cursorExecutable),
            fixtureExecutableEvidence(
              "editor.antigravity",
              antigravityExecutable,
            ),
            fixtureExecutableEvidence(
              "tool.antigravity-tools",
              antigravityToolsExecutable,
            ),
            fixtureExecutableEvidence("browser.chrome", chromeExecutable),
            fixtureExecutableEvidence("browser.brave", braveExecutable),
            fixtureExecutableEvidence("browser.edge", edgeExecutable),
            fixtureExecutableEvidence("browser.firefox", firefoxExecutable),
            fixtureExecutableEvidence("runtime.anaconda", anacondaExecutable),
            fixtureExecutableEvidence("runtime.miniconda", minicondaExecutable),
          ],
        },
        {
          source: "appx",
          mandatory: true,
          completed: true,
          evidence: [
            fixtureEvidence(
              "appx",
              "app.slack",
              "Current Slack Appx package.",
              {
                packageFamilyName: "91750D7E.Slack_8she8kybcnzg4",
                installLocation: path.join(root, "Packages", "Slack"),
                verified: true,
                strength: "strong",
              },
            ),
            fixtureEvidence(
              "appx",
              "app.chatgpt",
              "Current ChatGPT Appx package.",
              {
                packageFamilyName: "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0",
                installLocation: path.join(root, "Packages", "ChatGPT"),
                verified: true,
                strength: "strong",
              },
            ),
            fixtureEvidence(
              "appx",
              "app.codex",
              "Current Codex Appx package.",
              {
                packageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
                installLocation: path.join(root, "Packages", "Codex"),
                verified: true,
                strength: "strong",
              },
            ),
          ],
        },
        {
          source: "process",
          mandatory: true,
          completed: true,
          evidence: [
            fixtureEvidence(
              "process",
              "editor.cursor",
              "Running verified Cursor executable.",
              {
                executablePath: cursorExecutable,
                verified: true,
                strength: "strong",
              },
            ),
          ],
        },
        {
          source: "observation",
          mandatory: false,
          completed: true,
          evidence: [],
        },
        ...["shortcut", "portable-root"].map((source) => ({
          source: source as "shortcut" | "portable-root",
          mandatory: true,
          completed: true,
          evidence: [],
        })),
        ...["service", "scheduled-task", "protocol", "package-manager"].map(
          (source) => ({
            source: source as
              | "shortcut"
              | "portable-root"
              | "service"
              | "scheduled-task"
              | "protocol"
              | "package-manager",
            mandatory: false,
            completed: true,
            evidence: [],
          }),
        ),
      ],
    },
    freeDiskSpaceBytes: 14_000_000_000,
  };
  await fs.writeFile(
    path.join(root, CLEANER_TEST_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
}

export async function regenerateCleanerFixture(root: string): Promise<void> {
  await assertFixtureRoot(root);
  const target = path.join(
    root,
    "User",
    "AppData",
    "Local",
    "npm-cache",
    "_cacache",
  );
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(
    path.join(target, "regenerated.bin"),
    "regenerated fixture\n",
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, CLEANER_TEST_MANIFEST), "utf8"),
  ) as CleanerFixtureManifest;
  if (!manifest.createdPaths.includes(target))
    manifest.createdPaths.push(target);
  manifest.sizeOverrides[normalizeWindowsPath(target)] = 640_000_000;
  manifest.evidence.processes = manifest.evidence.processes.filter(
    (processInfo) => processInfo.name.toLowerCase() !== "node.exe",
  );
  await fs.writeFile(
    path.join(root, CLEANER_TEST_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function removeCleanerFixtureRoot(root: string): Promise<void> {
  await assertFixtureRoot(root);
  const resolved = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  if (
    !resolved.startsWith(`${tempRoot}${path.sep}`) ||
    !path.basename(resolved).startsWith(FIXTURE_PREFIX)
  ) {
    throw new Error(
      "Refusing to remove a Cleaner fixture outside the dedicated temporary prefix.",
    );
  }
  await fs.rm(resolved, { recursive: true, force: false });
}

async function assertFixtureRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  await fs.access(path.join(resolved, CLEANER_TEST_SENTINEL));
  await fs.access(path.join(resolved, CLEANER_TEST_MANIFEST));
}

async function main() {
  const command = process.argv[2] ?? "create";
  const target = process.argv[3];
  if (command === "create") {
    process.stdout.write(`${await createCleanerFixtureRoot(target)}\n`);
    return;
  }
  if (!target)
    throw new Error(`Cleaner fixture ${command} requires an exact root path.`);
  if (command === "regenerate") {
    await regenerateCleanerFixture(target);
    process.stdout.write(`Regenerated fixture cache in ${target}\n`);
    return;
  }
  if (command === "remove") {
    await removeCleanerFixtureRoot(target);
    process.stdout.write(`Removed Cleaner fixture root ${target}\n`);
    return;
  }
  throw new Error(`Unknown Cleaner fixture command ${command}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
