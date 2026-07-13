import { strict as assert } from "node:assert";
import {
  deleteEnvironmentVariable,
  getEnvironmentVariableValue,
  listEnvironmentVariables,
  saveEnvironmentVariable,
} from "../src/main/environment-variables.ts";

if (process.platform !== "win32") {
  console.log("ENV key integration test skipped, Windows only.");
  process.exit(0);
}

const originalName = `LOCAL_DASHBOARD_TEST_KEY_${process.pid}`;
const renamedName = `${originalName}_RENAMED`;
const firstValue = "local-dashboard-test-value-one";
const secondValue = "local-dashboard-test-value-two-✓";

async function deleteIfPresent(name: string): Promise<void> {
  try {
    await getEnvironmentVariableValue({ name, scope: "user" });
    await deleteEnvironmentVariable({ name, scope: "user" });
  } catch {
    // The temporary variable is already absent.
  }
}

try {
  await saveEnvironmentVariable({
    name: originalName,
    scope: "user",
    value: firstValue,
  });
  assert.equal(
    await getEnvironmentVariableValue({ name: originalName, scope: "user" }),
    firstValue,
  );

  const created = await listEnvironmentVariables();
  assert.ok(created.some((item) => item.name === originalName));

  await saveEnvironmentVariable({
    name: renamedName,
    scope: "user",
    value: secondValue,
    original: { name: originalName, scope: "user" },
  });
  await assert.rejects(() =>
    getEnvironmentVariableValue({ name: originalName, scope: "user" }),
  );
  assert.equal(
    await getEnvironmentVariableValue({ name: renamedName, scope: "user" }),
    secondValue,
  );

  await deleteEnvironmentVariable({ name: renamedName, scope: "user" });
  await assert.rejects(() =>
    getEnvironmentVariableValue({ name: renamedName, scope: "user" }),
  );
  console.log("ENV key create, read, rename, edit, and delete checks passed.");
} finally {
  await deleteIfPresent(originalName);
  await deleteIfPresent(renamedName);
}
