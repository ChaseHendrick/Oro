// One place to get the terrain tables the selected part is playing. Prefers the
// engine's live tables (exactly what you hear, including imports); falls back
// to generating them with the DSP module so previews still work without audio.

import { listen } from './dom.js';
import { TERRAIN_INDEX } from '../dsp/catalog.js';
import { jobFor, jobKey, buildTerrainData } from '../audio/terrain-jobs.js';
import { partCount } from '../core/tracks.js';

const SLOTS = ['A', 'B'];
const FALLBACK_SIZE = 512;

export function createTerrainSource({ store, engine }) {
  const live = new Map();      // `${part}${slot}` -> {size, data} from engine events
  const fallback = new Map();  // `${part}${slot}` -> { key, table }
  const listeners = new Set();
  const notify = (part, slot) => { for (const fn of listeners) { try { fn(part, slot); } catch (err) { console.warn(err); } } };

  const offEngine = listen(engine, 'terrain', (ev) => {
    if (!ev || !ev.data) return;
    const slot = ev.slot === 1 || ev.slot === 'B' ? 'B' : 'A';
    live.set(`${ev.part}${slot}`, { size: ev.size, data: ev.data });
    notify(ev.part, slot);
  });

  // Without engine events, regenerate when the generating parameters change.
  const timers = new Map();
  const offStore = store.subscribe('parts', (path) => {
    const m = /^parts\.(\d+)(?:\.(params\.(terrainA|terrainB|seed|detail|imageChannelA|imageChannelB|imageMappingA|imageMappingB)|userTerrain.*))?$/.exec(path);
    if (!m && path !== 'parts') return;
    // The list changed (tracks moved, added or removed): engine tables are
    // looked up by index again, the event copies by index are stale.
    if (!m) live.clear();
    const parts = m ? [Number(m[1])] : Array.from({ length: partCount(store) }, (_, i) => i);
    for (const p of parts) {
      clearTimeout(timers.get(p));
      timers.set(p, setTimeout(() => { notify(p, 'A'); notify(p, 'B'); }, 60));
    }
  });
  const offRoot = store.subscribe('', (path) => {
    if (path !== '') return;
    live.clear();
    for (let p = 0; p < partCount(store); p++) { notify(p, 'A'); notify(p, 'B'); }
  });

  function fromEngine(part, slot) {
    if (engine && typeof engine.getTerrain === 'function') {
      try {
        const t = engine.getTerrain(part, slot);
        if (t && t.data && t.size) return t;
      } catch { /* engine not ready */ }
    }
    return live.get(`${part}${slot}`) || null;
  }

  function generated(part, slot) {
    const params = store.get(`parts.${part}.params`) || {};
    const index = params['terrain' + slot];
    const user = index === TERRAIN_INDEX.user;
    const ut = store.get(`parts.${part}.userTerrain.${slot}`);
    const job = jobFor(params, user ? ut : null, slot, FALLBACK_SIZE);
    const key = jobKey(job);
    const hit = fallback.get(`${part}${slot}`);
    if (hit && hit.key === key) return hit.table;
    const data = buildTerrainData(job);
    const table = { size: job.kind === 'flat' ? job.size : FALLBACK_SIZE, data };
    fallback.set(`${part}${slot}`, { key, table });
    return table;
  }

  return {
    slots: SLOTS,
    /** {size, data} for a part's slot ('A' | 'B'), or null. */
    get(part, slot) {
      return fromEngine(part, slot) || generated(part, slot);
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { offEngine(); offStore(); offRoot(); timers.forEach(t => clearTimeout(t)); },
  };
}
