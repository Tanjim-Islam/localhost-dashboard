// Exercises login-launch visibility without writing to Windows or macOS startup settings.
import assert from "node:assert/strict";
import test from "node:test";
import {
  getElectronLoginItemSettings,
  HIDDEN_LOGIN_ARGUMENT,
  shouldManageSystemLoginItem,
  shouldSynchronizeSystemLoginItemAtLaunch,
  shouldStartInTray,
} from "../src/main/startup-visibility.ts";

test("development builds never write operating system login items", () => {
  assert.equal(shouldManageSystemLoginItem(false), false);
});

test("packaged builds keep operating system login items synchronized", () => {
  assert.equal(shouldManageSystemLoginItem(true), true);
});

test("packaged Windows repairs its login item on every launch", () => {
  assert.equal(
    shouldSynchronizeSystemLoginItemAtLaunch({
      platform: "win32",
      isPackaged: true,
      settingsWereSeeded: false,
    }),
    true,
  );
});

test("packaged macOS only registers its login item after first-run seeding", () => {
  assert.equal(
    shouldSynchronizeSystemLoginItemAtLaunch({
      platform: "darwin",
      isPackaged: true,
      settingsWereSeeded: true,
    }),
    true,
  );
  assert.equal(
    shouldSynchronizeSystemLoginItemAtLaunch({
      platform: "darwin",
      isPackaged: true,
      settingsWereSeeded: false,
    }),
    false,
  );
});

test("development launches never synchronize native login items", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    assert.equal(
      shouldSynchronizeSystemLoginItemAtLaunch({
        platform,
        isPackaged: false,
        settingsWereSeeded: true,
      }),
      false,
    );
  }
});

test("packaged Windows startup uses the installed executable", () => {
  assert.deepEqual(
    getElectronLoginItemSettings({
      platform: "win32",
      isPackaged: true,
      enabled: true,
      openInTrayAtLogin: true,
      executablePath: "C:\\Program Files\\Localhost Dashboard.exe",
    }),
    {
      openAtLogin: true,
      name: "Localhost Dashboard",
      path: "C:\\Program Files\\Localhost Dashboard.exe",
      args: [HIDDEN_LOGIN_ARGUMENT],
    },
  );
});

test("development Windows startup cannot register raw Electron", () => {
  assert.equal(
    getElectronLoginItemSettings({
      platform: "win32",
      isPackaged: false,
      enabled: true,
      openInTrayAtLogin: true,
      executablePath: "D:\\project\\node_modules\\electron\\electron.exe",
    }),
    null,
  );
});

test("packaged macOS startup keeps native hidden-login settings", () => {
  assert.deepEqual(
    getElectronLoginItemSettings({
      platform: "darwin",
      isPackaged: true,
      enabled: true,
      openInTrayAtLogin: true,
      executablePath:
        "/Applications/Localhost Dashboard.app/Contents/MacOS/Localhost Dashboard",
    }),
    {
      openAtLogin: true,
      openAsHidden: true,
    },
  );
});

test("development macOS startup does not alter native login items", () => {
  assert.equal(
    getElectronLoginItemSettings({
      platform: "darwin",
      isPackaged: false,
      enabled: true,
      openInTrayAtLogin: true,
      executablePath:
        "/project/node_modules/electron/Electron.app/Contents/MacOS/Electron",
    }),
    null,
  );
});

test("Windows login launch starts in the tray when enabled", () => {
  assert.equal(
    shouldStartInTray({
      platform: "win32",
      argv: ["Localhost Dashboard.exe", HIDDEN_LOGIN_ARGUMENT],
      startAtLogin: true,
      openInTrayAtLogin: true,
    }),
    true,
  );
});

test("Windows manual launch still opens the window", () => {
  assert.equal(
    shouldStartInTray({
      platform: "win32",
      argv: ["Localhost Dashboard.exe"],
      startAtLogin: true,
      openInTrayAtLogin: true,
    }),
    false,
  );
});

test("macOS login launch starts in the tray when enabled", () => {
  assert.equal(
    shouldStartInTray({
      platform: "darwin",
      argv: ["Localhost Dashboard"],
      startAtLogin: true,
      openInTrayAtLogin: true,
      wasOpenedAtLogin: true,
    }),
    true,
  );
});

test("the tray preference can keep login launches visible", () => {
  for (const platform of ["win32", "darwin"] as const) {
    assert.equal(
      shouldStartInTray({
        platform,
        argv: ["Localhost Dashboard", HIDDEN_LOGIN_ARGUMENT],
        startAtLogin: true,
        openInTrayAtLogin: false,
        wasOpenedAtLogin: true,
      }),
      false,
    );
  }
});

test("disabled login startup never hides the app", () => {
  assert.equal(
    shouldStartInTray({
      platform: "win32",
      argv: ["Localhost Dashboard.exe", HIDDEN_LOGIN_ARGUMENT],
      startAtLogin: false,
      openInTrayAtLogin: true,
    }),
    false,
  );
});
