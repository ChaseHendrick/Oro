// What the map shows for the selected part: the modulated values the audio is
// actually using (from the engine's telemetry) where a parameter is being
// modulated, otherwise the knob value straight from the store. Reading the
// store directly for unmodulated values matters for the dot: it then follows
// the pointer with zero lag instead of trailing telemetry by a frame or two.

import { PART_PARAM_MAP, fromNorm } from '../core/params.js';

// Laps and Pace joined the contract later; follow them when the registry has them.
export const VIS_IDS = ['morph', 'warp', 'lift', 'fold', 'size', 'stretch', 'rotate', 'centerX', 'centerY', 'pathParam', 'laps', 'pace']
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
