import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { getCliDefinition, type CliDefinition } from "./catalogue";
import { compareEndpoints } from "./inventory-builder";
import type { CliCancellationToken } from "./session";
import type {
  CliCommandRunner,
  CliExecutableEndpoint,
  CliInstallation,
  CliInventorySnapshot,
  CliScanEnvironment,
} from "./types";

const VERSION_OUTPUT_LIMIT = 64 * 1024;

export async function probeVersions(input: {
  environment: CliScanEnvironment;
  runner: CliCommandRunner;
  cancellation: CliCancellationToken;
  installations: CliInstallation[];
  endpoints: CliExecutableEndpoint[];
  previous: CliInventorySnapshot | null;
  onProgress: (completed: number) => void;
  verificationInstallationId?: string;
  now?: () => number;
}): Promise<void> {
  const candidates = input.installations.filter(
    (installation) =>
      installation.presence === "present" &&
      (!installation.version ||
        installation.id === input.verificationInstallationId) &&
      getCliDefinition(installation.productId)?.versionProbe,
  );
  let nextIndex = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      input.cancellation.throwIfCancelled();
      const installation = candidates[nextIndex++];
      const definition = getCliDefinition(installation.productId);
      const probe = definition?.versionProbe;
      if (!probe) continue;
      const endpoints = input.endpoints
        .filter(
          (endpoint) =>
            installation.endpointIds.includes(endpoint.id) &&
            endpoint.commandName === probe.commandName &&
            endpoint.targetExists &&
            endpoint.accessible,
        )
        .sort(compareEndpoints);
      const forceProbe = installation.id === input.verificationInstallationId;
      const metadataVersion = forceProbe
        ? undefined
        : await readPassiveVersionMetadata(installation.productId, endpoints);
      if (metadataVersion) {
        installation.version = metadataVersion;
        installation.versionSource = "executable-metadata";
        installation.issueCodes = installation.issueCodes.filter(
          (issue) => issue !== "version-unverified",
        );
        completed += 1;
        input.onProgress(completed);
        continue;
      }
      const endpoint = endpoints[0];
      const probeExecutable = endpoint
        ? resolveProbeExecutable(endpoint, input.environment.platform)
        : undefined;
      if (!endpoint || !probeExecutable) {
        completed += 1;
        input.onProgress(completed);
        continue;
      }
      const result = await input.runner.run(
        {
          executable: probeExecutable,
          args: [...probe.args],
          cwd: input.environment.neutralWorkingDirectory,
          timeoutMs: Math.min(probe.timeoutMs, 8_000),
          maxStdoutBytes: VERSION_OUTPUT_LIMIT,
          maxStderrBytes: VERSION_OUTPUT_LIMIT,
        },
        input.cancellation.signal,
      );
      if (forceProbe) delete installation.commandVerification;
      const version =
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.cancelled &&
        !result.outputExceeded
          ? parseVersion(`${result.stdout}\n${result.stderr}`, probe.parser)
          : undefined;
      if (version) {
        installation.commandVerification = {
          endpointId: endpoint.id,
          endpointFingerprint: endpoint.fingerprint,
          checkedAt: input.now?.() ?? Date.now(),
        };
        installation.lastSuccessfulVerificationAt =
          installation.commandVerification.checkedAt;
        installation.version = version;
        installation.versionSource = "version-probe";
        installation.issueCodes = installation.issueCodes.filter(
          (issue) => issue !== "version-unverified",
        );
      }
      if (definition?.incompleteProbe) {
        const health = await input.runner.run(
          {
            executable: probeExecutable,
            args: [...definition.incompleteProbe.args],
            cwd: input.environment.neutralWorkingDirectory,
            timeoutMs: 5_000,
            maxStdoutBytes: VERSION_OUTPUT_LIMIT,
            maxStderrBytes: VERSION_OUTPUT_LIMIT,
          },
          input.cancellation.signal,
        );
        if (
          health.exitCode === 0 &&
          definition.incompleteProbe.emptyMeansIncomplete &&
          !health.stdout.trim()
        ) {
          installation.issueCodes.push("incomplete-installation");
        }
      }
      completed += 1;
      input.onProgress(completed);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length || 1) }, () => worker()),
  );
}

async function readPassiveVersionMetadata(
  productId: string,
  endpoints: CliExecutableEndpoint[],
): Promise<string | undefined> {
  if (productId !== "gcloud") return undefined;
  for (const endpoint of endpoints) {
    const binDirectory = path.dirname(endpoint.path);
    if (path.basename(binDirectory).toLowerCase() !== "bin") continue;
    const versionFile = path.join(path.dirname(binDirectory), "VERSION");
    try {
      const metadata = await stat(versionFile);
      if (!metadata.isFile() || metadata.size > 512) continue;
      const value = (await readFile(versionFile, "utf8")).trim();
      const match = value.match(/^([0-9]+(?:\.[0-9]+)+)$/);
      if (match) return match[1];
    } catch {
      continue;
    }
  }
  return undefined;
}

export function resolveProbeExecutable(
  endpoint: CliExecutableEndpoint,
  platform: CliScanEnvironment["platform"],
): string | undefined {
  if (platform === "darwin") {
    return endpoint.executable
      ? (endpoint.canonicalPath ?? endpoint.path)
      : undefined;
  }
  const candidates = [
    endpoint.shimTarget,
    endpoint.symlinkTarget,
    endpoint.canonicalPath,
    endpoint.path,
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) =>
    [".exe", ".com"].includes(path.extname(candidate).toLowerCase()),
  );
}

function parseVersion(
  output: string,
  parser: NonNullable<CliDefinition["versionProbe"]>["parser"],
): string | undefined {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  if (parser === "first-line") return firstLine.slice(0, 128);
  const match =
    parser === "python-version"
      ? firstLine.match(/Python\s+([0-9][^\s]*)/i)
      : firstLine.match(/v?([0-9]+(?:\.[0-9A-Za-z-]+)+)/);
  return match?.[1]?.slice(0, 128);
}
