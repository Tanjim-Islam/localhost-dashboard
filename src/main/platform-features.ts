export type PlatformFeatures = {
  servers: true;
  ahkScripts: boolean;
  automatorScripts: boolean;
  environmentKeys: boolean;
  cleaner: boolean;
  clis: boolean;
};

export function getPlatformFeatures(
  platform: NodeJS.Platform,
): PlatformFeatures {
  return {
    servers: true,
    ahkScripts: platform === "win32",
    automatorScripts: platform === "darwin",
    environmentKeys: platform === "win32",
    cleaner: platform === "win32",
    clis: platform === "win32" || platform === "darwin",
  };
}

export function getDefaultGlobalHotkey(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Command+Shift+D";
  if (platform === "win32") return "Control+Alt+Shift+D";
  return "Ctrl+Shift+D";
}
