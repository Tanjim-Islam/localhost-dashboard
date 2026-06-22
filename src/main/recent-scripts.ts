import Store from "electron-store";
import path from "node:path";

export type RecentScriptType = "ahk" | "automator";

export type RecentScriptInfo = {
  id: string;
  type: RecentScriptType;
  scriptPath: string;
  scriptName: string;
  firstSeen: number;
  lastUsed: number;
  useCount: number;
};

type StoredRecentScript = Omit<RecentScriptInfo, "id">;

type RecentScriptsStore = {
  scripts: StoredRecentScript[];
};

const MAX_RECENT_SCRIPTS = 40;

const recentScriptsStore = new Store<RecentScriptsStore>({
  name: "recent-scripts",
  fileExtension: "json",
  defaults: {
    scripts: [],
  },
});

export function getRecentScripts(
  type?: RecentScriptType,
): RecentScriptInfo[] {
  return recentScriptsStore
    .get("scripts")
    .filter((script) => !type || script.type === type)
    .map(withId)
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

export function getRecentScriptById(id: string): RecentScriptInfo | undefined {
  return recentScriptsStore.get("scripts").map(withId).find((script) => {
    return script.id === id;
  });
}

export function rememberRecentScript(
  type: RecentScriptType,
  scriptPath: string,
  scriptName?: string,
): RecentScriptInfo[] {
  const normalizedPath = normalizeScriptPath(scriptPath);
  const now = Date.now();
  const scripts = recentScriptsStore.get("scripts");
  const existing = scripts.find((script) => {
    return (
      script.type === type && sameScriptPath(script.scriptPath, normalizedPath)
    );
  });

  const nextScript: StoredRecentScript = existing
    ? {
        ...existing,
        scriptPath: normalizedPath,
        scriptName:
          scriptName || existing.scriptName || path.basename(normalizedPath),
        lastUsed: now,
        useCount: existing.useCount + 1,
      }
    : {
        type,
        scriptPath: normalizedPath,
        scriptName: scriptName || path.basename(normalizedPath),
        firstSeen: now,
        lastUsed: now,
        useCount: 1,
      };

  const next = [
    nextScript,
    ...scripts.filter((script) => {
      return !(
        script.type === type && sameScriptPath(script.scriptPath, normalizedPath)
      );
    }),
  ]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_RECENT_SCRIPTS);

  recentScriptsStore.set("scripts", next);
  return getRecentScripts(type);
}

export function deleteRecentScript(id: string): RecentScriptInfo[] {
  const scripts = recentScriptsStore.get("scripts");
  const target = scripts.map(withId).find((script) => script.id === id);
  if (!target) return getRecentScripts();

  recentScriptsStore.set(
    "scripts",
    scripts.filter((script) => {
      return !(
        script.type === target.type &&
        sameScriptPath(script.scriptPath, target.scriptPath)
      );
    }),
  );

  return getRecentScripts(target.type);
}

export function getPlatformRecentScriptType(): RecentScriptType | undefined {
  if (process.platform === "win32") return "ahk";
  if (process.platform === "darwin") return "automator";
  return undefined;
}

function withId(script: StoredRecentScript): RecentScriptInfo {
  return {
    ...script,
    id: getRecentScriptId(script.type, script.scriptPath),
  };
}

function getRecentScriptId(type: RecentScriptType, scriptPath: string): string {
  return `${type}:${normalizeScriptPath(scriptPath).toLowerCase()}`;
}

function normalizeScriptPath(scriptPath: string): string {
  return path.normalize(scriptPath.trim());
}

function sameScriptPath(left: string, right: string): boolean {
  return (
    normalizeScriptPath(left).toLowerCase() ===
    normalizeScriptPath(right).toLowerCase()
  );
}
