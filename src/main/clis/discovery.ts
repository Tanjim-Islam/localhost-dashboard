import { findCliByPackage, getCliDefinitions } from "./catalogue";
import { stableCliId } from "./fingerprint";
import type { CliPackageSource, CliPlatform } from "./types";

export function validCliCommand(value: string): boolean {
  return /^[a-z0-9][a-z0-9._+-]{0,127}$/i.test(value);
}

export function discoveredCommandId(command: string): string {
  return `discovered-command:${command.toLowerCase()}`;
}

export function discoveredPackageId(
  source: CliPackageSource,
  packageId: string,
  platform: CliPlatform,
): string {
  const definition =
    findCliByPackage(source, packageId, platform) ??
    (source === "registry"
      ? getCliDefinitions(platform).find((item) =>
          [item.displayName, ...(item.aliases ?? [])].some(
            (name) => name.toLowerCase() === packageId.toLowerCase(),
          ),
        )
      : undefined);
  return (
    definition?.id ??
    stableCliId("discovered-package", {
      source,
      packageId: packageId.toLowerCase(),
    })
  );
}
