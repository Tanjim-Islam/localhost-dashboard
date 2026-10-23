import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ServerStopController,
  type StopDependencies,
} from "../src/main/projects/stop-controller";
import type { ServerInfo } from "../src/shared/servers";
import type { ProcessIdentity } from "../src/main/server-restart/types";

function harness() {
  const identity = (pid: number): ProcessIdentity => ({
    pid,
    ppid: 1,
    started: `${pid}-start`,
    startedMs: 1000,
    executable: "C:/node.exe",
  });
  const observed = [identity(100), identity(200), identity(300)];
  let live = structuredClone(observed),
    now = 1000;
  const items: ServerInfo[] = observed.map((p) => ({
    key: `${p.pid}:${60000 + p.pid}`,
    firstSeen: 1000,
    pid: p.pid,
    port: 60000 + p.pid,
    protocol: "tcp",
    url: "",
    lastSeen: 1000,
    discovery: "development",
    serviceName: "API",
    projectId: p.pid === 300 ? "other" : "project",
    association: "detected",
    canStop: true,
  }));
  let listeners = items.map((s) => ({ pid: s.pid, localPort: s.port }));
  const stopped: number[] = [];
  const deps: StopDependencies = {
    items: () => items,
    identity: (pid) => observed.find((p) => p.pid === pid),
    projectName: (id) => id,
    ownPid: 999,
    restartBusy: () => false,
    listeners: async () => listeners,
    createHost: () => ({
      snapshot: async () => ({ processes: live, contexts: [] }),
      stop: async (targets) => {
        stopped.push(...targets.map((p) => p.pid));
        live = live.filter((p) => !targets.some((t) => t.pid === p.pid));
      },
      dispose: () => {},
    }),
    refresh: async () => {},
    now: () => now,
    pause: async () => {},
  };
  return {
    controller: new ServerStopController(deps),
    deps,
    items,
    observed,
    stopped,
    reuse: () => {
      live[0] = { ...live[0], started: "reused" };
    },
    advance: () => {
      now += 61000;
    },
    addPort: () => {
      listeners = [...listeners, { pid: 100, localPort: 65500 }];
    },
  };
}

test("Stop Selected only targets explicit processes and previews every port in a shared process", async () => {
  const h = harness();
  h.addPort();
  const preview = await h.controller.preview({ refs: [h.items[0]] });
  assert.deepEqual(
    preview.targets.map((t) => t.pid),
    [100],
  );
  assert.deepEqual(preview.targets[0].ports, [60100, 65500]);
  assert.equal((await h.controller.execute(preview.token))[0].ok, true);
  assert.deepEqual(h.stopped, [100]);
  await assert.rejects(h.controller.execute(preview.token), /expired/);
});
test("stop rejects stale selection, replaced PID, expired confirmation and changed listener set", async () => {
  for (const mode of ["stale", "reused", "expired", "port"] as const) {
    const h = harness();
    if (mode === "stale") {
      await assert.rejects(
        h.controller.preview({ refs: [{ ...h.items[0], firstSeen: 5 }] }),
      );
      continue;
    }
    const preview = await h.controller.preview({ refs: [h.items[0]] });
    if (mode === "reused") h.reuse();
    if (mode === "expired") h.advance();
    if (mode === "port") h.addPort();
    if (mode === "expired")
      await assert.rejects(h.controller.execute(preview.token));
    else assert.equal((await h.controller.execute(preview.token))[0].ok, false);
    assert.deepEqual(h.stopped, []);
  }
});
test("project stop validates associations in main and reports partial success", async () => {
  const h = harness();
  await assert.rejects(
    h.controller.preview({ refs: h.items, projectId: "project" }),
    /association/,
  );
  const preview = await h.controller.preview({
    refs: h.items.slice(0, 2),
    projectId: "project",
  });
  h.reuse();
  const result = await h.controller.execute(preview.token);
  assert.deepEqual(
    result.map((r) => r.ok),
    [false, true],
  );
  assert.deepEqual(h.stopped, [200]);
});
test("project reassignment after preview invalidates authorization and busy restart blocks stops", async () => {
  const h = harness();
  const preview = await h.controller.preview({
    refs: [h.items[0]],
    projectId: "project",
  });
  h.items[0].projectId = "other";
  await assert.rejects(h.controller.execute(preview.token));
  assert.equal(h.stopped.length, 0);
  h.deps.restartBusy = () => true;
  await assert.rejects(
    h.controller.preview({ refs: [h.items[1]] }),
    /already running/,
  );
});
test("missing inspection or cross-project process ownership cannot be stopped", async () => {
  const h = harness();
  h.deps.identity = () => undefined;
  await assert.rejects(
    h.controller.preview({ refs: [h.items[0]] }),
    /identity/,
  );
  assert.equal(h.stopped.length, 0);
});

test("a scan between successful stops does not invalidate the remaining selection", async () => {
  const h = harness();
  const original = h.deps.createHost;
  h.deps.createHost = () => {
    const host = original();
    return {
      ...host,
      stop: async (targets) => {
        await host.stop(targets);
        for (const target of targets) {
          const index = h.items.findIndex((s) => s.pid === target.pid);
          if (index >= 0) h.items.splice(index, 1);
        }
      },
    };
  };
  const preview = await h.controller.preview({
    refs: h.items.slice(0, 2),
    projectId: "project",
  });
  assert.deepEqual(
    (await h.controller.execute(preview.token)).map((r) => r.ok),
    [true, true],
  );
  assert.deepEqual(h.stopped, [100, 200]);
});

test("a shared process reassigned after preview cannot stop another project's listener", async () => {
  const h = harness();
  const preview = await h.controller.preview({ refs: [h.items[0]] });
  h.items.push({
    ...h.items[0],
    key: "100:65500",
    port: 65500,
    projectId: "other",
  });
  assert.equal((await h.controller.execute(preview.token))[0].ok, false);
  assert.deepEqual(h.stopped, []);
});
