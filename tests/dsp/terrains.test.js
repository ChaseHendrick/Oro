import { describe, it, expect, vi } from 'vitest';
import { TERRAINS } from '../../src/dsp/catalog.js';
import { generateTerrain, decodeUserTerrain, buildMipChain, normalise, base64ToBytes } from '../../src/dsp/terrains.js';
import { sampleBilinear, wrap01, warpPoint, pathTransform, fastSin, fastCos, mulberry32, makeGradientGrid, gradientNoise, torusRho } from '../../src/dsp/terrain-math.js';

// Offline renders are heavy and the suite may share a busy machine: measure
// quality here, not wall-clock speed (dev/dsp/bench.mjs measures CPU time).
vi.setConfig({ testTimeout: 120000 });

const PROC = TERRAINS.map((t, i) => i).filter(i => TERRAINS[i].id !== 'user');
const USER = TERRAINS.findIndex(t => t.id === 'user');

/**
 * Seam statistics along both axes. For value continuity the step across the
 * seam (last column -> first column) must look like an ordinary interior step;
 * for slope continuity the same holds for second differences.
 */
function seamStats(d, S) {
  const at = (i, j) => d[((j + S) % S) * S + ((i + S) % S)];
  let inMax1 = 0, inSum1 = 0, seamMax1 = 0, seamSum1 = 0;
  let inMax2 = 0, inSum2 = 0, seamMax2 = 0, seamSum2 = 0;
  let n1 = 0, n2 = 0;
  for (let axis = 0; axis < 2; axis++) {
    for (let r = 0; r < S; r++) {
      const v = (i) => (axis === 0 ? at(i, r) : at(r, i));
      for (let i = 0; i < S; i++) {
        const d1 = Math.abs(v(i + 1) - v(i));
        const d2 = Math.abs(v(i + 1) - 2 * v(i) + v(i - 1));
        if (i === S - 1) { seamMax1 = Math.max(seamMax1, d1); seamSum1 += d1; }
        else { inMax1 = Math.max(inMax1, d1); inSum1 += d1; n1++; }
        if (i === 0 || i === S - 1) { seamMax2 = Math.max(seamMax2, d2); seamSum2 += d2; }
        else { inMax2 = Math.max(inMax2, d2); inSum2 += d2; n2++; }
      }
    }
  }
  return {
    valueMaxRatio: seamMax1 / inMax1,
    valueMeanRatio: (seamSum1 / (2 * S)) / (inSum1 / n1),
    slopeMaxRatio: seamMax2 / inMax2,
    slopeMeanRatio: (seamSum2 / (4 * S)) / (inSum2 / n2),
  };
}

describe('terrain maths', () => {
  it('fast sine matches Math.sin to ~1e-6', () => {
    let err = 0;
    for (let i = -5000; i < 5000; i++) {
      const x = i * 0.000731;
      err = Math.max(err, Math.abs(fastSin(x) - Math.sin(2 * Math.PI * x)), Math.abs(fastCos(x) - Math.cos(2 * Math.PI * x)));
    }
    expect(err).toBeLessThan(1e-6);
  });

  it('bilinear lookup wraps', () => {
    const S = 8;
    const d = new Float32Array(S * S).map((_, k) => k);
    expect(sampleBilinear(d, S, 0, 0)).toBe(0);
    expect(sampleBilinear(d, S, 1, 1)).toBe(0);
    expect(sampleBilinear(d, S, -1 / S, 0)).toBe(7);
    expect(sampleBilinear(d, S, 0.5 / S, 0)).toBeCloseTo(0.5, 6);
    expect(sampleBilinear(d, S, (S - 0.5) / S, 0)).toBeCloseTo(3.5, 6); // halfway 7 -> 0
    expect(wrap01(-0.25)).toBeCloseTo(0.75, 12);
  });

  it('warp and transform follow the contract formulas', () => {
    const o = {};
    warpPoint(0.3, 0.7, 0.5, o);
    const w = 0.5 * 0.06;
    expect(o.u).toBeCloseTo(0.3 + w * (Math.sin(2 * Math.PI * 2 * 0.7) + 0.5 * Math.sin(2 * Math.PI * (3 * 0.7 + 2 * 0.3))), 12);
    expect(o.v).toBeCloseTo(0.7 + w * (Math.sin(2 * Math.PI * 2 * 0.3) + 0.5 * Math.sin(2 * Math.PI * (3 * 0.3 - 2 * 0.7))), 12);
    pathTransform(1, 0, 0, 0.25, 90, 0, 0.5, 0.5, o);
    expect(o.u).toBeCloseTo(0.5, 12);
    expect(o.v).toBeCloseTo(0.75, 12);
    pathTransform(1, 1, 1, 0.1, 0, 0.25, 0, 0, o);
    const ax = Math.pow(2, 1.5);
    expect(o.u).toBeCloseTo(-0.1 / ax, 12);
    expect(o.v).toBeCloseTo(0.1 * ax, 12);
  });

  it('periodic noise tiles', () => {
    const g = makeGradientGrid(5, mulberry32(3));
    for (let i = 0; i < 50; i++) {
      const u = i / 50, v = (i * 7 % 50) / 50;
      expect(gradientNoise(g, u + 1, v - 2)).toBeCloseTo(gradientNoise(g, u, v), 10);
    }
    expect(torusRho(0.1, 0.2, 0.1, 0.2)).toBe(0);
    expect(torusRho(0.1 + 1, 0.2, 0.1, 0.2)).toBeCloseTo(0, 12);
  });
});

describe('procedural terrains', () => {
  const cache = new Map();
  const gen = (i) => { if (!cache.has(i)) cache.set(i, generateTerrain(i, { size: 512, seed: 7, detail: 0.5 })); return cache.get(i); };

  it('returns null for the imported slot', () => {
    expect(generateTerrain(USER)).toBeNull();
  });

  it('is normalised: zero mean, max |h| = 1, finite', { timeout: 60000 }, () => {
    for (const i of PROC) {
      const d = gen(i);
      expect(d).toBeInstanceOf(Float32Array);
      expect(d.length).toBe(512 * 512);
      let sum = 0, peak = 0, finite = true;
      for (let k = 0; k < d.length; k++) { sum += d[k]; peak = Math.max(peak, Math.abs(d[k])); if (!Number.isFinite(d[k])) finite = false; }
      expect(finite).toBe(true);
      expect(Math.abs(sum / d.length)).toBeLessThan(1e-4);
      expect(peak).toBeCloseTo(1, 5);
    }
  });

  it('tiles seamlessly on the torus (value and slope)', { timeout: 60000 }, () => {
    const rows = [];
    for (const i of PROC) {
      const st = seamStats(gen(i), 512);
      rows.push(`${TERRAINS[i].id.padEnd(8)} value max ${st.valueMaxRatio.toFixed(2)} mean ${st.valueMeanRatio.toFixed(2)} | slope max ${st.slopeMaxRatio.toFixed(2)} mean ${st.slopeMeanRatio.toFixed(2)}`);
      // A seam would show up as the largest step on the map, or as steps
      // systematically bigger than elsewhere.
      rows.push(st);
    }
    console.log('[terrains] seam / interior ratios\n' + rows.filter(r => typeof r === 'string').join('\n'));
    for (const st of rows.filter(r => typeof r !== 'string')) {
      expect(st.valueMaxRatio).toBeLessThan(1.05);
      expect(st.valueMeanRatio).toBeLessThan(2.5);
      expect(st.slopeMaxRatio).toBeLessThan(1.05);
      expect(st.slopeMeanRatio).toBeLessThan(2.5);
    }
  });

  it('is deterministic for (index, seed, detail) and varies with seed and detail', () => {
    for (const i of PROC) {
      const a = generateTerrain(i, { size: 256, seed: 11, detail: 0.3 });
      const b = generateTerrain(i, { size: 256, seed: 11, detail: 0.3 });
      expect(a).toEqual(b);
      const c = generateTerrain(i, { size: 256, seed: 12, detail: 0.3 });
      const e = generateTerrain(i, { size: 256, seed: 11, detail: 0.9 });
      let dc = 0, de = 0;
      for (let k = 0; k < a.length; k++) { dc += Math.abs(a[k] - c[k]); de += Math.abs(a[k] - e[k]); }
      expect(dc / a.length).toBeGreaterThan(0.01);
      expect(de / a.length).toBeGreaterThan(0.002);
    }
  }, 60000);
});

describe('mip chain', () => {
  it('halves down to 32 and preserves the mean', () => {
    const d = generateTerrain(5, { size: 512 });
    const chain = buildMipChain(d, 512);
    expect(chain.map(l => l.size)).toEqual([512, 256, 128, 64, 32]);
    expect(chain[0].data).toBe(d);
    for (const L of chain) {
      expect(L.data.length).toBe(L.size * L.size);
      let s = 0;
      for (let k = 0; k < L.data.length; k++) s += L.data[k];
      expect(Math.abs(s / L.data.length)).toBeLessThan(1e-4);
    }
  });

  it('low-passes before decimating (no aliasing of fine detail)', () => {
    const S = 64;
    // checkerboard at the full-resolution Nyquist: must vanish, not alias to DC
    const nyq = new Float32Array(S * S).map((_, k) => (((k % S) + Math.floor(k / S)) & 1 ? 1 : -1));
    const half = buildMipChain(nyq, S, 32)[1].data;
    expect(Math.max(...half.map(Math.abs))).toBeLessThan(1e-3);
    // a low spatial frequency passes almost unchanged
    const low = new Float32Array(S * S).map((_, k) => Math.sin(2 * Math.PI * 3 * (k % S) / S));
    const lh = buildMipChain(low, S, 32)[1].data;
    for (let i = 0; i < 32; i++) expect(lh[i]).toBeCloseTo(Math.sin(2 * Math.PI * 3 * i / 32), 2);
  });
});

describe('imported terrains', () => {
  const toB64 = (bytes) => Buffer.from(bytes).toString('base64');

  it('decodes base64 without atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 77]);
    expect(Array.from(base64ToBytes(toB64(bytes)))).toEqual(Array.from(bytes));
  });

  it('mirrors an image into a seamless, normalised tile', () => {
    const w = 40, h = 30;
    const img = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = Math.round(255 * (x / (w - 1)) * (0.5 + 0.5 * y / (h - 1)));
    for (const mirror of [1, 0]) {
      const d = decodeUserTerrain({ name: 'ramp', kind: 'image', w, h, mirror, data: toB64(img) }, 128);
      expect(d.length).toBe(128 * 128);
      let peak = 0;
      for (const v of d) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeCloseTo(1, 5);
      const st = seamStats(d, 128);
      expect(st.valueMaxRatio).toBeLessThan(1.25);
    }
  });

  it('keeps wavetable rows periodic and their shape', () => {
    const w = 256, h = 8;
    const wt = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) wt[y * w + x] = Math.round(127.5 + 127 * Math.sin(2 * Math.PI * x / w * (1 + (y > 3))));
    const d = decodeUserTerrain({ name: 'wt', kind: 'wavetable', w, h, mirror: 1, data: toB64(wt) }, 256);
    // row 0 is the first frame: one sine cycle across u (normalisation may scale it)
    let dot = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < 256; i++) { const s = Math.sin(2 * Math.PI * i / 256); dot += d[i] * s; n1 += d[i] * d[i]; n2 += s * s; }
    expect(dot / Math.sqrt(n1 * n2)).toBeGreaterThan(0.995);
    expect(seamStats(d, 256).valueMaxRatio).toBeLessThan(1.25);
  });

  it('downsizes a large image without crashing and stays finite', () => {
    const w = 700, h = 500;
    const img = new Uint8Array(w * h).map((_, k) => (k * 2654435761) >>> 24);
    const d = decodeUserTerrain({ kind: 'image', w, h, mirror: 1, data: toB64(img) }, 64);
    expect(d.every(Number.isFinite)).toBe(true);
  });

  it('combines the low byte plane of a 16-bit height map', () => {
    // The high bytes alone are flat; only the low bytes carry the slope.
    const w = 32, h = 32;
    const hi = new Uint8Array(w * h).fill(128);
    const lo = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lo[y * w + x] = Math.round(255 * Math.sin(Math.PI * x / w) ** 2);
    const base = { kind: 'image', w, h, mirror: 1, data: toB64(hi) };
    const flat = decodeUserTerrain(base, 32);
    expect(flat.every(v => v === 0)).toBe(true);
    const fine = decodeUserTerrain({ ...base, lo: toB64(lo) }, 32);
    expect(fine.every(Number.isFinite)).toBe(true);
    let peak = 0;
    for (const v of fine) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(1, 5);
    // the slope follows the low bytes: with mirror the 32 output columns span the
    // mirrored 64-sample period, so column 8 is source x = 16 (the crest) and column 0 is x = 0
    expect(fine[16 * 32 + 8]).toBeGreaterThan(fine[16 * 32] + 0.5);
    // a Uint8Array plane works too, and an empty plane means 8 bits
    expect(Array.from(decodeUserTerrain({ ...base, lo }, 32))).toEqual(Array.from(fine));
    expect(decodeUserTerrain({ ...base, lo: '' }, 32).every(v => v === 0)).toBe(true);
  });

  it('normalise handles flat input', () => {
    const z = normalise(new Float32Array(16).fill(3));
    expect(Array.from(z)).toEqual(new Array(16).fill(0));
  });
});
