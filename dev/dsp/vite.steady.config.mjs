// The project's Vite config for browser checks while other people edit the
// tree: same plugins and build, but no HMR and no file watching, so a save
// elsewhere cannot reload the page in the middle of a measurement.
//   npx vite --config dev/dsp/vite.steady.config.mjs --port 5191 --strictPort
import base from '../../vite.config.js';

export default async (env) => {
  const cfg = typeof base === 'function' ? await base(env) : base;
  return {
    ...cfg,
    root: new URL('../..', import.meta.url).pathname,
    server: { ...(cfg.server || {}), hmr: false, watch: { ignored: ['**/*'] } },
  };
};
