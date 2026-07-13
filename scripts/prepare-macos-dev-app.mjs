import { copyFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const APP_DISPLAY_NAME = "Localhost Dashboard";

if (process.platform !== "darwin") {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electronModulePath = require.resolve("electron");
const electronRoot = dirname(electronModulePath);
const pathFile = join(electronRoot, "path.txt");
const distRoot = join(electronRoot, "dist");
const stockAppRoot = join(distRoot, "Electron.app");
const appRoot = join(distRoot, `${APP_DISPLAY_NAME}.app`);
const stockExecutable = join(appRoot, "Contents", "MacOS", "Electron");
const appExecutable = join(appRoot, "Contents", "MacOS", APP_DISPLAY_NAME);
const plistPath = join(appRoot, "Contents", "Info.plist");
const resourcesPath = join(appRoot, "Contents", "Resources");
const sourceDockIcon = resolve("resources", "icon-dock.png");
const targetDockIcon = join(resourcesPath, "localhost-dashboard-dock.png");

if (!existsSync(appRoot) && existsSync(stockAppRoot)) {
  renameSync(stockAppRoot, appRoot);
}

if (existsSync(stockExecutable) && !existsSync(appExecutable)) {
  renameSync(stockExecutable, appExecutable);
}

if (!existsSync(plistPath) || !existsSync(appExecutable)) {
  process.exit(0);
}

setPlistValue(plistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
setPlistValue(plistPath, "CFBundleName", APP_DISPLAY_NAME);
setPlistValue(plistPath, "CFBundleIdentifier", "com.localdashboard.dev");
setPlistValue(plistPath, "CFBundleExecutable", APP_DISPLAY_NAME);

if (existsSync(sourceDockIcon)) {
  copyFileSync(sourceDockIcon, targetDockIcon);
}

execFileSync("/usr/bin/touch", [appRoot]);
writeFileSync(
  pathFile,
  `${APP_DISPLAY_NAME}.app/Contents/MacOS/${APP_DISPLAY_NAME}`,
);

function setPlistValue(plistPath, key, value) {
  const command = `/usr/libexec/PlistBuddy`;
  const setArgs = ["-c", `Set :${key} ${value}`, plistPath];
  const addArgs = ["-c", `Add :${key} string ${value}`, plistPath];

  try {
    execFileSync(command, setArgs, { stdio: "ignore" });
  } catch {
    execFileSync(command, addArgs, { stdio: "ignore" });
  }
}
