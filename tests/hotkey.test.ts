import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hotkeyParts, isValidHotkey, recordedAccelerator, sameHotkey } from "../src/shared/hotkey";

const shiftedJ = { key: "J", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };

test("Mac recordings keep physical Command and Control distinct, including together", () => {
  assert.equal(recordedAccelerator({ ...shiftedJ, metaKey: true }, "darwin"), "Command+Shift+J");
  assert.equal(recordedAccelerator({ ...shiftedJ, ctrlKey: true }, "darwin"), "Control+Shift+J");
  assert.equal(recordedAccelerator({ ...shiftedJ, metaKey: true, ctrlKey: true }, "darwin"), "Command+Control+Shift+J");
  assert.equal(sameHotkey("Command+Shift+J", "Control+Shift+J", "darwin"), false);
});

test("old accelerator names and reordered modifiers compare by their platform meaning", () => {
  for (const alias of ["CommandOrControl", "Super", "Meta", "Cmd"]) {
    assert.equal(sameHotkey("Shift+" + alias + "+j", "Command+Shift+J", "darwin"), true);
  }
  assert.equal(sameHotkey("Shift+Ctrl+J", "Control+Shift+J", "darwin"), true);
  assert.equal(sameHotkey("CommandOrControl+J", "Control+J", "win32"), true);
  assert.deepEqual(hotkeyParts("Win+J", "win32"), ["Super", "J"]);
  assert.equal(recordedAccelerator({ ...shiftedJ, metaKey: true }, "win32"), "Super+Shift+J");
});

test("a modifier-only recording cannot enable Save", () => {
  const partial = recordedAccelerator({ ...shiftedJ, metaKey: true, key: "Shift" }, "darwin");
  assert.equal(isValidHotkey(partial), false);
  assert.equal(isValidHotkey("J"), false);
  assert.equal(isValidHotkey("Control+Shift+J"), true);
});
