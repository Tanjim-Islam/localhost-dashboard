import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const legacyPublicKey = "pLcjY+xshxhfKvhZyQbg8XZZFmrPzOw+lyVUGkd9JcI=";
const text = (file) => readFileSync(file, "utf8");
const macMinimum = JSON.parse(text(join(root, "src-tauri/tauri.macos.conf.json"))).bundle.macOS.minimumSystemVersion;
const rawPublicKey = (bytes) => {
  assert.equal(bytes.length, 32, "Invalid Ed25519 public key");
  return createPublicKey({ format: "der", type: "spki", key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), bytes,
  ]) });
};

export function releaseInfo(version, repository, notes, date) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(notes.trim(), "Missing release notes");
  assert.ok(Number.isFinite(Date.parse(date)), "Invalid release date");
  const prefix = "Localhost-Dashboard-";
  return {
    version, notes: notes.trim(), date, macMinimum, base: "https://github.com/" + repository + "/releases/download/v" + version + "/",
    installer: prefix + "Setup-" + version + ".exe", portable: prefix + version + ".exe",
    dmg: prefix + version + "-universal.dmg", zip: prefix + version + "-universal.zip",
    archive: prefix + version + "-universal.app.tar.gz",
  };
}

function checkTauri(artifact, signature, publicKey, version) {
  const unwrap = (s) => Buffer.from(s.trim(), "base64").toString("utf8").trimEnd().split(/\r?\n/);
  const [, keyLine] = unwrap(publicKey);
  const [, body, comment, globalLine] = unwrap(signature);
  assert.ok(keyLine && body && comment?.startsWith("trusted comment: ") && globalLine, "Invalid updater signature envelope");
  const key = Buffer.from(keyLine, "base64");
  const packet = Buffer.from(body, "base64");
  assert.equal(key.length, 42);
  assert.equal(packet.length, 74);
  assert.equal(key.subarray(0, 2).toString(), "Ed");
  assert.equal(packet.subarray(0, 2).toString(), "ED", "Expected prehashed Minisign signature");
  assert.deepEqual(packet.subarray(2, 10), key.subarray(2, 10), "Signing key ID mismatch");
  const publicObject = rawPublicKey(key.subarray(10));
  const signatureBytes = packet.subarray(10);
  const digest = createHash("blake2b512").update(artifact).digest();
  assert.ok(verify(null, digest, publicObject, signatureBytes), "Invalid Tauri artifact signature");
  const signedComment = Buffer.concat([signatureBytes, Buffer.from(comment.slice("trusted comment: ".length))]);
  assert.ok(verify(null, signedComment, publicObject, Buffer.from(globalLine, "base64")), "Invalid Tauri trusted comment");
  assert.ok(comment.split("\t").includes("version:" + version), "Signature version differs from release");
}

export function writeLegacyWindows(dir, info) {
  const bytes = readFileSync(join(dir, info.installer));
  const sha = createHash("sha512").update(bytes).digest("base64");
  const lines = ["version: " + info.version, "files:", "  - url: " + info.installer,
    "    sha512: " + sha, "    size: " + bytes.length, "path: " + info.installer,
    "sha512: " + sha, "releaseDate: '" + info.date + "'", ""];
  writeFileSync(join(dir, "latest.yml"), lines.join("\n"));
}

function legacyMacXml(info, length, signature) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">',
    '<channel><title>Localhost Dashboard</title><item>',
    '<title>Localhost Dashboard ' + info.version + '</title>',
    '<sparkle:version>' + info.version + '</sparkle:version>',
    '<sparkle:shortVersionString>' + info.version + '</sparkle:shortVersionString>',
    '<sparkle:minimumSystemVersion>' + info.macMinimum + '</sparkle:minimumSystemVersion>',
    '<enclosure url="' + info.base + info.zip + '" length="' + length + '" type="application/octet-stream" sparkle:edSignature="' + signature + '"/>',
    '</item></channel></rss>', '',
  ].join('\n');
}

export function writeLegacyMac(dir, info, signature, verifier = legacyPublicKey) {
  const zip = readFileSync(join(dir, info.zip));
  assert.ok(verify(null, zip, rawPublicKey(Buffer.from(verifier, "base64")), Buffer.from(signature, "base64")), "Invalid Sparkle ZIP signature");
  writeFileSync(join(dir, "appcast.xml"), legacyMacXml(info, zip.length, signature));
}

export function prepareFeed(dir, info, publicKey, sparkleKey = legacyPublicKey) {
  const required = [info.installer, info.installer + ".sig", info.installer + ".blockmap", info.portable,
    info.dmg, info.archive, info.archive + ".sig", info.zip, "latest.yml", "appcast.xml"];
  for (const name of required) assert.ok(statSync(join(dir, name)).size > 0, "Empty asset " + name);
  const platform = (name) => {
    const bytes = readFileSync(join(dir, name));
    const signature = text(join(dir, name + ".sig")).trim();
    checkTauri(bytes, signature, publicKey, info.version);
    return { url: info.base + name, signature };
  };
  const mac = platform(info.archive);
  const windows = platform(info.installer);
  const zip = readFileSync(join(dir, info.zip));
  const xml = text(join(dir, "appcast.xml"));
  const edSignature = /sparkle:edSignature="([A-Za-z0-9+/=]+)"/.exec(xml)?.[1];
  assert.ok(edSignature && verify(null, zip, rawPublicKey(Buffer.from(sparkleKey, "base64")), Buffer.from(edSignature, "base64")), "Bad Sparkle feed signature");
  assert.equal(xml, legacyMacXml(info, zip.length, edSignature), "Sparkle metadata differs from release assets");
  const installer = readFileSync(join(dir, info.installer));
  const sha = createHash("sha512").update(installer).digest("base64");
  const yml = text(join(dir, "latest.yml")).split(/\r?\n/);
  for (const line of ["version: " + info.version, "  - url: " + info.installer, "    size: " + installer.length,
    "path: " + info.installer, "sha512: " + sha, "    sha512: " + sha]) assert.ok(yml.includes(line), "Invalid Windows feed");
  const blockmap = JSON.parse(gunzipSync(readFileSync(join(dir, info.installer + ".blockmap"))));
  assert.equal(blockmap.version, "2");
  assert.equal(blockmap.files.reduce((n, file) => n + file.sizes.reduce((a,b) => a+b, 0), 0), installer.length, "Blockmap size mismatch");
  return { version: info.version, notes: info.notes, pub_date: info.date,
    platforms: { "darwin-aarch64": mac, "darwin-x86_64": mac, "windows-x86_64": windows } };
}

function one(dir, suffix) {
  const names = readdirSync(dir).filter((s) => s.endsWith(suffix));
  assert.equal(names.length, 1, "Expected one " + suffix + " file in " + dir);
  return join(dir, names[0]);
}

function stage(dir, release, info, platform, publicKey) {
  const assets = platform === "windows"
    ? [[one(join(release, "bundle/nsis"), "-setup.exe"), info.installer],
       [one(join(release, "bundle/nsis"), "-setup.exe.sig"), info.installer + ".sig"],
       [join(release, "local-dashboard.exe"), info.portable]]
    : [[one(join(release, "bundle/dmg"), ".dmg"), info.dmg],
       [one(join(release, "bundle/macos"), ".app.tar.gz"), info.archive],
       [one(join(release, "bundle/macos"), ".app.tar.gz.sig"), info.archive + ".sig"]];
  mkdirSync(dir, { recursive: true });
  for (const [source, name] of assets) copyFileSync(source, join(dir, name));
  const update = join(dir, platform === "windows" ? info.installer : info.archive);
  checkTauri(readFileSync(update), text(update + ".sig"), publicKey, info.version);
  if (platform === "windows") writeLegacyWindows(dir, info);
}

function run(command, args) {
  const pkg = JSON.parse(text(join(root, "package.json")));
  const stamp = process.env.RELEASE_DATE;
  const repo = process.env.GITHUB_REPOSITORY;
  const info = releaseInfo(pkg.version, repo, text(join(root, "docs/releases/v" + pkg.version + ".md")), stamp);
  const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
  if (command === "validate") {
    assert.equal(process.env.GITHUB_REF_NAME, "v" + info.version);
    const cfg = JSON.parse(text(join(root,"src-tauri/tauri.conf.json")));
    const lock = JSON.parse(text(join(root, "package-lock.json")));
    assert.equal(lock.version, info.version);
    assert.equal(lock.packages[""].version, info.version);
    assert.equal(cfg.version, info.version);
    assert.equal(/^version\s*=\s*"([^"]+)"/m.exec(text(join(root, "src-tauri/Cargo.toml")))?.[1], info.version);
    assert.ok(text(join(root, "src-tauri/Cargo.lock")).replaceAll("\r\n","\n").includes('name = "local-dashboard"\nversion = "' + info.version + '"'));
    assert.ok(publicKey && Buffer.from(publicKey,"base64").toString().startsWith("untrusted comment:"), "Set TAURI_UPDATER_PUBLIC_KEY");
  } else if (command === "config") {
    assert.ok(publicKey);
    writeFileSync(args[0], JSON.stringify({
      bundle: {createUpdaterArtifacts: true, macOS: {bundleVersion: info.version}},
      plugins: {updater:{pubkey:publicKey,requireSignedVersion:true}},
    }));
  } else if (command === "stage") {
    assert.ok(["mac","windows"].includes(args[0]));
    stage(args[2], args[1], info, args[0], publicKey);
  } else if (command === "sparkle") {
    const signature = /sparkle:edSignature="([A-Za-z0-9+/=]+)"/.exec(text(args[1]))?.[1];
    assert.ok(signature, "Sparkle returned no signature");
    writeLegacyMac(args[0], info, signature);
  } else if (command === "feed" || command === "verify") {
    const feed = prepareFeed(args[0], info, publicKey);
    const target = join(args[0], "latest.json");
    if (command === "feed") writeFileSync(target, JSON.stringify(feed,null,2) + "\n");
    else assert.deepEqual(JSON.parse(text(target)), feed);
  } else throw Error("Unknown release command " + command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2], process.argv.slice(3));
}
