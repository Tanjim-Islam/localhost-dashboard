export function formatCleanerBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(2)} ${units[index]}`;
}

export function formatCleanerSignedBytes(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0 B";
  return `${value > 0 ? "+" : "-"}${formatCleanerBytes(Math.abs(value))}`;
}

export function formatCleanerDuration(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function formatCleanerDate(value: number): string {
  return new Date(value).toLocaleString();
}

export function humanizeCleanerValue(value: string): string {
  return value
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatCleanerInstallState(value: string): string {
  return (
    {
      "confirmed-installed": "Application installed",
      "probably-installed": "Application probably installed",
      "portable-detected": "Portable application detected",
      ambiguous: "Installation status uncertain",
      "probably-uninstalled": "Application not found",
      "confirmed-uninstalled": "Application confirmed uninstalled",
      "shared-component": "Shared component",
      unknown: "Installation status unknown",
    }[value] ?? humanizeCleanerValue(value)
  );
}

export function formatCleanerRunningState(value: string): string {
  return (
    {
      "confirmed-running": "Application currently running",
      "likely-running": "Application likely running",
      "not-running-observed": "No related process observed",
      unknown: "Running status unknown",
    }[value] ?? humanizeCleanerValue(value)
  );
}
