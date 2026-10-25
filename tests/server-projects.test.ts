import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectIdentifier } from "../src/main/projects/identify";
import {
  emptyProjectState,
  migrateProjectState,
  ProjectModel,
} from "../src/main/projects/model";
import {
  developmentRuntime,
  ListenerTracker,
  sameObservedStart,
} from "../src/main/projects/discovery";

test("coarse process timestamps do not invent restarts when native metadata arrives", () => {
  assert.ok(
    sameObservedStart(
      "2026-10-24T00:00:00Z",
      "2026-10-24T00:00:00.572Z",
      false,
    ),
  );
  assert.ok(
    sameObservedStart(
      "2026-10-24T00:00:00.572Z",
      "2026-10-24T00:00:00Z",
      false,
    ),
  );
  assert.ok(
    !sameObservedStart(
      "2026-10-24T00:00:00.572Z",
      "2026-10-24T00:00:00.900Z",
      true,
    ),
  );
  assert.ok(
    !sameObservedStart("2026-10-24T00:00:00Z", "2026-10-24T00:00:05Z", false),
  );
});

test("native identity preserves a live instance despite coarse timestamp jitter", () => {
  const started = "2026-10-24T00:00:00.572Z";
  assert.ok(
    sameObservedStart("2026-10-24T00:00:00Z", "2026-10-24T00:00:01Z", false),
  );
  assert.ok(sameObservedStart(started, started, true, true));
  assert.ok(
    !sameObservedStart(started, "2026-10-24T00:00:00.900Z", true, true),
  );
  assert.ok(!sameObservedStart(started, started, false, true));
});
import {
  associationEdit,
  projectEdit,
  stopScope,
  type ServerInfo,
} from "../src/shared/servers";

const service = (overrides: Partial<ServerInfo> = {}): ServerInfo => ({
  key: "100:60007",
  pid: 100,
  port: 60007,
  protocol: "tcp",
  firstSeen: 1000,
  lastSeen: 2000,
  processStarted: "2026-10-23T00:00:00Z",
  serviceName: "Frontend",
  discovery: "development",
  canStop: true,
  url: "http://localhost:60007",
  ...overrides,
});

test("ignored projects migrate, persist and follow stable identity across ports and restarts", () => {
  const model = new ProjectModel(emptyProjectState());
  const p = model.ensure(path.resolve("ignored-fixture"), "Keep my name");
  model.edit({ ...p, ignored: true, notes: "Keep my notes", pinned: true });
  const evidence = {
    directory: p.directory,
    name: "detected",
    serviceDirectory: p.directory,
    serviceName: "API",
    associationKey: "b".repeat(32),
  };
  assert.equal(model.decorate(service(), evidence).ignored, true);
  const restored = new ProjectModel(
    migrateProjectState(JSON.parse(JSON.stringify(model.state))),
  );
  const next = restored.decorate(
    service({ pid: 200, key: "200:60008", port: 60008, firstSeen: 9999 }),
    evidence,
  );
  assert.equal(next.projectId, p.id);
  assert.equal(next.ignored, true);
  assert.equal(restored.state.projects[0].notes, "Keep my notes");
  restored.edit({ ...restored.state.projects[0], ignored: false });
  assert.equal(restored.decorate(service(), evidence).ignored, false);
  const old = JSON.parse(JSON.stringify(model.state));
  old.schemaVersion = 1;
  delete old.projects[0].ignored;
  const migrated = migrateProjectState(old);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.projects[0].ignored, false);
  assert.equal(migrated.projects[0].notes, "Keep my notes");
  assert.throws(() => projectEdit({ ...p, ignored: "true" }));
});

test("reclassifying an application does not invent a stopped listener or allow project actions", () => {
  const model = new ProjectModel(emptyProjectState());
  const first = service();
  model.reconcile([first]);
  const app = model.decorate({
    ...first,
    discovery: "application",
    projectId: "wrong",
    association: "manual",
    canStop: true,
  });
  assert.equal(app.canStop, true);
  assert.equal(app.projectId, undefined);
  model.reconcile([app]);
  assert.equal(model.state.recentlyStopped.length, 0);
  assert.equal(
    model.state.activity.filter((e) => e.kind === "listener-disappeared")
      .length,
    0,
  );
});

test("fast presence checks retire on two successful absences without waiting for metadata scans", () => {
  const tracker = new ListenerTracker();
  const item = service();
  tracker.reconcile([item]);
  assert.equal(tracker.checkPresence([item], new Set()).length, 0);
  // A slow metadata scan completing between checks cannot reset absence evidence.
  tracker.reconcile([item], false);
  assert.deepEqual(tracker.checkPresence([item], new Set()), [item]);
  assert.equal(tracker.values().length, 0);
});

test("confirmed stops retire immediately, preserve replacements, and deduplicate history", () => {
  const tracker = new ListenerTracker();
  const model = new ProjectModel(emptyProjectState());
  const item = service();
  tracker.reconcile([item]);
  model.reconcile(tracker.values());
  assert.deepEqual(tracker.retire([item]), [item]);
  model.reconcile(tracker.values());
  assert.deepEqual(tracker.retire([item]), []);
  model.reconcile(tracker.values());
  assert.equal(model.state.recentlyStopped.length, 1);
  const replacement = service({ firstSeen: 9999 });
  tracker.reconcile([replacement]);
  assert.deepEqual(tracker.retire([item]), []);
  assert.deepEqual(tracker.checkPresence([item], new Set()), []);
  assert.deepEqual(tracker.values(), [replacement]);
});

test("a live presence observation cancels a transient absence", () => {
  const tracker = new ListenerTracker();
  const item = service();
  tracker.reconcile([item]);
  tracker.checkPresence([item], new Set());
  tracker.checkPresence([item], new Set([item.key]));
  assert.deepEqual(tracker.checkPresence([item], new Set()), []);
  assert.equal(tracker.values().length, 1);
});

test("project detection groups workspace packages, respects nested repositories and unrelated roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-projects-"));
  try {
    const mono = path.join(root, "mono"),
      web = path.join(mono, "apps/web"),
      api = path.join(mono, "apps/api"),
      other = path.join(root, "other");
    for (const dir of [web, api, other])
      await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(mono, "package.json"),
      JSON.stringify({ name: "Product", workspaces: ["apps/*"] }),
    );
    for (const [dir, name] of [
      [web, "frontend"],
      [api, "api"],
      [other, "Other"],
    ])
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name }),
      );
    const detector = new ProjectIdentifier();
    const first = await detector.identify(
      web,
      ["node", "dev.js"],
      process.execPath,
    );
    const second = await detector.identify(
      api,
      ["node", "api.js"],
      process.execPath,
    );
    assert.equal(first?.directory, await fs.realpath(mono));
    assert.equal(first?.serviceName, "frontend");
    assert.equal(second?.directory, first?.directory);
    assert.notEqual(
      (await detector.identify(other, [], process.execPath))?.directory,
      first?.directory,
    );
    await fs.mkdir(path.join(api, ".git"));
    assert.equal(
      (await new ProjectIdentifier().identify(api, [], process.execPath))
        ?.directory,
      await fs.realpath(api),
    );
    assert.equal(
      await detector.identify(root, [], process.execPath),
      undefined,
    );
    assert.equal(
      await detector.identify(
        web,
        ["node", path.join(other, "server.js")],
        process.execPath,
      ),
      undefined,
      "conflicting cwd and script are not silently assigned",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("port-independent project identity, service associations, edits and legacy migration persist without note leakage", () => {
  const state = migrateProjectState(undefined, { "5173": "Old project note" });
  const model = new ProjectModel(state);
  const a = model.ensure(path.resolve("fixture-a"), "A"),
    b = model.ensure(path.resolve("fixture-b"), "B");
  const key = "a".repeat(32);
  const evidence = {
    directory: a.directory,
    name: "Detected A",
    serviceDirectory: a.directory,
    serviceName: "web",
    associationKey: key,
  };
  const first = model.decorate(service(), evidence, key);
  const changedPort = model.decorate(
    service({ key: "200:60008", pid: 200, port: 60008, firstSeen: 3000 }),
    evidence,
    key,
  );
  assert.equal(first.projectId, changedPort.projectId);
  assert.equal(first.serviceId, changedPort.serviceId);
  assert.equal(a.notes, "");
  assert.equal(b.notes, "");
  assert.equal(state.legacyNotes.length, 1);
  model.edit({
    ...a,
    name: "Renamed",
    pinned: true,
    bookmarked: true,
    notes: "Manual note",
  });
  model.associate(key, b.id);
  assert.equal(model.decorate(changedPort, evidence, key).projectId, b.id);
  model.associate(key, null);
  assert.equal(model.decorate(changedPort, evidence, key).projectId, undefined);
  model.attachLegacy("legacy-5173", a.id);
  assert.equal(a.notes, "Manual note\nOld project note");
  assert.equal(b.notes, "");
  const restored = migrateProjectState(JSON.parse(JSON.stringify(state)), {
    "5173": "Old project note",
  });
  assert.equal(restored.legacyNotes.length, 0);
  assert.equal(restored.projects[0].pinned, true);
  assert.equal(restored.projects[0].bookmarked, true);
  assert.equal(restored.projects[0].name, "Renamed");
  assert.equal(
    new ProjectModel(restored).decorate(changedPort, evidence, key).projectId,
    undefined,
  );
});

test("failed scans do not advance disappearance and arbitrary ports are retained", () => {
  const tracker = new ListenerTracker();
  assert.equal(tracker.reconcile([service()]).added.length, 1);
  assert.equal(tracker.reconcile([]).removed.length, 0);
  // Failure means no reconcile call. Existing observation remains intact.
  assert.equal(tracker.values().length, 1);
  assert.equal(tracker.reconcile([service()]).added.length, 0);
  tracker.reconcile([]);
  assert.equal(tracker.reconcile([]).removed.length, 1);
  assert.equal(
    developmentRuntime("node.exe", "node vite --port 60007"),
    "Vite",
  );
  assert.equal(developmentRuntime("svchost.exe", ""), undefined);
  assert.equal(developmentRuntime("electron.exe", "vite"), undefined);
});

test("lifecycle records observed transitions once, keeps HTTP separate, and bounds sanitized persistence", () => {
  const model = new ProjectModel(emptyProjectState());
  const p = model.ensure(path.resolve("fixture"), "Fixture");
  const first = service({
    projectId: p.id,
    serviceId: "stable",
    association: "detected",
  });
  model.reconcile([first], 3000);
  model.reconcile([first], 4000);
  assert.deepEqual(
    model.state.activity.map((e) => e.kind),
    ["discovered"],
  );
  model.updateHealth(first, "down", 5000);
  model.updateHealth(first, "down", 6000);
  assert.equal(model.state.recentlyStopped.length, 0);
  model.updateHealth(first, "healthy", 7000);
  model.reconcile([], 8000);
  assert.equal(model.state.recentlyStopped[0].status, "listener-disappeared");
  assert.equal(model.state.recentlyStopped[0].projectName, "Fixture");
  model.reconcile(
    [
      service({
        ...first,
        pid: 101,
        key: "101:60007",
        firstSeen: 9000,
        processStarted: "2026-10-23T00:01:00Z",
      }),
    ],
    9000,
  );
  assert.ok(model.state.activity.some((e) => e.kind === "available-again"));
  assert.ok(model.state.activity.some((e) => e.kind === "process-changed"));
  model.reconcile(
    [
      service({
        projectId: "another",
        key: "102:60007",
        pid: 102,
        firstSeen: 10000,
        processStarted: "2026-10-23T00:02:00Z",
      }),
    ],
    10000,
  );
  assert.ok(model.state.activity.some((e) => e.kind === "port-reused"));
  for (let i = 0; i < 700; i++)
    model.event("restarted", model.state.lastObserved[0], i);
  assert.equal(model.state.activity.length, 500);
  const restored = migrateProjectState(JSON.parse(JSON.stringify(model.state)));
  assert.ok(restored.recentlyStopped.length);
  assert.equal(restored.activity.length, 500);
  assert.doesNotMatch(
    JSON.stringify(restored),
    /command|environment|argv|crash|exitCode/,
  );
});

test("project and selection IPC validators discard extra fields and reject malformed scope", () => {
  assert.throws(() => stopScope({ refs: [] }));
  assert.throws(() => stopScope({ refs: [service(), service()] }));
  assert.throws(() =>
    stopScope({ refs: [{ key: "100:65536", firstSeen: 1 }] }),
  );
  assert.deepEqual(stopScope({ refs: [service()], command: "unsafe" }), {
    refs: [{ key: "100:60007", firstSeen: 1000 }],
  });
  assert.throws(() =>
    projectEdit({
      id: "a",
      name: "a",
      notes: "",
      pinned: "yes",
      bookmarked: false,
    }),
  );
  assert.deepEqual(
    associationEdit({ ref: service(), projectId: null, command: "unsafe" }),
    { ref: { key: "100:60007", firstSeen: 1000 }, projectId: null },
  );
});

test("temporary metadata loss and application restart do not invent stop or repeated HTTP failure events", () => {
  const model = new ProjectModel(emptyProjectState());
  const item = service();
  model.reconcile([item]);
  model.updateHealth(item, "down", 5000);
  const restored = new ProjectModel(
    migrateProjectState(JSON.parse(JSON.stringify(model.state))),
  );
  restored.updateHealth(item, "down", 6000);
  restored.reconcile([
    { ...item, discovery: "unidentified", processStarted: undefined },
  ]);
  assert.equal(restored.state.recentlyStopped.length, 0);
  assert.deepEqual(
    restored.state.activity.map((e) => e.kind),
    ["http-unresponsive", "discovered"],
  );
  restored.reconcile([item]);
  restored.updateHealth(item, "healthy", 7000);
  assert.equal(restored.state.activity[0].kind, "http-recovered");
});

test("long legacy notes remain available without silently truncating to the project editor limit", () => {
  const text = "old note ".repeat(1000);
  const state = migrateProjectState(undefined, { "5173": text });
  assert.equal(state.legacyNotes[0].text, text);
  assert.equal(migrateProjectState(state).legacyNotes[0].text, text);
  const model = new ProjectModel(state);
  const project = model.ensure(path.resolve("legacy-long"), "Legacy");
  assert.throws(() => model.attachLegacy("legacy-5173", project.id), /exceeds/);
  assert.equal(model.state.legacyNotes[0].text, text);
});

test("stopped instances remain inspectable when another copy of the same service is running", () => {
  const model = new ProjectModel(emptyProjectState());
  const a = service({ serviceId: "same-launch" });
  const b = service({
    serviceId: "same-launch",
    pid: 200,
    key: "200:60008",
    port: 60008,
  });
  model.reconcile([a, b], 2000);
  model.reconcile([b], 3000);
  assert.equal(model.state.recentlyStopped[0].pid, a.pid);
  const c = service({
    serviceId: "same-launch",
    pid: 300,
    key: "300:60009",
    port: 60009,
    firstSeen: 4000,
  });
  model.reconcile([b, c], 4000);
  assert.equal(model.state.recentlyStopped[0].pid, a.pid);
  assert.equal(model.state.activity[0].kind, "discovered");
});

test("fallback listeners use full-scan absence while native listeners use fast presence checks", () => {
  const tracker = new ListenerTracker();
  const native = service();
  const fallback = service({ key: "0:60008", pid: 0, port: 60008 });
  const trackFallback = (item: ServerInfo) => item.key === fallback.key;
  tracker.reconcile([native, fallback], trackFallback);
  tracker.checkPresence([native], new Set());
  tracker.reconcile([native, fallback], trackFallback);
  assert.deepEqual(
    tracker.checkPresence([native], new Set()).map((s) => s.key),
    [native.key],
  );
  assert.deepEqual(
    tracker.values().map((s) => s.key),
    [fallback.key],
  );
  assert.equal(tracker.reconcile([], trackFallback).removed.length, 0);
  assert.deepEqual(
    tracker.reconcile([], trackFallback).removed.map((s) => s.key),
    [fallback.key],
  );
});
