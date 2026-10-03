// v2.8 Freeze: render a track offline into an audio loop and play the loop
// in step with the transport instead of running the track's voices.
//
// The loop is the track's own output after its track effects and before its
// fader ({t:'capture'} in the DSP), so level, mute, solo, the delay and reverb
// sends, Send A / Send B, vector mix and the pedal send still apply live.
// It covers whole passes of the track's pattern: `freezeLoopBeats`. The
// render starts at beat 0 and runs warm-up passes first (at least
// FREEZE_WARM_SECONDS), then keeps the last pass, so release and effect tails
// that cross the loop's end come back round at its start, as they do live.
//
// Editing a frozen track's sound unfreezes it (the controller compares a
// signature of everything that shapes the loop after each store change): its
// voices take over again with a short crossfade. Mix settings that the DSP
// applies after the loop (see MIX_ONLY_PARAMS) and dot-lock glides replayed by
// the sequencer do not unfreeze. Frozen loops are not saved with the session:
// a session always opens with every track live.

import { MAX_PARTS, SEQ_RATES, activeSeq, clamp } from '../core/params.js';
import { partCount, watchTracks, permute } from '../core/tracks.js';
import { createEmitter } from './emitter.js';

/** Loop length choices in bars; 0 = Auto (see freezeLoopBeats). */
export const FREEZE_BAR_CHOICES = Object.freeze([0, 1, 2, 4, 8]);
/** At least this much is rendered before the kept pass, for tails. */
export const FREEZE_WARM_SECONDS = 4;
/** Longest loop (beats) a freeze will make. */
export const FREEZE_MAX_BEATS = 128;
/** Parameters the DSP applies after the frozen loop: changing them does not unfreeze. */
export const MIX_ONLY_PARAMS = Object.freeze(['level', 'delaySend', 'reverbSend', 'sendA', 'sendB', 'mute', 'solo', 'pedalSend', 'pedalPre', 'pedalInsert']);
const MIX_ONLY = new Set(MIX_ONLY_PARAMS);
/** Global settings that change what a pattern plays. */
export const FREEZE_GLOBALS = Object.freeze(['tempo', 'swing', 'scaleRoot', 'scaleType']);
const QUANTUM = 128;
const YIELD_MS = 8;
const EPS = 1e-6;

const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldTask = () => new Promise(r => setTimeout(r, 0));

/** Length of a track's pattern loop in beats (0 when it has none). */
export function patternBeats(part) {
  const seq = activeSeq(part);
  if (!seq) return 0;
  const rateIdx = clamp(Math.round(finite(seq.rate, 3)), 0, SEQ_RATES.length - 1);
  const len = clamp(Math.round(finite(seq.length, 16)), 1, 16);
  return len * SEQ_RATES[rateIdx].beats;
}

/**
 * Frozen loop length in beats: whole passes of a pattern `pBeats` long.
 * `bars` > 0: the fewest passes that last at least that many bars. Auto (0):
 * the fewest passes (up to 8) that fill a whole number of bars, so tempo-synced
 * LFOs, swing and synced effects line up; otherwise the fewest that last a bar.
 */
export function freezeLoopBeats(pBeats, bars = 0) {
  if (!(pBeats > 0)) return 0;
  const b = Math.round(finite(bars, 0));
  let beats;
  if (b > 0) beats = pBeats * Math.max(1, Math.ceil(b * 4 / pBeats - EPS));
  else {
    beats = 0;
    for (let k = 1; k <= 8 && !beats; k++) {
      const x = pBeats * k / 4;
      if (Math.abs(x - Math.round(x)) < EPS) beats = pBeats * k;
    }
    if (!beats) beats = pBeats * Math.max(1, Math.ceil(4 / pBeats - EPS));
  }
  return Math.min(beats, Math.max(pBeats, Math.floor(FREEZE_MAX_BEATS / pBeats) * pBeats));
}

/** Whether the pattern a track plays has any note in it. */
export function patternHasNotes(part) {
  const seq = activeSeq(part);
  if (!seq) return false;
  const len = clamp(Math.round(finite(seq.length, 16)), 1, 16);
  if (part.drum && part.drum.on) {
    const lanes = Array.isArray(seq.drumLanes) ? seq.drumLanes : [];
    return lanes.some(row => Array.isArray(row) && row.slice(0, len).some(v => v > 0));
  }
  return Array.isArray(seq.steps) && seq.steps.slice(0, len).some(st => st && st.on && finite(st.prob, 1) > 0);
}

/** { ok, reason } for freezing a track (reason is shown to the person). */
export function canFreeze(part) {
  if (!part) return { ok: false, reason: 'There is no such track' };
  if (!part.seqOn) return { ok: false, reason: 'Turn on this track\'s pattern first (Seq on): Freeze records the pattern' };
  if (part.dot && Math.round(finite(part.dot.mode, 0)) !== 0) return { ok: false, reason: 'Set the dot to Pin first: a moving dot cannot be frozen' };
  if (!patternHasNotes(part)) return { ok: false, reason: 'This track\'s pattern has no notes to freeze' };
  return { ok: true, reason: '' };
}

/** Whether a track's rack listens to another track (its loop then needs the others rendered too). */
export function usesOtherTracks(part) {
  const fx = part && part.trackFx;
  return !!(fx && typeof fx.sidechain === 'string' && fx.sidechain !== 'self');
}

function terrainKey(t) {
  return t ? [t.name, t.kind, t.w, t.h, t.mirror] : null;
}

/**
 * Everything that shapes a track's frozen loop, as a list compared item by
 * item (===): a JSON string of the small settings, then the large imported
 * data by reference. Mix-only parameters are left out, and so are Dot X / Dot Y
 * when the pattern has dot locks (the sequencer moves them while it plays).
 */
export function freezeSignature(part, global = {}) {
  if (!part) return null;
  const params = { ...(part.params || {}) };
  for (const id of MIX_ONLY) delete params[id];
  const seq = activeSeq(part);
  if (seq && Array.isArray(seq.steps) && seq.steps.some(st => st && st.lock)) { delete params.centerX; delete params.centerY; }
  const drum = part.drum ? { on: part.drum.on, pads: (part.drum.pads || []).map(p => (p ? { ...p, sample: p.sample ? p.sample.rate : null } : p)) } : null;
  const json = JSON.stringify([
    params, part.mods || null, part.links || null, part.funcPoints || null, drum, part.trackFx || null, part.dot || null,
    part.chord || null, seq, terrainKey(part.userTerrain && part.userTerrain.A), terrainKey(part.userTerrain && part.userTerrain.B),
    FREEZE_GLOBALS.map(k => global[k]),
  ]);
  const ut = part.userTerrain || {};
  const refs = [ut.A ? ut.A.data : null, ut.B ? ut.B.data : null, part.noiseRecording || null];
  for (const p of (part.drum && part.drum.pads) || []) refs.push(p && p.sample ? p.sample.data : null);
  return [json, ...refs];
}

export function sameSignature(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Render a frozen loop with the DSP on this thread, in slices so the page
 * stays responsive. `init`: protocol messages for a fresh DSP (the session,
 * terrains and timed events, with the render starting at beat 0); `part`:
 * the track to capture; `beats` / `tempo`: the loop; `warmLoops`: passes
 * rendered before the one kept.
 * @returns {Promise<{L: Float32Array, R: Float32Array, frames: number, beats: number, tempo: number, sampleRate: number, ms: number, renderedSeconds: number}>}
 */
export async function renderFrozenLoop({ sampleRate = 48000, init = [], part, beats, tempo, warmLoops = 1, onProgress = () => {}, isCancelled = () => false }) {
  const { OroDSP } = await import('../dsp/dsp-core.js');
  const sr = sampleRate;
  const loopFrames = beats * 60 / clamp(finite(tempo, 120), 20, 400) * sr;
  if (!(loopFrames > 1)) throw new Error('The loop is too short to freeze');
  const start = Math.round(warmLoops * loopFrames);
  const keep = Math.ceil(loopFrames) + 1;
  const total = start + keep;
  const dsp = new OroDSP(sr);
  dsp.postMessage = () => {};
  for (const m of init) dsp.handleMessage(m);
  dsp.handleMessage({ t: 'watch', part: -1 });
  dsp.handleMessage({ t: 'capture', part });
  const L = new Float32Array(keep), R = new Float32Array(keep);
  const bl = new Float32Array(QUANTUM), br = new Float32Array(QUANTUM);
  const t0 = nowMs();
  let tick = nowMs();
  for (let f = 0; f < total; f += QUANTUM) {
    const n = Math.min(QUANTUM, total - f);
    dsp.process(bl, br, null, null, null, null, n, f / sr);
    // the kept pass: frames [start, start + keep)
    const a = Math.max(f, start), b = Math.min(f + n, total);
    for (let i = a; i < b; i++) { L[i - start] = bl[i - f]; R[i - start] = br[i - f]; }
    if (nowMs() - tick > YIELD_MS) {
      onProgress(f / total);
      await yieldTask();
      if (isCancelled()) throw new Error('cancelled');
      tick = nowMs();
    }
  }
  onProgress(1);
  return { L, R, frames: loopFrames, beats, tempo, sampleRate: sr, ms: nowMs() - t0, renderedSeconds: total / sr };
}

/**
 * The freeze state of every track, following the track list, with automatic
 * unfreezing when a frozen track's sound changes.
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.engine needs renderFreeze(part, opts) and setFrozen(part, loop | null)
 * @param {(bars: number, opts: {parts?: number[]}) => object[]} o.renderEvents music.renderEvents
 */
export function createFreezeController({ store, engine, renderEvents }) {
  const emitter = createEmitter();
  // per track slot: { beats, bars, sig, ms } while frozen, else null
  let frozen = Array.from({ length: MAX_PARTS }, () => null);
  // per track slot: the serial of a freeze being rendered, else 0
  let busy = new Array(MAX_PARTS).fill(0);
  let serial = 0;
  const available = !!(engine && typeof engine.renderFreeze === 'function' && typeof engine.setFrozen === 'function' && typeof renderEvents === 'function');
  const emit = () => emitter.emit('change', {});
  const offs = [];

  offs.push(watchTracks(store, ({ perm, fresh, count }) => {
    frozen = permute(frozen, perm, fresh, () => null);
    busy = permute(busy, perm, fresh, () => 0);
    for (let p = count; p < MAX_PARTS; p++) { frozen[p] = null; busy[p] = 0; }
    emit();
  }));

  function check(i) {
    const f = frozen[i];
    if (!f) return;
    const sig = freezeSignature(store.get(`parts.${i}`), store.get('global') || {});
    if (!sameSignature(sig, f.sig)) unfreeze(i, 'edit');
  }

  offs.push(store.subscribe('', (path, value, meta = {}) => {
    if (!frozen.some(Boolean) && !busy.some(Boolean)) return;
    if (meta && meta.source === 'lock') return;
    const k = String(path).split('.');
    if (k[0] === 'ui') return;
    if (k[0] === 'global') {
      if (k.length > 1 && !FREEZE_GLOBALS.includes(k[1])) return;
    } else if (k[0] === 'parts' && k.length >= 3) {
      const i = Number(k[1]);
      if (k[2] === 'params' && k.length >= 4 && MIX_ONLY.has(k[3])) return;
      if (k[2] === 'name' || k[2] === 'color' || k[2] === 'patchName') return;
      if (Number.isInteger(i) && i >= 0 && i < MAX_PARTS) { check(i); return; }
    }
    const n = partCount(store);
    for (let i = 0; i < n; i++) check(i);
  }));

  function unfreeze(i, reason = 'user') {
    if (!(i >= 0 && i < MAX_PARTS)) return false;
    const was = !!frozen[i] || !!busy[i];
    busy[i] = 0;
    if (!frozen[i]) { if (was) emit(); return false; }
    frozen[i] = null;
    try { engine.setFrozen(i, null); } catch (err) { console.error('[audio] unfreeze failed', err); }
    emit();
    emitter.emit('unfrozen', { part: i, reason });
    return true;
  }

  /**
   * Freeze track i. Resolves to { ok, reason?, ms?, beats? }. A second call
   * while one renders, an unfreeze or an edit meanwhile cancels the first.
   */
  async function freeze(i, { bars = 0 } = {}) {
    if (!available) return { ok: false, reason: 'Freeze needs the audio engine, which is not available here' };
    const part = store.get(`parts.${i}`);
    const can = canFreeze(part);
    if (!can.ok) return can;
    const global = store.get('global') || {};
    const tempo = clamp(finite(global.tempo, 120), 20, 400);
    const pBeats = patternBeats(part);
    const beats = freezeLoopBeats(pBeats, bars);
    const sig = freezeSignature(part, global);
    const my = ++serial;
    busy[i] = my;
    if (frozen[i]) { frozen[i] = null; engine.setFrozen(i, null); }
    emit();
    // where track i is now (the list may change while the loop renders)
    const indexNow = () => busy.indexOf(my);
    try {
      const loopSeconds = beats * 60 / tempo;
      const warmLoops = Math.max(1, Math.ceil(FREEZE_WARM_SECONDS / loopSeconds - EPS));
      const evBars = Math.ceil((warmLoops + 1) * beats / 4 - EPS) + 1;
      const others = usesOtherTracks(part);
      const events = renderEvents(evBars, others ? {} : { parts: [i] });
      const loop = await engine.renderFreeze(i, { events, beats, tempo, warmLoops, others, isCancelled: () => indexNow() < 0 });
      const j = indexNow();
      if (j < 0) return { ok: false, reason: 'cancelled' };
      busy[j] = 0;
      if (!sameSignature(freezeSignature(store.get(`parts.${j}`), store.get('global') || {}), sig)) {
        emit();
        return { ok: false, reason: 'The track changed while it was being frozen; try again' };
      }
      frozen[j] = { beats, bars, sig, ms: loop.ms, frames: loop.frames };
      engine.setFrozen(j, loop);
      emit();
      emitter.emit('frozen', { part: j, beats, ms: loop.ms });
      return { ok: true, ms: loop.ms, beats };
    } catch (err) {
      const j = indexNow();
      if (j >= 0) busy[j] = 0;
      emit();
      if (err && err.message === 'cancelled') return { ok: false, reason: 'cancelled' };
      console.error('[audio] freeze failed', err);
      return { ok: false, reason: (err && err.message) || 'Freeze failed' };
    }
  }

  return {
    available,
    freeze,
    unfreeze,
    toggle(i, opts) { return frozen[i] || busy[i] ? Promise.resolve({ ok: unfreeze(i), unfrozen: true }) : freeze(i, opts); },
    isFrozen: (i) => !!frozen[i],
    isBusy: (i) => !!busy[i],
    info: (i) => (frozen[i] ? { beats: frozen[i].beats, bars: frozen[i].bars, ms: frozen[i].ms } : null),
    count: () => frozen.filter(Boolean).length,
    can: (i) => canFreeze(store.get(`parts.${i}`)),
    on: (name, fn) => emitter.on(name, fn),
    off: (name, fn) => emitter.off(name, fn),
    dispose() {
      for (const o of offs) o();
      emitter.clear();
    },
  };
}
