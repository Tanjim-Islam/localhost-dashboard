import { Clock3, Info } from "lucide-react";
import type { CleanerFinding } from "./types";

export function CleanerProcessWarning({
  processes,
}: {
  processes: CleanerFinding["relatedProcesses"];
}) {
  if (processes.length === 0) return null;
  const blocking = processes.filter((processInfo) => processInfo.blocking);
  const advisory = processes.filter((processInfo) => !processInfo.blocking);
  if (blocking.length === 0) {
    return (
      <div className="mt-3 rounded-xl border border-gray-300 bg-gray-200/55 px-3 py-2.5 text-gray-800">
        <div className="flex items-start gap-2.5">
          <Info
            className="mt-0.5 h-4 w-4 shrink-0 text-gray-700"
            aria-hidden="true"
          />
          <div className="min-w-0 text-xs leading-5">
            <strong>Non-blocking process note.</strong>{" "}
            {advisory.map((processInfo) => processInfo.name).join(", ")} was
            observed by name only. Cleaner found no evidence that it is using
            this exact cache.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-xl border border-cleaner-blocked-border bg-cleaner-blocked-surface/78 px-3 py-3 text-cleaner-blocked-text">
      <div className="flex items-start gap-2.5">
        <Clock3
          className="mt-0.5 h-4 w-4 shrink-0 text-cleaner-blocked-icon"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="text-xs font-semibold">
            Close related applications first
          </div>
          <p className="mt-1 text-xs leading-5">
            {blocking.map((processInfo) => processInfo.name).join(", ")} has
            strong evidence of using this exact cache. Cleaner will never stop
            it automatically. Close it manually, then rescan.
          </p>
          {advisory.length > 0 && (
            <p className="mt-1 text-[11px] leading-4 opacity-85">
              Non-blocking name-only observations:{" "}
              {advisory.map((processInfo) => processInfo.name).join(", ")}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
