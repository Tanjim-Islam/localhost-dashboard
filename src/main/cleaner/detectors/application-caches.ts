import path from "node:path";
import type { CleanerDetector, CleanerDetectorContext } from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

export class ApplicationCacheDetector implements CleanerDetector {
  readonly id = "applications.cache-leaves";
  readonly category = "Application cache leaves";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const cursor = context.applications.find(
      (application) => application.id === "editor.cursor",
    );
    const cursorActionable = Boolean(
      cursor &&
      cursor.installState !== "ambiguous" &&
      cursor.installState !== "unknown",
    );
    return keepExistingCandidates(context, [
      candidate({
        detectorId: "editor.cursor.compile-cache",
        category: this.category,
        displayName: "Cursor compile cache",
        applicationName: "Cursor",
        applicationId: "editor.cursor",
        dataRootId: "editor.cursor.compile-cache",
        path: path.join(
          context.environment.localAppData,
          "cursor-compile-cache",
        ),
        baseSafety: cursorActionable ? "safe-now" : "protected",
        reason:
          "Exact Cursor compiled-artifact cache. Cursor settings, history, projects, extensions, and workspace state are not included.",
        consequences: ["Cursor may recompile cached artifacts."],
        restoration: "Cursor rebuilds this cache automatically.",
        relatedProcessNames: ["Cursor.exe"],
        dataKind: "compiled-cache",
        processMatchRules: [
          {
            applicationIds: ["editor.cursor"],
            commandCategories: ["editor"],
            executableBasenames: ["Cursor.exe"],
            allowReferencedTarget: true,
            weakNameWarnings: ["Cursor.exe"],
          },
        ],
        canDelete: Boolean(cursorActionable),
      }),
    ]);
  }
}
