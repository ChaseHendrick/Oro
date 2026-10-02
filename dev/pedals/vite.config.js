// Dev server for the pedal harness (dev/pedals/index.html), driven by
// tests/pedals/harness-e2e.cjs on port 5196:
//   npx vite --config dev/pedals/vite.config.js --port 5196 --strictPort
// Reuses the app config for the worklet-to-string plugin. HMR and file watching
// are off so other people's edits in the shared tree cannot reload the page in
// the middle of a scripted run.
import { defineConfig, mergeConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import appConfig from '../../vite.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig((env) => mergeConfig(appConfig(env), {
  root,
  server: { hmr: false, watch: null },
  build: {
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(root, 'dev/pedals/index.html') },
  },
}));
