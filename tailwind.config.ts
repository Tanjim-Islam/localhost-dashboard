import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['src/renderer/**/*.{html,tsx,ts}'],
  theme: {
    extend: {
      colors: {
        gray: { DEFAULT: '#757780', 100: '#181819', 200: '#2f3033', 300: '#47484c', 400: '#5e5f66', 500: '#757780', 600: '#919299', 700: '#acadb3', 800: '#c8c9cc', 900: '#e3e4e6' },
        pale_dogwood: { DEFAULT: '#ffd9ce', 100: '#5c1400', 200: '#b82800', 300: '#ff4714', 400: '#ff8f70', 500: '#ffd9ce', 600: '#ffdfd6', 700: '#ffe7e0', 800: '#ffefeb', 900: '#fff7f5' },
        celadon: { DEFAULT: '#b4ceb3', 100: '#1e2f1e', 200: '#3d5d3c', 300: '#5b8c5a', 400: '#84af83', 500: '#b4ceb3', 600: '#c2d7c1', 700: '#d1e1d0', 800: '#e0ebe0', 900: '#f0f5ef' },
        night: { DEFAULT: '#01110a', 100: '#000402', 200: '#000805', 300: '#010c07', 400: '#010f09', 500: '#01110a', 600: '#077042', 700: '#0ccc79', 800: '#46f4a9', 900: '#a2fad4' },
        mimi_pink: { DEFAULT: '#fad4d8', 100: '#530a11', 200: '#a61322', 300: '#e73042', 400: '#f0838e', 500: '#fad4d8', 600: '#fbdee1', 700: '#fce6e9', 800: '#fdeff0', 900: '#fef7f8' }
      },
      fontFamily: {
        sans: ['Geist Variable', 'Geist', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono Variable', 'Geist Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      },
      boxShadow: {
        soft: '0 8px 30px rgba(0,0,0,0.20)'
      }
    }
  },
  plugins: []
};

export default config;

