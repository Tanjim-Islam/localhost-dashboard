import {
  groupEquivalentEndpointKey,
  isWindowsExecutionAliasPath,
} from "./adapters/path";
import { getCliDefinition } from "./catalogue";
import { normalizeCliPath } from "./fingerprint";
import type {
  CliExecutableEndpoint,
  CliPackageIdentity,
  CliPackageRecord,
  CliPathEndpointRecord,
  CliScanEnvironment,
} from "./types";

export type MutableCliInstallation = {
  productId: string;
  packageIdentity?: CliPackageIdentity;
  endpoints: CliExecutableEndpoint[];
  commandNames: string[];
  binEntries: CliPackageRecord["binEntries"];
  version?: string;
  sourceId?: string;
  installationKey?: string;
};

export function matchInstallations(
  environment: CliScanEnvironment,
  pathRecords: CliPathEndpointRecord[],
  packageRecords: CliPackageRecord[],
): MutableCliInstallation[] {
  const mutableByPackage = new Map<string, MutableCliInstallation>();
  for (const record of packageRecords) {
    const key = packageRecordKey(record, environment.platform);
    const existing = mutableByPackage.get(key);
    if (existing) {
      existing.commandNames = [
        ...new Set([...existing.commandNames, ...record.commandNames]),
      ];
      existing.binEntries = dedupeBinEntries([
        ...existing.binEntries,
        ...record.binEntries,
      ], environment.platform);
      if (!getCliDefinition(record.productId)?.preferVersionProbe) {
        existing.version ??= record.version;
      }
      continue;
    }
    mutableByPackage.set(key, {
      productId: record.productId,
      packageIdentity: record.packageIdentity,
      endpoints: [],
      commandNames: [...record.commandNames],
      binEntries: [...record.binEntries],
      version: getCliDefinition(record.productId)?.preferVersionProbe
        ? undefined
        : record.version,
      sourceId: record.sourceId,
      installationKey: key,
    });
  }
  const mutable = [...mutableByPackage.values()];
  const unmatched = new Set(pathRecords);
  for (const installation of mutable) {
    const matches = [...unmatched].filter((record) =>
      endpointMatchesPackage(
        record,
        installation,
        environment.platform,
      ),
    );
    for (const match of matches) {
      installation.endpoints.push(match.endpoint);
      unmatched.delete(match);
    }
  }
  const pathGroups = new Map<string, CliPathEndpointRecord[]>();
  for (const record of unmatched) {
    if (
      environment.platform === "win32" &&
      isWindowsExecutionAliasPath(record.endpoint.path)
    ) {
      continue;
    }
    const key = groupEquivalentEndpointKey(record, environment.platform);
    const group = pathGroups.get(key) ?? [];
    group.push(record);
    pathGroups.set(key, group);
  }
  for (const records of pathGroups.values()) {
    mutable.push({
      productId: records[0].productId,
      endpoints: records.map((record) => record.endpoint),
      commandNames: [
        ...new Set(records.map((record) => record.endpoint.commandName)),
      ],
      binEntries: [],
      installationKey: groupEquivalentEndpointKey(
        records[0],
        environment.platform,
      ),
    });
  }
  return mutable.filter(
    (installation) =>
      installation.endpoints.length > 0 ||
      (installation.packageIdentity?.ownershipConfidence === "exact" &&
        (Boolean(installation.packageIdentity.installRoot) ||
          installation.binEntries.length > 0)),
  );
}

function endpointMatchesPackage(
  record: CliPathEndpointRecord,
  installation: MutableCliInstallation,
  platform: CliScanEnvironment["platform"],
): boolean {
  const identity = installation.packageIdentity;
  if (
    !identity ||
    record.productId !== installation.productId ||
    !installation.commandNames.some(
      (command) =>
        command.toLowerCase() === record.endpoint.commandName.toLowerCase(),
    )
  ) {
    return false;
  }
  const values = [
    record.endpoint.path,
    record.endpoint.canonicalPath,
    record.endpoint.shimPackageRoot,
    record.endpoint.shimTarget,
  ].filter((value): value is string => Boolean(value));
  const normalizedValues = values.map((value) =>
    normalizeCliPath(value, platform),
  );
  if (
    installation.binEntries.some((entry) =>
      normalizedValues.includes(normalizeCliPath(entry.targetPath, platform)),
    )
  ) {
    return true;
  }
  const roots = [identity.installRoot].filter(
    (value): value is string => Boolean(value),
  );
  if (
    roots.some((root) => {
      const normalizedRoot = normalizeCliPath(root, platform);
      return values.some((value) =>
        isSameOrWithin(
          normalizeCliPath(value, platform),
          normalizedRoot,
          platform,
        ),
      );
    })
  ) {
    return true;
  }
  if (identity.installRoot) {
    const nodeModulesMarker =
      platform === "win32" ? "\\node_modules\\" : "/node_modules/";
    const normalizedRoot = normalizeCliPath(identity.installRoot, platform);
    const markerIndex = normalizedRoot.lastIndexOf(nodeModulesMarker);
    if (markerIndex > 0) {
      const globalBinRoot = normalizedRoot.slice(0, markerIndex);
      if (
        normalizeCliPath(
          pathDirectory(record.endpoint.path, platform),
          platform,
        ) === globalBinRoot
      ) {
        return true;
      }
    }
  }
  if (
    identity.source === "winget" &&
    values.some((value) => value.toLowerCase().includes("windowsapps"))
  ) {
    return true;
  }
  return false;
}

function isSameOrWithin(
  value: string,
  root: string,
  platform: CliScanEnvironment["platform"],
): boolean {
  const separator = platform === "win32" ? "\\" : "/";
  return value === root || value.startsWith(`${root}${separator}`);
}

function packageRecordKey(
  record: CliPackageRecord,
  platform: CliScanEnvironment["platform"],
): string {
  const identity = record.packageIdentity;
  return [
    record.productId,
    identity.source,
    identity.packageId.toLowerCase(),
    identity.scope,
    normalizeOptional(identity.managerRoot, platform),
    normalizeOptional(identity.installRoot, platform),
  ].join("|");
}

function dedupeBinEntries(
  entries: CliPackageRecord["binEntries"],
  platform: CliScanEnvironment["platform"],
): CliPackageRecord["binEntries"] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.commandName.toLowerCase()}|${normalizeCliPath(entry.targetPath, platform)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeOptional(
  value: string | undefined,
  platform: CliScanEnvironment["platform"],
): string {
  return value ? normalizeCliPath(value, platform) : "";
}

function pathDirectory(
  value: string,
  platform: CliScanEnvironment["platform"],
): string {
  const separator = platform === "win32" ? "\\" : "/";
  const normalized = value.replaceAll(platform === "win32" ? "/" : "\\", separator);
  const index = normalized.lastIndexOf(separator);
  return index >= 0 ? normalized.slice(0, index) : normalized;
}
