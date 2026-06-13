import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  APP_DISPLAY_NAME,
  getDockIconInsetScale,
  getRendererLoadMode,
  shouldEnableAutoUpdater,
  shouldCreateTrayIcon,
  shouldShowDockForWindowState,
} from "../src/main/app-identity";

test("uses the Localhost Dashboard app name everywhere the app can control", () => {
  assert.equal(APP_DISPLAY_NAME, "Localhost Dashboard");
});

test("hides the Dock tile on macOS when the dashboard window is hidden", () => {
  assert.equal(shouldShowDockForWindowState("darwin", true), true);
  assert.equal(shouldShowDockForWindowState("darwin", false), false);
});

test("does not apply macOS Dock visibility behavior to Windows", () => {
  assert.equal(shouldShowDockForWindowState("win32", true), false);
  assert.equal(shouldShowDockForWindowState("win32", false), false);
});

test("keeps tray support off on macOS while preserving it elsewhere", () => {
  assert.equal(shouldCreateTrayIcon("darwin"), false);
  assert.equal(shouldCreateTrayIcon("win32"), true);
  assert.equal(shouldCreateTrayIcon("linux"), true);
});

test("insets the Dock icon artwork so it matches normal macOS icon weight", () => {
  const scale = getDockIconInsetScale();
  assert.equal(scale, 0.82);
});

test("keeps update checks disabled for renamed macOS dev bundles", () => {
  assert.equal(shouldEnableAutoUpdater(true, "http://localhost:5173"), false);
  assert.equal(shouldEnableAutoUpdater(true, undefined), true);
  assert.equal(shouldEnableAutoUpdater(false, undefined), false);
});

test("loads the dev renderer URL whenever it is provided", () => {
  assert.equal(getRendererLoadMode(true, "http://localhost:5173"), "dev-url");
  assert.equal(getRendererLoadMode(false, "http://localhost:5173"), "dev-url");
  assert.equal(getRendererLoadMode(true, undefined), "file");
});
