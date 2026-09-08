import type {
  CliCategory,
  CliCommand,
  CliExecutableEndpoint,
  CliHealthStatus,
  CliInstallation,
  CliInventorySnapshot,
  CliPackageSource,
  CliProduct,
} from "../main/clis/types";

export type CliFilters = {
  query: string;
  category: CliCategory | "all";
  health: CliHealthStatus | "verified" | "all";
  source: CliPackageSource | "all";
  presence: "all" | "installed" | "embedded" | "candidates";
  duplicatesOnly: boolean;
};

export type CliSummary = {
  installed: number;
  aiCoding: number;
  duplicates: number;
  broken: number;
};

export const CLI_CATEGORY_LABELS: Record<CliCategory, string> = {
  "ai-coding": "AI coding",
  runtime: "Runtime",
  "package-manager": "Package manager",
  "build-tool": "Build tool",
  cloud: "Cloud and deployment",
  infrastructure: "Infrastructure",
  database: "Database",
  "developer-tool": "Developer tool",
  "other-development": "Other development",
};

export const CLI_SOURCE_LABELS: Record<CliPackageSource, string> = {
  npm: "npm",
  pnpm: "pnpm",
  "yarn-classic": "Yarn Classic",
  bun: "Bun",
  pipx: "pipx",
  pip: "Python package",
  uv: "uv",
  cargo: "Cargo",
  winget: "Winget",
  chocolatey: "Chocolatey",
  scoop: "Scoop",
  "homebrew-formula": "Homebrew formula",
  "homebrew-cask": "Homebrew cask",
  macports: "MacPorts",
  "appx-alias": "WindowsApps alias",
  registry: "Windows installer",
  standalone: "Detected executable",
  unknown: "Source not identified",
};

export function formatCliInstallationSource(
  installation: CliInstallation,
  endpoints: CliExecutableEndpoint[],
): string {
  if (
    endpoints.some((endpoint) => endpoint.bundledWith === "strawberry-perl")
  ) {
    return "Bundled with Strawberry Perl";
  }
  if (installation.origin === "application-embedded")
    return "Bundled with an app";
  if (installation.origin === "sdk-bundled") return "Bundled with an SDK";
  if (!installation.packageIdentity) {
    return (
      endpoints.find((endpoint) => endpoint.ownerName)?.ownerName ??
      (endpoints.find((endpoint) => endpoint.publisher)?.publisher
        ? `Publisher: ${endpoints.find((endpoint) => endpoint.publisher)!.publisher}`
        : "Detected executable")
    );
  }
  const identity = installation.packageIdentity;
  return identity.source === "unknown" && identity.sourceName
    ? identity.sourceName
    : CLI_SOURCE_LABELS[identity.source];
}

export const CLI_NEW_BADGE_MS = 24 * 60 * 60 * 1000;

export function isCliCommandVerified(
  installation: CliInstallation,
  inventory: CliInventorySnapshot,
): boolean {
  const verification = installation.commandVerification;
  return (
    installation.health === "healthy" &&
    Boolean(
      verification &&
      inventory.endpoints.some(
        (endpoint) =>
          installation.endpointIds.includes(endpoint.id) &&
          endpoint.id === verification.endpointId &&
          endpoint.fingerprint === verification.endpointFingerprint &&
          endpoint.targetExists &&
          endpoint.accessible,
      ),
    )
  );
}

export function formatCliHealth(
  installation: CliInstallation,
  inventory: CliInventorySnapshot,
): string | undefined {
  if (installation.discoveryKind === "candidate") return "Discovered";
  if (installation.health === "healthy")
    return isCliCommandVerified(installation, inventory)
      ? "Verified"
      : "Installed";
  return undefined;
}

export function getPrimaryCliCommand(
  product: CliProduct | undefined,
  commands: CliCommand[],
): CliCommand | undefined {
  const names = [product?.id, product?.displayName, ...(product?.aliases ?? [])]
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLowerCase());
  const preferred = commands.find(
    (command) =>
      names.includes(command.name.toLowerCase()) &&
      command.pathRole === "active",
  );
  return (
    preferred ??
    commands.find((command) => command.pathRole === "active") ??
    commands.find((command) => names.includes(command.name.toLowerCase())) ??
    commands[0]
  );
}

export function isNewCliProduct(
  inventory: CliInventorySnapshot,
  product: CliProduct,
  now: number,
): boolean {
  const timestamps = inventory.installations
    .filter((item) => product.installationIds.includes(item.id))
    .map((item) => item.firstSeenAt);
  const firstSeen = Math.min(...timestamps);
  return (
    Number.isFinite(firstSeen) &&
    firstSeen <= now &&
    now - firstSeen < CLI_NEW_BADGE_MS
  );
}

export function formatCliInstallationDetails(
  installation: CliInstallation,
): string {
  const scope = {
    user: "Current user",
    machine: "All users",
    system: "System",
    unknown: undefined,
  }[installation.scope];
  return [
    installation.platform === "win32" ? "Windows" : "macOS",
    installation.architecture !== "unknown"
      ? installation.architecture
      : undefined,
    scope,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function formatCliVersionDescription(
  installation: CliInstallation,
): string {
  const source = installation.packageIdentity?.source;
  switch (installation.versionSource) {
    case "package-metadata":
      return source && source !== "unknown" && source !== "standalone"
        ? `Version reported by the installed ${CLI_SOURCE_LABELS[source]} package.`
        : "Version reported by the installed package.";
    case "version-probe":
      return "Version reported by the command.";
    case "executable-metadata":
      return "Version read from the installed files.";
    case "cached":
      return "Version saved from an earlier scan.";
    default:
      return "The version has not been detected.";
  }
}

export function summarizeCliInventory(
  inventory: CliInventorySnapshot | null,
): CliSummary {
  if (!inventory) {
    return { installed: 0, aiCoding: 0, duplicates: 0, broken: 0 };
  }
  const installed = inventory.products.filter(
    (product) => product.currentInstallationIds.length > 0,
  );
  return {
    installed: installed.length,
    aiCoding: installed.filter((product) => product.category === "ai-coding")
      .length,
    duplicates: installed.filter(isDuplicateProduct).length,
    broken: installed.filter((product) => product.health === "broken").length,
  };
}

export function filterCliProducts(
  inventory: CliInventorySnapshot | null,
  filters: CliFilters,
): CliProduct[] {
  if (!inventory) return [];
  const query = filters.query.trim().toLowerCase();
  return inventory.products.filter((product) => {
    const installations = getVisibleCliInstallations(
      inventory,
      product,
      filters.presence,
    );
    if (installations.length === 0) return false;
    if (filters.category !== "all" && product.category !== filters.category) {
      return false;
    }
    if (
      filters.health === "verified"
        ? !installations.every((item) => isCliCommandVerified(item, inventory))
        : filters.health !== "all" && product.health !== filters.health
    ) {
      return false;
    }
    if (filters.duplicatesOnly && !isDuplicateProduct(product)) return false;
    if (
      filters.source !== "all" &&
      !installations.some(
        (installation) =>
          (installation.packageIdentity?.source ?? "standalone") ===
          filters.source,
      )
    ) {
      return false;
    }
    if (!query) return true;
    const endpoints = inventory.endpoints.filter((endpoint) =>
      installations.some((installation) =>
        installation.endpointIds.includes(endpoint.id),
      ),
    );
    const commands = inventory.commands.filter((command) =>
      installations.some(
        (installation) => installation.id === command.installationId,
      ),
    );
    return [
      product.displayName,
      ...product.aliases,
      ...commands.map((command) => command.name),
      ...endpoints.flatMap((endpoint) => [
        endpoint.path,
        endpoint.canonicalPath ?? "",
      ]),
      ...installations.map(
        (installation) => installation.packageIdentity?.packageId ?? "",
      ),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function isDuplicateProduct(product: CliProduct): boolean {
  return product.issueCodes.some((issue) =>
    ["duplicate-version", "path-conflict"].includes(issue),
  );
}

export function getVisibleCliInstallations(
  inventory: CliInventorySnapshot,
  product: CliProduct,
  presence: CliFilters["presence"],
): CliInstallation[] {
  const ids =
    presence === "installed"
      ? product.currentInstallationIds
      : presence === "embedded"
        ? product.embeddedInstallationIds
        : presence === "candidates"
          ? (product.candidateInstallationIds ?? [])
          : [
              ...product.currentInstallationIds,
              ...product.embeddedInstallationIds,
            ];
  const idSet = new Set(ids);
  return inventory.installations.filter((installation) =>
    idSet.has(installation.id),
  );
}

export function formatCliAge(timestamp?: number): string {
  if (!timestamp) return "Not verified";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
