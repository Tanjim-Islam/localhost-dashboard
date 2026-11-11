// Read-only renderer QA. Run against an already launched isolated Electron page:
// await require('./scripts/animations.ui-checks.cjs').runAnimationChecks(page)
// No package uninstall, environment mutation, or server stop is performed.
const assert = require("node:assert/strict");

async function sampleClick(locator, selector) {
  await locator.focus();
  return locator.evaluate((button, targetSelector) => {
    button.click();
    return new Promise(resolve => {
      const started = performance.now();
      const samples = [];
      const frame = () => {
        const target = document.querySelector(targetSelector);
        samples.push(target ? Number(getComputedStyle(target).opacity) : null);
        if (performance.now() - started < 350) requestAnimationFrame(frame);
        else resolve(samples);
      };
      requestAnimationFrame(frame);
    });
  }, selector);
}

function assertTransition(samples, closing, label) {
  assert(samples.some(value => value !== null && value > 0 && value < 1), `${label} has intermediate animation frames`);
  assert.equal(samples.at(-1), closing ? null : 1, `${label} reaches its final state`);
}

async function runAnimationChecks(page) {
  const results = [];
  const record = name => results.push(name);
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const settingsSelector = '.fixed:has([aria-labelledby="settings-title"])';
  const opening = await sampleClick(settings, settingsSelector);
  assertTransition(opening, false, "Settings opening");
  record("Settings opening uses intermediate motion frames");

  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('[aria-labelledby="settings-title"]');
    const scroll = dialog.querySelector(".settings-scroll");
    const footer = dialog.querySelector("footer");
    const before = footer.getBoundingClientRect();
    scroll.scrollTop = scroll.scrollHeight;
    const after = footer.getBoundingClientRect();
    return {
      topBefore: before.top, topAfter: after.top, bottom: after.bottom,
      viewportHeight: innerHeight, scrollable: scroll.scrollHeight > scroll.clientHeight,
      footerOutsideScroll: !scroll.contains(footer),
      labels: Array.from(footer.querySelectorAll("button")).map(button => button.textContent.trim()),
    };
  });
  assert(geometry.scrollable && geometry.footerOutsideScroll);
  assert.equal(geometry.topBefore, geometry.topAfter);
  assert(geometry.bottom <= geometry.viewportHeight);
  assert.deepEqual(geometry.labels, ["Reset to defaults", "Save"]);
  record("Save and Reset stay visible when Settings scrolls at 900x600");

  const reset = page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Reset to defaults", exact: true });
  await reset.focus();
  await page.keyboard.press("Tab");
  assert(await page.getByRole("button", { name: "Close settings", exact: true }).evaluate(button => button === document.activeElement));
  record("Settings traps keyboard focus");
  const closing = await sampleClick(page.getByRole("button", { name: "Close settings", exact: true }), settingsSelector);
  assertTransition(closing, true, "Settings closing");
  assert(await settings.evaluate(button => button === document.activeElement));
  record("Settings closing animates and restores trigger focus");

  const clis = page.getByRole("button", { name: /^CLIs(?:\s|$)/ });
  if (await clis.count()) {
    await clis.click();
    const folders = page.getByRole("button", { name: "Scan folders", exact: true });
    await folders.waitFor({ state: "visible" });
    await folders.click();
    const addFolder = page.getByRole("button", { name: "Add folder", exact: true });
    await addFolder.waitFor({ state: "visible" });
    assert.equal(await folders.getAttribute("aria-expanded"), "true");
    await folders.click();
    await addFolder.waitFor({ state: "detached" });
    assert.equal(await folders.getAttribute("aria-expanded"), "false");
    record("CLI scan folders opens and closes without picking or changing folders");

    const product = page.locator('[aria-label="Developer CLIs"] article > button[aria-expanded]').first();
    if (await product.count()) {
      if (await product.getAttribute("aria-expanded") === "true") await product.click();
      await product.click();
      assert.equal(await product.getAttribute("aria-expanded"), "true");
      await product.click();
      assert.equal(await product.getAttribute("aria-expanded"), "false");
      record("CLI product details expand and collapse");
    }
  }

  const environment = page.getByRole("button", { name: /^ENV Keys(?:\s|$)/ });
  if (await environment.count()) {
    await environment.click();
    const addKey = page.getByRole("button", { name: "Add key", exact: true });
    await addKey.waitFor({ state: "visible" });
    await addKey.click();
    const editor = page.getByRole("dialog", { name: "Add ENV key", exact: true });
    await editor.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
    assert(await addKey.evaluate(button => button === document.activeElement));
    record("ENV editor opens and closes with Escape, returning focus without writing any key");
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await sampleClick(settings, settingsSelector);
  assert.equal(reduced.at(-1), 1);
  assert(!reduced.some(value => value !== null && value > 0 && value < 1), "Reduced motion opens without intermediate opacity frames");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
  record("Reduced motion skips Settings animation and still dismisses correctly");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  if (originalViewport) await page.setViewportSize(originalViewport);
  return { passed: results, openingFrames: opening, closingFrames: closing, footerGeometry: geometry };
}

module.exports = { runAnimationChecks };
