import Store from 'electron-store';

export type AppSettings = {
  scanIntervalMs: number;
  ports: (number | [number, number])[]; // numbers and inclusive ranges
  startAtLogin: boolean;
  // Per-event notification toggles
  notifyOnStart: boolean;
  notifyOnStop: boolean;
  // Legacy single toggle retained for migration only
  notifications?: boolean;
  // If true, ignore `ports` filter and include all TCP listeners
  scanAllPorts: boolean;
};

const schema = {
  scanIntervalMs: { type: 'number', default: 5000 },
  ports: { type: 'array', default: [3000, 3001, 3002, [5173, 5199], 8000, 8080, 5000, 4200] },
  startAtLogin: { type: 'boolean', default: false },
  notifyOnStart: { type: 'boolean', default: true },
  notifyOnStop: { type: 'boolean', default: true },
  notifications: { type: 'boolean', default: undefined }
} as const;

export const settings = new Store<AppSettings>({
  name: 'settings',
  fileExtension: 'json',
  defaults: {
    scanIntervalMs: 5000,
    ports: [3000, 3001, 3002, [5173, 5199], 8000, 8080, 5000, 4200],
    startAtLogin: false,
    notifyOnStart: true,
    notifyOnStop: true,
    scanAllPorts: false
  }
});

// One-time migration: if legacy `notifications` exists, copy to both new toggles.
export function migrateLegacyNotifications() {
  try {
    // use has() instead of get to distinguish undefined from false
    // @ts-expect-error store.has exists at runtime
    const hasLegacy = (settings as any).has?.('notifications');
    if (hasLegacy) {
      const val = settings.get('notifications' as any) as unknown as boolean;
      if (typeof val === 'boolean') {
        settings.set('notifyOnStart', val);
        settings.set('notifyOnStop', val);
        // Optionally delete the legacy key; safe to keep as it is ignored elsewhere.
      }
    }
  } catch {
    // ignore
  }
}

export function parsePorts(input: string): (number | [number, number])[] {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      if (token.includes('-')) {
        const [a, b] = token.split('-').map((n) => parseInt(n, 10));
        if (!Number.isFinite(a) || !Number.isFinite(b)) return [] as never;
        return [Math.min(a, b), Math.max(a, b)] as [number, number];
      }
      const n = parseInt(token, 10);
      if (!Number.isFinite(n)) return [] as never;
      return n;
    })
    .filter((x) => x !== (undefined as unknown));
}

export function portsToString(ports: (number | [number, number])[]): string {
  return ports
    .map((p) => (Array.isArray(p) ? `${p[0]}-${p[1]}` : String(p)))
    .join(', ');
}
