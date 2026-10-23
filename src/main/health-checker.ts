import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

export type HealthStatus = {
  firstSeen?: number;
  key: string; // server key (pid:port)
  url: string;
  status: 'healthy' | 'slow' | 'down';
  responseTime?: number; // ms
  lastChecked: number;
  error?: string;
};

// Thresholds
const SLOW_THRESHOLD_MS = 500;
const CHECK_TIMEOUT_MS = 3000;

export class HealthChecker extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private results = new Map<string, HealthStatus>();
  private servers: Array<{ key: string; url: string; firstSeen?: number }> = [];
  private intervalMs = 5000;

  setServers(servers: Array<{ key: string; url: string; firstSeen?: number }>) {
    this.servers = servers;
    // Clean up results for servers that no longer exist
    const validKeys = new Set(servers.map(s => s.key));
    for (const key of this.results.keys()) {
      if (!validKeys.has(key) || this.results.get(key)?.firstSeen !== servers.find(s => s.key === key)?.firstSeen) {
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

  private async checkAll() {
    const checks = this.servers.map(s => this.checkServer(s));
    await Promise.allSettled(checks);
    this.emit('update', this.getResults());
  }

  private async checkServer(server: { key: string; url: string; firstSeen?: number }): Promise<void> {
    
    try {
      const responseTime = await this.pingUrl(server.url);
      if (!this.servers.some(s => s.key === server.key && s.firstSeen === server.firstSeen)) return;
      const status: HealthStatus['status'] = 
        responseTime < SLOW_THRESHOLD_MS ? 'healthy' : 'slow';

      this.results.set(server.key, {
        key: server.key,
        firstSeen: server.firstSeen,
        url: server.url,
        status,
        responseTime,
        lastChecked: Date.now(),
      });
    } catch (err) {
      if (!this.servers.some(s => s.key === server.key && s.firstSeen === server.firstSeen)) return;
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

  private pingUrl(url: string): Promise<number> {
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
          timeout: CHECK_TIMEOUT_MS,
        },
        (res) => {
          res.destroy();
          resolve(Date.now() - start);
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
}

