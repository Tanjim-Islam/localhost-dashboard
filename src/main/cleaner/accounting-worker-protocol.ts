import type {
  CleanerMeasuredSize,
  CleanerMeasurementProgress,
} from "./size-calculator";

export type CleanerAccountingWorkerData = {
  kind: "cleaner-accounting-worker";
  testRoot?: string;
};

export type CleanerAccountingWorkerRequest =
  | {
      type: "measure";
      requestId: string;
      targetPath: string;
    }
  | {
      type: "cancel";
      requestId: string;
    }
  | {
      type: "shutdown";
    };

export type CleanerAccountingWorkerResponse =
  | {
      type: "progress";
      requestId: string;
      progress: CleanerMeasurementProgress;
    }
  | {
      type: "result";
      requestId: string;
      result: CleanerMeasuredSize;
    }
  | {
      type: "cancelled";
      requestId: string;
    }
  | {
      type: "failed";
      requestId: string;
      category: "worker-failed";
      message: string;
    };
