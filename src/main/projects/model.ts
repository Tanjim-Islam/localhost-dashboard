import { randomUUID } from "node:crypto";
import type {
  ActivityKind,
  Project,
  ProjectEdit,
  ProjectSnapshot,
  ServerInfo,
  ServiceRecord,
} from "../../shared/servers";
import { pathIdentity, stableId, type ProjectEvidence } from "./identify";

export type ProjectState = ProjectSnapshot & {
  schemaVersion: 2;
  legacyNotesMigrated: boolean;
  associations: Record<string, string | null>;
  lastObserved: ServiceRecord[];
};
export const emptyProjectState = (): ProjectState => ({
  schemaVersion: 2,
  legacyNotesMigrated: false,
  projects: [],
  associations: {},
  recentlyStopped: [],
  activity: [],
  legacyNotes: [],
  lastObserved: [],
});
const clean = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v.replace(/[\x00-\x08\x0b-\x1f]/g, "").slice(0, max)
    : "";

export function migrateProjectState(
  raw: unknown,
  legacy: Record<string, string> = {},
): ProjectState {
  const state = emptyProjectState();
  if (
    raw &&
    typeof raw === "object" &&
    [1, 2].includes((raw as ProjectState).schemaVersion)
  ) {
    const old = raw as ProjectState;
    state.projects = (Array.isArray(old.projects) ? old.projects : [])
      .slice(0, 1000)
      .filter(
        (p) => p && typeof p.id === "string" && typeof p.directory === "string",
      )
      .map((p) => ({
        id: clean(p.id, 100),
        directory: clean(p.directory, 2048),
        name: clean(p.name, 120),
        notes: clean(p.notes, 4000),
        pinned: !!p.pinned,
        bookmarked: !!p.bookmarked,
        ignored: p.ignored === true,
        createdAt: Number(p.createdAt) || 0,
        lastSeen: Number(p.lastSeen) || 0,
      }));
    const records = (items: ServiceRecord[] | undefined, limit: number) =>
      (Array.isArray(items) ? items : [])
        .slice(0, limit)
        .filter((s) => s && Number.isInteger(s.pid) && Number.isInteger(s.port))
        .map((s) => sanitizeRecord(s));
    state.recentlyStopped = records(old.recentlyStopped, 100);
    state.lastObserved = records(old.lastObserved, 512);
    const kinds: ActivityKind[] = [
      "discovered",
      "listener-disappeared",
      "http-unresponsive",
      "http-recovered",
      "process-changed",
      "port-reused",
      "restarted",
      "available-again",
    ];
    state.activity = (Array.isArray(old.activity) ? old.activity : [])
      .slice(0, 500)
      .filter(
        (e) =>
          e && kinds.includes(e.kind) && Number.isFinite(e.at) && e.service,
      )
      .map((e) => ({
        id: clean(e.id, 100),
        at: e.at,
        kind: e.kind,
        service: sanitizeRecord(e.service),
      }));
    state.legacyNotes = (Array.isArray(old.legacyNotes) ? old.legacyNotes : [])
      .filter((n) => n && typeof n.text === "string")
      .map((n) => ({
        id: clean(n.id, 100),
        port: clean(n.port, 5),
        text: clean(n.text, 64000),
      }));
    state.legacyNotesMigrated = !!old.legacyNotesMigrated;
    state.associations = Object.fromEntries(
      Object.entries(old.associations || {})
        .slice(0, 2000)
        .filter(
          ([key, value]) =>
            /^[a-f0-9]{32}$/.test(key) &&
            (value === null || state.projects.some((p) => p.id === value)),
        ),
    );
  }
  if (!state.legacyNotesMigrated) {
    state.legacyNotes = Object.entries(legacy)
      .filter(
        ([port, note]) =>
          /^\d{1,5}$/.test(port) && typeof note === "string" && note.trim(),
      )
      .map(([port, text]) => ({
        id: `legacy-${port}`,
        port,
        text: clean(text, 64000),
      }));
    state.legacyNotesMigrated = true;
  }
  return state;
}

function sanitizeRecord(s: ServiceRecord): ServiceRecord {
  return {
    key: clean(s.key, 32),
    firstSeen: Number(s.firstSeen) || 0,
    pid: Number(s.pid),
    port: Number(s.port),
    serviceName: clean(s.serviceName, 120),
    lastSeen: Number(s.lastSeen) || 0,
    status:
      s.status === "http-unresponsive" || s.status === "listener-disappeared"
        ? s.status
        : "listening",
    ...(s.lastStatus === "listening" || s.lastStatus === "http-unresponsive"
      ? { lastStatus: s.lastStatus }
      : {}),
    ...(s.processName ? { processName: clean(s.processName, 120) } : {}),
    ...(s.processStarted
      ? { processStarted: clean(s.processStarted, 100) }
      : {}),
    ...(s.framework ? { framework: clean(s.framework, 120) } : {}),
    ...(s.serviceId ? { serviceId: clean(s.serviceId, 100) } : {}),
    ...(s.projectId ? { projectId: clean(s.projectId, 100) } : {}),
    ...(s.projectName ? { projectName: clean(s.projectName, 120) } : {}),
    ...(s.directory ? { directory: clean(s.directory, 2048) } : {}),
    ...(Number.isFinite(s.stoppedAt) ? { stoppedAt: s.stoppedAt } : {}),
  };
}

export class ProjectModel {
  private health = new Map<string, string>();
  constructor(
    readonly state: ProjectState,
    private changed: () => void = () => {},
  ) {
    for (const service of state.lastObserved)
      this.health.set(
        `${service.key}:${service.firstSeen}`,
        service.status === "http-unresponsive" ? "down" : "healthy",
      );
  }
  snapshot(): ProjectSnapshot {
    const { projects, recentlyStopped, activity, legacyNotes } = this.state;
    return structuredClone({
      projects,
      recentlyStopped,
      activity,
      legacyNotes,
    });
  }
  ensure(directory: string, name: string, now = Date.now()): Project {
    const identity = stableId(pathIdentity(directory));
    let project = this.state.projects.find((p) => p.id === identity);
    if (!project) {
      if (this.state.projects.length >= 1000)
        throw new Error("Project limit reached.");
      project = {
        id: identity,
        directory,
        name: clean(name, 120),
        notes: "",
        pinned: false,
        bookmarked: false,
        ignored: false,
        createdAt: now,
        lastSeen: now,
      };
      this.state.projects.push(project);
      this.changed();
    }
    return project;
  }
  decorate(
    item: ServerInfo,
    evidence?: ProjectEvidence,
    associationKey?: string,
  ): ServerInfo {
    // Application ownership cannot be overridden into destructive project actions.
    if (item.discovery === "application") {
      const base = { ...item };
      delete base.projectId;
      delete base.association;
      delete base.serviceId;
      delete base.ignored;
      return { ...base, canStop: false };
    }
    const key = associationKey || evidence?.associationKey;
    const manual = key && Object.hasOwn(this.state.associations, key);
    const project = manual
      ? this.state.projects.find((p) => p.id === this.state.associations[key!])
      : evidence
        ? this.ensure(evidence.directory, evidence.name)
        : undefined;
    if (project) project.lastSeen = item.lastSeen;
    const base = { ...item };
    delete base.projectId;
    delete base.association;
    delete base.serviceId;
    delete base.ignored;
    return {
      ...base,
      ...(project
        ? {
            projectId: project.id,
            association: manual ? ("manual" as const) : ("detected" as const),
            discovery: "development" as const,
            ignored: project.ignored,
          }
        : {}),
      ...(key
        ? { serviceId: stableId(`${project?.id || "unassigned"}:${key}`) }
        : {}),
      serviceName: evidence?.serviceName || item.serviceName,
    };
  }
  edit(edit: ProjectEdit): void {
    const project = this.state.projects.find((p) => p.id === edit.id);
    if (!project) throw new Error("Project no longer exists.");
    Object.assign(project, edit);
    this.changed();
  }
  associate(key: string, projectId: string | null): void {
    if (projectId && !this.state.projects.some((p) => p.id === projectId))
      throw new Error("Project no longer exists.");
    if (
      !Object.hasOwn(this.state.associations, key) &&
      Object.keys(this.state.associations).length >= 2000
    )
      throw new Error("Association limit reached.");
    this.state.associations[key] = projectId;
    this.changed();
  }
  attachLegacy(noteId: string, projectId: string): void {
    const note = this.state.legacyNotes.find((n) => n.id === noteId);
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!note || !project) throw new Error("Note or project no longer exists.");
    const notes = [project.notes, note.text].filter(Boolean).join("\n");
    if (notes.length > 4000)
      throw new Error(
        "The combined note exceeds 4000 characters. Edit the project note first.",
      );
    project.notes = notes;
    this.state.legacyNotes = this.state.legacyNotes.filter(
      (n) => n.id !== noteId,
    );
    this.changed();
  }
  private record(item: ServerInfo): ServiceRecord {
    const project = this.state.projects.find((p) => p.id === item.projectId);
    return sanitizeRecord({
      ...item,
      projectName: project?.name,
      directory: project?.directory,
      status:
        this.health.get(`${item.key}:${item.firstSeen}`) === "down"
          ? "http-unresponsive"
          : "listening",
    });
  }
  event(kind: ActivityKind, service: ServiceRecord, at = Date.now()): void {
    this.state.activity.unshift({
      id: randomUUID(),
      at,
      kind,
      service: sanitizeRecord(service),
    });
    this.state.activity.length = Math.min(this.state.activity.length, 500);
    this.changed();
  }
  reconcile(items: ServerInfo[], now = Date.now()): void {
    const current = items
      .filter((i) => i.discovery === "development")
      .slice(0, 512)
      .map((i) => this.record(i));
    const previous = this.state.lastObserved;
    // A listener with temporarily unreadable metadata is still observed. Do not
    // reinterpret lost classification or permissions as a listener disappearance.
    for (const old of previous) {
      const unknown = items.find(
        (s) =>
          s.key === old.key &&
          s.discovery === "unidentified" &&
          (!s.processStarted || s.processStarted === old.processStarted),
      );
      if (unknown) current.push({ ...old, lastSeen: unknown.lastSeen });
    }
    const same = (a: ServiceRecord, b: ServiceRecord) =>
      a.key === b.key && a.firstSeen === b.firstSeen;
    for (const old of previous)
      if (!current.some((next) => same(old, next))) {
        // Reclassifying a live app helper is not a stopped process.
        if (
          items.some(
            (item) =>
              item.key === old.key &&
              item.processStarted === old.processStarted &&
              item.discovery === "application",
          )
        )
          continue;
        const stopped = {
          ...old,
          lastStatus:
            old.status === "http-unresponsive"
              ? ("http-unresponsive" as const)
              : ("listening" as const),
          status: "listener-disappeared" as const,
          stoppedAt: now,
        };
        this.state.recentlyStopped.unshift(stopped);
        this.event("listener-disappeared", stopped, now);
      }
    for (const next of current)
      if (!previous.some((old) => same(old, next))) {
        const priorPort =
          previous.find((old) => old.port === next.port) ||
          this.state.recentlyStopped.find((old) => old.port === next.port);
        if (
          priorPort &&
          (priorPort.pid !== next.pid ||
            (priorPort.processStarted &&
              next.processStarted &&
              priorPort.processStarted !== next.processStarted))
        )
          this.event(
            priorPort.projectId && priorPort.projectId === next.projectId
              ? "process-changed"
              : "port-reused",
            next,
            now,
          );
        const returned =
          next.serviceId &&
          !previous.some(
            (old) =>
              old.serviceId === next.serviceId &&
              current.some((item) => same(old, item)),
          ) &&
          this.state.recentlyStopped.some(
            (old) => old.serviceId === next.serviceId,
          );
        this.event(returned ? "available-again" : "discovered", next, now);
      }
    // A second instance using the same launch context must not erase the fact
    // that this particular listener disappeared.
    this.state.recentlyStopped = this.state.recentlyStopped.slice(0, 100);
    this.state.lastObserved = current;
    const liveKeys = new Set(items.map((i) => `${i.key}:${i.firstSeen}`));
    for (const key of this.health.keys())
      if (!liveKeys.has(key)) this.health.delete(key);
    this.changed();
  }
  updateHealth(item: ServerInfo, status: string, at: number): void {
    const key = `${item.key}:${item.firstSeen}`;
    const old = this.health.get(key);
    if (old === status) return;
    this.health.set(key, status);
    const observed = this.state.lastObserved.find(
      (s) => s.key === item.key && s.firstSeen === item.firstSeen,
    );
    if (observed)
      observed.status = status === "down" ? "http-unresponsive" : "listening";
    if (status === "down")
      this.event("http-unresponsive", this.record(item), at);
    else if (old === "down")
      this.event("http-recovered", this.record(item), at);
  }
  restarted(item: ServerInfo): void {
    this.event("restarted", this.record(item));
  }
}
