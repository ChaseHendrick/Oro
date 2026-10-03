//    ###   ####    ###
//   #   #  #   #  #   #
//   #   #  ####   #   #
//   #   #  #  #   #   #
//    ###   #   #   ###
//
// Oro bootstrap: builds the store, then wires audio, visuals, music,
// presets, MIDI and the UI together. Each module owns its own behaviour; this
// file only decides construction order and session persistence.

import './styles/main.css';
import { createStore, deepClone } from './core/store.js';
import { defaultState, MAX_PARTS } from './core/params.js';
import * as tracks from './core/tracks.js';
import { loadSessionAsync, createAutosave } from './core/session.js';
import { createEngine } from './audio/engine.js';
import { createVisuals } from './visual/visuals.js';
import { createMusic } from './music/music.js';
import { createPresets } from './presets/presets.js';
import { createMidi } from './midi/midi.js';
import { createUI } from './ui/app.js';
import { savedContextSampleRate } from './pedals/rig-settings.js';
import { installConsoleEgg } from './ui/eggs.js';

async function boot() {
  const root = document.getElementById('app');
  const saved = await loadSessionAsync();
  const store = createStore(saved || defaultState());
  // Saves a moment after changes, at least every couple of seconds while a dot
  // keeps moving, and at once when the page is hidden or closed.
  const autosave = createAutosave({ store });
  const persist = autosave.schedule;
  window.addEventListener('pagehide', autosave.flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave.flush(); });
  store.subscribe('global', persist);
  store.subscribe('parts', persist);
  store.subscribe('', (path) => { if (path === '') persist(); });

  // Settings > Pedals > Sample rate (per computer): Auto, 44.1 kHz (the MPC XL)
  // or 48 kHz. The context cannot change rate while running, so the choice
  // applies here, at start-up.
  const engine = await createEngine({ store, sampleRate: savedContextSampleRate() });
  const presets = createPresets({ store });
  await presets.ready;
  // The preview picks its phrase from the patch category, which the preset library knows.
  const music = createMusic({ store, engine, presets });
  if (!saved) presets.loadScene(0);
  // The transport tells the engine where beat 0 is whenever it starts or stops;
  // until then the engine should know the transport is stopped at the session tempo.
  if (engine && typeof engine.setTransport === 'function') {
    try { engine.setTransport({ playing: false, beatTime: 0, beat: 0, spb: 60 / (Number(store.get('global.tempo')) || 120) }); } catch { /* optional hook */ }
  }

  const viewport = root.querySelector('[data-viewport]') || root;
  let visuals = null;
  try {
    // music: dot-lock flashes on steps and Tour timing follow the transport.
    visuals = await createVisuals(viewport, { store, engine, music });
  } catch (err) {
    console.error('[orograph] 3D view failed to start', err);
  }
  // Explore mode: the marble passing a peak or valley plays an in-key note.
  // Visuals emit 'extremum' only in Explore mode; music checks the part's settings too.
  if (visuals && typeof visuals.on === 'function') {
    try { visuals.on('extremum', (e) => music.exploreNote(e)); } catch (err) { console.warn('[orograph] Explore notes unavailable', err); }
  }

  let midi = null;
  try {
    // presets: MIDI program change loads patches.
    midi = await createMidi({ store, router: music.router, engine, transport: music.transport, presets });
  } catch (err) {
    console.warn('[orograph] MIDI unavailable', err);
  }

  createUI(root, { store, engine, visuals, music, presets, midi, prepareUpdate: async () => {
    autosave.schedule(); autosave.flush();
    const saved = await Promise.all([autosave.settled(), presets.settled()]);
    return saved.every(Boolean);
  } });

  // Debug / test hook (used by the end-to-end tests; harmless in production).
  window.orograph = { store, engine, visuals, music, presets, midi, MAX_PARTS, tracks, deepClone };
  // v2.9 a hello for people who open the console (src/ui/eggs.js)
  installConsoleEgg();
}

boot().catch(err => {
  console.error('[orograph] failed to start', err);
  const el = document.createElement('pre');
  el.className = 'boot-error';
  el.textContent = 'Oro could not start:\n' + (err && err.stack || err);
  document.body.appendChild(el);
});
