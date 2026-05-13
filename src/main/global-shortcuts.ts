import { EventEmitter } from "node:events";
import { globalShortcut } from "electron";
import Store from "electron-store";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { AHKScanner } from "./ahk-scanner";

const execAsync = promisify(exec);

// =============================================================================
// Types
// =============================================================================

export type ShortcutSourceType =
  | "this-app"
  | "windows-reserved"
  | "lnk"
  | "ahk"
  | "cache"
  | "probe";

export type ShortcutStatus =
  | "active"
  | "taken"
  | "available"
  | "previously-seen"
  | "now-free"
  | "reserved"
  | "used-by-app"
  | "unknown-owner"
  | "invalid";

export type ShortcutRecord = {
  shortcut: string; // "Ctrl + Shift + K"
  accelerator: string; // normalized electron accelerator e.g. "CommandOrControl+Shift+K"
  sourceType: ShortcutSourceType;
  sourceName?: string;
  sourcePath?: string;
  status: ShortcutStatus;
  firstSeen: number;
  lastSeen: number;
  lastChecked: number;
  ownerKnown: boolean;
  confidence: "low" | "medium" | "high";
};

export type ShortcutCheckResult = {
  shortcut: string;
  accelerator: string;
  status: ShortcutStatus;
  source?: {
    type: ShortcutSourceType;
    name?: string;
    path?: string;
  };
  reason?: string;
};

export type RecommendationEntry = {
  shortcut: string;
  accelerator: string;
  reason: string;
  previouslySeen: boolean;
  includesWin: boolean;
};

// =============================================================================
// Constants
// =============================================================================

// Default refresh: 1 hour. Switch to 30 * 60 * 1000 if needed.
export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const HALF_HOUR_REFRESH_MS = 30 * 60 * 1000;

// Resolve refresh interval: env override (test/manual), then default 1h.
export function getRefreshIntervalMs(): number {
  const env = process.env["GLOBAL_SHORTCUTS_REFRESH"];
  if (env === "30m") return HALF_HOUR_REFRESH_MS;
  return DEFAULT_REFRESH_INTERVAL_MS;
}

// Common Windows-reserved/system shortcuts. Owner is the OS/shell.
const WINDOWS_RESERVED: Array<{ accelerator: string; name: string }> = [
  { accelerator: "Super+D", name: "Show Desktop" },
  { accelerator: "Super+E", name: "File Explorer" },
  { accelerator: "Super+L", name: "Lock Workstation" },
  { accelerator: "Super+R", name: "Run Dialog" },
  { accelerator: "Super+I", name: "Settings" },
  { accelerator: "Super+X", name: "Quick Link Menu" },
  { accelerator: "Super+Tab", name: "Task View" },
  { accelerator: "Alt+Tab", name: "Switch Apps" },
  { accelerator: "Ctrl+Alt+Delete", name: "Security Options" },
  { accelerator: "Super+Space", name: "Switch Keyboard Layout" },
  { accelerator: "Super+S", name: "Search" },
  { accelerator: "Super+A", name: "Action Center" },
  { accelerator: "Super+Up", name: "Maximize Window" },
  { accelerator: "Super+Down", name: "Minimize Window" },
  { accelerator: "Super+Left", name: "Snap Left" },
  { accelerator: "Super+Right", name: "Snap Right" },
  { accelerator: "Super+Shift+S", name: "Snipping Tool" },
  { accelerator: "Super+V", name: "Clipboard History" },
  { accelerator: "Super+;", name: "Emoji Panel" },
  { accelerator: "Super+.", name: "Emoji Panel" },
  { accelerator: "Super+P", name: "Project / Display Mode" },
  { accelerator: "Super+G", name: "Game Bar" },
  { accelerator: "Super+M", name: "Minimize All" },
  { accelerator: "F12", name: "DevTools (in browsers)" },
];

// Common app shortcuts that should not be recommended (not reserved, just risky)
const RISKY_COMMON_KEYS = new Set(["C", "V", "S", "A", "F", "X", "Z", "Y"]);

// =============================================================================
// Accelerator helpers
// =============================================================================

const MOD_DISPLAY: Record<string, string> = {
  CommandOrControl: "Ctrl",
  CmdOrCtrl: "Ctrl",
  Control: "Ctrl",
  Ctrl: "Ctrl",
  Cmd: "Cmd",
  Command: "Cmd",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
  Super: "Win",
  Meta: "Win",
  Win: "Win",
};

const MOD_ELECTRON: Record<string, string> = {
  Ctrl: "CommandOrControl",
  Control: "CommandOrControl",
  CommandOrControl: "CommandOrControl",
  CmdOrCtrl: "CommandOrControl",
  Cmd: "Command",
  Command: "Command",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
  Win: "Super",
  Meta: "Super",
  Super: "Super",
};

const MODIFIER_NAMES = new Set(Object.keys(MOD_ELECTRON));

const MOD_ORDER = ["CommandOrControl", "Alt", "Shift", "Super"];

export function isModifierName(name: string): boolean {
  return MODIFIER_NAMES.has(name);
}

// Normalize a list of key parts into a stable Electron accelerator.
export function normalizeAccelerator(parts: string[]): string | null {
  if (!parts.length) return null;
  const cleaned = parts.map((p) => p.trim()).filter(Boolean);
  if (cleaned.length < 2 || cleaned.length > 4) return null;

  const finalKey = cleaned[cleaned.length - 1];
  if (MODIFIER_NAMES.has(finalKey)) return null;

  const modsRaw = cleaned.slice(0, -1);
  const mods: string[] = [];
  for (const m of modsRaw) {
    const mapped = MOD_ELECTRON[m];
    if (!mapped) return null;
    if (mods.includes(mapped)) continue;
    mods.push(mapped);
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));

  const key = normalizeFinalKey(finalKey);
  if (!key) return null;

  return [...mods, key].join("+");
}

function normalizeFinalKey(raw: string): string | null {
  const k = raw.trim();
  if (!k) return null;
  if (k.length === 1) {
    const c = k.toUpperCase();
    if (/[A-Z0-9]/.test(c)) return c;
    // Punctuation passthrough — Electron accepts certain characters directly.
    return k;
  }
  if (/^F([1-9]|1\d|2[0-4])$/i.test(k)) {
    return "F" + k.substring(1);
  }
  // Named keys map (input -> Electron-friendly)
  const NAMED: Record<string, string> = {
    Space: "Space",
    Tab: "Tab",
    Enter: "Return",
    Return: "Return",
    Escape: "Escape",
    Esc: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Del: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Up: "Up",
    Down: "Down",
    Left: "Left",
    Right: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    PrintScreen: "PrintScreen",
    NumLock: "Numlock",
    ScrollLock: "Scrolllock",
    CapsLock: "Capslock",
  };
  if (NAMED[k]) return NAMED[k];
  // Try title case
  const t = k[0].toUpperCase() + k.slice(1).toLowerCase();
  if (NAMED[t]) return NAMED[t];
  return null;
}

// "CommandOrControl+Shift+K" -> "Ctrl + Shift + K"
export function acceleratorToDisplay(accelerator: string): string {
  return acceleratorToParts(accelerator).join(" + ");
}

export function acceleratorToParts(accelerator: string): string[] {
  return accelerator
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => MOD_DISPLAY[p] ?? p);
}

// =============================================================================
// Source: this app's own global shortcuts
// =============================================================================

// Tracks the accelerators the app itself registers (so we never probe them).
const ownShortcuts = new Map<string, string>(); // accelerator -> friendly label

export function registerOwnShortcut(accelerator: string, label: string) {
  if (!accelerator) return;
  const normalized = normalizeAccelerator(acceleratorToParts(accelerator));
  ownShortcuts.set(normalized || accelerator, label);
}

export function clearOwnShortcut(accelerator: string) {
  const normalized = normalizeAccelerator(acceleratorToParts(accelerator));
  ownShortcuts.delete(normalized || accelerator);
}

export function getOwnShortcuts(): ReadonlyMap<string, string> {
  return ownShortcuts;
}

// =============================================================================
// Source: .lnk hotkeys via PowerShell + WScript.Shell
// =============================================================================

type LnkHotkey = {
  accelerator: string;
  name: string;
  path: string;
};

async function scanLnkHotkeys(): Promise<LnkHotkey[]> {
  if (process.platform !== "win32") return [];
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu')
)
$results = @()
foreach ($dir in $dirs) {
  if ([string]::IsNullOrEmpty($dir)) { continue }
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  try {
    Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $sc = $shell.CreateShortcut($_.FullName)
        if (-not [string]::IsNullOrEmpty($sc.Hotkey)) {
          $results += [PSCustomObject]@{
            Path = $_.FullName
            Name = $_.BaseName
            Hotkey = $sc.Hotkey
          }
        }
      } catch {}
    }
  } catch {}
}
$results | ConvertTo-Json -Compress
`.trim();

  try {
    // Use -EncodedCommand to avoid quoting headaches between cmd/PowerShell
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const { stdout } = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const out: LnkHotkey[] = [];
    for (const item of list) {
      if (!item?.Hotkey) continue;
      const accel = lnkHotkeyToAccelerator(String(item.Hotkey));
      if (!accel) continue;
      out.push({
        accelerator: accel,
        name: String(item.Name || "Shortcut"),
        path: String(item.Path || ""),
      });
    }
    return out;
  } catch (err) {
    console.warn("scanLnkHotkeys failed:", err);
    return [];
  }
}

// "Ctrl+Shift+K" or "Alt+F1" -> normalized accelerator
function lnkHotkeyToAccelerator(hk: string): string | null {
  const parts = hk
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const mapped = parts.map((p) => {
    const lc = p.toLowerCase();
    if (lc === "ctrl" || lc === "control") return "Ctrl";
    if (lc === "alt") return "Alt";
    if (lc === "shift") return "Shift";
    if (lc === "win" || lc === "meta" || lc === "super") return "Win";
    return p;
  });
  return normalizeAccelerator(mapped);
}

// =============================================================================
// Source: AHK script hotkey parsing
// =============================================================================

type AhkHotkey = {
  accelerator: string;
  scriptName: string;
  scriptPath: string;
};

const AHK_MOD_MAP: Record<string, string> = {
  "^": "Ctrl",
  "!": "Alt",
  "+": "Shift",
  "#": "Win",
};

// Parse one AHK hotkey definition line. Supports common syntax only.
function parseAhkLine(line: string): { mods: string[]; key: string } | null {
  // Strip comments at end (";" outside strings — naive)
  const commentIdx = line.indexOf(";");
  const body = (commentIdx >= 0 ? line.substring(0, commentIdx) : line).trim();
  if (!body || body.startsWith(";")) return null;

  // Must end with "::" (definition) — ignore "::abbrev::replacement" hotstrings
  if (!body.endsWith("::")) return null;
  if (body.startsWith("::")) return null; // hotstring

  let s = body.substring(0, body.length - 2).trim();
  if (!s) return null;

  // Strip leading prefixes: * ~ $ < > (modifier behavior, not the key itself)
  s = s.replace(/^[*~$<>]+/, "");
  if (!s) return null;

  // Reject combos with " & " (custom combo, uncommon — out of scope)
  if (s.includes("&")) return null;
  // Reject "Up"/"Down" suffix variants like "k Up" — out of scope
  if (/\s/.test(s)) return null;

  // Tokenize modifier prefix chars
  const mods: string[] = [];
  let i = 0;
  while (i < s.length && AHK_MOD_MAP[s[i]]) {
    const m = AHK_MOD_MAP[s[i]];
    if (!mods.includes(m)) mods.push(m);
    i++;
  }
  const keyPart = s.substring(i).trim();
  if (!keyPart) return null;
  if (mods.length === 0) return null; // skip modifier-less hotkeys

  // Normalize key part
  let key: string | null = null;
  if (/^[A-Za-z0-9]$/.test(keyPart)) {
    key = keyPart.toUpperCase();
  } else if (/^F([1-9]|1\d|2[0-4])$/i.test(keyPart)) {
    key = "F" + keyPart.substring(1);
  } else {
    // try named keys via normalizeFinalKey
    const norm = normalizeFinalKey(keyPart);
    if (norm) key = norm;
  }
  if (!key) return null;

  return { mods, key };
}

async function scanAhkHotkeys(scriptPaths: string[]): Promise<AhkHotkey[]> {
  const out: AhkHotkey[] = [];
  for (const p of scriptPaths) {
    if (!p) continue;
    try {
      const content = await fs.promises.readFile(p, "utf-8").catch(() => "");
      if (!content) continue;
      const scriptName = path.basename(p);
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const parsed = parseAhkLine(line);
        if (!parsed) continue;
        const accel = normalizeAccelerator([...parsed.mods, parsed.key]);
        if (!accel) continue;
        out.push({ accelerator: accel, scriptName, scriptPath: p });
      }
    } catch {
      // ignore unreadable
    }
  }
  return out;
}

// =============================================================================
// Probe: try to register a shortcut to see if it's free
// =============================================================================

export type ProbeResult = "available" | "taken" | "invalid";

export function probeShortcut(accelerator: string): ProbeResult {
  if (!accelerator) return "invalid";
  if (ownShortcuts.has(accelerator)) return "taken";
  // If already registered (by us elsewhere), treat as taken without touching it
  try {
    if (globalShortcut.isRegistered(accelerator)) return "taken";
  } catch {
    return "invalid";
  }
  try {
    const ok = globalShortcut.register(accelerator, () => {
      // no-op probe callback
    });
    if (ok) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        // ignore
      }
      return "available";
    }
    return "taken";
  } catch {
    return "invalid";
  }
}

// =============================================================================
// Cache store
// =============================================================================

type CacheShape = { records: Record<string, ShortcutRecord> };

const cacheStore = new Store<CacheShape>({
  name: "global-shortcuts",
  fileExtension: "json",
  defaults: { records: {} },
});

function loadCache(): Record<string, ShortcutRecord> {
  return { ...cacheStore.get("records") };
}

function saveCache(records: Record<string, ShortcutRecord>) {
  cacheStore.set("records", records);
}

// =============================================================================
// Recommendation engine
// =============================================================================

const RECOMMEND_FINAL_KEYS = [
  // Letters
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  // Digits
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  // Function keys
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  // Navigation/named
  "Up",
  "Down",
  "Left",
  "Right",
  "Space",
  "Return",
  "Tab",
  "Escape",
  "Backspace",
  "Insert",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

const MOD_COMBOS_2: string[][] = [["Ctrl"], ["Alt"], ["Shift"], ["Win"]];
const MOD_COMBOS_3: string[][] = [
  ["Ctrl", "Alt"],
  ["Ctrl", "Shift"],
  ["Alt", "Shift"],
  ["Ctrl", "Win"],
  ["Alt", "Win"],
  ["Shift", "Win"],
];
const MOD_COMBOS_4: string[][] = [
  ["Ctrl", "Alt", "Shift"],
  ["Ctrl", "Alt", "Win"],
  ["Ctrl", "Shift", "Win"],
  ["Alt", "Shift", "Win"],
];

function modCombosForCount(keyCount: number): string[][] {
  if (keyCount === 2) return MOD_COMBOS_2;
  if (keyCount === 3) return MOD_COMBOS_3;
  if (keyCount === 4) return MOD_COMBOS_4;
  return [];
}

// Score lower = better. Used for ranking recommendations.
function scoreCandidate(args: {
  mods: string[];
  key: string;
  previouslySeen: boolean;
}): number {
  let score = 0;
  const includesWin = args.mods.includes("Win");
  if (includesWin) score += 8;
  if (RISKY_COMMON_KEYS.has(args.key)) score += 6;

  const isLetter = /^[A-Z]$/.test(args.key);
  const isDigit = /^[0-9]$/.test(args.key);
  const isFn = /^F\d+$/.test(args.key);

  // Prefer ergonomic 3-key combos with letters or F-keys
  if (args.mods.length === 2) {
    const set = new Set(args.mods);
    if (set.has("Ctrl") && set.has("Alt") && (isLetter || isFn)) score -= 3;
    else if (set.has("Ctrl") && set.has("Shift") && (isLetter || isFn))
      score -= 2;
  }
  // Prefer 4-key Ctrl+Alt+Shift+Letter
  if (args.mods.length === 3 && !includesWin && (isLetter || isFn)) score -= 2;

  if (args.previouslySeen) score += 3; // rank lower than never-seen
  if (isFn) score -= 1; // F-keys are less likely to clash with text input
  if (isDigit) score += 1; // digits often used by app number-tabs
  return score;
}

function reasonForRecommendation(args: {
  mods: string[];
  key: string;
  previouslySeen: boolean;
}): string {
  const includesWin = args.mods.includes("Win");
  if (args.previouslySeen) return "Available, previously seen but now free";
  if (includesWin) return "Available, includes Win key";
  return "Available, low conflict";
}

// =============================================================================
// Scanner
// =============================================================================

export class GlobalShortcutsScanner extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private records = new Map<string, ShortcutRecord>();
  private ahkScanner?: AHKScanner;
  private isScanning = false;
  private lastScanAt = 0;

  constructor(ahkScanner?: AHKScanner) {
    super();
    this.ahkScanner = ahkScanner;
  }

  start() {
    this.stop();
    // Hydrate from cache so the UI has data immediately.
    const cached = loadCache();
    for (const r of Object.values(cached)) this.records.set(r.accelerator, r);

    if (process.platform !== "win32") {
      this.emit("update", this.snapshot());
      return;
    }
    // Initial async scan, then periodic refresh.
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, getRefreshIntervalMs());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): ShortcutRecord[] {
    return Array.from(this.records.values()).sort((a, b) =>
      a.shortcut.localeCompare(b.shortcut)
    );
  }

  /**
   * Re-scan all known sources, recheck cached entries, and update statuses.
   * Safe to call concurrently — collapses to a single in-flight scan.
   */
  async refresh(): Promise<ShortcutRecord[]> {
    if (this.isScanning) return this.snapshot();
    this.isScanning = true;
    try {
      const now = Date.now();

      // Seed with persisted cache so we keep historical records around.
      const cache = loadCache();
      const next = new Map<string, ShortcutRecord>();
      for (const rec of Object.values(cache)) {
        next.set(rec.accelerator, { ...rec });
      }

      // -- Source A: this app's own shortcuts
      for (const [accel, label] of ownShortcuts) {
        upsert(next, {
          accelerator: accel,
          shortcut: acceleratorToDisplay(accel),
          sourceType: "this-app",
          sourceName: label,
          status: "used-by-app",
          ownerKnown: true,
          confidence: "high",
          now,
        });
      }

      // -- Source B: Windows reserved
      for (const item of WINDOWS_RESERVED) {
        const accel =
          normalizeAccelerator(acceleratorToParts(item.accelerator)) ||
          item.accelerator;
        upsert(next, {
          accelerator: accel,
          shortcut: acceleratorToDisplay(accel),
          sourceType: "windows-reserved",
          sourceName: item.name,
          status: "reserved",
          ownerKnown: true,
          confidence: "high",
          now,
        });
      }

      // -- Source C: .lnk hotkeys
      const lnks = await scanLnkHotkeys();
      for (const l of lnks) {
        upsert(next, {
          accelerator: l.accelerator,
          shortcut: acceleratorToDisplay(l.accelerator),
          sourceType: "lnk",
          sourceName: l.name,
          sourcePath: l.path,
          status: "active",
          ownerKnown: true,
          confidence: "high",
          now,
        });
      }

      // -- Source D: AHK scripts (running)
      if (this.ahkScanner) {
        const scripts = this.ahkScanner.getItems();
        const paths = scripts
          .map((s) => s.scriptPath)
          .filter((p): p is string => Boolean(p));
        const ahkHotkeys = await scanAhkHotkeys(paths);
        for (const h of ahkHotkeys) {
          upsert(next, {
            accelerator: h.accelerator,
            shortcut: acceleratorToDisplay(h.accelerator),
            sourceType: "ahk",
            sourceName: h.scriptName,
            sourcePath: h.scriptPath,
            status: "active",
            ownerKnown: true,
            confidence: "high",
            now,
          });
        }
      }

      // -- Re-probe cached entries that didn't appear in any current source.
      // This refreshes statuses ("now-free", "previously-seen") without
      // brute-forcing the entire candidate space.
      const liveSources = new Set<ShortcutSourceType>([
        "this-app",
        "windows-reserved",
        "lnk",
        "ahk",
      ]);
      for (const rec of next.values()) {
        if (liveSources.has(rec.sourceType) && rec.lastSeen === now) continue;
        // Was previously seen in another source, but not present now → probe
        const probe = probeShortcut(rec.accelerator);
        rec.lastChecked = now;
        if (probe === "available") {
          rec.status = "now-free";
          rec.confidence = "medium";
        } else if (probe === "taken") {
          rec.status = "previously-seen";
          rec.confidence = "low";
          rec.ownerKnown = false;
        } else {
          rec.status = "invalid";
        }
      }

      // Persist & publish
      this.records = next;
      const obj: Record<string, ShortcutRecord> = {};
      for (const [k, v] of next) obj[k] = v;
      saveCache(obj);
      this.lastScanAt = now;
      this.emit("update", this.snapshot());
      return this.snapshot();
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Check the current status of a single shortcut. Used by the recorder UI.
   */
  check(accelerator: string): ShortcutCheckResult {
    const normalized =
      normalizeAccelerator(acceleratorToParts(accelerator)) || accelerator;
    const display = acceleratorToDisplay(normalized);

    // Check known sources first (cheaper and more informative)
    const own = ownShortcuts.get(normalized);
    if (own) {
      return {
        shortcut: display,
        accelerator: normalized,
        status: "used-by-app",
        source: { type: "this-app", name: own },
        reason: "Registered by Localhost Dashboard",
      };
    }

    const existing = this.records.get(normalized);
    if (existing) {
      // Refresh probe to ensure status is current
      const probe = probeShortcut(normalized);
      const baseSource = {
        type: existing.sourceType,
        name: existing.sourceName,
        path: existing.sourcePath,
      };
      if (existing.sourceType === "windows-reserved") {
        return {
          shortcut: display,
          accelerator: normalized,
          status: "reserved",
          source: baseSource,
          reason: existing.sourceName,
        };
      }
      if (probe === "available") {
        return {
          shortcut: display,
          accelerator: normalized,
          status: "now-free",
          source: baseSource,
          reason: `Previously used by ${existing.sourceName ?? "another app"}`,
        };
      }
      return {
        shortcut: display,
        accelerator: normalized,
        status: existing.ownerKnown ? "taken" : "unknown-owner",
        source: baseSource,
      };
    }

    const probe = probeShortcut(normalized);
    if (probe === "invalid") {
      return {
        shortcut: display,
        accelerator: normalized,
        status: "invalid",
        reason: "Electron rejected this accelerator",
      };
    }
    if (probe === "available") {
      return {
        shortcut: display,
        accelerator: normalized,
        status: "available",
      };
    }
    return {
      shortcut: display,
      accelerator: normalized,
      status: "unknown-owner",
      reason: "Some other process holds this shortcut",
    };
  }

  /**
   * Recommend up to 5 shortcuts for the requested key count (2-4).
   */
  recommend(keyCount: number): RecommendationEntry[] {
    if (keyCount < 2 || keyCount > 4) return [];
    if (process.platform !== "win32") return [];

    const combos = modCombosForCount(keyCount);
    if (!combos.length) return [];

    const cache = this.records;
    const recs: Array<RecommendationEntry & { score: number }> = [];

    for (const mods of combos) {
      for (const key of RECOMMEND_FINAL_KEYS) {
        const accel = normalizeAccelerator([...mods, key]);
        if (!accel) continue;

        // Skip if known to be unavailable
        if (ownShortcuts.has(accel)) continue;
        const cached = cache.get(accel);
        const previouslySeen = Boolean(cached);
        if (cached) {
          const blocked: ShortcutStatus[] = [
            "active",
            "used-by-app",
            "reserved",
            "taken",
            "previously-seen",
            "unknown-owner",
          ];
          if (blocked.includes(cached.status)) continue;
        }

        const probe = probeShortcut(accel);
        if (probe !== "available") continue;

        const score = scoreCandidate({ mods, key, previouslySeen });
        recs.push({
          shortcut: acceleratorToDisplay(accel),
          accelerator: accel,
          reason: reasonForRecommendation({ mods, key, previouslySeen }),
          previouslySeen,
          includesWin: mods.includes("Win"),
          score,
        });

        // Bound work: stop probing once we have a healthy buffer to rank.
        if (recs.length >= 60) break;
      }
      if (recs.length >= 60) break;
    }

    recs.sort((a, b) => a.score - b.score);
    return recs.slice(0, 5).map(({ score: _s, ...rest }) => rest);
  }
}
// =============================================================================
// Internal helpers
// =============================================================================

function upsert(
  map: Map<string, ShortcutRecord>,
  patch: {
    accelerator: string;
    shortcut: string;
    sourceType: ShortcutSourceType;
    sourceName?: string;
    sourcePath?: string;
    status: ShortcutStatus;
    ownerKnown: boolean;
    confidence: "low" | "medium" | "high";
    now: number;
  }
) {
  const existing = map.get(patch.accelerator);
  if (existing) {
    // Higher-confidence sources should win when multiple sources claim a key.
    const sourcePriority: Record<ShortcutSourceType, number> = {
      "this-app": 5,
      "windows-reserved": 4,
      lnk: 3,
      ahk: 3,
      probe: 2,
      cache: 1,
    };
    const newWins =
      sourcePriority[patch.sourceType] >= sourcePriority[existing.sourceType];
    map.set(patch.accelerator, {
      ...existing,
      lastSeen: patch.now,
      lastChecked: patch.now,
      ...(newWins
        ? {
            sourceType: patch.sourceType,
            sourceName: patch.sourceName,
            sourcePath: patch.sourcePath,
            status: patch.status,
            ownerKnown: patch.ownerKnown,
            confidence: patch.confidence,
          }
        : {}),
    });
    return;
  }
  map.set(patch.accelerator, {
    accelerator: patch.accelerator,
    shortcut: patch.shortcut,
    sourceType: patch.sourceType,
    sourceName: patch.sourceName,
    sourcePath: patch.sourcePath,
    status: patch.status,
    firstSeen: patch.now,
    lastSeen: patch.now,
    lastChecked: patch.now,
    ownerKnown: patch.ownerKnown,
    confidence: patch.confidence,
  });
}
