// Only generated children can enter this test's controller or cleanup target set.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: pause } = require("node:timers/promises");
const {
  NativeProcessHost,
} = require("../.tmp-tests/src/main/server-restart/native-host.js");
const {
  readListeners,
} = require("../.tmp-tests/src/main/server-restart/listeners.js");
const {
  ServerStopController,
} = require("../.tmp-tests/src/main/projects/stop-controller.js");
const {
  ProjectIdentifier,
} = require("../.tmp-tests/src/main/projects/identify.js");
const {
  ListenerTracker,
} = require("../.tmp-tests/src/main/projects/discovery.js");
const resources = path.resolve("resources/server-restart");
const owned = [],
  identities = [],
  items = [];
let root;
async function main() {
  assert.ok(["win32", "darwin"].includes(process.platform));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-stop-"));
  const host = new NativeProcessHost(resources);
  try {
    for (let i = 0; i < 5; i++) {
      const dir = path.join(root, `project-${i}`);
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: `stop-fixture-${i}` }),
      );
      const script = path.join(dir, "server.cjs");
      await fs.writeFile(
        script,
        `const s=require('node:http').createServer((q,r)=>r.end('dummy'));s.listen(0,${JSON.stringify(i === 1 ? "::1" : "127.0.0.1")},()=>console.log(JSON.stringify({pid:process.pid,port:s.address().port})));`,
      );
      const child = spawn(process.execPath, [script], {
        cwd: dir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      owned.push(child);
      const record = await new Promise((resolve, reject) => {
        child.stdout.once("data", (data) =>
          resolve(JSON.parse(data.toString())),
        );
        child.once("error", reject);
      });
      const snapshot = await host.snapshot(record.pid);
      const identity = snapshot.processes.find((p) => p.pid === record.pid);
      assert.ok(identity);
      identities.push(identity);
      const evidence = await new ProjectIdentifier().identify(
        dir,
        [process.execPath, script],
        process.execPath,
      );
      assert.equal(evidence.name, `stop-fixture-${i}`);
      items.push({
        ...record,
        key: `${record.pid}:${record.port}`,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        protocol: "tcp",
        url: "",
        serviceName: "Dummy",
        projectId: `project-${i}`,
        association: "detected",
        discovery: "development",
        canStop: true,
      });
    }
    const listeners = await readListeners();
    for (const item of items)
      assert.ok(
        listeners.some((l) => l.pid === item.pid && l.localPort === item.port),
      );
    console.log(
      "PASS arbitrary IPv4/IPv6 listeners and real project identification",
    );
    const tracker = new ListenerTracker();
    tracker.reconcile(items);
    const controller = new ServerStopController({
      items: () => items,
      identity: (pid) => identities.find((p) => p.pid === pid),
      projectName: (id) => id,
      createHost: () => {
        const host = new NativeProcessHost(resources);
        return {
          snapshot: (pid) => host.snapshot(pid),
          stop: (targets) => host.stop(targets, true),
          dispose: () => host.dispose(),
        };
      },
      listeners: readListeners,
      // This standalone harness creates the servers. The real dashboard is a separate process.
      ownPid: 2147483647,
      restartBusy: () => false,
      refresh: async (refs) => {
        tracker.retire(refs);
      },
      now: Date.now,
      pause,
    });
    const selectedAt = performance.now();
    const direct = await controller.stop({ refs: [items[0]] });
    assert.equal(direct[0].ok, true);
    assert.ok(!tracker.values().some((s) => s.pid === items[0].pid));
    const directMs = performance.now() - selectedAt;
    assert.ok(directMs < 3000, `Selected stop took ${directMs.toFixed(0)}ms`);
    console.log(`PASS one-click stop and retirement: ${directMs.toFixed(0)}ms`);
    const preview = { targets: direct.map((r) => r.target), token: "consumed" };
    assert.deepEqual(
      preview.targets.map((t) => t.pid),
      [owned[0].pid],
    );
    await assert.rejects(controller.execute(preview.token));
    let after = await host.snapshot();
    assert.ok(after.processes.some((p) => p.pid === owned[1].pid));
    assert.ok(after.processes.some((p) => p.pid === owned[2].pid));
    console.log(
      "PASS selected stop and one-use confirmation leave unselected dummy processes alive",
    );
    const changed = await controller.preview({ refs: [items[1]] });
    const original = identities[1];
    identities[1] = { ...original, started: "simulated-observation-change" };
    // Execution compares its captured native identity. Change the live selection instead
    // to exercise stale renderer references without ever selecting an unrelated process.
    items[1].firstSeen++;
    await assert.rejects(controller.execute(changed.token));
    identities[1] = original;
    const projectAt = performance.now();
    const project = await controller.stop({
      refs: [items[1]],
      projectId: "project-1",
    });
    assert.equal(project[0].ok, true);
    assert.ok(performance.now() - projectAt < 3000);
    console.log(
      `PASS IPv6 project stop: ${(performance.now() - projectAt).toFixed(0)}ms`,
    );
    after = await host.snapshot();
    assert.ok(after.processes.some((p) => p.pid === owned[2].pid));
    console.log("PASS stale selection rejection and scoped project stop");
    items[2].discovery = "application";
    delete items[2].projectId;
    delete items[2].association;
    const appAt = performance.now();
    assert.equal((await controller.stop({ refs: [items[2]] }))[0].ok, true);
    assert.ok(performance.now() - appAt < 3000);
    console.log(
      `PASS application stop: ${(performance.now() - appAt).toFixed(0)}ms`,
    );
    const externalAt = performance.now();
    await host.stop([identities[3]]);
    for (let i = 0; i < 2; i++) {
      await pause(1000);
      const refs = tracker.values();
      const table = await readListeners();
      tracker.checkPresence(
        refs,
        new Set(table.map((l) => `${l.pid}:${l.localPort}`)),
      );
    }
    assert.ok(!tracker.values().some((s) => s.pid === items[3].pid));
    assert.ok(tracker.values().some((s) => s.pid === items[4].pid));
    assert.ok(performance.now() - externalAt < 3000);
    console.log(
      `PASS external stop retirement: ${(performance.now() - externalAt).toFixed(0)}ms, untouched control stays alive`,
    );
  } finally {
    // Revalidate original native identities before cleaning up our own fixtures.
    for (const identity of identities)
      if (owned.some((c) => c.pid === identity.pid))
        await host.stop([identity]).catch(() => {});
    const remaining = await host.snapshot();
    assert.equal(
      remaining.processes.some((p) =>
        identities.some((i) => i.pid === p.pid && i.started === p.started),
      ),
      false,
      "Owned dummy processes must be cleaned up",
    );
    host.dispose();
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of owned) {
      child.stdout?.destroy();
      child.unref();
    }
    if (root) {
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith("dashboard-stop-"));
      await fs.rm(resolved, { recursive: true, force: true });
    }
  });
