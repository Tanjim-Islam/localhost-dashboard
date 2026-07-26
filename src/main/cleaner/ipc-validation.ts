import type {
  CleanCleanerFindingsInput,
  CleanerExclusionScope,
  CleanerPreferences,
  StartCleanerScanInput,
  UpdateCleanerExclusionsInput,
} from "./types";

const SESSION_ID_PATTERN = /^[0-9a-f-]{20,64}$/i;
const FINDING_ID_PATTERN = /^[0-9a-f]{32}$/i;
const EXCLUSION_ID_PATTERN = /^[0-9a-f]{24}$/i;
const EXCLUSION_SCOPES = new Set<CleanerExclusionScope>([
  "category",
  "detector",
  "application",
  "root",
  "path",
  "finding",
]);

export function validateStartCleanerScanInput(
  value: unknown,
): StartCleanerScanInput {
  const input = requirePlainObject(value, ["mode"]);
  if (input.mode !== "standard" && input.mode !== "deep") {
    throw new Error("Cleaner scan mode must be standard or deep.");
  }
  return { mode: input.mode };
}

export function validateCleanerSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error("Cleaner scan session id is invalid.");
  }
  return value;
}

export function validateCleanCleanerFindingsInput(
  value: unknown,
): CleanCleanerFindingsInput {
  const input = requirePlainObject(value, [
    "scanSessionId",
    "findingIds",
    "confirmation",
  ]);
  const scanSessionId = validateCleanerSessionId(input.scanSessionId);
  if (!Array.isArray(input.findingIds) || input.findingIds.length === 0) {
    throw new Error("At least one Cleaner finding id is required.");
  }
  if (input.findingIds.length > 200) {
    throw new Error("Too many Cleaner findings were selected.");
  }
  const findingIds = input.findingIds.map((id) => {
    if (typeof id !== "string" || !FINDING_ID_PATTERN.test(id)) {
      throw new Error("Cleaner finding id is invalid.");
    }
    return id;
  });
  if (new Set(findingIds).size !== findingIds.length) {
    throw new Error("Duplicate Cleaner finding ids are not allowed.");
  }
  if (input.confirmation !== "safe" && input.confirmation !== "conditional") {
    throw new Error("Cleaner confirmation level is invalid.");
  }
  return { scanSessionId, findingIds, confirmation: input.confirmation };
}

export function validateUpdateCleanerExclusionsInput(
  value: unknown,
): UpdateCleanerExclusionsInput {
  const outer = requirePlainObject(value, [
    "action",
    "exclusion",
    "exclusionId",
  ]);
  if (outer.action === "remove") {
    if (
      typeof outer.exclusionId !== "string" ||
      !EXCLUSION_ID_PATTERN.test(outer.exclusionId)
    ) {
      throw new Error("Cleaner exclusion id is invalid.");
    }
    if (outer.exclusion !== undefined) {
      throw new Error(
        "Remove exclusion payload cannot include exclusion data.",
      );
    }
    return { action: "remove", exclusionId: outer.exclusionId };
  }
  if (outer.action !== "add" || outer.exclusionId !== undefined) {
    throw new Error("Cleaner exclusion action is invalid.");
  }
  const exclusion = requirePlainObject(outer.exclusion, [
    "scope",
    "value",
    "label",
  ]);
  if (
    typeof exclusion.scope !== "string" ||
    !EXCLUSION_SCOPES.has(exclusion.scope as CleanerExclusionScope)
  ) {
    throw new Error("Cleaner exclusion scope is invalid.");
  }
  if (
    typeof exclusion.value !== "string" ||
    !exclusion.value.trim() ||
    exclusion.value.length > 2048 ||
    typeof exclusion.label !== "string" ||
    !exclusion.label.trim() ||
    exclusion.label.length > 256
  ) {
    throw new Error("Cleaner exclusion value or label is invalid.");
  }
  return {
    action: "add",
    exclusion: {
      scope: exclusion.scope as CleanerExclusionScope,
      value: exclusion.value,
      label: exclusion.label,
    },
  };
}

export function validateCleanerPreferences(value: unknown): CleanerPreferences {
  const input = requirePlainObject(value, ["defaultScanMode", "showExcluded"]);
  if (
    input.defaultScanMode !== "standard" &&
    input.defaultScanMode !== "deep"
  ) {
    throw new Error("Cleaner default scan mode is invalid.");
  }
  if (typeof input.showExcluded !== "boolean") {
    throw new Error("Cleaner show-excluded preference is invalid.");
  }
  return {
    defaultScanMode: input.defaultScanMode,
    showExcluded: input.showExcluded,
  };
}

function requirePlainObject(
  value: unknown,
  allowedKeys: string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cleaner payload must be an object.");
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Cleaner payload contains unsupported field ${unexpected[0]}.`,
    );
  }
  return input;
}
