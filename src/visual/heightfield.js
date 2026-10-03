// CPU mirror of the displayed terrain.
//
// The GPU shader, the orbit line, the marble, picking and the physics all read
// heights through this one object, built on the same table lookup, warp and
// morph as the audio (src/dsp/terrain-math.js). So the line sits exactly on
// the land you see, and the land you see is the land you hear.
//
// World mapping (docs/ARCHITECTURE.md): x = (u - 0.5) W, z = (v - 0.5) W,
// y = h * H * min(lift, 2.5). The plane shows 3 x 3 tiles; every lookup wraps.

import { sampleBilinear, warpPoint, wrap01, wrapDelta } from '../dsp/terrain-math.js';

export const W = 10;
export const H = 1.6;
export const TILES = 3;
export const EXTENT = (W * TILES) / 2;
export const MAX_LIFT = 2.5;

export { wrap01, wrapDelta };

/** Displayed height scale for a Lift value: Lift is gain in the audio, capped here so peaks stay on screen. */
export function displayLift(lift) {
  const l = Number.isFinite(lift) ? lift : 1;
  return l < 0 ? 0 : l > MAX_LIFT ? MAX_LIFT : l;
}

export function uToX(u) { return (u - 0.5) * W; }
export function xToU(x) { return x / W + 0.5; }

/** Shift a world coordinate by whole tiles so it lands in the centre tile [-W/2, W/2). */
export function wrapWorld(x) {
  return x - W * Math.floor(x / W + 0.5);
}

function makeSlot() {
  return { data: null, size: 0, prev: null, prevSize: 0, fade: 1 };
}

const _wp = { u: 0, v: 0 };

export class HeightField {
  constructor() {
    this.A = makeSlot();
    this.B = makeSlot();
    this.morph = 0;
    this.warp = 0;
    this.lift = 1;          // displayed scale, already passed through displayLift()
    // Bumped whenever the surface changes shape, so consumers (physics
    // colliders, the minimap image) know when to rebuild.
    this.version = 0;
    this.tableVersion = 0; // source-only revision for cached CPU sample grids
  }

  slot(s) { return s === 'B' || s === 1 ? this.B : this.A; }

  /**
   * Install a table for slot 'A' | 'B'. With crossfade the previous table is
   * kept and blended out as fade goes 0 -> 1 (the GPU does the same).
   */
  setTable(s, data, size, crossfade = false) {
    const sl = this.slot(s);
    if (crossfade && sl.data && sl.data !== data) {
      sl.prev = sl.data;
      sl.prevSize = sl.size;
      sl.fade = 0;
    } else {
      sl.prev = null;
      sl.prevSize = 0;
      sl.fade = 1;
    }
    sl.data = data || null;
    sl.size = data ? size : 0;
    this.version++;
    this.tableVersion++;
  }

  /** Advance a slot's crossfade; returns the new fade. */
  setFade(s, f) {
    const sl = this.slot(s);
    const v = f >= 1 ? 1 : f <= 0 ? 0 : f;
    if (v !== sl.fade) {
      sl.fade = v;
      if (v >= 1) { sl.prev = null; sl.prevSize = 0; }
      this.version++;
    }
    return sl.fade;
  }

  /** Update morph / warp / displayed lift; bumps version only on real change. */
  setShape(morph, warp, lift) {
    const l = displayLift(lift);
    if (morph !== this.morph || warp !== this.warp || l !== this.lift) {
      this.morph = morph;
      this.warp = warp;
      this.lift = l;
      this.version++;
    }
  }

  get ready() { return !!(this.A.data || this.B.data); }

  /** Largest table side in use (sets the picking / gradient resolution). */
  get resolution() {
    return Math.max(this.A.size, this.B.size, this.A.prevSize, this.B.prevSize, 64);
  }

  sampleSlot(sl, u, v) {
    if (!sl.data) return 0;
    const c = sampleBilinear(sl.data, sl.size, u, v);
    if (sl.fade >= 1 || !sl.prev) return c;
    const p = sampleBilinear(sl.prev, sl.prevSize, u, v);
    return p + (c - p) * sl.fade;
  }

  /**
   * Normalised height (before Lift) at terrain coordinates (u, v), any real
   * values. Same branch structure as terrainHeight() in terrain-math.js, so
   * with no crossfade running the result is bit-identical to the audio lookup.
   */
  norm(u, v) {
    const warp = this.warp;
    if (warp > 0) { warpPoint(u, v, warp, _wp); u = _wp.u; v = _wp.v; }
    const morph = this.morph;
    if (morph <= 0 || !this.B.data) return this.sampleSlot(this.A, u, v);
    if (morph >= 1) return this.sampleSlot(this.B, u, v);
    const a = this.sampleSlot(this.A, u, v);
    return a + morph * (this.sampleSlot(this.B, u, v) - a);
  }

  /** World height at terrain coordinates. */
  y(u, v) { return this.norm(u, v) * H * this.lift; }

  /** World height at world position (x, z). */
  yAt(x, z) { return this.norm(x / W + 0.5, z / W + 0.5) * H * this.lift; }

  /** Conservative bound on |y| (tables are normalised to max|h| = 1, blends are convex). */
  bound() { return H * this.lift; }

  /** World-space slope (dy/dx, dy/dz) by central differences at half a texel. */
  gradient(x, z, out) {
    const e = (0.5 * W) / this.resolution;
    out.x = (this.yAt(x + e, z) - this.yAt(x - e, z)) / (2 * e);
    out.z = (this.yAt(x, z + e) - this.yAt(x, z - e)) / (2 * e);
    return out;
  }
}

const _clip = { t0: 0, t1: 0 };

// Narrow [t0, t1] to where o + t d lies within [lo, hi]; false when empty.
function clipAxis(o, d, lo, hi) {
  if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
  let a = (lo - o) / d, b = (hi - o) / d;
  if (a > b) { const t = a; a = b; b = t; }
  if (a > _clip.t0) _clip.t0 = a;
  if (b < _clip.t1) _clip.t1 = b;
  return _clip.t0 <= _clip.t1;
}

/**
 * First intersection of a ray with the displayed surface (all 3 x 3 tiles).
 * The ray is clipped to the slab |y| <= bound and the square |x|, |z| <= extent,
 * marched in steps of under half a texel of horizontal travel (the surface is
 * bilinear per texel, so no feature is narrower than that), then the sign
 * change is refined by bisection.
 *
 * Writes out.x, out.y, out.z, out.t, out.u, out.v (u, v unwrapped) and returns
 * true on a hit. `d` need not be normalised.
 */
export function intersectRay(hf, ox, oy, oz, dx, dy, dz, out, extent = EXTENT) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0)) return false;
  dx /= len; dy /= len; dz /= len;
  const top = hf.bound() + 1e-3;
  _clip.t0 = 0; _clip.t1 = Infinity;
  if (!clipAxis(oy, dy, -top, top)) return false;
  if (!clipAxis(ox, dx, -extent, extent)) return false;
  if (!clipAxis(oz, dz, -extent, extent)) return false;
  const t0 = _clip.t0, t1 = _clip.t1;
  if (!(t1 > t0) || !Number.isFinite(t1)) return false;

  const horiz = Math.sqrt(dx * dx + dz * dz);
  const texel = W / hf.resolution;
  // Under half a texel horizontally, and never more than a 20th of the slab
  // vertically so near-vertical rays still take a few samples.
  let dt = Math.min(horiz > 1e-9 ? (0.45 * texel) / horiz : Infinity, (2 * top) / 20 / Math.max(Math.abs(dy), 1e-9));
  const maxSteps = 24000;
  if ((t1 - t0) / dt > maxSteps) dt = (t1 - t0) / maxSteps;

  let ta = t0;
  let fa = oy + ta * dy - hf.yAt(ox + ta * dx, oz + ta * dz);
  let above = fa > 0;
  while (ta < t1) {
    const tb = Math.min(ta + dt, t1);
    const fb = oy + tb * dy - hf.yAt(ox + tb * dx, oz + tb * dz);
    if (above && fb <= 0) {
      let lo = ta, hi = tb, flo = fa;
      for (let i = 0; i < 48 && hi - lo > 1e-7; i++) {
        const mid = 0.5 * (lo + hi);
        const fm = oy + mid * dy - hf.yAt(ox + mid * dx, oz + mid * dz);
        if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else { hi = mid; }
      }
      const t = 0.5 * (lo + hi);
      out.t = t;
      out.x = ox + t * dx;
      out.z = oz + t * dz;
      out.y = hf.yAt(out.x, out.z);
      out.u = out.x / W + 0.5;
      out.v = out.z / W + 0.5;
      return true;
    }
    if (fb > 0) above = true;
    ta = tb; fa = fb;
  }
  return false;
}

/** Ray vs sphere (centre c, radius r): nearest t >= 0 or -1. */
export function intersectSphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= len; dy /= len; dz /= len;
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t = -b - s;
  if (t >= 0) return t;
  const t2 = -b + s;
  return t2 >= 0 ? t2 : -1;
}
