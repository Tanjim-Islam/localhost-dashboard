import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { groupEquivalentEndpointKey } from "./path";
import { findCliByPackage } from "../catalogue";
import type {
  CliAdapterResult,
  CliCommandResult,
  CliCommandRunner,
  CliExecutableEndpoint,
  CliPackageRecord,
  CliPackageSource,
  CliPlatform,
  CliScanEnvironment,
  CliSourceResult,
} from "../types";

type NodeManagerId = "npm" | "pnpm" | "yarn";

export async function collectNodePackageInventories(input: {
  environment: CliScanEnvironment;
  runner: CliCommandRunner;
  managerEndpoints: Array<{
    productId: NodeManagerId;
    endpoint: CliExecutableEndpoint;
  }>;
  nodeEndpoints?: CliExecutableEndpoint[];
  signal: AbortSignal;
  now: () => number;
}): Promise<CliAdapterResult> {
  const packageRecords: CliPackageRecord[] = [];
  const sourceResults: CliSourceResult[] = [];
  const seen = new Set<string>();

  const managerGroups = new Map<
    string,
    Array<(typeof input.managerEndpoints)[number]>
  >();
  for (const manager of input.managerEndpoints) {
    const key = groupEquivalentEndpointKey(
      { productId: manager.productId, endpoint: manager.endpoint },
      input.environment.platform,
    );
    const group = managerGroups.get(key) ?? [];
    group.push(manager);
    managerGroups.set(key, group);
  }

  for (const managers of managerGroups.values()) {
    if (input.signal.aborted) break;
    const manager = managers[0];
    const startedAt = input.now();
    const executions = await Promise.all(
      managers.map((candidate) =>
        resolveNodeManagerExecution(
          candidate.productId,
          candidate.endpoint,
          input.environment.platform,
          input.nodeEndpoints ?? [],
        ),
      ),
    );
    const execution = executions
      .filter(
        (
          candidate,
        ): candidate is { executable: string; prefixArgs: string[] } =>
          Boolean(candidate),
      )
      .sort(
        (left, right) =>
          Number(right.prefixArgs.length > 0) -
          Number(left.prefixArgs.length > 0),
      )[0];
    const key = execution
      ? [
          manager.productId,
          execution.executable,
          ...execution.prefixArgs,
        ].join("|")
      : `${manager.productId}|${manager.endpoint.canonicalPath ?? manager.endpoint.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!execution) {
      sourceResults.push({
        sourceId: key,
        label: `${manager.productId} global packages`,
        status: "skipped",
        startedAt,
        finishedAt: input.now(),
        recordCount: 0,
        errorCode: "DIRECT_EXECUTION_UNAVAILABLE",
        message: "A safe direct manager executable could not be resolved.",
      });
      continue;
    }
    const result = await input.runner.run(
      {
        executable: execution.executable,
        args: [...execution.prefixArgs, ...inventoryArgs(manager.productId)],
        cwd: input.environment.neutralWorkingDirectory,
        env:
          manager.productId === "yarn"
            ? {
                YARN_IGNORE_PATH: "1",
                SKIP_YARN_COREPACK_CHECK: "1",
              }
            : undefined,
        timeoutMs: 20_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 256 * 1024,
      },
      input.signal,
    );
    const parsed =
      result.exitCode === 0
        ? parseNodeManagerOutput(
            manager.productId,
            result,
            input.environment.platform,
            path.dirname(execution.executable),
            execution.executable,
            execution.prefixArgs[0],
          )
        : null;
    if (!parsed) {
      sourceResults.push({
        sourceId: key,
        label: `${manager.productId} global packages`,
        status: "failed",
        startedAt,
        finishedAt: input.now(),
        recordCount: 0,
        errorCode: result.errorCode ?? "INVENTORY_FAILED",
        message:
          result.message ??
          `${manager.productId} global inventory could not be parsed.`,
      });
      continue;
    }
    packageRecords.push(...parsed);
    sourceResults.push({
      sourceId: key,
      label: `${manager.productId} global packages`,
      status: "success",
      startedAt,
      finishedAt: input.now(),
      recordCount: parsed.length,
    });
  }

  const bun = await collectPassiveBunInventory(input.environment, input.now);
  packageRecords.push(...bun.packageRecords);
  sourceResults.push(...bun.sourceResults);
  return { packageRecords, sourceResults };
}

export function parseNodeManagerOutput(
  manager: NodeManagerId,
  result: Pick<CliCommandResult, "stdout">,
  platform: CliPlatform,
  managerRoot: string,
  managerExecutablePath: string,
  managerCommandPath?: string,
): CliPackageRecord[] | null {
  if (manager === "yarn") {
    return parseYarnOutput(
      result.stdout,
      platform,
      managerRoot,
      managerExecutablePath,
      managerCommandPath,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const dependencies = extractDependencyMap(parsed);
  if (!dependencies) return null;
  const source: CliPackageSource = manager;
  const records: CliPackageRecord[] = [];
  for (const [packageId, metadata] of Object.entries(dependencies)) {
    const definition = findCliByPackage(source, packageId, platform);
    if (!definition) continue;
    const version =
      metadata && typeof metadata === "object"
        ? stringValue((metadata as Record<string, unknown>).version)
        : undefined;
    const installRoot =
      metadata && typeof metadata === "object"
        ? stringValue((metadata as Record<string, unknown>).path)
        : undefined;
    const packageManagerRoot =
      deriveNodeGlobalRoot(installRoot, platform) ?? managerRoot;
    const binEntries = readNodeBinEntries(
      metadata,
      installRoot,
      definition.commands,
    );
    records.push({
      productId: definition.id,
      sourceId: `${manager}|${packageManagerRoot}`,
      commandNames:
        binEntries.length > 0
          ? binEntries.map((entry) => entry.commandName)
          : [...definition.commands],
      binEntries,
      version,
      packageIdentity: {
        source,
        packageId,
        packageVersion: version,
        scope: "user",
        managerRoot: packageManagerRoot,
        managerExecutablePath,
        ...(managerCommandPath ? { managerCommandPath } : {}),
        installRoot:
          installRoot ??
          path.join(managerRoot, "node_modules", ...packageId.split("/")),
        ownershipConfidence: "exact",
        uninstallEvidence: "manager-owned",
      },
    });
  }
  return records;
}

function deriveNodeGlobalRoot(
  installRoot: string | undefined,
  platform: CliPlatform,
): string | undefined {
  if (!installRoot) return undefined;
  const normalized = path.normalize(installRoot);
  const lower = platform === "win32" ? normalized.toLowerCase() : normalized;
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = lower.lastIndexOf(
    platform === "win32" ? marker.toLowerCase() : marker,
  );
  return markerIndex > 0 ? normalized.slice(0, markerIndex) : undefined;
}

async function collectPassiveBunInventory(
  environment: CliScanEnvironment,
  now: () => number,
): Promise<CliAdapterResult> {
  const startedAt = now();
  const globalRoot = path.join(
    environment.homeDirectory,
    ".bun",
    "install",
    "global",
  );
  const manifestPath = path.join(globalRoot, "package.json");
  let parsed: Record<string, unknown>;
  try {
    const stats = await stat(manifestPath);
    if (stats.size > 512 * 1024) throw new Error("manifest too large");
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {
      packageRecords: [],
      sourceResults: [
        {
          sourceId: "bun-passive",
          label: "Bun global packages",
          status: "skipped",
          startedAt,
          finishedAt: now(),
          recordCount: 0,
        },
      ],
    };
  }
  const dependencies = asStringRecord(parsed.dependencies);
  const records: CliPackageRecord[] = [];
  for (const [packageId, version] of Object.entries(dependencies)) {
    const definition = findCliByPackage(
      "bun",
      packageId,
      environment.platform,
    );
    if (!definition) continue;
    records.push({
      productId: definition.id,
      sourceId: "bun-passive",
      commandNames: [...definition.commands],
      binEntries: [],
      version,
      packageIdentity: {
        source: "bun",
        packageId,
        packageVersion: version,
        scope: "user",
        managerRoot: globalRoot,
        installRoot: path.join(
          globalRoot,
          "node_modules",
          ...packageId.split("/"),
        ),
        ownershipConfidence: "exact",
        uninstallEvidence: "none",
      },
    });
  }
  return {
    packageRecords: records,
    sourceResults: [
      {
        sourceId: "bun-passive",
        label: "Bun global packages",
        status: "success",
        startedAt,
        finishedAt: now(),
        recordCount: records.length,
      },
    ],
  };
}

export async function resolveNodeManagerExecution(
  manager: NodeManagerId,
  endpoint: CliExecutableEndpoint,
  platform: CliPlatform,
  nodeEndpoints: CliExecutableEndpoint[] = [],
): Promise<{ executable: string; prefixArgs: string[] } | null> {
  const endpointPath = endpoint.canonicalPath ?? endpoint.path;
  if (platform === "darwin") {
    return path.isAbsolute(endpointPath)
      ? { executable: endpointPath, prefixArgs: [] }
      : null;
  }
  if (path.extname(endpointPath).toLowerCase() === ".exe") {
    return { executable: endpointPath, prefixArgs: [] };
  }
  if (
    endpoint.shimTarget &&
    [".exe", ".com"].includes(
      path.extname(endpoint.shimTarget).toLowerCase(),
    )
  ) {
    return { executable: endpoint.shimTarget, prefixArgs: [] };
  }
  const root = path.dirname(endpoint.path);
  const relativeCli =
    manager === "npm"
      ? ["node_modules", "npm", "bin", "npm-cli.js"]
      : manager === "pnpm"
        ? ["node_modules", "pnpm", "bin", "pnpm.cjs"]
        : ["node_modules", "yarn", "bin", "yarn.js"];
  const cliCandidates = [
    endpoint.shimTarget,
    endpoint.shimPackageRoot
      ? path.join(
          endpoint.shimPackageRoot,
          "bin",
          manager === "npm"
            ? "npm-cli.js"
            : manager === "pnpm"
              ? "pnpm.cjs"
              : "yarn.js",
        )
      : undefined,
    path.join(root, ...relativeCli),
  ].filter((value): value is string => Boolean(value));
  const nodeCandidates = [
    path.join(root, "node.exe"),
    ...nodeEndpoints
      .filter((candidate) =>
        [".exe", ".com"].includes(
          path.extname(candidate.canonicalPath ?? candidate.path).toLowerCase(),
        ),
      )
      .map((candidate) => candidate.canonicalPath ?? candidate.path),
  ];
  for (const cliPath of [...new Set(cliCandidates)]) {
    if (!(await fileExists(cliPath))) continue;
    for (const nodePath of [...new Set(nodeCandidates)]) {
      if (await fileExists(nodePath)) {
        return { executable: nodePath, prefixArgs: [cliPath] };
      }
    }
  }
  return null;
}

function inventoryArgs(manager: NodeManagerId): string[] {
  if (manager === "npm") {
    return ["ls", "--global", "--depth=0", "--json", "--long"];
  }
  if (manager === "pnpm") {
    return ["list", "--global", "--depth=0", "--json"];
  }
  return ["global", "list", "--json", "--depth=0"];
}

function parseYarnOutput(
  stdout: string,
  platform: CliPlatform,
  managerRoot: string,
  managerExecutablePath: string,
  managerCommandPath?: string,
): CliPackageRecord[] | null {
  const records: CliPackageRecord[] = [];
  let sawStructuredLine = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
      sawStructuredLine = true;
    } catch {
      continue;
    }
    const data = event.data as { trees?: Array<{ name?: string }> } | undefined;
    for (const tree of data?.trees ?? []) {
      const name = tree.name ?? "";
      const separator = name.lastIndexOf("@");
      if (separator <= 0) continue;
      const packageId = name.slice(0, separator);
      const version = name.slice(separator + 1);
      const definition = findCliByPackage(
        "yarn-classic",
        packageId,
        platform,
      );
      if (!definition) continue;
      records.push({
        productId: definition.id,
        sourceId: `yarn|${managerRoot}`,
        commandNames: [...definition.commands],
        binEntries: [],
        version,
        packageIdentity: {
          source: "yarn-classic",
          packageId,
          packageVersion: version,
          scope: "user",
          managerRoot,
          managerExecutablePath,
          ...(managerCommandPath ? { managerCommandPath } : {}),
          ownershipConfidence: "exact",
          uninstallEvidence: "manager-owned",
        },
      });
    }
  }
  return sawStructuredLine ? records : null;
}

function extractDependencyMap(
  parsed: unknown,
): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (!first || typeof first !== "object") return {};
    return extractDependencyMap(first);
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const dependencies = record.dependencies ?? record.devDependencies;
  return dependencies && typeof dependencies === "object"
    ? (dependencies as Record<string, unknown>)
    : {};
}

function readNodeBinEntries(
  metadata: unknown,
  installRoot: string | undefined,
  knownCommands: readonly string[],
): CliPackageRecord["binEntries"] {
  if (
    !installRoot ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return [];
  }
  const bin = (metadata as Record<string, unknown>).bin;
  const allowed = new Set(knownCommands.map((command) => command.toLowerCase()));
  const entries: CliPackageRecord["binEntries"] = [];
  const candidates: Array<[string, unknown]> =
    typeof bin === "string" && knownCommands.length === 1
      ? [[knownCommands[0], bin]]
      : bin && typeof bin === "object" && !Array.isArray(bin)
        ? Object.entries(bin as Record<string, unknown>)
        : [];
  for (const [commandName, declaredTarget] of candidates) {
    if (
      !allowed.has(commandName.toLowerCase()) ||
      typeof declaredTarget !== "string"
    ) {
      continue;
    }
    const targetPath = path.isAbsolute(declaredTarget)
      ? path.normalize(declaredTarget)
      : path.resolve(installRoot, declaredTarget);
    const relative = path.relative(installRoot, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    entries.push({ commandName: commandName.toLowerCase(), targetPath });
  }
  return entries;
}

async function fileExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 256 ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
