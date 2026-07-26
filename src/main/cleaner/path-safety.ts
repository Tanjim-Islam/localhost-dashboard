import path from "node:path";
import type {
  CleanerEnvironment,
  CleanerFilesystem,
  CleanerPathFingerprint,
} from "./types";
import {
  isWindowsPathInside,
  normalizeWindowsPath,
  sameWindowsPath,
  windowsPathDepth,
} from "./path-normalization";
import { isCleanerProtectedParentBypassDefined } from "./applications/definitions";

export type CleanerPathSafetyResult =
  | { safe: true; normalizedPath: string; fingerprint: CleanerPathFingerprint }
  | { safe: false; reason: string };

export async function validateCleanerTargetPath(
  targetPath: string,
  environment: CleanerEnvironment,
  filesystem: CleanerFilesystem,
  options?: {
    protectedParentBypass?: {
      applicationId: string;
      protectedAncestor: string;
      exactTarget: string;
      rootId: string;
    };
  },
): Promise<CleanerPathSafetyResult> {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeWindowsPath(targetPath);
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error ? error.message : "The path is invalid.",
    };
  }

  const targetRoot = path.win32.parse(normalizedPath).root;
  const systemRoot = path.win32.parse(environment.systemDrive).root;
  if (!targetRoot || !sameRoot(targetRoot, systemRoot)) {
    return {
      safe: false,
      reason: "The target is outside the Windows system drive.",
    };
  }

  const broadTargets = [
    environment.systemDrive,
    environment.home,
    environment.localAppData,
    environment.roamingAppData,
    environment.programData,
    environment.windowsDir,
  ];
  if (broadTargets.some((broad) => sameWindowsPath(targetPath, broad))) {
    return { safe: false, reason: "The target is a protected broad parent." };
  }
  if (windowsPathDepth(targetPath) < 2) {
    return { safe: false, reason: "The target is suspiciously broad." };
  }

  const protectedSubtrees = getProtectedSubtrees(environment);
  const overlappingProtected = protectedSubtrees.find((protectedPath) => {
    const targetInsideProtected = isWindowsPathInside(
      normalizedPath,
      protectedPath,
    );
    const protectedInsideTarget = isWindowsPathInside(
      protectedPath,
      normalizedPath,
    );
    if (!targetInsideProtected && !protectedInsideTarget) return false;
    const bypass = options?.protectedParentBypass;
    if (
      targetInsideProtected &&
      bypass?.rootId &&
      sameWindowsPath(bypass.protectedAncestor, protectedPath) &&
      sameWindowsPath(bypass.exactTarget, normalizedPath) &&
      isCleanerProtectedParentBypassDefined(bypass, environment)
    ) {
      return false;
    }
    return true;
  });
  if (overlappingProtected) {
    return {
      safe: false,
      reason: `The target overlaps protected data at ${overlappingProtected}.`,
    };
  }

  if (normalizedPath.includes("\\onedrive\\")) {
    return { safe: false, reason: "OneDrive-managed paths are protected." };
  }
  if (normalizedPath.split("\\").includes(".git")) {
    return { safe: false, reason: "Git repository data is protected." };
  }

  if (!(await filesystem.exists(targetPath))) {
    return { safe: false, reason: "The scanned path no longer exists." };
  }
  try {
    const stat = await filesystem.lstat(targetPath);
    if (stat.isSymbolicLink || stat.isReparsePoint) {
      return {
        safe: false,
        reason:
          "The target became a symbolic link, junction, or reparse point.",
      };
    }
    if (!stat.isDirectory && !stat.isFile) {
      return { safe: false, reason: "The target type is not supported." };
    }
    return {
      safe: true,
      normalizedPath,
      fingerprint: {
        kind: stat.isDirectory ? "directory" : "file",
        device: stat.device,
        inode: stat.inode,
        modifiedMs: stat.modifiedMs,
        reparsePoint: false,
      },
    };
  } catch {
    return { safe: false, reason: "The target cannot be inspected safely." };
  }
}

export function fingerprintsMatch(
  scanned: CleanerPathFingerprint,
  current: CleanerPathFingerprint,
): boolean {
  if (scanned.kind !== current.kind || current.reparsePoint) return false;
  if (
    scanned.device !== undefined &&
    current.device !== undefined &&
    scanned.device !== current.device
  ) {
    return false;
  }
  if (
    scanned.inode !== undefined &&
    current.inode !== undefined &&
    scanned.inode !== current.inode
  ) {
    return false;
  }
  if (
    scanned.modifiedMs !== undefined &&
    current.modifiedMs !== undefined &&
    scanned.modifiedMs !== current.modifiedMs
  ) {
    return false;
  }
  return true;
}

export function getProtectedSubtrees(
  environment: CleanerEnvironment,
): string[] {
  return [
    path.join(environment.home, "OneDrive"),
    path.join(environment.home, ".codex"),
    path.join(environment.home, ".gemini"),
    path.join(environment.home, ".docker"),
    path.join(environment.home, ".ollama", "models"),
    path.join(environment.localAppData, "Google", "Chrome", "User Data"),
    path.join(
      environment.localAppData,
      "BraveSoftware",
      "Brave-Browser",
      "User Data",
    ),
    path.join(environment.localAppData, "Microsoft", "Edge", "User Data"),
    path.join(environment.roamingAppData, "Mozilla", "Firefox", "Profiles"),
    path.join(environment.localAppData, "Mozilla", "Firefox", "Profiles"),
    path.join(environment.roamingAppData, "Code"),
    path.join(environment.roamingAppData, "Code - Insiders"),
    path.join(environment.roamingAppData, "Cursor"),
    path.join(environment.roamingAppData, "Windsurf"),
    path.join(environment.roamingAppData, "Windsurf - Next"),
    path.join(environment.roamingAppData, "Trae"),
    path.join(environment.roamingAppData, "Qoder"),
    path.join(environment.roamingAppData, "Antigravity"),
    path.join(environment.localAppData, "Antigravity Tools"),
    path.join(environment.localAppData, "com.lbjlaq.antigravity-tools"),
    path.join(environment.roamingAppData, "com.lbjlaq.antigravity-tools"),
    path.join(environment.roamingAppData, "Slack"),
    path.join(environment.roamingAppData, "ChatGPT"),
    path.join(environment.localAppData, "Packages"),
    path.join(environment.programData, "DockerDesktop"),
    path.join(environment.programData, "PostgreSQL"),
    path.join(environment.programData, "MongoDB"),
    path.join(environment.windowsDir, "WinSxS"),
    path.join(environment.windowsDir, "Installer"),
    path.join(environment.windowsDir, "System32", "config"),
  ];
}

export function assertValidCleanerProtectedRoots(
  environment: CleanerEnvironment,
): void {
  for (const protectedRoot of getProtectedSubtrees(environment)) {
    try {
      normalizeWindowsPath(protectedRoot);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "The path is invalid.";
      throw new Error(
        `Cleaner protected-root configuration is invalid for ${JSON.stringify(protectedRoot)}. ${detail}`,
      );
    }
  }
}

function sameRoot(left: string, right: string): boolean {
  return (
    left.replace(/[\\/]+$/, "").toLowerCase() ===
    right.replace(/[\\/]+$/, "").toLowerCase()
  );
}
