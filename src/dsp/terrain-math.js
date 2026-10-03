// Shared pure maths for Oro's terrain synthesis.
//
// Everything here is used by more than one consumer (the audio worklet, the
// terrain generators, the 3D visuals) so that what you hear and what you see
// are computed by literally the same formulas. No DOM, no allocation in the
// per-sample helpers.
//
// Table convention: a terrain table of side `size` stores h(u, v) at
// u = i / size, v = j / size in data[j * size + i]; lookups wrap on the torus.

export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function wrap01(x) { return x - Math.floor(x); }

/** Signed difference a - b folded into [-0.5, 0.5): shortest way round a unit circle. */
export function wrapDelta(a, b) {
  const d = a - b;
  return d - Math.floor(d + 0.5);
}

/** Cubic Hermite step (C1). */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Quintic step (C2), used where second-derivative kinks would show as creases. */
export function smootherstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// ---------------------------------------------------------------------------
// Fast sine. The argument is in CYCLES (fastSin(x) = sin(2πx)), which is what
// every oscillator / path / warp formula naturally produces, and saves the 2π
// multiply. 4096 points with linear interpolation: max error ~3e-7 (-130 dB).
// The floor + mask form is ~4x quicker in V8 than wrapping the argument first.

export const SIN_TABLE_SIZE = 4096;
const SIN_MASK = SIN_TABLE_SIZE - 1;
const SIN_T = new Float64Array(SIN_TABLE_SIZE + 1);
const SIN_D = new Float64Array(SIN_TABLE_SIZE);
for (let i = 0; i <= SIN_TABLE_SIZE; i++) SIN_T[i] = Math.sin(TAU * i / SIN_TABLE_SIZE);
for (let i = 0; i < SIN_TABLE_SIZE; i++) SIN_D[i] = SIN_T[i + 1] - SIN_T[i];

/** sin(2π x), any real x. */
export function fastSin(x) {
  const f = x * SIN_TABLE_SIZE;
  const fi = Math.floor(f);
  const i = fi & SIN_MASK;
  return SIN_T[i] + (f - fi) * SIN_D[i];
}

/** cos(2π x), any real x. */
export function fastCos(x) {
  const f = x * SIN_TABLE_SIZE + SIN_TABLE_SIZE / 4;
  const fi = Math.floor(f);
  const i = fi & SIN_MASK;
  return SIN_T[i] + (f - fi) * SIN_D[i];
}

/** Rational tanh approximation (exact sign, |err| < 0.02, saturates exactly at ±1). */
export function fastTanh(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

// ---------------------------------------------------------------------------
// Deterministic randomness.

/** mulberry32: tiny, fast, good-enough 32-bit PRNG. Returns () => [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of (x, y, seed) -> [0, 1). Stateless, used for lattice noise. */
export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Periodic noise on the unit torus. A lattice with an integer `period` cells per
// unit wraps exactly, so every field built from it tiles with continuous value
// and slope. Grids are precomputed so the inner loops are table reads only.

function quintic(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Gradient lattice of period p (p x p unit gradients). */
export function makeGradientGrid(period, rng) {
  const p = Math.max(1, Math.round(period));
  const gx = new Float64Array(p * p);
  const gy = new Float64Array(p * p);
  for (let i = 0; i < p * p; i++) {
    const a = rng() * TAU;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return { period: p, gx, gy };
}

/** Periodic gradient (Perlin-style) noise, roughly in [-0.7, 0.7]. */
export function gradientNoise(grid, u, v) {
  const p = grid.period;
  const x = u * p, y = v * p;
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  // cheap wrap for the common in-range case; % only when far outside
  let x0 = xf < 0 ? xf + p : xf >= p ? xf - p : xf;
  if (x0 < 0 || x0 >= p) { x0 %= p; if (x0 < 0) x0 += p; }
  let y0 = yf < 0 ? yf + p : yf >= p ? yf - p : yf;
  if (y0 < 0 || y0 >= p) { y0 %= p; if (y0 < 0) y0 += p; }
  const x1 = x0 + 1 === p ? 0 : x0 + 1;
  const y1 = y0 + 1 === p ? 0 : y0 + 1;
  const gx = grid.gx, gy = grid.gy;
  const r0 = y0 * p, r1 = y1 * p;
  const n00 = gx[r0 + x0] * fx + gy[r0 + x0] * fy;
  const n10 = gx[r0 + x1] * (fx - 1) + gy[r0 + x1] * fy;
  const n01 = gx[r1 + x0] * fx + gy[r1 + x0] * (fy - 1);
  const n11 = gx[r1 + x1] * (fx - 1) + gy[r1 + x1] * (fy - 1);
  const sx = quintic(fx), sy = quintic(fy);
  const a = n00 + sx * (n10 - n00);
  const b = n01 + sx * (n11 - n01);
  return a + sy * (b - a);
}

/**
 * Accumulate w * gradientNoise(grid, i / size, v) into row[i] for a whole table
 * row at once: the v-dependent half of the work is done once per row, which
 * makes fBm generation roughly twice as fast. Same values as gradientNoise().
 */
export function addNoiseRow(grid, v, size, row, w) {
  const p = grid.period;
  const y = v * p;
  const yf = Math.floor(y);
  const fy = y - yf;
  let y0 = yf % p; if (y0 < 0) y0 += p;
  const y1 = y0 + 1 === p ? 0 : y0 + 1;
  const sy = quintic(fy);
  const gx = grid.gx, gy = grid.gy;
  const r0 = y0 * p, r1 = y1 * p;
  const fy1 = fy - 1;
  const scale = p / size;
  for (let i = 0; i < size; i++) {
    const x = i * scale;
    const x0 = Math.floor(x);
    const fx = x - x0;
    const x1 = x0 + 1 === p ? 0 : x0 + 1;
    const fx1 = fx - 1;
    const n00 = gx[r0 + x0] * fx + gy[r0 + x0] * fy;
    const n10 = gx[r0 + x1] * fx1 + gy[r0 + x1] * fy;
    const n01 = gx[r1 + x0] * fx + gy[r1 + x0] * fy1;
    const n11 = gx[r1 + x1] * fx1 + gy[r1 + x1] * fy1;
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const a = n00 + sx * (n10 - n00);
    const b = n01 + sx * (n11 - n01);
    row[i] += w * (a + sy * (b - a));
  }
}

/** Value lattice of period p (values in [-1, 1]). */
export function makeValueGrid(period, rng) {
  const p = Math.max(1, Math.round(period));
  const val = new Float64Array(p * p);
  for (let i = 0; i < p * p; i++) val[i] = rng() * 2 - 1;
  return { period: p, val };
}

/** Periodic value noise with quintic interpolation, in [-1, 1]. */
export function valueNoise(grid, u, v) {
  const p = grid.period;
  const x = u * p, y = v * p;
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = quintic(x - xf), fy = quintic(y - yf);
  let x0 = xf % p; if (x0 < 0) x0 += p;
  let y0 = yf % p; if (y0 < 0) y0 += p;
  const x1 = x0 + 1 === p ? 0 : x0 + 1;
  const y1 = y0 + 1 === p ? 0 : y0 + 1;
  const g = grid.val;
  const a = g[y0 * p + x0] + fx * (g[y0 * p + x1] - g[y0 * p + x0]);
  const b = g[y1 * p + x0] + fx * (g[y1 * p + x1] - g[y1 * p + x0]);
  return a + fy * (b - a);
}

/** Feature points for periodic Worley noise: one jittered point per cell. */
export function makeCellGrid(period, rng, jitter = 0.85) {
  const p = Math.max(1, Math.round(period));
  const px = new Float64Array(p * p);
  const py = new Float64Array(p * p);
  for (let i = 0; i < p * p; i++) {
    px[i] = 0.5 + (rng() - 0.5) * jitter;
    py[i] = 0.5 + (rng() - 0.5) * jitter;
  }
  return { period: p, px, py };
}

/**
 * Smooth-min Worley: distance (in cell units) to the nearest feature point,
 * softened with a polynomial smooth-min of width k so basin walls meet in
 * rounded creases instead of hard kinks. Returns ~[0, 1].
 */
export function worley(grid, u, v, k = 0.25) {
  const p = grid.period;
  const x = u * p, y = v * p;
  const cx = Math.floor(x), cy = Math.floor(y);
  let d = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    let jy = (cy + dy) % p; if (jy < 0) jy += p;
    for (let dx = -1; dx <= 1; dx++) {
      let jx = (cx + dx) % p; if (jx < 0) jx += p;
      const idx = jy * p + jx;
      const ex = cx + dx + grid.px[idx] - x;
      const ey = cy + dy + grid.py[idx] - y;
      const di = Math.sqrt(ex * ex + ey * ey);
      // polynomial smooth minimum
      const h = k - Math.abs(d - di);
      d = (d < di ? d : di) - (h > 0 ? h * h / (4 * k) : 0);
    }
  }
  return d;
}

/**
 * Smooth toroidal distance from (u, v) to (cu, cv): equals the Euclidean
 * distance near the centre but is built from sin² so that value AND slope are
 * continuous across the torus seams (max ≈ 0.45 at the antipode).
 */
export function torusRho(u, v, cu, cv) {
  const a = Math.sin(Math.PI * (u - cu));
  const b = Math.sin(Math.PI * (v - cv));
  return Math.sqrt(a * a + b * b) / Math.PI;
}

// ---------------------------------------------------------------------------
// Table lookups.

/** Bilinear lookup with wrap on a size x size table; any real u, v. */
export function sampleBilinear(data, size, u, v) {
  const x = u * size, y = v * size;
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  let x0, y0, x1, y1;
  if ((size & (size - 1)) === 0) {
    const m = size - 1;
    x0 = xf & m; y0 = yf & m; x1 = (x0 + 1) & m; y1 = (y0 + 1) & m;
  } else {
    x0 = xf % size; if (x0 < 0) x0 += size;
    y0 = yf % size; if (y0 < 0) y0 += size;
    x1 = x0 + 1 === size ? 0 : x0 + 1;
    y1 = y0 + 1 === size ? 0 : y0 + 1;
  }
  const r0 = y0 * size, r1 = y1 * size;
  const a = data[r0 + x0] + fx * (data[r0 + x1] - data[r0 + x0]);
  const b = data[r1 + x0] + fx * (data[r1 + x1] - data[r1 + x0]);
  return a + fy * (b - a);
}

// ---------------------------------------------------------------------------
// The shared coordinate pipeline (see docs/ARCHITECTURE.md).

/**
 * Coefficients of the path transform for one set of parameters, so a caller
 * that draws many points pays for pow/cos/sin once:
 *   u = cx + x*a - y*b,  v = cy + x*c + y*d
 */
export function makeTransform(stretch, size, rotateDeg, spinPhase, centerX, centerY, out = {}) {
  const ax = Math.pow(2, stretch * 1.5);
  const sx = ax * size, sy = size / ax;
  const th = (rotateDeg / 360 + spinPhase) * TAU;
  const c = Math.cos(th), s = Math.sin(th);
  out.a = sx * c; out.b = sy * s; out.c = sx * s; out.d = sy * c;
  out.cx = centerX; out.cy = centerY;
  return out;
}

/** Apply a makeTransform() result to a unit path point; writes out.u, out.v (unwrapped). */
export function applyTransform(xf, x, y, out) {
  out.u = xf.cx + x * xf.a - y * xf.b;
  out.v = xf.cy + x * xf.c + y * xf.d;
  return out;
}

/** One-shot path transform: unit path point -> terrain (u, v), unwrapped. */
export function pathTransform(x, y, stretch, size, rotateDeg, spinPhase, centerX, centerY, out) {
  const ax = Math.pow(2, stretch * 1.5);
  const px = x * ax * size, py = y * size / ax;
  const th = (rotateDeg / 360 + spinPhase) * TAU;
  const c = Math.cos(th), s = Math.sin(th);
  out.u = centerX + px * c - py * s;
  out.v = centerY + px * s + py * c;
  return out;
}

/** The terrain warp, exactly as specified; writes out.u, out.v. */
export function warpPoint(u, v, warp, out) {
  const w = warp * 0.06;
  out.u = u + w * (Math.sin(TAU * 2 * v) + 0.5 * Math.sin(TAU * (3 * v + 2 * u)));
  out.v = v + w * (Math.sin(TAU * 2 * u) + 0.5 * Math.sin(TAU * (3 * u - 2 * v)));
  return out;
}

const _w = { u: 0, v: 0 };
/** Terrain height after warp and morph (before Lift/Fold): what the audio reads. */
export function terrainHeight(dataA, sizeA, dataB, sizeB, morph, warp, u, v) {
  if (warp > 0) { warpPoint(u, v, warp, _w); u = _w.u; v = _w.v; }
  if (morph <= 0 || !dataB) return sampleBilinear(dataA, sizeA, u, v);
  if (morph >= 1) return sampleBilinear(dataB, sizeB, u, v);
  const a = sampleBilinear(dataA, sizeA, u, v);
  return a + morph * (sampleBilinear(dataB, sizeB, u, v) - a);
}

/**
 * Lift / Fold waveshaper (audio side).
 * Lift is gain. Below |y| = 1 the clean branch is the identity, so Lift 1 with
 * Fold 0 is bit-exact unity on a normalised terrain; above 1 it bends into a
 * soft knee that tops out at 1.5 (C1-continuous, no tanh needed).
 * Fold crossfades to a sine folder whose drive rises with Fold: at full Fold a
 * peak is folded back several times, which is where the bright partials come from.
 */
export function shapeHeight(h, lift, fold) {
  const y = h * lift;
  const ay = y < 0 ? -y : y;
  let s = y;
  if (ay > 1) {
    const e = 2 * (ay - 1);
    const k = 1 + 0.5 * e / (1 + e);
    s = y < 0 ? -k : k;
  }
  if (fold <= 0) return s;
  return s + fold * (fastSin(y * (1 + 4 * fold) * 0.25) - s);
}
