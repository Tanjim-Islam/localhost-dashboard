import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { applyThemePreferences } from "../src/renderer/theme/themeRuntime";
import { DEFAULT_THEME_PREFERENCES, THEME_REGISTRY } from "../src/renderer/theme/themeRegistry";
import config from "../tailwind.config";

type RGB = [number, number, number];
const colors = config.theme!.extend!.colors as Record<string, Record<string, string>>;
const defaults = new Map([...fs.readFileSync("src/renderer/styles.css", "utf8").matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

function resolvedColor(utility: string, variables: Map<string, string>): RGB {
  const channels = utility.match(/var\(--([\w-]+)\)/)?.[1];
  assert.ok(channels, `Missing CSS variable in ${utility}`);
  let value = variables.get(channels) ?? defaults.get(channels);
  for (let depth = 0; value?.startsWith("var(") && depth < 5; depth++) {
    const name = value.slice(6, -1);
    value = variables.get(name) ?? defaults.get(name);
  }
  assert.ok(value && /^\d+ \d+ \d+$/.test(value), `Unresolved status color: ${utility}`);
  return value.split(" ").map(Number) as RGB;
}

function fromHex(hex: string): RGB {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as RGB;
}

function contrast(a: RGB, b: RGB): number {
  const luminance = (rgb: RGB) => rgb.map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("switching through every palette preserves green success, red danger, and existing destructive aliases", () => {
  const variables = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty: (name: string, value: string) => variables.set(name.slice(2), value) } } } });
  const seen = new Map<string, RGB>();
  try {
    // Reverse order exercises light/dark transitions and revisiting old themes.
    for (const palette of [...THEME_REGISTRY, ...[...THEME_REGISTRY].reverse()]) {
      applyThemePreferences({ ...DEFAULT_THEME_PREFERENCES, mode: palette.mode, [palette.mode === "light" ? "lightPalette" : "darkPalette"]: palette.id }, palette.mode === "dark");
      for (const role of ["success", "danger"] as const) {
        const color = resolvedColor(colors[role].DEFAULT, variables);
        const [r, g, b] = color;
        assert.ok(role === "success" ? g > r && g > b : r > g && r > b, `${palette.name}: ${role} lost its hue`);
        const key = `${palette.mode}:${role}`;
        if (seen.has(key)) assert.deepEqual(color, seen.get(key), `${palette.name}: palette changed ${role}`);
        else seen.set(key, color);
        assert.ok(contrast(resolvedColor(colors[role].text, variables), resolvedColor(colors[role].surface, variables)) >= 4.5, `${palette.name}: ${role} notice contrast`);
        assert.ok(contrast(resolvedColor(colors[role].contrast, variables), color) >= 4.5, `${palette.name}: ${role} button contrast`);
        for (const surface of [palette.semanticTokens.background, palette.semanticTokens.card, palette.semanticTokens.muted]) {
          assert.ok(contrast(resolvedColor(colors[role].text, variables), fromHex(surface)) >= 4.5, `${palette.name}: ${role} inline text contrast`);
          assert.ok(contrast(resolvedColor(colors[role].icon, variables), fromHex(surface)) >= 3, `${palette.name}: ${role} icon contrast`);
        }
      }
      assert.deepEqual(resolvedColor(colors.mimi_pink[400], variables), resolvedColor(colors.danger.DEFAULT, variables));
      assert.deepEqual(resolvedColor(colors.mimi_pink[100], variables), resolvedColor(colors.danger.contrast, variables));
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
