import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { prepareFeed, releaseInfo, writeLegacyMac, writeLegacyWindows } from "./release.mjs";

test("both updater generations accept the signed assets and detect substituted bytes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const info = releaseInfo("1.14.0", "example/dashboard", "Desktop update", "2026-11-27T00:00:00Z");
  const path = (name) => join(dir, name);
  const write = (file, data) => writeFileSync(path(file), data);
  const contents = (file) => readFileSync(path(file));
  for (const name of [info.dmg, info.installer, info.archive, info.zip, info.portable]) write(name, "fixture " + name);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const verifier = publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64");
  const sparkleSig = sign(null, contents(info.zip), privateKey).toString("base64");
  writeLegacyMac(dir, info, sparkleSig, verifier);
  writeLegacyWindows(dir, info);
  write(info.installer + ".blockmap", gzipSync(JSON.stringify({version:"2", files:[{sizes:[contents(info.installer).length]}]})));
  const cli = fileURLToPath(new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^TAURI_SIGNING_PRIVATE_KEY/i.test(key)) delete env[key];
  const signer = (args) => execFileSync(process.execPath,[cli,"signer",...args],{env,stdio:"pipe"});
  signer(["generate","--ci","-p","temporary-fixture","-w",path("test.key")]);
  for (const name of [info.archive,info.installer]) {
    signer(["sign","-f",path("test.key"),"-p","temporary-fixture","--app-version",info.version,path(name)]);
  }
  const tauriKey = contents("test.key.pub").toString();
  const load = () => prepareFeed(dir, info, tauriKey, verifier);
  const feed = load();
  assert.equal(feed.version, info.version);
  assert.equal(feed.platforms["windows-x86_64"].url, info.base + info.installer);
  assert.deepEqual(feed.platforms["darwin-aarch64"],feed.platforms["darwin-x86_64"]);
  assert.equal(feed.platforms["darwin-aarch64"].url, info.base + info.archive);
  for (const name of [info.installer, info.archive, info.zip, "appcast.xml", "latest.yml"]) {
    const original = contents(name);
    write(name, name === "latest.yml" ? "version: 0" : Buffer.concat([original,Buffer.from("!")]));
    assert.throws(load);
    write(name, original);
  }
  write(info.archive + ".sig", contents(info.installer + ".sig"));
  assert.throws(load,/signature/i);
});
