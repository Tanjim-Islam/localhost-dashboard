import path from "node:path";
import type {
  CleanerApplicationDataRoot,
  CleanerApplicationDefinition,
  CleanerEnvironment,
  CleanerOwnedDataKind,
} from "../types";
import { isWindowsPathInside, sameWindowsPath } from "../path-normalization";

export const CLEANER_APPLICATION_DEFINITION_VERSION = 2;

type DefinitionInput = Omit<
  CleanerApplicationDefinition,
  | "definitionVersion"
  | "registrySignatures"
  | "executableSignatures"
  | "appxSignatures"
  | "shortcutSignatures"
  | "packageManagerSignatures"
  | "processSignatures"
  | "serviceSignatures"
  | "scheduledTaskSignatures"
  | "protocolSignatures"
  | "dataRoots"
> &
  Partial<
    Pick<
      CleanerApplicationDefinition,
      | "registrySignatures"
      | "executableSignatures"
      | "appxSignatures"
      | "shortcutSignatures"
      | "packageManagerSignatures"
      | "processSignatures"
      | "serviceSignatures"
      | "scheduledTaskSignatures"
      | "protocolSignatures"
      | "dataRoots"
    >
  >;

function definition(input: DefinitionInput): CleanerApplicationDefinition {
  return {
    definitionVersion: CLEANER_APPLICATION_DEFINITION_VERSION,
    registrySignatures: [],
    executableSignatures: [],
    appxSignatures: [],
    shortcutSignatures: [],
    packageManagerSignatures: [],
    processSignatures: [],
    serviceSignatures: [],
    scheduledTaskSignatures: [],
    protocolSignatures: [],
    dataRoots: [],
    ...input,
  };
}

function executable(
  basenames: string[],
  knownPaths: (environment: CleanerEnvironment) => string[],
  productNames: string[],
  publishers?: string[],
) {
  return { basenames, knownPaths, productNames, publishers };
}

function root(
  id: string,
  displayName: string,
  dataKind: CleanerOwnedDataKind,
  resolvePaths: (environment: CleanerEnvironment) => string[],
  options?: {
    ownership?: "exclusive" | "shared";
    allowProtectedParentBypass?: boolean;
    cacheOnly?: boolean;
  },
): CleanerApplicationDataRoot {
  return {
    id,
    displayName,
    dataKind,
    resolvePaths,
    ownership: options?.ownership ?? "exclusive",
    allowProtectedParentBypass: options?.allowProtectedParentBypass,
    cacheOnly: options?.cacheOnly ?? false,
  };
}

function editorRoots(
  applicationId: string,
  roamingName: string,
  extensionName: string,
): CleanerApplicationDataRoot[] {
  const leaf = (
    name: string,
    dataKind: CleanerOwnedDataKind = "ordinary-cache",
  ) =>
    root(
      `${applicationId}.${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
      dataKind,
      (environment) => [
        path.join(environment.roamingAppData, roamingName, name),
      ],
      { allowProtectedParentBypass: true, cacheOnly: true },
    );
  return [
    leaf("Cache"),
    leaf("CachedData"),
    leaf("Code Cache", "compiled-cache"),
    leaf("GPUCache", "compiled-cache"),
    leaf("DawnGraphiteCache", "compiled-cache"),
    leaf("DawnWebGPUCache", "compiled-cache"),
    leaf("CachedConfigurations"),
    leaf("CachedProfilesData"),
    leaf("CachedExtensionVSIXs", "download-cache"),
    root(
      `${applicationId}.extensions`,
      "Extension store",
      "extension-store",
      (environment) => [
        path.join(environment.home, extensionName, "extensions"),
      ],
    ),
    root(`${applicationId}.history`, "History", "history", (environment) => [
      path.join(environment.roamingAppData, roamingName, "User", "History"),
    ]),
    root(`${applicationId}.backups`, "Backups", "backup", (environment) => [
      path.join(environment.roamingAppData, roamingName, "Backups"),
    ]),
    root(
      `${applicationId}.workspace-state`,
      "Workspace state",
      "workspace-state",
      (environment) => [
        path.join(
          environment.roamingAppData,
          roamingName,
          "User",
          "workspaceStorage",
        ),
      ],
    ),
  ];
}

export const CLEANER_APPLICATION_DEFINITIONS: CleanerApplicationDefinition[] = [
  definition({
    id: "editor.vscode",
    familyId: "editor.vscode",
    channel: "stable",
    displayName: "Visual Studio Code",
    protectedByDefault: true,
    registrySignatures: [
      {
        displayNames: [
          "Microsoft Visual Studio Code (User)",
          "Microsoft Visual Studio Code",
        ],
        publishers: ["Microsoft Corporation"],
      },
    ],
    executableSignatures: [
      executable(
        ["Code.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Programs",
            "Microsoft VS Code",
            "Code.exe",
          ),
        ],
        ["Visual Studio Code"],
        ["Microsoft Corporation"],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Code.exe"] }],
    processSignatures: [{ executableBasenames: ["Code.exe"] }],
    dataRoots: editorRoots("editor.vscode", "Code", ".vscode"),
  }),
  definition({
    id: "editor.vscode-insiders",
    familyId: "editor.vscode",
    channel: "insiders",
    displayName: "Visual Studio Code Insiders",
    protectedByDefault: true,
    registrySignatures: [
      {
        displayNames: [
          "Microsoft Visual Studio Code Insiders (User)",
          "Microsoft Visual Studio Code Insiders",
        ],
        publishers: ["Microsoft Corporation"],
      },
    ],
    executableSignatures: [
      executable(
        ["Code - Insiders.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Programs",
            "Microsoft VS Code Insiders",
            "Code - Insiders.exe",
          ),
        ],
        ["Visual Studio Code - Insiders"],
        ["Microsoft Corporation"],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Code - Insiders.exe"] }],
    processSignatures: [{ executableBasenames: ["Code - Insiders.exe"] }],
    dataRoots: editorRoots(
      "editor.vscode-insiders",
      "Code - Insiders",
      ".vscode-insiders",
    ),
  }),
  definition({
    id: "editor.cursor",
    familyId: "editor.cursor",
    channel: "stable",
    displayName: "Cursor",
    registrySignatures: [
      {
        displayNames: ["Cursor (User)", "Cursor"],
        publishers: ["Anysphere, Inc.", "Anysphere Inc."],
      },
    ],
    executableSignatures: [
      executable(
        ["Cursor.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Programs",
            "cursor",
            "Cursor.exe",
          ),
        ],
        ["Cursor"],
        ["Anysphere, Inc.", "Anysphere Inc."],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Cursor.exe"] }],
    processSignatures: [{ executableBasenames: ["Cursor.exe"] }],
    dataRoots: editorRoots("editor.cursor", "Cursor", ".cursor"),
  }),
  definition({
    id: "editor.windsurf",
    familyId: "editor.windsurf",
    channel: "stable",
    displayName: "Windsurf",
    registrySignatures: [
      {
        displayNames: ["Windsurf (User)", "Windsurf"],
        publishers: ["Codeium", "Exafunction, Inc."],
      },
    ],
    executableSignatures: [
      executable(
        ["Windsurf.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Programs",
            "Windsurf",
            "Windsurf.exe",
          ),
        ],
        ["Windsurf"],
        ["Codeium", "Exafunction, Inc."],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Windsurf.exe"] }],
    processSignatures: [{ executableBasenames: ["Windsurf.exe"] }],
    dataRoots: editorRoots("editor.windsurf", "Windsurf", ".windsurf"),
  }),
  definition({
    id: "editor.windsurf-next",
    familyId: "editor.windsurf",
    channel: "next",
    displayName: "Windsurf Next",
    registrySignatures: [
      {
        displayNames: ["Windsurf Next (User)", "Windsurf Next"],
        publishers: ["Codeium", "Exafunction, Inc."],
      },
    ],
    executableSignatures: [
      executable(
        ["Windsurf - Next.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Programs",
            "Windsurf - Next",
            "Windsurf - Next.exe",
          ),
        ],
        ["Windsurf Next"],
        ["Codeium", "Exafunction, Inc."],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Windsurf - Next.exe"] }],
    processSignatures: [{ executableBasenames: ["Windsurf - Next.exe"] }],
    dataRoots: editorRoots(
      "editor.windsurf-next",
      "Windsurf - Next",
      ".windsurf-next",
    ),
  }),
  definition({
    id: "editor.trae",
    familyId: "editor.trae",
    channel: "stable",
    displayName: "Trae",
    registrySignatures: [{ displayNames: ["Trae", "Trae (User)"] }],
    executableSignatures: [
      executable(
        ["Trae.exe"],
        (environment) => [
          path.join(environment.localAppData, "Programs", "Trae", "Trae.exe"),
        ],
        ["Trae"],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Trae.exe"] }],
    processSignatures: [{ executableBasenames: ["Trae.exe"] }],
    dataRoots: editorRoots("editor.trae", "Trae", ".trae"),
  }),
  definition({
    id: "editor.qoder",
    familyId: "editor.qoder",
    channel: "stable",
    displayName: "Qoder",
    registrySignatures: [{ displayNames: ["Qoder", "Qoder (User)"] }],
    executableSignatures: [
      executable(
        ["Qoder.exe"],
        (environment) => [
          path.join(environment.localAppData, "Programs", "Qoder", "Qoder.exe"),
        ],
        ["Qoder"],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Qoder.exe"] }],
    processSignatures: [{ executableBasenames: ["Qoder.exe"] }],
    dataRoots: editorRoots("editor.qoder", "Qoder", ".qoder"),
  }),
  definition({
    id: "editor.antigravity",
    familyId: "editor.antigravity",
    channel: "stable",
    displayName: "Gemini Antigravity",
    registrySignatures: [
      {
        displayNames: ["Gemini Antigravity", "Antigravity IDE"],
        publishers: ["Google LLC"],
      },
    ],
    executableSignatures: [
      executable(
        ["Antigravity.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Programs",
            "Antigravity",
            "Antigravity.exe",
          ),
        ],
        ["Gemini Antigravity", "Antigravity IDE"],
        ["Google LLC"],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["Antigravity.exe"] }],
    processSignatures: [{ executableBasenames: ["Antigravity.exe"] }],
    dataRoots: [
      ...editorRoots("editor.antigravity", "Antigravity", ".antigravity"),
      root(
        "editor.antigravity.gemini-ide",
        "Gemini Antigravity IDE state",
        "workspace-state",
        (environment) => [
          path.join(environment.home, ".gemini", "antigravity-ide"),
        ],
      ),
      root(
        "editor.antigravity.gemini-backup",
        "Gemini Antigravity backup",
        "backup",
        (environment) => [
          path.join(environment.home, ".gemini", "antigravity-backup"),
        ],
      ),
    ],
  }),
  definition({
    id: "tool.antigravity-tools",
    familyId: "tool.antigravity-tools",
    channel: "stable",
    displayName: "Antigravity Tools",
    registrySignatures: [
      {
        displayNames: ["Antigravity Tools"],
        publishers: ["lbjlaq"],
      },
    ],
    executableSignatures: [
      executable(
        ["antigravity_tools.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Antigravity Tools",
            "antigravity_tools.exe",
          ),
        ],
        ["Antigravity Tools"],
        ["lbjlaq"],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["antigravity_tools.exe"] }],
    processSignatures: [{ executableBasenames: ["antigravity_tools.exe"] }],
    dataRoots: [
      root(
        "tool.antigravity-tools.local",
        "Antigravity Tools local data",
        "settings",
        (environment) => [
          path.join(environment.localAppData, "Antigravity Tools"),
          path.join(environment.localAppData, "com.lbjlaq.antigravity-tools"),
        ],
      ),
      root(
        "tool.antigravity-tools.roaming",
        "Antigravity Tools roaming data",
        "settings",
        (environment) => [
          path.join(environment.roamingAppData, "com.lbjlaq.antigravity-tools"),
        ],
      ),
    ],
    protectedByDefault: true,
  }),
  definition({
    id: "editor.jetbrains",
    familyId: "editor.jetbrains",
    channel: "stable",
    displayName: "JetBrains IDEs",
    registrySignatures: [
      {
        displayNames: [
          "JetBrains Toolbox",
          "IntelliJ IDEA",
          "PyCharm",
          "WebStorm",
          "Rider",
        ],
        publishers: ["JetBrains s.r.o."],
      },
    ],
    executableSignatures: [
      executable(
        ["idea64.exe", "pycharm64.exe", "webstorm64.exe", "rider64.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "JetBrains",
            "Toolbox",
            "bin",
            "jetbrains-toolbox.exe",
          ),
        ],
        ["JetBrains Toolbox", "IntelliJ IDEA", "PyCharm", "WebStorm", "Rider"],
        ["JetBrains s.r.o."],
      ),
    ],
    processSignatures: [
      {
        executableBasenames: [
          "idea64.exe",
          "pycharm64.exe",
          "webstorm64.exe",
          "rider64.exe",
        ],
      },
    ],
  }),
  definition({
    id: "editor.android-studio",
    familyId: "editor.android-studio",
    channel: "stable",
    displayName: "Android Studio",
    registrySignatures: [
      {
        displayNames: ["Android Studio"],
        publishers: ["Google LLC"],
      },
    ],
    executableSignatures: [
      executable(
        ["studio64.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Programs",
            "Android Studio",
            "bin",
            "studio64.exe",
          ),
        ],
        ["Android Studio"],
        ["Google LLC"],
      ),
    ],
    shortcutSignatures: [{ targetBasenames: ["studio64.exe"] }],
    processSignatures: [{ executableBasenames: ["studio64.exe"] }],
  }),
  definition({
    id: "browser.chrome",
    familyId: "browser.chromium.google",
    channel: "stable",
    displayName: "Google Chrome",
    registrySignatures: [
      {
        displayNames: ["Google Chrome"],
        publishers: ["Google LLC"],
      },
    ],
    executableSignatures: [
      executable(
        ["chrome.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          ),
        ],
        ["Google Chrome"],
        ["Google LLC"],
      ),
    ],
    appxSignatures: [],
    processSignatures: [{ executableBasenames: ["chrome.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "browser.brave",
    familyId: "browser.chromium.brave",
    channel: "stable",
    displayName: "Brave",
    registrySignatures: [
      {
        displayNames: ["Brave"],
        publishers: ["Brave Software, Inc."],
      },
    ],
    executableSignatures: [
      executable(
        ["brave.exe"],
        (environment) => [
          path.join(
            environment.localAppData,
            "BraveSoftware",
            "Brave-Browser",
            "Application",
            "brave.exe",
          ),
        ],
        ["Brave"],
        ["Brave Software, Inc."],
      ),
    ],
    processSignatures: [{ executableBasenames: ["brave.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "browser.edge",
    familyId: "browser.chromium.microsoft",
    channel: "stable",
    displayName: "Microsoft Edge",
    registrySignatures: [
      {
        displayNames: ["Microsoft Edge"],
        publishers: ["Microsoft Corporation"],
      },
    ],
    executableSignatures: [
      executable(
        ["msedge.exe"],
        () => [],
        ["Microsoft Edge"],
        ["Microsoft Corporation"],
      ),
    ],
    processSignatures: [{ executableBasenames: ["msedge.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "browser.firefox",
    familyId: "browser.mozilla.firefox",
    channel: "stable",
    displayName: "Mozilla Firefox",
    registrySignatures: [
      {
        displayNames: ["Mozilla Firefox"],
        publishers: ["Mozilla"],
      },
    ],
    executableSignatures: [
      executable(["firefox.exe"], () => [], ["Firefox"], ["Mozilla"]),
    ],
    processSignatures: [{ executableBasenames: ["firefox.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "app.slack",
    familyId: "app.slack",
    channel: "stable",
    displayName: "Slack",
    registrySignatures: [
      { displayNames: ["Slack"], publishers: ["Slack Technologies LLC"] },
    ],
    executableSignatures: [
      executable(
        ["slack.exe"],
        (environment) => [
          path.join(environment.localAppData, "slack", "slack.exe"),
        ],
        ["Slack"],
        ["Slack Technologies LLC"],
      ),
    ],
    appxSignatures: [
      {
        packageFamilyNames: [
          "91750D7E.Slack_8she8kybcnzg4",
          "SlackTechnologies.Slack_8she8kybcnzg4",
        ],
      },
    ],
    processSignatures: [{ executableBasenames: ["slack.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "app.chatgpt",
    familyId: "app.openai.chatgpt",
    channel: "stable",
    displayName: "ChatGPT",
    registrySignatures: [{ displayNames: ["ChatGPT"], publishers: ["OpenAI"] }],
    executableSignatures: [
      executable(["ChatGPT.exe"], () => [], ["ChatGPT"], ["OpenAI"]),
    ],
    appxSignatures: [
      {
        packageFamilyNames: ["OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0"],
      },
    ],
    processSignatures: [{ executableBasenames: ["ChatGPT.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "app.codex",
    familyId: "app.openai.codex",
    channel: "stable",
    displayName: "Codex",
    registrySignatures: [{ displayNames: ["Codex"], publishers: ["OpenAI"] }],
    executableSignatures: [
      executable(["Codex.exe"], () => [], ["Codex"], ["OpenAI"]),
    ],
    appxSignatures: [{ packageFamilyNames: ["OpenAI.Codex_2p2nqsd0c76g0"] }],
    processSignatures: [{ executableBasenames: ["Codex.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "updater.stealth-coder",
    familyId: "app.stealth-coder",
    channel: "stable",
    displayName: "Stealth Coder",
    registrySignatures: [{ displayNames: ["Stealth Coder"] }],
    executableSignatures: [
      executable(["Stealth Coder.exe"], () => [], ["Stealth Coder"]),
    ],
    scheduledTaskSignatures: [{ taskNames: ["Stealth Coder Update"] }],
    dataRoots: [
      root(
        "updater.stealth-coder.payload",
        "Stealth Coder updater payload",
        "updater-payload",
        (environment) => [
          path.join(environment.localAppData, "stealth-coder-updater"),
        ],
        { cacheOnly: false },
      ),
    ],
  }),
  definition({
    id: "updater.zcode-desktop",
    familyId: "app.zcode-desktop",
    channel: "stable",
    displayName: "ZCode Desktop",
    registrySignatures: [{ displayNames: ["ZCode Desktop", "@zcodedesktop"] }],
    executableSignatures: [
      executable(["ZCode Desktop.exe"], () => [], ["ZCode Desktop"]),
    ],
    scheduledTaskSignatures: [{ taskNames: ["ZCode Desktop Update"] }],
    dataRoots: [
      root(
        "updater.zcode-desktop.payload",
        "ZCode Desktop updater payload",
        "updater-payload",
        (environment) => [
          path.join(environment.localAppData, "@zcodedesktop-updater"),
        ],
        { cacheOnly: false },
      ),
    ],
  }),
  definition({
    id: "runtime.anaconda",
    familyId: "runtime.conda",
    channel: "stable",
    displayName: "Anaconda",
    registrySignatures: [
      {
        displayNames: ["Anaconda3", "Anaconda"],
        publishers: ["Anaconda, Inc.", "Anaconda"],
      },
    ],
    executableSignatures: [
      executable(
        ["conda.exe", "python.exe"],
        (environment) => [
          path.join(environment.home, "anaconda3", "Scripts", "conda.exe"),
        ],
        ["Anaconda"],
        ["Anaconda, Inc.", "Anaconda"],
      ),
    ],
    processSignatures: [{ executableBasenames: ["conda.exe"] }],
    protectedByDefault: true,
  }),
  definition({
    id: "runtime.miniconda",
    familyId: "runtime.conda",
    channel: "stable",
    displayName: "Miniconda",
    registrySignatures: [
      {
        displayNames: ["Miniconda3", "Miniconda"],
        publishers: ["Anaconda, Inc.", "Anaconda"],
      },
    ],
    executableSignatures: [
      executable(
        ["conda.exe", "python.exe"],
        (environment) => [
          path.join(environment.home, "miniconda3", "Scripts", "conda.exe"),
        ],
        ["Miniconda"],
        ["Anaconda, Inc.", "Anaconda"],
      ),
    ],
    processSignatures: [{ executableBasenames: ["conda.exe"] }],
    protectedByDefault: true,
  }),
];

const definitionsById = new Map(
  CLEANER_APPLICATION_DEFINITIONS.map((item) => [item.id, item]),
);

export function getCleanerApplicationDefinition(
  applicationId: string,
): CleanerApplicationDefinition | undefined {
  return definitionsById.get(applicationId);
}

export function getCleanerApplicationDataRoot(
  applicationId: string,
  rootId: string,
): CleanerApplicationDataRoot | undefined {
  return definitionsById
    .get(applicationId)
    ?.dataRoots.find((item) => item.id === rootId);
}

export function resolveCleanerApplicationDataRootPaths(
  applicationId: string,
  rootId: string,
  environment: CleanerEnvironment,
): string[] {
  return (
    getCleanerApplicationDataRoot(applicationId, rootId)?.resolvePaths(
      environment,
    ) ?? []
  );
}

export function isCleanerProtectedParentBypassDefined(
  bypass: {
    applicationId: string;
    protectedAncestor: string;
    exactTarget: string;
    rootId: string;
  },
  environment: CleanerEnvironment,
): boolean {
  const definedRoot = getCleanerApplicationDataRoot(
    bypass.applicationId,
    bypass.rootId,
  );
  if (definedRoot?.allowProtectedParentBypass) {
    return definedRoot
      .resolvePaths(environment)
      .some((targetPath) => sameWindowsPath(targetPath, bypass.exactTarget));
  }

  const browserRoots: Record<string, string> = {
    "browser.chrome": path.join(
      environment.localAppData,
      "Google",
      "Chrome",
      "User Data",
    ),
    "browser.brave": path.join(
      environment.localAppData,
      "BraveSoftware",
      "Brave-Browser",
      "User Data",
    ),
    "browser.edge": path.join(
      environment.localAppData,
      "Microsoft",
      "Edge",
      "User Data",
    ),
    "browser.firefox": path.join(
      environment.localAppData,
      "Mozilla",
      "Firefox",
      "Profiles",
    ),
  };
  const expectedAncestor = browserRoots[bypass.applicationId];
  if (
    !expectedAncestor ||
    !sameWindowsPath(expectedAncestor, bypass.protectedAncestor) ||
    !isWindowsPathInside(bypass.exactTarget, expectedAncestor)
  ) {
    return false;
  }
  const relativeParts = path.win32
    .relative(expectedAncestor, bypass.exactTarget)
    .split("\\")
    .filter(Boolean);
  if (bypass.applicationId === "browser.firefox") {
    return (
      bypass.rootId === "browser.firefox.cache-leaf" &&
      relativeParts.length === 2 &&
      relativeParts[1].toLowerCase() === "cache2"
    );
  }
  if (
    relativeParts.length < 2 ||
    !/^(default|profile \d+)$/i.test(relativeParts[0])
  ) {
    return false;
  }
  const relativeLeaf = relativeParts.slice(1).join("\\").toLowerCase();
  if (bypass.rootId === `${bypass.applicationId}.cache-leaf`) {
    return [
      "cache",
      "code cache",
      "gpucache",
      "shadercache",
      "grshadercache",
    ].includes(relativeLeaf);
  }
  return (
    bypass.rootId === `${bypass.applicationId}.service-worker-cache` &&
    relativeLeaf === "service worker\\cachestorage"
  );
}
