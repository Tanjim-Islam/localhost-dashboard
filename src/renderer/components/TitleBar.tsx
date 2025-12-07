import React from "react";

type Props = {
  onRefresh: () => void;
  onSettings: () => void;
  search: string;
  onSearchChange: (v: string) => void;
  version?: string;
};

export default function TitleBar({
  onRefresh,
  onSettings,
  search,
  onSearchChange,
  version,
}: Props) {
  const handleDoubleClick = (e: React.MouseEvent) => {
    const path = (e as any).nativeEvent?.composedPath?.() || [];
    const shouldIgnore = path.some((el: any) => {
      try {
        if (!el || !el.tagName) return false;
        if (el.dataset?.nodrag === "true") return true;
        const tag = String(el.tagName).toUpperCase();
        return tag === "INPUT" || tag === "BUTTON" || tag === "A" || tag === "TEXTAREA";
      } catch {
        return false;
      }
    });
    if (shouldIgnore) return;
    (window as any).windowControls?.maximize?.();
  };
  return (
    <div
      className="flex items-center h-12 bg-gray-100 text-gray-900 px-3 border-b border-gray-300 select-none"
      style={{ WebkitAppRegion: "drag" as any }}
      onDoubleClick={handleDoubleClick}
    >
      <div className="flex items-center gap-2 shrink-0">
        <div className="h-2.5 w-2.5 rounded-full bg-night-700"></div>
        <div className="font-semibold tracking-tight flex items-center gap-2">
          <span>Localhost Dashboard</span>
          {version && (
            <span className="px-2 py-0.5 rounded-full bg-gray-200 text-xs text-gray-700" style={{ WebkitAppRegion: "no-drag" as any }}>
              v{version}
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 flex justify-center px-3" style={{ WebkitAppRegion: "drag" as any }}>
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search ports, PID, names."
          className="w-[44vw] max-w-[560px] min-w-[220px] px-4 py-1.5 rounded-full bg-gray-200/80 text-gray-900 placeholder-gray-700/60 ring-1 ring-transparent focus:ring-night-700/40 outline-none transition-all duration-200 focus:bg-gray-200"
          style={{ WebkitAppRegion: "no-drag" as any }}
          data-nodrag="true"
        />
      </div>
      <div
        className="flex items-center gap-2 shrink-0"
        style={{ WebkitAppRegion: "no-drag" as any }}
        data-nodrag="true"
      >
        <button
          title="Refresh (Ctrl/Cmd+R)"
          onClick={onRefresh}
          className="px-3 py-1.5 text-sm rounded-full bg-gray-200/90 text-gray-900 ring-1 ring-transparent hover:bg-gray-300 hover:ring-gray-400/40 transition-colors duration-150"
        >
          Refresh
        </button>
        <button
          title="Settings (Ctrl/Cmd+,)"
          onClick={onSettings}
          className="px-3 py-1.5 text-sm rounded-full bg-gray-200/90 text-gray-900 ring-1 ring-transparent hover:bg-gray-300 hover:ring-gray-400/40 transition-colors duration-150"
        >
          Settings
        </button>
        <WinButtons />
      </div>
    </div>
  );
}

function WinButtons() {
  return (
    <div className="flex items-center ml-2">
      <button
        onClick={() => (window as any).windowControls?.minimize()}
        className="w-8 h-8 rounded-full text-gray-700 hover:text-gray-900 hover:bg-gray-300/50 transition-colors"
        style={{ WebkitAppRegion: "no-drag" as any }}
        aria-label="Minimize"
      >
        –
      </button>
      <button
        onClick={() => (window as any).windowControls?.maximize()}
        className="w-8 h-8 rounded-full text-gray-700 hover:text-night-100 hover:bg-celadon-400/60 transition-colors"
        style={{ WebkitAppRegion: "no-drag" as any }}
        aria-label="Maximize"
      >
        <span className="relative top-[-1px]">□</span>
      </button>
      <button
        onClick={() => (window as any).windowControls?.close()}
        className="w-8 h-8 rounded-full text-gray-700 hover:text-night-100 hover:bg-mimi_pink-400/80 transition-colors"
        style={{ WebkitAppRegion: "no-drag" as any }}
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );
}
