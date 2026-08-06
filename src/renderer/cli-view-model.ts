import type {
  CliCategory,
  CliHealthStatus,
  CliInstallation,
  CliInventorySnapshot,
  CliPackageSource,
  CliProduct,
} from "../main/clis/types";

export type CliFilters = {
  query: string;
  category: CliCategory | "all";
  health: CliHealthStatus | "all";
  source: CliPackageSource | "all";
  presence: "all" | "installed" | "embedded";
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
  cargo: "Cargo",
  winget: "Winget",
  chocolatey: "Chocolatey",
  scoop: "Scoop",
  "homebrew-formula": "Homebrew formula",
  "homebrew-cask": "Homebrew cask",
  macports: "MacPorts",
  "appx-alias": "WindowsApps alias",
  registry: "Windows registry",
  standalone: "Standalone",
  unknown: "Unknown",
};

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
    if (filters.health !== "all" && product.health !== filters.health) {
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
