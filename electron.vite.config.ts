import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    entry: 'src/main/index.ts'
  },
  preload: {
    input: {
      index: 'src/preload/index.ts'
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: 'dist'
    }
  }
});

