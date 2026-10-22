import { app } from "electron";
import path from "node:path";

const isolatedTestRoot = process.env["LOCAL_DASHBOARD_CLIS_TEST_ROOT"];
if (isolatedTestRoot) {
  app.setPath(
    "userData",
    path.join(isolatedTestRoot, "electron-app-data", "Electron"),
  );
}

await import("./index");
