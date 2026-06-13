import React from 'react';
import cx from 'classnames';
import dayjs from 'dayjs';

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

type ButtonState = 'idle' | 'active' | 'done';

export default function AHKCard({
  item,
  onOptimisticKill,
}: {
  item: AHKItem;
  onOptimisticKill?: (key: string) => void;
}) {
  const uptime = dayjs(item.lastSeen).from(item.firstSeen, true);
  const cpu = item.cpu ? `${item.cpu.toFixed(1)}%` : '—';
  const mem = item.memory ? readableBytes(item.memory) : '—';

  const ref = React.useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = React.useState<null | 'left' | 'right'>(null);
  
  // Button states for animations
  const [copyState, setCopyState] = React.useState<ButtonState>('idle');
  const [restartState, setRestartState] = React.useState<ButtonState>('idle');
  const [editState, setEditState] = React.useState<ButtonState>('idle');

  const kill = () => {
    if (exiting) return;
    const rect = ref.current?.getBoundingClientRect();
    const centerX = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
    const dir = centerX < window.innerWidth / 2 ? 'left' : 'right';
    setExiting(dir);
    window.api.killAHK(item.pid);
    window.setTimeout(() => onOptimisticKill?.(item.key), 260);
  };

  const restart = async () => {
    if (!item.scriptPath || restartState !== 'idle') return;
    setRestartState('active');
    
    try {
      // Kill first, then restart after a brief delay
      window.api.killAHK(item.pid);
      await new Promise((r) => setTimeout(r, 500));
      await window.api.restartAHK(item.scriptPath);
      
      setRestartState('done');
      setTimeout(() => setRestartState('idle'), 2000);
    } catch {
      // Reset to idle on error so button can be clicked again
      setRestartState('idle');
    }
  };

  const edit = () => {
    if (!item.scriptPath || editState !== 'idle') return;
    setEditState('active');
    window.api.editAHK(item.scriptPath);
    
    setTimeout(() => {
      setEditState('done');
      setTimeout(() => setEditState('idle'), 1500);
    }, 300);
  };

  const openExplorer = () => {
    if (!item.scriptPath) return;
    window.api.openExplorer(item.scriptPath);
  };

  const copyPath = () => {
    if (!item.scriptPath || copyState !== 'idle') return;
    setCopyState('active');
    window.api.copyText(item.scriptPath);
    
    setTimeout(() => {
      setCopyState('done');
      setTimeout(() => setCopyState('idle'), 2000);
    }, 150);
  };

  return (
    <div
      ref={ref}
      className={cx(
        'rounded-xl border border-pale_dogwood-400/40 bg-gray-100 p-4 shadow-soft transition-all duration-300 will-change-transform',
        exiting === 'left' && '-translate-x-[120%] opacity-0',
        exiting === 'right' && 'translate-x-[120%] opacity-0'
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full bg-celadon-400 animate-pulse"></div>
          <div className="text-lg font-semibold text-night-900 truncate max-w-[260px]" title={item.scriptName || item.processName}>
            {item.scriptName || item.processName}
          </div>
        </div>
        <div className="text-xs text-gray-600">PID {item.pid}</div>
      </div>
      
      {item.scriptPath && (
        <div
          className="text-xs text-gray-600 mt-1.5 truncate cursor-pointer hover:text-gray-800 transition-colors"
          title={item.scriptPath}
          onClick={copyPath}
        >
          📁 {item.scriptPath}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-700 mt-3">
        <span>CPU {cpu}</span>
        <span className="opacity-50">•</span>
        <span>MEM {mem}</span>
        <span className="opacity-50">•</span>
        <span>Up {uptime}</span>
      </div>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        {item.scriptPath && (
          <>
            {/* Edit Button */}
            <button
              onClick={edit}
              disabled={editState !== 'idle'}
              className={cx(
                'h-10 px-4 rounded-full text-sm font-medium transition-all duration-200 transform',
                editState === 'idle' && 'bg-night-700 text-night-100 hover:bg-night-800 hover:scale-105 active:scale-95',
                editState === 'active' && 'bg-night-800 text-night-100 scale-95',
                editState === 'done' && 'bg-night-600 text-celadon-300 scale-100'
              )}
            >
              <span className="flex items-center gap-1.5">
                {editState === 'idle' && 'Edit'}
                {editState === 'active' && (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-night-100 border-t-transparent rounded-full animate-spin"></span>
                    Opening...
                  </>
                )}
                {editState === 'done' && (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Opened
                  </>
                )}
              </span>
            </button>

            {/* Open in Explorer Button */}
            <button
              onClick={openExplorer}
              className="h-10 px-4 rounded-full bg-gray-200 text-gray-900 hover:bg-gray-300 hover:scale-105 active:scale-95 transition-all duration-200 transform text-sm font-medium"
            >
              <span className="flex items-center gap-1.5">
                <FolderIcon />
                Explorer
              </span>
            </button>

            {/* Restart Button */}
            <button
              onClick={restart}
              disabled={restartState !== 'idle'}
              className={cx(
                'h-10 px-4 rounded-full text-sm font-medium transition-all duration-200 transform',
                restartState === 'idle' && 'bg-celadon-400/80 text-night-900 hover:bg-celadon-400 hover:scale-105 active:scale-95',
                restartState === 'active' && 'bg-celadon-500 text-night-900 scale-95 animate-pulse',
                restartState === 'done' && 'bg-celadon-500 text-white scale-100'
              )}
            >
              <span className="flex items-center gap-1.5">
                {restartState === 'idle' && 'Restart'}
                {restartState === 'active' && (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-night-900 border-t-transparent rounded-full animate-spin"></span>
                    Restarting...
                  </>
                )}
                {restartState === 'done' && (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Restarted!
                  </>
                )}
              </span>
            </button>
          </>
        )}

        {/* Copy Path Button */}
        <button
          onClick={copyPath}
          disabled={!item.scriptPath || copyState !== 'idle'}
          className={cx(
            'h-10 px-4 rounded-full text-sm font-medium transition-all duration-200 transform',
            copyState === 'idle' && 'bg-gray-200 text-gray-900 hover:bg-gray-300 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100',
            copyState === 'active' && 'bg-gray-300 text-gray-900 scale-110',
            copyState === 'done' && 'bg-celadon-400 text-white scale-100'
          )}
        >
          <span className="flex items-center gap-1.5 min-w-[80px] justify-center">
            {copyState === 'idle' && 'Copy Path'}
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

        {/* Kill Button */}
        <button
          onClick={kill}
          className="h-10 px-4 rounded-full bg-mimi_pink-300 text-mimi_pink-100 hover:bg-mimi_pink-200 hover:scale-105 active:scale-95 transition-all duration-200 transform text-sm font-medium ml-auto"
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

function FolderIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
      />
    </svg>
  );
}
