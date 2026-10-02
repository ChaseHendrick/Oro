// Orbit (path) shapes for the wave terrain oscillator.
//
// pathPoint(shape, t, order, param, out) writes a unit-scale point for the
// phase t ∈ [0, 1). It runs once per oscillator sample (twice with 2x
// oversampling, for every unison voice), so it must not allocate and keeps to
// table sines, multiplies and the odd sqrt. Every path except Scan is a closed,
// continuous loop; all of them are scaled so their outermost point sits at
// radius ~1, which keeps the footprint similar across shapes for one Size.
//
// Scan is deliberately open: it is a sawtooth sweep x = 2t - 1. At Size 0.5 the
// jump from +1 back to -1 is exactly one terrain period, so on the torus it is
// seamless and the oscillator plays a terrain row like a wavetable.

import { fastSin, fastCos, mulberry32 } from './terrain-math.js';

export const PATH_COUNT = 12;
const ELLIPSE = 0, LISSA = 1, ROSE = 2, POLYGON = 3, STAR = 4, SPIRAL = 5,
  SCAN = 6, SPIRO = 7, EIGHT = 8, CUSP = 9, SUPER = 10, SCRIBBLE = 11;

function clampOrder(order) {
  const o = Math.round(order);
  return o < 1 ? 1 : o > 8 ? 8 : o;
}

// --- polygon / star vertex tables ------------------------------------------
// Unit directions for 2..16 evenly spaced vertices, index [n][k], k = 0..n.
const DIR_X = [], DIR_Y = [];
for (let n = 0; n <= 16; n++) {
  const dx = new Float64Array(n + 1), dy = new Float64Array(n + 1);
  for (let k = 0; k <= n && n > 0; k++) {
    const a = 2 * Math.PI * k / n;
    dx[k] = Math.cos(a); dy[k] = Math.sin(a);
  }
  DIR_X.push(dx); DIR_Y.push(dy);
}

// --- superformula radius table --------------------------------------------
// r(ψ) = (|cos ψ|^N + |sin ψ|^N)^(-1/N) has period π/2 in ψ and does not depend
// on the symmetry order, so one table per exponent covers every order. The
// exponent is quantised into SUPER_LEVELS steps of `param` and interpolated, so
// the five transcendental calls per point are paid once per table, not per sample.
const SUPER_G = 512;
const SUPER_LEVELS = 64;
const superTables = new Array(SUPER_LEVELS + 1).fill(null);

// 0 -> 0.6 (pinched star), 0.5 -> 1 (straight-edged polygon), 1 -> 6 (rounded blob).
// Below ~0.6 the star tips get so sharp that they jump between samples.
function superExponent(param) {
  return param < 0.5 ? 0.6 * Math.pow(1 / 0.6, 2 * param) : Math.pow(6, 2 * param - 1);
}

function superTable(level) {
  let tab = superTables[level];
  if (tab) return tab;
  tab = new Float64Array(SUPER_G + 1);
  const N = superExponent(level / SUPER_LEVELS);
  // max radius: 1 on the axes when N <= 2, else on the diagonals
  const norm = N > 2 ? Math.pow(2, 0.5 - 1 / N) : 1;
  for (let i = 0; i <= SUPER_G; i++) {
    const psi = (i / SUPER_G) * Math.PI / 2;
    const a = Math.abs(Math.cos(psi)), b = Math.abs(Math.sin(psi));
    const ta = a > 1e-12 ? Math.exp(N * Math.log(a)) : 0;
    const tb = b > 1e-12 ? Math.exp(N * Math.log(b)) : 0;
    tab[i] = Math.exp(-Math.log(ta + tb) / N) / norm;
  }
  superTables[level] = tab;
  return tab;
}

function superRadius(m, t, param) {
  const lp = (param < 0 ? 0 : param > 1 ? 1 : param) * SUPER_LEVELS;
  let l0 = Math.floor(lp);
  if (l0 >= SUPER_LEVELS) l0 = SUPER_LEVELS - 1;
  const lf = lp - l0;
  const ta = superTables[l0] || superTable(l0);
  const tb = superTables[l0 + 1] || superTable(l0 + 1);
  let s = m * t;
  s -= Math.floor(s);
  const f = s * SUPER_G;
  const i = Math.floor(f);
  const a = f - i;
  const ra = ta[i] + a * (ta[i + 1] - ta[i]);
  const rb = tb[i] + a * (tb[i + 1] - tb[i]);
  return ra + lf * (rb - ra);
}

// --- scribble coefficients -------------------------------------------------
// Per seed (order 1..8): a circle plus harmonics 2..7 with random amplitude
// and phase rolling off as 1/k^1.1, so the loop stays smooth (no corners).
const SCRIB_K = 7;
const SCRIB_STRIDE = 4 * (SCRIB_K - 1);
const SCRIB = new Float64Array(9 * SCRIB_STRIDE); // [seed][harmonic 2..7] -> ax, bx, ay, by
for (let s = 1; s <= 8; s++) {
  const rng = mulberry32(0x5c1b + s * 7919);
  for (let k = 2; k <= SCRIB_K; k++) {
    const amp = 0.9 / Math.pow(k, 1.1);
    for (let j = 0; j < 4; j++) SCRIB[s * SCRIB_STRIDE + (k - 2) * 4 + j] = (rng() * 2 - 1) * amp;
  }
}
const SCRIB_LEVELS = 64;
const scribNorm = new Float64Array(9 * (SCRIB_LEVELS + 1)).fill(NaN);
const _sp = { x: 0, y: 0 };

function scribbleRaw(seed, t, chaos, out) {
  const o = seed * SCRIB_STRIDE;
  const c1 = fastCos(t), s1 = fastSin(t);
  let ck = c1, sk = s1, hx = 0, hy = 0;
  for (let i = 0; i < SCRIB_STRIDE; i += 4) {
    // rotate (cos kθ, sin kθ) by θ: cheaper than, and as exact as, two table reads
    const nc = ck * c1 - sk * s1;
    sk = sk * c1 + ck * s1;
    ck = nc;
    hx += SCRIB[o + i] * ck + SCRIB[o + i + 1] * sk;
    hy += SCRIB[o + i + 2] * ck + SCRIB[o + i + 3] * sk;
  }
  out.x = c1 + chaos * hx;
  out.y = s1 + chaos * hy;
}

function scribbleNorm(seed, level) {
  const idx = seed * (SCRIB_LEVELS + 1) + level;
  let v = scribNorm[idx];
  if (v === v) return v;
  const chaos = scribbleChaos(level / SCRIB_LEVELS);
  let m = 1e-9;
  for (let i = 0; i < 1024; i++) {
    scribbleRaw(seed, i / 1024, chaos, _sp);
    const ax = Math.abs(_sp.x), ay = Math.abs(_sp.y);
    if (ax > m) m = ax;
    if (ay > m) m = ay;
  }
  v = 1 / (m * 1.002);
  scribNorm[idx] = v;
  return v;
}

function scribbleChaos(param) { return 1.6 * param; }

// ---------------------------------------------------------------------------
// One small point function per shape, writing X[j], Y[j]. pathPoint() and the
// block renderer pathBlock() both call these, so the audio thread and the
// visuals compute bit-identical curves; V8 inlines them into the block loops.

function ellipseAt(t, n, p, X, Y, j) {
  // Skew shifts the phase of y by up to a quarter cycle: circle at 0.5,
  // diagonal lines at 0 and 1. Order adds a small epicycle at that harmonic.
  const ph = (p - 0.5) * 0.5;
  const x = fastCos(t), y = fastSin(t + ph);
  if (n > 1) {
    const g = 1 / 1.2;
    X[j] = (x + 0.2 * fastCos(n * t)) * g;
    Y[j] = (y + 0.2 * fastSin(n * t + ph)) * g;
  } else {
    X[j] = x; Y[j] = y;
  }
}

function lissaAt(t, n, p, X, Y, j) {
  X[j] = fastSin(n * t + 0.5 * p);
  Y[j] = fastSin((n + 1) * t);
}

function roseAt(t, n, p, X, Y, j) {
  // r = c + (1 - c) cos(nθ): Bloom 0 gives petals with inner loops,
  // 0.5 petals that nearly meet in the middle, 1 opens to a circle.
  const c = 0.25 + 0.75 * p;
  const r = c + (1 - c) * fastCos(n * t);
  X[j] = r * fastCos(t);
  Y[j] = r * fastSin(t);
}

function polygonAt(t, n, p, X, Y, j) {
  const c = fastCos(t), s = fastSin(t);
  if (n === 1) { X[j] = c; Y[j] = s; return; }
  const f = (t - Math.floor(t)) * n;
  const k = Math.floor(f);
  const a = f - k;
  const dx = DIR_X[n], dy = DIR_Y[n];
  const px = dx[k] + a * (dx[k + 1] - dx[k]);
  const py = dy[k] + a * (dy[k + 1] - dy[k]);
  X[j] = px + p * (c - px);
  Y[j] = py + p * (s - py);
}

function starAt(t, n, p, X, Y, j) {
  const ri = 1 - 0.9 * p;
  const m = 2 * n;
  const f = (t - Math.floor(t)) * m;
  const k = Math.floor(f);
  const a = f - k;
  const dx = DIR_X[m], dy = DIR_Y[m];
  const r0 = (k & 1) ? ri : 1, r1 = (k & 1) ? 1 : ri;
  const x0 = dx[k] * r0, y0 = dy[k] * r0;
  X[j] = x0 + a * (dx[k + 1] * r1 - x0);
  Y[j] = y0 + a * (dy[k + 1] * r1 - y0);
}

function spiralAt(t, n, p, X, Y, j) {
  // Radius breathes core -> 1 -> core once per cycle while the angle makes
  // `order` full turns, so it winds out and back in, smoothly and closed.
  const core = 0.9 * p;
  const r = core + (1 - core) * (0.5 - 0.5 * fastCos(t));
  X[j] = r * fastCos(n * t);
  Y[j] = r * fastSin(n * t);
}

function scanAt(t, n, p, X, Y, j) {
  const tt = t - Math.floor(t);
  const x = 2 * tt - 1;
  const slope = 2 * p - 1;
  X[j] = x;
  if (n === 1) { Y[j] = slope * x; return; }
  // zigzag: triangle wave in y with (order - 1) teeth per sweep
  let z = (n - 1) * tt;
  z -= Math.floor(z);
  Y[j] = 0.55 * slope * x + 0.45 * (1 - 4 * Math.abs(z - 0.5));
}

function spiroAt(t, n, p, X, Y, j) {
  // hypotrochoid with integer ratio k = order + 1 (k + 1 lobes); pen 0..1
  const k = n + 1;
  const g = 1 / (1 + p);
  X[j] = (fastCos(t) + p * fastCos(k * t)) * g;
  Y[j] = (fastSin(t) - p * fastSin(k * t)) * g;
}

function eightAt(t, n, p, X, Y, j) {
  // x = sin θ, y ∝ sin(Lθ) (even L) or cos(Lθ) (odd L) so the loop closes
  // without retracing; L = order + 1 lobes, order 1 is the classic eight.
  const L = n + 1;
  const w = 0.15 + 0.85 * p;
  X[j] = fastSin(t);
  Y[j] = w * ((L & 1) ? fastCos(L * t) : fastSin(L * t));
}

function cuspAt(t, n, p, X, Y, j) {
  // epitrochoid: Depth 0.5 -> exact epicycloid with `order` cusps (order 1
  // is the cardioid), below rounds the cusps off, above throws loops.
  const k1 = n + 1;
  const d = 2 * p;
  const g = 1 / (k1 + d);
  X[j] = (k1 * fastCos(t) - d * fastCos(k1 * t)) * g;
  Y[j] = (k1 * fastSin(t) - d * fastSin(k1 * t)) * g;
}

function superAt(t, n, p, X, Y, j) {
  const r = superRadius(n, t, p);
  X[j] = r * fastCos(t);
  Y[j] = r * fastSin(t);
}

function scribbleAt(t, n, p, X, Y, j) {
  const lp = p * SCRIB_LEVELS;
  let l0 = Math.floor(lp);
  if (l0 >= SCRIB_LEVELS) l0 = SCRIB_LEVELS - 1;
  const lf = lp - l0;
  const base = n * (SCRIB_LEVELS + 1) + l0;
  let g0 = scribNorm[base], g1 = scribNorm[base + 1];
  if (g0 !== g0) g0 = scribbleNorm(n, l0);
  if (g1 !== g1) g1 = scribbleNorm(n, l0 + 1);
  const g = g0 + lf * (g1 - g0);
  scribbleRaw(n, t, scribbleChaos(p), _sp);
  // interpolated normalisation can overshoot by a hair between levels
  let x = _sp.x * g, y = _sp.y * g;
  X[j] = x > 1 ? 1 : x < -1 ? -1 : x;
  Y[j] = y > 1 ? 1 : y < -1 ? -1 : y;
}

const PX = new Float64Array(1), PY = new Float64Array(1);

/**
 * Point on path `shape` (index into PATHS) at phase t ∈ [0, 1).
 * order: integer 1..8 (clamped), param: 0..1 continuous. Writes out.x, out.y ∈ [-1, 1].
 */
export function pathPoint(shape, t, order, param, out) {
  const n = order >= 1 && order <= 8 && order === (order | 0) ? order : clampOrder(order);
  const p = param < 0 ? 0 : param > 1 ? 1 : param;
  switch (shape) {
    case ELLIPSE: ellipseAt(t, n, p, PX, PY, 0); break;
    case LISSA: lissaAt(t, n, p, PX, PY, 0); break;
    case ROSE: roseAt(t, n, p, PX, PY, 0); break;
    case POLYGON: polygonAt(t, n, p, PX, PY, 0); break;
    case STAR: starAt(t, n, p, PX, PY, 0); break;
    case SPIRAL: spiralAt(t, n, p, PX, PY, 0); break;
    case SCAN: scanAt(t, n, p, PX, PY, 0); break;
    case SPIRO: spiroAt(t, n, p, PX, PY, 0); break;
    case EIGHT: eightAt(t, n, p, PX, PY, 0); break;
    case CUSP: cuspAt(t, n, p, PX, PY, 0); break;
    case SUPER: superAt(t, n, p, PX, PY, 0); break;
    case SCRIBBLE: scribbleAt(t, n, p, PX, PY, 0); break;
    default: PX[0] = fastCos(t); PY[0] = fastSin(t); break;
  }
  out.x = PX[0]; out.y = PY[0];
  return out;
}

// Block renderer: advances an oscillator phase (with a linearly ramped
// increment) and a linearly ramped param over n samples, writing the path into
// X/Y. One switch per block instead of per sample; the per-shape loops are
// what V8 optimises. state = [phase, inc, dinc, param, dParam]; phase, inc and
// param are left at their end-of-block values. Identical to calling pathPoint
// once per sample.
function loop(fn, n, st, X, Y, order) {
  let ph = st[0], inc = st[1], p = st[3];
  const dinc = st[2], dp = st[4];
  for (let j = 0; j < n; j++) {
    ph += inc;
    if (ph >= 1) ph -= 1;
    inc += dinc;
    p += dp;
    fn(ph, order, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j);
  }
  st[0] = ph; st[1] = inc; st[3] = p;
}

// Distinct copies of the loop per shape so each call site stays monomorphic
// and the point function is inlined.
function loopEllipse(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; ellipseAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopLissa(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; lissaAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopRose(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; roseAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopPolygon(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; polygonAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopStar(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; starAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopSpiral(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; spiralAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopScan(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; scanAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopSpiro(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; spiroAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopEight(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; eightAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopCusp(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; cuspAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopSuper(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; superAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }
function loopScribble(n, st, X, Y, o) { let ph = st[0], inc = st[1], p = st[3]; const di = st[2], dp = st[4]; for (let j = 0; j < n; j++) { ph += inc; if (ph >= 1) ph -= 1; inc += di; p += dp; scribbleAt(ph, o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } st[0] = ph; st[1] = inc; st[3] = p; }

/**
 * Render n consecutive path samples for an oscillator (see loop() above for
 * the state layout). Used by the DSP inner loop; equivalent to pathPoint().
 */
export function pathBlock(shape, order, n, state, X, Y) {
  const o = order >= 1 && order <= 8 && order === (order | 0) ? order : clampOrder(order);
  switch (shape) {
    case ELLIPSE: loopEllipse(n, state, X, Y, o); break;
    case LISSA: loopLissa(n, state, X, Y, o); break;
    case ROSE: loopRose(n, state, X, Y, o); break;
    case POLYGON: loopPolygon(n, state, X, Y, o); break;
    case STAR: loopStar(n, state, X, Y, o); break;
    case SPIRAL: loopSpiral(n, state, X, Y, o); break;
    case SCAN: loopScan(n, state, X, Y, o); break;
    case SPIRO: loopSpiro(n, state, X, Y, o); break;
    case EIGHT: loopEight(n, state, X, Y, o); break;
    case CUSP: loopCusp(n, state, X, Y, o); break;
    case SUPER: loopSuper(n, state, X, Y, o); break;
    case SCRIBBLE: loopScribble(n, state, X, Y, o); break;
    default: loop(ellipseAt, n, state, X, Y, o); break;
  }
}

// --- perimeter cache -------------------------------------------------------
const LEN_LEVELS = 32;
const LEN_SAMPLES = 512;
const lenCache = new Float64Array(PATH_COUNT * 8 * (LEN_LEVELS + 1)).fill(NaN);
const _lp = { x: 0, y: 0 };

function computeLength(shape, order, param) {
  pathPoint(shape, 0, order, param, _lp);
  let px = _lp.x, py = _lp.y, len = 0;
  for (let i = 1; i <= LEN_SAMPLES; i++) {
    pathPoint(shape, (i % LEN_SAMPLES) / LEN_SAMPLES, order, param, _lp);
    const dx = _lp.x - px, dy = _lp.y - py;
    // The Scan wrap jump is a seam on the torus, not distance travelled.
    if (!(shape === SCAN && i === LEN_SAMPLES)) len += Math.sqrt(dx * dx + dy * dy);
    px = _lp.x; py = _lp.y;
  }
  return shape === SCAN ? len * LEN_SAMPLES / (LEN_SAMPLES - 1) : len;
}

/**
 * Approximate perimeter of the path in unit coordinates (a unit circle is 2π).
 * Cached on a grid of param values and interpolated, so it is cheap enough for
 * the audio thread's per-block mip selection.
 */
export function pathLength(shape, order, param) {
  const s = shape >= 0 && shape < PATH_COUNT ? shape | 0 : 0;
  const n = clampOrder(order);
  const lp = (param < 0 ? 0 : param > 1 ? 1 : param) * LEN_LEVELS;
  let l0 = Math.floor(lp);
  if (l0 >= LEN_LEVELS) l0 = LEN_LEVELS - 1;
  const lf = lp - l0;
  const base = (s * 8 + (n - 1)) * (LEN_LEVELS + 1);
  let a = lenCache[base + l0];
  if (a !== a) { a = computeLength(s, n, l0 / LEN_LEVELS); lenCache[base + l0] = a; }
  let b = lenCache[base + l0 + 1];
  if (b !== b) { b = computeLength(s, n, (l0 + 1) / LEN_LEVELS); lenCache[base + l0 + 1] = b; }
  return a + lf * (b - a);
}

/**
 * Sample n points of a path for drawing: out[2i] = x, out[2i + 1] = y at
 * t = i / n. Pass a Float32Array(2n) to avoid allocation; returns it.
 */
export function samplePath(shape, order, param, n, out) {
  const arr = out && out.length >= 2 * n ? out : new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    pathPoint(shape, i / n, order, param, _lp);
    arr[2 * i] = _lp.x;
    arr[2 * i + 1] = _lp.y;
  }
  return arr;
}

// --- Pace (phase distortion) and Laps (hard sync) ----------------------------
// The oscillator's cycle phase φ ∈ [0, 1) advances at the note frequency.
// Pace bends it into ψ = paceWarp(φ): a monotonic map with ψ(0) = 0 and
// ψ(1) = 1, so the cycle (and therefore the pitch) keeps its length while the
// dot speeds up and slows down along the path: timbre only. paceSpeed(φ) =
// dψ/dφ is the local traversal speed relative to an even one. Every curve
// keeps it >= 0.1 for |pace| <= 1 (the dot never stops or runs backwards) and
// periodic, so the speed has no corner at the cycle boundary either.
// Laps then picks the path phase t = frac(laps · ψ): integer laps trace the
// closed path that many times per cycle; fractional laps cut the last lap
// short and restart at t = 0 on every cycle boundary (hard sync).
// Audio (dsp-core.js) and the visuals' comet trail both use these functions.

export const PACE_SHAPES = ['Bend', 'Skew', 'Pinch'];
export const PACE_BEND = 0, PACE_SKEW = 1, PACE_PINCH = 2;
const PACE_DEPTH = 0.9;      // Bend / Pinch: |k| <= 0.9 keeps the speed within [0.1, 1.9]
const SKEW_RANGE = 0.42;     // Skew: the knee moves from 0.5 to 0.08 (pace 1) or 0.92 (pace -1)
const SKEW_SOFT = 0.4;       // Skew: half-width of each speed change, as a fraction of the shorter segment
const INV_2PI = 1 / (2 * Math.PI), INV_4PI = 1 / (4 * Math.PI);

// Skew: the first half of the path (ψ 0 → 0.5) takes a fraction d of the
// cycle and the second half the rest, like a two-segment CZ phase distortion.
// A hard knee would put corners in the speed (a kink in the waveform per
// corner, which aliases); here the speed steps between s1 = 0.5/d and
// s2 = 0.5/(1 - d) through raised-cosine ramps of half-width h centred on the
// knee (φ = d) and on the cycle boundary, so the speed is C1. The ramps are
// symmetric about their centres, which keeps ∫speed = s2 + (s1 - s2) d = 1.
// ψ = s2 φ + (s1 - s2) I(φ) where I integrates the smoothed "first segment"
// indicator; the five branches below are that integral in closed form.
function skewWarp(phi, pace) {
  const d = 0.5 - SKEW_RANGE * pace;
  const s2 = 0.5 / (1 - d), ds = 0.5 / d - s2;
  const h = SKEW_SOFT * (d < 0.5 ? d : 1 - d), c = h / Math.PI, q = 0.25 / h;
  let I;
  if (phi < h) I = 0.5 * phi + c * (1 - fastCos(phi * q));
  else if (phi < d - h) I = phi - 0.5 * h + c;
  else if (phi < d + h) { const x = phi - d; I = d - h + c + 0.5 * x + c * fastCos(x * q); }
  else if (phi < 1 - h) I = d - 0.5 * h + c;
  else { const x = phi - 1; I = d + c + 0.5 * x - c * fastCos(x * q); }
  return s2 * phi + ds * I;
}

function skewSpeed(phi, pace) {
  const d = 0.5 - SKEW_RANGE * pace;
  const s2 = 0.5 / (1 - d), ds = 0.5 / d - s2;
  const h = SKEW_SOFT * (d < 0.5 ? d : 1 - d), q = 0.25 / h;
  let b;
  if (phi < h) b = 0.5 + 0.5 * fastSin(phi * q);
  else if (phi < d - h) b = 1;
  else if (phi < d + h) b = 0.5 - 0.5 * fastSin((phi - d) * q);
  else if (phi < 1 - h) b = 0;
  else b = 0.5 + 0.5 * fastSin((phi - 1) * q);
  return s2 + ds * b;
}

/**
 * Pace: warped cycle phase ψ for the cycle phase phi ∈ [0, 1).
 * pace -1..1 (0 = identity, exactly; clamped), shape 0 Bend | 1 Skew | 2 Pinch.
 *   Bend:  ψ = φ + k sin(2πφ) / 2π, k = 0.9 pace: one speed hump per cycle
 *          (pace > 0 rushes through the start of the path and lingers halfway).
 *   Skew:  two-speed CZ-style split with smoothed knees (see skewWarp).
 *   Pinch: ψ = φ + k sin(4πφ) / 4π: two symmetric speed-ups per cycle.
 */
export function paceWarp(phi, pace, shape) {
  pace = pace < -1 ? -1 : pace > 1 ? 1 : pace;
  if (shape === PACE_SKEW) return pace === 0 ? phi : skewWarp(phi, pace);
  const k = PACE_DEPTH * pace;
  return shape === PACE_PINCH ? phi + k * fastSin(2 * phi) * INV_4PI : phi + k * fastSin(phi) * INV_2PI;
}

/** Pace: local traversal speed dψ/dφ at phi (1 = even), always in [0.1, 6.3]. */
export function paceSpeed(phi, pace, shape) {
  pace = pace < -1 ? -1 : pace > 1 ? 1 : pace;
  if (shape === PACE_SKEW) return pace === 0 ? 1 : skewSpeed(phi, pace);
  const k = PACE_DEPTH * pace;
  return shape === PACE_PINCH ? 1 + k * fastCos(2 * phi) : 1 + k * fastCos(phi);
}

/** Pace: the fastest local speed over a cycle (for normalising a speed display). */
export function paceMaxSpeed(pace, shape) {
  const a = pace < -1 || pace > 1 ? 1 : pace < 0 ? -pace : pace;
  if (shape !== PACE_SKEW) return 1 + PACE_DEPTH * a;
  const d = 0.5 - SKEW_RANGE * a;
  return 0.5 / d;
}

/**
 * Block form of paceWarp for the oscillator: for cycle phases PH[0..n) with
 * pace ramping from pace0 (pace0 + dPace at j = 0), writes ψ to PSI[j]. Same
 * formulas as paceWarp; a held Skew pace computes its knee coefficients once
 * per block instead of per sample.
 */
export function paceBlock(shape, n, PH, pace0, dPace, PSI) {
  // unboxed locals for the ramp (see the note above pathBlockAt)
  let pc = +pace0;
  const dPc = +dPace;
  if (shape === PACE_SKEW) {
    if (dPc === 0 && pc !== 0) {
      const d = 0.5 - SKEW_RANGE * pc;
      const s2 = 0.5 / (1 - d), ds = 0.5 / d - s2;
      const h = SKEW_SOFT * (d < 0.5 ? d : 1 - d), c = h / Math.PI, q = 0.25 / h;
      const e1 = d - h, e2 = d + h, e3 = 1 - h;
      for (let j = 0; j < n; j++) {
        const phi = PH[j];
        let I;
        if (phi < h) I = 0.5 * phi + c * (1 - fastCos(phi * q));
        else if (phi < e1) I = phi - 0.5 * h + c;
        else if (phi < e2) { const x = phi - d; I = d - h + c + 0.5 * x + c * fastCos(x * q); }
        else if (phi < e3) I = d - 0.5 * h + c;
        else { const x = phi - 1; I = d + c + 0.5 * x - c * fastCos(x * q); }
        PSI[j] = s2 * phi + ds * I;
      }
    } else {
      for (let j = 0; j < n; j++) {
        pc += dPc;
        PSI[j] = pc === 0 ? PH[j] : skewWarp(PH[j], pc);
      }
    }
  } else if (shape === PACE_PINCH) {
    for (let j = 0; j < n; j++) {
      pc += dPc;
      const phi = PH[j];
      PSI[j] = phi + PACE_DEPTH * pc * fastSin(2 * phi) * INV_4PI;
    }
  } else {
    for (let j = 0; j < n; j++) {
      pc += dPc;
      const phi = PH[j];
      PSI[j] = phi + PACE_DEPTH * pc * fastSin(phi) * INV_2PI;
    }
  }
}

/** Laps: path phase t = frac(laps · psi) for the (paced) cycle phase psi. */
export function syncPhase(psi, laps) {
  const t = laps * psi;
  return t - Math.floor(t);
}

/**
 * Path phase for cycle phase phi with Pace and Laps applied: what the
 * oscillator traces. Same argument order as the UI's dsp-bridge cyclePhase.
 */
export function cyclePhase(phi, laps = 1, pace = 0, shape = 0) {
  return syncPhase(paceWarp(phi, pace, shape), laps);
}

// Block renderer for precomputed path phases (the Laps / Pace oscillator):
// X[j], Y[j] = the path at T[j] with param ramped linearly from `param`
// (param + dParam at j = 0, as in pathBlock). Monomorphic per-shape loops.
// The ramp lives in fresh locals (`+p0`): accumulating into a parameter that
// may arrive as a small integer made V8 box a heap number every sample.
function atEllipse(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; ellipseAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atLissa(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; lissaAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atRose(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; roseAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atPolygon(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; polygonAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atStar(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; starAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atSpiral(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; spiralAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atScan(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; scanAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atSpiro(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; spiroAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atEight(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; eightAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atCusp(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; cuspAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atSuper(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; superAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }
function atScribble(n, T, p0, d0, X, Y, o) { let p = +p0; const dp = +d0; for (let j = 0; j < n; j++) { p += dp; scribbleAt(T[j], o, p < 0 ? 0 : p > 1 ? 1 : p, X, Y, j); } }

/**
 * Render the path at n precomputed phases T[0..n) (each in [0, 1)) into X/Y,
 * with param ramping from `param` by `dParam` per sample. Identical to calling
 * pathPoint(shape, T[j], order, param + (j + 1) dParam) for each j.
 */
export function pathBlockAt(shape, order, n, T, param, dParam, X, Y) {
  const o = order >= 1 && order <= 8 && order === (order | 0) ? order : clampOrder(order);
  switch (shape) {
    case LISSA: atLissa(n, T, param, dParam, X, Y, o); break;
    case ROSE: atRose(n, T, param, dParam, X, Y, o); break;
    case POLYGON: atPolygon(n, T, param, dParam, X, Y, o); break;
    case STAR: atStar(n, T, param, dParam, X, Y, o); break;
    case SPIRAL: atSpiral(n, T, param, dParam, X, Y, o); break;
    case SCAN: atScan(n, T, param, dParam, X, Y, o); break;
    case SPIRO: atSpiro(n, T, param, dParam, X, Y, o); break;
    case EIGHT: atEight(n, T, param, dParam, X, Y, o); break;
    case CUSP: atCusp(n, T, param, dParam, X, Y, o); break;
    case SUPER: atSuper(n, T, param, dParam, X, Y, o); break;
    case SCRIBBLE: atScribble(n, T, param, dParam, X, Y, o); break;
    default: atEllipse(n, T, param, dParam, X, Y, o); break;
  }
}

// --- Travel: direction (Ping-pong) and traverse (Even) -----------------------
// Applied to the path phase after Pace and Laps: t -> pingPong(t) -> evenPhase.
// Ping-pong runs each lap forward and then backward, so the waveform of every
// lap is symmetric and an open path (Scan) never jumps. Even re-times the trip
// so the dot moves at constant speed along the curve (Natural follows the
// curve's own maths, which rushes some stretches and lingers on others).
// Both maps are monotonic pieces with fixed endpoints, so the cycle length,
// and with it the pitch, never changes.

// The turning point of a ping-pong lap must be the END of the path: for the
// open Scan path t = 1 would wrap back to its start, so stay a hair below it.
const PP_TOP = 1 - 2 ** -40;

/** Ping-pong: 0 -> 1 over the first half of the lap, back to 0 over the second. */
export function pingPong(t) {
  const f = t - Math.floor(t);
  const y = f < 0.5 ? 2 * f : 2 - 2 * f;
  return y > PP_TOP ? PP_TOP : y;
}

// Even: per (shape, order, quantised param) an inverse arc-length table maps
// a fraction of the path's length to the phase t where it is reached. Params
// between two levels blend the neighbouring tables (both are monotonic, so the
// blend is too), the same scheme as the perimeter cache. A table costs ~2000
// path points (~0.1 ms) and is built on first use; the engine calls
// prepareEven from its message handler for the levels around the current
// param, so the audio callback only builds one when modulation reaches a
// level nobody has used yet.
const EVEN_LEVELS = 32;
const EVEN_G = 512;
const EVEN_FINE = 2048;
const evenCache = new Array(PATH_COUNT * 8 * (EVEN_LEVELS + 1)).fill(null);
const _ep = { x: 0, y: 0 };
const _arc = new Float64Array(EVEN_FINE + 1);

function evenTable(shape, order, level) {
  const idx = (shape * 8 + (order - 1)) * (EVEN_LEVELS + 1) + level;
  const hit = evenCache[idx];
  if (hit) return hit;
  const param = level / EVEN_LEVELS;
  pathPoint(shape, 0, order, param, _ep);
  let px = _ep.x, py = _ep.y;
  _arc[0] = 0;
  for (let i = 1; i <= EVEN_FINE; i++) {
    // the last point approaches t = 1 from below: closed paths land on their
    // start anyway, and the open Scan does not count its seam as distance
    pathPoint(shape, i < EVEN_FINE ? i / EVEN_FINE : 1 - 1e-9, order, param, _ep);
    const dx = _ep.x - px, dy = _ep.y - py;
    _arc[i] = _arc[i - 1] + Math.sqrt(dx * dx + dy * dy);
    px = _ep.x; py = _ep.y;
  }
  const total = _arc[EVEN_FINE];
  const tab = new Float64Array(EVEN_G + 1);
  if (!(total > 1e-12)) {
    for (let k = 0; k <= EVEN_G; k++) tab[k] = k / EVEN_G;
  } else {
    let i = 0;
    for (let k = 1; k < EVEN_G; k++) {
      const target = total * k / EVEN_G;
      while (i < EVEN_FINE - 1 && _arc[i + 1] < target) i++;
      const seg = _arc[i + 1] - _arc[i];
      const f = seg > 0 ? (target - _arc[i]) / seg : 0;
      tab[k] = (i + (f < 0 ? 0 : f > 1 ? 1 : f)) / EVEN_FINE;
    }
    tab[0] = 0; tab[EVEN_G] = 1;
  }
  evenCache[idx] = tab;
  return tab;
}

/**
 * Build the Even tables of one shape and order now (outside the audio
 * callback): the levels within `reach` of param, or all of them without one.
 */
export function prepareEven(shape, order, param = null, reach = 2) {
  const s = shape >= 0 && shape < PATH_COUNT ? shape | 0 : 0;
  const n = clampOrder(order);
  let lo = 0, hi = EVEN_LEVELS;
  if (param !== null && Number.isFinite(param)) {
    const l = Math.floor((param < 0 ? 0 : param > 1 ? 1 : param) * EVEN_LEVELS);
    lo = Math.max(0, l - reach); hi = Math.min(EVEN_LEVELS, l + 1 + reach);
  }
  for (let l = lo; l <= hi; l++) evenTable(s, n, l);
}

/**
 * Even traverse: the phase where the dot has covered the fraction t of the
 * path's length (t in [0, 1); 0 -> 0 and 1 -> 1, monotonic). Same shape /
 * order / param arguments as pathPoint.
 */
export function evenPhase(shape, order, param, t) {
  const s = shape >= 0 && shape < PATH_COUNT ? shape | 0 : 0;
  const n = order >= 1 && order <= 8 && order === (order | 0) ? order : clampOrder(order);
  const lp = (param < 0 ? 0 : param > 1 ? 1 : param) * EVEN_LEVELS;
  let l0 = Math.floor(lp);
  if (l0 >= EVEN_LEVELS) l0 = EVEN_LEVELS - 1;
  const lf = lp - l0;
  const base = (s * 8 + (n - 1)) * (EVEN_LEVELS + 1);
  const A = evenCache[base + l0] || evenTable(s, n, l0);
  const B = evenCache[base + l0 + 1] || evenTable(s, n, l0 + 1);
  const x = (t - Math.floor(t)) * EVEN_G;
  const i = x | 0;
  const f = x - i;
  const a = A[i] + f * (A[i + 1] - A[i]);
  const b = B[i] + f * (B[i + 1] - B[i]);
  return a + lf * (b - a);
}

/**
 * Block form for the oscillator: in place, T[j] -> pingPong (when pingPong is
 * set) and then evenPhase (when even is set), with the param ramping exactly
 * as in pathBlockAt (param + (j + 1) dParam at sample j, clamped), so the
 * Even tables always match the curve that is drawn.
 */
export function travelBlock(shape, order, n, T, param, dParam, pingPongOn, evenOn) {
  if (pingPongOn) {
    for (let j = 0; j < n; j++) {
      const f = T[j];
      const y = f < 0.5 ? 2 * f : 2 - 2 * f;
      T[j] = y > PP_TOP ? PP_TOP : y;
    }
  }
  if (!evenOn) return;
  const s = shape >= 0 && shape < PATH_COUNT ? shape | 0 : 0;
  const o = order >= 1 && order <= 8 && order === (order | 0) ? order : clampOrder(order);
  const base = (s * 8 + (o - 1)) * (EVEN_LEVELS + 1);
  let p = +param;
  const dp = +dParam;
  if (dp === 0) {
    const pc = p < 0 ? 0 : p > 1 ? 1 : p;
    const lp = pc * EVEN_LEVELS;
    let l0 = Math.floor(lp);
    if (l0 >= EVEN_LEVELS) l0 = EVEN_LEVELS - 1;
    const lf = lp - l0;
    const A = evenCache[base + l0] || evenTable(s, o, l0);
    const B = evenCache[base + l0 + 1] || evenTable(s, o, l0 + 1);
    for (let j = 0; j < n; j++) {
      const x = T[j] * EVEN_G;
      const i = x | 0;
      const f = x - i;
      const a = A[i] + f * (A[i + 1] - A[i]);
      T[j] = a + lf * (B[i] + f * (B[i + 1] - B[i]) - a);
    }
    return;
  }
  for (let j = 0; j < n; j++) {
    p += dp;
    T[j] = evenPhase(s, o, p, T[j]);
  }
}

/**
 * The path phase the oscillator traces at cycle phase phi, with every travel
 * control: Pace, Laps, Direction (0 Forward, 1 Ping-pong) and Traverse
 * (0 Natural, 1 Even). For the visuals' dot and comet trail.
 */
export function travelPhase(phi, { laps = 1, pace = 0, paceShape = 0, direction = 0, traverse = 0, shape = 0, order = 1, param = 0.5 } = {}) {
  let t = syncPhase(paceWarp(phi - Math.floor(phi), pace, paceShape), laps);
  if (direction === 1) t = pingPong(t);
  if (traverse === 1) t = evenPhase(shape, order, param, t);
  return t;
}
