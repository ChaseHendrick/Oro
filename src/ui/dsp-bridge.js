// Optional access to the DSP module's pure maths (path shapes, transform, warp,
// terrain generators) so the UI draws exactly what the oscillator plays.
// import.meta.glob resolves to an empty object when a file does not exist, so
// the UI still builds and runs if the DSP module is missing or renamed; every
// helper below then falls back to a local implementation of the formulas that
// docs/ARCHITECTURE.md specifies.

const pick = (mods) => Object.values(mods)[0] || null;
const paths = pick(import.meta.glob('../dsp/paths.js', { eager: true }));
const tmath = pick(import.meta.glob('../dsp/terrain-math.js', { eager: true }));
const terrains = pick(import.meta.glob('../dsp/terrains.js', { eager: true }));

const fn = (mod, name) => (mod && typeof mod[name] === 'function' ? mod[name] : null);

const TAU = Math.PI * 2;

export const hasPaths = !!fn(paths, 'pathPoint');
export const hasGenerator = !!fn(terrains, 'generateTerrain');

const _fallbackPoint = (shape, t, order, param, out) => {
  // Without the DSP module we can only promise a circle.
  out.x = Math.cos(TAU * t);
  out.y = Math.sin(TAU * t);
  return out;
};

export const pathPoint = fn(paths, 'pathPoint') || _fallbackPoint;

export function makeTransform(stretch, size, rotateDeg, spinPhase, centerX, centerY, out = {}) {
  const f = fn(tmath, 'makeTransform');
  if (f) return f(stretch, size, rotateDeg, spinPhase, centerX, centerY, out);
  const ax = Math.pow(2, stretch * 1.5);
  const sx = ax * size, sy = size / ax;
  const th = (rotateDeg / 360 + spinPhase) * TAU;
  const c = Math.cos(th), s = Math.sin(th);
  out.a = sx * c; out.b = sy * s; out.c = sx * s; out.d = sy * c;
  out.cx = centerX; out.cy = centerY;
  return out;
}

export function applyTransform(xf, x, y, out) {
  out.u = xf.cx + x * xf.a - y * xf.b;
  out.v = xf.cy + x * xf.c + y * xf.d;
  return out;
}

export function sampleBilinear(data, size, u, v) {
  const f = fn(tmath, 'sampleBilinear');
  if (f) return f(data, size, u, v);
  const x = u * size, y = v * size;
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  const x0 = ((xf % size) + size) % size, y0 = ((yf % size) + size) % size;
  const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
  const a = data[y0 * size + x0] + fx * (data[y0 * size + x1] - data[y0 * size + x0]);
  const b = data[y1 * size + x0] + fx * (data[y1 * size + x1] - data[y1 * size + x0]);
  return a + fy * (b - a);
}

export function terrainHeight(dataA, sizeA, dataB, sizeB, morph, warp, u, v) {
  const f = fn(tmath, 'terrainHeight');
  if (f) return f(dataA, sizeA, dataB, sizeB, morph, warp, u, v);
  if (warp > 0) {
    const w = warp * 0.06;
    const nu = u + w * (Math.sin(TAU * 2 * v) + 0.5 * Math.sin(TAU * (3 * v + 2 * u)));
    const nv = v + w * (Math.sin(TAU * 2 * u) + 0.5 * Math.sin(TAU * (3 * u - 2 * v)));
    u = nu; v = nv;
  }
  if (morph <= 0 || !dataB) return sampleBilinear(dataA, sizeA, u, v);
  if (morph >= 1) return sampleBilinear(dataB, sizeB, u, v);
  const a = sampleBilinear(dataA, sizeA, u, v);
  return a + morph * (sampleBilinear(dataB, sizeB, u, v) - a);
}

export function shapeHeight(h, lift, fold) {
  const f = fn(tmath, 'shapeHeight');
  if (f) return f(h, lift, fold);
  const y = h * lift;
  return y > 1.5 ? 1.5 : y < -1.5 ? -1.5 : y;
}

/**
 * Pace (phase distortion of the cycle phase, before Laps). Uses the DSP
 * module's paceWarp(phase, pace, shape) when it exists; until then the cycle
 * view shows Laps only, so it never draws a curve the oscillator does not play.
 */
const paceWarpFn = fn(paths, 'paceWarp') || fn(tmath, 'paceWarp');
export const hasPace = !!paceWarpFn;
export function pacePhase(phase, pace, shape) {
  if (!paceWarpFn || !pace) return phase;
  try {
    const v = paceWarpFn(phase, pace, shape);
    return Number.isFinite(v) ? v : phase;
  } catch {
    return phase;
  }
}

/** Path phase for cycle phase `phase`: t = frac(laps * paceWarp(phase)). */
export function cyclePhase(phase, laps = 1, pace = 0, shape = 0) {
  const g = pacePhase(phase, pace, shape) * (laps > 0 ? laps : 1);
  return g - Math.floor(g);
}

/** Procedural terrain table (or null when the generator is unavailable). */
export function generateTerrain(index, opts) {
  const f = fn(terrains, 'generateTerrain');
  if (!f) return null;
  try {
    const r = f(index, opts);
    if (r && r.data) return { size: r.size || opts.size, data: r.data };
    if (r instanceof Float32Array || r instanceof Float64Array) return { size: opts.size, data: r };
    return null;
  } catch (err) {
    console.warn('[ui] terrain preview failed', err);
    return null;
  }
}

/** Decode an imported user terrain into a table (or null). */
export function decodeUserTerrain(userTerrain, size) {
  const f = fn(terrains, 'decodeUserTerrain');
  if (!f || !userTerrain) return null;
  try {
    const r = f(userTerrain, size);
    if (r && r.data) return { size: r.size || size, data: r.data };
    if (r instanceof Float32Array || r instanceof Float64Array) return { size, data: r };
    return null;
  } catch {
    return null;
  }
}

/**
 * Unit-scale outline of a path shape as an SVG path string in a box of side
 * `box` (with padding). Scan is the one open path, so it is not closed.
 */
export function pathOutline(shape, order, param, box = 24, pad = 3, points = 160) {
  const pt = { x: 0, y: 0 };
  const half = box / 2, r = half - pad;
  let d = '';
  let fx = 0, fy = 0, lx = 0, ly = 0;
  for (let i = 0; i <= points; i++) {
    const t = i === points ? 0.99999 : i / points;
    pathPoint(shape, t, order, param, pt);
    const x = half + pt.x * r, y = half + pt.y * r;
    if (i === 0) { fx = x; fy = y; d += `M${x.toFixed(2)} ${y.toFixed(2)}`; }
    else d += `L${x.toFixed(2)} ${y.toFixed(2)}`;
    lx = x; ly = y;
  }
  if (Math.hypot(lx - fx, ly - fy) < r * 0.1) d += 'Z';
  return d;
}
