import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isSecretEnvironmentVariableName,
  normalizeEnvironmentVariableName,
  validateEnvironmentVariableName,
  validateEnvironmentVariableScope,
  validateSaveEnvironmentVariableInput,
} from "../src/main/environment-variables";

test("detects credential-like environment variable names without substring noise", () => {
  for (const name of [
    "DHL_API_KEY",
    "DHL_API_SECRET",
    "GH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "GITHUB_PAT",
    "SERVICE_PASSWORD",
  ]) {
    assert.equal(isSecretEnvironmentVariableName(name), true, name);
  }

  for (const name of [
    "PATH",
    "CUDA_PATH",
    "SSH_AUTH_SOCK",
    "MONKEY_MODE",
    "KEYBOARD_LAYOUT",
  ]) {
    assert.equal(isSecretEnvironmentVariableName(name), false, name);
  }
});

test("normalizes and validates editable environment variable names", () => {
  assert.equal(normalizeEnvironmentVariableName("  gh_token  "), "GH_TOKEN");
  assert.equal(validateEnvironmentVariableName(" dhl_api_key "), "DHL_API_KEY");
  assert.throws(() => validateEnvironmentVariableName("9_DHL_KEY"));
  assert.throws(() => validateEnvironmentVariableName("DHL-API-KEY"));
  assert.throws(() => validateEnvironmentVariableName("DATABASE_URL"));
});

test("validates scope and preserves secret values exactly", () => {
  assert.equal(validateEnvironmentVariableScope("user"), "user");
  assert.equal(validateEnvironmentVariableScope("machine"), "machine");
  assert.throws(() => validateEnvironmentVariableScope("process"));

  const parsed = validateSaveEnvironmentVariableInput({
    name: " local_dashboard_test_key ",
    scope: "user",
    value: "  keep surrounding spaces  ",
    original: {
      name: "LOCAL_DASHBOARD_OLD_KEY",
      scope: "user",
    },
  });

  assert.deepEqual(parsed, {
    name: "LOCAL_DASHBOARD_TEST_KEY",
    scope: "user",
    value: "  keep surrounding spaces  ",
    original: {
      name: "LOCAL_DASHBOARD_OLD_KEY",
      scope: "user",
    },
  });
});
