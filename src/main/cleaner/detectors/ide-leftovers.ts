import path from "node:path";
import type {
  CleanerApplicationResolution,
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDetectorContext,
  CleanerOwnedDataKind,
} from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

type EditorDefinition = {
  appId: string;
  displayName: string;
  roamingName: string;
  extensionFolder: string;
  processNames: string[];
  protectedByDefault?: boolean;
};

const EDITORS: EditorDefinition[] = [
  {
    appId: "editor.vscode",
    displayName: "VS Code",
    roamingName: "Code",
    extensionFolder: ".vscode",
    processNames: ["Code.exe"],
    protectedByDefault: true,
  },
  {
    appId: "editor.vscode-insiders",
    displayName: "VS Code Insiders",
    roamingName: "Code - Insiders",
    extensionFolder: ".vscode-insiders",
    processNames: ["Code - Insiders.exe"],
    protectedByDefault: true,
  },
  {
    appId: "editor.cursor",
    displayName: "Cursor",
    roamingName: "Cursor",
    extensionFolder: ".cursor",
    processNames: ["Cursor.exe"],
  },
  {
    appId: "editor.windsurf",
    displayName: "Windsurf",
    roamingName: "Windsurf",
    extensionFolder: ".windsurf",
    processNames: ["Windsurf.exe"],
  },
  {
    appId: "editor.windsurf-next",
    displayName: "Windsurf Next",
    roamingName: "Windsurf - Next",
    extensionFolder: ".windsurf-next",
    processNames: ["Windsurf - Next.exe"],
  },
  {
    appId: "editor.trae",
    displayName: "Trae",
    roamingName: "Trae",
    extensionFolder: ".trae",
    processNames: ["Trae.exe"],
  },
  {
    appId: "editor.qoder",
    displayName: "Qoder",
    roamingName: "Qoder",
    extensionFolder: ".qoder",
    processNames: ["Qoder.exe"],
  },
  {
    appId: "editor.antigravity",
    displayName: "Gemini Antigravity",
    roamingName: "Antigravity",
    extensionFolder: ".antigravity",
    processNames: ["Antigravity.exe"],
  },
];

const CACHE_LEAVES: Array<{
  name: string;
  dataKind: CleanerOwnedDataKind;
}> = [
  { name: "Cache", dataKind: "ordinary-cache" },
  { name: "CachedData", dataKind: "ordinary-cache" },
  { name: "Code Cache", dataKind: "compiled-cache" },
  { name: "GPUCache", dataKind: "compiled-cache" },
  { name: "DawnGraphiteCache", dataKind: "compiled-cache" },
  { name: "DawnWebGPUCache", dataKind: "compiled-cache" },
  { name: "CachedConfigurations", dataKind: "ordinary-cache" },
  { name: "CachedProfilesData", dataKind: "ordinary-cache" },
  { name: "CachedExtensionVSIXs", dataKind: "download-cache" },
];

const PROTECTED_STATE_LEAVES: Array<{
  relativePath: string[];
  label: string;
  dataKind: CleanerOwnedDataKind;
}> = [
  { relativePath: ["User", "History"], label: "history", dataKind: "history" },
  { relativePath: ["Backups"], label: "backups", dataKind: "backup" },
  {
    relativePath: ["User", "workspaceStorage"],
    label: "workspace state",
    dataKind: "workspace-state",
  },
  {
    relativePath: ["User", "globalStorage"],
    label: "global state",
    dataKind: "settings",
  },
  {
    relativePath: ["ModularData"],
    label: "modular project state",
    dataKind: "project-data",
  },
  { relativePath: ["projects"], label: "projects", dataKind: "project-data" },
  {
    relativePath: ["worktrees"],
    label: "worktrees",
    dataKind: "project-data",
  },
  {
    relativePath: ["Local Storage"],
    label: "local storage",
    dataKind: "local-storage",
  },
  {
    relativePath: ["IndexedDB"],
    label: "IndexedDB",
    dataKind: "indexed-db",
  },
  {
    relativePath: ["Session Storage"],
    label: "session state",
    dataKind: "session-state",
  },
  {
    relativePath: ["databases"],
    label: "databases",
    dataKind: "database",
  },
];

export class IdeLeftoverDetector implements CleanerDetector {
  readonly id = "editor.leftovers";
  readonly category = "IDEs and editors";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const candidates: CleanerDetectorCandidate[] = [];
    for (const editor of EDITORS) {
      const application = findApplication(context, editor.appId);
      const appRoot = path.join(
        context.environment.roamingAppData,
        editor.roamingName,
      );
      const cacheActionable =
        !editor.protectedByDefault &&
        application.installState !== "ambiguous" &&
        application.installState !== "unknown";
      for (const leaf of CACHE_LEAVES) {
        const targetPath = path.join(appRoot, leaf.name);
        candidates.push(
          candidate({
            detectorId: `${editor.appId}.cache`,
            category: this.category,
            displayName: `${editor.displayName} ${leaf.name}`,
            applicationName: editor.displayName,
            applicationId: editor.appId,
            dataRootId: `${editor.appId}.${leaf.name
              .toLowerCase()
              .replaceAll(" ", "-")}`,
            path: targetPath,
            baseSafety: cacheActionable ? "safe-now" : "protected",
            reason: editor.protectedByDefault
              ? `${editor.displayName} cache leaves remain protected by product policy.`
              : `Exact ${editor.displayName} cache-only leaf. The mixed application-data parent is not included.`,
            consequences: [
              "The editor may rebuild UI data and reopen more slowly.",
            ],
            restoration: "The editor recreates this cache when it starts.",
            relatedProcessNames: editor.processNames,
            dataKind: leaf.dataKind,
            processMatchRules: [
              {
                applicationIds: [editor.appId],
                commandCategories: ["editor"],
                executableBasenames: editor.processNames,
                allowReferencedTarget: true,
                weakNameWarnings: editor.processNames,
              },
            ],
            protectedParentBypass: editor.protectedByDefault
              ? undefined
              : {
                  applicationId: editor.appId,
                  protectedAncestor: appRoot,
                  exactTarget: targetPath,
                  rootId: `${editor.appId}.${leaf.name
                    .toLowerCase()
                    .replaceAll(" ", "-")}`,
                },
            canDelete: cacheActionable,
          }),
        );
      }

      const extensionActionable =
        !editor.protectedByDefault &&
        (application.installState === "probably-uninstalled" ||
          application.installState === "confirmed-uninstalled") &&
        application.currentAuditComplete &&
        application.unavailableEvidenceSources.length === 0;
      candidates.push(
        candidate({
          detectorId: `${editor.appId}.extensions`,
          category: this.category,
          displayName: `${editor.displayName} extension store`,
          applicationName: editor.displayName,
          applicationId: editor.appId,
          dataRootId: `${editor.appId}.extensions`,
          path: path.join(
            context.environment.home,
            editor.extensionFolder,
            "extensions",
          ),
          baseSafety: extensionActionable ? "conditional" : "protected",
          reason: extensionActionable
            ? "A complete current audit did not find the exclusive owner. Extensions are still installed capability and require confirmation."
            : "Protected while the editor is installed, portable, ambiguous, or incompletely audited. Extensions are not ordinary cache.",
          consequences: [
            "Extensions and their downloaded components will be removed.",
          ],
          restoration:
            "Reinstall required extensions from the editor marketplace or a backup.",
          relatedProcessNames: editor.processNames,
          dataKind: "extension-store",
          manualApprovalEligible: !editor.protectedByDefault,
          processMatchRules: [
            {
              applicationIds: [editor.appId],
              commandCategories: ["editor"],
              executableBasenames: editor.processNames,
              allowReferencedTarget: true,
              weakNameWarnings: editor.processNames,
            },
          ],
          canDelete: extensionActionable,
        }),
      );

      for (const state of PROTECTED_STATE_LEAVES) {
        candidates.push(
          candidate({
            detectorId: `${editor.appId}.${state.dataKind}`,
            category: this.category,
            displayName: `${editor.displayName} ${state.label}`,
            applicationName: editor.displayName,
            applicationId: editor.appId,
            dataRootId: `${editor.appId}.${state.dataKind}`,
            path: path.join(appRoot, ...state.relativePath),
            baseSafety: "protected",
            reason:
              "Protected recoverable application state. It can contain source history, snapshots, settings, databases, or workspace recovery data.",
            consequences: [
              "Recoverable edits, source snapshots, or user state could be lost.",
            ],
            restoration:
              "Restoration is not guaranteed without a separate backup.",
            relatedProcessNames: editor.processNames,
            dataKind: state.dataKind,
            canDelete: false,
          }),
        );
      }
    }

    candidates.push(...antigravityProtectedData(context));
    candidates.push(...(await detectJetBrainsAndAndroidStudio(context)));
    return keepExistingCandidates(context, candidates);
  }
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

function antigravityProtectedData(
  context: CleanerDetectorContext,
): CleanerDetectorCandidate[] {
  const protectedData = (
    detectorId: string,
    applicationId: string,
    displayName: string,
    targetPath: string,
    dataKind: CleanerOwnedDataKind,
  ) =>
    candidate({
      detectorId,
      category: "IDEs and editors",
      displayName,
      applicationName:
        applicationId === "tool.antigravity-tools"
          ? "Antigravity Tools"
          : "Gemini Antigravity",
      applicationId,
      dataRootId: detectorId,
      path: targetPath,
      baseSafety: "protected",
      reason:
        "Protected product-specific state. Antigravity Tools and Gemini Antigravity are separate identities and are never matched by the word Antigravity alone.",
      consequences: ["Settings, backups, or application state could be lost."],
      restoration: "Use the owning application's backup or reset workflow.",
      relatedProcessNames:
        applicationId === "tool.antigravity-tools"
          ? ["antigravity_tools.exe"]
          : ["Antigravity.exe"],
      dataKind,
      canDelete: false,
    });
  return [
    protectedData(
      "editor.antigravity.gemini-ide",
      "editor.antigravity",
      "Gemini Antigravity IDE state",
      path.join(context.environment.home, ".gemini", "antigravity-ide"),
      "workspace-state",
    ),
    protectedData(
      "editor.antigravity.gemini-backup",
      "editor.antigravity",
      "Gemini Antigravity backup",
      path.join(context.environment.home, ".gemini", "antigravity-backup"),
      "backup",
    ),
    protectedData(
      "tool.antigravity-tools.local",
      "tool.antigravity-tools",
      "Antigravity Tools local data",
      path.join(context.environment.localAppData, "Antigravity Tools"),
      "settings",
    ),
    protectedData(
      "tool.antigravity-tools.bundle",
      "tool.antigravity-tools",
      "Antigravity Tools bundle data",
      path.join(
        context.environment.localAppData,
        "com.lbjlaq.antigravity-tools",
      ),
      "settings",
    ),
    protectedData(
      "tool.antigravity-tools.roaming",
      "tool.antigravity-tools",
      "Antigravity Tools roaming data",
      path.join(
        context.environment.roamingAppData,
        "com.lbjlaq.antigravity-tools",
      ),
      "settings",
    ),
  ];
}

async function detectJetBrainsAndAndroidStudio(
  context: CleanerDetectorContext,
): Promise<CleanerDetectorCandidate[]> {
  const products = [
    {
      applicationId: "editor.jetbrains",
      displayName: "JetBrains IDE",
      vendorRoot: path.join(context.environment.localAppData, "JetBrains"),
      versionPattern:
        /^(?:IntelliJIdea|PyCharm|WebStorm|Rider|CLion|GoLand|PhpStorm|RubyMine)\d/i,
      processNames: [
        "idea64.exe",
        "pycharm64.exe",
        "webstorm64.exe",
        "rider64.exe",
      ],
    },
    {
      applicationId: "editor.android-studio",
      displayName: "Android Studio",
      vendorRoot: path.join(context.environment.localAppData, "Google"),
      versionPattern: /^AndroidStudio/i,
      processNames: ["studio64.exe"],
    },
  ];
  const cacheLeaves = [
    ["caches"],
    ["cache"],
    ["index"],
    ["indices"],
    ["compile-server"],
    ["tmp"],
  ];
  const protectedLeaves = [
    ["LocalHistory"],
    ["plugins"],
    ["projects"],
    ["settings"],
    ["vcs"],
    ["log"],
  ];
  const results: CleanerDetectorCandidate[] = [];

  for (const product of products) {
    if (!(await context.filesystem.exists(product.vendorRoot))) continue;
    const application = findApplication(context, product.applicationId);
    let entries;
    try {
      entries = await context.filesystem.readDirectory(product.vendorRoot);
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 80)) {
      if (
        !entry.isDirectory ||
        entry.isSymbolicLink ||
        !product.versionPattern.test(entry.name)
      ) {
        continue;
      }
      const versionRoot = path.join(product.vendorRoot, entry.name);
      results.push(
        candidate({
          detectorId: `${product.applicationId}.version-root`,
          category: "IDEs and editors",
          displayName: `${product.displayName} ${entry.name} application data`,
          applicationName: product.displayName,
          applicationId: product.applicationId,
          dataRootId: `${product.applicationId}.version-root.${entry.name.toLowerCase()}`,
          path: versionRoot,
          baseSafety: "protected",
          reason:
            "Protected mixed IDE root. Cleaner never deletes an entire JetBrains or Android Studio version directory.",
          consequences: [
            "Settings, plugins, local history, projects, indexes, and runtime state may coexist here.",
          ],
          restoration: "Restoration of mixed IDE state is not guaranteed.",
          relatedProcessNames: product.processNames,
          dataKind: "settings",
          canDelete: false,
          supportedModes: ["deep"],
        }),
      );

      const cacheActionable =
        application.installState !== "ambiguous" &&
        application.installState !== "unknown";
      for (const relativePath of cacheLeaves) {
        results.push(
          candidate({
            detectorId: `${product.applicationId}.typed-cache`,
            category: "IDEs and editors",
            displayName: `${product.displayName} ${relativePath.join("\\")} cache`,
            applicationName: product.displayName,
            applicationId: product.applicationId,
            dataRootId: `${product.applicationId}.dynamic.cache.${entry.name.toLowerCase()}.${relativePath.join("-")}`,
            path: path.join(versionRoot, ...relativePath),
            baseSafety: cacheActionable ? "safe-now" : "protected",
            reason:
              "Exact typed cache, index, compile-server, or temporary leaf. The whole IDE version root is never included.",
            consequences: ["The IDE may rebuild indexes or compile caches."],
            restoration: "The IDE recreates this leaf after restart.",
            relatedProcessNames: product.processNames,
            dataKind: relativePath.includes("index")
              ? "compiled-cache"
              : "build-cache",
            processMatchRules: [
              {
                applicationIds: [product.applicationId],
                commandCategories: ["editor"],
                executableBasenames: product.processNames,
                weakNameWarnings: product.processNames,
              },
            ],
            canDelete: cacheActionable,
            supportedModes: ["deep"],
          }),
        );
      }
      for (const relativePath of protectedLeaves) {
        results.push(
          candidate({
            detectorId: `${product.applicationId}.protected-state`,
            category: "IDEs and editors",
            displayName: `${product.displayName} protected ${relativePath.join("\\")}`,
            applicationName: product.displayName,
            applicationId: product.applicationId,
            dataRootId: `${product.applicationId}.dynamic.protected.${entry.name.toLowerCase()}.${relativePath.join("-")}`,
            path: path.join(versionRoot, ...relativePath),
            baseSafety: "protected",
            reason:
              "Protected IDE history, plugins, projects, settings, VCS data, or diagnostic state.",
            consequences: [
              "User-created or recoverable IDE state could be lost.",
            ],
            restoration: "Restoration is not guaranteed.",
            relatedProcessNames: product.processNames,
            dataKind:
              relativePath[0].toLowerCase() === "projects"
                ? "project-data"
                : relativePath[0].toLowerCase() === "localhistory"
                  ? "history"
                  : "settings",
            canDelete: false,
            supportedModes: ["deep"],
          }),
        );
      }
    }
  }
  return results;
}
