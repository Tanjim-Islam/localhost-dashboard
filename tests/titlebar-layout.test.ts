import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getTitleBarLayout } from "../src/renderer/components/titleBarLayout";

test("macOS title bar leaves room for traffic lights and uses native window controls", () => {
  assert.deepEqual(getTitleBarLayout("darwin"), {
    rootPaddingClass: "pl-[86px]",
    showWindowControls: false,
    showLeadingStatusDot: false,
  });
});

test("Windows title bar keeps right-side window controls without macOS padding", () => {
  assert.deepEqual(getTitleBarLayout("win32"), {
    rootPaddingClass: "pl-3",
    showWindowControls: true,
    showLeadingStatusDot: true,
  });
});
