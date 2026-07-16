export type ThemeMode = "light" | "dark";
export type ThemeModePreference = ThemeMode | "system";

export type SemanticThemeTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  border: string;
  borderStrong: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  highlight: string;
  glow: string;
  danger: string;
  dangerForeground: string;
};

export type ThemePalette = {
  id: string;
  name: string;
  mode: ThemeMode;
  rawColors: Record<string, string>;
  semanticTokens: SemanticThemeTokens;
};

export const THEME_REGISTRY = [
  {
    id: "soft-whispering-snow",
    name: "Soft Whispering Snow",
    mode: "light",
    rawColors: {
      "dust-grey": "#d1d1d1ff",
      "dust-grey-2": "#e1dbd6ff",
      "alabaster-grey": "#e2e2e2ff",
      parchment: "#f9f6f2ff",
      white: "#ffffffff",
    },
    semanticTokens: {
      background: "#f9f6f2ff",
      foreground: "#262421ff",
      card: "#ffffffff",
      cardForeground: "#262421ff",
      primary: "#4b4742ff",
      primaryForeground: "#ffffffff",
      border: "#d1d1d1ff",
      borderStrong: "#b8b4b0ff",
      muted: "#e2e2e2ff",
      mutedForeground: "#67615cff",
      accent: "#d1d1d1ff",
      accentForeground: "#262421ff",
      highlight: "#e1dbd6ff",
      glow: "#e1dbd6ff",
      danger: "#a64f4fff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "soft-whispering-breeze",
    name: "Soft Whispering Breeze",
    mode: "light",
    rawColors: {
      "dust-grey": "#d6ccc2ff",
      "dust-grey-2": "#ded6ceff",
      "dust-grey-3": "#e5ded8ff",
      parchment: "#eeeae6ff",
      "powder-petal": "#e3d5caff",
      linen: "#f5ebe0ff",
    },
    semanticTokens: {
      background: "#f5ebe0ff",
      foreground: "#2d2925ff",
      card: "#eeeae6ff",
      cardForeground: "#2d2925ff",
      primary: "#655b53ff",
      primaryForeground: "#ffffffff",
      border: "#d6ccc2ff",
      borderStrong: "#b8aa9dff",
      muted: "#e5ded8ff",
      mutedForeground: "#6d625aff",
      accent: "#d6ccc2ff",
      accentForeground: "#2d2925ff",
      highlight: "#e3d5caff",
      glow: "#e3d5caff",
      danger: "#a64f4fff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "blushing-marshmallow",
    name: "Blushing Marshmallow",
    mode: "light",
    rawColors: {
      "powder-blush": "#e4b1abff",
      "powder-blush-2": "#fbc3bcff",
      "soft-blush": "#fde1deff",
      "lavender-blush": "#fef0efff",
      white: "#ffffffff",
    },
    semanticTokens: {
      background: "#fef0efff",
      foreground: "#302525ff",
      card: "#ffffffff",
      cardForeground: "#302525ff",
      primary: "#8a4f4aff",
      primaryForeground: "#ffffffff",
      border: "#e4b1abff",
      borderStrong: "#c88780ff",
      muted: "#fde1deff",
      mutedForeground: "#765c59ff",
      accent: "#e4b1abff",
      accentForeground: "#302525ff",
      highlight: "#fbc3bcff",
      glow: "#fbc3bcff",
      danger: "#9f3f3fff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "whispering-ivory-shores",
    name: "Whispering Ivory Shores",
    mode: "light",
    rawColors: {
      parchment: "#f6f2f0ff",
      seashell: "#f3e7e4ff",
      "almond-silk": "#e7d1c9ff",
      linen: "#f1e7ddff",
      "desert-sand": "#d0b49fff",
    },
    semanticTokens: {
      background: "#f6f2f0ff",
      foreground: "#302923ff",
      card: "#fffaf7ff",
      cardForeground: "#302923ff",
      primary: "#725f50ff",
      primaryForeground: "#ffffffff",
      border: "#e7d1c9ff",
      borderStrong: "#d0b49fff",
      muted: "#f1e7ddff",
      mutedForeground: "#74665cff",
      accent: "#d0b49fff",
      accentForeground: "#302923ff",
      highlight: "#f3e7e4ff",
      glow: "#e7d1c9ff",
      danger: "#a44f4fff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "delicate-pastel-hues",
    name: "Delicate Pastel Hues",
    mode: "light",
    rawColors: {
      "powder-blush": "#e8a598ff",
      "powder-blush-2": "#ffb5a7ff",
      "powder-blush-3": "#fec5bbff",
      "almond-silk": "#fcd5ceff",
      "soft-blush": "#fae1ddff",
      seashell: "#f8edebff",
      "powder-petal": "#f9e5d8ff",
      "powder-petal-2": "#f9dcc4ff",
      "soft-apricot": "#fcd2afff",
      "peach-glow": "#fec89aff",
    },
    semanticTokens: {
      background: "#f8edebff",
      foreground: "#342622ff",
      card: "#fff8f5ff",
      cardForeground: "#342622ff",
      primary: "#8b4e43ff",
      primaryForeground: "#ffffffff",
      border: "#fcd5ceff",
      borderStrong: "#e8a598ff",
      muted: "#fae1ddff",
      mutedForeground: "#7a5d56ff",
      accent: "#e8a598ff",
      accentForeground: "#342622ff",
      highlight: "#f9dcc4ff",
      glow: "#fec89aff",
      danger: "#9f3f3fff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "dark-monochrome-essentials",
    name: "Dark Monochrome Essentials",
    mode: "dark",
    rawColors: {
      graphite: "#383838ff",
      "graphite-2": "#353535ff",
      "graphite-3": "#323232ff",
      "graphite-4": "#2c2c2cff",
      "shadow-grey": "#272727ff",
      "carbon-black": "#252525ff",
      "carbon-black-2": "#232323ff",
      "carbon-black-3": "#1f1f1fff",
      onyx: "#121212ff",
    },
    semanticTokens: {
      background: "#121212ff",
      foreground: "#f3f1efff",
      card: "#1f1f1fff",
      cardForeground: "#f3f1efff",
      primary: "#383838ff",
      primaryForeground: "#ffffffff",
      border: "#323232ff",
      borderStrong: "#454545ff",
      muted: "#272727ff",
      mutedForeground: "#b8b5b2ff",
      accent: "#353535ff",
      accentForeground: "#ffffffff",
      highlight: "#2c2c2cff",
      glow: "#383838ff",
      danger: "#9f4f55ff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "dark-grey-jungle",
    name: "Dark Grey Jungle",
    mode: "dark",
    rawColors: {
      "dim-grey": "#696969ff",
      charcoal: "#4f4f4fff",
      graphite: "#333333ff",
      "carbon-black": "#252525ff",
      onyx: "#0a0a0aff",
      evergreen: "#033933ff",
      "pine-teal": "#024c42ff",
      "blue-spruce": "#017365ff",
      "blue-spruce-2": "#1e776dff",
    },
    semanticTokens: {
      background: "#0a0a0aff",
      foreground: "#f1f5f3ff",
      card: "#252525ff",
      cardForeground: "#f1f5f3ff",
      primary: "#017365ff",
      primaryForeground: "#ffffffff",
      border: "#333333ff",
      borderStrong: "#4f4f4fff",
      muted: "#2b3432ff",
      mutedForeground: "#b7c2beff",
      accent: "#1e776dff",
      accentForeground: "#ffffffff",
      highlight: "#033933ff",
      glow: "#017365ff",
      danger: "#a45057ff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "classic-black-palette",
    name: "Classic Black Palette",
    mode: "dark",
    rawColors: {
      onyx: "#121212ff",
      "carbon-black": "#171717ff",
      "carbon-black-2": "#1c1c1cff",
      "carbon-black-3": "#212121ff",
      "carbon-black-4": "#262626ff",
      graphite: "#2b2b2bff",
      "graphite-2": "#303030ff",
      "graphite-3": "#363636ff",
      gunmetal: "#3b3b3bff",
      "gunmetal-2": "#404040ff",
    },
    semanticTokens: {
      background: "#121212ff",
      foreground: "#f4f2efff",
      card: "#1c1c1cff",
      cardForeground: "#f4f2efff",
      primary: "#404040ff",
      primaryForeground: "#ffffffff",
      border: "#303030ff",
      borderStrong: "#404040ff",
      muted: "#262626ff",
      mutedForeground: "#bbb7b2ff",
      accent: "#363636ff",
      accentForeground: "#ffffffff",
      highlight: "#2b2b2bff",
      glow: "#404040ff",
      danger: "#a14f55ff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "shady-forest-frenzy",
    name: "Shady Forest Frenzy",
    mode: "dark",
    rawColors: {
      "dark-emerald": "#066839ff",
      "emerald-depths": "#0a5c36ff",
      "emerald-depths-2": "#0f5132ff",
      "deep-forest": "#14452fff",
      evergreen: "#18392bff",
      "jet-black": "#1d2e28ff",
      "carbon-black": "#212224ff",
    },
    semanticTokens: {
      background: "#111a16ff",
      foreground: "#f0f6f2ff",
      card: "#1d2e28ff",
      cardForeground: "#f0f6f2ff",
      primary: "#0a5c36ff",
      primaryForeground: "#ffffffff",
      border: "#2d463bff",
      borderStrong: "#3d5c4fff",
      muted: "#18392bff",
      mutedForeground: "#b5c5bcff",
      accent: "#066839ff",
      accentForeground: "#ffffffff",
      highlight: "#14452fff",
      glow: "#066839ff",
      danger: "#a34f55ff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "earthy-tones-story",
    name: "Earthy Tones Story",
    mode: "dark",
    rawColors: {
      ebony: "#5f6556ff",
      graphite: "#433f3eff",
      "graphite-2": "#292825ff",
      evergreen: "#1b2413ff",
      black: "#080809ff",
    },
    semanticTokens: {
      background: "#080809ff",
      foreground: "#f2f0eaff",
      card: "#292825ff",
      cardForeground: "#f2f0eaff",
      primary: "#5f6556ff",
      primaryForeground: "#ffffffff",
      border: "#433f3eff",
      borderStrong: "#5f6556ff",
      muted: "#272b22ff",
      mutedForeground: "#c0c1b7ff",
      accent: "#4f5942ff",
      accentForeground: "#ffffffff",
      highlight: "#1b2413ff",
      glow: "#5f6556ff",
      danger: "#a55252ff",
      dangerForeground: "#ffffffff",
    },
  },
  {
    id: "legacy",
    name: "Legacy",
    mode: "dark",
    rawColors: {
      "gray-100": "#181819ff",
      "gray-200": "#2f3033ff",
      "gray-300": "#47484cff",
      "gray-900": "#e3e4e6ff",
      "pale-dogwood": "#ffd9ceff",
      celadon: "#b4ceb3ff",
      "celadon-400": "#84af83ff",
      night: "#01110aff",
      "night-700": "#0ccc79ff",
      "mimi-pink": "#fad4d8ff",
    },
    semanticTokens: {
      background: "#01110aff",
      foreground: "#e3e4e6ff",
      card: "#181819ff",
      cardForeground: "#e3e4e6ff",
      primary: "#0ccc79ff",
      primaryForeground: "#01110aff",
      border: "#47484cff",
      borderStrong: "#5e5f66ff",
      muted: "#2f3033ff",
      mutedForeground: "#acadb3ff",
      accent: "#84af83ff",
      accentForeground: "#01110aff",
      highlight: "#ffd9ceff",
      glow: "#0ccc79ff",
      danger: "#9f3f49ff",
      dangerForeground: "#fff7f5ff",
    },
  },
] as const satisfies readonly ThemePalette[];

export type ThemePaletteId = (typeof THEME_REGISTRY)[number]["id"];
export type RegisteredThemePalette = (typeof THEME_REGISTRY)[number];

export type FontPreset = {
  id: string;
  name: string;
  family: string;
  cssStack: string;
};

export const FONT_PRESETS = [
  {
    id: "calm-professional",
    name: "Calm Professional",
    family: "Inter",
    cssStack: '"Inter Variable", "Inter", system-ui, sans-serif',
  },
  {
    id: "warm-bangla",
    name: "Warm Bangla",
    family: "Noto Sans Bengali",
    cssStack: '"Noto Sans Bengali Variable", "Noto Sans Bengali", sans-serif',
  },
  {
    id: "modern-minimal",
    name: "Modern Minimal",
    family: "Manrope",
    cssStack: '"Manrope Variable", "Manrope", system-ui, sans-serif',
  },
  {
    id: "soft-product",
    name: "Soft Product",
    family: "Plus Jakarta Sans",
    cssStack:
      '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, sans-serif',
  },
  {
    id: "technical-admin",
    name: "Technical Admin",
    family: "Geist Mono",
    cssStack: '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
  },
] as const satisfies readonly FontPreset[];

export type FontPresetId = (typeof FONT_PRESETS)[number]["id"];

export const DEFAULT_LIGHT_PALETTE_ID: ThemePaletteId =
  "whispering-ivory-shores";
export const DEFAULT_DARK_PALETTE_ID: ThemePaletteId = "classic-black-palette";
export const DEFAULT_FONT_PRESET_ID: FontPresetId = "calm-professional";

export const THEME_STORAGE_KEYS = {
  mode: "dashboard:themeMode",
  lightPalette: "dashboard:lightPalette",
  darkPalette: "dashboard:darkPalette",
  font: "dashboard:fontPreset",
} as const;

export type ThemePreferences = {
  mode: ThemeModePreference;
  lightPalette: ThemePaletteId;
  darkPalette: ThemePaletteId;
  font: FontPresetId;
};

export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  mode: "system",
  lightPalette: DEFAULT_LIGHT_PALETTE_ID,
  darkPalette: DEFAULT_DARK_PALETTE_ID,
  font: DEFAULT_FONT_PRESET_ID,
};

export function getPalettesByMode(
  mode: ThemeMode,
): readonly RegisteredThemePalette[] {
  return THEME_REGISTRY.filter((palette) => palette.mode === mode);
}

export function getThemePalette(
  id: string,
  mode: ThemeMode,
): RegisteredThemePalette {
  return (THEME_REGISTRY.find(
    (palette) => palette.id === id && palette.mode === mode,
  ) ??
    THEME_REGISTRY.find((palette) =>
      mode === "light"
        ? palette.id === DEFAULT_LIGHT_PALETTE_ID
        : palette.id === DEFAULT_DARK_PALETTE_ID,
    )!) as RegisteredThemePalette;
}

export function getFontPreset(id: string): FontPreset {
  return FONT_PRESETS.find((preset) => preset.id === id) ?? FONT_PRESETS[0];
}

export function isThemePaletteForMode(
  id: string | null,
  mode: ThemeMode,
): id is ThemePaletteId {
  return THEME_REGISTRY.some(
    (palette) => palette.id === id && palette.mode === mode,
  );
}

export function isFontPreset(id: string | null): id is FontPresetId {
  return FONT_PRESETS.some((preset) => preset.id === id);
}
