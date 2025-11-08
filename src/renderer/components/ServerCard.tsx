import React from 'react';
import dayjs from 'dayjs';

export default function ServerCard({ item }: { item: any }) {
  const uptime = dayjs(item.lastSeen).from(item.firstSeen, true);
  const cpu = item.cpu ? `${item.cpu.toFixed(1)}%` : '—';
  const mem = item.memory ? readableBytes(item.memory) : '—';

  const open = () => window.api.openUrl(item.url);
  const copy = () => window.api.copyText(item.url);
  const kill = () => window.api.killPid(item.pid);

  const [stats, setStats] = React.useState<any>(null);
  React.useEffect(() => {
    window.api.getStats().then(setStats);
    const off = window.api.onStatsUpdate(setStats);
    return () => off?.();
  }, []);

  const seenCount = stats?.portCounts?.[String(item.port)] ?? 0;

  return (
    <div className="rounded-xl border border-gray-300/40 bg-gray-100 p-4 shadow-soft hover:shadow transition">
      <div className="flex items-center justify-between">
        <div className="text-2xl font-mono text-night-900">:{item.port}</div>
        <div className="text-xs text-gray-600">PID {item.pid} • Seen {seenCount}x</div>
      </div>
      <div className="text-sm text-gray-700 mt-1 truncate" title={item.command || item.processName}>{item.processName || 'Process'}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700 mt-3">
        <span>CPU {cpu}</span>
        <span className="opacity-50">•</span>
        <span>MEM {mem}</span>
        <span className="opacity-50">•</span>
        <span>Up {uptime}</span>
      </div>
      <div className="mt-4 flex items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <button onClick={open} className="h-12 px-5 rounded-full bg-night-700 text-night-100 hover:bg-night-800 transition text-sm font-medium">Open</button>
          <button onClick={copy} className="h-12 px-5 rounded-full bg-gray-200 text-gray-900 hover:bg-gray-300 transition text-sm font-medium">Copy URL</button>
        </div>
        <button onClick={kill} className="h-12 px-5 rounded-full bg-mimi_pink-300 text-mimi_pink-100 hover:bg-mimi_pink-200 transition text-sm font-medium">Kill</button>
      </div>
    </div>
  );
}

function readableBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
