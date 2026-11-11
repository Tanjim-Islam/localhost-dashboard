import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

export type HealthStatus = {
  firstSeen?: number;
  key: string; // server key (pid:port)
  url: string;
  status: 'healthy' | 'slow' | 'down';
  responseTime?: number; // ms
  httpStatus?: number;
  endpoint?: 'http' | 'websocket' | 'upgrade';
  lastChecked: number;
  error?: string;
};

// Thresholds
const SLOW_THRESHOLD_MS = 500;
const CHECK_TIMEOUT_MS = 3000;

export class HealthChecker extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private results = new Map<string, HealthStatus>();
  private servers = new Map<string, { key: string; url: string; firstSeen?: number }>();
  private intervalMs = 5000;

  setServers(servers: Array<{ key: string; url: string; firstSeen?: number }>) {
    this.servers = new Map(servers.map(server => [server.key, server]));
    // Clean up results for servers that no longer exist
    for (const key of this.results.keys()) {
      const server = this.servers.get(key);
      const result = this.results.get(key);
      if (!server || result?.firstSeen !== server.firstSeen || result?.url !== server.url) {
        this.results.delete(key);
      }
    }
  }

  setInterval(ms: number) {
    this.intervalMs = ms;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  start() {
    this.stop();
    this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getResults(): HealthStatus[] {
    return Array.from(this.results.values());
  }

  private checkAll(): Promise<void> {
    return (this.inFlight ??= this.checkOnce().finally(() => {
      this.inFlight = undefined;
    }));
  }

  private async checkOnce(): Promise<void> {
    const checks = Array.from(this.servers.values(), s => this.checkServer(s));
    await Promise.allSettled(checks);
    this.emit('update', this.getResults());
  }

  private async checkServer(server: { key: string; url: string; firstSeen?: number }): Promise<void> {
    
    try {
      const response = await this.pingUrl(server.url);
      const { responseTime } = response;
      if (!this.isCurrent(server)) return;
      const status: HealthStatus['status'] = 
        responseTime < SLOW_THRESHOLD_MS ? 'healthy' : 'slow';

      this.results.set(server.key, {
        key: server.key,
        firstSeen: server.firstSeen,
        url: server.url,
        status,
        responseTime,
        httpStatus: response.httpStatus,
        endpoint: response.endpoint,
        lastChecked: Date.now(),
      });
    } catch (err) {
      if (!this.isCurrent(server)) return;
      this.results.set(server.key, {
        key: server.key,
        firstSeen: server.firstSeen,
        url: server.url,
        status: 'down',
        lastChecked: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private isCurrent(server: { key: string; url: string; firstSeen?: number }): boolean {
    const current = this.servers.get(server.key);
    return current?.firstSeen === server.firstSeen && current?.url === server.url;
  }

  private pingUrl(url: string) {
    return pingUrl(url, CHECK_TIMEOUT_MS);
  }
}

// True for a plain HTTP response, false when the port replies with another
// protocol or refuses. A timeout is unknown: cold dev servers can be slow.
export async function probeHttp(url: string, timeoutMs = 3000): Promise<boolean | undefined> {
  try {
    return (await pingUrl(url, timeoutMs)).endpoint === 'http';
  } catch (error) {
    return error instanceof Error && error.message === 'Timeout' ? undefined : false;
  }
}

function pingUrl(url: string, timeoutMs: number): Promise<{ responseTime: number; httpStatus?: number; endpoint: 'http' | 'websocket' | 'upgrade' }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(
      {
        hostname: parsedUrl.hostname.replace(/^\[|\]$/g, ''),
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname || '/',
        method: 'HEAD',
        timeout: timeoutMs,
      },
      (res) => {
        res.destroy();
        const upgrade = String(res.headers.upgrade || '').toLowerCase();
        resolve({ responseTime: Date.now() - start, httpStatus: res.statusCode, endpoint: upgrade === 'websocket' ? 'websocket' : res.statusCode === 426 ? 'upgrade' : 'http' });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}
