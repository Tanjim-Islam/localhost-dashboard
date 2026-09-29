import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

run("npm", ["run", "build"]);
if (process.platform === "darwin") {
  run("npm", ["run", "build:mac-sparkle-bridge"]);
}
run("npx", [
  "electron-builder",
  "--publish",
  "never",
  ...process.argv.slice(2),
]);
