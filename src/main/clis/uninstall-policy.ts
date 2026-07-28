import type { CliDefinition } from "./catalogue";
import type {
  CliInstallation,
  CliPackageIdentity,
  CliInstallationOrigin,
  CliUninstallCapability,
} from "./types";

export function calculateUninstallCapability(input: {
  definition: CliDefinition | undefined;
  identity: CliPackageIdentity | undefined;
  commands: string[];
  presence: CliInstallation["presence"];
  sourceFailed: boolean;
  origin?: CliInstallationOrigin;
}): CliUninstallCapability {
  const base = {
    source: input.identity?.source ?? ("unknown" as const),
    packageId: input.identity?.packageId,
    providedCommands: [...new Set(input.commands)],
    requiresElevation: false,
  };
  if (input.presence !== "present") {
    return {
      ...base,
      status: "blocked",
      reasonCode: "installation-missing",
      reason: "The installation is not currently present.",
      warnings: [],
    };
  }
  if (
    input.origin === "application-embedded" ||
    input.origin === "sdk-bundled"
  ) {
    return {
      ...base,
      status: "blocked",
      reasonCode: "embedded-tool",
      reason: "Bundled tools are managed by their owning application or SDK.",
      warnings: [],
    };
  }
  if (input.sourceFailed) {
    return {
      ...base,
      status: "blocked",
      reasonCode: "source-unavailable",
      reason: "The package source could not be revalidated.",
      warnings: [],
    };
  }
  if (input.definition?.foundational) {
    return {
      ...base,
      status: "manual-only",
      reasonCode: "foundational-tool",
      reason: "Foundational runtimes and package managers are manual-only.",
      warnings: [],
    };
  }
  if (!input.identity) {
    return {
      ...base,
      status: "blocked",
      reasonCode: "standalone-binary",
      reason: "Standalone binaries do not have a proven uninstall owner.",
      warnings: [],
    };
  }
  if (input.identity.ownershipConfidence !== "exact") {
    return {
      ...base,
      status: "blocked",
      reasonCode: "identity-uncertain",
      reason: "Current package ownership is not exact.",
      warnings: [],
    };
  }
  if (["npm", "pipx"].includes(input.identity.source)) {
    return {
      ...base,
      status: "supported",
      reasonCode: "exact-manager-owned",
      reason: "Exact package ownership is available.",
      warnings: [],
    };
  }
  if (input.identity.source === "cargo") {
    return {
      ...base,
      status: "requires-warning",
      reasonCode: "multiple-commands",
      reason: "Cargo removes the exact package and every binary it provides.",
      warnings: ["Every command provided by this Cargo package will be removed."],
    };
  }
  if (
    input.identity.source === "scoop" &&
    input.identity.uninstallEvidence === "simple-manifest"
  ) {
    return {
      ...base,
      status: "requires-warning",
      reasonCode: "multiple-commands",
      reason: "This Scoop manifest has no custom uninstall hooks.",
      warnings: [
        "Every command provided by this Scoop application will be removed.",
      ],
    };
  }
  if (input.identity.source === "homebrew-formula") {
    return {
      ...base,
      status: "requires-warning",
      reasonCode: "multiple-commands",
      reason: "Homebrew can remove this exact formula.",
      warnings: ["Every command provided by this formula will be removed."],
    };
  }
  return {
    ...base,
    status: "manual-only",
    reasonCode: "manager-policy",
    reason: "This package source is inventory-only in the current safety policy.",
    warnings: [],
  };
}
