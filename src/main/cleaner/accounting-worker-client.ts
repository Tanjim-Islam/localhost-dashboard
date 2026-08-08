import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  CleanerAccountingWorkerFailure,
  type CleanerAccountingWorkerFactory,
  type CleanerAccountingWorkerSession,
} from "./accounting-worker";
import {
  CleanerCancelledError,
  type CleanerCancellationToken,
} from "./cancellation";
import type {
  CleanerMeasuredSize,
  CleanerMeasurementProgress,
} from "./size-calculator";
import type {
  CleanerAccountingWorkerData,
  CleanerAccountingWorkerRequest,
  CleanerAccountingWorkerResponse,
} from "./accounting-worker-protocol";

type ActiveRequest = {
  requestId: string;
  resolve(result: CleanerMeasuredSize): void;
  reject(error: Error): void;
  onProgress?: (progress: CleanerMeasurementProgress) => void;
  unsubscribeCancellation(): void;
  forcedTermination?: NodeJS.Timeout;
};

export class NodeCleanerAccountingWorkerFactory implements CleanerAccountingWorkerFactory {
  constructor(
    private readonly workerScript: string | URL,
    private readonly testRoot?: string,
  ) {}

  create(): CleanerAccountingWorkerSession {
    return new NodeCleanerAccountingWorkerSession(
      this.workerScript,
      this.testRoot,
    );
  }
}

class NodeCleanerAccountingWorkerSession implements CleanerAccountingWorkerSession {
  private readonly worker: Worker;
  private active?: ActiveRequest;
  private closing = false;
  private exited = false;
  private readonly exitedPromise: Promise<void>;
  private resolveExited!: () => void;

  constructor(workerScript: string | URL, testRoot?: string) {
    const workerData: CleanerAccountingWorkerData = {
      kind: "cleaner-accounting-worker",
      testRoot,
    };
    this.worker = new Worker(workerScript, { workerData });
    this.exitedPromise = new Promise<void>((resolve) => {
      this.resolveExited = resolve;
    });
    this.worker.on("message", (message: unknown) =>
      this.handleMessage(message),
    );
    this.worker.on("error", () => {
      this.failActive(
        new CleanerAccountingWorkerFailure(
          "The background accounting worker emitted an error.",
        ),
      );
    });
    this.worker.on("exit", (code) => {
      this.exited = true;
      this.resolveExited();
      if (!this.closing) {
        this.failActive(
          new CleanerAccountingWorkerFailure(
            `The background accounting worker stopped unexpectedly with exit code ${code}.`,
          ),
        );
      }
    });
  }

  measure(
    targetPath: string,
    cancellation: CleanerCancellationToken,
    onProgress?: (progress: CleanerMeasurementProgress) => void,
  ): Promise<CleanerMeasuredSize> {
    if (this.closing || this.exited) {
      return Promise.reject(
        new CleanerAccountingWorkerFailure(
          "The background accounting worker is not available.",
        ),
      );
    }
    if (this.active) {
      return Promise.reject(
        new CleanerAccountingWorkerFailure(
          "The background accounting worker already has an active target.",
        ),
      );
    }
    cancellation.throwIfCancelled();
    const requestId = randomUUID();
    return new Promise<CleanerMeasuredSize>((resolve, reject) => {
      const unsubscribeCancellation = cancellation.onCancelled(() => {
        this.post({ type: "cancel", requestId });
        const active = this.active;
        if (!active || active.requestId !== requestId) return;
        active.forcedTermination = setTimeout(() => {
          if (this.active?.requestId === requestId) {
            void this.worker.terminate();
            this.failActive(new CleanerCancelledError());
          }
        }, 2_000);
      });
      this.active = {
        requestId,
        resolve,
        reject,
        onProgress,
        unsubscribeCancellation,
      };
      this.post({ type: "measure", requestId, targetPath });
    });
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.exitedPromise;
      return;
    }
    this.closing = true;
    if (this.exited) return;
    this.post({ type: "shutdown" });
    await this.exitedPromise;
  }

  private post(message: CleanerAccountingWorkerRequest): void {
    if (!this.exited) this.worker.postMessage(message);
  }

  private handleMessage(message: unknown): void {
    if (!isWorkerResponse(message)) return;
    const active = this.active;
    if (!active || active.requestId !== message.requestId) return;
    if (message.type === "progress") {
      active.onProgress?.(message.progress);
      return;
    }
    this.clearActive();
    if (message.type === "result") {
      active.resolve(message.result);
    } else if (message.type === "cancelled") {
      active.reject(new CleanerCancelledError());
    } else {
      active.reject(new CleanerAccountingWorkerFailure(message.message));
    }
  }

  private failActive(error: Error): void {
    const active = this.active;
    if (!active) return;
    this.clearActive();
    active.reject(error);
  }

  private clearActive(): void {
    const active = this.active;
    this.active = undefined;
    active?.unsubscribeCancellation();
    if (active?.forcedTermination) clearTimeout(active.forcedTermination);
  }
}

function isWorkerResponse(
  value: unknown,
): value is CleanerAccountingWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CleanerAccountingWorkerResponse>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.requestId === "string" &&
    ["progress", "result", "cancelled", "failed"].includes(candidate.type)
  );
}
