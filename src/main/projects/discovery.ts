import type { ServerInfo, ServerRef } from "../../shared/servers";

export function developmentRuntime(
  name = "",
  command = "",
): string | undefined {
  const base = name.toLowerCase().replace(/\.exe$/, "");
  if (
    /^(electron|chrome|msedge|code|svchost|system|services|controlcenter)$/.test(
      base,
    )
  )
    return;
  const frameworks: [RegExp, string][] = [
    [/\bvite\b/i, "Vite"],
    [/\bnext\b/i, "Next.js"],
    [/\bnuxt\b/i, "Nuxt"],
    [/\bastro\b/i, "Astro"],
    [/\bangular\b/i, "Angular"],
    [/\buvicorn\b/i, "Uvicorn"],
    [/\bgunicorn\b/i, "Gunicorn"],
    [/\bdjango\b|manage\.py/i, "Django"],
    [/\bodoo(?:-bin|\.py)?\b/i, "Odoo"],
    [/\bflask\b/i, "Flask"],
    [/\bfastapi\b/i, "FastAPI"],
    [/\bhttp\.server\b|\bSimpleHTTPServer\b/i, "Python HTTP"],
    [/\brails\b/i, "Rails"],
  ];
  for (const [test, label] of frameworks) if (test.test(command)) return label;
  if (
    /^(node|nodejs|bun|deno|python[\d.]*|ruby[\d.]*|php[\d.]*|dotnet|java|go|uvicorn|gunicorn)$/.test(
      base,
    )
  ) {
    return (
      (
        {
          node: "Node.js",
          nodejs: "Node.js",
          dotnet: ".NET",
          java: "Java",
          bun: "Bun",
          deno: "Deno",
          go: "Go",
        } as Record<string, string>
      )[base] || (/^python/.test(base) ? "Python" : base)
    );
  }
}
export function serviceLabel(framework?: string): string {
  if (["Vite", "Next.js", "Nuxt", "Astro", "Angular"].includes(framework || ""))
    return "Frontend";
  if (
    ["Uvicorn", "Gunicorn", "Django", "Rails", "Flask", "FastAPI"].includes(
      framework || "",
    )
  )
    return "API";
  return framework || "Local listener";
}

// systeminformation reports start times at second precision. Gaining native
// metadata must not turn that same process into a stopped/replaced instance.
export function sameObservedStart(
  previous: string | undefined,
  next: string | undefined,
  nativeComparison: boolean,
  coarseChanged = false,
): boolean {
  // A fresh native identity outranks a changed, estimated ps start timestamp.
  // Without it, a changed coarse observation cannot preserve an old instance.
  if (coarseChanged && !nativeComparison) return false;
  if (!previous || !next) return true;
  const before = Date.parse(previous),
    after = Date.parse(next);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return true;
  return nativeComparison ? before === after : Math.abs(before - after) <= 2000;
}

// Only successful observations advance disappearance counts.
export class ListenerTracker {
  private items = new Map<string, ServerInfo>();
  private missing = new Map<string, number>();
  values(): ServerInfo[] {
    return [...this.items.values()];
  }
  // Only retire the observed instance, never a replacement using the same key.
  retire(refs: ServerRef[]): ServerInfo[] {
    const removed: ServerInfo[] = [];
    for (const ref of refs) {
      const item = this.items.get(ref.key);
      if (!item || item.firstSeen !== ref.firstSeen) continue;
      removed.push(item);
      this.items.delete(ref.key);
      this.missing.delete(ref.key);
    }
    return removed;
  }
  checkPresence(refs: ServerRef[], keys: Set<string>): ServerInfo[] {
    const absent: ServerRef[] = [];
    for (const ref of refs) {
      const item = this.items.get(ref.key);
      if (!item || item.firstSeen !== ref.firstSeen) continue;
      if (keys.has(ref.key)) this.missing.delete(ref.key);
      else {
        const count = (this.missing.get(ref.key) || 0) + 1;
        this.missing.set(ref.key, count);
        if (count >= 2) absent.push(ref);
      }
    }
    return this.retire(absent);
  }
  reconcile(
    observed: ServerInfo[],
    trackPresence: boolean | ((item: ServerInfo) => boolean) = true,
  ): {
    items: ServerInfo[];
    added: ServerInfo[];
    removed: ServerInfo[];
  } {
    const added: ServerInfo[] = [],
      removed: ServerInfo[] = [];
    const tracksPresence = (item: ServerInfo) =>
      typeof trackPresence === "function" ? trackPresence(item) : trackPresence;
    const keys = new Set(observed.map((s) => s.key));
    for (const item of observed) {
      const old = this.items.get(item.key);
      if (old && old.firstSeen !== item.firstSeen) removed.push(old);
      if (!old || old.firstSeen !== item.firstSeen) added.push(item);
      this.items.set(item.key, item);
      if (tracksPresence(item) || !old || old.firstSeen !== item.firstSeen)
        this.missing.delete(item.key);
    }
    for (const [key, item] of this.items)
      if (tracksPresence(item) && !keys.has(key)) {
        const count = (this.missing.get(key) || 0) + 1;
        this.missing.set(key, count);
        if (count >= 2) {
          removed.push(item);
          this.items.delete(key);
          this.missing.delete(key);
        }
      }
    return { items: this.values(), added, removed };
  }
}
