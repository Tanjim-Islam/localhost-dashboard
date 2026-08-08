import path from "node:path";
import type {
  CleanerProcessMatchRule,
  CleanerProcessReference,
  CleanerProcessSnapshot,
} from "./types";
import {
  isWindowsPathInside,
  normalizeWindowsPath,
} from "./path-normalization";

export function findRelatedCleanerProcesses(
  rules: CleanerProcessMatchRule[],
  processes: CleanerProcessSnapshot[],
  targetPath: string,
): CleanerProcessReference[] {
  const normalizedTarget = normalizeWindowsPath(targetPath);
  const seen = new Set<string>();
  const results: CleanerProcessReference[] = [];
  for (const processInfo of processes) {
    const match = strongestMatch(rules, processInfo, normalizedTarget);
    if (match.strength === "none") continue;
    const key = `${normalizeProcessName(processInfo.name)}:${processInfo.pid ?? ""}:${processInfo.createdAt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name: processInfo.name,
      pid: processInfo.pid,
      createdAt: processInfo.createdAt,
      evidenceStrength: match.strength,
      blocking:
        match.strength === "confirmed-consumer" ||
        match.strength === "likely-related",
      reason: match.reason,
    });
  }
  return results;
}

export function hasBlockingCleanerProcess(
  processes: CleanerProcessReference[],
): boolean {
  return processes.some((processInfo) => processInfo.blocking);
}

export function normalizeProcessName(input: string): string {
  const base = path.win32.basename(input.trim()).toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

function strongestMatch(
  rules: CleanerProcessMatchRule[],
  processInfo: CleanerProcessSnapshot,
  normalizedTarget: string,
): {
  strength: "confirmed-consumer" | "likely-related" | "weak-name-only" | "none";
  reason: string;
} {
  for (const rule of rules) {
    if (
      rule.applicationIds?.length &&
      processInfo.applicationId &&
      rule.applicationIds.includes(processInfo.applicationId)
    ) {
      return {
        strength: "confirmed-consumer",
        reason: "Verified process identity matches the owning application.",
      };
    }
    if (
      rule.allowExecutableInsideTarget &&
      processInfo.executablePath &&
      safePathInside(processInfo.executablePath, normalizedTarget)
    ) {
      return {
        strength: "confirmed-consumer",
        reason: "The executable is physically running from this data root.",
      };
    }
    if (
      rule.allowReferencedTarget &&
      processInfo.referencedPaths.some((reference) =>
        safePathInside(reference, normalizedTarget),
      )
    ) {
      return {
        strength: "confirmed-consumer",
        reason:
          "The current process invocation references this exact data root.",
      };
    }
  }
  for (const rule of rules) {
    const basename = path.win32
      .basename(processInfo.executablePath || processInfo.name)
      .toLowerCase();
    const basenameMatches =
      !rule.executableBasenames?.length ||
      rule.executableBasenames.some(
        (expected) => expected.toLowerCase() === basename,
      );
    if (
      basenameMatches &&
      rule.commandCategories?.includes(processInfo.commandCategory)
    ) {
      return {
        strength: "likely-related",
        reason: `Sanitized process category ${processInfo.commandCategory} is an active consumer.`,
      };
    }
  }
  for (const rule of rules) {
    const normalizedName = normalizeProcessName(processInfo.name);
    if (
      rule.weakNameWarnings?.some(
        (expected) => normalizeProcessName(expected) === normalizedName,
      )
    ) {
      return {
        strength: "weak-name-only",
        reason:
          "The process name is similar, but no cache use was proven. It does not block cleanup.",
      };
    }
  }
  return { strength: "none", reason: "No relationship was found." };
}

function safePathInside(candidate: string, target: string): boolean {
  try {
    return isWindowsPathInside(candidate, target);
  } catch {
    return false;
  }
}
