import path from "node:path";
import type { ApplicationOwner, ServerInfo } from "../../shared/servers";
import type {
  LaunchContext,
  ProcessIdentity,
  ProcessSnapshot,
} from "../server-restart/types";
import { developmentRuntime, serviceLabel } from "./discovery";
import type { ProjectEvidence } from "./identify";

const runtimeName =
  /^(node|nodejs|bun|deno|python[\d.]*|ruby[\d.]*|php[\d.]*|dotnet|java|go|uvicorn|gunicorn)$/i;
const shellName =
  /^(cmd|powershell|pwsh|bash|zsh|sh|fish|terminal|windowsterminal|conhost|explorer|launchd|services|svchost|system)$/i;
const baseName = (file: string) =>
  file
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, "") || "";
const cleanName = (value: string) =>
  value.replace(/[\x00-\x1f]/g, "").slice(0, 120);
const applicationNames: Record<string, string> = {
  code: "Visual Studio Code",
  raycast: "Raycast",
  "com.docker.backend": "Docker",
  electron: "Electron",
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  firefox: "Firefox",
  brave: "Brave",
  idmintegrator64: "Internet Download Manager",
  ollama: "Ollama",
};
const appName = (value: string) =>
  applicationNames[value.toLowerCase()] || cleanName(value);

function inside(
  file: string,
  directory: string,
  platform: NodeJS.Platform,
): boolean {
  const api = platform === "win32" ? path.win32 : path.posix;
  const normalize = (p: string) =>
    platform === "win32" ? api.normalize(p).toLowerCase() : api.normalize(p);
  const relative = api.relative(normalize(directory), normalize(file));
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${api.sep}`) &&
    !api.isAbsolute(relative)
  );
}

function installedDirectory(file: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? /[\\/](?:Program Files(?: \(x86\))?|WindowsApps)[\\/]|[\\/]AppData[\\/](?:Local|Roaming)[\\/]/i.test(
        file,
      )
    : /^\/(?:Applications|System\/Applications|System\/Library|usr\/libexec)\//.test(
        file,
      ) || /\/Applications\/[^/]+\.app\/Contents\//.test(file);
}

// Ownership requires an actual bundle or a shared installation with a verified
// ancestor. An IDE/terminal ancestor alone never makes an external Node app bundled.
export function applicationOwner(
  snapshot: ProcessSnapshot,
  pid: number,
  platform: NodeJS.Platform,
): ApplicationOwner | undefined {
  const process = snapshot.processes.find((p) => p.pid === pid);
  if (!process) return;
  const executable = process.executable;
  if (platform === "darwin") {
    const bundle = executable.match(/^(.*?\/([^/]+)\.app)\/Contents\//);
    if (bundle)
      return { name: appName(bundle[2]), executable, evidence: "app-bundle" };
  }
  const api = platform === "win32" ? path.win32 : path.posix;
  let current: ProcessIdentity | undefined = process;
  const visited = new Set<number>();
  for (let depth = 0; current && depth < 12; depth++) {
    if (visited.has(current.pid)) break;
    visited.add(current.pid);
    const parent = snapshot.processes.find(
      (p) => p.pid === current!.ppid && p.startedMs <= current!.startedMs,
    );
    if (!parent) break;
    const name = baseName(parent.executable);
    if (
      !runtimeName.test(name) &&
      !shellName.test(name) &&
      installedDirectory(parent.executable, platform) &&
      inside(executable, api.dirname(parent.executable), platform)
    ) {
      return {
        name: appName(name),
        executable: parent.executable,
        evidence: "bundled-runtime",
      };
    }
    current = parent;
  }
  const name = baseName(executable);
  // Portable browsers and development Electron builds also expose internal
  // listeners. Their working directory is not a development-server project.
  if (/^(electron|chrome|msedge|firefox|brave|code)$/i.test(name))
    return { name: appName(name), executable, evidence: "application-process" };
  if (
    !runtimeName.test(name) &&
    !shellName.test(name) &&
    installedDirectory(executable, platform)
  ) {
    return { name: appName(name), executable, evidence: "application-process" };
  }
}

export type ListenerClassification = Pick<
  ServerInfo,
  "discovery" | "serviceName" | "framework" | "application"
>;
export function classifyListener(input: {
  name?: string;
  context?: Pick<LaunchContext, "executable" | "argv" | "cwd">;
  evidence?: ProjectEvidence;
  application?: ApplicationOwner;
  platform?: NodeJS.Platform;
}): ListenerClassification {
  const { context, evidence, application } = input;
  const name = input.name || baseName(context?.executable || "");
  const framework = developmentRuntime(name, context?.argv.join(" "));
  if (application)
    return {
      discovery: "application",
      serviceName: application.name,
      framework,
      application,
    };
  const args = context?.argv.slice(1) || [];
  // A runtime name by itself is not evidence of a development server.
  const script = args.some((arg) =>
    /\.(?:[cm]?js|ts|py|rb|php)(?:$)/i.test(arg),
  );
  const inlineServer = args.some((arg) =>
    /createServer\s*\(|http\.server|SimpleHTTPServer/.test(arg),
  );
  const frameworkCommand =
    framework &&
    ![
      "Node.js",
      "Python",
      "Java",
      ".NET",
      "Bun",
      "Deno",
      "Go",
      "ruby",
      "php",
    ].includes(framework);
  const platform = input.platform || process.platform;
  const installedScript =
    !!context &&
    installedDirectory(context.executable, platform) &&
    args.some(
      (arg) =>
        /\.(?:[cm]?js|ts|py|rb|php)$/i.test(arg) &&
        installedDirectory(arg, platform),
    );
  const development = !!(
    evidence ||
    (context &&
      (frameworkCommand ||
        (runtimeName.test(baseName(name)) &&
          !installedScript &&
          (script || inlineServer))))
  );
  return {
    discovery: development ? "development" : "unidentified",
    framework,
    serviceName: serviceLabel(framework),
  };
}
