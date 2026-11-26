import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = mkdtempSync(path.join(tmpdir(), "local-dashboard-fixture-"));
console.log("Isolated dashboard data:", root);
const child = spawn(
  process.execPath,
  [require.resolve("@tauri-apps/cli/tauri.js"), "dev"],
  {
    env: { ...process.env, LOCAL_DASHBOARD_CLIS_TEST_ROOT: root },
    stdio: "inherit",
  },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
