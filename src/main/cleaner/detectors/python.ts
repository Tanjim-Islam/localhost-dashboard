import path from "node:path";
import type {
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDetectorContext,
  CleanerProcessCommandCategory,
} from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

export class PythonCacheDetector implements CleanerDetector {
  readonly id = "dev.python";
  readonly category = "Python";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const { home, localAppData, roamingAppData } = context.environment;
    const candidates: CleanerDetectorCandidate[] = [
      safeCache(
        "dev.uv-cache",
        "uv package cache",
        "uv",
        path.join(localAppData, "uv", "cache"),
        ["uv", "python", "python3"],
        ["uv-operation"],
        "root-children",
      ),
      safeCache(
        "dev.pip-cache",
        "pip package cache",
        "pip",
        path.join(localAppData, "pip", "Cache"),
        ["pip", "python", "python3"],
        ["pip-operation"],
      ),
      safeCache(
        "dev.poetry-cache",
        "Poetry package cache",
        "Poetry",
        path.join(localAppData, "pypoetry", "Cache"),
        ["poetry", "python"],
        ["poetry-operation"],
      ),
      safeCache(
        "dev.pipenv-cache",
        "Pipenv cache",
        "Pipenv",
        path.join(localAppData, "pipenv", "Cache"),
        ["pipenv", "python"],
        ["pipenv-operation"],
      ),
      candidate({
        detectorId: "dev.jupyter-runtime",
        category: this.category,
        displayName: "Jupyter runtime state",
        applicationName: "Jupyter",
        path: path.join(roamingAppData, "jupyter", "runtime"),
        baseSafety: "protected",
        reason:
          "Protected session state. Runtime connection files can contain active kernel details and are not ordinary cache.",
        consequences: [
          "Deleting current connection files can disconnect notebook clients.",
        ],
        restoration:
          "Jupyter creates new runtime state when a new kernel starts.",
        relatedProcessNames: ["jupyter", "python"],
        dataKind: "session-state",
        processMatchRules: [
          {
            commandCategories: ["jupyter-operation"],
            allowReferencedTarget: true,
            weakNameWarnings: ["jupyter", "python"],
          },
        ],
        canDelete: false,
      }),
      candidate({
        detectorId: "models.huggingface",
        category: "AI models",
        displayName: "Hugging Face model and dataset store",
        applicationName: "Hugging Face",
        path: path.join(home, ".cache", "huggingface"),
        baseSafety: "protected",
        reason:
          "Protected model and dataset storage. Download cost, offline use, and local snapshots make this installed data, not ordinary cache.",
        consequences: [
          "Models and datasets can be expensive or impossible to restore offline.",
        ],
        restoration:
          "Restore from a backup or redownload the exact model and dataset revisions.",
        relatedProcessNames: ["python", "huggingface", "transformers"],
        dataKind: "model-data",
        canDelete: false,
      }),
      candidate({
        detectorId: "models.torch",
        category: "AI models",
        displayName: "Torch model and compiled-artifact store",
        applicationName: "PyTorch",
        path: path.join(home, ".cache", "torch"),
        baseSafety: "protected",
        reason:
          "Protected model and compiled-extension storage. It is not part of safe bulk cleanup.",
        consequences: [
          "Models may need redownload and compiled extensions may rebuild.",
        ],
        restoration: "Restore from a backup or redownload required artifacts.",
        relatedProcessNames: ["python", "torch"],
        dataKind: "model-data",
        canDelete: false,
      }),
    ];
    candidates.push(...(await detectCondaData(context)));
    return keepExistingCandidates(context, candidates);
  }
}

async function detectCondaData(
  context: CleanerDetectorContext,
): Promise<CleanerDetectorCandidate[]> {
  const roots = [
    {
      applicationId: "runtime.anaconda",
      name: "Anaconda",
      root: path.join(context.environment.home, "anaconda3"),
    },
    {
      applicationId: "runtime.miniconda",
      name: "Miniconda",
      root: path.join(context.environment.home, "miniconda3"),
    },
  ];
  const results: CleanerDetectorCandidate[] = [];
  for (const definition of roots) {
    const application = context.applications.find(
      (item) => item.id === definition.applicationId,
    );
    const hasMetadata =
      (await context.filesystem.exists(
        path.join(definition.root, "conda-meta"),
      )) ||
      (await context.filesystem.exists(
        path.join(definition.root, "Scripts", "conda.exe"),
      ));
    if (
      !hasMetadata &&
      application?.installState !== "confirmed-installed" &&
      application?.installState !== "probably-installed"
    ) {
      continue;
    }
    results.push(
      candidate({
        detectorId: `dev.${definition.name.toLowerCase()}.packages`,
        category: "Python",
        displayName: `${definition.name} package store`,
        applicationName: definition.name,
        applicationId: definition.applicationId,
        dataRootId: `${definition.applicationId}.package-store`,
        path: path.join(definition.root, "pkgs"),
        baseSafety: "protected",
        reason:
          "Protected shared package store. Cleaner never deletes the entire Conda package store directly.",
        consequences: [
          "Environments can share extracted packages and offline archives.",
        ],
        restoration:
          "Use Conda's own package-cache inspection and a reviewed dry run.",
        relatedProcessNames: ["conda", "python"],
        dataKind: "shared-dependency-store",
        ownershipStatus: "shared",
        processMatchRules: [
          {
            applicationIds: [definition.applicationId],
            commandCategories: ["conda-operation"],
            allowExecutableInsideTarget: true,
            allowReferencedTarget: true,
            weakNameWarnings: ["conda", "python"],
          },
        ],
        canDelete: false,
      }),
      candidate({
        detectorId: `dev.${definition.name.toLowerCase()}.environments`,
        category: "Python",
        displayName: `${definition.name} environments`,
        applicationName: definition.name,
        applicationId: definition.applicationId,
        dataRootId: `${definition.applicationId}.environments`,
        path: path.join(definition.root, "envs"),
        baseSafety: "protected",
        reason:
          "Protected installed runtimes and packages. Environments are not cache.",
        consequences: ["Deleting an environment removes its runtime."],
        restoration:
          "Recreate each environment from a reviewed environment definition.",
        relatedProcessNames: ["conda", "python"],
        dataKind: "installed-runtime",
        canDelete: false,
      }),
    );

    const packageRoot = path.join(definition.root, "pkgs");
    if (!(await context.filesystem.exists(packageRoot))) continue;
    try {
      const entries = await context.filesystem.readDirectory(packageRoot);
      for (const entry of entries.slice(0, 400)) {
        if (!entry.isFile || !/\.(?:conda|tar\.bz2)$/i.test(entry.name)) {
          continue;
        }
        results.push(
          candidate({
            detectorId: `dev.${definition.name.toLowerCase()}.package-archive`,
            category: "Python",
            displayName: `${definition.name} downloaded package archive`,
            applicationName: definition.name,
            applicationId: definition.applicationId,
            dataRootId: `${definition.applicationId}.package-archive`,
            path: path.join(packageRoot, entry.name),
            baseSafety: "conditional",
            reason:
              "Exact downloaded package archive. The extracted package store and environments are not included.",
            consequences: [
              "Conda may need to redownload this exact package archive.",
            ],
            restoration:
              "Conda can redownload the package when its configured channel remains available.",
            relatedProcessNames: ["conda", "python"],
            dataKind: "download-cache",
            processMatchRules: [
              {
                applicationIds: [definition.applicationId],
                commandCategories: ["conda-operation"],
                allowReferencedTarget: true,
                weakNameWarnings: ["conda", "python"],
              },
            ],
            canDelete: true,
          }),
        );
      }
    } catch {
      // Inaccessible package stores remain represented by the protected parent.
    }
  }
  return results;
}

function safeCache(
  detectorId: string,
  displayName: string,
  applicationName: string,
  targetPath: string,
  relatedProcessNames: string[],
  commandCategories: CleanerProcessCommandCategory[],
  protectedMarkerScope?: CleanerDetectorCandidate["protectedMarkerScope"],
) {
  return candidate({
    detectorId,
    category: "Python",
    displayName,
    applicationName,
    path: targetPath,
    baseSafety: "safe-now",
    reason: `Exact ${applicationName} regenerable download cache. Environments and project source are not included.`,
    consequences: ["Packages or metadata may be downloaded again."],
    restoration: `${applicationName} recreates this cache automatically.`,
    relatedProcessNames,
    dataKind: "download-cache",
    processMatchRules: [
      {
        commandCategories,
        allowExecutableInsideTarget: true,
        allowReferencedTarget: true,
        weakNameWarnings: relatedProcessNames,
      },
    ],
    protectedMarkerScope,
    canDelete: true,
  });
}
