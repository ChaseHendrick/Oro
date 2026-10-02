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
