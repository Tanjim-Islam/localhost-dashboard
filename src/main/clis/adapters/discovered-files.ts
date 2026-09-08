import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { discoveredPackageId } from "../discovery";
import {
  findCliByCommand,
  findCliByPackage,
  getCliDefinition,
} from "../catalogue";
import { normalizeCliPath } from "../fingerprint";
import type {
  CliAdapterResult,
  CliCommandRunner,
  CliPackageRecord,
  CliPackageSource,
  CliPathEndpointRecord,
  CliScanEnvironment,
} from "../types";
import { readNodeBinEntries } from "./node-packages";
import { readBoundedPackageJson } from "./windows";
import type { CliCancellationToken } from "../session";

export async function discoverAdditionalDirectories(
  roots: string[],
  cancellation: CliCancellationToken,
): Promise<{ directories: string[]; incomplete: boolean }> {
  const queue = roots.map((directory) => ({ directory, depth: 0 }));
  const directories: string[] = [];
  const seen = new Set<string>();
  const ignored = new Set([
    "node_modules",
    ".git",
    ".cache",
    "cache",
    "caches",
    ".venv",
    "venv",
    "__pycache__",
    "$recycle.bin",
    "system volume information",
  ]);
  let incomplete = false;
  for (let index = 0; index < queue.length; index++) {
    cancellation.throwIfCancelled();
    if (directories.length >= 2000) {
      incomplete = true;
      break;
    }
    const { directory, depth } = queue[index];
    const canonical = await realpath(directory).catch(() => directory);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    directories.push(directory);
    try {
      const children = (
        await readdir(directory, { withFileTypes: true })
      ).filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !ignored.has(entry.name.toLowerCase()),
      );
      if (depth >= 8) {
        if (children.length) incomplete = true;
        continue;
      }
      if (children.length > 1000) incomplete = true;
      for (const child of children
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 1000))
        queue.push({
          directory: path.join(directory, child.name),
          depth: depth + 1,
        });
    } catch {
      incomplete = true;
    }
  }
  return { directories, incomplete };
}

export async function discoverVersionedBinDirectories(
  environment: CliScanEnvironment,
): Promise<string[]> {
  const directories: string[] = [...environment.knownDirectories];
  const roots = [
    environment.env.NVM_HOME,
    environment.env.NVM_DIR &&
      path.join(environment.env.NVM_DIR, "versions", "node"),
    path.join(environment.homeDirectory, ".nvm", "versions", "node"),
    environment.env.LOCALAPPDATA &&
      path.join(environment.env.LOCALAPPDATA, "Programs", "Python"),
  ].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    try {
      const children = (await readdir(root, { withFileTypes: true }))
        .filter(
          (entry) => entry.isDirectory() && /^(v\d|python\d)/i.test(entry.name),
        )
        .slice(0, 64);
      for (const child of children) {
        const location = path.join(root, child.name);
        directories.push(
          location,
          path.join(location, "bin"),
          path.join(location, "Scripts"),
        );
      }
    } catch {
      /* Optional tool homes may not exist. */
    }
  }
  for (const key of [
    "JAVA_HOME",
    "CARGO_HOME",
    "GOPATH",
    "GOBIN",
    "PNPM_HOME",
    "BUN_INSTALL",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "MAVEN_HOME",
    "GRADLE_HOME",
  ]) {
    const root = environment.env[key];
    if (root && path.isAbsolute(root))
      directories.push(
        root,
        path.join(root, "bin"),
        path.join(root, "platform-tools"),
      );
  }
  return [...new Set(directories)];
}

// Read the owning package of Node shims, including inactive global prefixes.
export async function collectShimPackageMetadata(
  records: CliPathEndpointRecord[],
  environment: CliScanEnvironment,
  existing: CliPackageRecord[],
  signal: AbortSignal,
): Promise<CliPackageRecord[]> {
  const roots = new Set(
    records
      .map((record) => record.endpoint.shimPackageRoot)
      .filter((value): value is string => Boolean(value)),
  );
  const result: CliPackageRecord[] = [];
  for (const root of roots) {
    if (signal.aborted) break;
    if (
      existing.some(
        (record) =>
          record.packageIdentity.installRoot &&
          normalizeCliPath(
            record.packageIdentity.installRoot,
            environment.platform,
          ) === normalizeCliPath(root, environment.platform),
      )
    )
      continue;
    const manifest = await readBoundedPackageJson(root);
    if (
      !manifest ||
      typeof manifest.name !== "string" ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(manifest.name)
    )
      continue;
    const packageId = manifest.name;
    const definition =
      findCliByPackage("npm", packageId, environment.platform) ??
      findCliByCommand(packageId, environment.platform);
    const bins = readNodeBinEntries(
      manifest,
      root,
      definition?.commands ?? [packageId.split("/").at(-1) ?? packageId],
    );
    if (!bins.length) continue;
    const marker = `${path.sep}node_modules${path.sep}`;
    const managerRoot = root.slice(0, root.toLowerCase().lastIndexOf(marker));
    const normalizedRoot = managerRoot.replaceAll("\\", "/").toLowerCase();
    const source: CliPackageSource =
      /\/(?:yarn\/data\/global|yarn\/global)/.test(normalizedRoot)
        ? "yarn-classic"
        : /\/(?:pnpm|\.pnpm)\//.test(normalizedRoot)
          ? "pnpm"
          : normalizedRoot.includes("/.bun/install/global")
            ? "bun"
            : normalizedRoot.endsWith("/npm") ||
                /\/(?:nvm|\.nvm)\//.test(normalizedRoot)
              ? "npm"
              : "unknown";
    const version =
      typeof manifest.version === "string" && manifest.version.length < 128
        ? manifest.version
        : undefined;
    result.push({
      productId:
        definition?.id ??
        discoveredPackageId("npm", packageId, environment.platform),
      sourceId: "node-shim-metadata",
      commandNames: bins.map((bin) => bin.commandName),
      binEntries: bins,
      version,
      packageIdentity: {
        source,
        ...(source === "unknown" ? { sourceName: "Node.js package" } : {}),
        packageId,
        packageVersion: version,
        managerRoot,
        installRoot: root,
        scope: within(root, environment.homeDirectory, environment.platform)
          ? "user"
          : "unknown",
        // Package metadata proves attribution, but does not select a manager for removal.
        ownershipConfidence: "corroborated",
        uninstallEvidence: "none",
      },
    });
  }
  return result;
}

export async function attributeDiscoveredFiles(input: {
  records: CliPathEndpointRecord[];
  environment: CliScanEnvironment;
  applicationRoots: NonNullable<CliAdapterResult["applicationRoots"]>;
  runner: CliCommandRunner;
  signal: AbortSignal;
  now(): number;
}): Promise<CliAdapterResult> {
  const roots = await Promise.all(
    input.applicationRoots.map(async (root) => ({
      ...root,
      path: await realpath(root.path).catch(() => root.path),
    })),
  );
  const applicationPackages = new Map<string, CliPackageRecord>();
  for (const { endpoint } of input.records) {
    const candidates = roots
      .filter((root) =>
        within(
          endpoint.canonicalPath ?? endpoint.path,
          root.path,
          input.environment.platform,
        ),
      )
      .sort((left, right) => right.path.length - left.path.length);
    const longest = candidates[0];
    if (
      longest &&
      !candidates.some(
        (other) =>
          other.path.length === longest.path.length &&
          other.name !== longest.name,
      )
    ) {
      endpoint.ownerName = longest.name;
      endpoint.publisher = longest.publisher;
      const record = input.records.find((item) => item.endpoint === endpoint);
      if (
        record &&
        getCliDefinition(record.productId) &&
        endpoint.executable &&
        !endpoint.bundledWith &&
        !applicationPackages.has(`${longest.path}|${record.productId}`)
      ) {
        const rootRecords = input.records.filter(
          ({ endpoint: candidate }) =>
            !candidate.bundledWith &&
            candidate.executable &&
            Boolean(
              findCliByCommand(
                candidate.commandName,
                input.environment.platform,
              ),
            ) &&
            within(
              candidate.canonicalPath ?? candidate.path,
              longest.path,
              input.environment.platform,
            ),
        );
        const productId = record.productId;
        // Application ownership must not promote unrelated helpers into a CLI.
        const ownedRecords = rootRecords.filter(
          (candidate) => candidate.productId === productId,
        );
        const group = {
          productId,
          sourceId: "windows-registry",
          commandNames: [
            ...new Set(
              ownedRecords.map((candidate) => candidate.endpoint.commandName),
            ),
          ],
          binEntries: ownedRecords.map((candidate) => ({
            commandName: candidate.endpoint.commandName,
            targetPath: candidate.endpoint.path,
          })),
          version: longest.version,
          packageIdentity: {
            source: "registry" as const,
            packageId: longest.name,
            packageVersion: longest.version,
            installRoot: longest.path,
            scope: within(
              longest.path,
              input.environment.homeDirectory,
              input.environment.platform,
            )
              ? ("user" as const)
              : ("machine" as const),
            ownershipConfidence: "corroborated" as const,
            uninstallEvidence: "none" as const,
          },
        };
        applicationPackages.set(`${longest.path}|${productId}`, group);
      }
    }
  }
  if (input.environment.platform !== "win32")
    return { packageRecords: [], sourceResults: [] };
  const systemRoot =
    input.environment.env.SystemRoot ?? input.environment.env.WINDIR;
  if (!systemRoot)
    return {
      packageRecords: [...applicationPackages.values()],
      sourceResults: [],
    };
  const nativeRecords = input.records.filter(
    ({ endpoint }) =>
      path.extname(endpoint.path).toLowerCase() === ".exe" &&
      !endpoint.shimTarget,
  );
  const files = [
    ...new Set(
      nativeRecords.map(
        ({ endpoint }) => endpoint.canonicalPath ?? endpoint.path,
      ),
    ),
  ];
  const startedAt = input.now();
  let failed = false;
  let count = 0;
  for (let start = 0; start < files.length && !input.signal.aborted; ) {
    const batch: string[] = [];
    let characters = 0;
    while (start < files.length && characters + files[start].length < 4500) {
      characters += files[start].length + 4;
      batch.push(files[start++]);
    }
    if (!batch.length) {
      start++;
      failed = true;
      continue;
    }
    const script = `$ErrorActionPreference='Stop'\n$files=@(${batch.map((file) => `'${file.replaceAll("'", "''")}'`).join(",")})\n@($files | ForEach-Object { try { $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($_); [pscustomobject]@{path=$_;publisher=$v.CompanyName;product=$v.ProductName;version=$v.ProductVersion} } catch {} }) | ConvertTo-Json -Compress`;
    try {
      const result = await input.runner.run(
        {
          executable: path.join(
            systemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          cwd: input.environment.neutralWorkingDirectory,
          timeoutMs: 15_000,
          maxStdoutBytes: 512 * 1024,
          maxStderrBytes: 64 * 1024,
        },
        input.signal,
      );
      if (result.exitCode !== 0 || result.outputExceeded)
        throw new Error("unavailable");
      const parsed: unknown = result.stdout.trim()
        ? JSON.parse(result.stdout)
        : [];
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!row || typeof row.path !== "string" || !batch.includes(row.path))
          continue;
        const publisher = cleanLabel(row.publisher);
        const version = cleanLabel(row.version)?.match(
          /^\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/i,
        )?.[0];
        for (const { endpoint } of nativeRecords) {
          if ((endpoint.canonicalPath ?? endpoint.path) !== row.path) continue;
          if (publisher) endpoint.publisher ??= publisher;
          if (
            version &&
            typeof row.product === "string" &&
            row.product.toLowerCase() === endpoint.commandName.toLowerCase()
          )
            endpoint.fileVersion = version;
        }
        count++;
      }
    } catch {
      failed = true;
    }
  }
  return {
    packageRecords: [...applicationPackages.values()],
    sourceResults: [
      {
        sourceId: "file-metadata",
        label: "Installed file details",
        status: failed ? "failed" : "success",
        startedAt,
        finishedAt: input.now(),
        recordCount: count,
        ...(failed
          ? {
              errorCode: "FILE_METADATA_UNAVAILABLE",
              message: "Some installed file details could not be read.",
            }
          : {}),
      },
    ],
  };
}

function within(
  value: string,
  root: string,
  platform: CliScanEnvironment["platform"],
): boolean {
  const relative = path.relative(
    normalizeCliPath(root, platform),
    normalizeCliPath(value, platform),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function cleanLabel(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f]/g, "")
        .trim()
        .slice(0, 256) || undefined
    : undefined;
}
