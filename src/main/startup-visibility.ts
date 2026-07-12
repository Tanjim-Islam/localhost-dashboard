// Pure startup visibility rules, kept separate so Windows and macOS behavior
// can be verified without changing OS login items or restarting a computer.
export const HIDDEN_LOGIN_ARGUMENT = "--hidden";

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
