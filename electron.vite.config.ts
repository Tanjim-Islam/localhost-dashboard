import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: "src/main/bootstrap.ts",
          app: "src/main/index.ts",
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
    },
  },
  preload: {
    input: {
      index: "src/preload/index.ts",
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: "dist",
    },
  },
});
