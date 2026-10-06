// What the map shows for the selected part: the modulated values the audio is
// actually using (from the engine's telemetry) where a parameter is being
// modulated, otherwise the knob value straight from the store. Reading the
// store directly for unmodulated values matters for the dot: it then follows
// the pointer with zero lag instead of trailing telemetry by a frame or two.

import { PART_PARAM_MAP, fromNorm, toNorm } from '../core/params.js';

// Laps and Pace joined the contract later; follow them when the registry has them.
export const VIS_IDS = ['morph', 'warp', 'lift', 'fold', 'size', 'stretch', 'rotate', 'centerX', 'centerY', 'pathParam', 'laps', 'pace', 'pathWindow', 'pathMangle', 'pathMirror']
  .filter(id => PART_PARAM_MAP[id]);
const PERIOD = { rotate: 360, centerX: 1, centerY: 1 };

export const TELE_STALE_MS = 400;

/** True when a mod slot or a Link can move the value away from its knob. */
export function isModulated(mods, id, links) {
  const m = mods && mods[id];
  if (m && ((m.lfoDepth || 0) !== 0 || (m.envDepth || 0) !== 0)) return true;
  if (Array.isArray(links)) {
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (l && l.dst === id && (l.amt || 0) !== 0) return true;
    }
  }
  return false;
}

function baseValue(params, id) {
  const v = params ? params[id] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : PART_PARAM_MAP[id].default;
}

/**
 * Target value for one parameter. `tele` must already be filtered to fresh
 * telemetry for this part (or null). Morph always prefers telemetry because
 * the mod wheel adds to it without any mod slot.
 */
export function targetValue(id, params, mods, tele, links) {
  const base = baseValue(params, id);
  if (tele && tele.n && (id === 'morph' || isModulated(mods, id, links))) {
    const n = tele.n[id];
    if (typeof n === 'number' && Number.isFinite(n)) return fromNorm(PART_PARAM_MAP[id], n);
  }
  return base;
}

/** Shortest signed difference b - a on a circle of the given period. */
export function periodicDelta(a, b, period) {
  const d = (b - a) / period;
  return (d - Math.floor(d + 0.5)) * period;
}

/**
 * Smoothed live parameters. step() eases every value toward its target with
 * a one-pole filter (time constant tau seconds), the shortest way round for
 * the periodic ones, and wraps them back into range.
 */
export class LiveParams {
  constructor() {
    this.cur = {};
    this.target = {};
    for (const id of VIS_IDS) {
      this.cur[id] = PART_PARAM_MAP[id].default;
      this.target[id] = PART_PARAM_MAP[id].default;
    }
    this.primed = false;
  }

  setTargets(params, mods, tele, links) {
    for (let i = 0; i < VIS_IDS.length; i++) {
      const id = VIS_IDS[i];
      this.target[id] = targetValue(id, params, mods, tele, links);
    }
    if (!this.primed) { this.snap(); this.primed = true; }
  }

  snap(id) {
    if (id) { this.cur[id] = this.target[id]; return; }
    for (let i = 0; i < VIS_IDS.length; i++) this.cur[VIS_IDS[i]] = this.target[VIS_IDS[i]];
  }

  step(dt, tau) {
    const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
    for (let i = 0; i < VIS_IDS.length; i++) {
      const id = VIS_IDS[i];
      const p = PERIOD[id];
      const t = this.target[id];
      if (p) {
        let v = this.cur[id] + periodicDelta(this.cur[id], t, p) * k;
        v -= Math.floor(v / p) * p;
        this.cur[id] = v;
      } else {
        this.cur[id] += (t - this.cur[id]) * k;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-voice orbits. Telemetry carries the modulated values of the newest
// voice only, so the other voices are derived from it by what depends on the
// note: Key>Size (size x 2^(noteSize (note - 60) / 24), clamped to 0..0.5) and
// Links whose source is Key ((note - 60) / 48 through the link's curve).

export const ORBIT_IDS = ['stretch', 'size', 'rotate', 'centerX', 'centerY', 'pathParam', 'pathWindow', 'pathMangle', 'pathMirror'];
const KEY_SOURCE = 3;   // index of 'Key' in LINK_SOURCES

/** Key>Size factor for a note (the oscillator applies it per voice). */
export function noteSizeFactor(noteSize, note) {
  const k = Number.isFinite(noteSize) ? noteSize : 0;
  if (k === 0 || !Number.isFinite(note)) return 1;
  return Math.pow(2, (k * (note - 60)) / 24);
}

// Mirrors linkCurve in src/dsp/dsp-core.js (2.17 added curves 3 to 7).
function linkCurve(c, x) {
  if (c === 1) return Math.sign(x) * x * x;
  if (c === 2) return Math.sign(x) * Math.sqrt(Math.abs(x));
  if (c === 3) { const a = Math.min(1, Math.abs(x)); return Math.sign(x) * a * a * (3 - 2 * a); }
  if (c === 4) return Math.round(x * 4) / 4;
  if (c === 5) return -x;
  if (c === 6) return Math.abs(x);
  if (c === 7) return x > 0 ? x : 0;
  return x;
}

/** Sum of Key-link contributions to `id` for a note, in normalised knob units. */
export function keyLinkDelta(links, id, note) {
  if (!Array.isArray(links) || !Number.isFinite(note)) return 0;
  let d = 0;
  const x = (note - 60) / 48;
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (l && l.src === KEY_SOURCE && l.dst === id && l.amt) d += l.amt * linkCurve(l.curve | 0, x < -1 ? -1 : x > 1 ? 1 : x);
  }
  return d;
}

/**
 * Path values for a voice playing `note`, from the live values `L` (which
 * belong to the voice playing `refNote`, or to no voice when refNote is NaN).
 * Writes ORBIT_IDS into out.
 */
export function voiceLive(L, note, refNote, links, noteSize, out) {
  for (let i = 0; i < ORBIT_IDS.length; i++) {
    const id = ORBIT_IDS[i];
    let v = Number.isFinite(L[id]) ? L[id] : PART_PARAM_MAP[id].default;
    const d = keyLinkDelta(links, id, note) - (Number.isFinite(refNote) ? keyLinkDelta(links, id, refNote) : 0);
    if (d !== 0) {
      const def = PART_PARAM_MAP[id];
      let n = toNorm(def, v) + d;
      if (PERIOD[id]) n -= Math.floor(n); else n = n < 0 ? 0 : n > 1 ? 1 : n;
      v = fromNorm(def, n);
    }
    out[id] = v;
  }
  const s = out.size * noteSizeFactor(noteSize, note);
  out.size = s < 0 ? 0 : s > 0.5 ? 0.5 : s;
  return out;
}

/**
 * How different two orbits look, 0 = identical; about 1 = clearly different
 * (6 % in size, 4 degrees of rotation, 0.006 of the map, 0.05 of stretch or shape).
 */
export function orbitDifference(a, b) {
  const sa = Math.max(1e-4, a.size), sb = Math.max(1e-4, b.size);
  const size = Math.abs(Math.log(sa / sb)) / 0.06;
  const rot = Math.abs(periodicDelta(a.rotate, b.rotate, 360)) / 4 * Math.min(1, Math.max(sa, sb) * 8);
  const cen = Math.hypot(periodicDelta(a.centerX, b.centerX, 1), periodicDelta(a.centerY, b.centerY, 1)) / 0.006;
  const st = Math.abs(a.stretch - b.stretch) / 0.05;
  const sh = Math.abs(a.pathParam - b.pathParam) / 0.05;
  const window = Math.abs((a.pathWindow || 0) - (b.pathWindow || 0)) / 0.05;
  const mangle = Math.abs((a.pathMangle || 0) - (b.pathMangle || 0)) / 0.05;
  const mirror = (a.pathMirror || 0) === (b.pathMirror || 0) ? 0 : 2;
  return Math.max(size, rot, cen, st, sh, window, mangle, mirror);
}
