import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  getDefaultGlobalHotkey,
  getPlatformFeatures,
} from "../src/main/platform-features";

test("enables Automator only on macOS", () => {
  assert.deepEqual(getPlatformFeatures("darwin"), {
    servers: true,
    ahkScripts: false,
    automatorScripts: true,
    environmentKeys: false,
    cleaner: false,
    clis: true,
  });
});

test("keeps AHK support Windows-only", () => {
  assert.deepEqual(getPlatformFeatures("win32"), {
    servers: true,
    ahkScripts: true,
    automatorScripts: false,
    environmentKeys: true,
    cleaner: true,
    clis: true,
  });
});

test("unsupported platforms expose only working shared features", () => {
  assert.deepEqual(getPlatformFeatures("linux"), {
    servers: true,
    ahkScripts: false,
    automatorScripts: false,
    environmentKeys: false,
    cleaner: false,
    clis: false,
  });
});

test("uses platform-specific global hotkey defaults", () => {
  assert.equal(getDefaultGlobalHotkey("darwin"), "Command+Shift+D");
  assert.equal(getDefaultGlobalHotkey("win32"), "Control+Alt+Shift+D");
  assert.equal(getDefaultGlobalHotkey("linux"), "Ctrl+Shift+D");
});
