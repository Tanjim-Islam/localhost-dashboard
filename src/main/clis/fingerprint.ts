import { createHash } from "node:crypto";
import path from "node:path";
import type {
  CliExecutableEndpoint,
  CliPackageIdentity,
  CliPlatform,
} from "./types";

export function normalizeCliPath(
  value: string,
  platform: CliPlatform,
): string {
  const normalized =
    platform === "win32"
      ? path.win32.normalize(value.trim())
      : path.posix.normalize(value.trim());
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function stableCliId(
  prefix: string,
  value: Readonly<Record<string, unknown>>,
): string {
  const digest = createHash("sha256")
    .update(stableSerialize(value))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

export function createInstallationId(input: {
  platform: CliPlatform;
  productId: string;
  packageIdentity?: CliPackageIdentity;
  canonicalPath?: string;
  installationRoot?: string;
  standaloneIdentity?: string;
}): string {
  const packageIdentity = input.packageIdentity;
  return stableCliId("cli", {
    platform: input.platform,
    productId: input.productId,
    source: packageIdentity?.source ?? "standalone",
    packageId: packageIdentity?.packageId.toLowerCase() ?? "",
    scope: packageIdentity?.scope ?? "unknown",
    managerRoot: packageIdentity?.managerRoot
      ? normalizeCliPath(packageIdentity.managerRoot, input.platform)
      : "",
    installationRoot: normalizeOptional(
      packageIdentity?.installRoot ?? input.installationRoot,
      input.platform,
    ),
    canonicalPath: packageIdentity
      ? ""
      : normalizeOptional(
          input.standaloneIdentity ?? input.canonicalPath,
          input.platform,
        ),
  });
}

export function createEndpointFingerprint(
  endpoint: Omit<CliExecutableEndpoint, "id" | "fingerprint">,
  platform: CliPlatform,
): string {
  return stableCliId("fp", {
    path: normalizeCliPath(endpoint.path, platform),
    canonicalPath: normalizeOptional(endpoint.canonicalPath, platform),
    symlinkTarget: normalizeOptional(endpoint.symlinkTarget, platform),
    shimTarget: normalizeOptional(endpoint.shimTarget, platform),
    fileSize: endpoint.fileSize ?? null,
    modifiedAt: endpoint.modifiedAt ?? null,
    fileIdentity: endpoint.fileIdentity ?? null,
    targetExists: endpoint.targetExists,
    accessible: endpoint.accessible,
  });
}

export function createInstallationFingerprint(input: {
  platform: CliPlatform;
  packageIdentity?: CliPackageIdentity;
  endpoints: CliExecutableEndpoint[];
}): string {
  return stableCliId("install-fp", {
    platform: input.platform,
    source: input.packageIdentity?.source ?? "standalone",
    packageId: input.packageIdentity?.packageId ?? "",
    packageVersion: input.packageIdentity?.packageVersion ?? "",
    managerRoot: normalizeOptional(
      input.packageIdentity?.managerRoot,
      input.platform,
    ),
    managerCommandPath: normalizeOptional(
      input.packageIdentity?.managerCommandPath,
      input.platform,
    ),
    installRoot: normalizeOptional(
      input.packageIdentity?.installRoot,
      input.platform,
    ),
    endpoints: input.endpoints
      .map((endpoint) => endpoint.fingerprint)
      .sort(),
  });
}

function normalizeOptional(
  value: string | undefined,
  platform: CliPlatform,
): string {
  return value ? normalizeCliPath(value, platform) : "";
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}
