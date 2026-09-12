import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package both architectures, including for electron-builder's universal app.
if (process.platform === "darwin") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = path.join(root, "resources/server-restart/darwin-process-helper");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync("/usr/bin/clang", [
    "-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter",
    "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=12.0",
    "-framework", "Foundation", path.join(root, "native/server-process.m"), "-o", output,
  ], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", output], { stdio: "inherit" });
}
