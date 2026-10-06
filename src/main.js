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
import { seedNewInstallDefaults } from './core/first-run.js';
import { installConsoleEgg } from './ui/eggs.js';
import { restoreRescue, clearRescue } from './learn/rescue.js';
import { pluginRequested, hostOutputs, hostParamList, applyHostParam } from './plugin/host.js';
import { createAgentApi, installBridge, agentOptIn } from './agent/api.js';
import { createTouchTool } from './music/touch.js';
import { version as APP_VERSION } from '../package.json';

// Start-up timing marks (2.11): 'oro:boot' once the main chunk has run,
// 'oro:ui' once the interface is built. Read with performance.getEntriesByType('mark').
const mark = (name) => { try { performance.mark(name); } catch { /* old browsers */ } };

async function boot() {
  mark('oro:boot');
  const root = document.getElementById('app');
  const saved = await loadSessionAsync();
  // 2.11: a computer with nothing saved starts at Pristine, 96 kHz (existing choices are kept).
  seedNewInstallDefaults({ hasSession: !!saved });
  const store = createStore(saved || defaultState());
  // Saves a moment after changes, at least every couple of seconds while a dot
  // keeps moving, and at once when the page is hidden or closed.
  const autosave = createAutosave({ store });
  const persist = autosave.schedule;
  window.addEventListener('pagehide', autosave.flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autosave.flush(); });
  store.subscribe('global', persist);
  store.subscribe('parts', persist);
  store.subscribe('live', persist);   // 2.12 live mode setup
  store.subscribe('', (path) => { if (path === '') persist(); });
  try {
    const rescued = restoreRescue(localStorage);
    if (rescued && Array.isArray(rescued.parts)) {
      store.load(rescued, { source: 'learn' });
      clearRescue(localStorage);
      autosave.flush();
    }
  } catch { /* no storage */ }

  // Settings > Pedals > Sample rate (per computer): Auto, 44.1 kHz (the MPC XL),
  // 48 kHz or 96 kHz (the new-install default; a device that refuses it runs at its own rate). The context cannot change rate while running, so the choice
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
    // 2.17 the touch tool (Touch: Strum / FX in the map toolbar)
    try {
      const touchTool = createTouchTool({ store, engine, router: music.router });
      visuals.on('touch', (e) => touchTool.handle(e));
    } catch (err) { console.warn('[orograph] the touch tool is unavailable', err); }
  }

  let midi = null;
  try {
    // presets: MIDI program change loads patches.
    midi = await createMidi({ store, router: music.router, engine, transport: music.transport, presets });
  } catch (err) {
    console.warn('[orograph] MIDI unavailable', err);
  }

  // 2.17: a score borrows tracks while it plays; the saved session keeps them as they were
  autosave.addFilter((state) => music.score.cleanState(state));

  const ui = createUI(root, { store, engine, visuals, music, presets, midi, autosave, prepareUpdate: async () => {
    autosave.schedule(); autosave.flush();
    const saved = await Promise.all([autosave.settled(), presets.settled()]);
    return saved.every(Boolean);
  } });

  mark('oro:ui');
  // v2.11 version history (src/core/versions.js), loaded after the app is up
  import('./core/versions.js').then(m => m.startVersions({ store })).catch(err => console.warn('[orograph] version history unavailable', err));

  // Debug / test hook (used by the end-to-end tests; harmless in production).
  window.orograph = { store, engine, visuals, music, presets, midi, MAX_PARTS, tracks, deepClone };
  // 2.17 agent API (src/agent/api.js): window.oro and the postMessage bridge.
  // Changing the session over postMessage needs the page opened with ?agent=1.
  window.oro = createAgentApi({ store, engine, music, presets, visuals, getUi: () => ui && ui.ctx, version: APP_VERSION });
  installBridge(window, window.oro, { allowMutating: () => agentOptIn() });
  // A #score= link puts its score on the desk and plays it once audio is running.
  // 2.17.1: also when the link is pasted into a tab that already has Oro open.
  let waitForAudio = null;
  const openScoreLink = () => {
    if (!/[#&]score=/.test(location.hash || '')) return;
    import('./music/score-export.js').then(async ({ scoreFromHash }) => {
      const text = await scoreFromHash(location.hash);
      const r = text ? music.score.load(text) : null;
      if (!r || !r.ok) { console.warn('[orograph] the score in this link could not be read', r && r.errors); return; }
      const go = () => { music.score.play(); };
      if (waitForAudio) { waitForAudio(); waitForAudio = null; }
      if (store.get('ui.audioStarted') && engine && engine.context && engine.context.state === 'running') go();
      else {
        const off = store.subscribe('ui.audioStarted', () => { if (store.get('ui.audioStarted')) { off(); waitForAudio = null; go(); } });
        waitForAudio = off;
      }
    }).catch((err) => console.warn('[orograph] score link failed', err));
  };
  openScoreLink();
  window.addEventListener('hashchange', openScoreLink);
  if (pluginRequested()) {
    window.orograph.host = {
      outputs: () => hostOutputs((store.get('parts') || []).length),
      params: hostParamList(),
      set: (param, value) => applyHostParam(store, param, value),
    };
  }
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
