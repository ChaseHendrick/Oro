// Dev server for the 3D map harness and its end-to-end test.
//   npx vite --config dev/visual/vite.config.mjs        (port 5183)
// Other modules are developed in the same tree at the same time; this config
// keeps their edits from reloading the harness mid-test (only the visuals and
// what they import from src/dsp and src/core are watched) and uses its own
// dependency cache so their optimizer runs do not invalidate ours.
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const watched = /^(src|dev|tests)$|^(src\/visual|src\/dsp|src\/core|dev\/visual)(\/|$)/;

export default defineConfig({
  root,
  base: './',
  cacheDir: path.join(root, 'node_modules/.vite-visual'),
  server: {
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
    watch: {
      ignored: (p) => {
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) return false;
        return !watched.test(rel);
      },
    },
  },
  optimizeDeps: {
    entries: ['dev/visual/index.html'],
    include: ['three', '@dimforge/rapier3d-compat'],
  },
});
