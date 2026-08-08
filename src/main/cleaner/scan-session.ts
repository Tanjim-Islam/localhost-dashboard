import { randomUUID } from "node:crypto";
import type {
  CleanerClock,
  CleanerApplicationEvidenceSnapshot,
  CleanerApplicationResolution,
  CleanerFinding,
  CleanerPlatform,
  CleanerScanMode,
  CleanerScanProgress,
  CleanerScanResult,
} from "./types";
import { CleanerCancellationToken } from "./cancellation";

export type CleanerScanSessionStatus =
  "scanning" | "complete" | "cancelled" | "invalidated";

export class CleanerScanSession {
  readonly id = randomUUID();
  readonly createdAt: number;
  readonly platform: CleanerPlatform = "win32";
  readonly cancellation = new CleanerCancellationToken();
  readonly findings = new Map<string, CleanerFinding>();
  applicationEvidence?: CleanerApplicationEvidenceSnapshot;
  applicationResolutions: CleanerApplicationResolution[] = [];
  status: CleanerScanSessionStatus = "scanning";
  progress?: CleanerScanProgress;
  result?: CleanerScanResult;

  constructor(
    readonly mode: CleanerScanMode,
    readonly testMode: boolean,
    clock: CleanerClock,
  ) {
    this.createdAt = clock.now();
  }

  cancel(): void {
    this.cancellation.cancel();
    this.status = "cancelled";
  }

  invalidate(): void {
    this.cancellation.cancel();
    this.status = "invalidated";
    this.findings.clear();
    this.applicationEvidence = undefined;
    this.applicationResolutions = [];
    this.result = undefined;
  }
}

export class CleanerScanSessionManager {
  private active?: CleanerScanSession;

  constructor(
    private readonly clock: CleanerClock,
    private readonly maxAgeMs = 30 * 60 * 1000,
  ) {}

  create(mode: CleanerScanMode, testMode: boolean): CleanerScanSession {
    this.active?.invalidate();
    this.active = new CleanerScanSession(mode, testMode, this.clock);
    return this.active;
  }

  getActive(): CleanerScanSession | undefined {
    if (this.active && this.isExpired(this.active)) {
      this.active.invalidate();
      this.active = undefined;
    }
    return this.active;
  }

  cancel(id: string): boolean {
    const active = this.getActive();
    if (!active || active.id !== id || active.status !== "scanning")
      return false;
    active.cancel();
    return true;
  }

  requireCompleted(id: string): CleanerScanSession {
    const active = this.getActive();
    if (!active || active.id !== id) {
      throw new Error(
        "Cleaner scan session is missing, stale, or from a previous app session.",
      );
    }
    if (active.status !== "complete" || !active.result) {
      throw new Error("Cleaner scan session is not ready for cleanup.");
    }
    return active;
  }

  invalidateActive(): void {
    this.active?.invalidate();
    this.active = undefined;
  }

  private isExpired(session: CleanerScanSession): boolean {
    return this.clock.now() - session.createdAt > this.maxAgeMs;
  }
}
