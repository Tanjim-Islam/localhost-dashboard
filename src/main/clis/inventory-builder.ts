import { getCliDefinition } from "./catalogue";
import {
  groupEquivalentEndpointKey,
  isWindowsExecutionAliasPath,
} from "./adapters/path";
import {
  createInstallationFingerprint,
  createInstallationId,
  stableCliId,
} from "./fingerprint";
import type { MutableCliInstallation } from "./installation-matcher";
import type {
  CliCommand,
  CliExecutableEndpoint,
  CliInstallation,
  CliInventorySnapshot,
  CliIssueCode,
  CliPathEndpointRecord,
  CliProduct,
  CliRuntimeHealth,
  CliScanEnvironment,
  CliVerificationStatus,
} from "./types";
import { calculateUninstallCapability } from "./uninstall-policy";
import { classifyCliOrigin, isEmbeddedCliOrigin } from "./origin";

const MISSING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function assembleInventory(input: {
  environment: CliScanEnvironment;
  mutable: MutableCliInstallation[];
  previous: CliInventorySnapshot | null;
  failedSourceIds: Set<string>;
  now: number;
}): Pick<
  CliInventorySnapshot,
  "products" | "installations" | "commands" | "endpoints"
> {
  const endpoints: CliExecutableEndpoint[] = [];
  const installations: CliInstallation[] = [];
  const commands: CliCommand[] = [];
  const previousById = new Map(
    (input.previous?.installations ?? []).map((item) => [item.id, item]),
  );

  for (const record of input.mutable) {
    const canonicalPath =
      record.endpoints[0]?.canonicalPath ?? record.endpoints[0]?.path;
    const installationId = createInstallationId({
      platform: input.environment.platform,
      productId: record.productId,
      packageIdentity: record.packageIdentity,
      canonicalPath,
      installationRoot: record.packageIdentity?.installRoot,
      standaloneIdentity: record.installationKey,
    });
    const uniqueEndpoints = dedupeEndpoints(record.endpoints);
    endpoints.push(...uniqueEndpoints);
    const fingerprint = createInstallationFingerprint({
      platform: input.environment.platform,
      packageIdentity: record.packageIdentity,
      endpoints: uniqueEndpoints,
    });
    const previous = previousById.get(installationId);
    const definition = getCliDefinition(record.productId);
    const canReusePreviousVersion =
      previous?.fingerprint === fingerprint &&
      Boolean(previous.version) &&
      !(
        definition?.preferVersionProbe &&
        ["package-metadata", "cached"].includes(previous.versionSource)
      );
    const version =
      record.version ??
      (canReusePreviousVersion ? previous?.version : undefined);
    const versionSource = record.version
      ? "package-metadata"
      : canReusePreviousVersion
        ? "cached"
        : "unknown";
    const issueCodes = collectEndpointIssues(uniqueEndpoints);
    if (!version) issueCodes.push("version-unverified");
    const commandNames = [
      ...new Set([
        ...record.commandNames,
        ...uniqueEndpoints.map((endpoint) => endpoint.commandName),
      ]),
    ];
    const commandIds = commandNames.map((name) =>
      stableCliId("command", { installationId, name }),
    );
    const origin = classifyCliOrigin({
      platform: input.environment.platform,
      productId: record.productId,
      packageIdentity: record.packageIdentity,
      endpoints: uniqueEndpoints,
      homeDirectory: input.environment.homeDirectory,
    });
    const capability = calculateUninstallCapability({
      definition,
      identity: record.packageIdentity,
      commands: commandNames,
      presence: "present",
      sourceFailed: false,
      origin,
    });
    const hasUsableEndpoint = uniqueEndpoints.some(isUsableEndpoint);
    const presence =
      uniqueEndpoints.length > 0 &&
      !uniqueEndpoints.some((endpoint) => endpoint.accessible)
        ? "inaccessible"
        : "present";
    installations.push({
      id: installationId,
      productId: record.productId,
      platform: input.environment.platform,
      architecture: input.environment.architecture,
      scope: record.packageIdentity?.scope ?? "unknown",
      origin,
      version,
      versionSource,
      verificationStatus: deriveVerificationStatus({
        packageIdentity: record.packageIdentity,
        version,
        versionSource,
        presence,
      }),
      packageIdentity: record.packageIdentity,
      endpointIds: uniqueEndpoints.map((endpoint) => endpoint.id),
      commandIds,
      fingerprint,
      presence,
      health: "unknown",
      issueCodes: [...new Set(issueCodes)],
      firstSeenAt: previous?.firstSeenAt ?? input.now,
      lastSeenAt: input.now,
      lastVerifiedAt: input.now,
      lastSuccessfulVerificationAt:
        hasUsableEndpoint
          ? input.now
          : previous?.lastSuccessfulVerificationAt,
      uninstallCapability: capability,
    });
  }

  addRetainedMissingInstallations({
    input,
    installations,
    commands,
    endpoints,
  });
  assignCommandResolution(installations, commands, endpoints);
  return {
    products: buildProducts(
      input.environment.platform,
      installations,
      commands,
    ),
    installations,
    commands,
    endpoints,
  };
}

function addRetainedMissingInstallations(input: {
  input: {
    environment: CliScanEnvironment;
    previous: CliInventorySnapshot | null;
    failedSourceIds: Set<string>;
    now: number;
  };
  installations: CliInstallation[];
  commands: CliCommand[];
  endpoints: CliExecutableEndpoint[];
}): void {
  const currentIds = new Set(input.installations.map((item) => item.id));
  const currentEndpointGroups = new Set(
    input.installations.flatMap((installation) =>
      input.endpoints
        .filter((endpoint) => installation.endpointIds.includes(endpoint.id))
        .map((endpoint) =>
          groupEquivalentEndpointKey(
            { productId: installation.productId, endpoint },
            input.input.environment.platform,
          ),
        ),
    ),
  );
  for (const previous of input.input.previous?.installations ?? []) {
    if (currentIds.has(previous.id)) continue;
    const previousEndpoints = (input.input.previous?.endpoints ?? []).filter(
      (endpoint) => previous.endpointIds.includes(endpoint.id),
    );
    if (
      previousEndpoints.length === 0 &&
      previous.packageIdentity &&
      !previous.packageIdentity.installRoot
    ) {
      continue;
    }
    if (
      input.input.environment.platform === "win32" &&
      !previous.packageIdentity &&
      previousEndpoints.length > 0 &&
      previousEndpoints.every((endpoint) =>
        isWindowsExecutionAliasPath(endpoint.path),
      )
    ) {
      continue;
    }
    if (
      previousEndpoints.some((endpoint) =>
        currentEndpointGroups.has(
          groupEquivalentEndpointKey(
            { productId: previous.productId, endpoint },
            input.input.environment.platform,
          ),
        ),
      )
    ) {
      continue;
    }
    const source = previous.packageIdentity?.source;
    const sourceFailed =
      source !== undefined &&
      [...input.input.failedSourceIds].some((sourceId) =>
        sourceIdMatchesPackageSource(sourceId, source),
      );
    const missingSince = previous.missingSince ?? input.input.now;
    if (!sourceFailed && input.input.now - missingSince > MISSING_RETENTION_MS) {
      continue;
    }
    const retained: CliInstallation = {
      ...structuredClone(previous),
      presence: sourceFailed ? "unknown" : "missing",
      health: sourceFailed ? "unknown" : "missing",
      issueCodes: [
        ...new Set([
          ...previous.issueCodes.filter(
            (issue) =>
              issue !== "duplicate-version" &&
              issue !== "path-conflict" &&
              issue !== "shadowed" &&
              issue !== "cached-missing" &&
              issue !== "package-source-unavailable",
          ),
          sourceFailed ? "package-source-unavailable" : "cached-missing",
        ]),
      ] as CliIssueCode[],
      versionSource: previous.version ? "cached" : "unknown",
      verificationStatus: "cached",
      missingSince,
      uninstallCapability: calculateUninstallCapability({
        definition: getCliDefinition(previous.productId),
        identity: previous.packageIdentity,
        commands: previous.uninstallCapability.providedCommands,
        presence: sourceFailed ? "unknown" : "missing",
        sourceFailed,
        origin: previous.origin,
      }),
    };
    input.installations.push(retained);
    input.commands.push(
      ...(input.input.previous?.commands ?? [])
        .filter((command) => command.installationId === previous.id)
        .map((command) => ({
          ...structuredClone(command),
          activeEndpointId: undefined,
          pathRole: "not-on-path" as const,
        })),
    );
    input.endpoints.push(
      ...previousEndpoints,
    );
  }
}

export function assignCommandResolution(
  installations: CliInstallation[],
  commands: CliCommand[],
  endpoints: CliExecutableEndpoint[],
): void {
  commands.splice(0, commands.length);
  const activeByName = new Map<string, string>();
  const currentEndpointIds = new Set(
    installations
      .filter(isCurrentInstallation)
      .flatMap((installation) => installation.endpointIds),
  );
  for (const endpoint of endpoints
    .filter(
      (candidate) =>
        currentEndpointIds.has(candidate.id) &&
        candidate.pathIndex !== undefined,
    )
    .sort(compareEndpoints)) {
    if (!activeByName.has(endpoint.commandName)) {
      activeByName.set(endpoint.commandName, endpoint.id);
    }
  }
  for (const installation of installations) {
    const installEndpoints = endpoints.filter((endpoint) =>
      installation.endpointIds.includes(endpoint.id),
    );
    const names = [
      ...new Set([
        ...installation.uninstallCapability.providedCommands,
        ...installEndpoints.map((endpoint) => endpoint.commandName),
      ]),
    ];
    installation.commandIds = [];
    for (const name of names) {
      const endpointIds = installEndpoints
        .filter((endpoint) => endpoint.commandName === name)
        .map((endpoint) => endpoint.id);
      const pathEndpointIds = installEndpoints
        .filter(
          (endpoint) =>
            endpoint.commandName === name &&
            endpoint.pathIndex !== undefined,
        )
        .map((endpoint) => endpoint.id);
      const activeEndpointId = activeByName.get(name);
      const pathRole =
        pathEndpointIds.length === 0
          ? "not-on-path"
          : activeEndpointId && pathEndpointIds.includes(activeEndpointId)
            ? "active"
            : "shadowed";
      const id = stableCliId("command", {
        installationId: installation.id,
        name,
      });
      commands.push({
        id,
        productId: installation.productId,
        installationId: installation.id,
        name,
        endpointIds,
        ...(activeEndpointId ? { activeEndpointId } : {}),
        pathRole,
      });
      installation.commandIds.push(id);
      if (pathRole === "shadowed" && isCurrentInstallation(installation)) {
        installation.issueCodes.push("shadowed");
      }
    }
    installation.issueCodes = [...new Set(installation.issueCodes)];
  }
}

export function finalizeHealth(
  assembled: Pick<
    CliInventorySnapshot,
    "products" | "installations" | "commands" | "endpoints"
  >,
): void {
  for (const installation of assembled.installations) {
    installation.issueCodes = installation.issueCodes.filter(
      (issue) =>
        issue !== "path-conflict" && issue !== "duplicate-version",
    );
    installation.health = deriveRuntimeHealth(
      installation,
      assembled.commands,
      assembled.endpoints,
    );
    installation.verificationStatus = deriveVerificationStatus(installation);
  }

  const commandsByName = new Map<string, CliCommand[]>();
  for (const command of assembled.commands) {
    if (command.pathRole === "not-on-path") continue;
    const installation = assembled.installations.find(
      (candidate) => candidate.id === command.installationId,
    );
    if (!installation || !isCurrentInstallation(installation)) continue;
    const records = commandsByName.get(command.name) ?? [];
    records.push(command);
    commandsByName.set(command.name, records);
  }
  for (const records of commandsByName.values()) {
    const distinct = new Map<string, CliCommand>();
    for (const command of records) {
      const installation = assembled.installations.find(
        (candidate) => candidate.id === command.installationId,
      );
      if (!installation) continue;
      distinct.set(
        meaningfulInstallationKey(
          installation,
          assembled.endpoints,
        ),
        command,
      );
    }
    const commands = [...distinct.values()];
    const installations = commands
      .map((command) =>
        assembled.installations.find(
          (candidate) => candidate.id === command.installationId,
        ),
      )
      .filter((value): value is CliInstallation => Boolean(value));
    const activeEmbedded = installations.some(
      (installation, index) =>
        isEmbeddedCliOrigin(installation.origin) &&
        commands[index]?.pathRole === "active",
    );
    const normalCount = installations.filter(
      (installation) => !isEmbeddedCliOrigin(installation.origin),
    ).length;
    if (
      installations.length > 1 &&
      commands.some((command) => command.pathRole === "active") &&
      commands.some((command) => command.pathRole === "shadowed") &&
      (normalCount > 1 || activeEmbedded)
    ) {
      for (const installation of installations) {
        installation.issueCodes.push("path-conflict");
      }
    }
  }

  const currentByProduct = new Map<string, CliInstallation[]>();
  for (const installation of assembled.installations) {
    if (
      isCurrentInstallation(installation) &&
      !isEmbeddedCliOrigin(installation.origin)
    ) {
      const current =
        currentByProduct.get(installation.productId) ?? [];
      current.push(installation);
      currentByProduct.set(installation.productId, current);
    }
  }
  for (const installations of currentByProduct.values()) {
    const versions = new Map<string, CliInstallation[]>();
    for (const installation of installations) {
      const version = installation.version?.trim().toLowerCase();
      if (!version) continue;
      const matching = versions.get(version) ?? [];
      matching.push(installation);
      versions.set(version, matching);
    }
    for (const matching of versions.values()) {
      const distinctKeys = new Set(
        matching.map((installation) =>
          meaningfulInstallationKey(installation, assembled.endpoints),
        ),
      );
      if (distinctKeys.size < 2) continue;
      for (const installation of matching) {
        installation.issueCodes.push("duplicate-version");
      }
    }
  }
  for (const installation of assembled.installations) {
    installation.issueCodes = [...new Set(installation.issueCodes)];
  }

  assembled.products.splice(
    0,
    assembled.products.length,
    ...buildProducts(
      assembled.installations[0]?.platform ?? "win32",
      assembled.installations,
      assembled.commands,
    ),
  );
  for (const product of assembled.products) {
    const installations = assembled.installations.filter((candidate) =>
      product.installationIds.includes(candidate.id),
    );
    const current = installations.filter(
      (installation) =>
        isCurrentInstallation(installation) &&
        !isEmbeddedCliOrigin(installation.origin),
    );
    product.issueCodes = [
      ...new Set(current.flatMap((item) => item.issueCodes)),
    ];
    product.health = deriveProductStatus(
      current,
      assembled.commands,
      product.issueCodes,
      product.removedInstallationIds.length > 0,
    );
    product.verificationStatus = deriveProductVerification(current);
  }
}

export function buildProducts(
  platform: CliScanEnvironment["platform"],
  installations: CliInstallation[],
  commands: CliCommand[],
): CliProduct[] {
  const productIds = [
    ...new Set(installations.map((installation) => installation.productId)),
  ];
  const products: CliProduct[] = [];
  for (const productId of productIds) {
    const definition = getCliDefinition(productId);
    if (!definition) continue;
    const supportedPlatforms = [
      ...(definition.platforms ?? ["win32", "darwin"]),
    ];
    if (!supportedPlatforms.includes(platform)) continue;
    const productInstallations = installations.filter(
      (installation) => installation.productId === productId,
    );
    const productCommands = commands.filter(
      (command) => command.productId === productId,
    );
    const currentInstallationIds = productInstallations
      .filter(
        (installation) =>
          isCurrentInstallation(installation) &&
          !isEmbeddedCliOrigin(installation.origin),
      )
      .map((installation) => installation.id);
    const removedInstallationIds = productInstallations
      .filter((installation) => installation.presence === "missing")
      .map((installation) => installation.id);
    const embeddedInstallationIds = productInstallations
      .filter(
        (installation) =>
          isCurrentInstallation(installation) &&
          isEmbeddedCliOrigin(installation.origin),
      )
      .map((installation) => installation.id);
    products.push({
      id: definition.id,
      displayName: definition.displayName,
      category: definition.category,
      aliases: [...(definition.aliases ?? [])],
      commandNames: [...new Set(productCommands.map((command) => command.name))],
      supportedPlatforms,
      discoveryConfidence: "catalogued",
      installationIds: [
        ...new Set(productInstallations.map((installation) => installation.id)),
      ],
      currentInstallationIds: [...new Set(currentInstallationIds)],
      removedInstallationIds: [...new Set(removedInstallationIds)],
      embeddedInstallationIds: [...new Set(embeddedInstallationIds)],
      health: deriveProductStatus(
        productInstallations.filter((installation) =>
          currentInstallationIds.includes(installation.id),
        ),
        commands,
        [],
        removedInstallationIds.length > 0,
      ),
      verificationStatus: deriveProductVerification(
        productInstallations.filter((installation) =>
          currentInstallationIds.includes(installation.id),
        ),
      ),
      issueCodes: [
        ...new Set(
          productInstallations.flatMap(
            (installation) =>
              currentInstallationIds.includes(installation.id)
                ? installation.issueCodes
                : [],
          ),
        ),
      ],
    });
  }
  return products.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function collectEndpointIssues(
  endpoints: CliExecutableEndpoint[],
): CliInstallation["issueCodes"] {
  const issues: CliInstallation["issueCodes"] = [];
  const byCommand = new Map<string, CliExecutableEndpoint[]>();
  for (const endpoint of endpoints) {
    const commandEndpoints = byCommand.get(endpoint.commandName) ?? [];
    commandEndpoints.push(endpoint);
    byCommand.set(endpoint.commandName, commandEndpoints);
  }
  for (const commandEndpoints of byCommand.values()) {
    if (commandEndpoints.some(isUsableEndpoint)) continue;
    for (const endpoint of commandEndpoints) {
      if (!endpoint.targetExists) {
        issues.push(endpoint.kind === "shim" ? "broken-shim" : "missing-target");
      }
      if (!endpoint.accessible || !endpoint.executable) {
        issues.push("inaccessible");
      }
    }
  }
  return [...new Set(issues)];
}

function dedupeEndpoints(
  endpoints: CliExecutableEndpoint[],
): CliExecutableEndpoint[] {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = endpoint.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compareEndpoints(
  left: CliExecutableEndpoint,
  right: CliExecutableEndpoint,
): number {
  return (
    (left.pathIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.pathIndex ?? Number.MAX_SAFE_INTEGER) ||
    (left.pathextIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.pathextIndex ?? Number.MAX_SAFE_INTEGER) ||
    left.path.localeCompare(right.path)
  );
}

export function indexEndpoints(
  records: CliPathEndpointRecord[],
): Map<string, CliExecutableEndpoint[]> {
  const result = new Map<string, CliExecutableEndpoint[]>();
  for (const record of records) {
    const endpoints = result.get(record.productId) ?? [];
    endpoints.push(record.endpoint);
    result.set(record.productId, endpoints);
  }
  return result;
}

function deriveRuntimeHealth(
  installation: CliInstallation,
  commands: CliCommand[],
  endpoints: CliExecutableEndpoint[],
): CliRuntimeHealth {
  if (installation.presence === "missing") return "missing";
  if (installation.presence === "inaccessible") return "inaccessible";
  if (installation.issueCodes.includes("incomplete-installation")) {
    return "incomplete";
  }
  const installEndpoints = endpoints.filter((endpoint) =>
    installation.endpointIds.includes(endpoint.id),
  );
  const activeEndpointIds = new Set(
    commands
      .filter(
        (command) =>
          command.installationId === installation.id &&
          command.pathRole === "active" &&
          command.activeEndpointId,
      )
      .map((command) => command.activeEndpointId as string),
  );
  const activeEndpoints = installEndpoints.filter((endpoint) =>
    activeEndpointIds.has(endpoint.id),
  );
  const activeWithoutEquivalent = activeEndpoints.filter(
    (activeEndpoint) =>
      !installEndpoints.some(
        (candidate) =>
          candidate.commandName === activeEndpoint.commandName &&
          candidate.id !== activeEndpoint.id &&
          isUsableEndpoint(candidate),
      ),
  );
  if (activeWithoutEquivalent.some((endpoint) => !endpoint.targetExists)) {
    return "broken";
  }
  if (
    activeWithoutEquivalent.some(
      (endpoint) => !endpoint.accessible || !endpoint.executable,
    )
  ) {
    return "inaccessible";
  }
  if (installEndpoints.some(isUsableEndpoint)) return "healthy";
  if (installEndpoints.length > 0) return "broken";
  return "unknown";
}

function deriveVerificationStatus(input: {
  packageIdentity?: CliInstallation["packageIdentity"];
  version?: string;
  versionSource: CliInstallation["versionSource"];
  presence: CliInstallation["presence"];
}): CliVerificationStatus {
  if (input.presence === "missing" || input.versionSource === "cached") {
    return "cached";
  }
  const exactOwnership =
    input.packageIdentity?.ownershipConfidence === "exact";
  const verifiedVersion =
    Boolean(input.version) &&
    ["package-metadata", "executable-metadata", "version-probe"].includes(
      input.versionSource,
    );
  if (exactOwnership && verifiedVersion) return "verified";
  if (exactOwnership && !verifiedVersion) return "version-unverified";
  if (input.packageIdentity) return "partially-verified";
  if (verifiedVersion) return "ownership-unknown";
  return "ownership-unknown";
}

function deriveProductVerification(
  installations: CliInstallation[],
): CliVerificationStatus {
  const statuses = new Set(
    installations.map((installation) => installation.verificationStatus),
  );
  if (statuses.size === 1 && statuses.has("verified")) return "verified";
  if (statuses.has("ownership-unknown")) return "ownership-unknown";
  if (statuses.has("version-unverified")) return "version-unverified";
  if (statuses.has("partially-verified")) return "partially-verified";
  if (statuses.has("cached") && statuses.has("verified")) {
    return "partially-verified";
  }
  if (statuses.has("cached")) return "cached";
  return "partially-verified";
}

function deriveProductStatus(
  current: CliInstallation[],
  commands: CliCommand[],
  issueCodes: CliIssueCode[],
  hasRemoved: boolean,
): CliProduct["health"] {
  if (current.length === 0) return hasRemoved ? "missing" : "unknown";
  const activeIds = new Set(
    commands
      .filter((command) => command.pathRole === "active")
      .map((command) => command.installationId),
  );
  const assessed = current.some((installation) => activeIds.has(installation.id))
    ? current.filter((installation) => activeIds.has(installation.id))
    : current;
  const hasUsable = current.some(
    (installation) => installation.health === "healthy",
  );
  if (!hasUsable) {
    if (assessed.every((installation) => installation.health === "unknown")) {
      return "unverified";
    }
    if (
      assessed.some((installation) => installation.health === "incomplete") &&
      assessed.every((installation) =>
        ["incomplete", "unknown"].includes(installation.health),
      )
    ) {
      return "warning";
    }
    return "broken";
  }
  if (
    issueCodes.includes("path-conflict") ||
    assessed.some((installation) =>
      ["broken", "inaccessible", "incomplete"].includes(
        installation.health,
      ),
    )
  ) {
    return "warning";
  }
  return "healthy";
}

function meaningfulInstallationKey(
  installation: CliInstallation,
  endpoints: CliExecutableEndpoint[],
): string {
  const identity = installation.packageIdentity;
  if (identity) {
    return [
      installation.productId,
      identity.source,
      identity.packageId.toLowerCase(),
      identity.scope,
      identity.managerRoot ?? "",
      identity.installRoot ?? "",
    ].join("|");
  }
  const keys = endpoints
    .filter((endpoint) => installation.endpointIds.includes(endpoint.id))
    .map((endpoint) =>
      groupEquivalentEndpointKey(
        { productId: installation.productId, endpoint },
        installation.platform,
      ),
    )
    .sort();
  return keys[0] ?? installation.id;
}

function isCurrentInstallation(installation: CliInstallation): boolean {
  return (
    installation.presence === "present" ||
    installation.presence === "inaccessible"
  );
}

function isUsableEndpoint(endpoint: CliExecutableEndpoint): boolean {
  return endpoint.targetExists && endpoint.accessible && endpoint.executable;
}

function sourceIdMatchesPackageSource(
  sourceId: string,
  source: NonNullable<CliInstallation["packageIdentity"]>["source"],
): boolean {
  const sourcePrefix = sourceId.split("|", 1)[0];
  let expected: string = source;
  if (source === "yarn-classic") expected = "yarn";
  else if (source === "registry") expected = "windows-registry";
  else if (
    source === "homebrew-formula" ||
    source === "homebrew-cask"
  ) {
    expected = "homebrew";
  }
  return sourcePrefix === expected;
}
