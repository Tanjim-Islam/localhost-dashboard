import React, { useEffect, useState } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  settings: any;
  onSave: (next: any) => void | Promise<void>;
};

export default function SettingsPanel({ open, onClose, settings, onSave }: Props) {
  const [scanIntervalMs, setScanIntervalMs] = useState(5000);
  const [portsText, setPortsText] = useState('3000-3999, 8000, 8080, 5000, 4200, 5173-5199');
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [notifications, setNotifications] = useState(true);

  useEffect(() => {
    if (settings) {
      setScanIntervalMs(settings.scanIntervalMs ?? 5000);
      setPortsText(settings.portsText ?? portsToString(settings.ports || []));
      setStartAtLogin(Boolean(settings.startAtLogin));
      setNotifications(Boolean(settings.notifications));
    }
  }, [settings]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center" style={{ WebkitAppRegion: 'no-drag' as any }}>
      <div className="w-[560px] max-w-[95vw] bg-gray-100 text-gray-900 rounded-lg shadow-soft p-5">
        <div className="text-lg font-semibold mb-4">Settings</div>
        <div className="space-y-4">
          <label className="block">
            <div className="text-sm text-gray-700 mb-1">Scan interval (ms)</div>
            <input type="number" value={scanIntervalMs} onChange={(e) => setScanIntervalMs(parseInt(e.target.value || '0', 10))} className="w-full rounded bg-gray-200 px-3 py-2 outline-none focus:ring-2 ring-night-700" />
          </label>
          <label className="block">
            <div className="text-sm text-gray-700 mb-1">Ports (comma separated, allow ranges like 3000-3999)</div>
            <input value={portsText} onChange={(e) => setPortsText(e.target.value)} className="w-full rounded bg-gray-200 px-3 py-2 outline-none focus:ring-2 ring-night-700" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={startAtLogin} onChange={(e) => setStartAtLogin(e.target.checked)} />
            <span>Start at system login</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={notifications} onChange={(e) => setNotifications(e.target.checked)} />
            <span>Desktop notifications</span>
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 rounded-full bg-gray-200 hover:bg-gray-300">Cancel</button>
          <button
            onClick={() => onSave({ scanIntervalMs, portsText, startAtLogin, notifications })}
            className="px-3 py-1.5 rounded-full bg-night-700 text-night-100 hover:bg-night-800"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function portsToString(ports: (number | [number, number])[]) {
  return (ports || []).map((p) => (Array.isArray(p) ? `${p[0]}-${p[1]}` : String(p))).join(', ');
}
