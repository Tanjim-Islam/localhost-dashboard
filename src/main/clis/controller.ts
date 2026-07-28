import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CliCancelledError, CliCancellationToken, CliScanSessionManager } from "./session";
import { boundCliStore } from "./store";
import { CliUninstallController } from "./uninstall-controller";
import type {
  CliClock,
  CliInstallationRef,
  CliInventorySnapshot,
  CliPersistence,
  CliScanAttemptSummary,
  CliScanProgress,
  CliScanSession,
  CliUninstallAuditSummary,
  CliUninstallPreview,
  CliUninstallProgress,
  CliUninstallRequest,
  CliUninstallResult,
} from "./types";
import type { CliScanner } from "./scanner";

type CliControllerEventMap = {
  "scan-progress": [CliScanProgress];
  "scan-complete": [CliInventorySnapshot];
  "scan-error": [{ scanSessionId?: string; status: "failed" | "cancelled"; message: string }];
  "inventory-changed": [CliInventorySnapshot];
  "uninstall-progress": [CliUninstallProgress];
  "uninstall-complete": [CliUninstallResult];
};

export class CliController extends EventEmitter<CliControllerEventMap> {
  private readonly sessions: CliScanSessionManager;
  private readonly uninstallController: CliUninstallController;
  private lastSession?: CliScanSession;

  constructor(
    private readonly options: {
      scanner: CliScanner;
      persistence: CliPersistence;
      clock: CliClock;
      runner: import("./types").CliCommandRunner;
    },
  ) {
    super();
    this.sessions = new CliScanSessionManager(options.clock);
    const initial = options.persistence.read();
    if (initial.lastScanStatus === "scanning" || initial.lastScanStatus === "cancelling") {
      options.persistence.write({ ...initial, lastScanStatus: "failed" });
    }
    this.uninstallController = new CliUninstallController({
      clock: options.clock,
      runner: options.runner,
      getInventory: () => this.readInventory(false),
      revalidate: (installationId) => this.revalidateFromFreshEvidence(installationId),
      refreshAfterAction: () => this.scanAndPublish(`refresh-${randomUUID()}`),
      markFixtureUninstalled: (installationId) =>
        options.scanner.markFixtureUninstalled(installationId),
      onProgress: (progress) => this.emit("uninstall-progress", progress),
      onAudit: (audit) => this.recordUninstallAudit(audit),
    });
  }

  getInventory(): CliInventorySnapshot | null {
    return this.readInventory(true);
  }

  getScanState(): CliScanSession {
    return this.sessions.getActive()?.toJSON() ?? this.lastSession ?? {
      id: "scan-idle",
      status: "idle",
      startedAt: 0,
      completedSources: 0,
      totalSources: 0,
      completedProbes: 0,
      totalProbes: 0,
    };
  }

  startScan(): CliScanSession {
    const session = this.sessions.create();
    const store = this.options.persistence.read();
    this.options.persistence.write({
      ...store,
      lastScanStartedAt: session.startedAt,
      lastScanStatus: "scanning",
    });
    void this.runUserScan(session);
    return session.toJSON();
  }

  cancelScan(scanSessionId: string): CliScanSession {
    const session = this.sessions.cancel(scanSessionId);
    this.options.persistence.write({
      ...this.options.persistence.read(),
      lastScanStatus: "cancelling",
    });
    return session.toJSON();
  }

  async verifyInstallation(input: CliInstallationRef): Promise<CliInventorySnapshot> {
    this.requireRevision(input.inventoryRevision);
    return this.scanAndPublish(`verify-${randomUUID()}`);
  }

  resolveRevealPath(input: CliInstallationRef): string {
    const snapshot = this.requireRevision(input.inventoryRevision);
    const installation = snapshot.installations.find(
      (candidate) => candidate.id === input.installationId,
    );
    if (!installation) throw new Error("The CLI installation was not found.");
    const endpoint = snapshot.endpoints.find((candidate) =>
      installation.endpointIds.includes(candidate.id),
    );
    if (!endpoint) throw new Error("This installation has no local executable to reveal.");
    return endpoint.path;
  }

  getUninstallPreview(input: CliInstallationRef): Promise<CliUninstallPreview> {
    return this.uninstallController.preview(
      input.installationId,
      input.inventoryRevision,
    );
  }

  async uninstall(input: CliUninstallRequest): Promise<CliUninstallResult> {
    const result = await this.uninstallController.uninstall(input);
    this.emit("uninstall-complete", result);
    return result;
  }

  private async runUserScan(
    session: ReturnType<CliScanSessionManager["create"]>,
  ): Promise<void> {
    try {
      const snapshot = await this.options.scanner.scan({
        previous: this.readInventory(false),
        cancellation: session.cancellation,
        scanSessionId: session.id,
        onProgress: (progress) => {
          session.progress = progress;
          this.emit("scan-progress", progress);
        },
      });
      session.status = snapshot.completeness === "partial" ? "partial" : "complete";
      session.finishedAt = this.options.clock.now();
      const publishedSnapshot = this.publishSnapshot(snapshot, session.toJSON());
      this.emit("scan-complete", publishedSnapshot);
    } catch (error) {
      session.finishedAt = this.options.clock.now();
      if (error instanceof CliCancelledError || session.cancellation.isCancelled) {
        session.status = "cancelled";
        session.message = "CLI scan cancelled. Cached inventory was kept.";
      } else {
        session.status = "failed";
        session.message = sanitizeError(error);
      }
      this.recordFailedAttempt(session.toJSON());
      this.emit("scan-error", {
        scanSessionId: session.id,
        status: session.status === "cancelled" ? "cancelled" : "failed",
        message: session.message,
      });
    } finally {
      this.lastSession = session.toJSON();
    }
  }

  private async scanAndPublish(scanSessionId: string): Promise<CliInventorySnapshot> {
    const snapshot = await this.options.scanner.scan({
      previous: this.readInventory(false),
      cancellation: new CliCancellationToken(),
      scanSessionId,
      onProgress: () => undefined,
    });
    return this.publishSnapshot(snapshot);
  }

  private async revalidateFromFreshEvidence(
    installationId: string,
  ): Promise<{ snapshot: CliInventorySnapshot; installation: import("./types").CliInstallation }> {
    const snapshot = await this.options.scanner.scan({
      previous: this.readInventory(false),
      cancellation: new CliCancellationToken(),
      scanSessionId: `revalidate-${randomUUID()}`,
      onProgress: () => undefined,
    });
    const installation = snapshot.installations.find(
      (candidate) => candidate.id === installationId,
    );
    if (!installation || installation.presence !== "present") {
      throw new Error("The installation is no longer confirmed by its package source.");
    }
    const passive = await this.options.scanner.revalidateInstallation(
      snapshot,
      installationId,
    );
    if (!passive.current) throw new Error(passive.reason ?? "The installation changed.");
    return { snapshot, installation };
  }

  private publishSnapshot(
    snapshot: CliInventorySnapshot,
    session?: CliScanSession,
  ): CliInventorySnapshot {
    const now = this.options.clock.now();
    const store = this.options.persistence.read();
    const lastSuccessfulScanAt =
      snapshot.completeness === "complete"
        ? now
        : store.lastSuccessfulScanAt ?? snapshot.lastSuccessfulScanAt;
    const publishedSnapshot: CliInventorySnapshot = {
      ...snapshot,
      ...(lastSuccessfulScanAt ? { lastSuccessfulScanAt } : {}),
      cached: false,
    };
    const attempt: CliScanAttemptSummary | undefined = session && session.finishedAt
      ? {
          scanSessionId: session.id,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          status: session.status as CliScanAttemptSummary["status"],
          sourceFailureCount: snapshot.sourceResults.filter(
            (source) => source.status === "failed",
          ).length,
          ...(session.message ? { message: session.message } : {}),
        }
      : undefined;
    this.options.persistence.write(boundCliStore({
      ...store,
      inventory: publishedSnapshot,
      lastCompletedScanAt: now,
      lastSuccessfulScanAt:
        lastSuccessfulScanAt ?? null,
      lastScanStatus:
        snapshot.completeness === "complete" ? "complete" : "partial",
      scanAttempts: attempt
        ? [attempt, ...store.scanAttempts]
        : store.scanAttempts,
    }));
    this.emit("inventory-changed", publishedSnapshot);
    return publishedSnapshot;
  }

  private recordFailedAttempt(session: CliScanSession): void {
    if (!session.finishedAt || session.status === "idle" || session.status === "scanning" || session.status === "cancelling") return;
    const store = this.options.persistence.read();
    const attempt: CliScanAttemptSummary = {
      scanSessionId: session.id,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      status: session.status,
      sourceFailureCount: 0,
      ...(session.message ? { message: session.message } : {}),
    };
    this.options.persistence.write(boundCliStore({
      ...store,
      lastCompletedScanAt: session.finishedAt,
      lastScanStatus: session.status,
      scanAttempts: [attempt, ...store.scanAttempts],
    }));
  }

  private recordUninstallAudit(audit: CliUninstallAuditSummary): void {
    const store = this.options.persistence.read();
    this.options.persistence.write(boundCliStore({
      ...store,
      uninstallAudits: [audit, ...store.uninstallAudits],
    }));
  }

  private requireRevision(revision: string): CliInventorySnapshot {
    const snapshot = this.readInventory(false);
    if (!snapshot || snapshot.revision !== revision) {
      throw new Error("The CLI inventory changed. Refresh and try again.");
    }
    return snapshot;
  }

  private readInventory(cached: boolean): CliInventorySnapshot | null {
    const snapshot = this.options.persistence.read().inventory;
    return snapshot ? { ...structuredClone(snapshot), cached } : null;
  }
}

function sanitizeError(error: unknown): string {
  if (!(error instanceof Error)) return "CLI scan failed.";
  const message = error.message.replace(/[\r\n]+/g, " ").slice(0, 300);
  return message || "CLI scan failed.";
}
