"use strict";

const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = async (context) => {
  const { Arch } = require("electron-builder");
  // Signing the thin apps before the universal merge changes CodeResources.
  if (
    context.electronPlatformName !== "darwin" ||
    context.arch !== Arch.universal
  )
    return;
  const { adHocSignAfterPack } =
    await import("electron-sparkle-updater/builder");
  await adHocSignAfterPack(context);
  const appName = readdirSync(context.appOutDir).find((entry) =>
    entry.endsWith(".app"),
  );
  if (!appName)
    throw new Error("Universal Mac app is missing after packaging.");
  execFileSync(
    "codesign",
    ["--verify", "--deep", "--strict", join(context.appOutDir, appName)],
    { stdio: "inherit" },
  );
};
