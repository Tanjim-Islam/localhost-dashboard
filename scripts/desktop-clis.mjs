import assert from "node:assert/strict";
import path from "node:path";

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
