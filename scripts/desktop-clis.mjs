import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function checkCliFolders({ root, page, api, pid, pass }) {
  assert.equal((await api("getMeta")).clisTestMode, true);
  assert.deepEqual(await api("getCliScanDirectories"), []);
  const folder = path.join(root, "Additional CLI folder");
  await fs.mkdir(folder);
  await fs.writeFile(
    path.join(folder, "fixture.txt"),
    "scan directory fixture",
  );
  await page.getByRole("button", { name: "Scan folders", exact: true }).click();
  const add = page.getByRole("button", { name: "Add folder", exact: true });
  async function pick(action) {
    await add.click();
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./desktop-cli-folder.ps1", import.meta.url)),
        "-DashboardPid",
        String(pid),
        "-FixtureRoot",
        root,
        "-Action",
        action,
      ],
      { windowsHide: true, timeout: 35000 },
    );
  }
  await pick("select");
  await page
    .getByRole("button", { name: "Scan folders (1)", exact: true })
    .waitFor();
  const selected = await api("getCliScanDirectories");
  assert.equal(selected.length, 1);
  assert.equal(await fs.realpath(selected[0].path), await fs.realpath(folder));
  assert(selected[0].id);
  await pick("select");
  assert.deepEqual(await api("getCliScanDirectories"), selected);
  await pick("cancel");
  assert.deepEqual(await api("getCliScanDirectories"), selected);
  pass(
    "Native CLI folder picker adds one fixture folder, deduplicates a second selection and preserves it on cancel",
  );
  return selected;
}

export async function removeSavedCliFolder({
  root,
  page,
  api,
  selected,
  pass,
}) {
  assert.deepEqual(await api("getCliScanDirectories"), selected);
  const toggle = page.getByRole("button", {
    name: "Scan folders (1)",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  const remove = page.getByRole("button", {
    name: "Remove scan folder " + selected[0].path,
    exact: true,
  });
  await remove.click();
  await remove.waitFor({ state: "hidden" });
  assert.deepEqual(await api("getCliScanDirectories"), []);
  const store = JSON.parse(
    await fs.readFile(path.join(root, "tauri-app-data", "clis.json"), "utf8"),
  );
  assert.deepEqual(store.scanDirectories, []);
  assert.equal(
    await fs.readFile(path.join(selected[0].path, "fixture.txt"), "utf8"),
    "scan directory fixture",
  );
  pass(
    "CLI scan folder survives restart and removing it preserves files in the directory",
  );
}

export async function checkCliActions({ root, page, api, pass, inventory }) {
  assert.equal((await api("getMeta")).clisTestMode, true);
  const codex = inventory.installations.find(
    (item) => item.productId === "codex",
  );
  const opencode = inventory.installations.find(
    (item) => item.productId === "opencode",
  );
  for (const item of [codex, opencode]) {
    assert.equal(item.packageIdentity.source, "npm");
    assert.equal(
      path.resolve(item.packageIdentity.managerExecutablePath),
      path.join(root, "npm", "node.exe"),
    );
  }
  const dialog = page.getByRole("alertdialog", {
    name: "Uninstall exact CLI installation",
  });
  const productName = (item) =>
    inventory.products.find((p) => p.id === item.productId).displayName;
  const card = (item) =>
    page.getByRole("article").filter({
      has: page.getByText(productName(item), { exact: true }),
    });
  async function expand(item) {
    const toggle = card(item).locator("button[aria-expanded]");
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
  }
  async function preview(item) {
    await expand(item);
    await card(item)
      .getByRole("button", { name: "Uninstall", exact: true })
      .click();
    await dialog.getByText(item.id, { exact: true }).waitFor();
    const details = await dialog
      .locator("dt")
      .evaluateAll((terms) =>
        Object.fromEntries(
          terms.map((term) => [
            term.textContent,
            term.nextElementSibling.textContent,
          ]),
        ),
      );
    assert.deepEqual(details, {
      Product: productName(item),
      Version: item.version,
      "Package manager": "npm",
      "Package ID": item.packageIdentity.packageId,
      "Installation ID": item.id,
      Scope: "user",
      "Commands removed": item.productId,
      "Other installation remains": "No",
      Elevation: "Not expected",
    });
  }
  const action = dialog.getByRole("button", {
    name: "Uninstall exact package",
  });
  const ids = (snapshot) => snapshot.installations.map((i) => i.id).sort();

  await expand(codex);
  await card(codex).getByRole("button", { name: "Check again" }).click();
  await page
    .getByText(
      productName(codex) +
        ": file and package checks completed. Command execution has not been verified.",
      { exact: true },
    )
    .waitFor();
  const checked = await api("getCliInventory");
  assert.notEqual(checked.revision, inventory.revision);
  assert(
    checked.installations.find((i) => i.id === codex.id).lastVerifiedAt >
      codex.lastVerifiedAt,
  );
  assert.deepEqual(ids(checked), ids(inventory));
  pass(
    "CLI Check again refreshes the installation and reports the verification result",
  );

  await preview(codex);
  assert(await action.isEnabled());
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await api("getCliInventory")).revision, checked.revision);
  pass(
    "Exact uninstall preview identifies the fixture package and Cancel preserves the revision",
  );

  await preview(opencode);
  await action.click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByText("The package manager could not remove the selected package.", {
      exact: true,
    })
    .waitFor();
  const failed = await api("getCliInventory");
  assert.deepEqual(ids(failed), ids(checked));
  assert(await card(opencode).isVisible());
  pass(
    "Simulated CLI removal failure is visible and preserves every installation",
  );

  await preview(codex);
  await action.click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByText(
      "The exact installation was removed and the inventory was refreshed.",
      { exact: true },
    )
    .waitFor();
  await card(codex).waitFor({ state: "hidden" });
  const removed = await api("getCliInventory");
  assert.notEqual(removed.revision, failed.revision);
  assert.deepEqual(
    ids(removed),
    ids(checked).filter((id) => id !== codex.id),
  );
  pass(
    "Simulated CLI removal succeeds and refreshes only the selected installation",
  );
  return removed.revision;
}
