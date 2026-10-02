// Orograph bootstrap: builds the store, then wires audio, visuals, music,
// presets, MIDI and the UI together. Each module owns its own behaviour; this
// file only decides construction order and session persistence.

import './styles/main.css';
import { createStore, deepClone } from './core/store.js';
import { defaultState, NUM_PARTS } from './core/params.js';
import { migrateState } from './core/migrate.js';
import { createEngine } from './audio/engine.js';
import { createVisuals } from './visual/visuals.js';
import { createMusic } from './music/music.js';
import { createPresets } from './presets/presets.js';
import { createMidi } from './midi/midi.js';
import { createUI } from './ui/app.js';

const SESSION_KEY = 'orograph.session.v1';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return migrateState(JSON.parse(raw));
  } catch (err) {
    console.warn('[orograph] ignoring unreadable saved session', err);
    return null;
  }
}

function saveSessionSoon(store) {
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(store.serialize())); } catch { /* storage full or blocked */ }
    }, 600);
  };
}

async function boot() {
  const root = document.getElementById('app');
  const saved = loadSession();
  const store = createStore(saved || defaultState());
  const persist = saveSessionSoon(store);
  store.subscribe('global', persist);
  store.subscribe('parts', persist);
  store.subscribe('', (path) => { if (path === '') persist(); });

  const engine = await createEngine({ store });
  const music = createMusic({ store, engine });
  const presets = createPresets({ store });
  if (!saved) presets.loadScene(0);

  const viewport = root.querySelector('[data-viewport]') || root;
  let visuals = null;
  try {
    visuals = await createVisuals(viewport, { store, engine });
  } catch (err) {
    console.error('[orograph] 3D view failed to start', err);
  }
  let midi = null;
  try {
    midi = await createMidi({ store, router: music.router, engine, transport: music.transport });
  } catch (err) {
    console.warn('[orograph] MIDI unavailable', err);
  }

  createUI(root, { store, engine, visuals, music, presets, midi });

  // Debug / test hook (used by the end-to-end tests; harmless in production).
  window.orograph = { store, engine, visuals, music, presets, midi, NUM_PARTS, deepClone };
}

boot().catch(err => {
  console.error('[orograph] failed to start', err);
  const el = document.createElement('pre');
  el.className = 'boot-error';
  el.textContent = 'Orograph could not start:\n' + (err && err.stack || err);
  document.body.appendChild(el);
});
