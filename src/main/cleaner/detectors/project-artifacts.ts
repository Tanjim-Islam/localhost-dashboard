import path from "node:path";
import type {
  CleanerDetector,
  CleanerDetectorCandidate,
  CleanerDetectorContext,
} from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

const PROJECT_MARKERS = new Set([
  ".git",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  ".sln",
]);

const ARTIFACTS = [
  {
    name: "node_modules",
    label: "project node_modules",
    tool: "Node.js",
    consequence: "Run the project's package-manager install command.",
    dataKind: "shared-dependency-store",
  },
  {
    name: ".next",
    label: "Next.js build output",
    tool: "Next.js",
    consequence: "The next build will recreate optimized output.",
    dataKind: "build-cache",
  },
  {
    name: ".turbo",
    label: "Turborepo cache",
    tool: "Turborepo",
    consequence: "Tasks will recompute cached outputs.",
    dataKind: "build-cache",
  },
  {
    name: "dist",
    label: "project dist output",
    tool: "Build tool",
    consequence: "Rebuild the project before using packaged output.",
    dataKind: "build-cache",
  },
  {
    name: "build",
    label: "project build output",
    tool: "Build tool",
    consequence: "Rebuild the project before using generated output.",
    dataKind: "build-cache",
  },
  {
    name: "out",
    label: "project out directory",
    tool: "Build tool",
    consequence: "Rebuild the project before using generated output.",
    dataKind: "build-cache",
  },
  {
    name: "coverage",
    label: "test coverage output",
    tool: "Test runner",
    consequence: "Run the coverage suite to recreate reports.",
    dataKind: "build-cache",
  },
  {
    name: ".pytest_cache",
    label: "pytest cache",
    tool: "pytest",
    consequence: "pytest recreates its cache on the next run.",
    dataKind: "ordinary-cache",
  },
  {
    name: ".mypy_cache",
    label: "mypy cache",
    tool: "mypy",
    consequence: "mypy will reanalyze the project.",
    dataKind: "ordinary-cache",
  },
  {
    name: ".ruff_cache",
    label: "Ruff cache",
    tool: "Ruff",
    consequence: "Ruff will reanalyze the project.",
    dataKind: "ordinary-cache",
  },
  {
    name: ".tox",
    label: "tox environments",
    tool: "tox",
    consequence: "tox will recreate its managed environments.",
    dataKind: "installed-runtime",
  },
  {
    name: ".nox",
    label: "nox environments",
    tool: "nox",
    consequence: "nox will recreate its managed environments.",
    dataKind: "installed-runtime",
  },
  {
    name: ".venv",
    label: "Python virtual environment",
    tool: "Python",
    consequence: "Recreate the environment and reinstall its dependencies.",
    dataKind: "installed-runtime",
  },
  {
    name: "venv",
    label: "Python virtual environment",
    tool: "Python",
    consequence: "Recreate the environment and reinstall its dependencies.",
    dataKind: "installed-runtime",
  },
  {
    name: "env",
    label: "Python environment directory",
    tool: "Python",
    consequence:
      "Confirm this is an environment, then recreate it and reinstall dependencies.",
    dataKind: "unknown",
  },
] as const;

export class ProjectArtifactDetector implements CleanerDetector {
  readonly id = "project.artifacts";
  readonly category = "Project build artifacts";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    if (context.mode !== "deep") return [];
    const projectDirectories = await discoverProjects(context);
    const candidates: CleanerDetectorCandidate[] = [];
    for (const projectDirectory of projectDirectories) {
      for (const artifact of ARTIFACTS) {
        candidates.push(
          candidate({
            detectorId: `project.${artifact.name.replace(/[^a-z0-9]+/gi, "-")}`,
            category: this.category,
            displayName: artifact.label,
            applicationName: artifact.tool,
            path: path.join(projectDirectory, artifact.name),
            baseSafety: "conditional",
            reason: `Exact ${artifact.name} child of a bounded, marker-confirmed project. Project source and Git data are not included.`,
            consequences: [artifact.consequence],
            restoration: artifact.consequence,
            relatedProcessNames:
              artifact.tool === "Python"
                ? ["python", "python3"]
                : ["node", "npm", "pnpm", "yarn", "bun"],
            dataKind: artifact.dataKind,
            ownershipStatus:
              artifact.dataKind === "shared-dependency-store"
                ? "shared"
                : "exclusive",
            exactDataRoot: true,
            canDelete: true,
            supportedModes: ["deep"],
          }),
        );
      }
    }
    return keepExistingCandidates(context, candidates);
  }
}

async function discoverProjects(
  context: CleanerDetectorContext,
): Promise<string[]> {
  const projects = new Set<string>();
  const queue = context.environment.projectRoots.map((root) => ({
    path: root,
    depth: 0,
  }));
  let inspectedDirectories = 0;

  while (queue.length > 0 && inspectedDirectories < 600) {
    if (context.isCancelled()) break;
    const current = queue.shift()!;
    if (!(await context.filesystem.exists(current.path))) continue;
    try {
      const stat = await context.filesystem.lstat(current.path);
      if (!stat.isDirectory || stat.isSymbolicLink || stat.isReparsePoint)
        continue;
      const entries = await context.filesystem.readDirectory(current.path);
      inspectedDirectories += 1;
      if (
        entries.some((entry) => PROJECT_MARKERS.has(entry.name.toLowerCase()))
      ) {
        projects.add(current.path);
        continue;
      }
      if (current.depth >= 3) continue;
      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymbolicLink) continue;
        if (
          entry.name.startsWith(".") ||
          entry.name.toLowerCase() === "node_modules"
        )
          continue;
        queue.push({
          path: path.join(current.path, entry.name),
          depth: current.depth + 1,
        });
      }
    } catch {
      // Inaccessible project roots are skipped without changing permissions.
    }
  }
  return [...projects];
}
