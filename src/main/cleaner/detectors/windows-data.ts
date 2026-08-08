import path from "node:path";
import type {
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDetectorContext,
} from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

export class WindowsDataDetector implements CleanerDetector {
  readonly id = "windows.data";
  readonly category = "Windows temporary data";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const { home, localAppData, windowsDir, tempDir } = context.environment;
    const candidates: CleanerDetectorCandidate[] = [
      candidate({
        detectorId: "windows.squirrel-temp",
        category: this.category,
        displayName: "Squirrel installer temporary data",
        applicationName: "Squirrel updater",
        path: path.join(localAppData, "SquirrelTemp"),
        baseSafety: "safe-now",
        reason:
          "Exact Squirrel temporary installer path used for regenerable update payloads.",
        consequences: [
          "A future application update may download its payload again.",
        ],
        restoration: "Squirrel recreates this directory during future updates.",
        relatedProcessNames: ["update", "squirrel", "installer"],
        dataKind: "updater-payload",
        processMatchRules: [
          {
            commandCategories: ["updater"],
            allowReferencedTarget: true,
            weakNameWarnings: ["update", "squirrel", "installer"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "windows.electron-updater",
        category: this.category,
        displayName: "Electron updater pending payloads",
        applicationName: "electron-updater",
        path: path.join(localAppData, "electron-updater", "pending"),
        baseSafety: "safe-now",
        reason:
          "Exact pending updater payload cache. Installed applications are not included.",
        consequences: ["A pending update may need to download again."],
        restoration: "The updater downloads a new payload when needed.",
        relatedProcessNames: ["update", "updater", "electron"],
        dataKind: "updater-payload",
        processMatchRules: [
          {
            commandCategories: ["updater", "electron-download"],
            allowReferencedTarget: true,
            weakNameWarnings: ["update", "updater", "electron"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "windows.directx-shader-cache",
        category: this.category,
        displayName: "DirectX shader cache",
        applicationName: "DirectX",
        path: path.join(localAppData, "D3DSCache"),
        baseSafety: "safe-now",
        reason:
          "Exact DirectX compiled shader cache. It does not contain installed games or personal data.",
        consequences: [
          "Games and graphics applications may briefly rebuild shaders.",
        ],
        restoration: "Applications and Windows recreate shaders automatically.",
        relatedProcessNames: ["dwm", "game", "renderer"],
        dataKind: "compiled-cache",
        processMatchRules: [
          {
            allowReferencedTarget: true,
            weakNameWarnings: ["dwm", "game", "renderer"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "windows.nvidia-dx-cache",
        category: this.category,
        displayName: "NVIDIA DirectX cache",
        applicationName: "NVIDIA",
        path: path.join(home, "AppData", "LocalLow", "NVIDIA", "DXCache"),
        baseSafety: "safe-now",
        reason:
          "Exact NVIDIA LocalLow DirectX compiled shader cache. Driver settings and installed software are not included.",
        consequences: [
          "Shaders will recompile and games may briefly stutter on first reuse.",
        ],
        restoration:
          "The NVIDIA driver and graphics applications recreate shaders.",
        relatedProcessNames: ["nvcontainer", "nvidia", "game"],
        dataKind: "compiled-cache",
        processMatchRules: [
          {
            allowReferencedTarget: true,
            weakNameWarnings: ["nvcontainer", "nvidia", "game"],
          },
        ],
        canDelete: true,
      }),
      candidate({
        detectorId: "windows.crash-dumps",
        category: this.category,
        displayName: "Application crash dumps",
        applicationName: "Windows Error Reporting",
        path: path.join(localAppData, "CrashDumps"),
        baseSafety: "conditional",
        reason:
          "Recognized crash diagnostics. They are removable only if they are no longer needed for debugging.",
        consequences: ["Past crash diagnostics will no longer be available."],
        restoration:
          "Old crash dumps cannot be recreated. New crashes may create new dumps.",
        relatedProcessNames: [],
        dataKind: "history",
        canDelete: true,
      }),
      candidate({
        detectorId: "windows.user-temp",
        category: this.category,
        displayName: "User temporary directory",
        applicationName: "Windows and applications",
        path: tempDir,
        baseSafety: "manual-review",
        reason:
          "Manual review only. A broad Temp directory can contain active installer state and unknown application files, so it is not assumed safe.",
        consequences: [
          "Deleting unknown temporary state can interrupt applications or installers.",
        ],
        restoration: "Restoration varies by application and is not guaranteed.",
        relatedProcessNames: [],
        dataKind: "unknown",
        canDelete: false,
      }),
      protectedWindows(
        "windows.system-temp",
        "Windows temporary directory",
        path.join(windowsDir, "Temp"),
        "A broad system temporary directory can contain active privileged installer state.",
      ),
      protectedWindows(
        "windows.delivery-optimization",
        "Delivery Optimization cache",
        path.join(
          windowsDir,
          "ServiceProfiles",
          "NetworkService",
          "AppData",
          "Local",
          "Microsoft",
          "Windows",
          "DeliveryOptimization",
          "Cache",
        ),
        "Windows manages this cache. Use Windows Storage settings for supported cleanup.",
      ),
      protectedWindows(
        "windows.update-downloads",
        "Windows Update downloads",
        path.join(windowsDir, "SoftwareDistribution", "Download"),
        "Protected system update state. This Cleaner never stops services or manipulates Windows Update internals.",
      ),
      protectedWindows(
        "windows.recycle-bin",
        "Recycle Bin storage",
        path.join(context.environment.systemDrive, "$Recycle.Bin"),
        "Protected in this implementation. Use the Recycle Bin UI to inspect and empty it deliberately.",
      ),
      protectedWindows(
        "windows.logs",
        "Windows logs",
        path.join(windowsDir, "Logs"),
        "Protected system logs may be required for diagnostics and servicing.",
      ),
      protectedWindows(
        "windows.winsxs",
        "Windows component store",
        path.join(windowsDir, "WinSxS"),
        "Protected system component store. Manual deletion can break Windows servicing.",
      ),
      protectedWindows(
        "windows.installer",
        "Windows Installer cache",
        path.join(windowsDir, "Installer"),
        "Protected installer cache required for repair, updates, and uninstallation.",
      ),
    ];

    candidates.push(...(await detectThumbnailCaches(context)));
    candidates.push(...(await detectApplicationUpdaterPayloads(context)));
    return keepExistingCandidates(context, candidates);
  }
}

function protectedWindows(
  detectorId: string,
  displayName: string,
  targetPath: string,
  reason: string,
) {
  return candidate({
    detectorId,
    category: "Windows temporary data",
    displayName,
    applicationName: "Windows",
    path: targetPath,
    baseSafety: "protected",
    reason,
    consequences: [
      "Unsupported deletion can damage Windows state or remove diagnostics.",
    ],
    restoration: "Use Windows-supported cleanup tools where applicable.",
    relatedProcessNames: [],
    dataKind: "settings",
    canDelete: false,
  });
}

async function detectThumbnailCaches(
  context: CleanerDetectorContext,
): Promise<CleanerDetectorCandidate[]> {
  const explorerPath = path.join(
    context.environment.localAppData,
    "Microsoft",
    "Windows",
    "Explorer",
  );
  if (!(await context.filesystem.exists(explorerPath))) return [];
  try {
    const entries = await context.filesystem.readDirectory(explorerPath);
    return entries
      .filter(
        (entry) =>
          entry.isFile && /^thumbcache_[a-z0-9_]+\.db$/i.test(entry.name),
      )
      .slice(0, 40)
      .map((entry) =>
        candidate({
          detectorId: "windows.thumbnail-cache",
          category: "Windows temporary data",
          displayName: `Windows thumbnail cache ${entry.name}`,
          applicationName: "Windows Explorer",
          path: path.join(explorerPath, entry.name),
          baseSafety: "conditional",
          reason:
            "Exact recognized thumbnail cache file. Explorer usually keeps these files open, so this implementation reports them without direct deletion.",
          consequences: [
            "Explorer will regenerate thumbnails and folders may load more slowly.",
          ],
          restoration:
            "Windows Explorer recreates thumbnail data automatically.",
          relatedProcessNames: ["explorer", "explorer.exe"],
          dataKind: "compiled-cache",
          processMatchRules: [
            {
              allowReferencedTarget: true,
              weakNameWarnings: ["explorer", "explorer.exe"],
            },
          ],
          canDelete: false,
        }),
      );
  } catch {
    return [];
  }
}

async function detectApplicationUpdaterPayloads(
  context: CleanerDetectorContext,
): Promise<CleanerDetectorCandidate[]> {
  const roots = [
    {
      applicationId: "updater.stealth-coder",
      displayName: "Stealth Coder",
      rootId: "updater.stealth-coder.payload",
      targetPath: path.join(
        context.environment.localAppData,
        "stealth-coder-updater",
      ),
    },
    {
      applicationId: "updater.zcode-desktop",
      displayName: "ZCode Desktop",
      rootId: "updater.zcode-desktop.payload",
      targetPath: path.join(
        context.environment.localAppData,
        "@zcodedesktop-updater",
      ),
    },
  ];
  const results: CleanerDetectorCandidate[] = [];
  for (const root of roots) {
    if (!(await context.filesystem.exists(root.targetPath))) continue;
    results.push(
      candidate({
        detectorId: `${root.applicationId}.state-root`,
        category: "Windows temporary data",
        displayName: `${root.displayName} updater state root`,
        applicationName: root.displayName,
        applicationId: root.applicationId,
        dataRootId: `${root.rootId}.mixed-root`,
        path: root.targetPath,
        baseSafety: "protected",
        reason:
          "Protected mixed updater state root. Only exact disposable payload children are considered separately.",
        consequences: ["Pending update state may be required."],
        restoration: "Let the application updater manage its state.",
        relatedProcessNames: ["update", "updater"],
        dataKind: "settings",
        canDelete: false,
      }),
    );
    let entries;
    try {
      entries = await context.filesystem.readDirectory(root.targetPath);
    } catch {
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
    for (const entry of entries.slice(0, 120)) {
      if (entry.isSymbolicLink) continue;
      const lower = entry.name.toLowerCase();
      const isPayloadDirectory =
        entry.isDirectory && /^(?:pending|downloads?|packages?)$/.test(lower);
      const isBlockmap = entry.isFile && lower.endsWith(".blockmap");
      const isArchive = entry.isFile && /\.(?:zip|7z|nupkg)$/i.test(entry.name);
      const isInstallerWithMetadata =
        entry.isFile &&
        /\.exe$/i.test(entry.name) &&
        (names.has(`${lower}.blockmap`) ||
          [...names].some(
            (name) =>
              name.endsWith(".blockmap") &&
              lower.replace(/\.exe$/i, "") ===
                name.replace(/\.exe\.blockmap$|\.blockmap$/i, ""),
          ));
      if (
        !isPayloadDirectory &&
        !isBlockmap &&
        !isArchive &&
        !isInstallerWithMetadata
      ) {
        continue;
      }
      results.push(
        candidate({
          detectorId: `${root.applicationId}.payload-child`,
          category: "Windows temporary data",
          displayName: `${root.displayName} updater payload ${entry.name}`,
          applicationName: root.displayName,
          applicationId: root.applicationId,
          dataRootId: `${root.rootId}.child.${lower}`,
          path: path.join(root.targetPath, entry.name),
          baseSafety: "conditional",
          reason:
            "Exact application-definition-backed updater payload child. An installer filename alone is never sufficient evidence.",
          consequences: ["The update may need to download again."],
          restoration: "The verified updater can redownload the payload.",
          relatedProcessNames: ["update", "updater"],
          dataKind: "updater-payload",
          processMatchRules: [
            {
              applicationIds: [root.applicationId],
              commandCategories: ["updater"],
              allowReferencedTarget: true,
              weakNameWarnings: ["update", "updater"],
            },
          ],
          canDelete: true,
          supportedModes: ["deep"],
        }),
      );
    }
  }
  return results;
}
