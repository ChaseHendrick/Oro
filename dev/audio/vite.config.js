// Config for the audio harness (tests/e2e/audio-host.cjs).
//  * dev server: no HMR and no file watching, so edits other people make in the
//    shared tree cannot reload the page in the middle of a scripted run;
//  * build: the harness as one self-contained HTML file (same plugins as the
//    app's single-file build) so the e2e test can open it from file://:
//      npx vite build --config dev/audio/vite.config.js --mode single --outDir /tmp/orograph-single-audio
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
    rollupOptions: { input: path.resolve(root, 'dev/audio/index.html') },
  },
}));
