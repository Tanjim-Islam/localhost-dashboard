import { randomUUID } from "node:crypto";
import type {
  CliClock,
  CliScanProgress,
  CliScanSession,
  CliScanStatus,
} from "./types";

export class CliCancelledError extends Error {
  constructor() {
    super("CLI scan was cancelled.");
    this.name = "CliCancelledError";
  }
}

export class CliCancellationToken {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isCancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(): void {
    this.controller.abort();
  }

  throwIfCancelled(): void {
    if (this.isCancelled) throw new CliCancelledError();
  }
}

export class ActiveCliScanSession {
  readonly id = randomUUID();
  readonly cancellation = new CliCancellationToken();
  readonly startedAt: number;
  status: CliScanStatus = "scanning";
  progress?: CliScanProgress;
  finishedAt?: number;
  message?: string;

  constructor(clock: CliClock) {
    this.startedAt = clock.now();
  }

  toJSON(): CliScanSession {
    return {
      id: this.id,
      status: this.status,
      ...(this.progress ? { stage: this.progress.stage } : {}),
      startedAt: this.startedAt,
      ...(this.finishedAt ? { finishedAt: this.finishedAt } : {}),
      completedSources: this.progress?.completedSources ?? 0,
      totalSources: this.progress?.totalSources ?? 0,
      completedProbes: this.progress?.completedProbes ?? 0,
      totalProbes: this.progress?.totalProbes ?? 0,
      ...(this.message ? { message: this.message } : {}),
    };
  }
}

export class CliScanSessionManager {
  private active?: ActiveCliScanSession;

  constructor(private readonly clock: CliClock) {}

  create(): ActiveCliScanSession {
    const current = this.active;
    if (
      current &&
      (current.status === "scanning" || current.status === "cancelling")
    ) {
      throw new Error("A CLI scan is already running.");
    }
    this.active = new ActiveCliScanSession(this.clock);
    return this.active;
  }

  getActive(): ActiveCliScanSession | undefined {
    return this.active;
  }

  cancel(id: string): ActiveCliScanSession {
    const current = this.active;
    if (!current || current.id !== id || current.status !== "scanning") {
      throw new Error("CLI scan session cannot be cancelled.");
    }
    current.status = "cancelling";
    current.cancellation.cancel();
    return current;
  }
}
