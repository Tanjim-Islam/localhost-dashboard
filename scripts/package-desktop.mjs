import { spawnSync } from "node:child_process";

// Invoke npm through Node so Windows does not need to execute a .cmd shim.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run packaging through npm run package.");

function runNpm(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}

runNpm(["run", "build"]);
if (process.platform === "darwin") {
  runNpm(["run", "build:mac-sparkle-bridge"]);
}
runNpm([
  "exec",
  "--",
  "electron-builder",
  "--publish",
  "never",
  ...process.argv.slice(2),
]);
