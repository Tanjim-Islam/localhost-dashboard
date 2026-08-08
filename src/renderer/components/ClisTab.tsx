import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleSlash2,
  Search,
  Terminal,
} from "lucide-react";
import type {
  CliHealthStatus,
  CliInstallation,
  CliInventorySnapshot,
  CliPackageSource,
  CliScanProgress,
  CliScanSession,
  CliUninstallPreview,
  CliUninstallProgress,
} from "../../main/clis/types";
import {
  CLI_CATEGORY_LABELS,
  CLI_SOURCE_LABELS,
  filterCliProducts,
  formatCliAge,
  summarizeCliInventory,
  type CliFilters,
} from "../cli-view-model";
import { CliProductRow } from "./clis/CliProductRow";
import { CliSelect } from "./clis/CliSelect";
import { CliUninstallDialog } from "./clis/CliUninstallDialog";

const DEFAULT_FILTERS: CliFilters = {
  query: "",
  category: "all",
  health: "all",
  source: "all",
  presence: "installed",
  duplicatesOnly: false,
};

type DialogState = {
  installation: CliInstallation;
  trigger: HTMLButtonElement;
};

export default function ClisTab({
  active,
  testMode,
  onCountChange,
}: {
  active: boolean;
  testMode: boolean;
  onCountChange(count: number): void;
}) {
  const [inventory, setInventory] = useState<CliInventorySnapshot | null>(null);
  const [scan, setScan] = useState<CliScanSession | null>(null);
  const [progress, setProgress] = useState<CliScanProgress | null>(null);
  const [filters, setFilters] = useState<CliFilters>(DEFAULT_FILTERS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [preview, setPreview] = useState<CliUninstallPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uninstallProgress, setUninstallProgress] =
    useState<CliUninstallProgress | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busyInstallationId, setBusyInstallationId] = useState<string>();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      window.api.getCliInventory(),
      window.api.getCliScanState(),
    ]).then(([saved, current]) => {
      if (!mounted.current) return;
      setInventory(saved);
      setScan(current.status === "idle" ? null : current);
    });
    const offProgress = window.api.onCliScanProgress((next) => {
      setProgress(next);
      setScan((current) =>
        current
          ? {
              ...current,
              status: "scanning",
              stage: next.stage,
              completedSources: next.completedSources,
              totalSources: next.totalSources,
              completedProbes: next.completedProbes,
              totalProbes: next.totalProbes,
            }
          : {
              id: next.scanSessionId,
              status: "scanning",
              stage: next.stage,
              startedAt: next.startedAt,
              completedSources: next.completedSources,
              totalSources: next.totalSources,
              completedProbes: next.completedProbes,
              totalProbes: next.totalProbes,
            },
      );
    });
    const offComplete = window.api.onCliScanComplete((next) => {
      setInventory(next);
      setScan(null);
      setProgress(null);
      setNotice(
        next.completeness === "partial"
          ? "Scan completed with isolated source failures."
          : "CLI inventory is up to date.",
      );
    });
    const offError = window.api.onCliScanError((error) => {
      setScan(null);
      setProgress(null);
      setNotice(error.message);
    });
    const offInventory = window.api.onCliInventoryChanged(setInventory);
    const offUninstallProgress =
      window.api.onCliUninstallProgress(setUninstallProgress);
    const offUninstallComplete = window.api.onCliUninstallComplete((result) => {
      setUninstallProgress(null);
      setNotice(result.message);
    });
    return () => {
      mounted.current = false;
      offProgress();
      offComplete();
      offError();
      offInventory();
      offUninstallProgress();
      offUninstallComplete();
    };
  }, []);

  const summary = useMemo(() => summarizeCliInventory(inventory), [inventory]);
  const products = useMemo(
    () => filterCliProducts(inventory, filters),
    [filters, inventory],
  );
  const sources = useMemo(() => {
    const visibleInstallationIds = new Set(
      (inventory?.products ?? []).flatMap((product) => [
        ...product.currentInstallationIds,
        ...product.embeddedInstallationIds,
      ]),
    );
    return [
      ...new Set(
        (inventory?.installations ?? [])
          .filter((installation) => visibleInstallationIds.has(installation.id))
          .map(
            (installation) =>
              installation.packageIdentity?.source ?? "standalone",
          ),
      ),
    ].sort();
  }, [inventory]);

  useEffect(
    () => onCountChange(summary.installed),
    [onCountChange, summary.installed],
  );

  const scanning =
    scan?.status === "scanning" ||
    scan?.status === "cancelling" ||
    Boolean(progress);

  const startScan = async (): Promise<void> => {
    setNotice(null);
    try {
      const next = await window.api.startCliScan();
      setScan(next);
    } catch (error) {
      setNotice(messageOf(error));
    }
  };

  const cancelScan = async (): Promise<void> => {
    if (!scan) return;
    try {
      const next = await window.api.cancelCliScan(scan.id);
      setScan(next);
    } catch (error) {
      setNotice(messageOf(error));
    }
  };

  const openUninstall = useCallback(
    async (installation: CliInstallation, trigger: HTMLButtonElement) => {
      if (!inventory) return;
      setDialog({ installation, trigger });
      setPreview(null);
      setDialogError(null);
      setPreviewLoading(true);
      try {
        const next = await window.api.getCliUninstallPreview({
          installationId: installation.id,
          inventoryRevision: inventory.revision,
        });
        setPreview(next);
      } catch (error) {
        setDialogError(messageOf(error));
      } finally {
        setPreviewLoading(false);
      }
    },
    [inventory],
  );

  const closeDialog = useCallback(() => {
    if (uninstallProgress) return;
    const trigger = dialog?.trigger;
    setDialog(null);
    setPreview(null);
    setDialogError(null);
    setTimeout(() => trigger?.focus(), 0);
  }, [dialog, uninstallProgress]);

  const confirmUninstall = async (): Promise<void> => {
    if (!dialog || !preview) return;
    setDialogError(null);
    try {
      const result = await window.api.uninstallCliInstallation({
        installationId: dialog.installation.id,
        inventoryRevision: preview.inventoryRevision,
        previewToken: preview.token,
        confirmation: "uninstall-exact-cli-installation",
      });
      setNotice(result.message);
      setUninstallProgress(null);
      const trigger = dialog.trigger;
      setDialog(null);
      setPreview(null);
      setTimeout(() => trigger.focus(), 0);
    } catch (error) {
      setUninstallProgress(null);
      setDialogError(messageOf(error));
    }
  };

  if (!active) return null;

  const sourceFailures =
    inventory?.sourceResults.filter((source) => source.status === "failed") ??
    [];

  return (
    <section
      aria-label="Developer CLIs"
      className="clis-motion-root space-y-4 pb-8"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-gray-900">
              CLIs
            </h1>
            <span className="rounded-full bg-night-700 px-2.5 py-1 text-xs font-semibold text-night-100">
              {summary.installed} installed
            </span>
            {inventory?.cached && (
              <span className="rounded-full border border-gray-300 bg-gray-200/65 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-700">
                Cached
              </span>
            )}
            {testMode && (
              <span className="rounded-full border border-cleaner-review-border bg-cleaner-review-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-cleaner-review-text">
                Fixture mode
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-600">
            Last successful scan:{" "}
            {inventory?.lastSuccessfulScanAt
              ? formatCliAge(inventory.lastSuccessfulScanAt)
              : "Never"}
            {inventory && ` · ${inventory.platform} ${inventory.architecture}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {scanning && (
            <div
              className="mr-1 min-w-[190px] text-right text-xs text-gray-600"
              aria-live="polite"
            >
              <p className="font-medium text-gray-800">
                {scan?.status === "cancelling"
                  ? "Cancelling"
                  : (progress?.label ?? "Starting scan")}
              </p>
              <p>
                Sources {progress?.completedSources ?? 0}/
                {progress?.totalSources ?? 0}
                {(progress?.totalProbes ?? 0) > 0 &&
                  ` · Probes ${progress?.completedProbes ?? 0}/${progress?.totalProbes ?? 0}`}
              </p>
            </div>
          )}
          {scanning ? (
            <button
              type="button"
              onClick={cancelScan}
              disabled={scan?.status === "cancelling"}
              className="h-9 rounded-xl border border-gray-300 bg-gray-200 px-3 text-sm font-medium outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-night-700/25 disabled:opacity-45"
            >
              {scan?.status === "cancelling" ? "Cancelling" : "Cancel"}
            </button>
          ) : (
            <button
              type="button"
              onClick={startScan}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-night-700 px-3.5 text-sm font-semibold text-night-100 outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-night-700/35"
            >
              <Terminal className="h-4 w-4" />
              Scan Now
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryButton
          label="Installed"
          count={summary.installed}
          active={filters.presence === "installed"}
          onClick={() =>
            setFilters((value) => ({
              ...value,
              presence: value.presence === "installed" ? "all" : "installed",
            }))
          }
        />
        <SummaryButton
          label="AI coding"
          count={summary.aiCoding}
          active={filters.category === "ai-coding"}
          onClick={() =>
            setFilters((value) => ({
              ...value,
              category: value.category === "ai-coding" ? "all" : "ai-coding",
            }))
          }
        />
        <SummaryButton
          label="Multiple installs"
          count={summary.duplicates}
          active={filters.duplicatesOnly}
          onClick={() =>
            setFilters((value) => ({
              ...value,
              duplicatesOnly: !value.duplicatesOnly,
            }))
          }
        />
        <SummaryButton
          label="Broken"
          count={summary.broken}
          active={filters.health === "broken"}
          onClick={() =>
            setFilters((value) => ({
              ...value,
              health: value.health === "broken" ? "all" : "broken",
            }))
          }
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="flex h-9 min-w-[220px] flex-[1.5] items-center gap-2 rounded-xl border border-gray-300 bg-gray-200/65 px-3 focus-within:border-night-700 focus-within:ring-2 focus-within:ring-night-700/15">
          <Search className="h-3.5 w-3.5 text-gray-600" />
          <input
            value={filters.query}
            onChange={(event) =>
              setFilters((value) => ({ ...value, query: event.target.value }))
            }
            placeholder="Search products, commands, packages, or paths"
            className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-600/70"
          />
        </label>
        <CliSelect
          label="Category"
          value={filters.category}
          onChange={(category) =>
            setFilters((value) => ({
              ...value,
              category: category as CliFilters["category"],
            }))
          }
          options={[
            { value: "all", label: "All" },
            ...Object.entries(CLI_CATEGORY_LABELS).map(([value, label]) => ({
              value,
              label,
            })),
          ]}
        />
        <CliSelect
          label="Status"
          value={filters.health}
          onChange={(health) =>
            setFilters((value) => ({
              ...value,
              health: health as CliHealthStatus | "all",
            }))
          }
          options={[
            "all",
            "healthy",
            "unverified",
            "warning",
            "broken",
            "unknown",
          ].map((value) => ({
            value,
            label: value === "all" ? "All" : capitalize(value),
          }))}
        />
        <CliSelect
          label="Source"
          value={filters.source}
          onChange={(source) =>
            setFilters((value) => ({
              ...value,
              source: source as CliPackageSource | "all",
            }))
          }
          options={[
            { value: "all", label: "All" },
            ...sources.map((source) => ({
              value: source,
              label: CLI_SOURCE_LABELS[source],
            })),
          ]}
        />
        <CliSelect
          label="State"
          value={filters.presence}
          onChange={(presence) =>
            setFilters((value) => ({
              ...value,
              presence: presence as CliFilters["presence"],
            }))
          }
          options={[
            { value: "all", label: "All" },
            { value: "installed", label: "Installed" },
            { value: "embedded", label: "Embedded tools" },
          ]}
        />
      </div>

      {notice && (
        <div
          className="flex items-center justify-between gap-3 rounded-xl border border-gray-300 bg-gray-200/55 px-3 py-2 text-xs text-gray-700"
          role="status"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded p-1 outline-none hover:bg-gray-300 focus-visible:ring-2 focus-visible:ring-night-700/25"
            aria-label="Dismiss status"
          >
            <CircleSlash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {sourceFailures.length > 0 && (
        <details className="rounded-xl border border-cleaner-blocked-border bg-cleaner-blocked-surface/70 px-3 py-2 text-xs text-cleaner-blocked-text">
          <summary className="cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-cleaner-blocked-border">
            {sourceFailures.length} package source
            {sourceFailures.length === 1 ? "" : "s"} could not be read
          </summary>
          <ul className="mt-2 space-y-1 pl-4">
            {sourceFailures.map((source) => (
              <li key={source.sourceId}>
                {source.label}: {source.message ?? "Unavailable"}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!inventory ? (
        <EmptyState
          icon={<Terminal className="h-5 w-5" />}
          title="No CLI inventory yet"
          detail="Press Scan Now to inspect PATH and supported package sources. Nothing is scanned automatically."
        />
      ) : products.length === 0 ? (
        <EmptyState
          icon={
            summary.installed === 0 ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <AlertCircle className="h-5 w-5" />
            )
          }
          title={
            summary.installed === 0
              ? "No developer CLIs found"
              : "No CLIs match these filters"
          }
          detail={
            summary.installed === 0
              ? "The completed scan found no catalogued or package-owned developer CLIs."
              : "Clear a filter or search to see the rest of the cached inventory."
          }
        />
      ) : (
        <div className="space-y-2.5">
          {products.map((product) => (
            <CliProductRow
              key={product.id}
              inventory={inventory}
              product={product}
              presence={filters.presence}
              expanded={expanded.has(product.id)}
              busyInstallationId={busyInstallationId}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(product.id)) next.delete(product.id);
                  else next.add(product.id);
                  return next;
                })
              }
              onVerify={async (installation) => {
                setBusyInstallationId(installation.id);
                setNotice(null);
                try {
                  const next = await window.api.verifyCliInstallation({
                    installationId: installation.id,
                    inventoryRevision: inventory.revision,
                  });
                  setInventory(next);
                  setNotice("Installation verification completed.");
                } catch (error) {
                  setNotice(messageOf(error));
                } finally {
                  setBusyInstallationId(undefined);
                }
              }}
              onReveal={async (installation) => {
                try {
                  await window.api.revealCliInstallation({
                    installationId: installation.id,
                    inventoryRevision: inventory.revision,
                  });
                } catch (error) {
                  setNotice(messageOf(error));
                }
              }}
              onUninstall={openUninstall}
            />
          ))}
        </div>
      )}

      {dialog && (
        <CliUninstallDialog
          installation={dialog.installation}
          preview={preview}
          loading={previewLoading}
          progress={uninstallProgress}
          error={dialogError}
          onConfirm={confirmUninstall}
          onClose={closeDialog}
        />
      )}
    </section>
  );
}

function SummaryButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-xl border px-3 py-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-night-700/25 ${
        active
          ? "border-night-700 bg-night-700 text-night-100"
          : "border-gray-300 bg-gray-100/85 text-gray-900 hover:bg-gray-200"
      }`}
    >
      <span className="block text-lg font-semibold leading-none">{count}</span>
      <span
        className={`mt-1 block text-[10px] font-semibold uppercase tracking-wider ${active ? "text-night-100/75" : "text-gray-600"}`}
      >
        {label}
      </span>
    </button>
  );
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="app-card flex min-h-[210px] flex-col items-center justify-center border border-gray-300 bg-gray-100/85 px-6 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-gray-200 text-gray-700">
        {icon}
      </span>
      <h2 className="mt-3 font-semibold text-gray-900">{title}</h2>
      <p className="mt-1 max-w-lg text-sm text-gray-600">{detail}</p>
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The CLI action failed.";
}
