export type PlatformFeatures = {
  servers: true;
  ahkScripts: boolean;
  automatorScripts: boolean;
};

export function getPlatformFeatures(platform: NodeJS.Platform): PlatformFeatures {
  return {
    servers: true,
    ahkScripts: platform === "win32",
    automatorScripts: platform === "darwin",
  };
}

export function getDefaultGlobalHotkey(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Command+Shift+D";
  if (platform === "win32") return "Control+Alt+Shift+D";
  return "Ctrl+Shift+D";
}
