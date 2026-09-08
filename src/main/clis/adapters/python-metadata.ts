import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { findCliByCommand } from "../catalogue";
import { discoveredPackageId, validCliCommand } from "../discovery";
import type {
  CliAdapterResult,
  CliPackageRecord,
  CliPathEndpointRecord,
  CliScanEnvironment,
} from "../types";

export async function collectPythonEntryPoints(input: {
  records: CliPathEndpointRecord[];
  environment: CliScanEnvironment;
  signal: AbortSignal;
  now(): number;
}): Promise<CliAdapterResult> {
  const startedAt = input.now();
  const scriptRoots = [
    ...new Set(
      input.records
        .map(({ endpoint }) => path.dirname(endpoint.path))
        .filter(
          (directory) => path.basename(directory).toLowerCase() === "scripts",
        ),
    ),
  ];
  const packages: CliPackageRecord[] = [];
  let incomplete = false;
  for (const scripts of scriptRoots) {
    for (const site of [
      path.join(path.dirname(scripts), "Lib", "site-packages"),
      path.join(path.dirname(scripts), "site-packages"),
    ]) {
      if (input.signal.aborted) break;
      let entries;
      try {
        entries = (await readdir(site, { withFileTypes: true })).filter(
          (entry) => entry.isDirectory() && entry.name.endsWith(".dist-info"),
        );
      } catch {
        continue;
      }
      if (entries.length > 2000) incomplete = true;
      for (const entry of entries.slice(0, 2000)) {
        if (input.signal.aborted) break;
        const root = path.join(site, entry.name);
        const declarations = await readBoundedText(
          path.join(root, "entry_points.txt"),
        );
        if (!declarations) continue;
        const commands = parsePythonConsoleScripts(declarations);
        const endpoints = input.records.filter(
          ({ endpoint }) =>
            path.dirname(endpoint.path) === scripts &&
            commands.includes(endpoint.commandName),
        );
        if (!endpoints.length) continue;
        const metadata = await readBoundedText(path.join(root, "METADATA"));
        const name = metadata?.match(/^Name: ([^\r\n]+)\r?$/m)?.[1]?.trim();
        const version = metadata
          ?.match(/^Version: ([^\r\n]+)\r?$/m)?.[1]
          ?.trim();
        if (!name || !/^[a-z0-9._-]{1,128}$/i.test(name)) continue;
        const definition = endpoints
          .map(({ endpoint }) =>
            findCliByCommand(endpoint.commandName, input.environment.platform),
          )
          .find(Boolean);
        packages.push({
          productId:
            definition?.id ??
            discoveredPackageId("pip", name, input.environment.platform),
          sourceId: "pip",
          commandNames: [
            ...new Set(endpoints.map(({ endpoint }) => endpoint.commandName)),
          ],
          binEntries: endpoints.map(({ endpoint }) => ({
            commandName: endpoint.commandName,
            targetPath: endpoint.path,
          })),
          version: version?.slice(0, 128),
          packageIdentity: {
            source: "pip",
            packageId: name,
            packageVersion: version?.slice(0, 128),
            installRoot: root,
            managerRoot: path.dirname(scripts),
            scope: "unknown",
            ownershipConfidence: "corroborated",
            uninstallEvidence: "none",
          },
        });
      }
    }
  }
  return {
    packageRecords: packages,
    sourceResults: [
      {
        sourceId: "pip",
        label: "Python command packages",
        status: incomplete ? "failed" : "success",
        startedAt,
        finishedAt: input.now(),
        recordCount: packages.length,
        ...(incomplete
          ? {
              errorCode: "PYTHON_PACKAGE_LIMIT",
              message:
                "A Python package folder exceeded the metadata scan limit.",
            }
          : {}),
      },
    ],
  };
}

export function parsePythonConsoleScripts(text: string): string[] {
  let consoleSection = false;
  const commands: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const section = line.trim().match(/^\[([^\]]+)\]$/);
    if (section) {
      consoleSection = section[1] === "console_scripts";
      continue;
    }
    const name = consoleSection
      ? line.match(/^\s*([^\s=]+)\s*=/)?.[1]
      : undefined;
    if (name && validCliCommand(name)) commands.push(name.toLowerCase());
  }
  return [...new Set(commands)];
}

export async function collectUvToolReceipts(input: {
  records: CliPathEndpointRecord[];
  environment: CliScanEnvironment;
  signal: AbortSignal;
  now(): number;
}): Promise<CliAdapterResult> {
  const startedAt = input.now();
  const packages: CliPackageRecord[] = [];
  const roots = [
    ...new Set(
      [
        input.environment.env.UV_TOOL_DIR,
        input.environment.env.APPDATA &&
          path.join(input.environment.env.APPDATA, "uv", "tools"),
        path.join(
          input.environment.homeDirectory,
          ".local",
          "share",
          "uv",
          "tools",
        ),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  for (const root of roots) {
    let tools;
    try {
      tools = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .slice(0, 500);
    } catch {
      continue;
    }
    for (const tool of tools) {
      if (input.signal.aborted) break;
      const installRoot = path.join(root, tool.name);
      const receipt = await readBoundedText(
        path.join(installRoot, "uv-receipt.toml"),
      );
      if (!receipt) continue;
      const entries = parseUvEntrypoints(receipt);
      const matches = input.records.filter(({ endpoint }) =>
        entries.some(
          (entry) =>
            entry.commandName === endpoint.commandName &&
            path.normalize(entry.targetPath).toLowerCase() ===
              path.normalize(endpoint.path).toLowerCase(),
        ),
      );
      if (!matches.length) continue;
      const name = receipt.match(
        /requirements\s*=\s*\[\s*\{\s*name\s*=\s*"([a-z0-9._-]+)"/i,
      )?.[1];
      if (!name) continue;
      packages.push({
        productId: discoveredPackageId("uv", name, input.environment.platform),
        sourceId: "uv",
        commandNames: matches.map(({ endpoint }) => endpoint.commandName),
        binEntries: entries,
        packageIdentity: {
          source: "uv",
          packageId: name,
          scope: "user",
          managerRoot: root,
          installRoot,
          ownershipConfidence: "corroborated",
          uninstallEvidence: "none",
        },
      });
    }
  }
  return {
    packageRecords: packages,
    sourceResults: [
      {
        sourceId: "uv",
        label: "uv tool receipts",
        status: "success",
        startedAt,
        finishedAt: input.now(),
        recordCount: packages.length,
      },
    ],
  };
}

export function parseUvEntrypoints(
  receipt: string,
): CliPackageRecord["binEntries"] {
  const declarations =
    receipt.match(/entrypoints\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  const result: CliPackageRecord["binEntries"] = [];
  for (const match of declarations.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1].match(/\bname\s*=\s*("(?:\\.|[^"\\])*")/)?.[1];
    const location = match[1].match(
      /\binstall-path\s*=\s*("(?:\\.|[^"\\])*")/,
    )?.[1];
    try {
      const commandName = name
        ? (JSON.parse(name) as string).replace(/\.exe$/i, "").toLowerCase()
        : "";
      const targetPath: unknown = location ? JSON.parse(location) : undefined;
      if (
        validCliCommand(commandName) &&
        typeof targetPath === "string" &&
        path.isAbsolute(targetPath) &&
        targetPath.length <= 1024 &&
        !targetPath.includes("\0")
      )
        result.push({ commandName, targetPath });
    } catch {
      /* Unsupported TOML string forms are not ownership evidence. */
    }
  }
  return result;
}

async function readBoundedText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size <= 512 * 1024
      ? await readFile(file, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
}
