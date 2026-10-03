// Imprint (2.10): turn a sound into a landscape.
//
//   analyseImprint(samples, sampleRate)  finds the note's period (the guitar
//       capture's MPM analysis, src/pedals/guitar.js captureToWavetable) and
//       cuts phase-aligned, band-limited single cycles from the attack to the
//       decay, in time order.
//   orbitPoints(params, K, scale)  the K map points the engine's dot passes
//       through over one cycle with the track's current path settings (shape,
//       order, Shape, Size, Stretch, Rotate, Dot X/Y, Laps, Pace, Travel,
//       Direction, Window, Mangle, Mirror, Warp), exactly as the DSP maps them
//       (see orbitMean in src/dsp/dsp-core.js). Spin, Key>Size, modulation and
//       unison Map spread are not included.
//   imprintHeights(...)  writes each cycle along its ring (every pixel within
//       2 px of the path takes the value of the nearest stretch of the cycle,
//       so bilinear reads on the path return the cycle), then fills the rest of
//       the map: G, the smoothest (harmonic) land through the rings, and B + D,
//       the old land with the rings set in smoothly (D is the ring's difference
//       from the old land, spread by a screened Laplace fill that dies away
//       within about 24 px). Strength blends them: the result is
//       Strength * G + (1 - Strength) * (B + D), and on the rings it is always
//       the cycle. The fills are solved by over-relaxation on a 128 x 128 grid
//       (initialised from 32 and 64), interpolated up, then relaxed near the
//       rings at full size.
//   imprintTerrain(...)  all of it -> a UserTerrain (kind image, 512 x 512,
//       wrap tiling, 16 bits) ready for addUserTerrain.
//
// Time mode puts successive cycles on rings: the current orbit scaled to Size
// TIME_SIZES[0] .. TIME_SIZES[1], earliest cycle innermost, so turning Size
// scans through the recording.

import { pathPoint, shapePathPoint, paceWarp, pingPong, evenPhase } from '../dsp/paths.js';
import { fastSin, fastCos } from '../dsp/terrain-math.js';
import { captureToWavetable } from '../pedals/guitar.js';
import { heightsToPlanes } from './heightmap.js';
import { bytesToBase64 } from './importers.js';

export const IMPRINT_SIZE = 512;
export const IMPRINT_CYCLE = 512;
export const IMPRINT_MODES = Object.freeze(['Single', 'Time']);
/** Size (orbit radius) of the innermost and outermost ring in Time mode. */
export const TIME_SIZES = Object.freeze([0.06, 0.46]);
export const MAX_RINGS = 32;
const SPLAT_R = 2;          // px: pixels this close to a ring take its value
const BAND_R = 8;           // px: relaxed after the coarse fill
const BLEND_PX = 24;        // px: how far a ring's difference from the old land spreads
const COARSE = 128;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * A recording -> its pitch and single cycles (IMPRINT_CYCLE samples each,
 * zero mean, time order).
 * @returns {{ok: true, freq: number, note: number, frames: Float64Array[], clarity: number}|{ok: false, reason: string}}
 */
export function analyseImprint(samples, sampleRate, { frames = MAX_RINGS } = {}) {
  const res = captureToWavetable(samples, sampleRate, {
    name: 'Imprint', width: IMPRINT_CYCLE, frames: clamp(Math.round(frames), 2, MAX_RINGS), minFreq: 40, maxFreq: 1500, normalize: 'each',
  });
  if (!res.ok) return { ok: false, reason: res.reason.replace('Capture', 'Imprint') };
  return { ok: true, freq: res.freq, note: res.note, frames: res.frames, clarity: res.clarity };
}

/** One cycle for a Single imprint: a frame a third of the way in, past the attack. */
export function steadyCycle(frames) {
  return frames[Math.min(frames.length - 1, Math.floor(frames.length / 3))];
}

/**
 * Map points of one cycle of the orbit: Float64Array [u0, w0, u1, w1, ...]
 * (map units, not wrapped). `scale` multiplies Size (Time mode rings).
 */
export function orbitPoints(params, K = 4096, scale = 1, sizeOverride = null) {
  const p = params || {};
  const shape = Math.max(0, Math.round(num(p.pathShape, 0)));
  const order = clamp(Math.round(num(p.pathOrder, 2)), 1, 8);
  const param = clamp(num(p.pathParam, 0.5), 0, 1);
  const size = (sizeOverride !== null ? sizeOverride : num(p.size, 0.22)) * scale;
  const ax = Math.exp(num(p.stretch, 0) * 1.5 * Math.LN2);
  const sx = ax * size, sy = size / ax;
  const th = num(p.rotate, 0) / 360;
  const c = fastCos(th), s = fastSin(th);
  const tA = sx * c, tB = sy * s, tC = sx * s, tD = sy * c;
  const cx = num(p.centerX, 0.5), cy = num(p.centerY, 0.5);
  const L = Math.max(1, num(p.laps, 1)), pc = clamp(num(p.pace, 0), -1, 1), shp = clamp(Math.round(num(p.paceShape, 0)), 0, 2);
  const trav = (Math.round(num(p.direction, 0)) === 1 ? 1 : 0) | (Math.round(num(p.traverse, 0)) === 1 ? 2 : 0);
  const win = clamp(num(p.pathWindow, 0), 0, 1), mangle = clamp(num(p.pathMangle, 0), -1, 1), mirror = clamp(Math.round(num(p.pathMirror, 0)), 0, 3);
  const warp = clamp(num(p.warp, 0), 0, 1);
  const plain = L === 1 && pc === 0 && trav === 0;
  const out = new Float64Array(2 * K), pt = { x: 0, y: 0 };
  for (let i = 0; i < K; i++) {
    let t = i / K;
    if (!plain) {
      t = L * paceWarp(t, pc, shp); t -= Math.floor(t);
      if (trav & 1) t = pingPong(t);
      if (trav & 2) t = evenPhase(shape, order, param, t);
    }
    pathPoint(shape, t, order, param, pt);
    if (win || mangle || mirror) shapePathPoint(pt.x, pt.y, t, win, mangle, mirror, pt);
    let u = cx + pt.x * tA - pt.y * tB;
    let w = cy + pt.x * tC + pt.y * tD;
    if (warp > 0) {
      const ww = warp * 0.06;
      const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
      w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
      u = u2;
    }
    out[2 * i] = u; out[2 * i + 1] = w;
  }
  return out;
}

/** Periodic cubic read of a cycle at phase x in [0, 1). */
function cycleAt(c, x) {
  const n = c.length, p = (x - Math.floor(x)) * n, i = Math.floor(p), t = p - i;
  const y0 = c[(i - 1 + n) % n], y1 = c[i % n], y2 = c[(i + 1) % n], y3 = c[(i + 2) % n];
  return y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
}

/** Zero-mean copy scaled to peak 1. */
export function normaliseCycle(c) {
  const n = c.length, out = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) m += c[i];
  m /= n;
  let pk = 0;
  for (let i = 0; i < n; i++) { out[i] = c[i] - m; pk = Math.max(pk, Math.abs(out[i])); }
  if (pk > 1e-12) for (let i = 0; i < n; i++) out[i] /= pk;
  return out;
}

/** Path length in pixels (for the sample count along a ring). */
function ringLengthPx(pts, S) {
  let len = 0;
  const K = pts.length >> 1;
  for (let i = 0; i < K; i++) {
    const j = (i + 1) % K;
    len += Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
  }
  return len * S;
}

/**
 * Splat rings into value/weight accumulators on the S x S torus.
 * rings: [{pts, cycle}], pts from orbitPoints. Returns {val, wgt, band}.
 */
export function splatRings(rings, S) {
  const acc = new Float64Array(S * S), wgt = new Float64Array(S * S), band = new Uint8Array(S * S);
  const R = SPLAT_R, B = BAND_R;
  for (const { pts, cycle } of rings) {
    const K0 = pts.length >> 1;
    // about 4 samples per pixel along the ring
    const K = Math.max(K0, Math.ceil(ringLengthPx(pts, S) * 4));
    for (let k = 0; k < K; k++) {
      const x = k / K;
      // linear position between the given orbit points
      const f = x * K0, i0 = Math.floor(f) % K0, i1 = (i0 + 1) % K0, fr = f - Math.floor(f);
      const u = (pts[2 * i0] + fr * (pts[2 * i1] - pts[2 * i0])) * S;
      const w = (pts[2 * i0 + 1] + fr * (pts[2 * i1 + 1] - pts[2 * i0 + 1])) * S;
      const v = cycleAt(cycle, x);
      const xi = Math.floor(u), yi = Math.floor(w);
      for (let dy = -B; dy <= B + 1; dy++) {
        const py = yi + dy, ry = (((py % S) + S) % S) * S;
        for (let dx = -B; dx <= B + 1; dx++) {
          const px = xi + dx;
          const d = Math.hypot(px - u, py - w);
          if (d > B) continue;
          const idx = ry + (((px % S) + S) % S);
          band[idx] = 1;
          if (d >= R) continue;
          const g = (1 - d / R) * (1 - d / R) + 1e-6;
          acc[idx] += g * v; wgt[idx] += g;
        }
      }
    }
  }
  for (let i = 0; i < S * S; i++) if (wgt[i] > 0) acc[i] /= wgt[i];
  return { val: acc, wgt, band };
}

/** Area average of an S x S field to n x n (S a multiple of n), weighted by `w` when given. */
function downsample(src, S, n, w = null) {
  const f = S / n, out = new Float64Array(n * n), ow = new Float64Array(n * n);
  for (let y = 0; y < S; y++) {
    const Y = Math.floor(y / f) * n;
    for (let x = 0; x < S; x++) {
      const i = y * S + x, o = Y + Math.floor(x / f);
      const g = w ? w[i] : 1;
      out[o] += g * src[i]; ow[o] += g;
    }
  }
  for (let i = 0; i < n * n; i++) out[i] = ow[i] > 0 ? out[i] / ow[i] : 0;
  return { val: out, wgt: ow };
}

/** Bilinear periodic upsample of an n x n field to S x S. */
function upsample(src, n, S) {
  const out = new Float64Array(S * S), f = n / S;
  for (let y = 0; y < S; y++) {
    const gy = (y + 0.5) * f - 0.5, y0 = Math.floor(gy), ty = gy - y0;
    const r0 = ((y0 % n) + n) % n * n, r1 = (((y0 + 1) % n) + n) % n * n;
    for (let x = 0; x < S; x++) {
      const gx = (x + 0.5) * f - 0.5, x0 = Math.floor(gx), tx = gx - x0;
      const c0 = ((x0 % n) + n) % n, c1 = (((x0 + 1) % n) + n) % n;
      const a = src[r0 + c0] + tx * (src[r0 + c1] - src[r0 + c0]);
      const b = src[r1 + c0] + tx * (src[r1 + c1] - src[r1 + c0]);
      out[y * S + x] = a + ty * (b - a);
    }
  }
  return out;
}

/**
 * Over-relaxed Gauss-Seidel (red-black) on the n x n torus for
 * (4 + k2) X = sum of neighbours, with X fixed where fixed[i] (values in X).
 * `mask` (optional) limits the update to those cells.
 */
function relax(X, fixed, n, k2, iters, omega, mask = null) {
  const d = 4 + k2;
  for (let it = 0; it < iters; it++) {
    for (let colour = 0; colour < 2; colour++) {
      for (let y = 0; y < n; y++) {
        const up = ((y + n - 1) % n) * n, dn = ((y + 1) % n) * n, row = y * n;
        for (let x = (y + colour) & 1; x < n; x += 2) {
          const i = row + x;
          if (fixed[i] || (mask && !mask[i])) continue;
          const l = row + (x === 0 ? n - 1 : x - 1), r = row + (x === n - 1 ? 0 : x + 1);
          const gs = (X[l] + X[r] + X[up + x] + X[dn + x]) / d;
          X[i] += omega * (gs - X[i]);
        }
      }
    }
  }
}

/**
 * Fill from fixed values (val where fixed) over the torus at n x n:
 * screened by `k2px` (per pixel^2 at the full size S), solved coarse to fine
 * from 32 x 32. Returns the n x n field.
 */
function solveFill(val, wgt, S, n, k2px) {
  let X = null, m = 32;
  for (; m <= n; m *= 2) {
    const { val: v, wgt: w } = downsample(val, S, m, wgt);
    const fixed = new Uint8Array(m * m);
    const need = (S / m) * (S / m) * 0.08;   // a cell is fixed when rings cover ~8% of it
    let any = false;
    for (let i = 0; i < m * m; i++) if (w[i] > need) { fixed[i] = 1; any = true; }
    const Y = X ? upsample(X, m / 2, m) : new Float64Array(m * m);
    for (let i = 0; i < m * m; i++) if (fixed[i]) Y[i] = v[i];
    if (!any) return new Float64Array(n * n);
    const h = S / m;
    relax(Y, fixed, m, k2px * h * h, m === 32 ? 300 : 120, 1.85);
    X = Y;
  }
  return X;
}

/**
 * The imprinted heights (Float64Array S x S, not normalised).
 * @param {object} o
 * @param {Float32Array|Float64Array|null} o.base the old land, S x S (null = flat)
 * @param {{pts: Float64Array, cycle: Float64Array}[]} o.rings
 * @param {number} o.strength 0..1
 * @param {number} [o.size] S
 */
export function imprintHeights({ base = null, rings, strength = 0.6, size: S = IMPRINT_SIZE }) {
  const s = clamp(num(strength, 0.6), 0, 1);
  const { val, wgt, band } = splatRings(rings, S);
  const fixed = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) if (wgt[i] > 0.05) fixed[i] = 1;
  const B = new Float64Array(S * S);
  if (base) for (let i = 0; i < S * S; i++) B[i] = num(base[i], 0);
  // G: harmonic fill of the ring values; D: screened fill of their difference from the old land
  const n = Math.min(COARSE, S);
  const G = s > 0 ? upsample(solveFill(val, wgt, S, n, 0), n, S) : null;
  const diff = new Float64Array(S * S);
  for (let i = 0; i < S * S; i++) if (wgt[i] > 0) diff[i] = val[i] - B[i];
  const D = s < 1 ? upsample(solveFill(diff, wgt, S, n, 1 / (BLEND_PX * BLEND_PX)), n, S) : null;
  const F = new Float64Array(S * S);
  for (let i = 0; i < S * S; i++) {
    const old = D ? B[i] + D[i] : 0;
    F[i] = fixed[i] ? val[i] : (G ? s * G[i] : 0) + (1 - s) * old;
  }
  // smooth the seam between the exact rings and the coarse fill
  relax(F, fixed, S, 0, 24, 1.5, band);
  return F;
}

/** Resample a square table (size x size) to S x S, bilinear and periodic. */
export function resampleTable(data, size, S = IMPRINT_SIZE) {
  if (!data || !(size >= 2)) return null;
  if (size === S) return data;
  return upsample(data, size, S);
}

/**
 * Everything: cycles + orbit settings + old land -> a UserTerrain.
 * @param {object} o
 * @param {Float64Array[]} o.frames single cycles in time order
 * @param {'single'|'time'} o.mode
 * @param {object} o.params the track's params (path settings)
 * @param {{size:number, data:Float32Array}|null} o.base the slot's current table
 * @param {number} o.strength 0..1
 * @param {string} o.name
 */
export function imprintTerrain({ frames, mode = 'single', params = {}, base = null, strength = 0.6, name = 'Imprint', size: S = IMPRINT_SIZE }) {
  if (!frames || !frames.length) throw new Error('There is no cycle to imprint');
  const rings = [];
  if (mode === 'time') {
    const count = Math.min(MAX_RINGS, frames.length);
    for (let k = 0; k < count; k++) {
      const src = frames[Math.round(k * (frames.length - 1) / Math.max(1, count - 1))];
      const sz = TIME_SIZES[0] + (TIME_SIZES[1] - TIME_SIZES[0]) * (count === 1 ? 0 : k / (count - 1));
      rings.push({ pts: orbitPoints(params, 2048, 1, sz), cycle: normaliseCycle(src) });
    }
  } else {
    rings.push({ pts: orbitPoints(params, 4096), cycle: normaliseCycle(steadyCycle(frames)) });
  }
  const B = base ? resampleTable(base.data, base.size, S) : null;
  const F = imprintHeights({ base: B, rings, strength, size: S });
  const planes = heightsToPlanes(F);
  return { name: String(name || 'Imprint').slice(0, 80), kind: 'image', w: S, h: S, mirror: 0, data: bytesToBase64(planes.hi), lo: bytesToBase64(planes.lo) };
}

/** The Size at which Time mode's ring k of `count` sits (for the status line and tests). */
export function timeRingSize(k, count) {
  return TIME_SIZES[0] + (TIME_SIZES[1] - TIME_SIZES[0]) * (count <= 1 ? 0 : k / (count - 1));
}
