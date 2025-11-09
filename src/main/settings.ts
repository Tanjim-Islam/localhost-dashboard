import Store from 'electron-store';
import fs from 'node:fs';
import path from 'node:path';

// Resolve a path to the packaged/unpacked default settings JSON.
function resolveDefaultSettingsPath(): string | null {
  const candidates = [
    // Packaged: files under resources/ are copied to process.resourcesPath
    path.join(process.resourcesPath || '', 'default-settings.json'),
    // Unpacked dev: relative to source tree
    path.join(__dirname, '../../resources/default-settings.json'),
    // Fallback to CWD resources
    path.join(process.cwd(), 'resources', 'default-settings.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // continue
    }
  }
  return null;
}

function readDefaultSettingsFromFile(): Partial<AppSettings> | null {
  const p = resolveDefaultSettingsPath();
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const json = JSON.parse(raw);
    // Basic shape guard; we only accept known keys.
    const out: Partial<AppSettings> = {};
    if (typeof json.scanIntervalMs === 'number') out.scanIntervalMs = json.scanIntervalMs;
    if (Array.isArray(json.ports)) out.ports = json.ports as any;
    if (typeof json.startAtLogin === 'boolean') out.startAtLogin = json.startAtLogin;
    if (typeof json.notifyOnStart === 'boolean') out.notifyOnStart = json.notifyOnStart;
    if (typeof json.notifyOnStop === 'boolean') out.notifyOnStop = json.notifyOnStop;
    if (typeof json.scanAllPorts === 'boolean') out.scanAllPorts = json.scanAllPorts;
    if (typeof json.closeToTray === 'boolean') out.closeToTray = json.closeToTray;
    return out;
  } catch {
    return null;
  }
}

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
  // Close behavior: if true, window close hides to tray; if false, quits app
  closeToTray: boolean;
};

const schema = {
  scanIntervalMs: { type: 'number', default: 5000 },
  ports: { type: 'array', default: [3000, 3001, 3002, [5173, 5199], 8000, 8080, 5000, 4200] },
  startAtLogin: { type: 'boolean', default: false },
  notifyOnStart: { type: 'boolean', default: true },
  notifyOnStop: { type: 'boolean', default: true },
  notifications: { type: 'boolean', default: undefined },
  closeToTray: { type: 'boolean', default: true }
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
    scanAllPorts: false,
    closeToTray: true
  }
});

// One-time migration: if legacy `notifications` exists, copy to both new toggles.
export function migrateLegacyNotifications() {
  try {
    // use has() instead of get to distinguish undefined from false
    const hasLegacy = (settings as any).has?.('notifications');
    const already = (settings as any).get?.('__legacyNotificationsMigrated');
    if (!hasLegacy || already) return;
    const val = settings.get('notifications' as any) as unknown as boolean;
    if (typeof val === 'boolean') {
      settings.set('notifyOnStart', val);
      settings.set('notifyOnStop', val);
    }
    // Ensure this migration does not run again and remove legacy key.
    (settings as any).delete?.('notifications');
    (settings as any).set?.('__legacyNotificationsMigrated', true);
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

// First-run seeding from resources/default-settings.json (if present).
// We intentionally perform this on app start from main/index.ts to keep this
// module side-effect free on import.
export function seedDefaultsIfNeeded(): { seeded: boolean; path?: string } {
  try {
    const storePath: string | undefined = (settings as any).path;
    const exists = storePath ? fs.existsSync(storePath) : false;
    if (exists) return { seeded: false };
    const fromFile = readDefaultSettingsFromFile();
    if (!fromFile) return { seeded: false };
    if (typeof fromFile.scanIntervalMs === 'number') settings.set('scanIntervalMs', fromFile.scanIntervalMs);
    if (Array.isArray(fromFile.ports)) settings.set('ports', fromFile.ports as any);
    if (typeof fromFile.startAtLogin === 'boolean') settings.set('startAtLogin', fromFile.startAtLogin);
    if (typeof fromFile.notifyOnStart === 'boolean') settings.set('notifyOnStart', fromFile.notifyOnStart);
    if (typeof fromFile.notifyOnStop === 'boolean') settings.set('notifyOnStop', fromFile.notifyOnStop);
    if (typeof fromFile.scanAllPorts === 'boolean') settings.set('scanAllPorts', fromFile.scanAllPorts);
    if (typeof fromFile.closeToTray === 'boolean') settings.set('closeToTray', fromFile.closeToTray);
    (settings as any).set?.('__seededAt', Date.now());
    return { seeded: true, path: resolveDefaultSettingsPath() || undefined };
  } catch {
    return { seeded: false };
  }
}

// Reset the store back to the JSON defaults (or code defaults if file missing).
export function resetToDefaults(): AppSettings {
  const json = readDefaultSettingsFromFile();
  try {
    // Clear existing keys to remove unknown/legacy ones.
    (settings as any).clear?.();
  } catch {
    // ignore if clear not available
  }
  // Apply JSON or fallback to in-code defaults
  const next: AppSettings = {
    scanIntervalMs: (json?.scanIntervalMs ?? 5000) as number,
    ports: (json?.ports ?? [3000, 3001, 3002, [5173, 5199], 8000, 8080, 5000, 4200]) as any,
    startAtLogin: (json?.startAtLogin ?? false) as boolean,
    notifyOnStart: (json?.notifyOnStart ?? true) as boolean,
    notifyOnStop: (json?.notifyOnStop ?? true) as boolean,
    scanAllPorts: (json?.scanAllPorts ?? false) as boolean,
    closeToTray: (json?.closeToTray ?? true) as boolean,
    notifications: undefined
  } satisfies AppSettings;
  settings.set('scanIntervalMs', next.scanIntervalMs);
  settings.set('ports', next.ports);
  settings.set('startAtLogin', next.startAtLogin);
  settings.set('notifyOnStart', next.notifyOnStart);
  settings.set('notifyOnStop', next.notifyOnStop);
  settings.set('scanAllPorts', next.scanAllPorts);
  settings.set('closeToTray', next.closeToTray);
  return next;
}
