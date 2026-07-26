import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  Ban,
  Check,
  Clock3,
  LockKeyhole,
  MoreHorizontal,
  Search,
} from "lucide-react";
import {
  canSelectCleanerFinding,
  getCleanerCompactReason,
  getCleanerCompactSize,
} from "../../cleaner-view-model";
import {
  CLEANER_STATUS_META,
  CLEANER_TONE_STYLES,
  getCleanerVisualStatus,
} from "../../cleaner-semantics";
import {
  formatCleanerBytes,
  formatCleanerDate,
  formatCleanerInstallState,
  formatCleanerRunningState,
  humanizeCleanerValue,
} from "../../cleaner-format";
import { CleanerDetailsAccordion } from "./CleanerDetailsAccordion";
import { CleanerStatusBadge } from "./CleanerStatus";
import type { CleanerFinding } from "./types";

type ExclusionScope =
  "finding" | "detector" | "category" | "application" | "root" | "path";

export function CleanerFindingCard({
  finding,
  selected,
  onSelect,
  onExclude,
  onManageExclusions,
}: {
  finding: CleanerFinding;
  selected: boolean;
  onSelect(selected: boolean): void;
  onExclude(scope: ExclusionScope): void;
  onManageExclusions(): void;
}) {
  const reduceMotion = useReducedMotion();
  const selectable = canSelectCleanerFinding(finding);
  const visualStatus = getCleanerVisualStatus(finding.safety, finding.excluded);
  const meta = CLEANER_STATUS_META[visualStatus];
  const styles = CLEANER_TONE_STYLES[meta.tone];
  const size = getCleanerCompactSize(finding);
  const compactReason = getCleanerCompactReason(finding);

  return (
    <motion.article
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: finding.excluded ? 0.78 : 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0 : 0.16,
        ease: [0.22, 1, 0.36, 1],
      }}
      aria-label={`${finding.displayName}, ${meta.label}`}
      className={`relative min-w-0 rounded-2xl border bg-gray-100/88 p-4 outline-none transition-colors focus-within:z-20 focus-within:ring-2 focus-within:ring-cleaner-review-border ${styles.border} ${selected ? `ring-2 ${styles.selectedRing}` : "hover:border-gray-400"}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <SelectionControl
          finding={finding}
          selected={selected}
          selectable={selectable}
          onSelect={onSelect}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="cleaner-line-clamp-2 break-words text-[15px] font-semibold leading-5 text-gray-900">
                {finding.displayName}
              </h3>
              <p className="mt-0.5 truncate text-xs text-gray-700">
                {finding.applicationName
                  ? `${finding.applicationName} · ${finding.category}`
                  : finding.category}
              </p>
            </div>
            <div className="max-w-[46%] shrink-0 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-700">
                Estimated recovery
              </div>
              <div className="mt-0.5 truncate text-lg font-semibold leading-5 text-gray-900">
                {size.estimatedRecoveryBytes === null
                  ? "Unknown"
                  : formatCleanerBytes(size.estimatedRecoveryBytes)}
              </div>
              {size.showLogicalSize && (
                <div className="mt-1 truncate text-[11px] text-gray-700">
                  Logical {formatCleanerBytes(size.logicalBytes)}
                </div>
              )}
            </div>
          </div>

          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-2">
            <CleanerStatusBadge
              safety={finding.safety}
              excluded={finding.excluded}
            />
            {size.accountingIndicator && (
              <span className="truncate text-[11px] font-medium text-gray-700">
                {size.accountingIndicator}
              </span>
            )}
          </div>

          <p className="cleaner-line-clamp-2 mt-2.5 text-sm leading-5 text-gray-800">
            {compactReason}
          </p>

          <CleanerDetailsAccordion
            path={finding.path}
            actions={
              <CleanerFindingMenu
                findingName={finding.displayName}
                excluded={finding.excluded}
                onExclude={onExclude}
                onManageExclusions={onManageExclusions}
              />
            }
          >
            <DetailGroup label="Storage">
              <DetailRows
                rows={[
                  [
                    "Estimated recovery",
                    finding.estimatedReclaimableBytes === null
                      ? "Unknown"
                      : formatCleanerBytes(finding.estimatedReclaimableBytes),
                  ],
                  ["Logical size", formatCleanerBytes(finding.logicalBytes)],
                  [
                    "Allocated size",
                    finding.allocatedBytes === null
                      ? "Unavailable"
                      : formatCleanerBytes(finding.allocatedBytes),
                  ],
                  [
                    "Unique allocation",
                    finding.uniqueAllocatedBytes === null
                      ? "Unavailable"
                      : formatCleanerBytes(finding.uniqueAllocatedBytes),
                  ],
                  [
                    "Recovery bounds",
                    `${formatCleanerBytes(
                      finding.reclaimableLowerBoundBytes,
                    )} to ${
                      finding.reclaimableUpperBoundBytes === null
                        ? "unknown"
                        : formatCleanerBytes(finding.reclaimableUpperBoundBytes)
                    }`,
                  ],
                  [
                    "Accounting",
                    `${humanizeCleanerValue(
                      finding.measurementCompleteness,
                    )}, ${humanizeCleanerValue(
                      finding.accountingConfidence,
                    )} confidence`,
                  ],
                  [
                    "Files and folders",
                    `${finding.measuredFileCount.toLocaleString()} files, ${finding.measuredDirectoryCount.toLocaleString()} folders`,
                  ],
                  [
                    "Hardlinks",
                    `${finding.hardlinkRecordCount.toLocaleString()} internal, ${finding.externalHardlinkRecordCount.toLocaleString()} linked outside`,
                  ],
                ]}
              />
              {finding.measurementFailureCategory && (
                <DetailNote>
                  {humanizeCleanerValue(finding.measurementFailureCategory)}
                  {finding.measurementFailureExplanation
                    ? `. ${finding.measurementFailureExplanation}`
                    : ""}
                </DetailNote>
              )}
              {finding.sizeMeasurementWarnings.length > 0 && (
                <DetailList items={finding.sizeMeasurementWarnings} />
              )}
            </DetailGroup>

            <DetailGroup label="Safety">
              <DetailRows
                rows={[
                  ["Status", meta.label],
                  ["Data kind", humanizeCleanerValue(finding.dataKind)],
                  [
                    "Leftover cache",
                    finding.leftoverCacheStatus === "leftover-cache"
                      ? "Confirmed"
                      : humanizeCleanerValue(finding.leftoverCacheStatus),
                  ],
                  [
                    "Recommendation",
                    humanizeCleanerValue(finding.recommendation),
                  ],
                  [
                    "Path checks",
                    `${humanizeCleanerValue(finding.reparsePointStatus)}${
                      finding.overlapGroup ? ", overlaps another finding" : ""
                    }`,
                  ],
                ]}
              />
              <DetailNote>{finding.statusExplanation}</DetailNote>
              {finding.recommendationReason !== finding.statusExplanation && (
                <DetailNote>{finding.recommendationReason}</DetailNote>
              )}
              {finding.mixedDataWarnings.length > 0 && (
                <DetailList items={finding.mixedDataWarnings} />
              )}
              {finding.consequences.length > 0 && (
                <DetailList items={finding.consequences} />
              )}
              {finding.restoration && (
                <DetailNote>{finding.restoration}</DetailNote>
              )}
            </DetailGroup>

            <DetailGroup label="Application">
              <DetailRows
                rows={[
                  ["Owner", finding.applicationName ?? "No application owner"],
                  [
                    "Installation",
                    formatCleanerInstallState(finding.applicationInstallState),
                  ],
                  [
                    "Running",
                    formatCleanerRunningState(finding.applicationRunningState),
                  ],
                  [
                    "Ownership",
                    `${humanizeCleanerValue(
                      finding.ownershipStatus,
                    )}, ${humanizeCleanerValue(
                      finding.ownershipConfidence,
                    )} confidence`,
                  ],
                  [
                    "Shared ownership",
                    finding.sharedOwnership ? "Shared" : "Not shared",
                  ],
                  [
                    "Product channel",
                    humanizeCleanerValue(
                      finding.productChannel ??
                        finding.applicationChannel ??
                        "unknown",
                    ),
                  ],
                  [
                    "Application instance",
                    finding.applicationInstanceId ??
                      "No current instance fingerprint",
                  ],
                  [
                    "Exact data root",
                    finding.exactDataRoot ? "Verified" : "Not verified",
                  ],
                ]}
              />
              {finding.verifiedExecutableBasename && (
                <DetailNote>
                  Verified executable: {finding.verifiedExecutableBasename}
                </DetailNote>
              )}
              {finding.lastSeenInstalledAt && (
                <DetailNote>
                  Last seen installed:{" "}
                  {formatCleanerDate(finding.lastSeenInstalledAt)}
                </DetailNote>
              )}
              {(finding.strongEvidence.length > 0 ||
                finding.supportingEvidence.length > 0 ||
                finding.staleEvidence.length > 0 ||
                finding.unavailableEvidenceSources.length > 0) && (
                <div className="space-y-2">
                  <EvidenceList
                    label="Strong evidence"
                    items={finding.strongEvidence}
                  />
                  <EvidenceList
                    label="Supporting evidence"
                    items={finding.supportingEvidence}
                  />
                  <EvidenceList
                    label="Stale evidence"
                    items={finding.staleEvidence}
                  />
                  <EvidenceList
                    label="Unavailable sources"
                    items={finding.unavailableEvidenceSources}
                  />
                </div>
              )}
            </DetailGroup>

            <DetailGroup label="Process evidence">
              {finding.relatedProcesses.length === 0 ? (
                <DetailNote>No related process evidence.</DetailNote>
              ) : (
                <div className="space-y-1.5">
                  {finding.relatedProcesses.map((processInfo) => (
                    <DetailNote
                      key={`${processInfo.name}-${processInfo.pid ?? "unknown"}`}
                    >
                      <strong>{processInfo.name}</strong>
                      {processInfo.pid
                        ? `, PID ${processInfo.pid}`
                        : ", PID unavailable"}
                      {`. ${humanizeCleanerValue(
                        processInfo.evidenceStrength,
                      )}. ${processInfo.blocking ? "Blocks cleanup." : "Advisory only."}`}
                    </DetailNote>
                  ))}
                </div>
              )}
            </DetailGroup>

            <DetailGroup label="History">
              <DetailNote>{finding.regeneration.summary}</DetailNote>
              {finding.history ? (
                <DetailRows
                  rows={[
                    [
                      "Last cleaned",
                      finding.history.lastCleanedAt
                        ? formatCleanerDate(finding.history.lastCleanedAt)
                        : "Never",
                    ],
                    [
                      "Last cleaned size",
                      finding.history.lastCleanedSizeBytes
                        ? formatCleanerBytes(
                            finding.history.lastCleanedSizeBytes,
                          )
                        : "Not recorded",
                    ],
                    [
                      "Outcomes",
                      `${finding.history.successfulCleanups} successful cleanups, ${finding.history.observedRegenerations} observed regenerations`,
                    ],
                  ]}
                />
              ) : (
                <DetailNote>No cleanup history for this finding.</DetailNote>
              )}
            </DetailGroup>
          </CleanerDetailsAccordion>
        </div>
      </div>
    </motion.article>
  );
}

function CleanerFindingMenu({
  findingName,
  excluded,
  onExclude,
  onManageExclusions,
}: {
  findingName: string;
  excluded: boolean;
  onExclude(scope: ExclusionScope): void;
  onManageExclusions(): void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    }, 0);
    const closeForOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeForEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeForOutsideClick);
    document.addEventListener("keydown", closeForEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("mousedown", closeForOutsideClick);
      document.removeEventListener("keydown", closeForEscape);
    };
  }, [open]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown")
      nextIndex = (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "Tab") {
      setOpen(false);
      return;
    } else {
      return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const runAction = (action: () => void) => {
    setOpen(false);
    action();
    buttonRef.current?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${findingName}`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="grid h-9 w-9 place-items-center rounded-lg text-gray-800 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${findingName}`}
          onKeyDown={handleMenuKeyDown}
          className="absolute bottom-full right-0 z-30 mb-1 max-h-72 w-56 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-gray-300 bg-gray-100 p-1.5 text-sm text-gray-900 shadow-2xl"
        >
          {excluded ? (
            <MenuItem
              label="Manage exclusions"
              onSelect={() => runAction(onManageExclusions)}
            />
          ) : (
            (
              [
                ["finding", "Exclude finding"],
                ["detector", "Exclude detector"],
                ["category", "Exclude category"],
                ["application", "Exclude app"],
                ["root", "Exclude root"],
                ["path", "Exclude exact path"],
              ] as const
            ).map(([scope, label]) => (
              <MenuItem
                key={scope}
                label={label}
                dataScope={scope}
                onSelect={() => runAction(() => onExclude(scope))}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  dataScope,
  onSelect,
}: {
  label: string;
  dataScope?: ExclusionScope;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-exclusion-scope={dataScope}
      onClick={onSelect}
      className="flex min-h-9 w-full items-center rounded-lg px-3 py-2 text-left outline-none hover:bg-gray-200 focus-visible:bg-gray-200 focus-visible:ring-2 focus-visible:ring-cleaner-review-border"
    >
      {label}
    </button>
  );
}

function SelectionControl({
  finding,
  selected,
  selectable,
  onSelect,
}: {
  finding: CleanerFinding;
  selected: boolean;
  selectable: boolean;
  onSelect(selected: boolean): void;
}) {
  if (selectable) {
    const tone = finding.safety === "conditional" ? "conditional" : "safe";
    const styles = CLEANER_TONE_STYLES[tone];
    return (
      <label
        data-cleaner-selection-control="selectable"
        className={`relative grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-lg border bg-gray-100/95 outline-none transition hover:brightness-105 focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-gray-100 ${styles.border} ${styles.selectedRing}`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelect(event.target.checked)}
          className="peer sr-only"
          aria-label={`Select ${finding.displayName}, ${CLEANER_STATUS_META[finding.safety].label}`}
        />
        <span
          data-cleaner-checkbox-visual="true"
          className={`grid h-5 w-5 place-items-center rounded-[6px] border-2 transition-colors ${styles.checkbox}`}
          aria-hidden="true"
        >
          {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
        </span>
      </label>
    );
  }

  const visualStatus = getCleanerVisualStatus(finding.safety, finding.excluded);
  const meta = CLEANER_STATUS_META[visualStatus];
  const styles = CLEANER_TONE_STYLES[meta.tone];
  const Icon = finding.excluded
    ? Ban
    : finding.safety === "safe-after-close"
      ? Clock3
      : finding.safety === "protected"
        ? LockKeyhole
        : finding.safety === "manual-review"
          ? Search
          : AlertTriangle;
  return (
    <span
      data-cleaner-selection-control="blocked"
      className={`grid h-9 w-9 shrink-0 cursor-not-allowed place-items-center rounded-lg border ${styles.border} ${styles.surface} ${styles.icon}`}
      aria-disabled="true"
      aria-label={`${finding.displayName} cannot be selected, ${meta.label}`}
      title={`${meta.label}. Selection is unavailable.`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}

function DetailGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-700">
        {label}
      </h4>
      <div className="space-y-2 text-xs leading-5 text-gray-800">
        {children}
      </div>
    </section>
  );
}

function DetailRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-gray-700">
            {label}
          </dt>
          <dd className="break-words font-medium text-gray-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailNote({ children }: { children: ReactNode }) {
  return <p className="break-words">{children}</p>;
}

function DetailList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-4">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function EvidenceList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="font-semibold text-gray-900">{label}</div>
      <DetailList items={items} />
    </div>
  );
}
