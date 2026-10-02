// Terrain tables for every part, for the map and the physics. The engine's
// tables are preferred (exactly what you hear, including imports); when the
// engine has none, or does not answer a change within a short wait (audio not
// built yet, or running without an engine), the same tables are generated
// locally with the DSP module.

import { NUM_PARTS } from '../core/params.js';
import { TERRAIN_INDEX } from '../dsp/catalog.js';
import { generateTerrain, decodeUserTerrain } from '../dsp/terrains.js';

const SLOTS = ['A', 'B'];
const LOCAL_SIZE = 512;
const ENGINE_WAIT_MS = 450;

export function createTerrainCache({ store, engine, onChange }) {
  const entries = Array.from({ length: NUM_PARTS }, () => ({ A: null, B: null }));
  const timers = Array.from({ length: NUM_PARTS }, () => ({ A: 0, B: 0 }));
  let disposed = false;

  function keyFor(part, slot) {
    const p = store.get(`parts.${part}.params`) || {};
    const index = p['terrain' + slot];
    if (index === TERRAIN_INDEX.user) {
      const ut = store.get(`parts.${part}.userTerrain.${slot}`);
      return ut ? `user|${ut.kind}|${ut.w}x${ut.h}|${ut.mirror}|${ut.data.length}|${ut.data.slice(0, 64)}|${ut.data.slice(-64)}` : 'user|none';
    }
    return `${index}|${p.seed}|${p.detail}`;
  }

  function generateLocal(part, slot) {
    const p = store.get(`parts.${part}.params`) || {};
    const index = p['terrain' + slot];
    let data = null;
    try {
      if (index === TERRAIN_INDEX.user) {
        data = decodeUserTerrain(store.get(`parts.${part}.userTerrain.${slot}`), LOCAL_SIZE);
      } else {
        data = generateTerrain(index, { size: LOCAL_SIZE, seed: p.seed ?? 7, detail: p.detail ?? 0.5 });
      }
    } catch (err) {
      console.warn('[visuals] terrain generation failed', err);
    }
    if (!data) data = new Float32Array(LOCAL_SIZE * LOCAL_SIZE);
    return { data, size: LOCAL_SIZE, key: keyFor(part, slot), source: 'local' };
  }

  function fromEngine(part, slot) {
    if (!engine || typeof engine.getTerrain !== 'function') return null;
    try {
      const t = engine.getTerrain(part, slot);
      if (t && t.data && t.size && t.data.length >= t.size * t.size) {
        return { data: t.data, size: t.size, key: keyFor(part, slot), source: 'engine' };
      }
    } catch { /* engine not ready yet */ }
    return null;
  }

  function get(part, slot) {
    let e = entries[part][slot];
    if (e) return e;
    e = fromEngine(part, slot) || generateLocal(part, slot);
    entries[part][slot] = e;
    return e;
  }

  function set(part, slot, entry) {
    entries[part][slot] = entry;
    if (onChange) onChange(part, slot, entry);
  }

  /** Engine 'terrain' event: {part, slot: 'A'|'B'|0|1, size, data}. */
  function onEngineTerrain(ev) {
    if (!ev || !ev.data || !(ev.part >= 0 && ev.part < NUM_PARTS)) return;
    const slot = ev.slot === 1 || ev.slot === 'B' ? 'B' : 'A';
    const size = ev.size || Math.round(Math.sqrt(ev.data.length));
    clearTimeout(timers[ev.part][slot]);
    timers[ev.part][slot] = 0;
    set(ev.part, slot, { data: ev.data, size, key: keyFor(ev.part, slot), source: 'engine' });
  }

  /** A generating parameter changed: wait briefly for the engine, else build it here. */
  function invalidate(part) {
    for (const slot of SLOTS) {
      const cur = entries[part][slot];
      if (cur && cur.key === keyFor(part, slot)) continue;
      clearTimeout(timers[part][slot]);
      timers[part][slot] = setTimeout(() => {
        timers[part][slot] = 0;
        if (disposed) return;
        const now = entries[part][slot];
        if (now && now.key === keyFor(part, slot)) return;
        set(part, slot, fromEngine(part, slot) && engineMatches(part, slot) ? fromEngine(part, slot) : generateLocal(part, slot));
      }, ENGINE_WAIT_MS);
    }
  }

  // An engine table only counts as fresh if it differs from what we hold; if
  // the engine still hands back the old array it has not rebuilt yet.
  function engineMatches(part, slot) {
    const e = fromEngine(part, slot);
    const cur = entries[part][slot];
    return !!e && (!cur || cur.data !== e.data);
  }

  function invalidateAll() {
    for (let p = 0; p < NUM_PARTS; p++) invalidate(p);
  }

  return {
    get,
    onEngineTerrain,
    invalidate,
    invalidateAll,
    keyFor,
    dispose() {
      disposed = true;
      for (const t of timers) { clearTimeout(t.A); clearTimeout(t.B); }
    },
  };
}
