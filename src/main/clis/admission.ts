import { getCliDefinition } from "./catalogue";
import type {
  CliDiscoveryKind,
  CliInstallation,
  CliPackageIdentity,
} from "./types";

// These adapters read declared commands, not the list of installed applications.
const COMMAND_PACKAGE_SOURCES = new Set<CliPackageIdentity["source"]>([
  "npm",
  "pnpm",
  "yarn-classic",
  "bun",
  "pipx",
  "pip",
  "uv",
  "cargo",
  "scoop",
  "homebrew-formula",
  "macports",
]);

export function classifyCliAdmission(input: {
  productId: string;
  packageIdentity?: CliPackageIdentity;
  includedByUser?: boolean;
}): CliDiscoveryKind {
  if (getCliDefinition(input.productId)) return "catalogue";
  const identity = input.packageIdentity;
  if (
    identity &&
    identity.ownershipConfidence !== "uncertain" &&
    (COMMAND_PACKAGE_SOURCES.has(identity.source) ||
      (identity.source === "unknown" &&
        identity.sourceName === "Node.js package"))
  )
    return "package-command";
  return input.includedByUser ? "user" : "candidate";
}

export function isCliCandidate(installation: CliInstallation): boolean {
  return classifyCliAdmission(installation) === "candidate";
}
