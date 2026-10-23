import type {
  CliChanges as Changes,
  CliChangeKind,
} from "../../../main/clis/changes";

const labels: Record<CliChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  version: "Version changed",
  executable: "Active executable changed",
  path: "Installation path changed",
  precedence: "PATH precedence changed",
  ownership: "Ownership changed",
  availability: "Availability changed",
  uncertain: "Could not verify",
};
export function CliChanges({ changes }: { changes?: Changes }) {
  if (!changes) return null;
  const count = (kind: CliChangeKind) =>
    new Set(
      changes.entries.filter((e) => e.kind === kind).map((e) => e.productId),
    ).size;
  const summary = (
    [
      ["added", "added"],
      ["removed", "removed"],
      ["version", "updated"],
      ["executable", "executable changed"],
      ["path", "path changed"],
      ["precedence", "PATH changed"],
      ["ownership", "ownership changed"],
      ["availability", "availability changed"],
      ["uncertain", "could not verify"],
    ] as [CliChangeKind, string][]
  )
    .filter(([kind]) => count(kind))
    .map(([kind, label]) => `${count(kind)} ${label}`)
    .join(" · ");
  if (!changes.entries.length)
    return (
      <p role="status" className="text-xs text-gray-600">
        No changes in the last scan.
      </p>
    );
  return (
    <details className="rounded-lg border border-gray-300/50 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-gray-700">{summary}</summary>
      <ul className="mt-2 divide-y divide-gray-300/40">
        {changes.entries.map((e, i) => (
          <li key={`${e.productId}-${i}`} className="py-2">
            <div>
              <strong className="font-medium">{e.name}</strong>
              <span
                className={`ml-2 text-xs ${e.kind === "uncertain" ? "text-status-review-text" : "text-gray-600"}`}
              >
                {labels[e.kind]}
              </span>
            </div>
            {(e.before || e.after) && (
              <div className="mt-1 break-all whitespace-pre-wrap font-mono text-xs text-gray-600">
                {e.before && <div>{e.before}</div>}
                {e.after && (
                  <div>
                    {e.before ? "→ " : ""}
                    {e.after}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {changes.truncated && (
        <p className="text-xs text-gray-600">Showing the first 200 changes.</p>
      )}
    </details>
  );
}
