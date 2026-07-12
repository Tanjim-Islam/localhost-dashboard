// Exercises login-launch visibility without writing to Windows or macOS startup settings.
import assert from "node:assert/strict";
import test from "node:test";
import {
  HIDDEN_LOGIN_ARGUMENT,
  shouldStartInTray,
} from "../src/main/startup-visibility.ts";

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
