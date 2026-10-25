export const APP_DISPLAY_NAME = "Localhost Dashboard";

// Renaming the development Electron bundle can make Electron report isPackaged
// even when its default app is loading a repository. Native resources still live
// in that repository, and automatic updates must remain disabled there.
export function isPackagedApplication(
  isPackaged: boolean,
  defaultApp?: boolean,
): boolean {
  return isPackaged && !defaultApp;
}

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
  _appIsPackaged: boolean,
  rendererUrl?: string,
): "dev-url" | "file" {
  return rendererUrl ? "dev-url" : "file";
}

export function getDockIconInsetScale(): number {
  return 0.82;
}
