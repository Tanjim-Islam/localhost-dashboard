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
    for (let i = 0; i < 3; i++) {
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
    const controller = new ServerStopController({
      items: () => items,
      identity: (pid) => identities.find((p) => p.pid === pid),
      projectName: (id) => id,
      createHost: () => new NativeProcessHost(resources),
      listeners: readListeners,
      ownPid: process.pid,
      restartBusy: () => false,
      refresh: async () => {},
      now: Date.now,
      pause,
    });
    const preview = await controller.preview({ refs: [items[0]] });
    assert.deepEqual(
      preview.targets.map((t) => t.pid),
      [owned[0].pid],
    );
    assert.equal((await controller.execute(preview.token))[0].ok, true);
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
    const project = await controller.preview({
      refs: [items[1]],
      projectId: "project-1",
    });
    assert.equal((await controller.execute(project.token))[0].ok, true);
    after = await host.snapshot();
    assert.ok(after.processes.some((p) => p.pid === owned[2].pid));
    console.log("PASS stale selection rejection and scoped project stop");
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
