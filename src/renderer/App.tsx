import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import TitleBarComponent from "./components/TitleBar";
import ServersTabComponent from "./components/ServersTab";
import type { HealthStatus as HealthResult } from "../types/preload";
import type { ServerInfo } from "../shared/servers";
import AHKCard from "./components/AHKCard";
import AutomatorCard from "./components/AutomatorCard";
import SettingsPanelComponent from "./components/SettingsPanel";
import UpdateNotificationComponent from "./components/UpdateNotification";
import RecentScriptsDrawerComponent from "./components/RecentScriptsDrawer";
import EnvironmentKeysTabComponent from "./components/EnvironmentKeysTab";
import ClisTabComponent from "./components/ClisTab";

// Scanner and health updates must not render unrelated settings or CLI rows.
const TitleBar = memo(TitleBarComponent);
const ServersTab = memo(ServersTabComponent);
const SettingsPanel = memo(SettingsPanelComponent);
const UpdateNotification = memo(UpdateNotificationComponent);
const RecentScriptsDrawer = memo(RecentScriptsDrawerComponent);
const EnvironmentKeysTab = memo(EnvironmentKeysTabComponent);
const ClisTab = memo(ClisTabComponent);
const refresh = () => window.api.refresh();
const revealScript = (scriptPath: string) => window.api.openExplorer(scriptPath);

dayjs.extend(relativeTime);

type Item = ServerInfo;

type AHKItem = {
  key: string;
  pid: number;
  processName: string;
  scriptPath?: string;
  scriptName?: string;
  firstSeen: number;
  lastSeen: number;
  cpu?: number;
  memory?: number;
};

type PlatformFeatures = {
  servers: true;
  ahkScripts: boolean;
  automatorScripts: boolean;
  environmentKeys: boolean;
  clis: boolean;
};

type AutomatorItem = {
  key: string;
  pid?: number;
  ppid?: number;
  processName?: string;
  scriptName: string;
  sourceKind: string;
  sourceLabel: string;
  status: "running" | "installed";
  firstSeen: number;
  lastSeen: number;
  command?: string;
  scriptPath?: string;
  processPath?: string;
  runtimeSeconds?: number;
  canOpenInAutomator: boolean;
  cpu?: number;
  memory?: number;
};

type TabType =
  | "servers"
  | "clis"
  | "ahk"
  | "automator"
  | "environment";

type AppMeta = {
  version: string;
  platform: string;
  arch: string;
  features: PlatformFeatures;
  clisTestMode: boolean;
};

type RecentScript = {
  id: string;
  type: "ahk" | "automator";
  scriptPath: string;
  scriptName: string;
  firstSeen: number;
  lastUsed: number;
  useCount: number;
};


export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [ahkItems, setAHKItems] = useState<AHKItem[]>([]);
  const [automatorItems, setAutomatorItems] = useState<AutomatorItem[]>([]);
  const [healthResults, setHealthResults] = useState<
    Record<string, HealthResult>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [openSettings, setOpenSettings] = useState(false);
  const showSettings = useCallback(() => setOpenSettings(true), []);
  const closeSettings = useCallback(() => setOpenSettings(false), []);
  const saveSettings = useCallback(async (s: Parameters<typeof window.api.updateSettings>[0]) => {
    const updated = await window.api.updateSettings(s);
    if (updated.error) throw new Error(updated.error);
    setSettings(updated);
    setOpenSettings(false);
  }, []);
  const resetSettings = useCallback(async () => {
    setSettings(await window.api.resetSettings());
    setOpenSettings(false);
  }, []);
  const [query, setQuery] = useState("");
  const [ahkHidden, setAHKHidden] = useState<Record<string, number>>({});
  const [automatorHidden, setAutomatorHidden] = useState<
    Record<string, number>
  >({});
  const [recentScripts, setRecentScripts] = useState<RecentScript[]>([]);
  const [recentOpen, setRecentOpen] = useState(false);
  const closeRecent = useCallback(() => setRecentOpen(false), []);
  const startRecent = useCallback(async (id: string) => {
    setRecentScripts(await window.api.startRecentScript(id));
  }, []);
  const deleteRecent = useCallback(async (id: string) => {
    setRecentScripts(await window.api.deleteRecentScript(id));
  }, []);
  const [environmentKeyCount, setEnvironmentKeyCount] = useState(0);
  const [cliCount, setCliCount] = useState(0);
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const saved = localStorage.getItem("dashboard:activeTab");
    return saved === "clis" ||
      saved === "ahk" ||
      saved === "automator" ||
      saved === "environment"
      ? saved
      : "servers";
  });
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [platform, setPlatform] = useState<string | undefined>(undefined);
  const [platformFeatures, setPlatformFeatures] = useState<PlatformFeatures>({
    servers: true,
    ahkScripts: false,
    automatorScripts: false,
    environmentKeys: false,
    clis: false,
  });

  useEffect(() => {
    const offUpdate = window.api.onScanUpdate((next) => { setItems(next); setError(null); });
    void window.api.getServers().then(setItems);
    const offError = window.api.onScanError((msg) => setError(msg));
    const offToggle = window.api.onToggleSettings(() =>
      setOpenSettings((v) => !v),
    );
    const offAHK = window.api.onAHKUpdate((next) => setAHKItems(next));
    const offAutomator = window.api.onAutomatorUpdate((next) =>
      setAutomatorItems(next),
    );
    const offHealth = window.api.onHealthUpdate((results) => {
      const map: Record<string, HealthResult> = {};
      results.forEach((r: HealthResult) => {
        map[r.key] = r;
      });
      setHealthResults(map);
    });
    const offRecent = window.api.onRecentScriptsUpdate(setRecentScripts);
    const offSettings = window.api.onSettingsUpdate(setSettings);
    window.api.getSettings().then(setSettings);
    window.api.getRecentScripts().then(setRecentScripts);
    window.api.getMeta().then((nextMeta) => {
      setMeta(nextMeta);
      setVersion(nextMeta?.version);
      setPlatform(nextMeta?.platform);
      if (nextMeta?.features) setPlatformFeatures(nextMeta.features);
      window.api.refresh();
    });
    return () => {
      offUpdate?.();
      offError?.();
      offToggle?.();
      offAHK?.();
      offAutomator?.();
      offHealth?.();
      offRecent?.();
      offSettings();
    };
  }, []);

  // Persist active tab to localStorage
  useEffect(() => {
    localStorage.setItem("dashboard:activeTab", activeTab);
  }, [activeTab]);

  const supportedTabs = useMemo<TabType[]>(() => {
    const tabs: TabType[] = ["servers"];
    if (platformFeatures.clis) tabs.push("clis");
    if (platformFeatures.ahkScripts) tabs.push("ahk");
    if (platformFeatures.automatorScripts) tabs.push("automator");
    if (platformFeatures.environmentKeys) tabs.push("environment");
    return tabs;
  }, [platformFeatures]);

  // If a tab was remembered from another platform, fall back to servers.
  useEffect(() => {
    if (!meta) return;
    if (!supportedTabs.includes(activeTab)) {
      setActiveTab("servers");
    }
  }, [supportedTabs, activeTab, meta]);

  const filtered = useMemo(
    () => items.filter(item => item.discovery === "development" && !item.ignored),
    [items],
  );

  const filteredAHK = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const visible = ahkItems.filter((it) => {
      const hidAt = ahkHidden[it.key];
      if (hidAt && now - hidAt < 8000) return false;
      return true;
    });
    if (!q) return visible;
    return visible.filter((it) => {
      const hay = [
        it.pid?.toString() ?? "",
        it.processName ?? "",
        it.scriptPath ?? "",
        it.scriptName ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [ahkItems, ahkHidden, query]);

  const filteredAutomator = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const visible = automatorItems.filter((it) => {
      const hidAt = automatorHidden[it.key];
      if (hidAt && now - hidAt < 8000) return false;
      return true;
    });
    if (!q) return visible;
    return visible.filter((it) => {
      const hay = [
        it.pid?.toString() ?? "",
        it.processName ?? "",
        it.scriptName ?? "",
        it.scriptPath ?? "",
        it.processPath ?? "",
        it.sourceLabel ?? "",
        it.status ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [automatorItems, automatorHidden, query]);

  const showTabs = supportedTabs.length > 1;
  const scriptTab = platformFeatures.automatorScripts
    ? "automator"
    : platformFeatures.ahkScripts
      ? "ahk"
      : null;
  const automationTabLabel =
    scriptTab === "automator" ? "Automator Scripts" : "AHK Scripts";
  const scriptItemCount =
    scriptTab === "automator" ? automatorItems.length : ahkItems.length;
  const showRecentButton =
    activeTab === scriptTab &&
    (scriptItemCount > 0 || recentScripts.length > 0);

  return (
    <div className="app-shell flex h-screen w-screen flex-col bg-night text-gray-900 select-none">
      <TitleBar
        onRefresh={refresh}
        onSettings={showSettings}
        search={query}
        onSearchChange={setQuery}
        searchPlaceholder={
          activeTab === "environment"
            ? "Search ENV key names."
            : "Search projects, services, ports"
        }
        showSearch={activeTab !== "clis"}
        showRefresh={activeTab !== "clis"}
        version={version}
        platform={platform}
      />

      <div className="dashboard-content app-scrollbar min-h-0 flex-1 px-6 py-5 overflow-y-auto overflow-x-hidden">
        {error && (
          <div role="alert" className="bg-danger-surface text-danger-text border border-danger-border px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

        {/* Platform tabs */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-1">
            {showTabs ? (
              <>
                <TabButton
                  active={activeTab === "servers"}
                  onClick={() => setActiveTab("servers")}
                  count={filtered.length}
                >
                  Servers
                </TabButton>
                {platformFeatures.clis && (
                  <TabButton
                    active={activeTab === "clis"}
                    onClick={() => setActiveTab("clis")}
                    count={cliCount}
                  >
                    CLIs
                  </TabButton>
                )}
                {platformFeatures.ahkScripts && (
                  <TabButton
                    active={activeTab === "ahk"}
                    onClick={() => setActiveTab("ahk")}
                    count={filteredAHK.length}
                  >
                    AHK Scripts
                  </TabButton>
                )}
                {platformFeatures.automatorScripts && (
                  <TabButton
                    active={activeTab === "automator"}
                    onClick={() => setActiveTab("automator")}
                    count={filteredAutomator.length}
                  >
                    Automator Scripts
                  </TabButton>
                )}
                {platformFeatures.environmentKeys && (
                  <TabButton
                    active={activeTab === "environment"}
                    onClick={() => setActiveTab("environment")}
                    count={environmentKeyCount}
                  >
                    ENV Keys
                  </TabButton>
                )}
              </>
            ) : (
              <div className="text-gray-600 text-sm font-medium">
                {filtered.length} server{filtered.length !== 1 ? "s" : ""}{" "}
                running
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {showRecentButton && (
              <RecentlyUsedButton
                count={recentScripts.length}
                onClick={() => setRecentOpen(true)}
              />
            )}

          </div>
        </div>

        <div className="grid items-start">
        <AnimatePresence initial={false}>
        {activeTab === "servers" && <TabSurface key="servers"><ServersTab items={items} health={healthResults} query={query} platform={platform} /></TabSurface>}

        {/* AHK Tab Content */}
        {activeTab === "ahk" && (
          <TabSurface key="ahk">
            {filteredAHK.length === 0 && (
              <div className="text-gray-600 text-center mt-20">
                No AutoHotkey scripts running.
              </div>
            )}

            <div
              className="grid gap-y-5 gap-x-6"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
              }}
            >
              {filteredAHK.map((it) => (
                <AHKCard
                  key={it.key}
                  item={it}
                  onOptimisticKill={(key) => {
                    setAHKHidden((h) => ({ ...h, [key]: Date.now() }));
                  }}
                />
              ))}
            </div>
          </TabSurface>
        )}

        {/* Automator Tab Content */}
        {activeTab === "automator" && (
          <TabSurface key="automator">
            {filteredAutomator.length === 0 && (
              <div className="text-gray-600 text-center mt-20">
                No Automator scripts found.
              </div>
            )}

            <div
              className="grid gap-y-5 gap-x-6"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
              }}
            >
              {filteredAutomator.map((it) => (
                <AutomatorCard
                  key={it.key}
                  item={it}
                  onOptimisticStop={(key) => {
                    setAutomatorHidden((h) => ({ ...h, [key]: Date.now() }));
                  }}
                />
              ))}
            </div>
          </TabSurface>
        )}
        </AnimatePresence>

        {platformFeatures.environmentKeys && (
          <EnvironmentKeysTab
            active={activeTab === "environment"}
            query={query}
            onCountChange={setEnvironmentKeyCount}
          />
        )}

        {platformFeatures.clis && (
          <ClisTab
            active={activeTab === "clis"}
            testMode={Boolean(meta?.clisTestMode)}
            onCountChange={setCliCount}
          />
        )}
        </div>
      </div>

      <SettingsPanel
        open={openSettings}
        onClose={closeSettings}
        settings={settings}
        platform={meta?.platform}
        onSave={saveSettings}
        onReset={resetSettings}
      />

      {/* Auto-update notification */}
      <UpdateNotification />

      <RecentScriptsDrawer
        open={recentOpen}
        scripts={recentScripts}
        label={automationTabLabel}
        onClose={closeRecent}
        onStart={startRecent}
        onReveal={revealScript}
        onDelete={deleteRecent}
      />
    </div>
  );
}

function TabSurface({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className="min-w-0 [grid-area:1/1]"
      inert={!present}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18 }}
    >
      {children}
    </motion.div>
  );
}

function RecentlyUsedButton({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="h-9 rounded-full bg-gray-200/70 px-3 text-sm font-medium text-gray-800 transition-all duration-200 hover:bg-gray-300 hover:text-gray-900"
    >
      <span className="flex items-center gap-2">
        <ClockIcon />
        Recently Used
        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-celadon-400 px-1.5 text-xs font-semibold text-night-100">
          {count}
        </span>
      </span>
    </button>
  );
}

function ClockIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6v6l3.5 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function TabButton({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`
        relative px-5 py-2.5 text-sm font-medium rounded-full transition-all duration-200
        ${
          active
            ? "bg-night-700 text-night-100 shadow-md"
            : "bg-gray-200/60 text-gray-700 hover:bg-gray-300/80 hover:text-gray-900"
        }
      `}
    >
      <span className="flex items-center gap-2">
        {children}
        {typeof count === "number" && (
          <span
            className={`
              inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold rounded-full transition-colors
              ${
                active
                  ? "bg-celadon-400 text-white"
                  : "bg-gray-400/30 text-gray-600"
              }
            `}
          >
            {count}
          </span>
        )}
      </span>
    </button>
  );
}
