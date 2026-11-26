export type CliChangeKind =
  | "added"
  | "removed"
  | "version"
  | "executable"
  | "path"
  | "precedence"
  | "ownership"
  | "availability"
  | "uncertain";
export type CliChange = {
  productId: string;
  name: string;
  installationId?: string;
  kind: CliChangeKind;
  before?: string;
  after?: string;
};
export type CliChanges = {
  schemaVersion: 1;
  comparedAt: number;
  baselineAt: number;
  entries: CliChange[];
  truncated: boolean;
};

export type CliPlatform = "win32" | "darwin";

export type CliCategory =
  | "ai-coding"
  | "runtime"
  | "package-manager"
  | "build-tool"
  | "cloud"
  | "infrastructure"
  | "database"
  | "developer-tool"
  | "other-development";

export type CliPackageSource =
  | "npm"
  | "pnpm"
  | "yarn-classic"
  | "bun"
  | "pipx"
  | "pip"
  | "uv"
  | "cargo"
  | "winget"
  | "chocolatey"
  | "scoop"
  | "homebrew-formula"
  | "homebrew-cask"
  | "macports"
  | "appx-alias"
  | "registry"
  | "standalone"
  | "unknown";

export type CliProductStatus =
  | "healthy"
  | "warning"
  | "broken"
  | "missing"
  | "unverified"
  | "unknown";

export type CliHealthStatus = CliProductStatus;

export type CliRuntimeHealth =
  | "healthy"
  | "broken"
  | "missing"
  | "inaccessible"
  | "incomplete"
  | "unknown";

export type CliVerificationStatus =
  | "verified"
  | "partially-verified"
  | "ownership-unknown"
  | "version-unverified"
  | "cached";

export type CliInstallationOrigin =
  | "user"
  | "system"
  | "package-manager"
  | "application-embedded"
  | "sdk-bundled"
  | "unknown";

export type CliDiscoveryKind =
  | "catalogue"
  | "package-command"
  | "user"
  | "candidate";

export type CliIssueCode =
  | "duplicate-version"
  | "path-conflict"
  | "shadowed"
  | "broken-shim"
  | "missing-target"
  | "inaccessible"
  | "incomplete-installation"
  | "cached-missing"
  | "package-source-unavailable"
  | "version-unverified";

export type CliPresence = "present" | "missing" | "inaccessible" | "unknown";
export type CliPathRole = "active" | "shadowed" | "not-on-path";
export type CliVersionSource =
  | "package-metadata"
  | "executable-metadata"
  | "version-probe"
  | "cached"
  | "unknown";

export type CliEndpointKind =
  | "native"
  | "script"
  | "shim"
  | "symlink"
  | "app-alias";

export type CliUninstallSupport =
  | "supported"
  | "requires-warning"
  | "blocked"
  | "manual-only";

export type CliScanStage =
  | "revalidating-cache"
  | "enumerating-path"
  | "reading-package-sources"
  | "matching-installations"
  | "checking-versions"
  | "finalizing";

export type CliScanStatus =
  | "idle"
  | "scanning"
  | "cancelling"
  | "complete"
  | "partial"
  | "cancelled"
  | "failed";

export type CliProduct = {
  id: string;
  displayName: string;
  category: CliCategory;
  aliases: string[];
  commandNames: string[];
  supportedPlatforms: CliPlatform[];
  discoveryConfidence: "catalogued" | "package-owned" | "executable";
  installationIds: string[];
  currentInstallationIds: string[];
  removedInstallationIds: string[];
  embeddedInstallationIds: string[];
  candidateInstallationIds?: string[];
  health: CliProductStatus;
  verificationStatus: CliVerificationStatus;
  issueCodes: CliIssueCode[];
};

export type CliPackageIdentity = {
  source: CliPackageSource;
  packageId: string;
  packageVersion?: string;
  scope: "user" | "machine" | "system" | "unknown";
  managerRoot?: string;
  managerExecutablePath?: string;
  managerCommandPath?: string;
  installRoot?: string;
  sourceName?: string;
  ownershipConfidence: "exact" | "corroborated" | "uncertain";
  uninstallEvidence?: "simple-manifest" | "manager-owned" | "none";
};

export type CliExecutableEndpoint = {
  id: string;
  commandName: string;
  kind: CliEndpointKind;
  path: string;
  canonicalPath?: string;
  symlinkTarget?: string;
  shimTarget?: string;
  shimPackageRoot?: string;
  ownerName?: string;
  publisher?: string;
  fileVersion?: string;
  bundledWith?: "strawberry-perl";
  pathIndex?: number;
  pathextIndex?: number;
  accessible: boolean;
  executable: boolean;
  targetExists: boolean;
  fileSize?: number;
  modifiedAt?: number;
  fileIdentity?: string;
  fingerprint: string;
};

export type CliCommand = {
  id: string;
  productId: string;
  installationId: string;
  name: string;
  endpointIds: string[];
  activeEndpointId?: string;
  pathRole: CliPathRole;
};

export type CliUninstallCapability = {
  status: CliUninstallSupport;
  source: CliPackageSource;
  packageId?: string;
  reasonCode:
    | "exact-manager-owned"
    | "multiple-commands"
    | "foundational-tool"
    | "unknown-source"
    | "standalone-binary"
    | "app-alias"
    | "source-unavailable"
    | "identity-uncertain"
    | "elevation-required"
    | "manager-policy"
    | "embedded-tool"
    | "installation-missing"
    | "state-changed";
  reason: string;
  warnings: string[];
  requiresElevation: boolean;
  providedCommands: string[];
};

export type CliInstallation = {
  id: string;
  productId: string;
  platform: CliPlatform;
  architecture: string;
  scope: CliPackageIdentity["scope"];
  origin: CliInstallationOrigin;
  discoveryKind?: CliDiscoveryKind;
  includedByUser?: boolean;
  commandVerification?: {
    endpointId: string;
    endpointFingerprint: string;
    checkedAt: number;
  };
  version?: string;
  versionSource: CliVersionSource;
  verificationStatus: CliVerificationStatus;
  packageIdentity?: CliPackageIdentity;
  endpointIds: string[];
  commandIds: string[];
  fingerprint: string;
  presence: CliPresence;
  health: CliRuntimeHealth;
  issueCodes: CliIssueCode[];
  firstSeenAt: number;
  lastSeenAt?: number;
  lastVerifiedAt?: number;
  lastSuccessfulVerificationAt?: number;
  missingSince?: number;
  uninstallCapability: CliUninstallCapability;
};

export type CliSourceResult = {
  sourceId: string;
  label: string;
  status: "success" | "failed" | "skipped";
  startedAt: number;
  finishedAt: number;
  recordCount: number;
  errorCode?: string;
  message?: string;
};

export type CliScanProgress = {
  scanSessionId: string;
  stage: CliScanStage;
  label: string;
  completedSources: number;
  totalSources: number;
  completedProbes: number;
  totalProbes: number;
  startedAt: number;
};

export type CliScanSession = {
  id: string;
  status: CliScanStatus;
  stage?: CliScanStage;
  startedAt: number;
  finishedAt?: number;
  completedSources: number;
  totalSources: number;
  completedProbes: number;
  totalProbes: number;
  message?: string;
};

export type CliInventorySnapshot = {
  changes?: CliChanges;
  schemaVersion: 2;
  revision: string;
  platform: CliPlatform;
  architecture: string;
  generatedAt: number;
  lastSuccessfulScanAt?: number;
  completeness: "complete" | "partial";
  cached: boolean;
  products: CliProduct[];
  installations: CliInstallation[];
  commands: CliCommand[];
  endpoints: CliExecutableEndpoint[];
  sourceResults: CliSourceResult[];
};

export type CliUninstallPreview = {
  token: string;
  expiresAt: number;
  inventoryRevision: string;
  installationId: string;
  productName: string;
  version?: string;
  source: CliPackageSource;
  packageId: string;
  scope: CliPackageIdentity["scope"];
  providedCommands: string[];
  remainingInstallationCount: number;
  support: CliUninstallSupport;
  requiresElevation: boolean;
  warnings: string[];
};

export type CliUninstallRequest = {
  installationId: string;
  inventoryRevision: string;
  previewToken: string;
  confirmation: "uninstall-exact-cli-installation";
};

export type CliUninstallProgress = {
  requestId: string;
  installationId: string;
  stage: "revalidating" | "uninstalling" | "verifying" | "refreshing";
  label: string;
};

export type CliUninstallResult = {
  requestId: string;
  installationId: string;
  status: "succeeded" | "failed" | "verification-failed";
  managerExitCode?: number;
  verifiedRemoved: boolean;
  message: string;
  inventoryRevision: string;
};

export type CliInstallationRef = {
  installationId: string;
  inventoryRevision: string;
};
