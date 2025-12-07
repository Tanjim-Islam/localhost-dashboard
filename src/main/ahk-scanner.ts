import si from 'systeminformation';
import pidusage from 'pidusage';
import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { settings } from './settings';

const execAsync = promisify(exec);

export type AHKScriptInfo = {
  key: string; // pid
  pid: number;
  processName: string;
  scriptPath?: string;
  scriptName?: string;
  firstSeen: number;
  lastSeen: number;
  cpu?: number;
  memory?: number;
};

export class AHKScanner extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private items = new Map<string, AHKScriptInfo>();

  start() {
    const interval = settings.get('scanIntervalMs');
    this.stop();
    this.scan();
    this.timer = setInterval(() => this.scan(), interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan() {
    try {
      const now = Date.now();
      const ahkProcesses = await getAHKProcesses();

      const keys = new Set<string>();
      for (const proc of ahkProcesses) {
        const key = String(proc.pid);
        keys.add(key);
        let rec = this.items.get(key);
        if (!rec) {
          rec = {
            key,
            pid: proc.pid,
            processName: proc.name,
            scriptPath: proc.scriptPath,
            scriptName: proc.scriptName,
            firstSeen: now,
            lastSeen: now,
          };
          this.items.set(key, rec);
          this.emit('new', rec);
        } else {
          rec.lastSeen = now;
          // Update script info in case it changed
          rec.scriptPath = proc.scriptPath;
          rec.scriptName = proc.scriptName;
        }
      }

      // Remove stale entries
      for (const [key, rec] of this.items) {
        if (!keys.has(key) && now - rec.lastSeen > settings.get('scanIntervalMs') * 2) {
          this.items.delete(key);
          this.emit('stopped', rec);
        }
      }

      // Enrich with CPU/memory usage
      for (const rec of this.items.values()) {
        try {
          const usage = await pidusage(rec.pid);
          rec.cpu = usage.cpu;
          rec.memory = usage.memory;
        } catch {
          // Process may have exited
        }
      }

      const payload = Array.from(this.items.values()).sort((a, b) => 
        (a.scriptName || '').localeCompare(b.scriptName || '')
      );
      this.emit('update', payload);
    } catch (err) {
      this.emit('error', err);
    }
  }

  getItems(): AHKScriptInfo[] {
    return Array.from(this.items.values());
  }
}

type AHKProcess = {
  pid: number;
  name: string;
  scriptPath?: string;
  scriptName?: string;
  command?: string;
};

async function getAHKProcesses(): Promise<AHKProcess[]> {
  const results: AHKProcess[] = [];

  if (process.platform !== 'win32') {
    return results; // AHK is Windows-only
  }

  try {
    // Get all processes
    const procData = await si.processes();
    const ahkProcs = procData.list.filter((p) => {
      const name = (p.name || '').toLowerCase();
      return name.includes('autohotkey') || name.includes('ahk');
    });

    for (const proc of ahkProcs) {
      const ahkProcess: AHKProcess = {
        pid: proc.pid,
        name: proc.name,
        command: proc.command,
      };

      // Try to get the script path from command line
      // AutoHotkey command typically looks like: "C:\...\AutoHotkey.exe" "C:\...\script.ahk"
      if (proc.command) {
        const scriptPath = extractAHKScriptPath(proc.command);
        if (scriptPath) {
          ahkProcess.scriptPath = scriptPath;
          ahkProcess.scriptName = extractFileName(scriptPath);
        }
      }

      // If we couldn't get it from command, try WMIC
      if (!ahkProcess.scriptPath) {
        try {
          const scriptPath = await getScriptPathViaWMIC(proc.pid);
          if (scriptPath) {
            ahkProcess.scriptPath = scriptPath;
            ahkProcess.scriptName = extractFileName(scriptPath);
          }
        } catch {
          // ignore
        }
      }

      results.push(ahkProcess);
    }
  } catch (err) {
    console.error('Error scanning AHK processes:', err);
  }

  return results;
}

function extractAHKScriptPath(command: string): string | undefined {
  // Match paths ending in .ahk
  // Handle both quoted and unquoted paths
  const patterns = [
    /"([^"]+\.ahk)"/i, // Quoted path
    /'([^']+\.ahk)'/i, // Single-quoted path
    /\s([A-Z]:\\[^\s]+\.ahk)/i, // Unquoted Windows path
    /\s(\/[^\s]+\.ahk)/i, // Unix-style path (unlikely for AHK but just in case)
  ];

  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // If the whole command looks like a path to a script
  if (command.toLowerCase().endsWith('.ahk')) {
    return command.replace(/^["']|["']$/g, '');
  }

  return undefined;
}

function extractFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

async function getScriptPathViaWMIC(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(
      `wmic process where processid=${pid} get commandline /format:list`
    );
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('CommandLine=')) {
        const cmd = line.substring('CommandLine='.length);
        return extractAHKScriptPath(cmd);
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

