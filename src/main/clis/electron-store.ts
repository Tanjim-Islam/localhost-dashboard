import Store, { type Schema } from "electron-store";
import type { CliPersistence, CliStoreSchema } from "./types";
import {
  boundCliStore,
  DEFAULT_CLI_STORE,
  MAX_CLI_SCAN_ATTEMPTS,
  MAX_CLI_UNINSTALL_AUDITS,
  migrateCliStore,
} from "./store";

const schema: Schema<CliStoreSchema> = {
  schemaVersion: { type: "number", enum: [1, 2], default: 2 },
  inventory: {
    type: ["object", "null"],
    default: null,
    additionalProperties: true,
  },
  lastScanStartedAt: { type: ["number", "null"], default: null },
  lastCompletedScanAt: { type: ["number", "null"], default: null },
  lastSuccessfulScanAt: { type: ["number", "null"], default: null },
  lastScanStatus: {
    type: "string",
    enum: [
      "idle",
      "scanning",
      "cancelling",
      "complete",
      "partial",
      "cancelled",
      "failed",
    ],
    default: "idle",
  },
  scanAttempts: {
    type: "array",
    maxItems: MAX_CLI_SCAN_ATTEMPTS,
    default: [],
    items: { type: "object", additionalProperties: true },
  },
  uninstallAudits: {
    type: "array",
    maxItems: MAX_CLI_UNINSTALL_AUDITS,
    default: [],
    items: { type: "object", additionalProperties: true },
  },
};

export class ElectronCliPersistence implements CliPersistence {
  private readonly store: Store<CliStoreSchema>;

  constructor() {
    this.store = new Store<CliStoreSchema>({
      name: "clis",
      fileExtension: "json",
      defaults: structuredClone(DEFAULT_CLI_STORE),
      schema,
      clearInvalidConfig: false,
    });
  }

  read(): CliStoreSchema {
    return migrateCliStore({
      schemaVersion: this.store.get("schemaVersion"),
      inventory: structuredClone(this.store.get("inventory")),
      lastScanStartedAt: this.store.get("lastScanStartedAt"),
      lastCompletedScanAt: this.store.get("lastCompletedScanAt"),
      lastSuccessfulScanAt: this.store.get("lastSuccessfulScanAt"),
      lastScanStatus: this.store.get("lastScanStatus"),
      scanAttempts: structuredClone(this.store.get("scanAttempts")),
      uninstallAudits: structuredClone(this.store.get("uninstallAudits")),
    });
  }

  write(next: CliStoreSchema): void {
    this.store.set(boundCliStore(migrateCliStore(next)));
  }
}
