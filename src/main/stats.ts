import Store from 'electron-store';

type Stats = {
  portCounts: Record<string, number>;
};

export const stats = new Store<Stats>({
  name: 'stats',
  fileExtension: 'json',
  defaults: { portCounts: {} }
});

export function bumpPort(port: number) {
  const key = String(port);
  const current = stats.get('portCounts')[key] ?? 0;
  stats.set(`portCounts.${key}`, current + 1);
}

