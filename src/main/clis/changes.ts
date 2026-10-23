import { lstat } from "node:fs/promises";
import { normalizeCliPath } from "./fingerprint";
import type { CliInstallation, CliInventorySnapshot } from "./types";

export type CliChangeKind =
  | "added"
  | "removed"
  | "version"
  | "executable"
  | "path"
  | "precedence"
  | "ownership"
  | "availability"
  | "uncertain";
export type CliChange = {
  productId: string;
  name: string;
  installationId?: string;
  kind: CliChangeKind;
  before?: string;
  after?: string;
};
export type CliChanges = {
  schemaVersion: 1;
  comparedAt: number;
  baselineAt: number;
  entries: CliChange[];
  truncated: boolean;
};
const kinds: CliChangeKind[] = [
  "added",
  "removed",
  "version",
  "executable",
  "path",
  "precedence",
  "ownership",
  "availability",
  "uncertain",
];
const clean = (v: unknown) =>
  typeof v === "string"
    ? v.replace(/[\x00-\x1f]/g, " ").slice(0, 2048)
    : undefined;
export function sanitizeCliChanges(value: unknown): CliChanges | undefined {
  const v = value as CliChanges | undefined;
  if (
    !v ||
    v.schemaVersion !== 1 ||
    !Number.isFinite(v.comparedAt) ||
    !Number.isFinite(v.baselineAt) ||
    !Array.isArray(v.entries)
  )
    return;
  return {
    schemaVersion: 1,
    comparedAt: v.comparedAt,
    baselineAt: v.baselineAt,
    truncated: !!v.truncated || v.entries.length > 200,
    entries: v.entries
      .slice(0, 200)
      .filter(
        (e) => e && kinds.includes(e.kind) && typeof e.productId === "string",
      )
      .map((e) => ({
        productId: clean(e.productId)!,
        name: clean(e.name) || "CLI",
        kind: e.kind,
        ...(e.installationId
          ? { installationId: clean(e.installationId) }
          : {}),
        ...(e.before ? { before: clean(e.before) } : {}),
        ...(e.after ? { after: clean(e.after) } : {}),
      })),
  };
}
const admitted = (i: CliInstallation) =>
  i.origin !== "application-embedded" &&
  i.origin !== "sdk-bundled" &&
  (i.discoveryKind !== "candidate" || i.includedByUser);

// Missing paths alone are insufficient on a partial scan. Permission failures,
// failed probes, missing package sources, and skipped sources are never removals.
export async function confirmedAbsent(
  previous: CliInventorySnapshot | null,
  next: CliInventorySnapshot,
): Promise<Set<string>> {
  const absent = new Set<string>();
  if (
    !previous ||
    next.completeness !== "complete" ||
    next.sourceResults.some((s) => s.status === "failed" || s.errorCode)
  )
    return absent;
  for (const old of previous.installations.filter(admitted)) {
    if (next.installations.some((i) => i.id === old.id)) continue;
    const endpoints = previous.endpoints.filter((e) =>
      old.endpointIds.includes(e.id),
    );
    if (!endpoints.length) continue;
    let allMissing = true;
    for (const endpoint of endpoints) {
      try {
        // A dangling shim/symlink is unavailable, not a removed installation.
        await lstat(endpoint.path);
        allMissing = false;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          allMissing = false;
          break;
        }
      }
    }
    if (allMissing) absent.add(old.id);
  }
  return absent;
}

export function compareCliInventories(
  previous: CliInventorySnapshot | null,
  next: CliInventorySnapshot,
  absent = new Set<string>(),
): CliChanges | undefined {
  if (!previous || previous.platform !== next.platform) return;
  const entries: CliChange[] = [];
  const norm = (p: string) => normalizeCliPath(p, next.platform);
  const oldItems = previous.installations.filter(admitted),
    newItems = next.installations.filter(admitted);
  const matched = new Set<string>();
  const paths = (snapshot: CliInventorySnapshot, item: CliInstallation) =>
    snapshot.endpoints
      .filter((e) => item.endpointIds.includes(e.id))
      .map((e) => norm(e.canonicalPath || e.path))
      .sort();
  const owner = (i: CliInstallation) =>
    i.packageIdentity
      ? [
          i.packageIdentity.source,
          i.packageIdentity.packageId,
          i.packageIdentity.scope,
          norm(i.packageIdentity.managerRoot || ""),
        ].join(" | ")
      : "Unknown";
  const push = (
    item: CliInstallation,
    kind: CliChangeKind,
    before?: string,
    after?: string,
  ) =>
    entries.push({
      productId: item.productId,
      installationId: item.id,
      name:
        next.products.find((p) => p.id === item.productId)?.displayName ||
        previous.products.find((p) => p.id === item.productId)?.displayName ||
        item.productId,
      kind,
      before,
      after,
    });
  for (const item of newItems) {
    let old = oldItems.find((i) => i.id === item.id);
    if (!old) {
      // Join only unambiguous ownership or exact endpoint identities, never names.
      const equivalent = (a: CliInstallation, b: CliInstallation) =>
        a.productId === b.productId &&
        ((a.packageIdentity && b.packageIdentity && owner(a) === owner(b)) ||
          paths(previous, a).some((p) => paths(next, b).includes(p)));
      const candidates = oldItems.filter(
        (i) => !matched.has(i.id) && equivalent(i, item),
      );
      if (
        candidates.length === 1 &&
        newItems.filter((i) => equivalent(candidates[0], i)).length === 1
      )
        old = candidates[0];
    }
    if (!old) {
      if (item.presence === "present")
        push(item, "added", undefined, paths(next, item).join("\n"));
      continue;
    }
    matched.add(old.id);
    if (
      item.presence !== "present" ||
      item.issueCodes.includes("package-source-unavailable")
    ) {
      push(item, "uncertain", undefined, "Could not verify");
      continue;
    }
    if (
      old.version &&
      item.version &&
      old.version !== item.version &&
      item.versionSource !== "cached"
    )
      push(item, "version", old.version, item.version);
    if (
      JSON.stringify(paths(previous, old)) !== JSON.stringify(paths(next, item))
    )
      push(
        item,
        "path",
        paths(previous, old).join("\n"),
        paths(next, item).join("\n"),
      );
    if (owner(old) !== owner(item))
      push(item, "ownership", owner(old), owner(item));
    if (old.presence !== item.presence || old.health !== item.health)
      push(
        item,
        "availability",
        `${old.presence} · ${old.health}`,
        `${item.presence} · ${item.health}`,
      );
    const roles = (s: CliInventorySnapshot, i: CliInstallation) =>
      s.commands
        .filter((c) => c.installationId === i.id)
        .map((c) => {
          const positions = s.endpoints
            .filter(
              (e) => c.endpointIds.includes(e.id) && e.pathIndex !== undefined,
            )
            .map((e) => e.pathIndex!);
          return `${c.name}: ${c.pathRole}${positions.length ? ` (PATH position ${Math.min(...positions) + 1})` : ""}`;
        })
        .sort()
        .join(", ");
    if (roles(previous, old) !== roles(next, item))
      push(item, "precedence", roles(previous, old), roles(next, item));
  }
  for (const old of oldItems)
    if (!matched.has(old.id) && !newItems.some((i) => i.id === old.id))
      push(
        old,
        next.completeness === "complete" && absent.has(old.id)
          ? "removed"
          : "uncertain",
        paths(previous, old).join("\n"),
        next.completeness === "complete" && absent.has(old.id)
          ? undefined
          : "Could not verify",
      );
  const active = (s: CliInventorySnapshot) =>
    new Map(
      s.commands
        .filter((c) => c.pathRole === "active" && c.activeEndpointId)
        .map((c) => [
          `${c.productId}:${c.name}`,
          { c, endpoint: s.endpoints.find((e) => e.id === c.activeEndpointId) },
        ]),
    );
  const beforeActive = active(previous);
  for (const [key, value] of active(next)) {
    const old = beforeActive.get(key);
    const item = newItems.find((i) => i.id === value.c.installationId);
    if (
      item &&
      old?.endpoint &&
      value.endpoint &&
      norm(old.endpoint.path) !== norm(value.endpoint.path)
    )
      push(item, "executable", old.endpoint.path, value.endpoint.path);
  }
  return sanitizeCliChanges({
    schemaVersion: 1,
    comparedAt: next.generatedAt,
    baselineAt: previous.generatedAt,
    entries,
    truncated: entries.length > 200,
  });
}
