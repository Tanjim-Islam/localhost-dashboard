import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ServerStopController,
  type StopDependencies,
} from "../src/main/projects/stop-controller";
import type { ServerInfo } from "../src/shared/servers";
import type { ProcessIdentity } from "../src/main/server-restart/types";
import { NativeProcessHost } from "../src/main/server-restart/native-host";

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

test("ignored and unidentified services cannot be stopped even with stale authorization", async () => {
  for (const change of [
    (s: ServerInfo) => {
      s.ignored = true;
    },
    (s: ServerInfo) => {
      s.discovery = "unidentified";
    },
  ]) {
    const h = harness();
    const preview = await h.controller.preview({ refs: [h.items[0]] });
    change(h.items[0]);
    await assert.rejects(h.controller.execute(preview.token));
    await assert.rejects(h.controller.preview({ refs: [h.items[0]] }));
    assert.deepEqual(h.stopped, []);
  }
});

test("one-click stop permits verified applications, uses one helper and publishes exact stopped instances", async () => {
  const h = harness();
  h.items[0].discovery = "application";
  delete h.items[0].projectId;
  delete h.items[0].association;
  const createHost = h.deps.createHost;
  let hosts = 0;
  h.deps.createHost = () => {
    hosts++;
    return createHost();
  };
  const retired: string[] = [];
  h.deps.refresh = async (refs) => {
    retired.push(...refs.map((s) => s.key));
  };
  await assert.rejects(
    h.controller.stop({ refs: [h.items[0]], projectId: "project" }),
    /association/,
  );
  hosts = 0;
  assert.equal((await h.controller.stop({ refs: [h.items[0]] }))[0].ok, true);
  assert.equal(hosts, 1);
  assert.deepEqual(retired, [h.items[0].key]);
  assert.deepEqual(h.stopped, [100]);
});

test("concurrent one-click stops are rejected and failures do not retire services", async () => {
  const h = harness();
  const createHost = h.deps.createHost;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.deps.listeners = async () => {
    await pending;
    return h.items.map((s) => ({ pid: s.pid, localPort: s.port }));
  };
  h.deps.createHost = () => ({
    ...createHost(),
    stop: async () => {
      throw new Error("Access denied");
    },
  });
  h.deps.refresh = async () => {
    assert.fail("Failed stop must remain visible");
  };
  const stop = h.controller.stop({ refs: [h.items[0]] });
  await assert.rejects(
    h.controller.stop({ refs: [h.items[1]] }),
    /already running/,
  );
  release();
  assert.equal((await stop)[0].ok, false);
  assert.equal(h.controller.isBusy(), false);
});

test("dashboard, its ancestors and children, and native system processes are protected", async () => {
  for (const mode of ["self", "parent", "child", "system"] as const) {
    const h = harness();
    if (mode === "self") h.deps.ownPid = 100;
    if (mode === "parent") {
      const createHost = h.deps.createHost;
      h.deps.createHost = () => ({
        ...createHost(),
        snapshot: async () => ({
          processes: [...h.observed, { ...h.observed[0], pid: 999, ppid: 100 }],
          contexts: [],
        }),
      });
    }
    if (mode === "child") {
      h.deps.ownPid = 1;
      const createHost = h.deps.createHost;
      h.deps.createHost = () => ({
        ...createHost(),
        snapshot: async () => ({
          processes: [...h.observed, { ...h.observed[0], pid: 1, ppid: 0 }],
          contexts: [],
        }),
      });
    }
    if (mode === "system")
      h.observed[0].executable = "C:/Windows/System32/service.exe";
    await assert.rejects(h.controller.stop({ refs: [h.items[0]] }));
    assert.deepEqual(h.stopped, []);
  }
});

test("ignoring a project while final process inspection is pending cancels termination", async () => {
  const h = harness();
  const preview = await h.controller.preview({ refs: [h.items[0]] });
  const createHost = h.deps.createHost;
  h.deps.createHost = () => {
    const host = createHost();
    return {
      ...host,
      snapshot: async () => {
        h.items[0].ignored = true;
        return host.snapshot();
      },
    };
  };
  assert.equal((await h.controller.execute(preview.token))[0].ok, false);
  assert.deepEqual(h.stopped, []);
});

test("verified restarted children remain stoppable, but unrelated children and reused identities stay protected", async () => {
  for (const mode of ["restarted", "unrelated", "reused"] as const) {
    const h = harness();
    h.deps.ownPid = 1;
    const createHost = h.deps.createHost;
    h.deps.createHost = () => {
      const host = createHost();
      return {
        ...host,
        snapshot: async () => {
          const snapshot = await host.snapshot();
          return {
            ...snapshot,
            processes: [
              ...snapshot.processes,
              { ...h.observed[0], pid: 1, ppid: 0 },
            ],
          };
        },
      };
    };
    if (mode !== "unrelated") h.controller.rememberRestarted([h.observed[0]]);
    if (mode === "reused") {
      h.reuse();
      h.observed[0].started = "reused";
    }
    if (mode === "restarted") {
      assert.equal(
        (await h.controller.stop({ refs: [h.items[0]] }))[0].ok,
        true,
      );
      assert.deepEqual(h.stopped, [100]);
    } else {
      await assert.rejects(
        h.controller.stop({ refs: [h.items[0]] }),
        /identity/,
      );
      assert.deepEqual(h.stopped, []);
    }
  }
});

test("helper startup failure releases the stop operation lock", async () => {
  const h = harness();
  const createHost = h.deps.createHost;
  h.deps.createHost = () => {
    throw new Error("Helper unavailable");
  };
  await assert.rejects(h.controller.stop({ refs: [h.items[0]] }), /Helper/);
  assert.equal(h.controller.isBusy(), false);
  h.deps.createHost = createHost;
  assert.equal((await h.controller.stop({ refs: [h.items[0]] }))[0].ok, true);
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

test("classification or association changed during final inspection cannot inherit stop authorization", async () => {
  for (const field of ["projectId", "discovery"] as const) {
    const h = harness();
    const preview = await h.controller.preview({ refs: [h.items[0]] });
    const createHost = h.deps.createHost;
    h.deps.createHost = () => {
      const host = createHost();
      return {
        ...host,
        snapshot: async () => {
          if (field === "projectId") h.items[0].projectId = "other";
          else h.items[0].discovery = "application";
          return host.snapshot();
        },
      };
    };
    assert.equal((await h.controller.execute(preview.token))[0].ok, false);
    assert.deepEqual(h.stopped, []);
  }
});

test("an unsuccessful native termination or a still-running process cannot report success", async () => {
  const h = harness();
  const host = new NativeProcessHost("unused");
  host.request = async () => [false];
  await assert.rejects(host.stop([h.observed[0]], true), /not confirmed/);
  // Restart cleanup deliberately tolerates targets that already exited.
  await host.stop([h.observed[0]]);
  const createHost = h.deps.createHost;
  h.deps.createHost = () => ({ ...createHost(), stop: async () => {} });
  h.deps.refresh = async () =>
    assert.fail("A live process must not be retired");
  assert.equal((await h.controller.stop({ refs: [h.items[0]] }))[0].ok, false);
});
