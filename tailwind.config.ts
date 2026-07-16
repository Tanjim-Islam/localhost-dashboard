import type { Config } from "tailwindcss";

const themed = (name: string): string =>
  `rgb(var(--${name}-rgb) / <alpha-value>)`;

const config: Config = {
  content: ["src/renderer/**/*.{html,tsx,ts}"],
  theme: {
    extend: {
      colors: {
        gray: {
          DEFAULT: themed("muted-foreground"),
          100: themed("card"),
          200: themed("muted"),
          300: themed("border"),
          400: themed("border-strong"),
          500: themed("muted-foreground"),
          600: themed("muted-foreground"),
          700: themed("muted-foreground"),
          800: themed("card-foreground"),
          900: themed("foreground"),
        },
        pale_dogwood: {
          DEFAULT: themed("highlight"),
          100: themed("accent-foreground"),
          200: themed("accent"),
          300: themed("highlight"),
          400: themed("highlight"),
          500: themed("highlight"),
          600: themed("highlight"),
          700: themed("highlight"),
          800: themed("card"),
          900: themed("foreground"),
        },
        celadon: {
          DEFAULT: themed("accent"),
          100: themed("accent-foreground"),
          200: themed("accent-foreground"),
          300: themed("highlight"),
          400: themed("accent"),
          500: themed("accent"),
          600: themed("primary"),
          700: themed("primary"),
          800: themed("primary"),
          900: themed("foreground"),
        },
        night: {
          DEFAULT: themed("background"),
          100: themed("primary-foreground"),
          200: themed("background"),
          300: themed("background"),
          400: themed("background"),
          500: themed("background"),
          600: themed("accent"),
          700: themed("primary"),
          800: themed("primary"),
          900: themed("foreground"),
        },
        mimi_pink: {
          DEFAULT: themed("danger"),
          100: themed("danger-foreground"),
          200: themed("danger-foreground"),
          300: themed("danger"),
          400: themed("danger"),
          500: themed("danger"),
          600: themed("danger"),
          700: themed("danger"),
          800: themed("danger"),
          900: themed("danger-foreground"),
        },
      },
      fontFamily: {
        sans: ["var(--font-ui)"],
        mono: [
          "Geist Mono Variable",
          "Geist Mono",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      boxShadow: {
        soft: "0 14px 44px rgb(var(--glow-rgb) / 0.08), 0 2px 10px rgb(0 0 0 / 0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
