import path from "node:path";
import type {
  CleanerApplicationResolution,
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDetectorContext,
} from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

type ChromiumBrowser = {
  applicationId: string;
  displayName: string;
  profileRoot: string;
  processNames: string[];
};

export class BrowserAndElectronDetector implements CleanerDetector {
  readonly id = "applications.protected";
  readonly category = "Browsers and applications";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const { home, localAppData, roamingAppData } = context.environment;
    const candidates: CleanerDetectorCandidate[] = [];
    const browsers: ChromiumBrowser[] = [
      {
        applicationId: "browser.brave",
        displayName: "Brave",
        profileRoot: path.join(
          localAppData,
          "BraveSoftware",
          "Brave-Browser",
          "User Data",
        ),
        processNames: ["brave.exe"],
      },
      {
        applicationId: "browser.chrome",
        displayName: "Google Chrome",
        profileRoot: path.join(localAppData, "Google", "Chrome", "User Data"),
        processNames: ["chrome.exe"],
      },
      {
        applicationId: "browser.edge",
        displayName: "Microsoft Edge",
        profileRoot: path.join(localAppData, "Microsoft", "Edge", "User Data"),
        processNames: ["msedge.exe"],
      },
    ];

    for (const browser of browsers) {
      candidates.push(
        protectedApplication({
          detectorId: `${browser.applicationId}.profile`,
          displayName: `${browser.displayName} browser profile`,
          applicationName: browser.displayName,
          applicationId: browser.applicationId,
          targetPath: browser.profileRoot,
          reason:
            "Protected browser profile containing sessions, credentials, extensions, databases, site storage, and user settings.",
          processes: browser.processNames,
          dataRootId: `${browser.applicationId}.profile`,
        }),
      );
      candidates.push(...(await detectChromiumCacheLeaves(context, browser)));
    }

    const firefoxRoamingRoot = path.join(
      roamingAppData,
      "Mozilla",
      "Firefox",
      "Profiles",
    );
    candidates.push(
      protectedApplication({
        detectorId: "browser.firefox.profile",
        displayName: "Firefox profiles",
        applicationName: "Mozilla Firefox",
        applicationId: "browser.firefox",
        targetPath: firefoxRoamingRoot,
        reason:
          "Protected Firefox profiles containing sessions, credentials, extensions, databases, history, and local storage.",
        processes: ["firefox.exe"],
        dataRootId: "browser.firefox.profile",
      }),
    );
    candidates.push(...(await detectFirefoxCacheLeaves(context)));

    candidates.push(
      protectedApplication({
        detectorId: "browser.chrome-devtools",
        displayName: "Chrome DevTools application data",
        applicationName: "Chrome DevTools",
        targetPath: path.join(localAppData, "Google", "Chrome DevTools"),
        reason:
          "Protected debugging state and workspace mappings. This identity is not Google Chrome and is never inferred from a project or package name.",
        processes: [],
        dataRootId: "browser.chrome-devtools.state",
      }),
      protectedApplication({
        detectorId: "app.codex-home",
        displayName: "Codex sessions and memory",
        applicationName: "Codex",
        applicationId: "app.codex",
        targetPath: path.join(home, ".codex"),
        reason:
          "Protected Codex sessions, memory, configuration, and runtime state.",
        processes: ["Codex.exe"],
        dataRootId: "app.codex.home",
      }),
      protectedApplication({
        detectorId: "app.codex",
        displayName: "Codex application state",
        applicationName: "Codex",
        applicationId: "app.codex",
        targetPath: path.join(roamingAppData, "Codex"),
        reason:
          "Protected application settings, sessions, databases, and browser state.",
        processes: ["Codex.exe"],
        dataRootId: "app.codex.roaming",
      }),
      protectedApplication({
        detectorId: "app.chatgpt",
        displayName: "ChatGPT application state",
        applicationName: "ChatGPT",
        applicationId: "app.chatgpt",
        targetPath: path.join(roamingAppData, "ChatGPT"),
        reason:
          "Protected application settings, sessions, databases, and local storage.",
        processes: ["ChatGPT.exe"],
        dataRootId: "app.chatgpt.roaming",
      }),
      protectedApplication({
        detectorId: "app.slack",
        displayName: "Slack application state",
        applicationName: "Slack",
        applicationId: "app.slack",
        targetPath: path.join(roamingAppData, "Slack"),
        reason:
          "Protected workspace sessions, databases, offline content, and local state.",
        processes: ["slack.exe"],
        dataRootId: "app.slack.roaming",
      }),
    );
    candidates.push(...detectPackagedApplicationState(context));
    return keepExistingCandidates(context, candidates);
  }
}

async function detectChromiumCacheLeaves(
  context: CleanerDetectorContext,
  browser: ChromiumBrowser,
): Promise<CleanerDetectorCandidate[]> {
  if (!(await context.filesystem.exists(browser.profileRoot))) return [];
  const application = findApplication(context, browser.applicationId);
  const cacheActionable =
    application.installState !== "ambiguous" &&
    application.installState !== "unknown";
  const profileDirectories = [browser.profileRoot];
  try {
    const entries = await context.filesystem.readDirectory(browser.profileRoot);
    for (const entry of entries.slice(0, 120)) {
      if (
        entry.isDirectory &&
        !entry.isSymbolicLink &&
        /^(?:Default|Profile \d+|Guest Profile|System Profile)$/i.test(
          entry.name,
        )
      ) {
        profileDirectories.push(path.join(browser.profileRoot, entry.name));
      }
    }
  } catch {
    return [];
  }

  const results: CleanerDetectorCandidate[] = [];
  const leaves = [
    { relativePath: ["Cache"], dataKind: "ordinary-cache" as const },
    { relativePath: ["Code Cache"], dataKind: "compiled-cache" as const },
    { relativePath: ["GPUCache"], dataKind: "compiled-cache" as const },
    { relativePath: ["ShaderCache"], dataKind: "compiled-cache" as const },
    { relativePath: ["GrShaderCache"], dataKind: "compiled-cache" as const },
  ];
  for (const profileDirectory of profileDirectories) {
    for (const leaf of leaves) {
      const targetPath = path.join(profileDirectory, ...leaf.relativePath);
      results.push(
        candidate({
          detectorId: `${browser.applicationId}.cache-leaf`,
          category: "Browsers and applications",
          displayName: `${browser.displayName} ${leaf.relativePath.join("\\")}`,
          applicationName: browser.displayName,
          applicationId: browser.applicationId,
          dataRootId: `${browser.applicationId}.dynamic.cache.${normalizeRootId(profileDirectory)}.${leaf.relativePath.join("-").toLowerCase()}`,
          path: targetPath,
          baseSafety: cacheActionable ? "safe-now" : "protected",
          reason:
            "Exact definition-backed browser cache leaf. The profile parent, credentials, extensions, history, and site state are not included.",
          consequences: [
            "Pages and graphics may load more slowly while cache is rebuilt.",
          ],
          restoration: `${browser.displayName} recreates this cache automatically.`,
          relatedProcessNames: browser.processNames,
          dataKind: leaf.dataKind,
          processMatchRules: [
            {
              applicationIds: [browser.applicationId],
              commandCategories: ["browser"],
              executableBasenames: browser.processNames,
              weakNameWarnings: browser.processNames,
            },
          ],
          protectedParentBypass: {
            applicationId: browser.applicationId,
            protectedAncestor: browser.profileRoot,
            exactTarget: targetPath,
            rootId: `${browser.applicationId}.cache-leaf`,
          },
          canDelete: cacheActionable,
        }),
      );
    }
    const serviceWorkerPath = path.join(
      profileDirectory,
      "Service Worker",
      "CacheStorage",
    );
    results.push(
      candidate({
        detectorId: `${browser.applicationId}.service-worker-cache`,
        category: "Browsers and applications",
        displayName: `${browser.displayName} Service Worker CacheStorage`,
        applicationName: browser.displayName,
        applicationId: browser.applicationId,
        dataRootId: `${browser.applicationId}.dynamic.service-worker.${normalizeRootId(profileDirectory)}`,
        path: serviceWorkerPath,
        baseSafety: cacheActionable ? "conditional" : "protected",
        reason:
          "Exact Service Worker CacheStorage leaf. It is kept separate from ordinary browser Cache because offline web applications may depend on it.",
        consequences: [
          "Offline web content may be removed and sites may redownload data.",
        ],
        restoration:
          "Sites can rebuild CacheStorage when online, but offline state may not be immediately available.",
        relatedProcessNames: browser.processNames,
        dataKind: "service-worker-cache",
        processMatchRules: [
          {
            applicationIds: [browser.applicationId],
            commandCategories: ["browser"],
            executableBasenames: browser.processNames,
            weakNameWarnings: browser.processNames,
          },
        ],
        protectedParentBypass: {
          applicationId: browser.applicationId,
          protectedAncestor: browser.profileRoot,
          exactTarget: serviceWorkerPath,
          rootId: `${browser.applicationId}.service-worker-cache`,
        },
        canDelete: cacheActionable,
      }),
    );
  }
  return results;
}

async function detectFirefoxCacheLeaves(
  context: CleanerDetectorContext,
): Promise<CleanerDetectorCandidate[]> {
  const localProfiles = path.join(
    context.environment.localAppData,
    "Mozilla",
    "Firefox",
    "Profiles",
  );
  if (!(await context.filesystem.exists(localProfiles))) return [];
  const application = findApplication(context, "browser.firefox");
  const cacheActionable =
    application.installState !== "ambiguous" &&
    application.installState !== "unknown";
  try {
    const entries = await context.filesystem.readDirectory(localProfiles);
    return entries
      .filter((entry) => entry.isDirectory && !entry.isSymbolicLink)
      .slice(0, 80)
      .map((entry) => {
        const targetPath = path.join(localProfiles, entry.name, "cache2");
        return candidate({
          detectorId: "browser.firefox.cache-leaf",
          category: "Browsers and applications",
          displayName: `Firefox cache2 ${entry.name}`,
          applicationName: "Mozilla Firefox",
          applicationId: "browser.firefox",
          dataRootId: `browser.firefox.dynamic.cache.${entry.name.toLowerCase()}`,
          path: targetPath,
          baseSafety: cacheActionable ? "safe-now" : "protected",
          reason:
            "Exact Firefox local cache2 leaf. The separate roaming profile remains protected.",
          consequences: [
            "Pages may load more slowly while Firefox rebuilds cache.",
          ],
          restoration: "Firefox recreates cache2 automatically.",
          relatedProcessNames: ["firefox.exe"],
          dataKind: "ordinary-cache",
          processMatchRules: [
            {
              applicationIds: ["browser.firefox"],
              commandCategories: ["browser"],
              executableBasenames: ["firefox.exe"],
              weakNameWarnings: ["firefox.exe"],
            },
          ],
          protectedParentBypass: {
            applicationId: "browser.firefox",
            protectedAncestor: localProfiles,
            exactTarget: targetPath,
            rootId: "browser.firefox.cache-leaf",
          },
          canDelete: cacheActionable,
        });
      });
  } catch {
    return [];
  }
}

function detectPackagedApplicationState(
  context: CleanerDetectorContext,
): CleanerDetectorCandidate[] {
  const packageEvidence = context.evidenceSnapshot.sources
    .find((source) => source.source === "appx")
    ?.evidence.filter(
      (item) =>
        item.applicationId &&
        item.packageFamilyName &&
        ["app.slack", "app.chatgpt", "app.codex"].includes(item.applicationId),
    );
  return (packageEvidence ?? []).map((item) =>
    protectedApplication({
      detectorId: `${item.applicationId}.packaged-state`,
      displayName: `${findApplication(context, item.applicationId!).displayName} packaged application state`,
      applicationName: findApplication(context, item.applicationId!)
        .displayName,
      applicationId: item.applicationId,
      targetPath: path.join(
        context.environment.localAppData,
        "Packages",
        item.packageFamilyName!,
      ),
      reason:
        "Protected packaged-application state. LocalCache is not assumed safe because packages can mix settings, databases, tokens, and offline content.",
      processes: [],
      dataRootId: `${item.applicationId}.package.${item.packageFamilyName!.toLowerCase()}`,
    }),
  );
}

function protectedApplication(input: {
  detectorId: string;
  displayName: string;
  applicationName: string;
  applicationId?: string;
  targetPath: string;
  reason: string;
  processes: string[];
  dataRootId: string;
}): CleanerDetectorCandidate {
  return candidate({
    detectorId: input.detectorId,
    category: "Browsers and applications",
    displayName: input.displayName,
    applicationName: input.applicationName,
    applicationId: input.applicationId,
    dataRootId: input.dataRootId,
    path: input.targetPath,
    baseSafety: "protected",
    reason: input.reason,
    consequences: [
      "Application state, sessions, databases, credentials, extensions, or offline data could be lost.",
    ],
    restoration:
      "Restoration is not guaranteed. Use the application's own controls.",
    relatedProcessNames: input.processes,
    dataKind: "settings",
    canDelete: false,
  });
}

function findApplication(
  context: CleanerDetectorContext,
  id: string,
): CleanerApplicationResolution {
  return (
    context.applications.find((application) => application.id === id) ?? {
      id,
      familyId: id,
      channel: "stable",
      displayName: id,
      definitionVersion: context.environment.definitionVersion,
      installState: "ambiguous",
      runningState: "unknown",
      confidence: "unknown",
      strongEvidence: [],
      supportingEvidence: [],
      staleEvidence: [],
      unavailableEvidenceSources: ["application-definition"],
      currentAuditComplete: false,
    }
  );
}

function normalizeRootId(targetPath: string): string {
  return path.win32
    .basename(targetPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}
