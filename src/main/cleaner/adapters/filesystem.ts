import type {
  CleanerApplicationEvidenceSnapshot,
  CleanerProcessSnapshot,
  CleanerSizeAccounting,
} from "../types";

export type CleanerFixtureManifest = {
  version: 2;
  createdAt: number;
  createdPaths: string[];
  sizeOverrides: Record<string, number>;
  accountingOverrides?: Record<string, Partial<CleanerSizeAccounting>>;
  standardAccountingOverrides?: Record<string, Partial<CleanerSizeAccounting>>;
  virtualTrees?: Record<
    string,
    {
      fileCount: number;
      logicalBytesPerFile: number;
      allocatedBytesPerFile: number;
      volumeIdentity: string;
    }
  >;
  evidence: CleanerApplicationEvidenceSnapshot & {
    processes: CleanerProcessSnapshot[];
  };
  freeDiskSpaceBytes: number;
  freeDiskSpaceMeasurements?: number[];
};

export const CLEANER_TEST_SENTINEL = ".local-dashboard-cleaner-fixture";
export const CLEANER_TEST_MANIFEST = "cleaner-fixture-manifest.json";
