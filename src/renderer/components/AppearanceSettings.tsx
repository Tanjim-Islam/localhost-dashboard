import React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  FONT_PRESETS,
  getFontPreset,
  getPalettesByMode,
  getThemePalette,
  type FontPreset,
  type FontPresetId,
  type RegisteredThemePalette,
  type ThemeMode,
  type ThemeModePreference,
  type ThemePaletteId,
} from "../theme/themeRegistry";
import { useThemePreferences } from "../theme/ThemeProvider";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./ui/select";

const MODE_OPTIONS: Array<{
  id: ThemeModePreference;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
];

export default function AppearanceSettings() {
  const { preferences, resolvedMode, updatePreferences } =
    useThemePreferences();

  return (
    <section className="settings-section p-3.5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-gray-900">Appearance</div>
          <p className="mt-0.5 text-[11px] leading-4 text-gray-600">
            Comfortable colors and type, saved only on this device.
          </p>
        </div>
        <span className="rounded-full border border-gray-300 bg-gray-100/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-600">
          {resolvedMode}
        </span>
      </div>

      <div className="rounded-[16px] border border-gray-300 bg-gray-100/55 p-1.5">
        <div className="grid grid-cols-3 gap-1.5">
          {MODE_OPTIONS.map(({ id, label, icon: Icon }) => {
            const selected = preferences.mode === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => updatePreferences({ mode: id })}
                className={`flex h-8 items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-night-700/25 ${
                  selected
                    ? "border-night-700 bg-night-700 text-night-100 shadow-soft"
                    : "border-transparent bg-transparent text-gray-600 hover:border-gray-300 hover:bg-gray-200/70 hover:text-gray-900"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <PaletteSelect
          label="Light palette"
          mode="light"
          selectedId={preferences.lightPalette}
          active={resolvedMode === "light"}
          onSelect={(lightPalette) => updatePreferences({ lightPalette })}
        />
        <PaletteSelect
          label="Dark palette"
          mode="dark"
          selectedId={preferences.darkPalette}
          active={resolvedMode === "dark"}
          onSelect={(darkPalette) => updatePreferences({ darkPalette })}
        />
      </div>

      <div className="mt-3">
        <FontSelect
          selectedId={preferences.font}
          onSelect={(font) => updatePreferences({ font })}
        />
      </div>
    </section>
  );
}

function PaletteSelect({
  label,
  mode,
  selectedId,
  active,
  onSelect,
}: {
  label: string;
  mode: ThemeMode;
  selectedId: ThemePaletteId;
  active: boolean;
  onSelect: (id: ThemePaletteId) => void;
}) {
  const palettes = getPalettesByMode(mode);
  const selectedPalette = getThemePalette(selectedId, mode);
  const triggerId = `appearance-${mode}-palette`;

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
        <label
          htmlFor={triggerId}
          className="flex items-center gap-1.5 text-xs font-semibold text-gray-800"
        >
          {mode === "light" ? (
            <Sun className="h-3.5 w-3.5" />
          ) : (
            <Moon className="h-3.5 w-3.5" />
          )}
          {label}
        </label>
        {active && (
          <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-gray-600">
            Active
          </span>
        )}
      </div>
      <Select
        value={selectedId}
        onValueChange={(value) => onSelect(value as ThemePaletteId)}
      >
        <SelectTrigger id={triggerId} aria-label={label}>
          <PaletteSummary palette={selectedPalette} />
        </SelectTrigger>
        <SelectContent aria-label={`${label} options`}>
          {palettes.map((palette) => (
            <SelectItem key={palette.id} value={palette.id}>
              <PaletteSummary palette={palette} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function FontSelect({
  selectedId,
  onSelect,
}: {
  selectedId: FontPresetId;
  onSelect: (id: FontPresetId) => void;
}) {
  const selectedPreset = getFontPreset(selectedId);

  return (
    <div>
      <label
        htmlFor="appearance-font-preset"
        className="mb-1.5 block px-0.5 text-xs font-semibold text-gray-800"
      >
        Font preset
      </label>
      <Select
        value={selectedId}
        onValueChange={(value) => onSelect(value as FontPresetId)}
      >
        <SelectTrigger id="appearance-font-preset" aria-label="Font preset">
          <FontSummary preset={selectedPreset} />
        </SelectTrigger>
        <SelectContent aria-label="Font preset options">
          {FONT_PRESETS.map((preset) => (
            <SelectItem
              key={preset.id}
              value={preset.id}
              style={{ fontFamily: preset.cssStack }}
            >
              <FontSummary preset={preset} />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PaletteSummary({ palette }: { palette: RegisteredThemePalette }) {
  const swatches = Object.values(palette.rawColors).slice(0, 5);

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 -space-x-1" aria-hidden="true">
        {swatches.map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="h-4 w-4 rounded-full border border-black/10"
            style={{ backgroundColor: color, zIndex: swatches.length - index }}
          />
        ))}
      </span>
      <span className="truncate font-medium">{palette.name}</span>
    </span>
  );
}

function FontSummary({ preset }: { preset: FontPreset }) {
  return (
    <span
      className="flex min-w-0 items-baseline gap-2"
      style={{ fontFamily: preset.cssStack }}
    >
      <span className="truncate font-semibold">{preset.name}</span>
      <span className="truncate text-[10px] text-gray-600">
        {preset.family}
      </span>
    </span>
  );
}
