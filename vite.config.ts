/// <reference types="vitest" />
/// <reference types="vite/client" />

import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: true,
    }),
    // Copy cleanup-worker.js to dist
    {
      name: 'copy-worker',
      writeBundle() {
        try {
          const fs = require('fs');
          const path = require('path');
          fs.copyFileSync(
            path.resolve('src/cleanup-worker.js'),
            path.resolve('dist/cleanup-worker.js')
          );
          console.log('✓ Copied cleanup-worker.js to dist/');
        } catch (error) {
          console.warn('⚠ Failed to copy cleanup-worker.js:', error);
        }
      }
    }
  ],
  build: {
    target: "es2015",
    lib: {
      formats: ["es", "umd"],
      entry: "src/index.ts",
      name: "QuickjsEmscriptenSync",
    },
    rollupOptions: {
      external: ["quickjs-emscripten"],
      output: {
        globals: {
          "quickjs-emscripten": "QuickjsEmscripten",
        },
      },
    },
  },
  test: {
    coverage: {
      reporter: ["text", "json"],
    },
  },
});
