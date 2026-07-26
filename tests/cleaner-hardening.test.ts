import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import {
  canonicalizeWindowsAbsolutePath,
  canonicalizeWindowsDriveRoot,
  isWindowsPathInside,
  normalizeWindowsPath,
  sameWindowsPath,
} from "../src/main/cleaner/path-normalization";
import {
  createCleanerEnvironment,
  validateCleanerEnvironment,
} from "../src/main/cleaner/environment";
import {
  CLEANER_APPLICATION_DEFINITIONS,
  getCleanerApplicationDefinition,
  isCleanerProtectedParentBypassDefined,
} from "../src/main/cleaner/applications/definitions";
import {
  matchCleanerAppxIdentity,
  matchCleanerExecutableIdentity,
  matchCleanerRegistryIdentity,
} from "../src/main/cleaner/applications/evidence-collector";
import { resolveCleanerApplication } from "../src/main/cleaner/applications/installation-resolver";
import {
  resolveCleanerCandidateOwnership,
  resolveCleanerLeftoverCacheStatus,
} from "../src/main/cleaner/applications/ownership-resolver";
import { findRelatedCleanerProcesses } from "../src/main/cleaner/process-checker";
import {
  CLEANER_APPLICATION_OBSERVATION_MAX_AGE_MS,
  MAX_CLEANER_APPLICATION_OBSERVATIONS,
  pruneCleanerApplicationObservations,
  updateCleanerApplicationObservations,
} from "../src/main/cleaner/applications/observation-store";
import { migrateCleanerStore } from "../src/main/cleaner/store-migration";
import { synchronizeHistoryExclusions } from "../src/main/cleaner/exclusions";
import { CleanerCancellationToken } from "../src/main/cleaner/cancellation";
import { CleanerSizeCalculator } from "../src/main/cleaner/size-calculator";
import {
  createCleanerFixture,
  createEmptyCleanerState,
  removeCleanerFixture,
  scanFixture,
} from "./cleaner-test-helpers";
import type {
  CleanerApplicationDefinition,
  CleanerApplicationEvidence,
  CleanerApplicationEvidenceSnapshot,
  CleanerApplicationObservation,
  CleanerApplicationResolution,
  CleanerDetectorCandidate,
  CleanerEvidenceSourceType,
  CleanerFilesystem,
  CleanerOwnedDataKind,
  CleanerProcessMatchRule,
  CleanerProcessSnapshot,
} from "../src/main/cleaner/types";

const ALL_EVIDENCE_SOURCES: CleanerEvidenceSourceType[] = [
  "uninstall-registry",
  "app-path",
  "exact-registry-key",
  "executable",
  "appx",
  "shortcut",
  "package-manager",
  "process",
  "service",
  "scheduled-task",
  "protocol",
  "portable-root",
  "observation",
];

function evidenceSnapshot(
  evidence: CleanerApplicationEvidence[] = [],
  failedSources: CleanerEvidenceSourceType[] = [],
  mode: "standard" | "deep" = "deep",
): CleanerApplicationEvidenceSnapshot {
  return {
    collectedAt: 10_000,
    mode,
    sources: ALL_EVIDENCE_SOURCES.map((source) => ({
      source,
      mandatory: source !== "observation",
      completed: !failedSources.includes(source),
      error: failedSources.includes(source)
        ? `${source} unavailable`
        : undefined,
      evidence: evidence.filter((item) => item.source === source),
    })),
  };
}

function currentEvidence(
  source: CleanerEvidenceSourceType,
  applicationId: string,
  overrides: Partial<CleanerApplicationEvidence> = {},
): CleanerApplicationEvidence {
  return {
    source,
    applicationId,
    current: true,
    verified: false,
    strength: "medium",
    summary: `${source} evidence`,
    ...overrides,
  };
}

function processSnapshot(
  overrides: Partial<CleanerProcessSnapshot> = {},
): CleanerProcessSnapshot {
  return {
    name: "unknown.exe",
    pid: 100,
    commandCategory: "unknown",
    referencedPaths: [],
    ...overrides,
  };
}

test("Windows path canonicalisation preserves drive roots and rejects non-local targets", () => {
  assert.equal(canonicalizeWindowsDriveRoot("C:"), "C:\\");
  assert.equal(canonicalizeWindowsDriveRoot("c:\\"), "C:\\");
  assert.equal(canonicalizeWindowsDriveRoot("d:/"), "D:\\");
  assert.equal(normalizeWindowsPath("C:\\"), "c:\\");
  assert.equal(
    normalizeWindowsPath("c:/Users/Test/Cache/"),
    "c:\\users\\test\\cache",
  );
  assert.equal(
    canonicalizeWindowsAbsolutePath("c:/Program Files/Test/cache/"),
    "c:\\Program Files\\Test\\cache\\",
  );
  assert.equal(
    sameWindowsPath("C:\\Users\\Test\\Space Here", "c:/users/test/space here/"),
    true,
  );
  assert.equal(
    isWindowsPathInside("C:\\Users\\Test\\Cache\\file.bin", "c:/users/test"),
    true,
  );

  for (const invalid of [
    "",
    "C:",
    ".\\cache",
    "cache",
    "file://C:/cache",
    "\\\\server\\share\\cache",
    "\\\\?\\C:\\cache",
    "\\\\.\\C:\\cache",
    "C:\\Temp\\*",
    "%LOCALAPPDATA%\\cache",
  ]) {
    assert.throws(() => normalizeWindowsPath(invalid), invalid);
  }
});

test("Cleaner environment rejects malformed internal roots before scanning", () => {
  const base = {
    systemDrive: "C:\\",
    home: "C:\\Users\\Fixture",
    localAppData: "C:\\Users\\Fixture\\AppData\\Local",
    roamingAppData: "C:\\Users\\Fixture\\AppData\\Roaming",
    programData: "C:\\ProgramData",
    windowsDir: "C:\\Windows",
    tempDir: "C:\\Users\\Fixture\\AppData\\Local\\Temp",
    projectRoots: ["C:\\Users\\Fixture\\Projects"],
    definitionVersion: 2,
  };
  assert.doesNotThrow(() => validateCleanerEnvironment(base));
  assert.doesNotThrow(() =>
    validateCleanerEnvironment({
      ...base,
      projectRoots: ["C:\\src\\Local-Dashboard"],
    }),
  );
  assert.doesNotThrow(() =>
    validateCleanerEnvironment({
      ...base,
      projectRoots: [],
      tempDir:
        "C:\\Users\\Fixture\\AppData\\Local\\Temp\\Local Dashboard packaged",
    }),
  );
  assert.throws(
    () => validateCleanerEnvironment({ ...base, systemDrive: "C:" }),
    /systemDrive.*absolute|canonical/i,
  );
  assert.throws(
    () =>
      validateCleanerEnvironment({
        ...base,
        roamingAppData: "D:\\Users\\Fixture\\AppData\\Roaming",
      }),
    /outside the configured system drive/i,
  );
  assert.throws(
    () =>
      validateCleanerEnvironment({
        ...base,
        localAppData: "\\\\server\\share",
      }),
    /environment localAppData is invalid/i,
  );
});

test("production environment construction canonicalises SystemDrive=C: to C:\\", async () => {
  const environment = await createCleanerEnvironment({
    ...process.env,
    LOCAL_DASHBOARD_CLEANER_TEST_ROOT: undefined,
    SystemDrive: "C:",
    LOCALAPPDATA: "C:\\Users\\Fixture\\AppData\\Local",
    APPDATA: "C:\\Users\\Fixture\\AppData\\Roaming",
    PROGRAMDATA: "C:\\ProgramData",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Users\\Fixture\\AppData\\Local\\Temp",
    GOCACHE: "C:\\Users\\Fixture\\AppData\\Local\\go-build",
  });
  assert.equal(environment.systemDrive, "C:\\");
});

test("protected-parent bypasses require exact central data-root definitions", () => {
  const environment = {
    systemDrive: "C:\\",
    home: "C:\\Users\\Fixture",
    localAppData: "C:\\Users\\Fixture\\AppData\\Local",
    roamingAppData: "C:\\Users\\Fixture\\AppData\\Roaming",
    programData: "C:\\ProgramData",
    windowsDir: "C:\\Windows",
    tempDir: "C:\\Users\\Fixture\\AppData\\Local\\Temp",
    projectRoots: ["C:\\Users\\Fixture\\Projects"],
    definitionVersion: 2,
  };
  const chromeRoot = path.win32.join(
    environment.localAppData,
    "Google",
    "Chrome",
    "User Data",
  );
  assert.equal(
    isCleanerProtectedParentBypassDefined(
      {
        applicationId: "browser.chrome",
        protectedAncestor: chromeRoot,
        exactTarget: path.win32.join(chromeRoot, "Default", "Cache"),
        rootId: "browser.chrome.cache-leaf",
      },
      environment,
    ),
    true,
  );
  assert.equal(
    isCleanerProtectedParentBypassDefined(
      {
        applicationId: "browser.chrome",
        protectedAncestor: chromeRoot,
        exactTarget: path.win32.join(chromeRoot, "Default", "History"),
        rootId: "browser.chrome.cache-leaf",
      },
      environment,
    ),
    false,
  );
  assert.equal(
    isCleanerProtectedParentBypassDefined(
      {
        applicationId: "browser.chrome",
        protectedAncestor: chromeRoot,
        exactTarget: path.win32.join(chromeRoot, "Default", "Cache", "nested"),
        rootId: "browser.chrome.cache-leaf",
      },
      environment,
    ),
    false,
  );
});

test("application identity matching is exact and channel-specific", () => {
  assert.deepEqual(
    matchCleanerRegistryIdentity({
      displayName: "Antigravity Tools",
      publisher: "lbjlaq",
    }),
    ["tool.antigravity-tools"],
  );
  assert.deepEqual(
    matchCleanerRegistryIdentity({
      displayName: "Antigravity",
      publisher: "lbjlaq",
    }),
    [],
  );
  assert.deepEqual(matchCleanerExecutableIdentity("antigravity_tools.exe"), [
    "tool.antigravity-tools",
  ]);
  assert.deepEqual(matchCleanerExecutableIdentity("antigravity.exe"), [
    "editor.antigravity",
  ]);
  assert.deepEqual(matchCleanerExecutableIdentity("Code.exe"), [
    "editor.vscode",
  ]);
  assert.deepEqual(matchCleanerExecutableIdentity("Code - Insiders.exe"), [
    "editor.vscode-insiders",
  ]);
  assert.deepEqual(matchCleanerExecutableIdentity("Windsurf.exe"), [
    "editor.windsurf",
  ]);
  assert.deepEqual(matchCleanerExecutableIdentity("Windsurf - Next.exe"), [
    "editor.windsurf-next",
  ]);
  assert.deepEqual(matchCleanerExecutableIdentity("renamed-Code.exe"), []);
  assert.deepEqual(
    matchCleanerAppxIdentity({
      packageFamilyName: "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0",
    }),
    ["app.chatgpt"],
  );
  assert.notEqual(
    getCleanerApplicationDefinition("editor.antigravity")?.familyId,
    getCleanerApplicationDefinition("tool.antigravity-tools")?.familyId,
  );
});

test("installation resolver uses explicit positive, ambiguous, portable, and negative states", () => {
  const definition = getCleanerApplicationDefinition("editor.windsurf")!;
  const resolve = (
    evidence: CleanerApplicationEvidence[],
    failed: CleanerEvidenceSourceType[] = [],
    processes: CleanerProcessSnapshot[] = [],
    observation?: CleanerApplicationObservation,
    mode: "standard" | "deep" = "deep",
  ) =>
    resolveCleanerApplication(
      definition,
      evidenceSnapshot(evidence, failed, mode),
      processes,
      observation,
    );

  assert.equal(
    resolve([
      currentEvidence("uninstall-registry", definition.id),
      currentEvidence("executable", definition.id, {
        verified: true,
        strength: "strong",
        executablePath: "C:\\Apps\\Windsurf\\Windsurf.exe",
      }),
    ]).installState,
    "confirmed-installed",
  );
  assert.equal(
    resolve([currentEvidence("uninstall-registry", definition.id)])
      .installState,
    "ambiguous",
  );
  assert.equal(
    resolve([
      currentEvidence("executable", definition.id, {
        verified: true,
        strength: "strong",
        executablePath: "C:\\Apps\\Windsurf\\Windsurf.exe",
      }),
    ]).installState,
    "probably-installed",
  );
  assert.equal(
    resolve([
      currentEvidence("shortcut", definition.id, {
        verified: true,
        strength: "strong",
        targetPath: "C:\\Apps\\Windsurf\\Windsurf.exe",
      }),
    ]).installState,
    "confirmed-installed",
  );
  assert.equal(
    resolve([
      currentEvidence("appx", definition.id, {
        verified: true,
        strength: "strong",
        packageFamilyName: "Fixture.Windsurf_123",
      }),
    ]).installState,
    "confirmed-installed",
  );
  assert.equal(
    resolve([
      currentEvidence("package-manager", definition.id),
      currentEvidence("executable", definition.id, {
        verified: true,
        strength: "strong",
        executablePath: "C:\\Apps\\Windsurf\\Windsurf.exe",
      }),
    ]).installState,
    "confirmed-installed",
  );
  assert.equal(
    resolve([currentEvidence("package-manager", definition.id)]).installState,
    "ambiguous",
  );
  assert.equal(
    resolve([currentEvidence("scheduled-task", definition.id)]).installState,
    "ambiguous",
  );
  assert.equal(
    resolve([
      currentEvidence("shortcut", definition.id, {
        stale: true,
        current: false,
      }),
    ]).installState,
    "ambiguous",
  );
  assert.equal(
    resolve([
      currentEvidence("portable-root", definition.id, {
        verified: true,
        portable: true,
        strength: "strong",
        executablePath: "C:\\Portable\\Windsurf\\Windsurf.exe",
      }),
    ]).installState,
    "portable-detected",
  );
  assert.equal(resolve([]).installState, "probably-uninstalled");
  assert.equal(
    resolve([], [], [], {
      applicationId: definition.id,
      definitionVersion: definition.definitionVersion,
      lastSeenInstalledAt: 1_000,
      lastInstallState: "confirmed-installed",
      lastEvidenceTypes: ["executable"],
      lastKnownRootIds: [],
      updatedAt: 1_000,
    }).installState,
    "confirmed-uninstalled",
  );
  assert.equal(resolve([], ["shortcut"]).installState, "ambiguous");
  assert.equal(
    resolve([], [], [], undefined, "standard").installState,
    "ambiguous",
  );
  assert.equal(
    resolve(
      [currentEvidence("process", definition.id, { verified: true })],
      [],
      [
        processSnapshot({
          name: "Windsurf.exe",
          applicationId: definition.id,
        }),
      ],
    ).runningState,
    "confirmed-running",
  );
  assert.equal(
    resolve(
      [
        currentEvidence("portable-root", definition.id, {
          verified: true,
          portable: true,
          strength: "strong",
          executablePath: "C:\\Portable\\Windsurf\\Windsurf.exe",
        }),
        currentEvidence("process", definition.id, {
          verified: true,
          strength: "strong",
        }),
      ],
      [],
      [
        processSnapshot({
          name: "Windsurf.exe",
          applicationId: definition.id,
        }),
      ],
    ).installState,
    "confirmed-installed",
  );
  assert.equal(
    resolve([], [], [processSnapshot({ name: "Windsurf.exe" })]).runningState,
    "likely-running",
  );
  assert.equal(
    resolve(
      [
        currentEvidence("uninstall-registry", definition.id),
        currentEvidence("executable", definition.id, {
          verified: true,
          strength: "strong",
          executablePath: "C:\\NewPath\\Windsurf.exe",
        }),
      ],
      [],
      [],
      {
        applicationId: definition.id,
        definitionVersion: definition.definitionVersion,
        lastSeenInstalledAt: 1_000,
        lastNegativeAuditAt: 2_000,
        lastInstallState: "confirmed-uninstalled",
        lastEvidenceTypes: [],
        lastKnownRootIds: ["old-root"],
        updatedAt: 2_000,
      },
    ).installState,
    "confirmed-installed",
  );
});

test("stable and prerelease channels can be installed together without merging", () => {
  const stable = getCleanerApplicationDefinition("editor.vscode")!;
  const insiders = getCleanerApplicationDefinition("editor.vscode-insiders")!;
  const snapshot = evidenceSnapshot([
    currentEvidence("executable", stable.id, {
      verified: true,
      strength: "strong",
      executablePath: "C:\\Apps\\VS Code\\Code.exe",
    }),
    currentEvidence("uninstall-registry", stable.id),
    currentEvidence("executable", insiders.id, {
      verified: true,
      strength: "strong",
      executablePath: "C:\\Apps\\VS Code Insiders\\Code - Insiders.exe",
    }),
    currentEvidence("uninstall-registry", insiders.id),
  ]);
  assert.equal(
    resolveCleanerApplication(stable, snapshot, []).installState,
    "confirmed-installed",
  );
  assert.equal(
    resolveCleanerApplication(insiders, snapshot, []).installState,
    "confirmed-installed",
  );
  assert.notEqual(stable.id, insiders.id);
  assert.notEqual(stable.channel, insiders.channel);
});

test("application instance fingerprints change when a verified installation path changes", () => {
  const definition = getCleanerApplicationDefinition("editor.cursor")!;
  const resolveAt = (executablePath: string) =>
    resolveCleanerApplication(
      definition,
      evidenceSnapshot([
        currentEvidence("uninstall-registry", definition.id),
        currentEvidence("executable", definition.id, {
          verified: true,
          strength: "strong",
          executablePath,
        }),
      ]),
      [],
    );
  const first = resolveAt("C:\\Apps\\Cursor\\Cursor.exe");
  const reinstalled = resolveAt("C:\\NewApps\\Cursor\\Cursor.exe");
  assert.ok(first.applicationInstanceId);
  assert.ok(reinstalled.applicationInstanceId);
  assert.notEqual(
    first.applicationInstanceId,
    reinstalled.applicationInstanceId,
  );
});

test("service-only evidence can identify an explicit shared component", () => {
  const base = getCleanerApplicationDefinition("updater.stealth-coder")!;
  const definition: CleanerApplicationDefinition = {
    ...base,
    id: "fixture.shared-service",
    familyId: "fixture.shared-service",
    sharedComponents: ["fixture-service"],
  };
  const resolution = resolveCleanerApplication(
    definition,
    evidenceSnapshot([
      currentEvidence("service", definition.id, {
        serviceName: "FixtureService",
      }),
    ]),
    [],
  );
  assert.equal(resolution.installState, "shared-component");
});

test("stable, prerelease, similarly named, and unrelated project identities do not collide", () => {
  const identifiers = new Set(
    CLEANER_APPLICATION_DEFINITIONS.map((definition) => definition.id),
  );
  for (const expected of [
    "editor.vscode",
    "editor.vscode-insiders",
    "editor.windsurf",
    "editor.windsurf-next",
    "editor.antigravity",
    "tool.antigravity-tools",
  ]) {
    assert.equal(identifiers.has(expected), true);
  }
  assert.deepEqual(
    matchCleanerRegistryIdentity({ displayName: "Cursor Project" }),
    [],
  );
  assert.deepEqual(
    matchCleanerRegistryIdentity({ displayName: "Chrome DevTools MCP" }),
    [],
  );
  assert.deepEqual(
    matchCleanerRegistryIdentity({ displayName: "antigravity npm package" }),
    [],
  );
  assert.deepEqual(
    matchCleanerRegistryIdentity({ displayName: "Slack Helper Clone" }),
    [],
  );
});

test("process association blocks strong cache consumers and keeps generic names advisory", () => {
  const npmTarget = "C:\\Users\\Fixture\\AppData\\Local\\npm-cache\\_cacache";
  const rules: CleanerProcessMatchRule[] = [
    {
      commandCategories: ["npm-cache-operation"],
      allowReferencedTarget: true,
      weakNameWarnings: ["node.exe"],
    },
  ];
  const related = findRelatedCleanerProcesses(
    rules,
    [
      processSnapshot({ name: "node.exe", pid: 1 }),
      processSnapshot({
        name: "node.exe",
        pid: 2,
        commandCategory: "npm-cache-operation",
        referencedPaths: [npmTarget],
      }),
      processSnapshot({
        name: "electron.exe",
        pid: 3,
        applicationId: "local-dashboard",
      }),
    ],
    npmTarget,
  );
  assert.equal(
    related.find((item) => item.pid === 1)?.evidenceStrength,
    "weak-name-only",
  );
  assert.equal(related.find((item) => item.pid === 1)?.blocking, false);
  assert.equal(
    related.find((item) => item.pid === 2)?.evidenceStrength,
    "confirmed-consumer",
  );
  assert.equal(related.find((item) => item.pid === 2)?.blocking, true);
  assert.equal(
    related.some((item) => item.pid === 3),
    false,
  );

  const uvTarget = "C:\\Users\\Fixture\\AppData\\Local\\uv\\cache";
  const uvRelated = findRelatedCleanerProcesses(
    [
      {
        applicationIds: ["runtime.uv"],
        commandCategories: ["uv-operation"],
        executableBasenames: ["uv.exe"],
        allowExecutableInsideTarget: true,
        allowReferencedTarget: true,
        weakNameWarnings: ["python.exe"],
      },
    ],
    [
      processSnapshot({ name: "python.exe", pid: 10 }),
      processSnapshot({
        name: "uv.exe",
        pid: 11,
        commandCategory: "uv-operation",
      }),
      processSnapshot({
        name: "python.exe",
        pid: 12,
        executablePath: `${uvTarget}\\runtime\\python.exe`,
      }),
      processSnapshot({ name: "jupyter.exe", pid: 13 }),
    ],
    uvTarget,
  );
  assert.equal(uvRelated.find((item) => item.pid === 10)?.blocking, false);
  assert.equal(uvRelated.find((item) => item.pid === 11)?.blocking, true);
  assert.equal(uvRelated.find((item) => item.pid === 12)?.blocking, true);
  assert.equal(
    uvRelated.some((item) => item.pid === 13),
    false,
  );

  for (const name of ["dwm.exe", "explorer.exe", "electron.exe"]) {
    assert.deepEqual(
      findRelatedCleanerProcesses([], [processSnapshot({ name })], npmTarget),
      [],
    );
  }
});

test("npx and Electron download evidence is specific, duplicate names remain distinct, and PID reuse does not inherit ownership", () => {
  const npxTarget = "C:\\Users\\Fixture\\AppData\\Local\\npm-cache\\_npx";
  const npx = findRelatedCleanerProcesses(
    [
      {
        commandCategories: ["npx-execution"],
        allowReferencedTarget: true,
        weakNameWarnings: ["node.exe"],
      },
    ],
    [
      processSnapshot({
        name: "node.exe",
        pid: 200,
        createdAt: 1,
        commandCategory: "npx-execution",
        referencedPaths: [npxTarget],
      }),
      processSnapshot({
        name: "node.exe",
        pid: 201,
        createdAt: 2,
      }),
    ],
    npxTarget,
  );
  assert.equal(npx.length, 2);
  assert.equal(npx.find((item) => item.pid === 200)?.blocking, true);
  assert.equal(npx.find((item) => item.pid === 201)?.blocking, false);

  const electronTarget = "C:\\Users\\Fixture\\AppData\\Local\\electron\\Cache";
  const electron = findRelatedCleanerProcesses(
    [
      {
        commandCategories: ["electron-download"],
        allowReferencedTarget: true,
        weakNameWarnings: ["electron.exe", "node.exe"],
      },
    ],
    [
      processSnapshot({
        name: "electron.exe",
        pid: 300,
        applicationId: "local-dashboard",
      }),
      processSnapshot({
        name: "node.exe",
        pid: 301,
        commandCategory: "electron-download",
        referencedPaths: [electronTarget],
      }),
    ],
    electronTarget,
  );
  assert.equal(electron.find((item) => item.pid === 300)?.blocking, false);
  assert.equal(electron.find((item) => item.pid === 301)?.blocking, true);

  const reusedPid = findRelatedCleanerProcesses(
    [
      {
        applicationIds: ["editor.cursor"],
        executableBasenames: ["Cursor.exe"],
      },
    ],
    [
      processSnapshot({
        name: "notepad.exe",
        pid: 400,
        createdAt: 20,
      }),
    ],
    "C:\\Users\\Fixture\\AppData\\Roaming\\Cursor\\Cache",
  );
  assert.deepEqual(reusedPid, []);
});

test("data-kind and leftover-cache policy separates cache from recoverable state", () => {
  const uninstalledOwner: CleanerApplicationResolution = {
    id: "editor.windsurf",
    familyId: "editor.windsurf",
    channel: "stable",
    displayName: "Windsurf",
    definitionVersion: 2,
    installState: "probably-uninstalled",
    runningState: "not-running-observed",
    confidence: "medium",
    strongEvidence: [],
    supportingEvidence: [],
    staleEvidence: [],
    unavailableEvidenceSources: [],
    currentAuditComplete: true,
  };
  const installedOwner = {
    ...uninstalledOwner,
    installState: "confirmed-installed" as const,
  };
  const exclusive = {
    status: "exclusive" as const,
    confidence: "high" as const,
    ownerApplicationIds: [uninstalledOwner.id],
    shared: false,
  };
  const resolve = (
    dataKind: CleanerOwnedDataKind,
    owner: CleanerApplicationResolution = uninstalledOwner,
    overrides: Partial<
      Parameters<typeof resolveCleanerLeftoverCacheStatus>[0]
    > = {},
  ) =>
    resolveCleanerLeftoverCacheStatus({
      dataKind,
      ownership: exclusive,
      ownerResolutions: [owner],
      exactDataRoot: true,
      hasBlockingProcess: false,
      hasProtectedMarkers: false,
      hasInternalReparsePoints: false,
      ...overrides,
    });

  for (const kind of [
    "ordinary-cache",
    "download-cache",
    "build-cache",
    "compiled-cache",
    "updater-payload",
  ] as CleanerOwnedDataKind[]) {
    assert.equal(resolve(kind), "leftover-cache", kind);
  }
  for (const kind of [
    "extension-store",
    "settings",
    "session-state",
    "workspace-state",
    "history",
    "backup",
    "database",
    "local-storage",
    "indexed-db",
    "project-data",
    "model-data",
    "installed-runtime",
  ] as CleanerOwnedDataKind[]) {
    assert.equal(resolve(kind), "contains-recoverable-state", kind);
  }
  assert.equal(resolve("ordinary-cache", installedOwner), "not-leftover");
  assert.equal(
    resolve("ordinary-cache", uninstalledOwner, {
      hasBlockingProcess: true,
    }),
    "uncertain",
  );
  assert.equal(
    resolve("ordinary-cache", uninstalledOwner, {
      hasProtectedMarkers: true,
    }),
    "uncertain",
  );
  assert.equal(
    resolve("ordinary-cache", uninstalledOwner, {
      ownership: { ...exclusive, status: "shared", shared: true },
    }),
    "shared-cache",
  );
  assert.equal(resolve("service-worker-cache"), "not-leftover");
  assert.equal(resolve("shared-dependency-store"), "not-leftover");
  assert.equal(resolve("unknown"), "not-leftover");
});

test("candidate ownership never treats an unknown or shared owner as exclusive", () => {
  const candidate = {
    ownerApplicationIds: ["editor.windsurf", "editor.windsurf-next"],
    ownershipStatus: "shared",
    exactDataRoot: true,
  } as CleanerDetectorCandidate;
  const applications = [
    {
      id: "editor.windsurf",
    },
    {
      id: "editor.windsurf-next",
    },
  ] as CleanerApplicationResolution[];
  const ownership = resolveCleanerCandidateOwnership(candidate, applications);
  assert.equal(ownership.status, "shared");
  assert.equal(ownership.shared, true);
  assert.equal(ownership.ownerApplicationIds.length, 2);
});

test("application observations are bounded, expire, and never retain commands or PIDs", () => {
  const now = 2_000_000_000;
  const state = createEmptyCleanerState();
  for (
    let index = 0;
    index < MAX_CLEANER_APPLICATION_OBSERVATIONS + 25;
    index += 1
  ) {
    state.applicationObservations[`app.${index}`] = {
      applicationId: `app.${index}`,
      definitionVersion: 2,
      lastInstallState: "probably-installed",
      lastEvidenceTypes: ["executable"],
      lastKnownRootIds: ["cache"],
      updatedAt: now - index,
    };
  }
  state.applicationObservations["stale"] = {
    applicationId: "stale",
    definitionVersion: 2,
    lastInstallState: "unknown",
    lastEvidenceTypes: [],
    lastKnownRootIds: [],
    updatedAt: now - CLEANER_APPLICATION_OBSERVATION_MAX_AGE_MS - 1,
  };
  pruneCleanerApplicationObservations(state, now);
  assert.equal(
    Object.keys(state.applicationObservations).length,
    MAX_CLEANER_APPLICATION_OBSERVATIONS,
  );
  assert.equal("stale" in state.applicationObservations, false);

  const resolution = resolveCleanerApplication(
    getCleanerApplicationDefinition("editor.cursor")!,
    evidenceSnapshot([
      currentEvidence("executable", "editor.cursor", {
        verified: true,
        strength: "strong",
        executablePath: "C:\\Apps\\Cursor\\Cursor.exe",
      }),
    ]),
    [],
  );
  updateCleanerApplicationObservations(
    state,
    [resolution],
    evidenceSnapshot([
      currentEvidence("executable", "editor.cursor", {
        verified: true,
        strength: "strong",
        executablePath: "C:\\Apps\\Cursor\\Cursor.exe",
        summary: "Do not persist --secret token",
      }),
    ]),
    now,
  );
  const serialized = JSON.stringify(state.applicationObservations);
  assert.doesNotMatch(serialized, /--secret|commandLine|\"pid\"/i);
});

test("store migration is bounded and finding/category exclusions synchronize with history", () => {
  const migrated = migrateCleanerStore({
    schemaVersion: 1,
    exclusions: [],
    itemHistory: {},
    cleanupEvents: [],
    preferences: { defaultScanMode: "deep", showExcluded: true },
    rawRegistryDump: ["secret"],
    processIds: [123],
  });
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.preferences.defaultScanMode, "deep");
  assert.equal(migrated.migrationNotices.length, 1);
  assert.doesNotMatch(
    JSON.stringify(migrated),
    /rawRegistryDump|processIds|secret/,
  );

  const state = createEmptyCleanerState();
  state.itemHistory["finding"] = {
    key: "finding",
    detectorId: "detector",
    findingId: "finding-id",
    category: "Node.js and JavaScript",
    normalizedPath: "c:\\cache",
    applicationName: "npm",
    successfulCleanups: 0,
    observedRegenerations: 0,
    currentObservedSizeBytes: 1,
    regenerationBaselineComplete: false,
    excluded: false,
    repeatedlyRegenerated: false,
  };
  state.exclusions = [
    {
      id: "category-exclusion",
      scope: "category",
      value: "node.js and javascript",
      label: "Node",
      createdAt: 1,
    },
  ];
  synchronizeHistoryExclusions(state);
  assert.equal(state.itemHistory["finding"].excluded, true);
  state.exclusions = [
    {
      id: "finding-exclusion",
      scope: "finding",
      value: "finding-id",
      label: "Finding",
      createdAt: 2,
    },
  ];
  synchronizeHistoryExclusions(state);
  assert.equal(state.itemHistory["finding"].excluded, true);
});

test("fixture detectors expose exact cache leaves and keep mixed, model, runtime, Docker, and packaged state protected", async () => {
  const root = await createCleanerFixture();
  try {
    const { result } = await scanFixture(root, "deep");
    const all = (id: string) =>
      result.findings.filter((finding) => finding.detectorId === id);
    const one = (id: string) => all(id)[0];

    assert.equal(
      one("editor.cursor.compile-cache")?.dataKind,
      "compiled-cache",
    );
    assert.equal(one("windows.nvidia-dx-cache")?.dataKind, "compiled-cache");
    assert.equal(one("dev.go-build-cache")?.exactDataRoot, true);
    assert.equal(one("dev.anaconda.packages")?.safety, "protected");
    assert.equal(one("dev.anaconda.package-archive")?.safety, "conditional");
    assert.equal(one("updater.stealth-coder.state-root")?.safety, "protected");
    assert.equal(
      one("updater.stealth-coder.payload-child")?.dataKind,
      "updater-payload",
    );
    assert.equal(
      one("updater.zcode-desktop.payload-child")?.safety,
      "conditional",
    );
    assert.equal(one("windows.delivery-optimization")?.safety, "protected");
    assert.equal(all("virtualization.docker-vhdx").length >= 2, true);
    assert.equal(
      all("virtualization.docker-vhdx").every(
        (item) => item.recoverableBytes === 0,
      ),
      true,
    );
    assert.equal(one("app.slack.packaged-state")?.safety, "protected");
    assert.equal(one("app.chatgpt.packaged-state")?.safety, "protected");
    assert.equal(one("app.codex.packaged-state")?.safety, "protected");
    assert.equal(one("runtime.codex")?.dataKind, "installed-runtime");
    assert.equal(one("models.lm-studio")?.dataKind, "model-data");
    assert.equal(one("models.paddlex")?.safety, "protected");

    for (const id of [
      "browser.brave.cache-leaf",
      "browser.chrome.cache-leaf",
      "browser.edge.cache-leaf",
      "browser.firefox.cache-leaf",
    ]) {
      assert.equal(all(id).length > 0, true, id);
      assert.equal(
        all(id).every((item) => item.exactDataRoot),
        true,
        id,
      );
    }
    assert.equal(one("browser.brave.profile")?.safety, "protected");
    assert.equal(
      one("browser.brave.service-worker-cache")?.dataKind,
      "service-worker-cache",
    );

    for (const id of [
      "editor.jetbrains.version-root",
      "editor.android-studio.version-root",
    ]) {
      assert.equal(one(id)?.safety, "protected", id);
      assert.equal(one(id)?.canDelete, false, id);
    }
    assert.equal(
      all("editor.jetbrains.typed-cache").every((item) =>
        ["build-cache", "compiled-cache"].includes(item.dataKind),
      ),
      true,
    );
    assert.equal(
      all("editor.jetbrains.protected-state").every(
        (item) => item.safety === "protected",
      ),
      true,
    );
    assert.equal(
      all("editor.android-studio.protected-state").every(
        (item) => item.safety === "protected",
      ),
      true,
    );
    assert.equal(
      result.findings.some(
        (finding) =>
          finding.applicationId === "editor.antigravity" &&
          finding.applicationName === "Antigravity Tools",
      ),
      false,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});

test("bounded size measurement reports a partial lower bound instead of actionable space", async () => {
  const root = String.raw`C:\bounded-cache`;
  const filesystem: CleanerFilesystem = {
    async exists() {
      return true;
    },
    async lstat(targetPath) {
      if (sameWindowsPath(targetPath, root)) {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          isReparsePoint: false,
          size: 0,
          modifiedMs: 1,
        };
      }
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        isReparsePoint: false,
        size: 128,
        modifiedMs: 1,
      };
    },
    async readDirectory() {
      return Array.from({ length: 10 }, (_, index) => ({
        name: `entry-${index}.bin`,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }));
    },
    async realPath(targetPath) {
      return targetPath;
    },
    async unlink() {},
    async removeReparsePoint() {},
    async removeDirectory() {},
    async getSizeOverride() {
      return undefined;
    },
  };
  const calculator = new CleanerSizeCalculator(
    filesystem,
    new CleanerCancellationToken(),
    {
      policy: {
        kind: "standard-bounded",
        maxEntries: 2,
        maxDurationMs: 60_000,
        maxTrackedFileRecords: 10,
      },
    },
  );

  const measured = await calculator.measure(root);

  assert.equal(measured.complete, false);
  assert.equal(measured.inspectedEntries, 2);
  assert.equal(measured.fileCount, 1);
  assert.equal(measured.sizeBytes, 128);
});

test("free-space refresh updates only current drive data and preserves the scan-time measurement", async () => {
  const root = await createCleanerFixture();
  try {
    const harness = await scanFixture(root, "standard");
    const scanTimeBytes = harness.result.summary.scanTimeFreeDiskSpaceBytes;
    const scanTimeMeasuredAt =
      harness.result.summary.scanTimeFreeDiskSpaceMeasuredAt;
    harness.driveProvider.setFreeBytesSequence([
      scanTimeBytes + 512 * 1024 * 1024,
    ]);
    const refreshed = await harness.scanner.refreshFreeSpace(
      harness.session,
      harness.environment,
    );
    assert.equal(
      refreshed.summary.freeDiskSpaceBytes,
      scanTimeBytes + 512 * 1024 * 1024,
    );
    assert.equal(refreshed.summary.scanTimeFreeDiskSpaceBytes, scanTimeBytes);
    assert.equal(
      refreshed.summary.scanTimeFreeDiskSpaceMeasuredAt,
      scanTimeMeasuredAt,
    );
    assert.equal(refreshed.summary.freeSpaceIsStale, false);
    assert.match(
      refreshed.summary.sizeAccountingNotes.join(" "),
      /logical|allocated|sparse|VHDX|concurrent/i,
    );
  } finally {
    await removeCleanerFixture(root);
  }
});
