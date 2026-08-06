import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CliInstallation,
  CliInventorySnapshot,
  CliIssueCode,
  CliProduct,
  CliProductStatus,
  CliRuntimeHealth,
  CliVerificationStatus,
} from "../../../main/clis/types";
import {
  CLI_CATEGORY_LABELS,
  CLI_SOURCE_LABELS,
  formatCliAge,
  getVisibleCliInstallations,
  type CliFilters,
} from "../../cli-view-model";

export function CliProductRow({
  inventory,
  product,
  presence,
  expanded,
  busyInstallationId,
  onToggle,
  onVerify,
  onReveal,
  onUninstall,
}: {
  inventory: CliInventorySnapshot;
  product: CliProduct;
  presence: CliFilters["presence"];
  expanded: boolean;
  busyInstallationId?: string;
  onToggle(): void;
  onVerify(installation: CliInstallation): void;
  onReveal(installation: CliInstallation): void;
  onUninstall(installation: CliInstallation, trigger: HTMLButtonElement): void;
}) {
  const installations = getVisibleCliInstallations(
    inventory,
    product,
    presence,
  );
  const primary =
    installations.find((installation) =>
      inventory.commands.some(
        (command) =>
          command.installationId === installation.id &&
          command.pathRole === "active",
      ),
    ) ??
    installations.find((installation) => installation.presence === "present") ??
    installations[0];
  const activeCommand = primary
    ? inventory.commands.find(
        (command) =>
          command.installationId === primary.id &&
          command.pathRole === "active",
      )
    : undefined;
  const activeEndpoint = primary
    ? (inventory.endpoints.find(
        (endpoint) =>
          primary.endpointIds.includes(endpoint.id) &&
          activeCommand?.activeEndpointId === endpoint.id,
      ) ??
      inventory.endpoints.find((endpoint) =>
        primary.endpointIds.includes(endpoint.id),
      ))
    : undefined;
  const source = primary?.packageIdentity?.source ?? "standalone";
  const currentCount = product.currentInstallationIds.length;
  const productHealthLabel =
    product.id === "dotnet" &&
    product.issueCodes.includes("incomplete-installation")
      ? "Runtime only, no SDK"
      : undefined;

  return (
    <article className="app-card overflow-hidden border border-gray-300 bg-gray-100/90 shadow-soft">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-gray-200/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-night-700/35"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-night-700 text-night-100">
          <TerminalSquare className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-gray-900">
              {product.displayName}
            </span>
            <StatusPill status={product.health} label={productHealthLabel} />
            {currentCount > 1 && (
              <span
                className="rounded-full border border-gray-300 bg-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-700"
                title="Multiple installations are available. PATH selects which one runs."
              >
                {currentCount} installations
              </span>
            )}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
            <span>{CLI_CATEGORY_LABELS[product.category]}</span>
            <span>{primary?.version ?? "Version unknown"}</span>
            <span>{CLI_SOURCE_LABELS[source]}</span>
            <span className="min-w-0 max-w-[48vw] truncate font-mono">
              {activeEndpoint?.path ?? "No active PATH endpoint"}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-xs text-gray-600">
          {formatCliAge(primary?.lastSuccessfulVerificationAt)}
        </span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-300 bg-gray-200/28 px-4 py-4">
          <div className="space-y-3">
            {installations.map((installation) => (
              <InstallationPanel
                key={installation.id}
                inventory={inventory}
                installation={installation}
                busy={busyInstallationId === installation.id}
                onVerify={() => onVerify(installation)}
                onReveal={() => onReveal(installation)}
                onUninstall={(trigger) => onUninstall(installation, trigger)}
              />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export function InstallationPanel({
  inventory,
  installation,
  busy,
  onVerify,
  onReveal,
  onUninstall,
}: {
  inventory: CliInventorySnapshot;
  installation: CliInstallation;
  busy: boolean;
  onVerify(): void;
  onReveal(): void;
  onUninstall(trigger: HTMLButtonElement): void;
}) {
  const endpoints = inventory.endpoints.filter((endpoint) =>
    installation.endpointIds.includes(endpoint.id),
  );
  const commands = inventory.commands.filter(
    (command) => command.installationId === installation.id,
  );
  const identity = installation.packageIdentity;
  const launcherPaths = [
    ...new Set(endpoints.map((endpoint) => endpoint.path)),
  ];
  const canonicalTargets = [
    ...new Set(
      endpoints
        .map(
          (endpoint) =>
            endpoint.shimTarget ??
            endpoint.symlinkTarget ??
            endpoint.canonicalPath,
        )
        .filter(
          (target): target is string =>
            typeof target === "string" &&
            !launcherPaths.some((launcher) => samePath(launcher, target)),
        ),
    ),
  ];
  const visibleIssues = installation.issueCodes.filter((issue) =>
    ACTIONABLE_ISSUES.has(issue),
  );
  const installationHealthLabel =
    installation.productId === "dotnet" &&
    installation.issueCodes.includes("incomplete-installation")
      ? "Runtime only, no SDK"
      : undefined;
  const commandText = commands.map((command) => command.name).join(", ");
  const primaryPath = endpoints[0]?.path;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  const canUninstall = ["supported", "requires-warning"].includes(
    installation.uninstallCapability.status,
  );

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) {
        window.clearTimeout(copyResetTimer.current);
      }
    },
    [],
  );

  const copyWithFeedback = (key: string, value: string): void => {
    window.api.copyText(value);
    setCopiedKey(key);
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
      copyResetTimer.current = null;
    }, 1_600);
  };

  return (
    <section
      className={`rounded-xl border border-gray-300 p-3 ${
        installation.presence === "missing"
          ? "bg-gray-200/45"
          : "bg-gray-100/75"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong>{installation.version ?? "Unknown version"}</strong>
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-700">
              {installation.versionSource.replaceAll("-", " ")}
            </span>
            <StatusPill
              status={installation.health}
              label={installationHealthLabel}
            />
            <VerificationPill status={installation.verificationStatus} />
          </div>
          <p className="mt-1 break-all text-xs text-gray-700">
            <strong>
              {CLI_SOURCE_LABELS[identity?.source ?? "standalone"]}
            </strong>
            {identity?.packageId
              ? ` · ${identity.packageId}`
              : " · Package owner not proven"}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-600">
            {installation.platform} · {installation.architecture} ·{" "}
            {installation.scope} scope · {formatOrigin(installation.origin)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <SmallButton
            label="Copy command"
            icon={<Clipboard className="h-3.5 w-3.5" />}
            onClick={() => copyWithFeedback("command", commandText)}
            disabled={!commandText}
            confirmable
            confirmed={copiedKey === "command"}
          />
          {primaryPath && (
            <SmallButton
              label="Copy path"
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              onClick={() => copyWithFeedback("primary-path", primaryPath)}
              confirmable
              confirmed={copiedKey === "primary-path"}
            />
          )}
          <SmallButton
            label="Open folder"
            icon={<FolderOpen className="h-3.5 w-3.5" />}
            onClick={onReveal}
            disabled={!endpoints[0]}
          />
          <SmallButton
            label={busy ? "Verifying" : "Verify"}
            icon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
              />
            }
            onClick={onVerify}
            disabled={busy}
          />
          <button
            type="button"
            onClick={(event) => onUninstall(event.currentTarget)}
            disabled={!canUninstall || busy}
            title={
              canUninstall
                ? "Preview exact uninstall"
                : installation.uninstallCapability.reason
            }
            className="h-8 rounded-lg border border-cleaner-danger-border bg-cleaner-danger-surface px-2.5 text-xs font-medium text-cleaner-danger-text outline-none transition hover:brightness-105 focus-visible:ring-2 focus-visible:ring-cleaner-danger-border disabled:cursor-not-allowed disabled:opacity-45"
          >
            Uninstall
          </button>
        </div>
      </div>

      <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
        <Detail
          label="Commands"
          value={
            commands
              .map((command) => `${command.name} (${command.pathRole})`)
              .join(", ") || "None"
          }
        />
        <Detail
          label="PATH position"
          value={pathPosition(commands, endpoints)}
        />
        <CopyablePathsDetail
          label={`Launchers (${launcherPaths.length})`}
          paths={launcherPaths}
          pathKind="launcher"
          copiedKey={copiedKey}
          onCopy={copyWithFeedback}
        />
        {canonicalTargets.length > 0 && (
          <CopyablePathsDetail
            label={canonicalTargets.length === 1 ? "Target" : "Targets"}
            paths={canonicalTargets}
            pathKind="target"
            copiedKey={copiedKey}
            onCopy={copyWithFeedback}
          />
        )}
        <Detail
          label="Last seen"
          value={formatCliAge(installation.lastSeenAt)}
        />
        <Detail
          label="Last verified"
          value={formatCliAge(installation.lastSuccessfulVerificationAt)}
        />
      </dl>

      {visibleIssues.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {visibleIssues.map((issue) => (
            <span
              key={issue}
              className="inline-flex items-center gap-1 rounded-full border border-cleaner-blocked-border bg-cleaner-blocked-surface px-2 py-1 text-[10px] font-medium text-cleaner-blocked-text"
            >
              <AlertTriangle className="h-3 w-3" />
              {issue.replaceAll("-", " ")}
            </span>
          ))}
        </div>
      )}
      {!canUninstall && (
        <p className="mt-3 flex items-start gap-2 text-xs text-gray-600">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong className="text-gray-800">
              {installation.uninstallCapability.status.replaceAll("-", " ")}:
            </strong>{" "}
            {installation.uninstallCapability.reason}
          </span>
        </p>
      )}
    </section>
  );
}

function StatusPill({
  status,
  label,
}: {
  status: CliProductStatus | CliRuntimeHealth;
  label?: string;
}) {
  const classes = {
    healthy:
      "bg-cleaner-safe-surface text-cleaner-safe-text border-cleaner-safe-border",
    warning:
      "bg-cleaner-conditional-surface text-cleaner-conditional-text border-cleaner-conditional-border",
    broken:
      "bg-cleaner-danger-surface text-cleaner-danger-text border-cleaner-danger-border",
    missing:
      "bg-cleaner-excluded-surface text-cleaner-excluded-text border-cleaner-excluded-border",
    inaccessible:
      "bg-cleaner-danger-surface text-cleaner-danger-text border-cleaner-danger-border",
    incomplete:
      "bg-cleaner-conditional-surface text-cleaner-conditional-text border-cleaner-conditional-border",
    unverified: "bg-gray-200 text-gray-700 border-gray-300",
    unknown:
      "bg-cleaner-review-surface text-cleaner-review-text border-cleaner-review-border",
  }[status];
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${classes}`}
    >
      {label ?? capitalizeStatus(status)}
    </span>
  );
}

function VerificationPill({ status }: { status: CliVerificationStatus }) {
  const label = {
    verified: "Verified",
    "partially-verified": "Partially verified",
    "ownership-unknown": "Ownership unverified",
    "version-unverified": "Version unverified",
    cached: "Cached",
  }[status];
  const classes =
    status === "verified"
      ? "border-cleaner-safe-border bg-cleaner-safe-surface text-cleaner-safe-text"
      : status === "cached"
        ? "border-gray-300 bg-gray-200 text-gray-700"
        : "border-cleaner-review-border bg-cleaner-review-surface text-cleaner-review-text";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${classes}`}
    >
      {label}
    </span>
  );
}

function Detail({
  label,
  value,
  mono = false,
  multiline = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-gray-900 ${mono ? "font-mono" : ""} ${
          multiline ? "whitespace-pre-wrap break-all" : "truncate"
        }`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function CopyablePathsDetail({
  label,
  paths,
  pathKind,
  copiedKey,
  onCopy,
}: {
  label: string;
  paths: string[];
  pathKind: "launcher" | "target";
  copiedKey: string | null;
  onCopy(key: string, value: string): void;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">
        {label}
      </dt>
      <dd className="mt-0.5 space-y-0.5">
        {paths.length === 0 ? (
          <span className="text-gray-900">Missing</span>
        ) : (
          paths.map((pathValue, index) => {
            const pathKey = `${pathKind}:${index}:${pathValue}`;
            const copied = copiedKey === pathKey;
            return (
              <button
                key={pathValue}
                type="button"
                onClick={() => onCopy(pathKey, pathValue)}
                className={`group -mx-1.5 grid w-[calc(100%+0.75rem)] cursor-copy grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg border px-1.5 py-1 text-left outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-night-700/25 motion-reduce:transition-none ${
                  copied
                    ? "border-cleaner-safe-border bg-cleaner-safe-surface text-cleaner-safe-text"
                    : "border-transparent text-gray-900 hover:border-gray-300 hover:bg-gray-200/70"
                }`}
                title={copied ? "Copied" : "Click to copy this path"}
                aria-label={`${copied ? "Copied" : "Copy"} ${pathKind} path ${pathValue}`}
              >
                <span className="min-w-0 break-all font-mono">{pathValue}</span>
                <AnimatePresence initial={false} mode="wait">
                  <motion.span
                    key={copied ? "copied" : "copy"}
                    initial={
                      reduceMotion ? false : { opacity: 0, scale: 0.88, y: 2 }
                    }
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={
                      reduceMotion
                        ? { opacity: 0 }
                        : { opacity: 0, scale: 0.88, y: -2 }
                    }
                    transition={{ duration: reduceMotion ? 0 : 0.16 }}
                    className={`mt-0.5 inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold ${
                      copied
                        ? "text-cleaner-safe-text"
                        : "text-gray-600 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    }`}
                    aria-live="polite"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Copied
                      </>
                    ) : (
                      <Clipboard className="h-3 w-3" aria-hidden="true" />
                    )}
                  </motion.span>
                </AnimatePresence>
              </button>
            );
          })
        )}
      </dd>
    </div>
  );
}

function SmallButton({
  label,
  icon,
  onClick,
  disabled,
  confirmable = false,
  confirmed = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick(): void;
  disabled?: boolean;
  confirmable?: boolean;
  confirmed?: boolean;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center justify-center rounded-lg border px-2.5 text-xs font-medium outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-night-700/25 disabled:opacity-45 motion-reduce:transition-none ${
        confirmable ? "min-w-[7.25rem]" : ""
      } ${
        confirmed
          ? "border-cleaner-safe-border bg-cleaner-safe-surface text-cleaner-safe-text"
          : "border-gray-300 bg-gray-200/65 hover:bg-gray-300"
      }`}
    >
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={confirmed ? "confirmed" : "idle"}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.9, y: 2 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={
            reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -2 }
          }
          transition={{ duration: reduceMotion ? 0 : 0.16 }}
          className="inline-flex items-center gap-1.5"
          aria-live="polite"
        >
          {confirmed ? (
            <>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Copied
            </>
          ) : (
            <>
              {icon}
              {label}
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

function pathPosition(
  commands: CliCommand[],
  endpoints: CliExecutableEndpoint[],
): string {
  const active = commands.find((command) => command.pathRole === "active");
  const endpoint = endpoints.find((candidate) =>
    active?.endpointIds.includes(candidate.id),
  );
  if (endpoint?.pathIndex !== undefined)
    return `Active, PATH ${endpoint.pathIndex + 1}`;
  if (commands.some((command) => command.pathRole === "shadowed")) {
    return "Shadowed by an earlier PATH entry";
  }
  return "Not on the current app PATH";
}

type CliCommand = import("../../../main/clis/types").CliCommand;
type CliExecutableEndpoint =
  import("../../../main/clis/types").CliExecutableEndpoint;

const ACTIONABLE_ISSUES = new Set<CliIssueCode>([
  "broken-shim",
  "missing-target",
  "inaccessible",
]);

function capitalizeStatus(status: string): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function samePath(left: string, right: string): boolean {
  return (
    left.replaceAll("/", "\\").toLowerCase() ===
    right.replaceAll("/", "\\").toLowerCase()
  );
}

function formatOrigin(origin: CliInstallation["origin"]): string {
  return {
    user: "User installation",
    system: "System installation",
    "package-manager": "Package-managed",
    "application-embedded": "Application embedded",
    "sdk-bundled": "SDK bundled",
    unknown: "Origin unknown",
  }[origin];
}
