// Integration check: the real UI (src/ui) around the real 3D map, with the
// UI engineer's fake engine / music / presets / MIDI (dev/ui/fakes.js) until
// the audio host lands. Shows how the map, its HUD and the UI overlay fit.
import '../../src/styles/main.css';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createUI } from '../../src/ui/app.js';
import { createVisuals } from '../../src/visual/visuals.js';
import { createFakeEngine, createFakeMusic, createFakePresets, createFakeMidi } from '../ui/fakes.js';

async function boot() {
  const store = createStore(defaultState());
  const engine = createFakeEngine({ store });
  const music = createFakeMusic({ store, engine });
  const presets = createFakePresets({ store });
  presets.loadScene(0);
  const root = document.getElementById('app');
  const visuals = await createVisuals(root.querySelector('[data-viewport]'), { store, engine });
  const midi = createFakeMidi({ store });
  const ui = createUI(root, { store, engine, visuals, music, presets, midi });
  window.orograph = { store, engine, visuals, music, presets, midi, ui };
  window.__vis = { store, engine, visuals, ready: true };
}

boot().catch((err) => {
  console.error('[app harness] failed', err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:20px;color:#f88;background:#111;white-space:pre-wrap;z-index:99';
  pre.textContent = String(err && err.stack || err);
  document.body.appendChild(pre);
});
