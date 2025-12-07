import React from 'react';
import cx from 'classnames';
import dayjs from 'dayjs';

type ButtonState = 'idle' | 'active' | 'done';

export default function ServerCard({ item, onOptimisticKill }: { item: any; onOptimisticKill?: (key: string) => void }) {
  const uptime = dayjs(item.lastSeen).from(item.firstSeen, true);
  const cpu = item.cpu ? `${item.cpu.toFixed(1)}%` : '—';
  const mem = item.memory ? readableBytes(item.memory) : '—';

  const ref = React.useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = React.useState<null | 'left' | 'right'>(null);
  
  // Button states for animations
  const [openState, setOpenState] = React.useState<ButtonState>('idle');
  const [copyState, setCopyState] = React.useState<ButtonState>('idle');

  const open = () => {
    if (openState !== 'idle') return;
    setOpenState('active');
    window.api.openUrl(item.url);
    
    setTimeout(() => {
      setOpenState('done');
      setTimeout(() => setOpenState('idle'), 1500);
    }, 300);
  };

  const copy = () => {
    if (copyState !== 'idle') return;
    setCopyState('active');
    window.api.copyText(item.url);
    
    setTimeout(() => {
      setCopyState('done');
      setTimeout(() => setCopyState('idle'), 2000);
    }, 150);
  };

  const kill = () => {
    if (exiting) return;
    const rect = ref.current?.getBoundingClientRect();
    const centerX = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
    const dir = centerX < window.innerWidth / 2 ? 'left' : 'right';
    setExiting(dir);
    // Fire the actual kill immediately
    window.api.killPid(item.pid);
    // Hide after the animation begins so users see the motion
    window.setTimeout(() => onOptimisticKill?.(item.key), 260);
  };

  const [stats, setStats] = React.useState<any>(null);
  React.useEffect(() => {
    window.api.getStats().then(setStats);
    const off = window.api.onStatsUpdate(setStats);
    return () => off?.();
  }, []);

  const seenCount = stats?.portCounts?.[String(item.port)] ?? 0;

  return (
    <div
      ref={ref}
      className={cx(
        'rounded-xl border border-gray-300/40 bg-gray-100 p-4 shadow-soft transition-all duration-300 will-change-transform',
        exiting === 'left' && '-translate-x-[120%] opacity-0',
        exiting === 'right' && 'translate-x-[120%] opacity-0'
      )}
    >
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
      <div className="mt-4 flex items-center gap-4 justify-between">
        <div className="flex items-center gap-3">
          {/* Open Button */}
          <button
            onClick={open}
            disabled={openState !== 'idle'}
            className={cx(
              'h-12 px-5 rounded-full text-sm font-medium transition-all duration-200 transform',
              openState === 'idle' && 'bg-night-700 text-night-100 hover:bg-night-800 hover:scale-105 active:scale-95',
              openState === 'active' && 'bg-night-800 text-night-100 scale-95',
              openState === 'done' && 'bg-night-600 text-celadon-300 scale-100'
            )}
          >
            <span className="flex items-center gap-1.5">
              {openState === 'idle' && 'Open'}
              {openState === 'active' && (
                <>
                  <span className="inline-block w-3 h-3 border-2 border-night-100 border-t-transparent rounded-full animate-spin"></span>
                  Opening...
                </>
              )}
              {openState === 'done' && (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  Opened
                </>
              )}
            </span>
          </button>

          {/* Copy URL Button */}
          <button
            onClick={copy}
            disabled={copyState !== 'idle'}
            className={cx(
              'h-12 px-5 rounded-full text-sm font-medium transition-all duration-200 transform',
              copyState === 'idle' && 'bg-gray-200 text-gray-900 hover:bg-gray-300 hover:scale-105 active:scale-95',
              copyState === 'active' && 'bg-gray-300 text-gray-900 scale-110',
              copyState === 'done' && 'bg-celadon-400 text-white scale-100'
            )}
          >
            <span className="flex items-center gap-1.5 min-w-[72px] justify-center">
              {copyState === 'idle' && 'Copy URL'}
              {copyState === 'active' && (
                <span className="inline-block animate-ping">📋</span>
              )}
              {copyState === 'done' && (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied!
                </>
              )}
            </span>
          </button>
        </div>

        {/* Kill Button */}
        <button
          onClick={kill}
          className="h-12 px-5 rounded-full bg-mimi_pink-300 text-mimi_pink-100 hover:bg-mimi_pink-200 hover:scale-105 active:scale-95 transition-all duration-200 transform text-sm font-medium"
        >
          Kill
        </button>
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
