"use strict";

const path = require("node:path");
const {
  createCleanerEnvironment,
} = require("../.tmp-tests/src/main/cleaner/environment.js");
const {
  RealCleanerFilesystem,
} = require("../.tmp-tests/src/main/cleaner/adapters/real-filesystem.js");
const {
  RealCleanerProcessProvider,
} = require("../.tmp-tests/src/main/cleaner/adapters/process-provider.js");
const {
  RealCleanerApplicationEvidenceProvider,
} = require("../.tmp-tests/src/main/cleaner/applications/evidence-collector.js");
const {
  RealCleanerDriveProvider,
} = require("../.tmp-tests/src/main/cleaner/adapters/drive-provider.js");
const {
  createCleanerDetectors,
} = require("../.tmp-tests/src/main/cleaner/detectors/index.js");
const { CleanerScanner } = require("../.tmp-tests/src/main/cleaner/scanner.js");
const {
  NodeCleanerAccountingWorkerFactory,
} = require("../.tmp-tests/src/main/cleaner/accounting-worker-client.js");
const {
  CleanerScanSession,
} = require("../.tmp-tests/src/main/cleaner/scan-session.js");
const {
  normalizeWindowsPath,
} = require("../.tmp-tests/src/main/cleaner/path-normalization.js");

function emptyState() {
  return {
    schemaVersion: 3,
    exclusions: [],
    itemHistory: {},
    cleanupEvents: [],
    cleanupReceipts: [],
    applicationObservations: {},
    migrationNotices: [],
    preferences: { defaultScanMode: "standard", showExcluded: false },
  };
}

class MemoryPersistence {
  constructor() {
    this.state = emptyState();
  }
  read() {
    return structuredClone(this.state);
  }
  write(next) {
    this.state = structuredClone(next);
  }
}

function counts(values) {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [value, values.filter((item) => item === value).length]),
  );
}

async function runAudit(mode, dependencies, environment) {
  const session = new CleanerScanSession(mode, false, dependencies.clock);
  const startedAt = Date.now();
  const result = await dependencies.scanner.scan(
    session,
    environment,
    () => undefined,
  );
  const applications = session.applicationResolutions
    .filter(
      (application) =>
        application.installState !== "probably-uninstalled" ||
        application.strongEvidence.length > 0 ||
        application.supportingEvidence.length > 0,
    )
    .map((application) => ({
      id: application.id,
      channel: application.channel,
      installState: application.installState,
      runningState: application.runningState,
      evidenceConfidence: application.confidence,
    }));
  const invalidAbsolutePaths = result.findings.filter((finding) => {
    try {
      normalizeWindowsPath(finding.path);
      return false;
    } catch {
      return true;
    }
  }).length;
  const weakNodeNameBlocking = result.findings.filter((finding) =>
    finding.relatedProcesses.some(
      (processInfo) =>
        processInfo.blocking &&
        processInfo.evidenceStrength === "weak-name-only" &&
        /^(node|electron)(\.exe)?$/i.test(processInfo.name),
    ),
  ).length;
  const weakPythonNameBlocking = result.findings.filter((finding) =>
    finding.relatedProcesses.some(
      (processInfo) =>
        processInfo.blocking &&
        processInfo.evidenceStrength === "weak-name-only" &&
        /^python(?:3)?(\.exe)?$/i.test(processInfo.name),
    ),
  ).length;
  const antigravityCollision = result.findings.some(
    (finding) =>
      finding.applicationId === "editor.antigravity" &&
      /Antigravity Tools/i.test(finding.applicationName || ""),
  );
  const uvAccounting = result.findings
    .filter((finding) => finding.detectorId === "dev.uv-cache")
    .map((finding) => ({
      logicalBytes: finding.logicalBytes,
      allocatedBytes: finding.allocatedBytes,
      uniqueAllocatedBytes: finding.uniqueAllocatedBytes,
      estimatedReclaimableBytes: finding.estimatedReclaimableBytes,
      measurementCompleteness: finding.measurementCompleteness,
      accountingConfidence: finding.accountingConfidence,
      hardlinkRecordCount: finding.hardlinkRecordCount,
      externalHardlinkRecordCount: finding.externalHardlinkRecordCount,
      measuredFileCount: finding.measuredFileCount,
      measuredDirectoryCount: finding.measuredDirectoryCount,
      measurementDurationMs: finding.measurementDurationMs,
      logicalTraversalComplete: finding.logicalTraversalComplete,
      physicalAccountingComplete: finding.physicalAccountingComplete,
      measurementFailureCategory: finding.measurementFailureCategory,
      measurementFailureExplanation: finding.measurementFailureExplanation,
      safety: finding.safety,
      cleanupEligible: finding.canDelete,
      blockingProcessCount: finding.relatedProcesses.filter(
        (processInfo) => processInfo.blocking,
      ).length,
      selectableNow:
        finding.canDelete &&
        finding.measurementCompleteness === "complete" &&
        finding.estimatedReclaimableBytes !== null &&
        !finding.relatedProcesses.some((processInfo) => processInfo.blocking) &&
        (finding.safety === "safe-now" || finding.safety === "conditional"),
    }));
  return {
    mode,
    durationMs: Date.now() - startedAt,
    findingCount: result.findings.length,
    safetyCounts: counts(result.findings.map((finding) => finding.safety)),
    dataKindCounts: counts(result.findings.map((finding) => finding.dataKind)),
    applications,
    invalidAbsolutePaths,
    weakNodeNameBlocking,
    weakPythonNameBlocking,
    antigravityCollision,
    scanIncomplete: result.summary.scanIncomplete,
    scanWarnings: result.summary.scanWarnings,
    estimatedRecoverableBytes: result.summary.estimatedRecoverableBytes,
    unknownRecoverableFindingCount:
      result.summary.unknownRecoverableFindingCount,
    uvAccounting,
    freeSpaceMeasuredAt: result.summary.freeDiskSpaceMeasuredAt,
    sizeAccountingNotes: result.summary.sizeAccountingNotes,
  };
}

async function main() {
  if (process.env.LOCAL_DASHBOARD_CLEANER_TEST_ROOT) {
    throw new Error(
      "Read-only production audit refused to run while Cleaner test mode is configured.",
    );
  }
  const environment = await createCleanerEnvironment(process.env);
  if (environment.testRoot) {
    throw new Error("Read-only production audit cannot use a fixture root.");
  }
  const persistence = new MemoryPersistence();
  const clock = { now: () => Date.now() };
  const scanner = new CleanerScanner({
    filesystem: new RealCleanerFilesystem(),
    processProvider: new RealCleanerProcessProvider(),
    applicationEvidenceProvider: new RealCleanerApplicationEvidenceProvider(),
    driveProvider: new RealCleanerDriveProvider(),
    persistence,
    clock,
    detectors: createCleanerDetectors(),
    accountingWorkerFactory: new NodeCleanerAccountingWorkerFactory(
      path.join(
        __dirname,
        "..",
        ".tmp-tests",
        "src",
        "main",
        "cleaner",
        "workers",
        "accounting-worker.js",
      ),
    ),
  });
  const dependencies = { scanner, clock };
  const standard = await runAudit("standard", dependencies, environment);
  const deep = await runAudit("deep", dependencies, environment);
  process.stdout.write(
    `${JSON.stringify(
      {
        destructiveOperationsAvailable: false,
        cleanupExecutorConstructed: false,
        systemDrive: environment.systemDrive,
        standard,
        deep,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
