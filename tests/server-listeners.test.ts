import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { listenerLabel } from "../src/main/projects/discovery";
import { probeHttp } from "../src/main/health-checker";
import { NativeProcessHost } from "../src/main/server-restart/native-host";

test("unidentified listeners are named after their Windows service or process", () => {
  assert.equal(listenerLabel("svchost.exe", ["RPC Endpoint Mapper"]), "RPC Endpoint Mapper");
  assert.equal(listenerLabel("postgres.exe"), "postgres");
  assert.equal(listenerLabel("AnyDesk.EXE", []), "AnyDesk");
  assert.equal(listenerLabel("System"), "Windows System");
  assert.equal(listenerLabel("rapportd"), "rapportd");
  assert.equal(listenerLabel(undefined), "Local listener");
});

test("service names are grouped per PID, sorted, and malformed entries dropped", async () => {
  const host = new NativeProcessHost("unused", "win32");
  host.request = async () => [
    { pid: 10, name: "Task Scheduler" }, { pid: 10, name: "Application Information" },
    { pid: 20, name: "  Print Spooler " }, { pid: "30", name: "Bad" }, { pid: 40, name: "" }, null,
  ];
  assert.deepEqual([...(await host.services())], [
    [10, ["Application Information", "Task Scheduler"]],
    [20, ["Print Spooler"]],
  ]);
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

test("only ports returning a plain HTTP response count as browsable", async () => {
  const sockets: net.Socket[] = [];
  const web = http.createServer((_, res) => res.end("ok"));
  const upgrade = http.createServer((_, res) => { res.statusCode = 426; res.end(); });
  const binary = net.createServer((socket) => { sockets.push(socket); socket.end(Buffer.from([0x05, 0x00, 0xff, 0x13])); });
  const silent = net.createServer((socket) => { sockets.push(socket); });
  try {
    const [webPort, upgradePort, binaryPort, silentPort] = await Promise.all([web, upgrade, binary, silent].map(listen));
    assert.equal(await probeHttp(`http://127.0.0.1:${webPort}`), true);
    assert.equal(await probeHttp(`http://127.0.0.1:${upgradePort}`), false);
    assert.equal(await probeHttp(`http://127.0.0.1:${binaryPort}`), false);
    const started = Date.now();
    assert.equal(await probeHttp(`http://127.0.0.1:${silentPort}`, 300), undefined, "a slow port is unknown, not final");
    assert.ok(Date.now() - started < 2000, "silent ports time out quickly");
    const gone = net.createServer();
    const closedPort = await listen(gone);
    await new Promise<void>((resolve) => gone.close(() => resolve()));
    assert.equal(await probeHttp(`http://127.0.0.1:${closedPort}`), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const server of [web, upgrade, binary, silent]) server.close();
  }
});
