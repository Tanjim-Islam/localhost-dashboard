import fs from "node:fs/promises";
import type { CleanerDriveProvider } from "../types";
import type { TestCleanerFilesystem } from "./test-filesystem";

export class RealCleanerDriveProvider implements CleanerDriveProvider {
  async measureFreeSpace(systemDrive: string) {
    const stat = await fs.statfs(systemDrive);
    return {
      freeBytes: stat.bavail * stat.bsize,
      driveIdentity: normalizeDriveIdentity(systemDrive),
    };
  }
}

export class TestCleanerDriveProvider implements CleanerDriveProvider {
  private configuredMeasurements?: number[];
  private measurementIndex = 0;

  constructor(private readonly filesystem: TestCleanerFilesystem) {}

  setFreeBytesSequence(measurements: number[]): void {
    if (measurements.length === 0) {
      throw new Error("Cleaner test drive measurements cannot be empty.");
    }
    this.configuredMeasurements = measurements.map((value) =>
      Math.max(0, Math.trunc(value)),
    );
    this.measurementIndex = 0;
  }

  resetFreeBytesSequence(): void {
    this.configuredMeasurements = undefined;
    this.measurementIndex = 0;
  }

  async measureFreeSpace(systemDrive = "C:\\") {
    const manifest = await this.filesystem.readManifest();
    const measurements =
      this.configuredMeasurements ?? manifest.freeDiskSpaceMeasurements;
    const freeBytes =
      measurements && measurements.length > 0
        ? measurements[Math.min(this.measurementIndex, measurements.length - 1)]
        : manifest.freeDiskSpaceBytes;
    this.measurementIndex += 1;
    return {
      freeBytes,
      driveIdentity: normalizeDriveIdentity(systemDrive),
    };
  }
}

function normalizeDriveIdentity(systemDrive: string): string {
  const normalized = systemDrive.replaceAll("/", "\\").trim().toLowerCase();
  return normalized.endsWith("\\") ? normalized : `${normalized}\\`;
}
