// Admin console (settings window) build. Source: admin/ · output: src/admin-ui/ (git-ignored, packaged by build.files `src/**/*`).
// `base: './'` keeps every asset URL relative so the main process can `loadFile('src/admin-ui/index.html')` over file://.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../src/admin-ui', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140', // Electron 45 ships Chromium 140
    chunkSizeWarningLimit: 4096,
    modulePreload: { polyfill: false },
  },
});
