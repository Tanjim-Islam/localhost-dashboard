import { app } from "electron";
import path from "node:path";

const cleanerTestRoot = process.env["LOCAL_DASHBOARD_CLEANER_TEST_ROOT"];
if (cleanerTestRoot) {
  app.setPath(
    "userData",
    path.join(cleanerTestRoot, "electron-app-data", "Electron"),
  );
}

await import("./index");
