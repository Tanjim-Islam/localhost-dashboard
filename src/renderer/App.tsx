import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import TitleBar from './components/TitleBar';
import ServerCard from './components/ServerCard';
import AHKCard from './components/AHKCard';
import SettingsPanel from './components/SettingsPanel';

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

type TabType = 'servers' | 'ahk';

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [ahkItems, setAHKItems] = useState<AHKItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [openSettings, setOpenSettings] = useState(false);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Record<string, number>>({});
  const [ahkHidden, setAHKHidden] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<TabType>('servers');

  useEffect(() => {
    const offUpdate = window.api.onScanUpdate((next) => setItems(next));
    const offError = window.api.onScanError((msg) => setError(msg));
    const offToggle = window.api.onToggleSettings(() => setOpenSettings((v) => !v));
    const offAHK = window.api.onAHKUpdate((next) => setAHKItems(next));
    window.api.getSettings().then((s) => setSettings({ ...s, portsText: (s.ports ?? []).map((p: any) => Array.isArray(p) ? `${p[0]}-${p[1]}` : String(p)).join(', ') }));
    return () => {
      offUpdate?.();
      offError?.();
      offToggle?.();
      offAHK?.();
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
        it.port?.toString() ?? '',
        it.pid?.toString() ?? '',
        it.processName ?? '',
        it.command ?? '',
        it.framework ?? '',
        it.url ?? ''
      ]
        .join(' ')
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
        it.pid?.toString() ?? '',
        it.processName ?? '',
        it.scriptPath ?? '',
        it.scriptName ?? ''
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [ahkItems, ahkHidden, query]);

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, Item[]>>((acc, cur) => {
      const f = cur.framework ?? 'Other';
      acc[f] = acc[f] || [];
      acc[f].push(cur);
      return acc;
    }, {});
  }, [filtered]);

  const showTabs = ahkItems.length > 0;

  return (
    <div className="h-screen w-screen bg-night text-gray-900 select-none">
      <TitleBar
        onRefresh={() => window.api.refresh()}
        onSettings={() => setOpenSettings(true)}
        search={query}
        onSearchChange={setQuery}
      />

      <div className="px-6 py-5 overflow-auto h-[calc(100vh-48px)]">
        {error && (
          <div className="bg-mimi_pink-700/30 text-mimi_pink-200 border border-mimi_pink-400/40 px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

        {/* Tabs - only show when AHK scripts are detected */}
        {showTabs && (
          <div className="flex items-center gap-1 mb-5">
            <TabButton
              active={activeTab === 'servers'}
              onClick={() => setActiveTab('servers')}
              count={filtered.length}
            >
              Servers
            </TabButton>
            <TabButton
              active={activeTab === 'ahk'}
              onClick={() => setActiveTab('ahk')}
              count={filteredAHK.length}
            >
              AHK Scripts
            </TabButton>
          </div>
        )}

        {/* Server Tab Content */}
        {activeTab === 'servers' && (
          <>
            {Object.keys(grouped).length === 0 && (
              <div className="text-gray-600 text-center mt-20">
                No servers detected yet. Start a dev server and it will show up here.
              </div>
            )}

            <div className="grid gap-y-6 gap-x-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
              {(Object.entries(grouped) as [string, Item[]][]).map(([framework, list]) => (
                <div key={framework} className="space-y-5">
                  <div className="text-gray-700 uppercase tracking-wider text-xs mb-2">{framework}</div>
                  {list.map((it) => (
                    <ServerCard
                      key={it.key}
                      item={it}
                      onOptimisticKill={(key) => {
                        setHidden((h) => ({ ...h, [key]: Date.now() }));
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        {/* AHK Tab Content */}
        {activeTab === 'ahk' && (
          <>
            {filteredAHK.length === 0 && (
              <div className="text-gray-600 text-center mt-20">
                No AutoHotkey scripts detected. Start an AHK script and it will show up here.
              </div>
            )}

            <div className="grid gap-y-5 gap-x-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
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
        ${active
          ? 'bg-night-700 text-night-100 shadow-md'
          : 'bg-gray-200/60 text-gray-700 hover:bg-gray-300/80 hover:text-gray-900'
        }
      `}
    >
      <span className="flex items-center gap-2">
        {children}
        {typeof count === 'number' && (
          <span
            className={`
              inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold rounded-full
              ${active
                ? 'bg-night-500/50 text-night-100'
                : 'bg-gray-400/30 text-gray-600'
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
