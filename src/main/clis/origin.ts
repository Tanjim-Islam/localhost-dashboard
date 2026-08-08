import path from "node:path";
import { normalizeCliPath } from "./fingerprint";
import type {
  CliExecutableEndpoint,
  CliInstallationOrigin,
  CliPackageIdentity,
  CliPlatform,
} from "./types";

const PACKAGE_MANAGER_SOURCES = new Set([
  "npm",
  "pnpm",
  "yarn-classic",
  "bun",
  "pipx",
  "cargo",
  "winget",
  "chocolatey",
  "scoop",
  "homebrew-formula",
  "homebrew-cask",
  "macports",
]);

export function classifyCliOrigin(input: {
  platform: CliPlatform;
  productId: string;
  packageIdentity?: CliPackageIdentity;
  endpoints: CliExecutableEndpoint[];
  homeDirectory?: string;
}): CliInstallationOrigin {
  const paths = input.endpoints.flatMap((endpoint) =>
    [
      endpoint.path,
      endpoint.canonicalPath,
      endpoint.shimTarget,
      endpoint.shimPackageRoot,
    ].filter((value): value is string => Boolean(value)),
  );
  if (paths.some((value) => isApplicationEmbeddedPath(value, input.platform))) {
    return "application-embedded";
  }
  if (
    !["docker", "docker-compose"].includes(input.productId) &&
    paths.some((value) => isDockerBundledPath(value, input.platform))
  ) {
    return "sdk-bundled";
  }
  if (
    input.packageIdentity &&
    PACKAGE_MANAGER_SOURCES.has(input.packageIdentity.source)
  ) {
    return "package-manager";
  }
  if (
    input.packageIdentity?.scope === "machine" ||
    input.packageIdentity?.scope === "system" ||
    paths.some((value) => isSystemPath(value, input.platform))
  ) {
    return "system";
  }
  if (
    typeof input.homeDirectory === "string" &&
    paths.some((value) =>
      isWithin(value, input.homeDirectory as string, input.platform),
    )
  ) {
    return "user";
  }
  return input.packageIdentity?.scope === "user" ? "user" : "unknown";
}

export function isEmbeddedCliOrigin(origin: CliInstallationOrigin): boolean {
  return origin === "application-embedded" || origin === "sdk-bundled";
}

function isApplicationEmbeddedPath(
  value: string,
  platform: CliPlatform,
): boolean {
  const normalized = normalizeCliPath(value, platform).replaceAll("\\", "/");
  return (
    normalized.includes("/.cache/codex-runtimes/") &&
    normalized.includes("/dependencies/")
  ) || (
    normalized.includes("/openai/codex/runtimes/") &&
    normalized.includes("/dependencies/")
  );
}

function isDockerBundledPath(value: string, platform: CliPlatform): boolean {
  return normalizeCliPath(value, platform)
    .replaceAll("\\", "/")
    .includes("/docker/docker/resources/bin/");
}

function isSystemPath(value: string, platform: CliPlatform): boolean {
  const normalized = normalizeCliPath(value, platform).replaceAll("\\", "/");
  if (platform === "darwin") {
    return normalized.startsWith("/usr/bin/") ||
      normalized.startsWith("/usr/sbin/") ||
      normalized.startsWith("/opt/homebrew/") ||
      normalized.startsWith("/usr/local/");
  }
  return normalized.includes("/program files/") ||
    normalized.includes("/programdata/") ||
    normalized.includes("/windowsapps/");
}

function isWithin(
  value: string,
  root: string,
  platform: CliPlatform,
): boolean {
  const normalizedValue = normalizeCliPath(value, platform);
  const normalizedRoot = normalizeCliPath(root, platform);
  const relative = path.relative(normalizedRoot, normalizedValue);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
