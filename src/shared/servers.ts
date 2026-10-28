// Public server contracts. No launch arguments, environments, or native handles.
export type ServerRef = { key: string; firstSeen: number };
export type ApplicationOwner = {
  name: string;
  executable: string;
  evidence: "app-bundle" | "bundled-runtime" | "application-process";
};
export type ServerInfo = ServerRef & {
  pid: number;
  port: number;
  protocol: "tcp";
  processName?: string;
  processStarted?: string;
  cwd?: string;
  lastSeen: number;
  url: string;
  framework?: string;
  cpu?: number;
  memory?: number;
  cpuHistory?: number[];
  memoryHistory?: number[];
  discovery: "development" | "application" | "unidentified";
  application?: ApplicationOwner;
  ignored?: boolean;
  projectId?: string;
  serviceId?: string;
  serviceName: string;
  association?: "detected" | "manual";
  canStop: boolean;
  // Unidentified listeners only: Windows services hosted by the process, and
  // whether the port answered a one-time local HTTP request.
  windowsServices?: string[];
  answersHttp?: boolean;
};
export type Project = {
  id: string;
  directory: string;
  name: string;
  notes: string;
  pinned: boolean;
  bookmarked: boolean;
  ignored: boolean;
  createdAt: number;
  lastSeen: number;
};
export type ActivityKind =
  | "discovered"
  | "listener-disappeared"
  | "http-unresponsive"
  | "http-recovered"
  | "process-changed"
  | "port-reused"
  | "restarted"
  | "available-again";
export type ServiceRecord = Pick<
  ServerInfo,
  | "key"
  | "firstSeen"
  | "pid"
  | "port"
  | "processName"
  | "processStarted"
  | "framework"
  | "serviceId"
  | "serviceName"
  | "projectId"
  | "lastSeen"
> & {
  projectName?: string;
  directory?: string;
  status: "listening" | "http-unresponsive" | "listener-disappeared";
  lastStatus?: "listening" | "http-unresponsive";
  stoppedAt?: number;
  // Computed for the renderer only. Launch details never leave main memory.
  canStart?: boolean;
};
export type Activity = {
  id: string;
  at: number;
  kind: ActivityKind;
  service: ServiceRecord;
};
export type LegacyNote = { id: string; port: string; text: string };
export type ProjectSnapshot = {
  projects: Project[];
  recentlyStopped: ServiceRecord[];
  activity: Activity[];
  legacyNotes: LegacyNote[];
};
export type ProjectEdit = {
  id: string;
  name: string;
  notes: string;
  pinned: boolean;
  bookmarked: boolean;
  ignored?: boolean;
};
export type AssociationEdit = { ref: ServerRef; projectId: string | null };
export type StopScope = { refs: ServerRef[]; projectId?: string };
export type StopTarget = {
  ref: ServerRef;
  pid: number;
  ports: number[];
  processName: string;
  projectName?: string;
  serviceName: string;
};
export type StopPreview = {
  token: string;
  expiresAt: number;
  targets: StopTarget[];
};
export type StopResult = { target: StopTarget; ok: boolean; message: string };
export type StartScope = StopScope;
export type StartResult = {
  ref: ServerRef;
  serviceName: string;
  port: number;
  ok: boolean;
  message: string;
};

export function serverRef(value: unknown): ServerRef {
  const v = object(value);
  if (
    typeof v.key !== "string" ||
    !/^[1-9]\d{0,9}:[1-9]\d{0,4}$/.test(v.key) ||
    !Number.isSafeInteger(v.firstSeen) ||
    Number(v.firstSeen) <= 0
  )
    throw new Error("Invalid service reference.");
  const [pid, port] = v.key.split(":").map(Number);
  if (pid > 0x7fffffff || port > 65535)
    throw new Error("Invalid service reference.");
  return { key: v.key, firstSeen: Number(v.firstSeen) };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value))
    throw new Error("Invalid identity.");
  return value;
}
export function textField(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b-\x1f]/.test(value)
  )
    throw new Error("Invalid text.");
  return value.trim();
}
export function projectEdit(value: unknown): ProjectEdit {
  const v = object(value);
  if (typeof v.pinned !== "boolean" || typeof v.bookmarked !== "boolean")
    throw new Error("Invalid project preferences.");
  if (v.ignored !== undefined && typeof v.ignored !== "boolean")
    throw new Error("Invalid ignored preference.");
  const name = textField(v.name, 120);
  if (!name) throw new Error("Project name is required.");
  return {
    id: id(v.id),
    name,
    notes: textField(v.notes, 4000),
    pinned: v.pinned,
    bookmarked: v.bookmarked,
    ...(v.ignored === undefined ? {} : { ignored: v.ignored as boolean }),
  };
}
export function terminalDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f]/.test(value) ||
    !/^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(value)
  )
    throw new Error("Invalid project folder.");
  return value;
}
export function associationEdit(value: unknown): AssociationEdit {
  const v = object(value);
  return {
    ref: serverRef(v.ref),
    projectId: v.projectId === null ? null : id(v.projectId),
  };
}
export function stopScope(value: unknown): StopScope {
  const v = object(value);
  if (!Array.isArray(v.refs) || !v.refs.length || v.refs.length > 100)
    throw new Error("Select between 1 and 100 services.");
  const refs = v.refs.map(serverRef);
  if (new Set(refs.map((r) => r.key)).size !== refs.length)
    throw new Error("Duplicate service selection.");
  return {
    refs,
    ...(v.projectId === undefined ? {} : { projectId: id(v.projectId) }),
  };
}
export function startScope(value: unknown): StartScope {
  return stopScope(value);
}
