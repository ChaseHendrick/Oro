// Explore mode: the marble roams the map under a slowly turning push (as if
// someone were gently tilting the board round and round) and the visuals
// report every peak and valley it passes, so the music module can play an
// in-key note there.
//
// Two small pieces, both pure and allocation-free per step:
//   Explorer           the push: direction turns slowly, strength follows
//                      dot.exploreRate, and it grows when the marble is stuck
//                      in a hollow so it always moves on.
//   ExtremumDetector   zig-zag detection with hysteresis on the height under
//                      the marble: a peak counts only once the height has
//                      fallen back by `delta`, a valley once it has risen by
//                      `delta`, and events closer than a refractory time are
//                      swallowed. Small wobbles and a marble settling in a
//                      dip therefore never chatter.

import { G } from './physics.js';
import { mulberry32, TAU } from '../dsp/terrain-math.js';

export const PEAK = 1, VALLEY = -1;

function clamp01(v) { return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0.5; }

/** Hysteresis (in normalised height, the land spans -1..1) for an Explore rate 0..1. */
export function exploreDelta(rate) { return 0.3 - 0.2 * clamp01(rate); }

/** Shortest time between two notes (s) for an Explore rate 0..1. */
export function exploreRefractory(rate) { return 0.75 - 0.55 * clamp01(rate); }

/** Base push strength as a fraction of the part's gravity for an Explore rate 0..1. */
export function windFraction(rate) { return 0.08 + 0.3 * clamp01(rate); }

// Extra push while stuck, as a fraction of gravity. A slope can hold the marble
// back with at most half of gravity (g |f'| / (1 + f'^2) peaks at |f'| = 1), so
// base + boost above that always gets it out of any hollow.
const BOOST = 0.6;

/** Seconds per full turn of the push direction for an Explore rate 0..1. */
export function windPeriod(rate) { return 40 - 26 * clamp01(rate); }

export class ExtremumDetector {
  constructor() {
    this.dir = 0;          // +1 climbing (tracking a maximum), -1 falling (tracking a minimum), 0 not yet known
    this.hi = 0; this.hiU = 0; this.hiV = 0;
    this.lo = 0; this.loU = 0; this.loV = 0;
    this.since = Infinity; // seconds since the last reported event
    this.primed = false;
    // The last detected extremum (valid right after push() returns non-zero).
    this.kind = 0; this.height = 0; this.u = 0; this.v = 0;
  }

  /** Start over at height h (e.g. after a teleport, so the jump is not a 'peak'). */
  reset(h, u, v) {
    this.dir = 0;
    this.hi = this.lo = h;
    this.hiU = this.loU = u;
    this.hiV = this.loV = v;
    this.primed = true;
  }

  /**
   * Feed one sample. Returns PEAK, VALLEY or 0. `delta` is the hysteresis and
   * `refractory` the minimum time between reported events; a turn inside the
   * refractory time still flips the state (so the next one is judged from
   * the right extreme) but is not reported.
   */
  push(h, u, v, dt, delta, refractory) {
    this.since += dt;
    if (!this.primed) { this.reset(h, u, v); return 0; }
    let found = 0;
    if (this.dir === 0) {
      // Where the marble started is not an extremum it passed: the first
      // clear move only tells which way it is going.
      if (h > this.hi) { this.hi = h; this.hiU = u; this.hiV = v; }
      if (h < this.lo) { this.lo = h; this.loU = u; this.loV = v; }
      if (h - this.lo >= delta) this.dir = 1;
      else if (this.hi - h >= delta) this.dir = -1;
      return 0;
    }
    if (this.dir > 0) {
      if (h > this.hi) { this.hi = h; this.hiU = u; this.hiV = v; }
      if (this.hi - h >= delta) {
        found = PEAK;
        this.kind = PEAK; this.height = this.hi; this.u = this.hiU; this.v = this.hiV;
        this.dir = -1;
        this.lo = h; this.loU = u; this.loV = v;
      }
    } else {
      if (h < this.lo) { this.lo = h; this.loU = u; this.loV = v; }
      if (h - this.lo >= delta) {
        found = VALLEY;
        this.kind = VALLEY; this.height = this.lo; this.u = this.loU; this.v = this.loV;
        this.dir = 1;
        this.hi = h; this.hiU = u; this.hiV = v;
      }
    }
    if (!found) return 0;
    if (this.since < refractory) return 0;
    this.since = 0;
    return found;
  }
}

/**
 * The turning push for one part. step() advances it and writes the
 * horizontal acceleration (world units / s^2) into out.x / out.z.
 */
export class Explorer {
  constructor(seed = 1) {
    const rng = mulberry32(0x5eed + seed * 7919);
    this.angle = rng() * TAU;
    this.t = rng() * 50;
    this.wobble = 0.21 + 0.1 * rng();
    this.boost = 0;        // extra push (fraction of g) while the marble is stuck
    this.quiet = 0;        // seconds without a note
    this.slow = 0;         // seconds spent nearly at rest
    this.loiter = 0;       // seconds spent sloshing around the same spot
    this.au = NaN; this.av = NaN; // slowly following anchor (torus coordinates)
    this.detector = new ExtremumDetector();
  }

  /** A new start (mode entered, dot moved by hand): forget the past. */
  reset(h, u, v) {
    this.boost = 0;
    this.quiet = 0;
    this.slow = 0;
    this.loiter = 0;
    this.au = u; this.av = v;
    this.detector.reset(h, u, v);
  }

  /** Call when an event fired: the marble is doing its job, ease off. */
  heard() { this.quiet = 0; }

  /**
   * Advance by dt and write the push (world units / s^2) for gravity g into
   * out. u, v: where the marble is (to notice it sloshing in one hollow).
   */
  step(dt, rate, speed, out, g = G, u = NaN, v = NaN) {
    const r = clamp01(rate);
    this.t += dt;
    // Direction: a steady turn with a slow wobble, so the route never repeats exactly.
    const turn = TAU / windPeriod(r);
    this.angle += dt * turn * (1 + 0.6 * Math.sin(this.wobble * this.t));
    if (this.angle > TAU) this.angle -= TAU;
    // Stuck: no note for a while, or hardly moving. Lean harder until it escapes.
    this.quiet += dt;
    this.slow = speed < 0.35 ? this.slow + dt : 0;
    // A marble rocking to and fro in one hollow still plays notes, but it is
    // not exploring: watch how far it gets from a slowly following anchor.
    if (Number.isFinite(u) && Number.isFinite(v)) {
      if (!Number.isFinite(this.au)) { this.au = u; this.av = v; }
      const du = u - this.au - Math.round(u - this.au), dv = v - this.av - Math.round(v - this.av);
      const k = Math.min(1, dt / 4);
      this.au += du * k; this.av += dv * k;
      this.au -= Math.floor(this.au); this.av -= Math.floor(this.av);
      this.loiter = du * du + dv * dv < 0.1 * 0.1 ? this.loiter + dt : Math.max(0, this.loiter - 2 * dt);
    }
    const patience = 1.5 + 3 * (1 - r);
    const stuck = this.quiet > patience || this.slow > 1 || this.loiter > 2 * patience;
    const target = stuck ? BOOST : 0;
    this.boost += (target - this.boost) * Math.min(1, dt * (stuck ? 1.2 : 2));
    const k = (windFraction(r) + this.boost) * g;
    out.x = Math.cos(this.angle) * k;
    out.z = Math.sin(this.angle) * k;
    return out;
  }
}
