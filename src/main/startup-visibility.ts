// Pure startup visibility rules, kept separate so Windows and macOS behavior
// can be verified without changing OS login items or restarting a computer.
export const HIDDEN_LOGIN_ARGUMENT = "--hidden";

export type ElectronLoginItemSettings = {
  openAtLogin: boolean;
  openAsHidden?: boolean;
  name?: string;
  path?: string;
  args?: string[];
};

export type ElectronLoginItemSettingsInput = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  enabled: boolean;
  openInTrayAtLogin: boolean;
  executablePath: string;
};

export function shouldManageSystemLoginItem(isPackaged: boolean): boolean {
  return isPackaged;
}

export type SystemLoginItemLaunchSyncInput = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  settingsWereSeeded: boolean;
};

export function shouldSynchronizeSystemLoginItemAtLaunch({
  platform,
  isPackaged,
  settingsWereSeeded,
}: SystemLoginItemLaunchSyncInput): boolean {
  if (!isPackaged) return false;

  // Windows needs to repair stale development registrations on every launch.
  // Other platforms retain the existing first-run registration behavior.
  return platform === "win32" || settingsWereSeeded;
}

export function getElectronLoginItemSettings({
  platform,
  isPackaged,
  enabled,
  openInTrayAtLogin,
  executablePath,
}: ElectronLoginItemSettingsInput): ElectronLoginItemSettings | null {
  if (!isPackaged) return null;

  if (platform === "win32") {
    return {
      openAtLogin: enabled,
      name: "Localhost Dashboard",
      path: executablePath,
      args: enabled && openInTrayAtLogin ? [HIDDEN_LOGIN_ARGUMENT] : [],
    };
  }

  if (platform === "darwin") {
    return {
      openAtLogin: enabled,
      openAsHidden: openInTrayAtLogin,
    };
  }

  return null;
}

export type StartupVisibilityInput = {
  platform: NodeJS.Platform;
  argv: string[];
  startAtLogin: boolean;
  openInTrayAtLogin: boolean;
  wasOpenedAtLogin?: boolean;
};

export function shouldStartInTray({
  platform,
  argv,
  startAtLogin,
  openInTrayAtLogin,
  wasOpenedAtLogin = false,
}: StartupVisibilityInput): boolean {
  if (!startAtLogin || !openInTrayAtLogin) return false;

  if (platform === "win32") {
    return argv.includes(HIDDEN_LOGIN_ARGUMENT);
  }

  if (platform === "darwin") {
    return wasOpenedAtLogin || argv.includes(HIDDEN_LOGIN_ARGUMENT);
  }

  return false;
}
