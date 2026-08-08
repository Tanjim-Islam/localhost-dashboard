import Store, { type Schema } from "electron-store";
import { app } from "electron";
import type { CleanerPersistence, CleanerStoreSchema } from "./types";
import { MAX_CLEANER_EVENTS, pruneCleanerHistory } from "./history";
import {
  MAX_CLEANER_HISTORY_ENTRIES,
  MAX_CLEANER_RECEIPTS,
  recoverInterruptedCleanupReceipts,
} from "./cleanup-receipts";
import { pruneCleanerApplicationObservations } from "./applications/observation-store";
import { migrateCleanerStore } from "./store-migration";
import { prepareCleanerStoreForAuditMigration } from "./store-file-migration";

export { migrateCleanerStore } from "./store-migration";

export const DEFAULT_CLEANER_STORE: CleanerStoreSchema = {
  schemaVersion: 3,
  exclusions: [],
  itemHistory: {},
  cleanupEvents: [],
  cleanupReceipts: [],
  cleanupHistory: [],
  applicationObservations: {},
  migrationNotices: [],
  preferences: {
    defaultScanMode: "standard",
    showExcluded: false,
  },
};

const schema: Schema<CleanerStoreSchema> = {
  schemaVersion: { type: "number", enum: [1, 2, 3], default: 3 },
  exclusions: {
    type: "array",
    maxItems: 500,
    default: [],
    items: {
      type: "object",
      required: ["id", "scope", "value", "label", "createdAt"],
      additionalProperties: false,
      properties: {
        id: { type: "string", maxLength: 64 },
        scope: {
          type: "string",
          enum: [
            "category",
            "detector",
            "application",
            "root",
            "path",
            "finding",
          ],
        },
        value: { type: "string", maxLength: 2048 },
        label: { type: "string", maxLength: 256 },
        createdAt: { type: "number" },
      },
    },
  },
  itemHistory: { type: "object", default: {}, additionalProperties: true },
  cleanupEvents: {
    type: "array",
    maxItems: MAX_CLEANER_EVENTS,
    default: [],
    items: { type: "object", additionalProperties: true },
  },
  cleanupReceipts: {
    type: "array",
    maxItems: MAX_CLEANER_RECEIPTS,
    default: [],
    items: { type: "object", additionalProperties: true },
  },
  cleanupHistory: {
    type: "array",
    maxItems: MAX_CLEANER_HISTORY_ENTRIES,
    default: [],
    items: {
      type: "object",
      required: [
        "id",
        "completedAt",
        "mode",
        "freeSpaceBeforeBytes",
        "freeSpaceAfterBytes",
        "recoveredBytes",
        "deletedTargetNames",
      ],
      additionalProperties: false,
      properties: {
        id: { type: "string", maxLength: 64 },
        completedAt: { type: "number" },
        mode: { type: "string", enum: ["standard", "deep"] },
        freeSpaceBeforeBytes: { type: ["number", "null"] },
        freeSpaceAfterBytes: { type: ["number", "null"] },
        recoveredBytes: { type: ["number", "null"] },
        deletedTargetNames: {
          type: "array",
          maxItems: 200,
          items: { type: "string", maxLength: 256 },
        },
      },
    },
  },
  applicationObservations: {
    type: "object",
    default: {},
    additionalProperties: true,
  },
  migrationNotices: {
    type: "array",
    maxItems: 20,
    default: [],
    items: { type: "string", maxLength: 256 },
  },
  preferences: {
    type: "object",
    default: DEFAULT_CLEANER_STORE.preferences,
    required: ["defaultScanMode", "showExcluded"],
    additionalProperties: false,
    properties: {
      defaultScanMode: {
        type: "string",
        enum: ["standard", "deep"],
        default: "standard",
      },
      showExcluded: { type: "boolean", default: false },
    },
  },
};

export class ElectronCleanerPersistence implements CleanerPersistence {
  private readonly store: Store<CleanerStoreSchema>;

  constructor() {
    prepareCleanerStoreForAuditMigration(app.getPath("userData"));
    this.store = new Store<CleanerStoreSchema>({
      name: "cleaner",
      fileExtension: "json",
      defaults: structuredClone(DEFAULT_CLEANER_STORE),
      schema,
      clearInvalidConfig: false,
    });
    const recovered = this.readWithoutRecovery();
    if (recoverInterruptedCleanupReceipts(recovered, Date.now())) {
      this.write(recovered);
    }
  }

  read(): CleanerStoreSchema {
    return this.readWithoutRecovery();
  }

  private readWithoutRecovery(): CleanerStoreSchema {
    const next = migrateCleanerStore({
      schemaVersion: this.store.get("schemaVersion"),
      exclusions: structuredClone(this.store.get("exclusions")),
      itemHistory: structuredClone(this.store.get("itemHistory")),
      cleanupEvents: structuredClone(this.store.get("cleanupEvents")),
      cleanupReceipts: structuredClone(this.store.get("cleanupReceipts")),
      cleanupHistory: structuredClone(this.store.get("cleanupHistory")),
      applicationObservations: structuredClone(
        this.store.get("applicationObservations"),
      ),
      migrationNotices: structuredClone(this.store.get("migrationNotices")),
      preferences: structuredClone(this.store.get("preferences")),
    });
    next.cleanupEvents = next.cleanupEvents.slice(0, MAX_CLEANER_EVENTS);
    next.cleanupReceipts = next.cleanupReceipts.slice(0, MAX_CLEANER_RECEIPTS);
    next.cleanupHistory = next.cleanupHistory.slice(
      0,
      MAX_CLEANER_HISTORY_ENTRIES,
    );
    pruneCleanerHistory(next);
    pruneCleanerApplicationObservations(next, Date.now());
    return next;
  }

  write(next: CleanerStoreSchema): void {
    const bounded = structuredClone(next);
    bounded.cleanupEvents = bounded.cleanupEvents.slice(0, MAX_CLEANER_EVENTS);
    bounded.cleanupReceipts = bounded.cleanupReceipts.slice(
      0,
      MAX_CLEANER_RECEIPTS,
    );
    bounded.cleanupHistory = bounded.cleanupHistory.slice(
      0,
      MAX_CLEANER_HISTORY_ENTRIES,
    );
    pruneCleanerHistory(bounded);
    pruneCleanerApplicationObservations(bounded, Date.now());
    bounded.applicationObservations = Object.fromEntries(
      Object.entries(bounded.applicationObservations).map(
        ([applicationId, observation]) => [
          applicationId,
          {
            ...observation,
            lastEvidenceTypes: observation.lastEvidenceTypes.slice(0, 16),
            lastKnownRootIds: observation.lastKnownRootIds.slice(0, 32),
            portableExecutablePaths: observation.portableExecutablePaths?.slice(
              0,
              8,
            ),
          },
        ],
      ),
    );
    bounded.migrationNotices = bounded.migrationNotices.slice(0, 20);
    this.store.set(bounded);
  }
}

export class MemoryCleanerPersistence implements CleanerPersistence {
  constructor(
    private state: CleanerStoreSchema = structuredClone(DEFAULT_CLEANER_STORE),
  ) {}

  read(): CleanerStoreSchema {
    return structuredClone(this.state);
  }

  write(next: CleanerStoreSchema): void {
    this.state = migrateCleanerStore(next);
  }
}
