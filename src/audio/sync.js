// Store -> DSP forwarding.
//
// Listens to every store change, remembers *what* changed (not the values) and
// at the end of the current task (microtask) reads the current values and
// posts one batch of protocol messages. A knob drag, a preset load inside
// store.batch() or a full scene load therefore all become a single
// postMessage, and the DSP always receives the latest state.
//
// Tracks: the DSP has MAX_PARTS parts and is told how many are in use
// ({t:'tracks', count}). When the track list is reordered, grows or shrinks
// (src/core/tracks.js), the matching {t:'tracks', count, perm, fresh} goes
// out at once, before anything else about the new list, so the DSP moves its
// parts with their tracks and a reorder never interrupts a sound.

import {
  MAX_PARTS, PART_PARAMS, PART_PARAM_MAP, GLOBAL_PARAMS, GLOBAL_PARAM_MAP, MOD_PARAM_IDS, MOD_FIELDS, LFO_STEP_COUNT,
} from '../core/params.js';
import { sanitizeLinks } from '../core/migrate.js';
import { sanitizeFuncPoints } from '../dsp/function-gen.js';
import { sanitizeDrum, base64ToPcm, SYNTH_DRUMS } from '../dsp/drum-kit.js';
import { libraryPcm, LIBRARY_PCM_RATE } from '../dsp/drum-library.js';
import { partCount, trackIds, trackChange, inversePerm } from '../core/tracks.js';
import { sanitizeTrackFx } from '../dsp/track-fx-config.js';
import { decodeNoiseRecording } from '../dsp/noise-recording.js';
import { sanitizeTuning, tuningTable, tuningFollowsKey } from '../dsp/tuning.js';
import { sanitizeOperator } from '../dsp/damage.js';

const MOD_SET = new Set(MOD_PARAM_IDS);

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function cleanMod(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  let any = false;
  for (const f of MOD_FIELDS) {
    if (f === 'steps') {
      // The Steps LFO's 16 values travel as a plain array (copied, so the DSP
      // never shares an array the UI keeps editing).
      const st = o.steps;
      if (Array.isArray(st) && st.length >= LFO_STEP_COUNT) {
        out.steps = Array.from({ length: LFO_STEP_COUNT }, (_, i) => (isNum(st[i]) ? Math.max(-1, Math.min(1, st[i])) : 0));
        any = true;
      }
    } else if (isNum(o[f])) { out[f] = o[f]; any = true; }
  }
  return any ? out : null;
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {(messages: object[]) => void} o.post receives one array of messages per flush
 * @param {(global: object, changed: string[]|null) => void} [o.onGlobal] host-side consumers (effects); changed null = everything
 * @param {(fn: () => void) => void} [o.defer] scheduling primitive (tests may pass a manual one)
 * @param {() => object[]} [o.extra] host state that is not in the store (quality, controllers),
 *   appended to snapshot() so a rebuilt DSP gets it back too
 * @param {() => number} [o.sampleRate] active render rate used to decode recorded noise
 */
export function createStoreSync({ store, post, onGlobal = () => {}, defer = queueMicrotask, extra = () => [], sampleRate = () => 48000 }) {
  let scheduled = false;
  let full = false;
  let fullExtra = false;     // a full resend that must include the host state too (resendAll)
  const partAll = new Set();
  const paramsAll = new Set();
  const modsAll = new Set();
  let params = Array.from({ length: MAX_PARTS }, () => new Set());
  let mods = Array.from({ length: MAX_PARTS }, () => new Set());
  let ids = trackIds(store.get('parts'));
  const links = new Set();
  const funcs = new Set();   // v2.4 Function points
  const kits = new Set();    // v2.7 drum kits
  const pcmCache = new Map(); // base64 sample -> Float32Array (decoded once)
  const kitSent = new Map();  // part -> the sound each pad last sent, so knob edits don't resend samples
  const trackFx = new Set();
  const noise = new Set();
  let globalAll = false;
  const globals = new Set();
  let watchDirty = false;
  // v2.9 microtuning: `tuningKey` names the table the DSP has ('default' = none)
  let tuningDirty = false;
  let tuningKey = 'default';
  // v2.9 Operator panel: {t:'operator', cfg} (cfg null = everything off); `opKey` names what the DSP has
  let opDirty = false;
  let opKey = 'null';
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

  // Links are replaced as a whole list ({t:'links'}), so any change inside
  // parts.N.links resends that part's list. A state without the field (saved
  // before links existed, not migrated) leaves the DSP's default link alone.
  function linksMsg(i) {
    const src = store.get(`parts.${i}.links`);
    if (!Array.isArray(src)) return null;
    return { t: 'links', part: i, links: sanitizeLinks(src) };
  }

  // `full` sends every pad's sound; otherwise a pad whose sound has not
  // changed since the last message sends only its settings (keep: 1).
  function kitMsg(i, full = false) {
    const d = sanitizeDrum(store.get(`parts.${i}.drum`));
    if (!d.on) return { t: 'kit', part: i, on: 0 };
    const sent = (!full && kitSent.get(i)) || [];
    const now = [];
    const pads = d.pads.map((p, k) => {
      const base = { gain: p.level, pitch: p.pitch, decay: p.decay, pan: p.pan, choke: p.choke };
      now[k] = p.sample ? p.sample.data : `synth:${p.synth}`;
      if (sent[k] === now[k]) return { ...base, keep: 1 };
      if (p.sample) {
        let pcm = pcmCache.get(p.sample.data);
        if (!pcm) { pcm = base64ToPcm(p.sample.data); if (pcmCache.size > 64) pcmCache.clear(); pcmCache.set(p.sample.data, pcm); }
        return { ...base, pcm, rate: p.sample.rate };
      }
      // v2.8 library sounds past the original eight are rendered here, not on the audio thread
      if (p.synth >= SYNTH_DRUMS.length) {
        const pcm = libraryPcm(p.synth);
        if (pcm) return { ...base, pcm, rate: LIBRARY_PCM_RATE };
      }
      return { ...base, synth: p.synth };
    });
    kitSent.set(i, now);
    return { t: 'kit', part: i, on: 1, pads };
  }

  function funcMsg(i) {
    return { t: 'func', part: i, points: sanitizeFuncPoints(store.get(`parts.${i}.funcPoints`)) };
  }

  function fxMsg(i) {
    const fx = sanitizeTrackFx(store.get(`parts.${i}.trackFx`));
    const tracks = trackIds(store.get('parts'));
    const source = fx.sidechain === 'mix' ? -2 : fx.sidechain === 'self' ? -1 : tracks.indexOf(fx.sidechain);
    return { t: 'trackFx', part: i, fx, sidechainIndex: source === i ? -1 : source };
  }

  function noiseMsg(i) {
    return { t: 'noiseRecording', part: i, data: decodeNoiseRecording(store.get(`parts.${i}.noiseRecording`), sampleRate()) };
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
    return { t: 'watch', part: sel >= 0 && sel < partCount(store) ? sel : 0 };
  }

  const tracksMsg = () => ({ t: 'tracks', count: partCount(store) });

  /** The session's tuning, the global Key it may follow and a key naming the resulting table. */
  function tuningState() {
    const src = store.get('tuning');
    const t = sanitizeTuning(src);
    if (!t) return { t: null, key: 'default', root: 0 };
    const root = Math.round(Number(store.get('global.scaleRoot')) || 0);
    return { t, root, key: JSON.stringify(t) + (tuningFollowsKey(t) ? `@${root}` : '') };
  }
  const tuningMsg = (st) => ({ t: 'tuning', hz: st.t ? tuningTable(st.t, st.root) : null });

  const operatorCfg = () => sanitizeOperator(store.get('operator'));

  const ALL_PARAM_IDS = PART_PARAMS.map(p => p.id);
  const ALL_GLOBAL_IDS = GLOBAL_PARAMS.map(p => p.id);

  /**
   * Every message needed to bring a fresh DSP up to the store's state (plus
   * the host's own state from `extra`, unless withExtra is false: a store
   * load changes the patch, not the quality setting or the controllers).
   */
  function snapshot(withExtra = true) {
    const out = [tracksMsg()];
    const g = globalMsg(ALL_GLOBAL_IDS);
    if (g) out.push(g);
    // a fresh DSP plays the default tuning, so only a custom one is sent
    const tu = tuningState();
    if (tu.t) out.push(tuningMsg(tu));
    // likewise the Operator panel, only when a session has changed it
    const op = operatorCfg();
    if (op) out.push({ t: 'operator', cfg: op });
    const n = partCount(store);
    for (let i = 0; i < n; i++) {
      const p = partParams(i, ALL_PARAM_IDS);
      if (p) out.push(p);
      const m = partMods(i, MOD_PARAM_IDS);
      if (m) out.push(m);
      const l = linksMsg(i);
      if (l) out.push(l);
      out.push(funcMsg(i), kitMsg(i, true), fxMsg(i), noiseMsg(i));
    }
    out.push(watchMsg());
    if (withExtra) {
      try { for (const m of extra() || []) if (m) out.push(m); } catch (err) { console.error('[audio] snapshot extra failed', err); }
    }
    return out;
  }

  function reset() {
    full = false; fullExtra = false; globalAll = false; watchDirty = false; playingDirty = false; tuningDirty = false; opDirty = false;
    partAll.clear(); paramsAll.clear(); modsAll.clear(); globals.clear(); links.clear(); funcs.clear(); kits.clear(); trackFx.clear(); noise.clear();
    for (const s of params) s.clear();
    for (const s of mods) s.clear();
  }

  function flush() {
    scheduled = false;
    flushes++;
    const out = [];
    let globalChanged = null;
    if (full) {
      out.push(...snapshot(fullExtra));
      const tu = tuningState();
      // a loaded session without a tuning resets one the DSP still has
      if (!tu.t && tuningKey !== 'default') out.push(tuningMsg(tu));
      tuningKey = tu.key;
      const op = operatorCfg();
      if (!op && opKey !== 'null') out.push({ t: 'operator', cfg: null });
      opKey = JSON.stringify(op);
      globalChanged = ALL_GLOBAL_IDS;
    } else {
      if (tuningDirty) {
        const tu = tuningState();
        if (tu.key !== tuningKey) { out.push(tuningMsg(tu)); tuningKey = tu.key; }
      }
      if (opDirty) {
        const op = operatorCfg();
        const key = JSON.stringify(op);
        if (key !== opKey) { out.push({ t: 'operator', cfg: op }); opKey = key; }
      }
      if (globalAll || globals.size) {
        const ids = globalAll ? ALL_GLOBAL_IDS : [...globals];
        const g = globalMsg(ids);
        if (g) out.push(g);
        globalChanged = ids;
      }
      const n = partCount(store);
      for (let i = 0; i < n; i++) {
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
        if (partAll.has(i) || links.has(i)) {
          const l = linksMsg(i);
          if (l) out.push(l);
        }
        if (partAll.has(i) || funcs.has(i)) out.push(funcMsg(i));
        if (partAll.has(i) || kits.has(i)) out.push(kitMsg(i, partAll.has(i)));
        if (partAll.has(i) || trackFx.has(i)) out.push(fxMsg(i));
        if (partAll.has(i) || noise.has(i)) out.push(noiseMsg(i));
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

  /**
   * The track list changed shape: move what is pending with the tracks, tell
   * the DSP right away (ahead of any note for the new list) and resend the
   * new tracks in full.
   */
  function retrack(meta) {
    const r = trackChange(ids, store, meta);
    ids = r.ids;
    const change = r.change;
    if (!change) return;
    const inv = inversePerm(change.perm);
    const move = (set) => new Set([...set].map(i => inv[i]).filter(i => i >= 0 && i < change.count));
    params = change.perm.map(j => params[j]);
    mods = change.perm.map(j => mods[j]);
    for (const set of [partAll, paramsAll, modsAll, links, trackFx, noise]) {
      const moved = move(set);
      set.clear();
      for (const i of moved) set.add(i);
    }
    for (const i of change.fresh) partAll.add(i);
    // Stable sidechain IDs resolve to new DSP indices after every reorder,
    // including tracks whose own rack did not otherwise change.
    for (let i = 0; i < change.count; i++) trackFx.add(i);
    watchDirty = true;
    mark();
    posts++;
    post([{ t: 'tracks', count: change.count, perm: change.perm, fresh: change.fresh }]);
  }

  function route(path, meta) {
    if (path === '' || path === 'parts') retrack(meta);
    if (path === '') { full = true; mark(); return; }
    const k = path.split('.');
    const head = k[0];
    if (head === 'parts') {
      if (k.length === 1) { for (let i = 0; i < MAX_PARTS; i++) partAll.add(i); mark(); return; }
      const i = Number(k[1]);
      if (!(i >= 0 && i < MAX_PARTS) || !Number.isInteger(i)) return;
      if (k.length === 2) { partAll.add(i); mark(); return; }
      if (k[2] === 'params') {
        if (k.length === 3) paramsAll.add(i); else params[i].add(k[3]);
        mark();
      } else if (k[2] === 'mods') {
        if (k.length === 3) modsAll.add(i); else mods[i].add(k[3]);
        mark();
      } else if (k[2] === 'links') {
        links.add(i);
        mark();
      } else if (k[2] === 'funcPoints') {
        funcs.add(i);
        mark();
      } else if (k[2] === 'drum') {
        kits.add(i);
        mark();
      } else if (k[2] === 'trackFx') {
        trackFx.add(i);
        mark();
      } else if (k[2] === 'noiseRecording') {
        noise.add(i);
        mark();
      }
      return;
    }
    if (head === 'global') {
      if (k.length === 1) globalAll = true; else globals.add(k[1]);
      if (k.length === 1 || k[1] === 'scaleRoot') tuningDirty = true;
      mark();
      return;
    }
    if (head === 'tuning') { tuningDirty = true; mark(); return; }
    if (head === 'operator') { opDirty = true; mark(); return; }
    if (head === 'ui') {
      if (k.length === 1 || k[1] === 'selectedPart') { watchDirty = true; mark(); }
      if (k.length === 1 || k[1] === 'playing') { playingDirty = true; mark(); }
    }
  }

  const off = store.subscribe('', (path, value, meta) => route(path, meta));

  return {
    snapshot,
    /** Post anything pending right now (call before a note so it sees the latest patch). */
    flush() { if (scheduled) flush(); },
    /** Mark everything dirty, e.g. after the DSP node was rebuilt. */
    resendAll() { full = true; fullExtra = true; playingDirty = false; mark(); },
    stats: () => ({ flushes, posts }),
    dispose() { scheduled = false; off(); },
  };
}
