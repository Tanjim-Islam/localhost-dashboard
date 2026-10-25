import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

export type ProjectEvidence = {
  directory: string;
  name: string;
  serviceDirectory: string;
  serviceName: string;
  associationKey: string;
};
export function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
export function serviceAssociationKey(
  cwd: string,
  executable: string,
  argv: string[],
): string {
  const args: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (/^(--port|-p)$/.test(argv[i]) && /^\d+$/.test(argv[i + 1] || "")) {
      i++;
      continue;
    }
    if (/^--port=\d+$/.test(argv[i])) continue;
    args.push(argv[i]);
  }
  return stableId(
    [pathIdentity(cwd), pathIdentity(executable), ...args].join("\0"),
  );
}
export function pathIdentity(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = (platform === "win32" ? path.win32 : path.posix)
    .normalize(value)
    .replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
async function manifest(
  dir: string,
): Promise<{ name?: string; workspaces?: unknown } | undefined> {
  try {
    const file = path.join(dir, "package.json");
    if ((await fs.stat(file)).size > 256 * 1024) return;
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      name:
        typeof value.name === "string"
          ? value.name.replace(/[\x00-\x1f]/g, "").slice(0, 120)
          : undefined,
      workspaces: value.workspaces,
    };
  } catch {
    return;
  }
}

// Only walk ancestors, never traverse a project. Bound reads and cache by launch context.
export class ProjectIdentifier {
  private cache = new Map<string, { until: number; value?: ProjectEvidence }>();
  async identify(
    cwd: string,
    argv: string[],
    executable: string,
  ): Promise<ProjectEvidence | undefined> {
    const entry = argv
      .slice(1)
      .find((arg) => path.isAbsolute(arg) && !arg.startsWith("-"));
    const key = stableId([cwd, entry || "", executable].join("\0"));
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    const candidates = [cwd];
    if (entry) {
      const moduleAt = entry.replace(/\\/g, "/").indexOf("/node_modules/");
      candidates.push(
        moduleAt >= 0 ? entry.slice(0, moduleAt) : path.dirname(entry),
      );
    }
    const found = (
      await Promise.all(
        candidates.filter(Boolean).map((dir) => this.resolve(dir)),
      )
    ).filter((v): v is Omit<ProjectEvidence, "associationKey"> => !!v);
    // A verified CWD and an unrelated absolute script are conflicting evidence.
    const roots = new Set(found.map((v) => pathIdentity(v.directory)));
    const value =
      roots.size === 1 ? { ...found[0], associationKey: key } : undefined;
    if (this.cache.size >= 1000)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { until: Date.now() + 60000, value });
    return value;
  }
  private async resolve(
    input: string,
  ): Promise<Omit<ProjectEvidence, "associationKey"> | undefined> {
    if (!path.isAbsolute(input)) return;
    let start: string;
    try {
      start = await fs.realpath(input);
      if (!(await fs.stat(start)).isDirectory()) return;
    } catch {
      return;
    }
    // Do not identify globally installed tools or application bundles as projects.
    if (
      /^\/(?:opt\/(?:homebrew|local)(?:\/|$)|usr\/local\/(?:Homebrew|Cellar|opt|var|lib|bin|sbin)(?:\/|$))/.test(
        start,
      ) ||
      /[\\/](node_modules|\.cargo|\.rustup|Windows|Program Files(?: \(x86\))?|WindowsApps)([\\/]|$)|\.app[\\/]Contents[\\/]/i.test(
        start,
      )
    )
      return;
    let dir = start;
    let nearest: { dir: string; name?: string } | undefined;
    let workspace: { dir: string; name?: string } | undefined;
    for (
      let depth = 0;
      depth < 12 && path.dirname(dir) !== dir;
      depth++, dir = path.dirname(dir)
    ) {
      // A manifest in the user home or a global tooling folder is not project evidence.
      if (
        pathIdentity(dir) === pathIdentity(os.homedir()) ||
        /[\\/](AppData|ProgramData|Users|tmp|temp)$/i.test(dir)
      )
        break;
      const pkg = await manifest(dir);
      const [python, cargo, go, git, pnpm] = await Promise.all(
        [
          "pyproject.toml",
          "Cargo.toml",
          "go.mod",
          ".git",
          "pnpm-workspace.yaml",
        ].map((file) => exists(path.join(dir, file))),
      );
      if (!nearest && (pkg || python || cargo || go || git))
        nearest = { dir, name: pkg?.name };
      if (pkg?.workspaces || pnpm) workspace = { dir, name: pkg?.name };
      if (git) {
        workspace ??= { dir, name: pkg?.name };
        break;
      } // A nested repository is its own project.
    }
    if (!nearest) return;
    const root = workspace || nearest;
    return {
      directory: root.dir,
      name: root.name || path.basename(root.dir),
      serviceDirectory: nearest.dir,
      serviceName:
        nearest.dir === root.dir
          ? ""
          : nearest.name || path.basename(nearest.dir),
    };
  }
}
