import type {
  CliPersistence,
  CliStoreSchema,
  CliScanAttemptSummary,
  CliUninstallAuditSummary,
} from "./types";
import { normalizeCliInventory } from "./inventory-normalizer";
import { normalizeScanDirectories } from "./scan-directories";

export const MAX_CLI_SCAN_ATTEMPTS = 20;
export const MAX_CLI_UNINSTALL_AUDITS = 100;
export const MAX_CLI_PRODUCTS = 5_000;
export const MAX_CLI_INSTALLATIONS = 10_000;

export const DEFAULT_CLI_STORE: CliStoreSchema = {
  schemaVersion: 2,
  scanDirectories: [],
  inventory: null,
  comparisonBaseline: null,
  lastScanStartedAt: null,
  lastCompletedScanAt: null,
  lastSuccessfulScanAt: null,
  lastScanStatus: "idle",
  scanAttempts: [],
  uninstallAudits: [],
};

export class MemoryCliPersistence implements CliPersistence {
  constructor(
    private state: CliStoreSchema = structuredClone(DEFAULT_CLI_STORE),
  ) {}

  read(): CliStoreSchema {
    return structuredClone(this.state);
  }

  write(next: CliStoreSchema): void {
    this.state = boundCliStore(migrateCliStore(next));
  }
}

export function migrateCliStore(value: unknown): CliStoreSchema {
  if (!value || typeof value !== "object") {
    return structuredClone(DEFAULT_CLI_STORE);
  }
  const input = value as Partial<CliStoreSchema>;
  const inventory = normalizeCliInventory(input.inventory);
  return boundCliStore({
    schemaVersion: 2,
    scanDirectories: normalizeScanDirectories(input.scanDirectories),
    inventory,
    comparisonBaseline:
      normalizeCliInventory(input.comparisonBaseline) ??
      (inventory?.completeness === "complete" ? inventory : null),
    lastScanStartedAt: finiteOrNull(input.lastScanStartedAt),
    lastCompletedScanAt: finiteOrNull(input.lastCompletedScanAt),
    lastSuccessfulScanAt: finiteOrNull(input.lastSuccessfulScanAt),
    lastScanStatus: isScanStatus(input.lastScanStatus)
      ? input.lastScanStatus
      : "idle",
    scanAttempts: isArray<CliScanAttemptSummary>(input.scanAttempts)
      ? structuredClone(input.scanAttempts)
      : [],
    uninstallAudits: isArray<CliUninstallAuditSummary>(input.uninstallAudits)
      ? structuredClone(input.uninstallAudits)
      : [],
  });
}

export function boundCliStore(next: CliStoreSchema): CliStoreSchema {
  const bounded = structuredClone(next);
  bounded.scanAttempts = bounded.scanAttempts
    .filter((attempt) => attempt && typeof attempt.scanSessionId === "string")
    .slice(0, MAX_CLI_SCAN_ATTEMPTS);
  bounded.uninstallAudits = bounded.uninstallAudits
    .filter((audit) => audit && typeof audit.requestId === "string")
    .slice(0, MAX_CLI_UNINSTALL_AUDITS);
  for (const inventory of [bounded.inventory, bounded.comparisonBaseline]) {
    if (!inventory) continue;
    inventory.products = inventory.products.slice(0, MAX_CLI_PRODUCTS);
    inventory.installations = inventory.installations.slice(
      0,
      MAX_CLI_INSTALLATIONS,
    );
    const installationIds = new Set(
      inventory.installations.map((item) => item.id),
    );
    inventory.commands = inventory.commands
      .filter((item) => installationIds.has(item.installationId))
      .slice(0, MAX_CLI_INSTALLATIONS * 8);
    const endpointIds = new Set(
      inventory.commands.flatMap((item) => item.endpointIds),
    );
    inventory.endpoints = inventory.endpoints
      .filter((item) => endpointIds.has(item.id))
      .slice(0, MAX_CLI_INSTALLATIONS * 12);
    inventory.sourceResults = inventory.sourceResults.slice(0, 64);
  }
  return bounded;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isArray<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

function isScanStatus(
  value: unknown,
): value is CliStoreSchema["lastScanStatus"] {
  return (
    typeof value === "string" &&
    [
      "idle",
      "scanning",
      "cancelling",
      "complete",
      "partial",
      "cancelled",
      "failed",
    ].includes(value)
  );
}
