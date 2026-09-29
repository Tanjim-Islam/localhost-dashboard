import fs from "node:fs/promises";
import path from "node:path";
import { RestartError, type LaunchContext, type ProcessSnapshot } from "./types";

// Parse literal POSIX words only. Expansion, redirection and command substitution
// are deliberately not interpreted. This is used to compare observed arguments,
// never to execute a shell string.
export function literalShellWords(text: string): string[] | null {
  const words: string[] = [];
  let word = "", quote = "", active = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = ""; else word += c;
      continue;
    }
    if (c === "\\") {
      if (++i >= text.length || text[i] === "\n") return null;
      if (quote === '"' && !/[\\$`"]/.test(text[i])) word += "\\";
      word += text[i]; active = true; continue;
    }
    if (c === '"') { quote = quote ? "" : '"'; active = true; continue; }
    if (c === "'" && !quote) { quote = "'"; active = true; continue; }
    if (/[$`\n\r]/.test(c) || (!quote && /[;&|<>()[\]*?~{}]/.test(c))) return null;
    if (!quote && /\s/.test(c)) {
      if (active) words.push(word);
      word = ""; active = false;
    } else { word += c; active = true; }
  }
  if (quote) return null;
  if (active) words.push(word);
  return words;
}

export function isNpmLauncher(context: LaunchContext): boolean {
  return /(?:^|[\\/])npm-cli\.js$/i.test(context.argv[1] || "") || /^npm (?:run|run-script|start|test)(?: |$)/.test(context.argv[0] || "");
}

type ResolvePath = (file: string) => Promise<string>;
async function canonical(file: string, cwd: string, resolvePath: ResolvePath): Promise<string | undefined> {
  try { return await resolvePath(path.posix.resolve(cwd, file)); } catch { return undefined; }
}

async function resolveCommand(command: string, context: LaunchContext, resolvePath: ResolvePath): Promise<string | undefined> {
  if (command.includes("/")) return canonical(command, context.cwd, resolvePath);
  for (const dir of (context.env.PATH || "").split(":")) {
    if (!dir) continue;
    const resolved = await canonical(path.posix.join(dir, command), context.cwd, resolvePath);
    if (resolved) return resolved;
  }
  return undefined;
}

export async function recoverNpmContexts(snapshot: ProcessSnapshot, platform: NodeJS.Platform, protectedPids = new Set<number>(), resolvePath: ResolvePath = fs.realpath): Promise<ProcessSnapshot> {
  if (platform !== "darwin") return snapshot;
  const contexts = [...snapshot.contexts];
  for (let index = 0; index < contexts.length; index++) {
    const npm = contexts[index];
    if (protectedPids.has(npm.pid)) continue;
    if (!/^npm (?:run|run-script|start|test)(?: |$)/.test(npm.argv[0] || "")) continue;
    let recovered: LaunchContext | undefined;
    for (const child of contexts) {
      const { npm_execpath: cli, npm_lifecycle_event: event, npm_lifecycle_script: script, npm_package_json: manifest } = child.env;
      if (!cli || !event || !script || !manifest || !path.posix.isAbsolute(cli) || !path.posix.isAbsolute(manifest) ||
          path.posix.basename(manifest) !== "package.json" || !/^[a-zA-Z0-9_.:@/-]+$/.test(event)) continue;
      let ancestor = snapshot.processes.find((p) => p.pid === child.pid);
      const seen = new Set<number>();
      while (ancestor && ancestor.pid !== npm.pid && !seen.has(ancestor.pid)) {
        seen.add(ancestor.pid);
        ancestor = snapshot.processes.find((p) => p.pid === ancestor!.ppid && p.startedMs <= ancestor!.startedMs);
      }
      if (ancestor?.pid !== npm.pid) continue;
      let extra: string[] | null = null;
      const shellIndex = child.argv.indexOf("-c");
      const shellCommand = shellIndex >= 0 ? child.argv[shellIndex + 1] : undefined;
      if (/\/(?:sh|bash|zsh)$/.test(child.executable) && shellCommand?.startsWith(script) &&
          (shellCommand.length === script.length || /\s/.test(shellCommand[script.length]))) {
        extra = literalShellWords(shellCommand.slice(script.length));
      } else {
        const words = literalShellWords(script);
        if (!words?.length) continue;
        const command = await resolveCommand(words[0], child, resolvePath);
        const executable = await canonical(child.executable, child.cwd, resolvePath);
        let offset = command && command === executable ? 1 : 0;
        if (!offset && command && child.argv[1] && command === await canonical(child.argv[1], child.cwd, resolvePath)) offset = 2;
        if (!offset) continue;
        const expected = words.slice(1), actual = child.argv.slice(offset);
        if (actual.length < expected.length) continue;
        let matches = true;
        for (let i = 0; i < expected.length; i++) {
          if (expected[i] === actual[i]) continue;
          const expectedPath = await canonical(expected[i], child.cwd, resolvePath);
          if (!expectedPath || expectedPath !== await canonical(actual[i], child.cwd, resolvePath)) { matches = false; break; }
        }
        if (matches) extra = actual.slice(expected.length);
      }
      if (!extra) continue;
      const env = { ...npm.env };
      // npm exports CLI config to its scripts. Preserve options such as script-shell
      // and ignore-scripts when reconstructing a title-overwritten launcher.
      for (const [key, value] of Object.entries(child.env)) if (key.startsWith("npm_config_")) env[key] = value;
      recovered = { ...npm, cwd: path.posix.dirname(manifest), env,
        argv: [npm.executable, cli, "run", event, "--", ...extra] };
      break;
    }
    if (!recovered) throw new RestartError("npm replaced its original arguments and they could not be recovered exactly. The server has been left running.");
    contexts[index] = recovered;
  }
  return { ...snapshot, contexts };
}
