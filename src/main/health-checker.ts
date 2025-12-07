import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

export type HealthStatus = {
  key: string; // server key (pid:port)
  url: string;
  status: 'healthy' | 'slow' | 'down';
  responseTime?: number; // ms
  lastChecked: number;
  error?: string;
};

// Thresholds
const SLOW_THRESHOLD_MS = 500;
const DOWN_THRESHOLD_MS = 2000;
const CHECK_TIMEOUT_MS = 3000;

export class HealthChecker extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private results = new Map<string, HealthStatus>();
  private servers: Array<{ key: string; url: string }> = [];
  private intervalMs = 5000;

  setServers(servers: Array<{ key: string; url: string }>) {
    this.servers = servers;
    // Clean up results for servers that no longer exist
    const validKeys = new Set(servers.map(s => s.key));
    for (const key of this.results.keys()) {
      if (!validKeys.has(key)) {
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

  private async checkServer(server: { key: string; url: string }): Promise<void> {
    const start = Date.now();
    
    try {
      const responseTime = await this.pingUrl(server.url);
      const status: HealthStatus['status'] = 
        responseTime < SLOW_THRESHOLD_MS ? 'healthy' :
        responseTime < DOWN_THRESHOLD_MS ? 'slow' : 'down';

      this.results.set(server.key, {
        key: server.key,
        url: server.url,
        status,
        responseTime,
        lastChecked: Date.now(),
      });
    } catch (err) {
      this.results.set(server.key, {
        key: server.key,
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
          hostname: parsedUrl.hostname,
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

