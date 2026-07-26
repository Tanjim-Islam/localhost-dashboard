import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  CleanerCancellationToken,
  CleanerCancelledError,
} from "../cancellation";
import { RealCleanerFilesystem } from "../adapters/real-filesystem";
import { TestCleanerFilesystem } from "../adapters/test-filesystem";
import { CleanerSizeCalculator } from "../size-calculator";
import { DEEP_EXHAUSTIVE_MEASUREMENT_POLICY } from "../measurement-policy";
import type {
  CleanerAccountingWorkerData,
  CleanerAccountingWorkerRequest,
  CleanerAccountingWorkerResponse,
} from "../accounting-worker-protocol";

if (!isMainThread) {
  if (!parentPort) {
    throw new Error("Cleaner accounting worker has no parent port.");
  }
  const port = parentPort;
  const configured = workerData as CleanerAccountingWorkerData;
  if (configured.kind !== "cleaner-accounting-worker") {
    throw new Error("Cleaner accounting worker configuration is invalid.");
  }
  const filesystem = configured.testRoot
    ? new TestCleanerFilesystem(configured.testRoot)
    : new RealCleanerFilesystem();
  let active:
    | {
        requestId: string;
        cancellation: CleanerCancellationToken;
      }
    | undefined;
  let shutdownRequested = false;

  const send = (message: CleanerAccountingWorkerResponse): void => {
    port.postMessage(message);
  };

  const finishIfShuttingDown = (): void => {
    if (shutdownRequested && !active) port.close();
  };

  port.on("message", (message: CleanerAccountingWorkerRequest): void => {
    if (message.type === "cancel") {
      if (active?.requestId === message.requestId) {
        active.cancellation.cancel();
      }
      return;
    }
    if (message.type === "shutdown") {
      shutdownRequested = true;
      active?.cancellation.cancel();
      finishIfShuttingDown();
      return;
    }
    if (shutdownRequested || active) {
      send({
        type: "failed",
        requestId: message.requestId,
        category: "worker-failed",
        message: "The accounting worker received overlapping work.",
      });
      return;
    }

    const cancellation = new CleanerCancellationToken();
    active = { requestId: message.requestId, cancellation };
    void new CleanerSizeCalculator(filesystem, cancellation, {
      policy: DEEP_EXHAUSTIVE_MEASUREMENT_POLICY,
      onProgress: (progress) =>
        send({
          type: "progress",
          requestId: message.requestId,
          progress,
        }),
    })
      .measure(message.targetPath)
      .then((result) => {
        send({ type: "result", requestId: message.requestId, result });
      })
      .catch((error: unknown) => {
        if (
          error instanceof CleanerCancelledError ||
          cancellation.isCancelled
        ) {
          send({ type: "cancelled", requestId: message.requestId });
          return;
        }
        send({
          type: "failed",
          requestId: message.requestId,
          category: "worker-failed",
          message:
            "The background accounting worker could not finish the target.",
        });
      })
      .finally(() => {
        active = undefined;
        finishIfShuttingDown();
      });
  });
}
