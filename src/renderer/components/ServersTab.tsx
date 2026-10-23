import { useEffect, useMemo, useState } from "react";
import { Bookmark, Pin } from "lucide-react";
import type {
  Project,
  ProjectSnapshot,
  ServerInfo,
  ServerRef,
  StopPreview,
  StopResult,
  StopScope,
} from "../../shared/servers";
import type { HealthStatus } from "../../types/preload";
import type { RestartProgress } from "../../main/server-restart/types";
import Modal from "./Modal";
import ProjectEditor from "./servers/ProjectEditor";
import ActivityDialog from "./servers/ActivityDialog";
import ProjectActions from "./servers/ProjectActions";
import ProjectMenu from "./servers/ProjectMenu";
import ServiceRow from "./servers/ServiceRow";
import { button, input, date } from "./servers/presentation";

const empty: ProjectSnapshot = {
  projects: [],
  activity: [],
  recentlyStopped: [],
  legacyNotes: [],
};
const identity = (s: ServerRef) => `${s.key}/${s.firstSeen}`;
export default function ServersTab({
  items,
  health,
  query,
  platform,
}: {
  items: ServerInfo[];
  health: Record<string, HealthStatus>;
  query: string;
  platform?: string;
}) {
  const [data, setData] = useState(empty);
  const [selected, setSelected] = useState<ServerRef[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<StopPreview | null>(null);
  const [results, setResults] = useState<StopResult[] | null>(null);
  const [edit, setEdit] = useState<Project | null>(null);
  const [assign, setAssign] = useState<ServerInfo | null>(null);
  const [association, setAssociation] = useState("");
  const [history, setHistory] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [restart, setRestart] = useState<RestartProgress | null>(null);
  const restartBusy =
    !!restart && ["preparing", "stopping", "starting"].includes(restart.phase);
  const locked = busy || restartBusy;
  useEffect(() => {
    void window.api
      .getProjects()
      .then(setData)
      .catch(() => setError("Projects could not be loaded."));
    void window.api.getServerRestartState().then(setRestart);
    const off = window.api.onProjectsUpdate(setData),
      offRestart = window.api.onServerRestartProgress(setRestart);
    return () => {
      off();
      offRestart();
    };
  }, []);
  useEffect(() => {
    setSelected((current) =>
      current.filter((ref) => items.some((i) => identity(i) === identity(ref))),
    );
  }, [items]);
  useEffect(() => {
    if (restart?.phase !== "ready") return;
    const timer = setTimeout(() => setRestart(null), 3000);
    return () => clearTimeout(timer);
  }, [restart]);
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(
              /^Error invoking remote method '[^']+': (Error: )?/,
              "",
            )
          : "Action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const prepareStop = (scope: StopScope) =>
    void run(async () => {
      setResults(null);
      setPreview(await window.api.previewStopServers(scope));
    });
  const startRestart = (item: ServerInfo) =>
    void run(async () => {
      setRestart({
        key: item.key,
        port: item.port,
        phase: "preparing",
        message: "Checking launch settings",
      });
      try {
        const result = await window.api.restartServer(item);
        setRestart({
          key: item.key,
          port: item.port,
          phase: result.ok ? "ready" : "failed",
          message: result.message,
        });
      } catch {
        setRestart({
          key: item.key,
          port: item.port,
          phase: "failed",
          message: "Restart could not be confirmed. Refresh before retrying.",
        });
      }
    });
  const matches = (s: ServerInfo, p?: Project) =>
    [
      s.serviceName,
      s.framework,
      s.processName,
      s.pid,
      s.port,
      p?.name,
      p?.directory,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  const groups = useMemo(
    () =>
      data.projects
        .filter(
          (p) =>
            (showAll ||
              p.pinned ||
              p.bookmarked ||
              items.some((s) => s.projectId === p.id)) &&
            (!query ||
              [p.name, p.directory]
                .join(" ")
                .toLowerCase()
                .includes(query.toLowerCase()) ||
              items.some((s) => s.projectId === p.id && matches(s, p))),
        )
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name),
        ),
    [data.projects, items, query, showAll],
  );
  const unidentified = items.filter(
    (s) => !s.projectId && s.discovery === "development" && matches(s),
  );
  const other = items.filter(
    (s) => s.discovery === "unidentified" && matches(s),
  );
  const visibleIds = new Set(
    items
      .filter(
        (s) =>
          matches(
            s,
            data.projects.find((p) => p.id === s.projectId),
          ) && s.discovery === "development",
      )
      .map(identity),
  );
  const hiddenSelection = selected.filter(
    (s) => !visibleIds.has(identity(s)),
  ).length;
  const toggle = (s: ServerInfo) =>
    setSelected((current) =>
      current.some((r) => identity(r) === identity(s))
        ? current.filter((r) => identity(r) !== identity(s))
        : [...current, { key: s.key, firstSeen: s.firstSeen }],
    );
  const row = (s: ServerInfo) => (
    <ServiceRow
      key={identity(s)}
      item={s}
      health={health[s.key]}
      selected={selected.some((r) => identity(r) === identity(s))}
      locked={locked}
      onSelect={() => toggle(s)}
      onStop={() => prepareStop({ refs: [s] })}
      onRestart={
        platform === "win32" || platform === "darwin"
          ? () => startRestart(s)
          : undefined
      }
      restarting={restartBusy && restart?.key === s.key}
      onAssign={() => {
        setAssign(s);
        setAssociation(s.projectId || "");
      }}
    />
  );
  return (
    <section aria-label="Projects and services" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            className={`${button} ${showAll ? "bg-gray-300" : "bg-gray-200"}`}
            aria-pressed={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            All projects
          </button>
          <button
            className={button}
            disabled={locked}
            onClick={() =>
              void run(async () => setData(await window.api.addProject()))
            }
          >
            Add project
          </button>
          <button className={button} onClick={() => setHistory("all")}>
            Activity
          </button>
        </div>
        {selected.length > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <span>
              {selected.length} selected
              {hiddenSelection ? ` · ${hiddenSelection} hidden by search` : ""}
            </span>
            <button className={button} onClick={() => setSelected([])}>
              Clear
            </button>
            <button
              className={`${button} bg-danger-surface text-danger-text`}
              disabled={locked}
              onClick={() => prepareStop({ refs: selected })}
            >
              Stop Selected
            </button>
          </div>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="flex justify-between gap-3 text-sm text-danger-text"
        >
          <span>{error}</span>
          <button onClick={() => setError("")} className="underline">
            Dismiss
          </button>
        </div>
      )}
      {restart && (
        <div
          role={restart.phase === "failed" ? "alert" : "status"}
          className={`flex gap-3 text-sm ${restart.phase === "failed" ? "text-danger-text" : restart.phase === "ready" ? "text-success-text" : "text-gray-600"}`}
        >
          <span>
            :{restart.port} · {restart.message}
          </span>
          {!restartBusy && (
            <button onClick={() => setRestart(null)} className="underline">
              Dismiss
            </button>
          )}
        </div>
      )}
      <div
        className="grid items-start gap-4"
        style={{
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 480px), 1fr))",
        }}
      >
        {groups.map((p) => {
          const services = items.filter((s) => s.projectId === p.id),
            shown = services.filter((s) => matches(s, p));
          return (
            <article
              key={p.id}
              className="app-card min-w-0 rounded-xl border border-gray-300/50 bg-gray-100/95"
            >
              <header className="flex items-start justify-between gap-2 p-4 pb-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    {p.pinned && <Pin size={13} aria-label="Pinned" />}
                    {p.bookmarked && (
                      <Bookmark size={13} aria-label="Bookmarked" />
                    )}
                    <span className="truncate">{p.name}</span>
                    <span className="text-xs font-normal text-gray-600">
                      {services.length || "Stopped"}
                    </span>
                  </h2>
                  <div
                    className="mt-1 truncate font-mono text-xs text-gray-600"
                    title={p.directory}
                  >
                    {p.directory}
                  </div>
                </div>
                <ProjectMenu
                  project={p}
                  onEdit={() => setEdit({ ...p })}
                  onPin={() =>
                    void run(async () =>
                      setData(
                        await window.api.editProject({
                          ...p,
                          pinned: !p.pinned,
                        }),
                      ),
                    )
                  }
                  onBookmark={() =>
                    void run(async () =>
                      setData(
                        await window.api.editProject({
                          ...p,
                          bookmarked: !p.bookmarked,
                        }),
                      ),
                    )
                  }
                  onActivity={() => setHistory(p.id)}
                  stopDisabled={
                    locked || !services.some((s) => s.canStop && s.association)
                  }
                  onStop={() =>
                    prepareStop({
                      projectId: p.id,
                      refs: services.filter((s) => s.canStop && s.association),
                    })
                  }
                />
              </header>
              {p.notes && (
                <button
                  className="mx-4 mb-2 block max-w-[calc(100%-2rem)] truncate text-left text-sm text-gray-700"
                  onClick={() => setEdit({ ...p })}
                >
                  {p.notes}
                </button>
              )}
              <div className="divide-y divide-gray-300/40">
                {shown.map(row)}
              </div>
              <div className="flex gap-1 border-t border-gray-300/40 px-3 py-2">
                <ProjectActions project={p} onError={setError} />
              </div>
            </article>
          );
        })}
        {unidentified.length > 0 && (
          <article className="min-w-0 rounded-xl border border-gray-300/50 bg-gray-100/95">
            <h2 className="px-4 py-3 text-sm font-semibold">
              Unassigned services
            </h2>
            <div className="divide-y divide-gray-300/40">
              {unidentified.map(row)}
            </div>
          </article>
        )}
      </div>
      {!groups.length && !unidentified.length && (
        <p className="py-8 text-center text-sm text-gray-600">
          {query ? "No matching services." : "No development servers running."}
        </p>
      )}
      {data.recentlyStopped.length > 0 && (
        <details className="rounded-xl border border-gray-300/40 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Recently stopped{" "}
            <span className="text-gray-600">{data.recentlyStopped.length}</span>
          </summary>
          <div className="mt-3 divide-y divide-gray-300/40">
            {data.recentlyStopped
              .filter((s) =>
                [s.projectName, s.serviceName, s.port]
                  .join(" ")
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((s, i) => (
                <div
                  key={`${s.key}-${s.firstSeen}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium">
                      {data.projects.find((p) => p.id === s.projectId)?.name ||
                        s.projectName ||
                        s.serviceName}
                    </span>
                    <span className="ml-2 text-gray-600">
                      {s.serviceName} · :{s.port}
                    </span>
                    <div className="text-xs text-gray-600">
                      Listener disappeared · {date(s.stoppedAt || s.lastSeen)}
                    </div>
                    <details className="text-xs text-gray-600">
                      <summary className="cursor-pointer">Details</summary>
                      <div>
                        {s.framework} · PID {s.pid} · {s.processName}
                      </div>
                      <div>
                        Last seen {date(s.lastSeen)} ·{" "}
                        {s.lastStatus === "http-unresponsive"
                          ? "HTTP unresponsive"
                          : "Listening"}
                      </div>
                      {s.processStarted && (
                        <div>Process started {s.processStarted}</div>
                      )}
                    </details>
                  </div>
                  {s.directory && (
                    <ProjectActions
                      project={{ directory: s.directory }}
                      onError={setError}
                    />
                  )}
                </div>
              ))}
          </div>
        </details>
      )}
      {other.length > 0 && (
        <details className="rounded-xl border border-gray-300/40 px-4 py-3">
          <summary className="cursor-pointer text-sm">
            Other local listeners{" "}
            <span className="text-gray-600">{other.length}</span>
          </summary>
          <div className="mt-2 divide-y divide-gray-300/40">
            {other.map(row)}
          </div>
        </details>
      )}
      {data.legacyNotes.length > 0 && (
        <details className="rounded-xl border border-gray-300/40 px-4 py-3">
          <summary className="cursor-pointer text-sm">
            Unassigned legacy notes{" "}
            <span className="text-gray-600">{data.legacyNotes.length}</span>
          </summary>
          <p className="mt-2 text-xs text-gray-600">
            Choose the project each old port note belongs to.
          </p>
          {data.legacyNotes.map((n) => (
            <div
              key={n.id}
              className="mt-3 flex flex-wrap items-center gap-2 text-sm"
            >
              <span className="font-mono">:{n.port}</span>
              <span className="min-w-0 flex-1 truncate" title={n.text}>
                {n.text}
              </span>
              <button
                className={button}
                onClick={() => window.api.copyText(n.text)}
              >
                Copy note
              </button>
              <select
                aria-label={`Assign note for port ${n.port}`}
                className={input + " max-w-48"}
                value=""
                onChange={(e) => {
                  const projectId = e.target.value;
                  void run(async () =>
                    setData(
                      await window.api.attachLegacyNote({
                        noteId: n.id,
                        projectId,
                      }),
                    ),
                  );
                }}
              >
                <option value="" disabled>
                  Assign to project
                </option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </details>
      )}
      {preview && (
        <Modal
          title="Stop selected processes?"
          busy={busy}
          error={error}
          onClose={() => setPreview(null)}
        >
          <p className="mb-3 text-sm text-gray-600">
            All listed ports in each process will stop.
          </p>
          <ul className="space-y-3">
            {preview.targets.map((t) => (
              <li key={t.pid} className="rounded-lg bg-gray-200 p-3 text-sm">
                <div className="font-medium">
                  {t.projectName
                    ? `${t.projectName} · ${t.serviceName}`
                    : t.serviceName}
                </div>
                <div>
                  {t.processName} · PID {t.pid} ·{" "}
                  {t.ports.map((p) => `:${p}`).join(", ")}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <button
              disabled={busy}
              className={button}
              onClick={() => setPreview(null)}
            >
              Cancel
            </button>
            <button
              disabled={busy}
              className={`${button} bg-danger text-danger-contrast`}
              onClick={() =>
                void run(async () => {
                  const result = await window.api.stopServers(preview.token);
                  setResults(result);
                  setPreview(null);
                  setSelected((current) =>
                    current.filter(
                      (ref) =>
                        !result.some(
                          (r) =>
                            r.ok &&
                            r.target.pid === Number(ref.key.split(":")[0]),
                        ),
                    ),
                  );
                })
              }
            >
              {busy
                ? "Stopping…"
                : `Stop ${preview.targets.length} process${preview.targets.length === 1 ? "" : "es"}`}
            </button>
          </div>
        </Modal>
      )}
      {results && (
        <div role="status" className="text-sm">
          <div className="flex items-center justify-between">
            <span
              className={
                results.every((r) => r.ok)
                  ? "text-success-text"
                  : "text-danger-text"
              }
            >
              {results.filter((r) => r.ok).length} stopped
              {results.some((r) => !r.ok)
                ? ` · ${results.filter((r) => !r.ok).length} not stopped`
                : ""}
            </span>
            <button className={button} onClick={() => setResults(null)}>
              Dismiss
            </button>
          </div>
          {results
            .filter((r) => !r.ok)
            .map((r) => (
              <p key={r.target.pid} className="text-danger-text">
                PID {r.target.pid}: {r.message}
              </p>
            ))}
        </div>
      )}
      {edit && (
        <ProjectEditor
          edit={edit}
          busy={busy}
          error={error}
          onClose={() => setEdit(null)}
          onChange={setEdit}
          onSave={() =>
            void run(async () => {
              setData(await window.api.editProject(edit));
              setEdit(null);
            })
          }
        />
      )}
      {assign && (
        <Modal
          title={`Project for ${assign.serviceName} :${assign.port}`}
          busy={busy}
          error={error}
          onClose={() => setAssign(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setData(
                  await window.api.associateService({
                    ref: assign,
                    projectId: association || null,
                  }),
                );
                setAssign(null);
              });
            }}
          >
            <select
              autoFocus
              aria-label="Project"
              className={input}
              value={association}
              onChange={(e) => setAssociation(e.target.value)}
            >
              <option value="">Unassigned</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.directory}
                </option>
              ))}
            </select>
            <div className="mt-4 flex justify-between">
              <button
                type="button"
                className={button}
                onClick={() =>
                  void run(async () => setData(await window.api.addProject()))
                }
              >
                Add project
              </button>
              <button
                disabled={busy}
                className={`${button} bg-night-700 text-night-100`}
              >
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
      {history && (
        <ActivityDialog
          data={data}
          history={history}
          onClose={() => setHistory(null)}
        />
      )}
    </section>
  );
}
