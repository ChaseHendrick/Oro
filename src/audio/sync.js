// Store -> DSP forwarding.
//
// Listens to every store change, remembers *what* changed (not the values) and
// at the end of the current task (microtask) reads the current values and
// posts one batch of protocol messages. A knob drag, a preset load inside
// store.batch() or a full scene load therefore all become a single
// postMessage, and the DSP always receives the latest state.

import {
  NUM_PARTS, PART_PARAMS, PART_PARAM_MAP, GLOBAL_PARAMS, GLOBAL_PARAM_MAP, MOD_PARAM_IDS, MOD_FIELDS,
} from '../core/params.js';

const MOD_SET = new Set(MOD_PARAM_IDS);

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function cleanMod(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  let any = false;
  for (const f of MOD_FIELDS) if (isNum(o[f])) { out[f] = o[f]; any = true; }
  return any ? out : null;
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {(messages: object[]) => void} o.post receives one array of messages per flush
 * @param {(global: object, changed: string[]|null) => void} [o.onGlobal] host-side consumers (effects); changed null = everything
 * @param {(fn: () => void) => void} [o.defer] scheduling primitive (tests may pass a manual one)
 */
export function createStoreSync({ store, post, onGlobal = () => {}, defer = queueMicrotask }) {
  let scheduled = false;
  let full = false;
  const partAll = new Set();
  const paramsAll = new Set();
  const modsAll = new Set();
  const params = Array.from({ length: NUM_PARTS }, () => new Set());
  const mods = Array.from({ length: NUM_PARTS }, () => new Set());
  let globalAll = false;
  const globals = new Set();
  let watchDirty = false;
  let playingDirty = false;
  let lastPlaying = store.get('ui.playing') ? 1 : 0;
  let flushes = 0, posts = 0;

  function partParams(i, ids) {
    const src = store.get(`parts.${i}.params`) || {};
    const p = {};
    let any = false;
    for (const id of ids) {
      if (!PART_PARAM_MAP[id]) continue;
      const v = src[id];
      if (isNum(v)) { p[id] = v; any = true; }
    }
    return any ? { t: 'params', part: i, p } : null;
  }

  function partMods(i, ids) {
    const src = store.get(`parts.${i}.mods`) || {};
    const m = {};
    let any = false;
    for (const id of ids) {
      if (!MOD_SET.has(id)) continue;
      const c = cleanMod(src[id]);
      if (c) { m[id] = c; any = true; }
    }
    return any ? { t: 'mods', part: i, m } : null;
  }

  function globalMsg(ids) {
    const src = store.get('global') || {};
    const p = {};
    let any = false;
    for (const id of ids) {
      if (!GLOBAL_PARAM_MAP[id]) continue;
      if (isNum(src[id])) { p[id] = src[id]; any = true; }
    }
    return any ? { t: 'global', p } : null;
  }

  function watchMsg() {
    const sel = Math.round(Number(store.get('ui.selectedPart')) || 0);
    return { t: 'watch', part: sel >= 0 && sel < NUM_PARTS ? sel : 0 };
  }

  const ALL_PARAM_IDS = PART_PARAMS.map(p => p.id);
  const ALL_GLOBAL_IDS = GLOBAL_PARAMS.map(p => p.id);

  /** Every message needed to bring a fresh DSP up to the store's state. */
  function snapshot() {
    const out = [];
    const g = globalMsg(ALL_GLOBAL_IDS);
    if (g) out.push(g);
    for (let i = 0; i < NUM_PARTS; i++) {
      const p = partParams(i, ALL_PARAM_IDS);
      if (p) out.push(p);
      const m = partMods(i, MOD_PARAM_IDS);
      if (m) out.push(m);
    }
    out.push(watchMsg());
    return out;
  }

  function reset() {
    full = false; globalAll = false; watchDirty = false; playingDirty = false;
    partAll.clear(); paramsAll.clear(); modsAll.clear(); globals.clear();
    for (const s of params) s.clear();
    for (const s of mods) s.clear();
  }

  function flush() {
    scheduled = false;
    flushes++;
    const out = [];
    let globalChanged = null;
    if (full) {
      out.push(...snapshot());
      globalChanged = ALL_GLOBAL_IDS;
    } else {
      if (globalAll || globals.size) {
        const ids = globalAll ? ALL_GLOBAL_IDS : [...globals];
        const g = globalMsg(ids);
        if (g) out.push(g);
        globalChanged = ids;
      }
      for (let i = 0; i < NUM_PARTS; i++) {
        const allP = partAll.has(i) || paramsAll.has(i);
        const allM = partAll.has(i) || modsAll.has(i);
        if (allP || params[i].size) {
          const p = partParams(i, allP ? ALL_PARAM_IDS : params[i]);
          if (p) out.push(p);
        }
        if (allM || mods[i].size) {
          const m = partMods(i, allM ? MOD_PARAM_IDS : mods[i]);
          if (m) out.push(m);
        }
      }
      if (watchDirty) out.push(watchMsg());
    }
    if (playingDirty) {
      const playing = store.get('ui.playing') ? 1 : 0;
      // The sequencer anchors synced LFOs itself (engine.setTransport); the
      // store flag only tells the DSP when to stop following that anchor.
      if (!playing && lastPlaying) out.push({ t: 'transport', playing: false });
      lastPlaying = playing;
    }
    reset();
    if (globalChanged) {
      try { onGlobal(store.get('global') || {}, globalChanged === ALL_GLOBAL_IDS ? null : globalChanged); } catch (err) { console.error('[audio] global consumer failed', err); }
    }
    if (out.length) { posts++; post(out); }
  }

  function mark() {
    if (scheduled) return;
    scheduled = true;
    defer(() => { if (scheduled) flush(); });
  }

  function route(path) {
    if (path === '') { full = true; mark(); return; }
    const k = path.split('.');
    const head = k[0];
    if (head === 'parts') {
      if (k.length === 1) { for (let i = 0; i < NUM_PARTS; i++) partAll.add(i); mark(); return; }
      const i = Number(k[1]);
      if (!(i >= 0 && i < NUM_PARTS) || !Number.isInteger(i)) return;
      if (k.length === 2) { partAll.add(i); mark(); return; }
      if (k[2] === 'params') {
        if (k.length === 3) paramsAll.add(i); else params[i].add(k[3]);
        mark();
      } else if (k[2] === 'mods') {
        if (k.length === 3) modsAll.add(i); else mods[i].add(k[3]);
        mark();
      }
      return;
    }
    if (head === 'global') {
      if (k.length === 1) globalAll = true; else globals.add(k[1]);
      mark();
      return;
    }
    if (head === 'ui') {
      if (k.length === 1 || k[1] === 'selectedPart') { watchDirty = true; mark(); }
      if (k.length === 1 || k[1] === 'playing') { playingDirty = true; mark(); }
    }
  }

  const off = store.subscribe('', (path) => route(path));

  return {
    snapshot,
    /** Post anything pending right now (call before a note so it sees the latest patch). */
    flush() { if (scheduled) flush(); },
    /** Mark everything dirty, e.g. after the DSP node was rebuilt. */
    resendAll() { full = true; playingDirty = false; mark(); },
    stats: () => ({ flushes, posts }),
    dispose() { scheduled = false; off(); },
  };
}
