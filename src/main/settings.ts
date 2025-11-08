import Store from 'electron-store';

export type AppSettings = {
  scanIntervalMs: number;
  ports: (number | [number, number])[]; // numbers and inclusive ranges
  startAtLogin: boolean;
  notifications: boolean;
};

const schema = {
  scanIntervalMs: { type: 'number', default: 5000 },
  ports: { type: 'array', default: [3000, 3001, 3002, [5173, 5199], 8000, 8080, 5000, 4200] },
  startAtLogin: { type: 'boolean', default: false },
  notifications: { type: 'boolean', default: true }
} as const;

export const settings = new Store<AppSettings>({
  name: 'settings',
  fileExtension: 'json',
  defaults: {
    scanIntervalMs: 5000,
    ports: [3000, 3001, 3002, [5173, 5199], 8000, 8080, 5000, 4200],
    startAtLogin: false,
    notifications: true
  }
});

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

