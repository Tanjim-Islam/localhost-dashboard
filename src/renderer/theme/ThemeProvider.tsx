import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DEFAULT_THEME_PREFERENCES,
  type ThemeMode,
  type ThemePreferences,
} from "./themeRegistry";
import {
  applyThemePreferences,
  readThemePreferences,
  writeThemePreferences,
} from "./themeRuntime";

type ThemeContextValue = {
  preferences: ThemePreferences;
  resolvedMode: ThemeMode;
  updatePreferences: (next: Partial<ThemePreferences>) => void;
  resetPreferences: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<ThemePreferences>(() =>
    readThemePreferences(),
  );
  const [resolvedMode, setResolvedMode] = useState<ThemeMode>(() =>
    applyThemePreferences(readThemePreferences()),
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      setResolvedMode(applyThemePreferences(preferences, media.matches));
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences]);

  const updatePreferences = useCallback((next: Partial<ThemePreferences>) => {
    setPreferences((current) => {
      const updated = { ...current, ...next };
      writeThemePreferences(updated);
      applyThemePreferences(updated);
      return updated;
    });
  }, []);

  const resetPreferences = useCallback(() => {
    writeThemePreferences(DEFAULT_THEME_PREFERENCES);
    applyThemePreferences(DEFAULT_THEME_PREFERENCES);
    setPreferences(DEFAULT_THEME_PREFERENCES);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preferences,
      resolvedMode,
      updatePreferences,
      resetPreferences,
    }),
    [preferences, resetPreferences, resolvedMode, updatePreferences],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useThemePreferences(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useThemePreferences must be used inside ThemeProvider");
  }
  return value;
}
