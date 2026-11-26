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

export type RestartResult = { ok: boolean; port: number; message: string };
export type RestartPhase = "preparing" | "stopping" | "starting" | "ready" | "failed";
export type RestartProgress = {
  key: string;
  port: number;
  phase: RestartPhase;
  message: string;
};
