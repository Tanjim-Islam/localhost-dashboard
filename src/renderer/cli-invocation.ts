import type {
  CliExecutableEndpoint,
  CliInstallation,
  CliInventorySnapshot,
} from "../main/clis/types";
import { getPrimaryCliCommand } from "./cli-view-model";

export type CliShell = "powershell" | "cmd" | "posix";

export function getCliInvocation(
  inventory: CliInventorySnapshot,
  installation: CliInstallation,
  shell: CliShell,
): string | undefined {
  const command = getPrimaryCliCommand(
    inventory.products.find((item) => item.id === installation.productId),
    inventory.commands.filter(
      (item) => item.installationId === installation.id,
    ),
  );
  if (!command) return undefined;
  const endpoints = inventory.endpoints
    .filter(
      (endpoint) =>
        command.endpointIds.includes(endpoint.id) &&
        endpoint.accessible &&
        endpoint.executable &&
        endpoint.targetExists,
    )
    .sort((a, b) => endpointRank(a, shell) - endpointRank(b, shell));
  for (const endpoint of endpoints) {
    const extension = endpoint.path.match(/\.[^.\\/]+$/)?.[0].toLowerCase();
    let args = [endpoint.path];
    if (installation.platform === "win32") {
      if ([".js", ".mjs", ".cjs"].includes(extension ?? "")) {
        const nodePath = installation.packageIdentity?.managerExecutablePath;
        if (!nodePath || !/[\\/]node\.exe$/i.test(nodePath)) continue;
        args = [nodePath, endpoint.path];
      } else if (extension === ".ps1") {
        if (shell !== "powershell") continue;
      } else if (![".exe", ".com", ".cmd", ".bat"].includes(extension ?? ""))
        continue;
    }
    // The terminal can have a different PATH or aliases from Electron.
    if (shell === "powershell") return `& ${args.map(quotePosh).join(" ")}`;
    if (shell === "posix") return args.map(quotePosix).join(" ");
    if (args.some((arg) => /[%!"\r\n]/.test(arg))) continue;
    return args.map((arg) => `"${arg}"`).join(" ");
  }
  return undefined;
}

function endpointRank(
  endpoint: CliExecutableEndpoint,
  shell: CliShell,
): number {
  const extension = endpoint.path.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? "";
  const extensions =
    shell === "posix"
      ? ["", ".sh"]
      : [".exe", ".com", ".cmd", ".bat", ".ps1", ".js", ".mjs", ".cjs"];
  const rank = extensions.indexOf(extension);
  return rank < 0 ? 99 : rank;
}
function quotePosh(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
