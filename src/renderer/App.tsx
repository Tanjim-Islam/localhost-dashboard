import React, { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import TitleBar from "./components/TitleBar";
import ServerCard from "./components/ServerCard";
import AHKCard from "./components/AHKCard";
import SettingsPanel from "./components/SettingsPanel";
import UpdateNotification from "./components/UpdateNotification";

dayjs.extend(relativeTime);

type Item = {
  key: string;
  pid: number;
  port: number;
  processName?: string;
  command?: string;
  path?: string;
  firstSeen: number;
  lastSeen: number;
  url: string;
  cpu?: number;
  memory?: number;
  framework?: string;
  cpuHistory?: number[];
  memoryHistory?: number[];
};

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

type TabType = "servers" | "ahk";

type HealthResult = {
  key: string;
  url: string;
  status: "healthy" | "slow" | "down";
  responseTime?: number;
  lastChecked: number;
  error?: string;
};

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [ahkItems, setAHKItems] = useState<AHKItem[]>([]);
  const [healthResults, setHealthResults] = useState<
    Record<string, HealthResult>
  >({});
  const [portNotes, setPortNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [openSettings, setOpenSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const [ahkHidden, setAHKHidden] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<TabType>("servers");

  useEffect(() => {
    const offUpdate = window.api.onScanUpdate((next) => setItems(next));
    const offError = window.api.onScanError((msg) => setError(msg));
    const offToggle = window.api.onToggleSettings(() =>
      setOpenSettings((v) => !v)
    );
    const offAHK = window.api.onAHKUpdate((next) => setAHKItems(next));
    const offHealth = window.api.onHealthUpdate((results) => {
      const map: Record<string, HealthResult> = {};
      results.forEach((r: HealthResult) => {
        map[r.key] = r;
      });
      setHealthResults(map);
    });
    window.api
      .getSettings()
      .then((s) =>
        setSettings({
          ...s,
          portsText: (s.ports ?? [])
            .map((p: any) => (Array.isArray(p) ? `${p[0]}-${p[1]}` : String(p)))
            .join(", "),
        })
      );
    window.api.getAllNotes().then(setPortNotes);
    return () => {
      offUpdate?.();
      offError?.();
      offToggle?.();
      offAHK?.();
      offHealth?.();
    };
  }, []);

  // Filter by search query and exclude optimistically hidden cards
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    // auto-expire hidden entries after 8s in case kill failed
    const visible = items.filter((it) => {
      const hidAt = hidden[it.key];
      if (hidAt && now - hidAt < 8000) return false;
      return true;
    });
    if (!q) return visible;
    return visible.filter((it) => {
      const hay = [
        it.port?.toString() ?? "",
        it.pid?.toString() ?? "",
        it.processName ?? "",
        it.command ?? "",
        it.framework ?? "",
        it.url ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, hidden, query]);

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

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, Item[]>>((acc, cur) => {
      const f = cur.framework ?? "Other";
      acc[f] = acc[f] || [];
      acc[f].push(cur);
      return acc;
    }, {});
  }, [filtered]);

  const showTabs = ahkItems.length > 0;

  return (
    <div className="h-screen w-screen bg-night text-gray-900 select-none overflow-hidden">
      <TitleBar
        onRefresh={() => window.api.refresh()}
        onSettings={() => setOpenSettings(true)}
        search={query}
        onSearchChange={setQuery}
      />

      <div className="px-6 py-5 overflow-y-auto overflow-x-hidden h-[calc(100vh-48px)]">
        {error && (
          <div className="bg-mimi_pink-700/30 text-mimi_pink-200 border border-mimi_pink-400/40 px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

        {/* Tabs and Kill All button */}
        <div className="flex items-center justify-between mb-5">
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
                <TabButton
                  active={activeTab === "ahk"}
                  onClick={() => setActiveTab("ahk")}
                  count={filteredAHK.length}
                >
                  AHK Scripts
                </TabButton>
              </>
            ) : (
              <div className="text-gray-600 text-sm font-medium">
                {filtered.length} server{filtered.length !== 1 ? "s" : ""}{" "}
                running
              </div>
            )}
          </div>

          {/* Kill All button - only on Servers tab */}
          {activeTab === "servers" && filtered.length > 0 && (
            <KillAllButton
              onKillAll={() => {
                window.api.killAllServers();
                // Optimistically hide all servers
                const allKeys = filtered.reduce(
                  (acc, it) => ({ ...acc, [it.key]: Date.now() }),
                  {}
                );
                setHidden((h) => ({ ...h, ...allKeys }));
              }}
            />
          )}
        </div>

        {/* Server Tab Content */}
        {activeTab === "servers" && (
          <>
            {Object.keys(grouped).length === 0 && (
              <div className="text-gray-600 text-center mt-20">
                No servers detected yet. Start a dev server and it will show up
                here.
              </div>
            )}

            <div
              className="grid gap-y-6 gap-x-6"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))",
              }}
            >
              {(Object.entries(grouped) as [string, Item[]][]).map(
                ([framework, list]) => (
                  <div key={framework} className="space-y-5">
                    <div className="text-gray-700 uppercase tracking-wider text-xs mb-2">
                      {framework}
                    </div>
                    {list.map((it) => (
                      <ServerCard
                        key={it.key}
                        item={it}
                        health={healthResults[it.key]}
                        note={portNotes[String(it.port)] || ""}
                        onNoteChange={async (port, note) => {
                          const all = await window.api.setNote(port, note);
                          setPortNotes(all);
                        }}
                        onOptimisticKill={(key) => {
                          setHidden((h) => ({ ...h, [key]: Date.now() }));
                        }}
                      />
                    ))}
                  </div>
                )
              )}
            </div>
          </>
        )}

        {/* AHK Tab Content */}
        {activeTab === "ahk" && (
          <>
            {filteredAHK.length === 0 && (
              <div className="text-gray-600 text-center mt-20">
                No AutoHotkey scripts detected. Start an AHK script and it will
                show up here.
              </div>
            )}

            <div
              className="grid gap-y-5 gap-x-6"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))",
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
          </>
        )}
      </div>

      <SettingsPanel
        open={openSettings}
        onClose={() => setOpenSettings(false)}
        settings={settings}
        onSave={async (s) => {
          const updated = await window.api.updateSettings(s);
          setSettings(updated);
          setOpenSettings(false);
        }}
        onReset={async () => {
          const updated = await window.api.resetSettings();
          setSettings(updated);
          setOpenSettings(false);
        }}
      />

      {/* Auto-update notification */}
      <UpdateNotification />
    </div>
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

function KillAllButton({ onKillAll }: { onKillAll: () => void }) {
  const [state, setState] = useState<"idle" | "confirm" | "done">("idle");

  const handleClick = () => {
    if (state === "idle") {
      setState("confirm");
      // Auto-reset after 3 seconds if not confirmed
      setTimeout(() => setState((s) => (s === "confirm" ? "idle" : s)), 3000);
    } else if (state === "confirm") {
      onKillAll();
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`
        h-9 px-4 rounded-full text-sm font-medium transition-all duration-200 transform
        ${
          state === "idle" &&
          "bg-mimi_pink-400/20 text-mimi_pink-200 hover:bg-mimi_pink-400/40 hover:scale-105"
        }
        ${
          state === "confirm" &&
          "bg-mimi_pink-400 text-white animate-pulse scale-105"
        }
        ${state === "done" && "bg-gray-600 text-gray-300"}
      `}
    >
      {state === "idle" && "Kill All"}
      {state === "confirm" && "Click to Confirm"}
      {state === "done" && "✓ Killed"}
    </button>
  );
}
