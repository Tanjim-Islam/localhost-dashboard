import { useEffect, useRef } from "react";
import { AlertTriangle, LoaderCircle, PackageX, X } from "lucide-react";
import type {
  CliInstallation,
  CliUninstallPreview,
  CliUninstallProgress,
} from "../../../main/clis/types";
import { CLI_SOURCE_LABELS } from "../../cli-view-model";

export function CliUninstallDialog({
  installation,
  preview,
  loading,
  progress,
  error,
  onConfirm,
  onClose,
}: {
  installation: CliInstallation;
  preview: CliUninstallPreview | null;
  loading: boolean;
  progress: CliUninstallProgress | null;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const locked = Boolean(progress);

  useEffect(() => {
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [locked, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-night/72 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cli-uninstall-title"
        className="env-modal-panel app-card w-full max-w-lg border border-gray-300 bg-gray-100 p-5 shadow-soft"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cleaner-danger-surface text-cleaner-danger-text">
            <PackageX className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="cli-uninstall-title" className="font-semibold text-gray-900">
              Uninstall exact CLI installation
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Only the package shown here will be requested from its manager.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close uninstall dialog"
            onClick={onClose}
            disabled={locked}
            className="rounded-lg p-1.5 text-gray-600 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-night-700/25 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && !preview ? (
          <div className="my-8 flex items-center justify-center gap-2 text-sm text-gray-600">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Revalidating package ownership
          </div>
        ) : preview ? (
          <>
            <dl className="mt-5 grid gap-3 rounded-2xl border border-gray-300 bg-gray-200/45 p-4 text-sm sm:grid-cols-2">
              <Item label="Product" value={preview.productName} />
              <Item label="Version" value={preview.version ?? "Unknown"} />
              <Item label="Package manager" value={CLI_SOURCE_LABELS[preview.source]} />
              <Item label="Package ID" value={preview.packageId} mono />
              <Item label="Installation ID" value={installation.id} mono />
              <Item label="Scope" value={preview.scope} />
              <Item
                label="Commands removed"
                value={preview.providedCommands.join(", ") || "Unknown"}
              />
              <Item
                label="Other installation remains"
                value={preview.remainingInstallationCount > 0 ? "Yes" : "No"}
              />
              <Item
                label="Elevation"
                value={preview.requiresElevation ? "Expected" : "Not expected"}
              />
            </dl>
            {preview.warnings.length > 0 && (
              <div className="mt-3 rounded-xl border border-cleaner-conditional-border bg-cleaner-conditional-surface p-3 text-xs text-cleaner-conditional-text">
                {preview.warnings.map((warning) => (
                  <p key={warning} className="flex gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </>
        ) : null}

        {progress && (
          <p className="mt-4 flex items-center gap-2 text-sm text-gray-700" aria-live="polite">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {progress.label}
          </p>
        )}
        {error && (
          <p className="mt-4 rounded-xl border border-cleaner-danger-border bg-cleaner-danger-surface p-3 text-xs text-cleaner-danger-text">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={locked}
            className="h-9 rounded-xl border border-gray-300 bg-gray-200 px-3 text-sm font-medium outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-night-700/25 disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!preview || locked}
            className="h-9 rounded-xl border border-cleaner-danger-border bg-cleaner-danger-surface px-3 text-sm font-semibold text-cleaner-danger-text outline-none hover:brightness-105 focus-visible:ring-2 focus-visible:ring-cleaner-danger-border disabled:opacity-45"
          >
            {progress ? "Uninstalling" : "Uninstall exact package"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Item({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">
        {label}
      </dt>
      <dd className={`mt-0.5 break-words text-gray-900 ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
