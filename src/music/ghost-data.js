// v2.9 Ghost replay data (see ghost.js): what a recorded ghost keeps in the
// session as parts.N.ghost, how a saved one is made safe to load, and where
// its dot is at a given beat. Pure, no browser APIs.
//
//   { bars: 1..64, startBar: whole bar it was recorded from (0 = the first bar after Play),
//     notes: [[beat, note, vel]]   vel 0 is a note-off
//     knobs: [[beat, paramId, value]]
//     dots:  [[beat, x, y]] }      the dot path (centerX / centerY), 0..1
// Beats count from the start of the ghost's first bar, in [0, bars * 4].

import { PART_PARAM_MAP, clamp } from '../core/params.js';

export const GHOST_MAX_BARS = 64;
export const GHOST_MAX_EVENTS = 20000;
/** Never recorded or replayed: they are the mix's routing, not playing. */
export const GHOST_SKIP_PARAMS = Object.freeze(['mute', 'solo', 'pedalSend', 'pedalPre', 'pedalInsert', 'centerX', 'centerY']);
const SKIP = new Set(GHOST_SKIP_PARAMS);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, k = 10000) => Math.round(v * k) / k;

/** True when a part parameter may be recorded as a knob move. */
export const ghostParam = (id) => !!PART_PARAM_MAP[id] && !SKIP.has(id);

/** A saved ghost, made safe; null when it is missing, empty or not a ghost. */
export function sanitizeGhost(src) {
  if (!src || typeof src !== 'object') return null;
  const bars = Math.round(Number(src.bars));
  if (!(bars >= 1 && bars <= GHOST_MAX_BARS)) return null;
  const len = bars * 4;
  const startBar = Math.round(clamp(fin(src.startBar) ? src.startBar : 0, 0, 100000));
  let budget = GHOST_MAX_EVENTS;
  const list = (arr, fn) => {
    const out = [];
    if (!Array.isArray(arr)) return out;
    for (const e of arr) {
      if (budget <= 0) break;
      if (!Array.isArray(e) || !fin(e[0]) || e[0] < 0 || e[0] > len) continue;
      const v = fn(e);
      if (v) { out.push(v); budget--; }
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  };
  const notes = list(src.notes, ([b, n, v]) => (fin(n) && n >= 0 && n <= 127 && fin(v) ? [round(b), Math.round(n), round(clamp(v, 0, 1), 1000)] : null));
  const knobs = list(src.knobs, ([b, id, v]) => {
    if (typeof id !== 'string' || !ghostParam(id) || !fin(v)) return null;
    const def = PART_PARAM_MAP[id];
    return [round(b), id, clamp(v, def.min, def.max)];
  });
  const dots = list(src.dots, ([b, x, y]) => (fin(x) && fin(y) ? [round(b), round(clamp(x, 0, 1), 1e5), round(clamp(y, 0, 1), 1e5)] : null));
  if (!notes.length && !knobs.length && !dots.length) return null;
  return { bars, startBar, notes, knobs, dots };
}

/** Index of the first entry of a beat-sorted list with beat >= b. */
export function lowerBound(list, b) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] < b) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Position of absolute transport beat `beat` inside the ghost's loop (0..bars*4). */
export function loopBeat(ghost, beat) {
  const len = ghost.bars * 4;
  const x = (beat - ghost.startBar * 4) % len;
  return x < 0 ? x + len : x;
}

/** Where the ghost's dot is at absolute beat `beat`: { u, v } (between path points), or null without a path. */
export function dotAtBeat(ghost, beat) {
  const dots = ghost && ghost.dots;
  if (!dots || !dots.length) return null;
  const b = loopBeat(ghost, beat);
  const i = lowerBound(dots, b + 1e-9) - 1;
  if (i < 0) return { u: dots[0][1], v: dots[0][2] };
  const a = dots[i], n = dots[i + 1];
  if (!n || n[0] <= a[0]) return { u: a[1], v: a[2] };
  const f = (b - a[0]) / (n[0] - a[0]);
  // the map wraps: move the short way round
  const du = n[1] - a[1], dv = n[2] - a[2];
  const su = Math.abs(du) > 0.5 ? du - Math.sign(du) : du, sv = Math.abs(dv) > 0.5 ? dv - Math.sign(dv) : dv;
  const w = (x) => x - Math.floor(x);
  return { u: w(a[1] + su * f), v: w(a[2] + sv * f) };
}

/** Counts for the status line. */
export function ghostSummary(ghost) {
  if (!ghost) return null;
  return {
    bars: ghost.bars, startBar: ghost.startBar,
    notes: ghost.notes.filter(e => e[2] > 0).length,
    knobs: ghost.knobs.length,
    dots: ghost.dots.length,
  };
}
