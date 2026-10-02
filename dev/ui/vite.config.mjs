// Dev server for the UI harness and its end-to-end test.
//   npx vite --config dev/ui/vite.config.mjs          (port 5184)
// Same build setup as the app (including the worklet plugin), but with hot
// reload off and its own dependency cache: other modules are edited in the
// same tree while UI tests run, and a reload mid-test would make them flaky.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../vite.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default async (env) => {
  const cfg = typeof base === 'function' ? await base(env) : base;
  return {
    ...cfg,
    root,
    cacheDir: path.join(root, 'node_modules/.vite-ui'),
    // hmr: false also stops Vite's full-reload messages (only connect, ping,
    // custom and error payloads still go out), so edits elsewhere never reload
    // a page under test. Keep the socket itself: without it the Vite client
    // logs connection errors that would fail the console checks.
    server: { ...(cfg.server || {}), host: '127.0.0.1', port: 5184, strictPort: true, hmr: false },
  };
};
