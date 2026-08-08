import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  CliClock,
  CliCommandRunner,
  CliInstallation,
  CliInventorySnapshot,
  CliPackageIdentity,
  CliUninstallAuditSummary,
  CliUninstallPreview,
  CliUninstallProgress,
  CliUninstallRequest,
  CliUninstallResult,
} from "./types";

const PREVIEW_LIFETIME_MS = 2 * 60 * 1000;
const UNINSTALL_TIMEOUT_MS = 60_000;
const MANAGER_OUTPUT_LIMIT = 256 * 1024;

type PreviewRecord = {
  preview: CliUninstallPreview;
  fingerprint: string;
  packageKey: string;
  managerFileFingerprint: string;
  used: boolean;
};

type RevalidationResult = {
  snapshot: CliInventorySnapshot;
  installation: CliInstallation;
};

export type CliUninstallControllerOptions = {
  clock: CliClock;
  runner: CliCommandRunner;
  getInventory(): CliInventorySnapshot | null;
  revalidate(installationId: string): Promise<RevalidationResult>;
  refreshAfterAction(): Promise<CliInventorySnapshot>;
  markFixtureUninstalled?(installationId: string): void;
  onProgress(progress: CliUninstallProgress): void;
  onAudit(audit: CliUninstallAuditSummary): void;
};

export class CliUninstallController {
  private readonly previews = new Map<string, PreviewRecord>();

  constructor(private readonly options: CliUninstallControllerOptions) {}

  async preview(
    installationId: string,
    inventoryRevision: string,
  ): Promise<CliUninstallPreview> {
    const current = this.requireCurrentInventory(inventoryRevision);
    const currentInstallation = requireInstallation(current, installationId);
    requireActionableCapability(currentInstallation);
    const fresh = await this.options.revalidate(installationId);
    assertSameInstallation(currentInstallation, fresh.installation);
    requireActionableCapability(fresh.installation);
    const identity = requirePackageIdentity(fresh.installation);
    const product = fresh.snapshot.products.find(
      (candidate) => candidate.id === fresh.installation.productId,
    );
    if (!product) throw new Error("The CLI product could not be resolved.");
    const token = `preview-${randomUUID()}`;
    const managerFileFingerprint = await fingerprintManagerFile(identity);
    const preview: CliUninstallPreview = {
      token,
      expiresAt: this.options.clock.now() + PREVIEW_LIFETIME_MS,
      inventoryRevision,
      installationId,
      productName: product.displayName,
      version: fresh.installation.version,
      source: identity.source,
      packageId: identity.packageId,
      scope: identity.scope,
      providedCommands: [
        ...fresh.installation.uninstallCapability.providedCommands,
      ],
      remainingInstallationCount: fresh.snapshot.installations.filter(
        (candidate) =>
          candidate.productId === fresh.installation.productId &&
          candidate.id !== installationId &&
          candidate.presence === "present",
      ).length,
      support: fresh.installation.uninstallCapability.status,
      requiresElevation:
        fresh.installation.uninstallCapability.requiresElevation,
      warnings: [...fresh.installation.uninstallCapability.warnings],
    };
    this.previews.set(token, {
      preview,
      fingerprint: fresh.installation.fingerprint,
      packageKey: packageIdentityKey(identity),
      managerFileFingerprint,
      used: false,
    });
    this.prunePreviews();
    return preview;
  }

  async uninstall(input: CliUninstallRequest): Promise<CliUninstallResult> {
    const requestId = `uninstall-${randomUUID()}`;
    const startedAt = this.options.clock.now();
    const record = this.previews.get(input.previewToken);
    if (
      !record ||
      record.used ||
      record.preview.expiresAt < this.options.clock.now() ||
      record.preview.installationId !== input.installationId ||
      record.preview.inventoryRevision !== input.inventoryRevision
    ) {
      throw new Error("The uninstall preview is stale. Request a new preview.");
    }
    record.used = true;
    const current = this.requireCurrentInventory(input.inventoryRevision);
    const before = requireInstallation(current, input.installationId);
    requireActionableCapability(before);
    this.emit(requestId, input.installationId, "revalidating", "Revalidating ownership");
    const fresh = await this.options.revalidate(input.installationId);
    assertSameInstallation(before, fresh.installation);
    const identity = requirePackageIdentity(fresh.installation);
    if (
      record.fingerprint !== fresh.installation.fingerprint ||
      record.packageKey !== packageIdentityKey(identity) ||
      record.managerFileFingerprint !== await fingerprintManagerFile(identity)
    ) {
      throw new Error("The installation changed after the preview.");
    }
    requireActionableCapability(fresh.installation);
    const plan = createCliUninstallPlan(fresh.installation);

    this.emit(requestId, input.installationId, "uninstalling", "Running exact package uninstall");
    const result = await this.options.runner.run({
      ...plan,
      timeoutMs: UNINSTALL_TIMEOUT_MS,
      maxStdoutBytes: MANAGER_OUTPUT_LIMIT,
      maxStderrBytes: MANAGER_OUTPUT_LIMIT,
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) {
      const message = result.timedOut
        ? "The package manager timed out."
        : result.outputExceeded
          ? "The package manager produced too much output."
          : "The package manager reported that uninstall failed.";
      const snapshot = await this.safeRefresh(current);
      const failed = createResult({
        requestId,
        installationId: input.installationId,
        status: "failed",
        managerExitCode: result.exitCode ?? undefined,
        verifiedRemoved: false,
        message,
        inventoryRevision: snapshot.revision,
      });
      this.audit(failed, identity, startedAt);
      return failed;
    }

    this.options.markFixtureUninstalled?.(input.installationId);
    this.emit(requestId, input.installationId, "verifying", "Verifying package removal");
    const verification = await this.options.revalidate(input.installationId).catch(
      () => null,
    );
    const packageStillPresent = Boolean(
      verification?.installation &&
        verification.installation.presence === "present",
    );
    this.emit(requestId, input.installationId, "refreshing", "Refreshing CLI inventory");
    const snapshot = await this.safeRefresh(current);
    const refreshed = snapshot.installations.find(
      (candidate) => candidate.id === input.installationId,
    );
    const verifiedRemoved =
      !packageStillPresent && refreshed?.presence !== "present";
    const final = createResult({
      requestId,
      installationId: input.installationId,
      status: verifiedRemoved ? "succeeded" : "verification-failed",
      managerExitCode: result.exitCode ?? undefined,
      verifiedRemoved,
      message: verifiedRemoved
        ? "The exact installation was removed and the inventory was refreshed."
        : "The command finished, but removal could not be verified.",
      inventoryRevision: snapshot.revision,
    });
    this.audit(final, identity, startedAt);
    return final;
  }

  private requireCurrentInventory(revision: string): CliInventorySnapshot {
    const snapshot = this.options.getInventory();
    if (!snapshot || snapshot.revision !== revision) {
      throw new Error("The CLI inventory changed. Refresh the details and try again.");
    }
    return snapshot;
  }

  private async safeRefresh(
    fallback: CliInventorySnapshot,
  ): Promise<CliInventorySnapshot> {
    try {
      return await this.options.refreshAfterAction();
    } catch {
      return fallback;
    }
  }

  private emit(
    requestId: string,
    installationId: string,
    stage: CliUninstallProgress["stage"],
    label: string,
  ): void {
    this.options.onProgress({ requestId, installationId, stage, label });
  }

  private audit(
    result: CliUninstallResult,
    identity: CliPackageIdentity,
    startedAt: number,
  ): void {
    this.options.onAudit({
      requestId: result.requestId,
      installationId: result.installationId,
      source: identity.source,
      packageId: identity.packageId,
      startedAt,
      finishedAt: this.options.clock.now(),
      status: result.status,
      message: result.message,
    });
  }

  private prunePreviews(): void {
    const now = this.options.clock.now();
    for (const [token, record] of this.previews) {
      if (record.used || record.preview.expiresAt < now) {
        this.previews.delete(token);
      }
    }
    while (this.previews.size > 32) {
      const oldest = this.previews.keys().next().value as string | undefined;
      if (!oldest) break;
      this.previews.delete(oldest);
    }
  }
}

export function createCliUninstallPlan(
  installation: CliInstallation,
): Pick<
  import("./types").CliCommandSpec,
  "executable" | "args" | "cwd" | "env"
> {
  const identity = requirePackageIdentity(installation);
  const executable = requireAbsoluteManager(identity);
  const packageId = validatePackageId(identity.source, identity.packageId);
  const cwd = identity.managerRoot && path.isAbsolute(identity.managerRoot)
    ? identity.managerRoot
    : path.dirname(executable);
  switch (identity.source) {
    case "npm": {
      if (
        installation.platform === "win32" &&
        path.basename(executable).toLowerCase() === "node.exe"
      ) {
        const cliPath = requireSafeNpmCommandPath(identity);
        return {
          executable,
          args: [cliPath, "uninstall", "--global", "--ignore-scripts", packageId],
          cwd,
          env: { npm_config_ignore_scripts: "true", npm_config_yes: "true" },
        };
      }
      return {
        executable,
        args: ["uninstall", "--global", "--ignore-scripts", packageId],
        cwd,
        env: { npm_config_ignore_scripts: "true", npm_config_yes: "true" },
      };
    }
    case "pipx":
      return {
        executable,
        args: ["uninstall", packageId],
        cwd,
        env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      };
    case "cargo":
      return {
        executable,
        args: ["uninstall", "--root", cwd, "--package", packageId],
        cwd,
      };
    case "scoop":
      if (installation.platform !== "win32") {
        throw new Error("Scoop uninstall is available only on Windows.");
      }
      return {
        executable: path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          executable,
          "uninstall",
          packageId,
        ],
        cwd,
      };
    case "homebrew-formula":
      return {
        executable,
        args: ["uninstall", "--formula", packageId],
        cwd,
        env: {
          HOMEBREW_NO_AUTO_UPDATE: "1",
          HOMEBREW_NO_ANALYTICS: "1",
        },
      };
    default:
      throw new Error("This package source is not supported for in-app uninstall.");
  }
}

function requireActionableCapability(installation: CliInstallation): void {
  if (
    installation.uninstallCapability.status !== "supported" &&
    installation.uninstallCapability.status !== "requires-warning"
  ) {
    throw new Error(installation.uninstallCapability.reason);
  }
  if (
    installation.uninstallCapability.requiresElevation ||
    installation.scope === "system"
  ) {
    throw new Error("This uninstall requires manual administrator action.");
  }
}

function requirePackageIdentity(
  installation: CliInstallation,
): CliPackageIdentity {
  const identity = installation.packageIdentity;
  if (
    !identity ||
    identity.ownershipConfidence !== "exact" ||
    !identity.packageId
  ) {
    throw new Error("Exact package ownership is unavailable.");
  }
  return identity;
}

function requireAbsoluteManager(identity: CliPackageIdentity): string {
  const executable = identity.managerExecutablePath;
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("The package manager executable is unavailable.");
  }
  return executable;
}

function requireSafeNpmCommandPath(identity: CliPackageIdentity): string {
  const commandPath = identity.managerCommandPath;
  if (
    !commandPath ||
    !path.isAbsolute(commandPath) ||
    path.basename(commandPath).toLowerCase() !== "npm-cli.js"
  ) {
    throw new Error("The npm command entrypoint is unavailable.");
  }
  const normalized = path.normalize(commandPath).toLowerCase();
  const expectedSuffix = path.normalize(
    `${path.sep}node_modules${path.sep}npm${path.sep}bin${path.sep}npm-cli.js`,
  ).toLowerCase();
  if (!normalized.endsWith(expectedSuffix)) {
    throw new Error("The npm command entrypoint is not recognized.");
  }
  return commandPath;
}

function validatePackageId(
  source: CliPackageIdentity["source"],
  packageId: string,
): string {
  const patterns: Partial<Record<CliPackageIdentity["source"], RegExp>> = {
    npm: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i,
    pipx: /^[a-z0-9][a-z0-9._-]*$/i,
    cargo: /^[a-z0-9][a-z0-9_-]*$/i,
    scoop: /^[a-z0-9][a-z0-9._-]*$/i,
    "homebrew-formula": /^[a-z0-9][a-z0-9@+._/-]*$/i,
  };
  const pattern = patterns[source];
  if (!pattern || packageId.length > 214 || !pattern.test(packageId)) {
    throw new Error("The exact package identity is not safe to execute.");
  }
  return packageId;
}

function requireInstallation(
  snapshot: CliInventorySnapshot,
  installationId: string,
): CliInstallation {
  const installation = snapshot.installations.find(
    (candidate) => candidate.id === installationId,
  );
  if (!installation) throw new Error("The CLI installation was not found.");
  return installation;
}

function assertSameInstallation(
  expected: CliInstallation,
  actual: CliInstallation,
): void {
  if (
    expected.id !== actual.id ||
    expected.productId !== actual.productId ||
    expected.fingerprint !== actual.fingerprint ||
    packageIdentityKey(expected.packageIdentity) !==
      packageIdentityKey(actual.packageIdentity)
  ) {
    throw new Error("The installation changed. Run a new scan.");
  }
}

function packageIdentityKey(identity: CliPackageIdentity | undefined): string {
  if (!identity) return "";
  return JSON.stringify([
    identity.source,
    identity.packageId,
    identity.scope,
    identity.managerRoot,
    identity.managerExecutablePath,
    identity.managerCommandPath,
    identity.installRoot,
  ]);
}

async function fingerprintManagerFile(
  identity: CliPackageIdentity,
): Promise<string> {
  const managerPath = requireAbsoluteManager(identity);
  try {
    const paths = [
      managerPath,
      ...(identity.managerCommandPath ? [identity.managerCommandPath] : []),
    ];
    const fingerprints = await Promise.all(
      paths.map(async (filePath) => {
        const metadata = await stat(filePath);
        return [
          path.normalize(filePath),
          metadata.dev,
          metadata.ino,
          metadata.size,
          metadata.mtimeMs,
        ];
      }),
    );
    return JSON.stringify(fingerprints);
  } catch {
    throw new Error("The package manager executable is unavailable.");
  }
}

function createResult(
  value: CliUninstallResult,
): CliUninstallResult {
  return value;
}
