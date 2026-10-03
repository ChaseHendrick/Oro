// Sound map (v2.8): places drum sounds on a 2D map so that sounds that sound
// alike sit together. Each sound is measured once (brightness, length, low
// end, noisiness, main pitch, attack), the measurements are standardised and
// the library is projected onto its two main axes of variation (PCA). Samples
// from the session are measured the same way and projected with the
// library's axes, so the library's layout never moves.
//
// Runs on the UI side only; nothing here touches the audio thread.

import { DRUM_LIBRARY_SIZE, KIT_PADS } from './drum-kit.js';
import { renderLibraryDrum, libraryList, DRUM_CATEGORIES } from './drum-library.js';

export const FEATURES = ['Brightness', 'Length', 'Low end', 'Noisiness', 'Pitch', 'Attack'];
const WEIGHTS = [1.2, 1, 1, 1, 0.6, 0.5];
/** Category index used for samples from the session (after the library's categories). */
export const SAMPLE_CAT = DRUM_CATEGORIES.length;
/** The category each pad gets from Shuffle kit, in the order of the default kit. */
export const KIT_ROLES = [0, 1, 2, 3, 4, 5, 7, 6];
const ANALYSIS_RATE = 48000;
const N = 2048;

// ---- measurement -----------------------------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));

/**
 * Raw measurements of a mono sound: { centroid (Hz), length (s, peak to 30 dB
 * down), low (share of energy under 160 Hz), flatness (0 tonal .. 1 noise),
 * pitch (Hz of the strongest partial), attack (s, start to peak) }.
 */
export function measureDrum(data, sr) {
  const hop = Math.max(1, Math.round(sr * 0.005));
  const frames = Math.max(1, Math.floor(data.length / hop));
  let peak = 0, peakF = 0;
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let j = 0; j < hop; j++) { const v = data[f * hop + j] || 0; e += v * v; }
    env[f] = Math.sqrt(e / hop);
    if (env[f] > peak) { peak = env[f]; peakF = f; }
  }
  let endF = frames;
  for (let f = peakF; f < frames; f++) if (env[f] < peak * 0.0316) { endF = f; break; }
  let start = 0, amax = 0;
  for (let i = 0; i < data.length; i++) amax = Math.max(amax, Math.abs(data[i]));
  while (start < data.length && Math.abs(data[start]) < amax * 0.1) start++;
  start = Math.max(0, start - 64);
  // power spectrum: up to four Hann frames from the onset, summed
  const pow = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let fr = 0; fr < 4; fr++) {
    const o = start + fr * N;
    if (o >= data.length) break;
    for (let i = 0; i < N; i++) { re[i] = (o + i < data.length ? data[o + i] : 0) * HANN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
  }
  let tot = 0, cen = 0, low = 0, best = 1, logSum = 0, linSum = 0, cnt = 0;
  const df = sr / N, top = Math.min(16000, sr / 2);
  for (let k = 1; k < N / 2; k++) {
    const f = k * df, p = pow[k];
    tot += p; cen += p * f;
    if (f < 160) low += p;
    if (p > pow[best]) best = k;
    if (f >= 100 && f <= top) { logSum += Math.log(p + 1e-12); linSum += p + 1e-12; cnt++; }
  }
  const flat = cnt ? Math.exp(logSum / cnt) / (linSum / cnt) : 0;
  return {
    centroid: tot > 0 ? cen / tot : 0,
    length: Math.max(0, (endF - peakF) * hop / sr),
    low: tot > 0 ? low / tot : 0,
    flatness: Math.min(1, Math.max(0, flat)),
    pitch: best * df,
    attack: peakF * hop / sr,
  };
}

/** The six numbers the map works with (logs where loudness and pitch are heard that way). */
export function featureVector(m) {
  return [
    Math.log2(Math.max(20, m.centroid)), Math.log2(m.length + 0.005), m.low,
    Math.sqrt(m.flatness), Math.log2(Math.max(20, m.pitch)), Math.log2(m.attack + 0.002),
  ];
}

// ---- projection ------------------------------------------------------------

function topEigen(C, start) {
  const d = C.length;
  let v = start.slice();
  for (let it = 0; it < 300; it++) {
    const w = new Array(d).fill(0);
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) w[i] += C[i][j] * v[j];
    const n = Math.hypot(...w) || 1;
    v = w.map(x => x / n);
  }
  let lambda = 0;
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) lambda += v[i] * C[i][j] * v[j];
  return { v, lambda };
}

/**
 * Fit the map to a list of feature vectors: standardise, weight, take the two
 * main axes (PCA by power iteration from fixed starts, signs fixed so the
 * first axis grows with brightness and the second with length), scale to
 * 0..1 and nudge apart points that would sit on top of each other.
 */
export function fitProjection(vectors) {
  const n = vectors.length, d = vectors[0].length;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  for (const v of vectors) for (let j = 0; j < d; j++) sd[j] += (v[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const w = WEIGHTS.slice(0, d);
  const z = vectors.map(v => v.map((x, j) => (x - mean[j]) / sd[j] * w[j]));
  const C = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const r of z) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] += r[i] * r[j] / n;
  const e1 = topEigen(C, Array.from({ length: d }, () => 1 / Math.sqrt(d)));
  const C2 = C.map((row, i) => row.map((x, j) => x - e1.lambda * e1.v[i] * e1.v[j]));
  const e2 = topEigen(C2, Array.from({ length: d }, (_, i) => (i % 2 ? -1 : 1) / Math.sqrt(d)));
  const v1 = e1.v[0] < 0 ? e1.v.map(x => -x) : e1.v;
  const v2 = e2.v[1] < 0 ? e2.v.map(x => -x) : e2.v;
  const raw = z.map(r => [dot(r, v1), dot(r, v2)]);
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const p of raw) for (let a = 0; a < 2; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  const proj = { mean, sd, w, v1, v2, lo, hi };
  const pts = raw.map(p => scale(p, proj));
  relax(pts);
  return { proj, z, pts };
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const scale = (p, { lo, hi }) => [0, 1].map(a => 0.04 + 0.92 * (p[a] - lo[a]) / ((hi[a] - lo[a]) || 1));

/** Push apart points closer than `gap` (deterministic, a few passes). */
function relax(pts, gap = 0.03, passes = 40) {
  for (let it = 0; it < passes; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        let dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
        const d0 = Math.hypot(dx, dy);
        if (d0 >= gap) continue;
        if (d0 < 1e-9) { dx = Math.cos(i * 2.39996 + j); dy = Math.sin(i * 2.39996 + j); } else { dx /= d0; dy /= d0; }
        const push = (gap - d0) / 2;
        pts[i][0] -= dx * push; pts[i][1] -= dy * push; pts[j][0] += dx * push; pts[j][1] += dy * push;
        moved = true;
      }
    }
    for (const p of pts) { p[0] = Math.min(0.98, Math.max(0.02, p[0])); p[1] = Math.min(0.98, Math.max(0.02, p[1])); }
    if (!moved) break;
  }
}

/** Standardised features and map position of a new sound, using the library's projection. */
export function projectVector(vec, proj) {
  const z = vec.map((x, j) => (x - proj.mean[j]) / proj.sd[j] * proj.w[j]);
  const p = scale([dot(z, proj.v1), dot(z, proj.v2)], proj);
  return { z, x: Math.min(0.98, Math.max(0.02, p[0])), y: Math.min(0.98, Math.max(0.02, p[1])) };
}

// ---- the library map (computed once, on first use) --------------------------

let LIB = null;

function describe(raw, all) {
  // words relative to the library: the lower and upper quarter of each measure
  const q = (key, v) => { const s = all.map(m => m[key]).sort((a, b) => a - b); return v <= s[Math.floor(s.length * 0.25)] ? -1 : v >= s[Math.floor(s.length * 0.75)] ? 1 : 0; };
  const words = [];
  const b = q('centroid', raw.centroid), l = q('length', raw.length), n = q('flatness', raw.flatness), lo = q('low', raw.low);
  if (b) words.push(b > 0 ? 'bright' : 'dark');
  if (l) words.push(l > 0 ? 'long' : 'short');
  if (lo > 0) words.push('deep');
  if (n) words.push(n > 0 ? 'noisy' : 'tonal');
  return words.join(', ');
}

function finishLib(list, raws) {
  const { proj, z, pts } = fitProjection(raws.map(featureVector));
  const points = list.map((e, i) => ({ id: `lib:${e.index}`, index: e.index, name: e.name, cat: e.cat, desc: describe(raws[i], raws), x: pts[i][0], y: pts[i][1], z: z[i], raw: raws[i] }));
  LIB = { points, proj, raws };
  return LIB;
}

/**
 * Every library sound with its place on the map:
 * { points: [{ id, index, name, cat, desc, x, y, z, raw }], proj }.
 */
export function libraryMap() {
  if (LIB) return LIB;
  const list = libraryList();
  return finishLib(list, list.map(e => measureDrum(renderLibraryDrum(e.index, ANALYSIS_RATE), ANALYSIS_RATE)));
}

let pending = null;
/** libraryMap() measured a few sounds at a time, so the page stays responsive (the result is the same). */
export function libraryMapAsync(later = (fn) => setTimeout(fn, 0)) {
  if (LIB) return Promise.resolve(LIB);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const list = libraryList(), raws = [];
    const step = () => {
      try {
        if (LIB) { resolve(LIB); return; }
        const end = Math.min(list.length, raws.length + 12);
        while (raws.length < end) { const e = list[raws.length]; raws.push(measureDrum(renderLibraryDrum(e.index, ANALYSIS_RATE), ANALYSIS_RATE)); }
        if (raws.length < list.length) later(step); else resolve(finishLib(list, raws));
      } catch (err) { pending = null; reject(err); }
    };
    step();
  });
  return pending;
}

const sampleCache = new Map();

/**
 * The map for a session: the library plus `samples` ([{ name, rate, data
 * (base64), pcm (Float32Array) }]), each sample measured once.
 */
export function buildSoundMap(samples = []) {
  const lib = libraryMap();
  const points = lib.points.slice();
  const seen = new Set();
  for (const s of samples) {
    if (!s || !s.pcm || !s.pcm.length || seen.has(s.data)) continue;
    seen.add(s.data);
    let m = sampleCache.get(s.data);
    if (!m) {
      const raw = measureDrum(s.pcm, s.rate);
      m = { raw, ...projectVector(featureVector(raw), lib.proj) };
      if (sampleCache.size > 64) sampleCache.clear();
      sampleCache.set(s.data, m);
    }
    points.push({ id: `smp:${points.length}`, index: -1, name: s.name, cat: SAMPLE_CAT, desc: describe(m.raw, lib.raws), x: m.x, y: m.y, z: m.z, raw: m.raw, sample: { rate: s.rate, data: s.data } });
  }
  return points;
}

// ---- navigation ------------------------------------------------------------

const zDist = (a, b) => Math.hypot(...a.z.map((x, i) => x - b.z[i]));

/**
 * The nearest point from `from` in direction (dx, dy) on the map (y grows
 * upwards), within 70 degrees of it; -1 when there is none.
 */
export function nearestInDirection(points, from, dx, dy) {
  const p = points[from];
  if (!p) return -1;
  let best = -1, bestScore = Infinity;
  const cosMax = Math.cos(70 * Math.PI / 180);
  points.forEach((q, i) => {
    if (i === from) return;
    const vx = q.x - p.x, vy = q.y - p.y, d = Math.hypot(vx, vy);
    if (d < 1e-9) return;
    const along = (vx * dx + vy * dy) / d;
    if (along < cosMax) return;
    const score = d * (1 + 2 * (1 - along));
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** Points ordered by how close they sound to `from` (nearest first), same category unless `anyCategory`. */
export function similarTo(points, from, { anyCategory = false } = {}) {
  const p = points[from];
  if (!p) return [];
  const same = !anyCategory && p.cat !== SAMPLE_CAT;
  return points.map((q, i) => ({ i, d: zDist(p, q) }))
    .filter(({ i }) => i !== from && (!same || points[i].cat === p.cat))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(o => o.i);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A kit that hangs together, as eight library indices (pad order of the
 * default kit: kick, snare, hat, open hat, clap, tom, perc, rim). A seeded
 * random library sound sets the character; each pad takes one of the three
 * sounds of its category that sound closest to it. Same seed, same kit.
 */
export function shuffleKit(seed) {
  const { points } = libraryMap();
  const rnd = mulberry32((seed | 0) ^ 0x2545f491);
  const anchor = points[Math.floor(rnd() * points.length)];
  return KIT_ROLES.slice(0, KIT_PADS).map((cat) => {
    const cands = points.filter(p => p.cat === cat).map(p => ({ p, d: zDist(anchor, p) })).sort((a, b) => a.d - b.d || a.p.index - b.p.index);
    return cands[Math.floor(rnd() * Math.min(3, cands.length))].p.index;
  });
}

export { DRUM_LIBRARY_SIZE };
