import path from "node:path";
import type { CleanerDetector, CleanerDetectorContext } from "../types";
import { candidate, keepExistingCandidates } from "./helpers";

export class BuildToolCacheDetector implements CleanerDetector {
  readonly id = "dev.build-tools";
  readonly category = "Build tools and SDKs";
  readonly supportedPlatform = "win32" as const;

  async detect(context: CleanerDetectorContext) {
    const { home, localAppData, goCache } = context.environment;
    const candidates = [
      ...(goCache
        ? [
            candidate({
              detectorId: "dev.go-build-cache",
              category: this.category,
              displayName: "Go build cache",
              applicationName: "Go",
              path: goCache,
              baseSafety: "safe-now",
              reason:
                "Exact Go compiler build cache. Go source and module downloads are not included.",
              consequences: ["Go packages will rebuild on the next compile."],
              restoration:
                "The Go toolchain recreates build outputs automatically.",
              relatedProcessNames: ["go", "gopls"],
              dataKind: "build-cache",
              processMatchRules: [
                {
                  commandCategories: ["go-build"],
                  allowExecutableInsideTarget: true,
                  allowReferencedTarget: true,
                  weakNameWarnings: ["go", "gopls"],
                },
              ],
              canDelete: true,
            }),
          ]
        : []),
      conditional(
        "dev.go-module-cache",
        "Go module cache",
        "Go",
        path.join(home, "go", "pkg", "mod"),
        ["go", "gopls"],
        "Downloaded modules will be fetched again.",
        ["go-build"],
      ),
      conditional(
        "dev.cargo-registry",
        "Cargo registry and crate cache",
        "Cargo",
        path.join(home, ".cargo", "registry"),
        ["cargo", "rustc"],
        "Crates and registry metadata will be downloaded again.",
        ["cargo-operation"],
      ),
      candidate({
        detectorId: "dev.rust-toolchains",
        category: this.category,
        displayName: "Rust toolchains",
        applicationName: "rustup",
        path: path.join(home, ".rustup", "toolchains"),
        baseSafety: "protected",
        reason:
          "Protected. These are installed compiler toolchains, not temporary caches.",
        consequences: [
          "Rust builds will fail until required toolchains are reinstalled.",
        ],
        restoration: "Use rustup to reinstall the required toolchains.",
        relatedProcessNames: ["rustup", "rustc", "cargo"],
        canDelete: false,
        dataKind: "installed-runtime",
      }),
      conditional(
        "dev.gradle-cache",
        "Gradle dependency and build cache",
        "Gradle",
        path.join(home, ".gradle", "caches"),
        ["java", "gradle", "gradlew"],
        "Dependencies will download again and builds will recompute outputs.",
        ["gradle-operation"],
      ),
      conditional(
        "dev.gradle-wrapper",
        "Gradle wrapper distributions",
        "Gradle",
        path.join(home, ".gradle", "wrapper", "dists"),
        ["java", "gradle", "gradlew"],
        "Gradle distributions will download again.",
        ["gradle-operation"],
      ),
      conditional(
        "dev.maven-cache",
        "Maven local repository",
        "Maven",
        path.join(home, ".m2", "repository"),
        ["java", "mvn"],
        "Dependencies will download again. Locally installed unpublished artifacts may not be recoverable.",
        ["maven-operation"],
      ),
      conditional(
        "dev.nuget-cache",
        "NuGet package cache",
        "NuGet",
        path.join(home, ".nuget", "packages"),
        ["dotnet", "nuget", "msbuild"],
        "NuGet packages will be restored again.",
        ["nuget-operation"],
      ),
      candidate({
        detectorId: "sdk.android",
        category: this.category,
        displayName: "Android SDK installation",
        applicationName: "Android SDK",
        path: path.join(localAppData, "Android", "Sdk"),
        baseSafety: "protected",
        reason:
          "Protected. This path contains installed SDK platforms, build tools, emulators, and system images.",
        consequences: ["Android builds and emulators may stop working."],
        restoration:
          "Use Android Studio SDK Manager to reinstall required components.",
        relatedProcessNames: ["studio64", "adb", "emulator", "java"],
        canDelete: false,
        dataKind: "installed-runtime",
      }),
    ];
    return keepExistingCandidates(context, candidates);
  }
}

function conditional(
  detectorId: string,
  displayName: string,
  applicationName: string,
  targetPath: string,
  relatedProcessNames: string[],
  consequence: string,
  commandCategories: import("../types").CleanerProcessCommandCategory[],
) {
  return candidate({
    detectorId,
    category: "Build tools and SDKs",
    displayName,
    applicationName,
    path: targetPath,
    baseSafety: "conditional",
    reason: `Recognized shared ${applicationName} store. It is useful cache-like data, but rebuild or download cost can be significant.`,
    consequences: [consequence],
    restoration: `${applicationName} restores required artifacts during future builds or installs.`,
    relatedProcessNames,
    dataKind: "shared-dependency-store",
    ownershipStatus: "shared",
    processMatchRules: [
      {
        commandCategories,
        allowReferencedTarget: true,
        weakNameWarnings: relatedProcessNames,
      },
    ],
    canDelete: true,
  });
}
