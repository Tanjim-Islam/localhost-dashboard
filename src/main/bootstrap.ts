import { app } from "electron";
import path from "node:path";

const cleanerTestRoot = process.env["LOCAL_DASHBOARD_CLEANER_TEST_ROOT"];
const clisTestRoot = process.env["LOCAL_DASHBOARD_CLIS_TEST_ROOT"];
const isolatedTestRoot = cleanerTestRoot ?? clisTestRoot;
if (isolatedTestRoot) {
  app.setPath(
    "userData",
    path.join(isolatedTestRoot, "electron-app-data", "Electron"),
  );
}

await import("./index");
