export const APP_DISPLAY_NAME = "Localhost Dashboard";

export function shouldShowDockForWindowState(
  platform: NodeJS.Platform,
  windowVisible: boolean,
): boolean {
  return platform === "darwin" && windowVisible;
}

export function shouldCreateTrayIcon(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

export function shouldEnableAutoUpdater(
  appIsPackaged: boolean,
  rendererUrl?: string,
): boolean {
  return appIsPackaged && !rendererUrl;
}

export function getRendererLoadMode(
  appIsPackaged: boolean,
  rendererUrl?: string,
): "dev-url" | "file" {
  return rendererUrl || !appIsPackaged ? "dev-url" : "file";
}

export function getDockIconInsetScale(): number {
  return 0.82;
}
