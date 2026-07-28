import type {
  CliInstallationRef,
  CliUninstallRequest,
} from "./types";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,95}$/i;

export function validateCliSessionId(value: unknown): string {
  return validateId(value, "CLI scan session ID");
}

export function validateCliInstallationRef(
  value: unknown,
): CliInstallationRef {
  const record = requireRecord(value, "CLI installation reference");
  return {
    installationId: validateId(
      record.installationId,
      "CLI installation ID",
    ),
    inventoryRevision: validateId(
      record.inventoryRevision,
      "CLI inventory revision",
    ),
  };
}

export function validateCliUninstallRequest(
  value: unknown,
): CliUninstallRequest {
  const record = requireRecord(value, "CLI uninstall request");
  if (record.confirmation !== "uninstall-exact-cli-installation") {
    throw new Error("CLI uninstall confirmation is invalid.");
  }
  return {
    installationId: validateId(
      record.installationId,
      "CLI installation ID",
    ),
    inventoryRevision: validateId(
      record.inventoryRevision,
      "CLI inventory revision",
    ),
    previewToken: validateId(record.previewToken, "CLI uninstall preview token"),
    confirmation: "uninstall-exact-cli-installation",
  };
}

function validateId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !ID_PATTERN.test(value) ||
    value.length > 96
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is required.`);
  }
  return value as Record<string, unknown>;
}
