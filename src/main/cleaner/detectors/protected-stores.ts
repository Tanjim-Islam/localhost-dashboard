import path from "node:path";
import type {
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDetectorContext,
} from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

export class ProtectedStoreDetector implements CleanerDetector {
  readonly id = "protected.stores";
  readonly category = "Protected development data";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const { home, localAppData, programData } = context.environment;
    const protectedCandidate = (
      detectorId: string,
      displayName: string,
      applicationName: string,
      targetPath: string,
      reason: string,
      dataKind:
        | "database"
        | "model-data"
        | "installed-runtime"
        | "settings" = "settings",
    ) =>
      candidate({
        detectorId,
        category: this.category,
        displayName,
        applicationName,
        path: targetPath,
        baseSafety: "protected",
        reason,
        consequences: [
          "The data is not recoverable through ordinary cache regeneration.",
        ],
        restoration:
          "Use the owning product's dedicated management or backup workflow.",
        relatedProcessNames: [applicationName.toLowerCase()],
        dataKind,
        canDelete: false,
      });

    const candidates: CleanerDetectorCandidate[] = [
      protectedCandidate(
        "virtualization.docker-vhdx",
        "Docker Desktop virtual disk",
        "Docker",
        path.join(localAppData, "Docker", "wsl", "disk", "docker_data.vhdx"),
        "Protected. The virtual disk can contain images, containers, volumes, and databases. Its full size is not recoverable space.",
        "installed-runtime",
      ),
      protectedCandidate(
        "virtualization.docker-vhdx",
        "Docker Desktop main virtual disk",
        "Docker",
        path.join(localAppData, "Docker", "wsl", "main", "ext4.vhdx"),
        "Protected. The virtual disk contains Docker-managed Linux state. Cleaner never deletes or compacts it.",
        "installed-runtime",
      ),
      protectedCandidate(
        "virtualization.docker-vhdx-legacy",
        "Docker Desktop legacy virtual disk",
        "Docker",
        path.join(localAppData, "Docker", "wsl", "data", "ext4.vhdx"),
        "Protected legacy Docker virtual disk. Its logical size is not reclaimable space.",
        "installed-runtime",
      ),
      protectedCandidate(
        "database.postgresql",
        "PostgreSQL data",
        "PostgreSQL",
        path.join(programData, "PostgreSQL"),
        "Protected database storage. The Cleaner never removes databases or backups.",
        "database",
      ),
      protectedCandidate(
        "database.mongodb",
        "MongoDB data",
        "MongoDB",
        path.join(programData, "MongoDB"),
        "Protected database storage. The Cleaner never removes databases or backups.",
        "database",
      ),
      protectedCandidate(
        "models.ollama",
        "Ollama model store",
        "Ollama",
        path.join(home, ".ollama", "models"),
        "Protected model store. Models are large installed assets and may be costly to download again.",
        "model-data",
      ),
      protectedCandidate(
        "models.lm-studio",
        "LM Studio model store",
        "LM Studio",
        path.join(home, ".cache", "lm-studio", "models"),
        "Protected model store. Models are not treated as ordinary cache data.",
        "model-data",
      ),
      protectedCandidate(
        "models.lm-studio-home",
        "LM Studio home model store",
        "LM Studio",
        path.join(home, ".lmstudio", "models"),
        "Protected model store. Models are installed assets, not ordinary cache.",
        "model-data",
      ),
      protectedCandidate(
        "models.paddlex",
        "PaddleX model and runtime store",
        "PaddleX",
        path.join(home, ".paddlex"),
        "Protected models, runtimes, and configuration.",
        "model-data",
      ),
      protectedCandidate(
        "runtime.codex",
        "Codex runtime store",
        "Codex",
        path.join(home, ".codex", "runtimes"),
        "Protected installed Codex runtime data.",
        "installed-runtime",
      ),
    ];
    candidates.push(...(await detectWslDisks(context)));
    candidates.push(...(await detectUnknownProfileCaches(context)));
    return keepExistingCandidates(context, candidates);
  }
}

async function detectWslDisks(
  context: CleanerDetectorContext,
): Promise<CleanerDetectorCandidate[]> {
  const packagesRoot = path.join(context.environment.localAppData, "Packages");
  if (!(await context.filesystem.exists(packagesRoot))) return [];
  try {
    const entries = await context.filesystem.readDirectory(packagesRoot);
    return entries
      .filter(
        (entry) =>
          entry.isDirectory &&
          /ubuntu|debian|kali|suse|fedora|wsl/i.test(entry.name),
      )
      .slice(0, 80)
      .map((entry) =>
        candidate({
          detectorId: "virtualization.wsl-vhdx",
          category: "Protected development data",
          displayName: `WSL virtual disk ${entry.name}`,
          applicationName: "Windows Subsystem for Linux",
          path: path.join(packagesRoot, entry.name, "LocalState", "ext4.vhdx"),
          baseSafety: "protected",
          reason:
            "Protected. This virtual disk contains the Linux filesystem, installed tools, projects, and databases. Its full size is not recoverable space.",
          consequences: ["The WSL distribution and its data would be lost."],
          restoration: "Restore from a WSL export or other backup.",
          relatedProcessNames: ["wsl", "wslhost", "vmmem"],
          dataKind: "installed-runtime",
          canDelete: false,
        }),
      );
  } catch {
    return [];
  }
}

async function detectUnknownProfileCaches(
  context: CleanerDetectorContext,
): Promise<CleanerDetectorCandidate[]> {
  if (context.mode !== "deep") return [];
  const cacheRoot = path.join(context.environment.home, ".cache");
  if (!(await context.filesystem.exists(cacheRoot))) return [];
  const recognized = new Set([
    "huggingface",
    "torch",
    "puppeteer",
    "lm-studio",
  ]);
  try {
    const entries = await context.filesystem.readDirectory(cacheRoot);
    return entries
      .filter(
        (entry) =>
          entry.isDirectory &&
          !entry.isSymbolicLink &&
          !recognized.has(entry.name.toLowerCase()),
      )
      .slice(0, 30)
      .map((entry) =>
        candidate({
          detectorId: "manual.profile-cache",
          category: "Unknown or manual review",
          displayName: `Unrecognized profile cache ${entry.name}`,
          applicationName: "Unknown",
          path: path.join(cacheRoot, entry.name),
          baseSafety: "manual-review",
          reason:
            "The directory is inside a bounded profile cache root, but no trusted detector rule proves what created it or whether deletion is safe.",
          consequences: [
            "Unknown application or development state may be lost.",
          ],
          restoration: "Restoration behavior is unknown.",
          relatedProcessNames: [],
          dataKind: "unknown",
          canDelete: false,
          supportedModes: ["deep"],
        }),
      );
  } catch {
    return [];
  }
}
