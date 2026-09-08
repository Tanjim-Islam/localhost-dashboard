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
} from "../../../main/clis/types";
import {
  CLI_CATEGORY_LABELS,
  formatCliAge,
  formatCliInstallationDetails,
  formatCliInstallationSource,
  formatCliVersionDescription,
  getVisibleCliInstallations,
  getPrimaryCliCommand,
  isNewCliProduct,
  formatCliHealth,
  isCliCommandVerified,
  type CliFilters,
} from "../../cli-view-model";
import { getCliInvocation, type CliShell } from "../../cli-invocation";

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
  now = Date.now(),
  onSetIncluded,
  shell,
}: {
  inventory: CliInventorySnapshot;
  product: CliProduct;
  presence: CliFilters["presence"];
  expanded: boolean;
  busyInstallationId?: string;
  now?: number;
  onToggle(): void;
  onVerify(installation: CliInstallation): void;
  onReveal(installation: CliInstallation): void;
  onUninstall(installation: CliInstallation, trigger: HTMLButtonElement): void;
  onSetIncluded?(installation: CliInstallation, included: boolean): void;
  shell?: CliShell;
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
    ? getPrimaryCliCommand(
        product,
        inventory.commands.filter(
          (command) => command.installationId === primary.id,
        ),
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
  const sourceLabel = primary
    ? formatCliInstallationSource(
        primary,
        inventory.endpoints.filter((endpoint) =>
          primary.endpointIds.includes(endpoint.id),
        ),
      )
    : "Source not identified";
  const currentCount = product.currentInstallationIds.length;
  const displayedHealth =
    currentCount === 0 && primary ? primary.health : product.health;
  const productHealthLabel =
    product.id === "dotnet" &&
    product.issueCodes.includes("incomplete-installation")
      ? "Runtime only, no SDK"
      : presence === "candidates"
        ? "Discovered"
        : displayedHealth === "healthy"
          ? installations.every((item) => isCliCommandVerified(item, inventory))
            ? "Verified"
            : "Installed"
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
            {presence !== "candidates" &&
              isNewCliProduct(inventory, product, now) && (
                <span
                  className="rounded-full border border-cleaner-review-border bg-cleaner-review-surface px-2 py-0.5 text-[10px] font-semibold text-cleaner-review-text"
                  title="First discovered in the last 24 hours"
                >
                  New
                </span>
              )}
            <StatusPill status={displayedHealth} label={productHealthLabel} />
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
            {primary?.version && <span>{primary.version}</span>}
            <span>{sourceLabel}</span>
            <span className="min-w-0 max-w-[48vw] truncate font-mono">
              {activeEndpoint?.path ?? "No active PATH endpoint"}
            </span>
          </span>
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
                onSetIncluded={
                  onSetIncluded
                    ? (included) => onSetIncluded(installation, included)
                    : undefined
                }
                shell={shell}
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
  onSetIncluded,
  shell = inventory.platform === "win32" ? "powershell" : "posix",
}: {
  inventory: CliInventorySnapshot;
  installation: CliInstallation;
  busy: boolean;
  onVerify(): void;
  onReveal(): void;
  onUninstall(trigger: HTMLButtonElement): void;
  onSetIncluded?(included: boolean): void;
  shell?: CliShell;
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
      : formatCliHealth(installation, inventory);
  const commandText = getCliInvocation(inventory, installation, shell);
  const primaryPath = endpoints[0]?.path;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  const canUninstall = ["supported", "requires-warning"].includes(
    installation.uninstallCapability.status,
  );
  const [showAllCommands, setShowAllCommands] = useState(false);

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
            <strong title={formatCliVersionDescription(installation)}>
              {installation.version ?? commands[0]?.name ?? "Installed tool"}
            </strong>
            <StatusPill
              status={installation.health}
              label={
                installationHealthLabel ??
                (installation.health === "unknown" && endpoints.length === 0
                  ? "No launcher found"
                  : undefined)
              }
            />
          </div>
          <p className="mt-1 break-all text-xs text-gray-700">
            <strong>
              {formatCliInstallationSource(installation, endpoints)}
            </strong>
            {identity?.packageId ? ` · ${identity.packageId}` : null}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-600">
            {formatCliInstallationDetails(installation)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <SmallButton
            label="Copy command"
            title={commandText ?? "No launcher is available for this terminal."}
            icon={<Clipboard className="h-3.5 w-3.5" />}
            onClick={() =>
              commandText && copyWithFeedback("command", commandText)
            }
            disabled={!commandText}
            confirmable
            confirmed={copiedKey === "command"}
          />
          {onSetIncluded &&
            ["candidate", "user"].includes(
              installation.discoveryKind ?? "",
            ) && (
              <SmallButton
                label={
                  installation.includedByUser
                    ? "Remove from CLI list"
                    : "Add to CLI list"
                }
                icon={<Check className="h-3.5 w-3.5" />}
                onClick={() => onSetIncluded(!installation.includedByUser)}
                disabled={
                  busy || (!installation.includedByUser && !commandText)
                }
              />
            )}
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
            label={busy ? "Checking" : "Check again"}
            icon={
              <RefreshCw
                className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
              />
            }
            onClick={onVerify}
            disabled={busy}
          />
          {canUninstall && (
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
          )}
        </div>
      </div>

      <dl className="mt-3 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <Detail
            label="Commands"
            value={
              (showAllCommands ? commands : commands.slice(0, 8))
                .map((command) => command.name)
                .join(", ") || "None"
            }
          />
          {commands.length > 8 && (
            <button
              type="button"
              className="mt-1 font-medium text-gray-800 underline"
              onClick={() => setShowAllCommands((value) => !value)}
            >
              {showAllCommands
                ? "Show fewer commands"
                : `Show all ${commands.length} commands`}
            </button>
          )}
        </div>
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
          label="Checked"
          value={formatCliAge(
            installation.lastVerifiedAt ?? installation.lastSeenAt,
          )}
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
  const [showAll, setShowAll] = useState(false);

  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-600">
        {label}
      </dt>
      <dd className="mt-0.5 space-y-0.5">
        {paths.length === 0 ? (
          <span className="text-gray-900">Missing</span>
        ) : (
          (showAll ? paths : paths.slice(0, 3)).map((pathValue, index) => {
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
        {paths.length > 3 && (
          <button
            type="button"
            className="pt-1 font-medium text-gray-800 underline"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer paths" : `Show all ${paths.length} paths`}
          </button>
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
  title,
}: {
  label: string;
  icon: React.ReactNode;
  onClick(): void;
  disabled?: boolean;
  confirmable?: boolean;
  confirmed?: boolean;
  title?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
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
  if (status === "unknown" || status === "unverified") return "Not checked";
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function samePath(left: string, right: string): boolean {
  return (
    left.replaceAll("/", "\\").toLowerCase() ===
    right.replaceAll("/", "\\").toLowerCase()
  );
}
