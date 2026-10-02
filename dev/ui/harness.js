// UI development harness: the real UI on top of fake modules.
// Query flags: ?engine=none&visuals=none&music=none|real&presets=none&midi=none|unsupported&scene=0
import '../../src/styles/main.css';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createUI } from '../../src/ui/app.js';
import { createFakeEngine, createFakeVisuals, createFakeMusic, createFakePresets, createFakeMidi } from './fakes.js';

const q = new URLSearchParams(location.search);
const off = (name) => q.get(name) === 'none';

async function boot() {
  const store = createStore(defaultState());
  const engine = off('engine') ? null : createFakeEngine({ store });
  let music = null;
  if (q.get('music') === 'real') {
    const { createMusic } = await import('../../src/music/music.js');
    music = createMusic({ store, engine });
  } else if (!off('music')) {
    music = createFakeMusic({ store, engine });
  }
  const presets = off('presets') ? null : createFakePresets({ store });
  if (presets && q.get('scene') !== 'none') presets.loadScene(Number(q.get('scene') || 0));
  const root = document.getElementById('app');
  const visuals = off('visuals') ? null : createFakeVisuals(root.querySelector('[data-viewport]'), { store, engine });
  const midi = off('midi') ? null : createFakeMidi({ store, unsupported: q.get('midi') === 'unsupported' });
  const ui = createUI(root, { store, engine, visuals, music, presets, midi });
  window.orograph = { store, engine, visuals, music, presets, midi, ui };
}

boot().catch((err) => {
  console.error('[harness] failed', err);
  const pre = document.createElement('pre');
  pre.className = 'boot-error';
  pre.textContent = String(err && err.stack || err);
  document.body.appendChild(pre);
});
