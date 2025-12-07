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
    if (!item.scriptPath) return;
    // Kill first, then restart after a brief delay
    window.api.killAHK(item.pid);
    await new Promise((r) => setTimeout(r, 500));
    await window.api.restartAHK(item.scriptPath);
  };

  const edit = () => {
    if (!item.scriptPath) return;
    window.api.editAHK(item.scriptPath);
  };

  const copyPath = () => {
    if (item.scriptPath) {
      window.api.copyText(item.scriptPath);
    }
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
            <button
              onClick={edit}
              className="h-10 px-4 rounded-full bg-night-700 text-night-100 hover:bg-night-800 transition text-sm font-medium"
            >
              Edit
            </button>
            <button
              onClick={restart}
              className="h-10 px-4 rounded-full bg-celadon-400/80 text-night-900 hover:bg-celadon-400 transition text-sm font-medium"
            >
              Restart
            </button>
          </>
        )}
        <button
          onClick={copyPath}
          disabled={!item.scriptPath}
          className="h-10 px-4 rounded-full bg-gray-200 text-gray-900 hover:bg-gray-300 transition text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Copy Path
        </button>
        <button
          onClick={kill}
          className="h-10 px-4 rounded-full bg-mimi_pink-300 text-mimi_pink-100 hover:bg-mimi_pink-200 transition text-sm font-medium ml-auto"
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

