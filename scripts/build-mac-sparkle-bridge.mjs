import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("The Sparkle bridge must be built on macOS.");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const electronVersion = JSON.parse(
  fs.readFileSync(
    path.join(root, "node_modules/electron/package.json"),
    "utf8",
  ),
).version;
const sparkleVersion = manifest.dependencies["electron-sparkle-updater"];
const localPackage = path.join(root, "node_modules/electron-sparkle-updater");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
}

// node-gyp's Makefile cannot build under a project path with spaces.
if (!/\s/.test(root)) {
  run(
    path.join(root, "node_modules/.bin/electron-sparkle-updater"),
    ["rebuild", "--electron-version", electronVersion, "--arch", "universal"],
    root,
  );
} else {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "local-dashboard-sparkle-"),
  );
  try {
    run(
      "npm",
      [
        "install",
        "--prefix",
        temporaryRoot,
        "--no-save",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `electron-sparkle-updater@${sparkleVersion}`,
      ],
      temporaryRoot,
    );
    run(
      path.join(temporaryRoot, "node_modules/.bin/electron-sparkle-updater"),
      ["rebuild", "--electron-version", electronVersion, "--arch", "universal"],
      temporaryRoot,
    );
    const builtPackage = path.join(
      temporaryRoot,
      "node_modules/electron-sparkle-updater",
    );
    run(
      "ditto",
      [
        path.join(builtPackage, "native/vendor"),
        path.join(localPackage, "native/vendor"),
      ],
      root,
    );
    const binaryDir = path.join(localPackage, "native/build/Release");
    fs.mkdirSync(binaryDir, { recursive: true });
    fs.copyFileSync(
      path.join(builtPackage, "native/build/Release/sparkle_bridge.node"),
      path.join(binaryDir, "sparkle_bridge.node"),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

for (const arch of ["arm64", "x86_64"]) {
  run(
    "lipo",
    [
      "-verify_arch",
      arch,
      path.join(localPackage, "native/build/Release/sparkle_bridge.node"),
    ],
    root,
  );
}
