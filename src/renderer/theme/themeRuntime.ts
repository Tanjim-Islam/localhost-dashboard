import {
  DEFAULT_THEME_PREFERENCES,
  THEME_STORAGE_KEYS,
  type ThemeMode,
  type ThemeModePreference,
  type ThemePreferences,
  getFontPreset,
  getThemePalette,
  isFontPreset,
  isThemePaletteForMode,
} from "./themeRegistry";

const LEGACY_THEME_STORAGE_KEYS = [
  "dashboard:compactMode",
  "dashboard:animatedBackground",
] as const;

export function readThemePreferences(): ThemePreferences {
  LEGACY_THEME_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  const storedMode = localStorage.getItem(THEME_STORAGE_KEYS.mode);
  const mode: ThemeModePreference =
    storedMode === "light" || storedMode === "dark" || storedMode === "system"
      ? storedMode
      : DEFAULT_THEME_PREFERENCES.mode;
  const storedLightPalette = localStorage.getItem(
    THEME_STORAGE_KEYS.lightPalette,
  );
  const storedDarkPalette = localStorage.getItem(
    THEME_STORAGE_KEYS.darkPalette,
  );
  const storedFont = localStorage.getItem(THEME_STORAGE_KEYS.font);

  return {
    mode,
    lightPalette: isThemePaletteForMode(storedLightPalette, "light")
      ? storedLightPalette
      : DEFAULT_THEME_PREFERENCES.lightPalette,
    darkPalette: isThemePaletteForMode(storedDarkPalette, "dark")
      ? storedDarkPalette
      : DEFAULT_THEME_PREFERENCES.darkPalette,
    font: isFontPreset(storedFont)
      ? storedFont
      : DEFAULT_THEME_PREFERENCES.font,
  };
}

export function resolveThemeMode(
  preference: ThemeModePreference,
  systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches,
): ThemeMode {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

function hexToRgbChannels(hex: string): string {
  const normalized = hex.replace("#", "").slice(0, 6);
  const value = Number.parseInt(normalized, 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

function setColorVariable(
  root: HTMLElement,
  name: string,
  value: string,
): void {
  root.style.setProperty(`--${name}`, value);
  root.style.setProperty(`--${name}-rgb`, hexToRgbChannels(value));
}

export function applyThemePreferences(
  preferences: ThemePreferences,
  systemPrefersDark?: boolean,
): ThemeMode {
  const resolvedMode = resolveThemeMode(preferences.mode, systemPrefersDark);
  const palette = getThemePalette(
    resolvedMode === "light"
      ? preferences.lightPalette
      : preferences.darkPalette,
    resolvedMode,
  );
  const font = getFontPreset(preferences.font);
  const root = document.documentElement;
  const tokens = palette.semanticTokens;

  Object.entries(tokens).forEach(([name, value]) => {
    const cssName = name.replace(
      /[A-Z]/g,
      (letter) => `-${letter.toLowerCase()}`,
    );
    setColorVariable(root, cssName, value);
  });

  root.dataset.theme = resolvedMode;
  root.dataset.themePreference = preferences.mode;
  root.dataset.palette = palette.id;
  root.dataset.font = font.id;
  root.style.setProperty("--font-ui", font.cssStack);
  root.style.colorScheme = resolvedMode;

  return resolvedMode;
}

export function writeThemePreferences(preferences: ThemePreferences): void {
  localStorage.setItem(THEME_STORAGE_KEYS.mode, preferences.mode);
  localStorage.setItem(
    THEME_STORAGE_KEYS.lightPalette,
    preferences.lightPalette,
  );
  localStorage.setItem(THEME_STORAGE_KEYS.darkPalette, preferences.darkPalette);
  localStorage.setItem(THEME_STORAGE_KEYS.font, preferences.font);
}

export function applyStoredThemePreferences(): ThemePreferences {
  const preferences = readThemePreferences();
  applyThemePreferences(preferences);
  return preferences;
}
