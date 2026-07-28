import { getCliDefinition } from "./catalogue";
import { groupEquivalentEndpointKey } from "./adapters/path";
import {
  createInstallationFingerprint,
  createInstallationId,
} from "./fingerprint";
import {
  assignCommandResolution,
  buildProducts,
  finalizeHealth,
} from "./inventory-builder";
import { classifyCliOrigin } from "./origin";
import { calculateUninstallCapability } from "./uninstall-policy";
import type {
  CliExecutableEndpoint,
  CliCommand,
  CliInstallation,
  CliInstallationOrigin,
  CliInventorySnapshot,
  CliPackageIdentity,
  CliPlatform,
  CliPresence,
  CliRuntimeHealth,
  CliVerificationStatus,
  CliVersionSource,
} from "./types";

const ORIGINS = new Set<CliInstallationOrigin>([
  "user",
  "system",
  "package-manager",
  "application-embedded",
  "sdk-bundled",
  "unknown",
]);
const VERIFICATION_STATUSES = new Set<CliVerificationStatus>([
  "verified",
  "partially-verified",
  "ownership-unknown",
  "version-unverified",
  "cached",
]);

export function normalizeCliInventory(
  value: unknown,
): CliInventorySnapshot | null {
  if (!isInventoryShape(value)) return null;
  const platform = value.platform;
  const endpoints = dedupeEndpoints(value.endpoints);
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const commandsByInstallation = new Map<string, string[]>();
  for (const command of value.commands) {
    if (
      !command ||
      typeof command !== "object" ||
      typeof command.installationId !== "string" ||
      typeof command.name !== "string"
    ) {
      continue;
    }
    const names = commandsByInstallation.get(command.installationId) ?? [];
    names.push(command.name);
    commandsByInstallation.set(command.installationId, names);
  }

  const groups = new Map<string, CliInstallation>();
  for (const raw of value.installations) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.id !== "string" ||
      typeof raw.productId !== "string" ||
      !Array.isArray(raw.endpointIds)
    ) {
      continue;
    }
    const rawId = raw.id;
    const productId = raw.productId;
    const installationEndpoints = raw.endpointIds
      .map((id) => endpointById.get(id))
      .filter((endpoint): endpoint is CliExecutableEndpoint => Boolean(endpoint));
    const identity = isPackageIdentity(raw.packageIdentity)
      ? structuredClone(raw.packageIdentity)
      : undefined;
    const standaloneIdentity = installationEndpoints
      .map((endpoint) =>
        groupEquivalentEndpointKey(
          { productId, endpoint },
          platform,
        ),
      )
      .sort()[0];
    const id = createInstallationId({
      platform,
      productId,
      packageIdentity: identity,
      standaloneIdentity,
      canonicalPath:
        installationEndpoints[0]?.canonicalPath ??
        installationEndpoints[0]?.path,
    });
    const presence = normalizePresence(raw.presence);
    const versionSource = normalizeVersionSource(raw.versionSource);
    const version = typeof raw.version === "string" ? raw.version : undefined;
    const commandNames = [
      ...new Set([
        ...(commandsByInstallation.get(rawId) ?? []),
        ...(raw.uninstallCapability?.providedCommands ?? []),
        ...installationEndpoints.map((endpoint) => endpoint.commandName),
      ]),
    ];
    const candidate: CliInstallation = {
      id,
      productId,
      platform,
      architecture:
        typeof raw.architecture === "string"
          ? raw.architecture
          : typeof value.architecture === "string"
            ? value.architecture
            : "unknown",
      scope: identity?.scope ?? normalizeScope(raw.scope),
      origin: isOrigin(raw.origin)
        ? raw.origin
        : classifyCliOrigin({
            platform,
            productId,
            packageIdentity: identity,
            endpoints: installationEndpoints,
          }),
      ...(version ? { version } : {}),
      versionSource,
      verificationStatus: isVerificationStatus(raw.verificationStatus)
        ? raw.verificationStatus
        : inferVerification(identity, version, versionSource, presence),
      ...(identity ? { packageIdentity: identity } : {}),
      endpointIds: installationEndpoints.map((endpoint) => endpoint.id),
      commandIds: [],
      fingerprint: createInstallationFingerprint({
        platform,
        packageIdentity: identity,
        endpoints: installationEndpoints,
      }),
      presence,
      health: normalizeRuntimeHealth(raw.health, presence),
      issueCodes: Array.isArray(raw.issueCodes)
        ? [...new Set(raw.issueCodes)]
        : [],
      firstSeenAt:
        finite(raw.firstSeenAt) ?? finite(value.generatedAt) ?? 0,
      ...(finite(raw.lastSeenAt) !== undefined
        ? { lastSeenAt: finite(raw.lastSeenAt) }
        : {}),
      ...(finite(raw.lastVerifiedAt) !== undefined
        ? { lastVerifiedAt: finite(raw.lastVerifiedAt) }
        : {}),
      ...(finite(raw.lastSuccessfulVerificationAt) !== undefined
        ? {
            lastSuccessfulVerificationAt: finite(
              raw.lastSuccessfulVerificationAt,
            ),
          }
        : {}),
      ...(finite(raw.missingSince) !== undefined
        ? { missingSince: finite(raw.missingSince) }
        : {}),
      uninstallCapability: calculateUninstallCapability({
        definition: getCliDefinition(productId),
        identity,
        commands: commandNames,
        presence,
        sourceFailed:
          raw.issueCodes?.includes("package-source-unavailable") ?? false,
        origin: isOrigin(raw.origin) ? raw.origin : undefined,
      }),
    };
    const key = identity
      ? `package|${id}`
      : `endpoint|${standaloneIdentity ?? rawId}`;
    const existing = groups.get(key);
    groups.set(
      key,
      existing
        ? mergeInstallations(existing, candidate, endpoints)
        : candidate,
    );
  }

  const installations = [...groups.values()];
  for (const installation of installations) {
    installation.uninstallCapability = calculateUninstallCapability({
      definition: getCliDefinition(installation.productId),
      identity: installation.packageIdentity,
      commands: installation.uninstallCapability.providedCommands,
      presence: installation.presence,
      sourceFailed: installation.issueCodes.includes(
        "package-source-unavailable",
      ),
      origin: installation.origin,
    });
  }
  const commands: CliInventorySnapshot["commands"] = [];
  assignCommandResolution(installations, commands, endpoints);
  const products = buildProducts(platform, installations, commands);
  const normalized: CliInventorySnapshot = {
    schemaVersion: 2,
    revision:
      typeof value.revision === "string"
        ? value.revision
        : `revision-migrated-${value.generatedAt}`,
    platform,
    architecture:
      typeof value.architecture === "string" ? value.architecture : "unknown",
    generatedAt: finite(value.generatedAt) ?? 0,
    ...(finite(value.lastSuccessfulScanAt) !== undefined
      ? { lastSuccessfulScanAt: finite(value.lastSuccessfulScanAt) }
      : {}),
    completeness: value.completeness === "complete" ? "complete" : "partial",
    cached: Boolean(value.cached),
    products,
    installations,
    commands,
    endpoints,
    sourceResults: value.sourceResults.slice(0, 64).map((source) =>
      structuredClone(source),
    ),
  };
  finalizeHealth(normalized);
  return normalized;
}

function mergeInstallations(
  left: CliInstallation,
  right: CliInstallation,
  allEndpoints: CliExecutableEndpoint[],
): CliInstallation {
  const endpointIds = [...new Set([...left.endpointIds, ...right.endpointIds])];
  const endpoints = allEndpoints.filter((endpoint) =>
    endpointIds.includes(endpoint.id),
  );
  const preferredVersion = preferVersion(left, right);
  const presence = preferPresence(left.presence, right.presence);
  const merged: CliInstallation = {
    ...left,
    ...preferredVersion,
    endpointIds,
    presence,
    origin:
      left.origin === "unknown" ? right.origin : left.origin,
    issueCodes: [...new Set([...left.issueCodes, ...right.issueCodes])],
    firstSeenAt: Math.min(left.firstSeenAt, right.firstSeenAt),
    lastSeenAt: maxDefined(left.lastSeenAt, right.lastSeenAt),
    lastVerifiedAt: maxDefined(left.lastVerifiedAt, right.lastVerifiedAt),
    lastSuccessfulVerificationAt: maxDefined(
      left.lastSuccessfulVerificationAt,
      right.lastSuccessfulVerificationAt,
    ),
    fingerprint: createInstallationFingerprint({
      platform: left.platform,
      packageIdentity: left.packageIdentity ?? right.packageIdentity,
      endpoints,
    }),
    verificationStatus: preferVerification(
      left.verificationStatus,
      right.verificationStatus,
    ),
  };
  if (presence !== "missing") delete merged.missingSince;
  else merged.missingSince = minDefined(left.missingSince, right.missingSince);
  return merged;
}

function preferVersion(
  left: CliInstallation,
  right: CliInstallation,
): Pick<CliInstallation, "version" | "versionSource"> {
  const rank: CliVersionSource[] = [
    "package-metadata",
    "executable-metadata",
    "version-probe",
    "cached",
    "unknown",
  ];
  const preferred =
    rank.indexOf(left.versionSource) <= rank.indexOf(right.versionSource)
      ? left
      : right;
  return {
    ...(preferred.version ? { version: preferred.version } : {}),
    versionSource: preferred.versionSource,
  };
}

function preferPresence(left: CliPresence, right: CliPresence): CliPresence {
  const order: CliPresence[] = ["present", "inaccessible", "unknown", "missing"];
  return order.find((presence) => presence === left || presence === right) ?? "unknown";
}

function preferVerification(
  left: CliVerificationStatus,
  right: CliVerificationStatus,
): CliVerificationStatus {
  const order: CliVerificationStatus[] = [
    "verified",
    "partially-verified",
    "version-unverified",
    "ownership-unknown",
    "cached",
  ];
  return order.find((status) => status === left || status === right) ?? "cached";
}

function inferVerification(
  identity: CliPackageIdentity | undefined,
  version: string | undefined,
  versionSource: CliVersionSource,
  presence: CliPresence,
): CliVerificationStatus {
  if (presence === "missing" || versionSource === "cached") return "cached";
  if (identity?.ownershipConfidence === "exact" && version) return "verified";
  if (identity?.ownershipConfidence === "exact") return "version-unverified";
  if (identity) return "partially-verified";
  return "ownership-unknown";
}

function normalizePresence(value: unknown): CliPresence {
  return ["present", "missing", "inaccessible", "unknown"].includes(
    String(value),
  )
    ? (value as CliPresence)
    : "unknown";
}

function normalizeVersionSource(value: unknown): CliVersionSource {
  return [
    "package-metadata",
    "executable-metadata",
    "version-probe",
    "cached",
    "unknown",
  ].includes(String(value))
    ? (value as CliVersionSource)
    : "unknown";
}

function normalizeRuntimeHealth(
  value: unknown,
  presence: CliPresence,
): CliRuntimeHealth {
  if (presence === "missing") return "missing";
  return [
    "healthy",
    "broken",
    "missing",
    "inaccessible",
    "incomplete",
    "unknown",
  ].includes(String(value))
    ? (value as CliRuntimeHealth)
    : "unknown";
}

function normalizeScope(value: unknown): CliPackageIdentity["scope"] {
  return ["user", "machine", "system", "unknown"].includes(String(value))
    ? (value as CliPackageIdentity["scope"])
    : "unknown";
}

function isPackageIdentity(value: unknown): value is CliPackageIdentity {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as CliPackageIdentity).source === "string" &&
      typeof (value as CliPackageIdentity).packageId === "string" &&
      typeof (value as CliPackageIdentity).ownershipConfidence === "string",
  );
}

function dedupeEndpoints(value: unknown[]): CliExecutableEndpoint[] {
  const result = new Map<string, CliExecutableEndpoint>();
  for (const endpoint of value) {
    if (
      endpoint &&
      typeof endpoint === "object" &&
      typeof (endpoint as CliExecutableEndpoint).id === "string" &&
      typeof (endpoint as CliExecutableEndpoint).path === "string"
    ) {
      result.set(
        (endpoint as CliExecutableEndpoint).id,
        structuredClone(endpoint as CliExecutableEndpoint),
      );
    }
  }
  return [...result.values()];
}

function isInventoryShape(value: unknown): value is {
  revision?: unknown;
  platform: CliPlatform;
  architecture?: unknown;
  generatedAt?: unknown;
  lastSuccessfulScanAt?: unknown;
  completeness?: unknown;
  cached?: unknown;
  installations: Array<Partial<CliInstallation>>;
  commands: Array<Partial<CliCommand>>;
  endpoints: unknown[];
  sourceResults: CliInventorySnapshot["sourceResults"];
} {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    (input.platform === "win32" || input.platform === "darwin") &&
    Array.isArray(input.installations) &&
    Array.isArray(input.commands) &&
    Array.isArray(input.endpoints) &&
    Array.isArray(input.sourceResults)
  );
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isOrigin(value: unknown): value is CliInstallationOrigin {
  return typeof value === "string" && ORIGINS.has(value as CliInstallationOrigin);
}

function isVerificationStatus(
  value: unknown,
): value is CliVerificationStatus {
  return (
    typeof value === "string" &&
    VERIFICATION_STATUSES.has(value as CliVerificationStatus)
  );
}

function maxDefined(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function minDefined(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
