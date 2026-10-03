// Drum pattern generators (v2.8) for the drum kit's eight lanes.
//
// euclid(): k hits spread as evenly as possible over n steps (Bjorklund's
// algorithm), optionally rotated.
// grooveLanes(): a whole 8-lane pattern from a style, a complexity and a
// loudness. Each style gives every lane and step a weight; a hit is placed
// when its weight clears a threshold that falls as complexity rises, so more
// complexity only ever adds hits. A seeded wobble (the variation number)
// reorders the optional hits. Same inputs, same pattern.

import { KIT_PADS } from '../dsp/drum-kit.js';

export const DRUM_STEPS = 16;
// lanes of the default kit
const K = 0, S = 1, CH = 2, OH = 3, CL = 4, LT = 5, HT = 6, RM = 7;

/** Bjorklund: `hits` onsets over `steps` steps, rotated `rotate` steps later. Array of 0/1. */
export function euclid(hits, steps, rotate = 0) {
  const n = Math.max(0, Math.round(steps) || 0);
  const k = Math.max(0, Math.min(n, Math.round(hits) || 0));
  if (!n) return [];
  let seq;
  if (k === 0) seq = new Array(n).fill(0);
  else if (k === n) seq = new Array(n).fill(1);
  else {
    let a = Array.from({ length: k }, () => [1]);
    let b = Array.from({ length: n - k }, () => [0]);
    while (b.length > 1) {
      const m = Math.min(a.length, b.length);
      const next = [];
      for (let i = 0; i < m; i++) next.push(a[i].concat(b[i]));
      const rest = a.length > m ? a.slice(m) : b.slice(m);
      a = next; b = rest;
    }
    seq = a.flat().concat(b.flat());
  }
  const r = (((Math.round(rotate) || 0) % n) + n) % n;
  return seq.map((_, i) => seq[(i - r + n) % n]);
}

/** A copy of `lanes` with lane `row` set to a Euclidean rhythm over the first `length` steps. */
export function euclidLane(lanes, row, hits, rotate, length, vel = 0.8) {
  const len = Math.max(1, Math.min(DRUM_STEPS, Math.round(length) || DRUM_STEPS));
  const out = Array.from({ length: KIT_PADS }, (_, r) => Array.from({ length: DRUM_STEPS }, (_, c) => Number(lanes && lanes[r] && lanes[r][c]) || 0));
  const e = euclid(hits, len, rotate);
  for (let c = 0; c < DRUM_STEPS; c++) out[row][c] = c < len && e[c] ? vel : 0;
  return out;
}

export const GROOVE_STYLES = [
  { id: 'straight', label: 'Straight' },
  { id: 'half', label: 'Half-time' },
  { id: 'broken', label: 'Broken' },
  { id: 'four', label: 'Four on the floor' },
];

// Weights per style: lane -> { step: weight }. 1 = always there, lower =
// only at higher complexity, absent = never. Hats share a helper.
function hats(quarter, eighth, sixteenth) {
  const w = {};
  for (let c = 0; c < DRUM_STEPS; c++) w[c] = c % 4 === 0 ? quarter : c % 2 === 0 ? eighth : sixteenth;
  return w;
}
const STYLE_WEIGHTS = {
  straight: {
    [K]: { 0: 1, 8: 1, 10: 0.55, 6: 0.35, 14: 0.3, 3: 0.2, 11: 0.25 },
    [S]: { 4: 1, 12: 1, 7: 0.3, 9: 0.25, 15: 0.35, 2: 0.15, 13: 0.2 },
    [CH]: hats(1, 0.85, 0.35),
    [OH]: { 14: 0.45, 6: 0.2 },
    [CL]: { 4: 0.6, 12: 0.65 },
    [LT]: { 15: 0.1 },
    [HT]: { 13: 0.12 },
    [RM]: { 3: 0.15, 11: 0.15 },
  },
  half: {
    [K]: { 0: 1, 3: 0.4, 6: 0.5, 10: 0.35, 11: 0.3, 14: 0.25 },
    [S]: { 8: 1, 5: 0.3, 11: 0.25, 13: 0.3, 15: 0.35 },
    [CH]: hats(1, 0.8, 0.3),
    [OH]: { 6: 0.35, 14: 0.4 },
    [CL]: { 8: 0.6 },
    [LT]: { 14: 0.12 },
    [HT]: { 12: 0.12 },
    [RM]: { 2: 0.2, 10: 0.2 },
  },
  broken: {
    [K]: { 0: 1, 10: 0.9, 3: 0.45, 6: 0.3, 11: 0.35, 15: 0.2, 7: 0.25 },
    [S]: { 4: 1, 12: 1, 7: 0.4, 9: 0.45, 15: 0.3, 1: 0.2, 13: 0.25 },
    [CH]: hats(1, 0.9, 0.45),
    [OH]: { 2: 0.3, 10: 0.35 },
    [CL]: { 12: 0.5 },
    [LT]: { 14: 0.2 },
    [HT]: { 13: 0.15 },
    [RM]: { 5: 0.3, 11: 0.3, 15: 0.2 },
  },
  four: {
    [K]: { 0: 1, 4: 1, 8: 1, 12: 1, 15: 0.25, 7: 0.15 },
    [S]: { 4: 0.85, 12: 0.85, 13: 0.2, 7: 0.2 },
    [CH]: hats(0.3, 1, 0.45),
    [OH]: { 2: 0.7, 6: 0.7, 10: 0.7, 14: 0.7 },
    [CL]: { 4: 1, 12: 1 },
    [LT]: { 14: 0.12 },
    [HT]: { 11: 0.1 },
    [RM]: { 3: 0.3, 11: 0.3, 7: 0.2 },
  },
};

// Deterministic 0..1 from integers.
function hash01(...xs) {
  let h = 0x811c9dc5;
  for (const x of xs) { h ^= (x | 0) + 0x9e3779b9; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16; }
  return (h >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * An 8 x 16 lane pattern. style: one of GROOVE_STYLES ids; complexity and
 * loudness 0..1; fill: add a fill over the last steps; length: the pattern
 * length (steps past it stay empty); seed: variation number.
 */
export function grooveLanes({ style = 'straight', complexity = 0.5, loudness = 0.7, fill = false, length = DRUM_STEPS, seed = 0 } = {}) {
  const W = STYLE_WEIGHTS[style] || STYLE_WEIGHTS.straight;
  const si = Math.max(0, GROOVE_STYLES.findIndex(s => s.id === style));
  const c = clamp(Number(complexity) || 0, 0, 1), l = clamp(Number(loudness) || 0, 0, 1);
  const len = Math.max(1, Math.min(DRUM_STEPS, Math.round(length) || DRUM_STEPS));
  const thr = 1 - 0.95 * c;
  const base = 0.35 + 0.65 * l;
  const out = Array.from({ length: KIT_PADS }, () => new Array(DRUM_STEPS).fill(0));
  for (let r = 0; r < KIT_PADS; r++) {
    const w = W[r] || {};
    for (let st = 0; st < len; st++) {
      const wt = w[st];
      if (!(wt > 0)) continue;
      const score = wt >= 1 ? 1 : wt + (hash01(seed, si, r, st) - 0.5) * 0.12;
      if (score < thr - 1e-9) continue;
      // strong positions full, weak ones softer (ghost notes)
      const accent = wt >= 1 ? 1 : st % 4 === 0 ? 0.92 : 0.6 + 0.3 * wt;
      out[r][st] = r2(clamp(base * accent, 0.05, 1));
    }
  }
  // an open hat closes the closed hat on the same step
  for (let st = 0; st < len; st++) if (out[OH][st] > 0) out[CH][st] = 0;
  if (fill) addFill(out, len, c, base, seed);
  return out;
}

/** Replace the last steps with a snare and tom run that builds to the end. */
function addFill(out, len, c, base, seed) {
  const zone = len >= 8 ? 4 : len >= 4 ? 2 : 1;
  const z0 = len - zone;
  const keepKick = out[K][z0];
  for (let r = 0; r < KIT_PADS; r++) for (let st = z0; st < len; st++) out[r][st] = 0;
  if (keepKick > 0) out[K][z0] = keepKick;
  const order = hash01(seed, 77) < 0.5 ? [S, HT, LT, S] : [HT, S, LT, LT];
  for (let k = 0; k < zone; k++) {
    // later steps of the fill come in first as complexity rises
    const need = (zone - 1 - k) / zone;
    if (c + 0.2 < need) continue;
    const st = z0 + k, lane = zone === 1 ? S : order[(k + 4 - zone) % 4];
    out[lane][st] = r2(clamp(base * (0.7 + 0.3 * (k + 1) / zone), 0.05, 1));
    // dense fills double the snare under the toms
    if (c > 0.75 && lane !== S) out[S][st] = r2(clamp(base * 0.55, 0.05, 1));
  }
}

/** Number of hits in a lane pattern. */
export function countHits(lanes) {
  let n = 0;
  for (const row of lanes || []) for (const v of row || []) if (v > 0) n++;
  return n;
}
