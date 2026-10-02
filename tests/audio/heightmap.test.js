import { describe, it, expect } from 'vitest';
import {
  heightFromPng, smoothHeights, smoothSigma, heightsToPlanes, decodeUserTerrainPrecise, axisWeights, srgbEncode, srgbDecode, hasLowPlane,
} from '../../src/audio/heightmap.js';
import { importTerrainFile, readTerrainFile, importOptions, bytesToBase64, framesToPlanes, wavetableFromSamples } from '../../src/audio/importers.js';
import { jobFor, jobKey, buildTerrainData } from '../../src/audio/terrain-jobs.js';
import { decodeUserTerrain, base64ToBytes } from '../../src/dsp/terrains.js';
import { sanitizePart } from '../../src/core/migrate.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { encodePng } from './png-encode.js';

function dem(W, H, f) {
  const s = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) s.push(Math.max(0, Math.min(65535, Math.round(f(x, y)))));
  return s;
}
const corr = (a, b) => {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb);
};

describe('area weights', () => {
  it('cover every source sample once and give every cell the same total', () => {
    for (const [size, n] of [[512, 256], [300, 256], [257, 256], [1000, 7], [256, 256]]) {
      const w = axisWeights(size, n);
      const cell = new Float64Array(n);
      for (let i = 0; i < size; i++) {
        expect(w.w0[i] + w.w1[i]).toBeCloseTo(1, 9);
        cell[w.c0[i]] += w.w0[i];
        if (w.c1[i] >= 0) cell[w.c1[i]] += w.w1[i];
      }
      for (const c of cell) expect(c).toBeCloseTo(size / n, 6);
    }
  });
});

describe('PNG height fields', { timeout: 60000 }, () => {
  it('keeps the levels of a narrow-band 16-bit DEM (an 8-bit canvas would flatten it)', async () => {
    // Relief spanning only 400 of 65536 levels: after 8-bit quantisation that is 2 steps.
    const W = 256, H = 256;
    const s = dem(W, H, (x, y) => 20000 + 200 * (1 + Math.sin(2 * Math.PI * x / W) * Math.cos(2 * Math.PI * y / H)));
    const png = encodePng({ width: W, height: H, colorType: 0, bitDepth: 16, samples: s });
    const r = await heightFromPng(png, { size: 256 });
    expect(r).toMatchObject({ n: 256, bitDepth: 16, colorType: 0 });
    const distinct = new Set(Array.from(r.heights, v => Math.round(v * 65535)));
    expect(distinct.size).toBeGreaterThan(300);
    expect(r.heights[0]).toBeCloseTo(s[0] / 65535, 6);
    const planes = heightsToPlanes(r.heights);
    expect(planes.min).toBeCloseTo(20000 / 65535, 4);
    const hi = new Set(planes.hi);
    expect(hi.size).toBeGreaterThan(200);          // the stretch spends the whole range on the relief
  });

  it('area-averages a big file down, centre-crops, and handles interlaced and odd sizes', async () => {
    const W = 600, H = 520;
    const s = dem(W, H, (x) => x * 100);
    for (const interlace of [false, true]) {
      const r = await heightFromPng(encodePng({ width: W, height: H, colorType: 0, bitDepth: 16, samples: s, interlace }), { size: 256 });
      expect(r.n).toBe(256);
      // crop starts at x = 40; cell 0 averages source columns 40 .. 42.03
      const s0 = 40 + 0.5 * (520 / 256);
      expect(r.heights[0] * 65535).toBeCloseTo(s0 * 100 - 50, -1);
      for (let j = 1; j < 256; j++) expect(r.heights[j]).toBeGreaterThan(r.heights[j - 1]);
    }
    const small = await heightFromPng(encodePng({ width: 20, height: 30, colorType: 0, bitDepth: 8, samples: dem(20, 30, (x, y) => x + y) }));
    expect(small.n).toBe(20);   // never upsampled
  });

  it('reads one channel as data, or perceived brightness in linear light, with transparency as low ground', async () => {
    const px = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 0]];
    const samples = px.flat();
    const png = encodePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, samples });
    const red = await heightFromPng(png, { channel: 'r' });
    expect(Array.from(red.heights)).toEqual([1, 0, 0, 0]);
    const green = await heightFromPng(png, { channel: 'g' });
    expect(Array.from(green.heights)).toEqual([0, 1, 0, 0]);
    const luma = await heightFromPng(png, { channel: 'luma' });
    expect(luma.heights[1]).toBeCloseTo(srgbEncode(0.7152), 5);
    expect(luma.heights[1]).toBeGreaterThan(luma.heights[0]);
    expect(luma.heights[0]).toBeGreaterThan(luma.heights[2]);
    expect(luma.heights[3]).toBe(0);
    // a grey palette image and tRNS on grey
    const pal = Uint8Array.from([0, 0, 0, 128, 128, 128, 255, 255, 255]);
    const p = await heightFromPng(encodePng({ width: 2, height: 2, colorType: 3, bitDepth: 8, samples: [0, 1, 2, 1], palette: pal }), { channel: 'luma' });
    expect(p.n).toBe(2);
    expect(Math.round(p.heights[1] * 255)).toBe(128);
    expect(Math.round(p.heights[2] * 255)).toBe(255);
    const g = await heightFromPng(encodePng({ width: 2, height: 2, colorType: 0, bitDepth: 16, samples: [1000, 60000, 60000, 1000], trns: Uint8Array.from([0xea, 0x60]) }));
    expect(g.heights[0]).toBeCloseTo(1000 / 65535, 9);
    expect(g.heights[1]).toBe(0);
    // wider than tall: the centre square is used
    const wide = await heightFromPng(encodePng({ width: 3, height: 1, colorType: 0, bitDepth: 8, samples: [0, 51, 255] }));
    expect(wide.n).toBe(1);
    expect(wide.heights[0]).toBeCloseTo(0.2, 6);
  });

  it('round-trips sRGB', () => {
    for (let v = 0; v <= 1; v += 0.05) expect(srgbEncode(srgbDecode(v))).toBeCloseTo(v, 9);
  });
});

describe('smoothing', () => {
  it('maps smooth 0..1 to a growing sigma and leaves 0 untouched', () => {
    expect(smoothSigma(0)).toBe(0);
    expect(smoothSigma(1)).toBe(8);
    expect(smoothSigma(0.3)).toBeGreaterThan(1);
    expect(smoothSigma(1, 128)).toBe(4);
    const src = Float32Array.from({ length: 64 }, (_, i) => i % 2);
    expect(Array.from(smoothHeights(src, 8, 0))).toEqual(Array.from(src));
  });

  it('keeps the mean, softens detail, and respects the edge mode', () => {
    const n = 64;
    const src = new Float32Array(n * n);
    src[0] = 1;   // a spike in the corner
    for (const tile of ['mirror', 'wrap']) {
      const out = smoothHeights(src, n, 1, tile);
      expect(Math.max(...out)).toBeLessThan(0.2);
      // wrap leaks over the edge to the far side, mirror reflects it back
      const far = out[(n - 1) * n + (n - 1)];
      if (tile === 'wrap') expect(far).toBeGreaterThan(1e-4); else expect(far).toBeLessThan(1e-9);
      if (tile === 'wrap') expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
    }
  });
});

describe('16-bit storage', { timeout: 60000 }, () => {
  it('splits into high and low planes; the high plane alone is the 8-bit image', () => {
    const v = Float32Array.from([0, 0.25, 0.5, 1]);
    const p = heightsToPlanes(v);
    // 0.25 * 65535 = 16383.75 -> 16384 = 0x4000; 0.5 -> 32768 = 0x8000
    expect(Array.from(p.hi)).toEqual([0, 0x40, 0x80, 0xff]);
    expect(Array.from(p.lo)).toEqual([0, 0, 0, 0xff]);
    const flat = heightsToPlanes(new Float32Array(4).fill(0.3));
    expect(Array.from(flat.hi)).toEqual([0, 0, 0, 0]);
  });

  it('decodes like the DSP decoder, but with 256 times finer steps', () => {
    // One tall peak sets the range; the rest is a gentle slope that 8 bits cannot resolve.
    const n = 64;
    const h = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = 0.003 * x / n;
    h[(n / 2) * n + n / 2] = 1;
    const p = heightsToPlanes(h);
    const ut = { name: 't', kind: 'image', w: n, h: n, mirror: 1, data: bytesToBase64(p.hi), lo: bytesToBase64(p.lo) };
    expect(hasLowPlane(ut)).toBe(true);
    const precise = decodeUserTerrainPrecise(ut, 128);
    const coarse = decodeUserTerrain(ut, 128);   // ignores lo
    expect(precise.length).toBe(128 * 128);
    expect(precise.every(Number.isFinite)).toBe(true);
    expect(Math.max(...precise.map(Math.abs))).toBeCloseTo(1, 5);
    expect(corr(precise, coarse)).toBeGreaterThan(0.9);
    // Along a row far from the peak the 16-bit table follows the slope; the 8-bit one is a staircase.
    const row = (t) => Array.from(t.subarray(8 * 128 + 4, 8 * 128 + 60));
    const ramp = Array.from({ length: 56 }, (_, i) => i);
    expect(corr(row(precise), ramp)).toBeGreaterThan(0.99);
    const c8 = corr(row(coarse), ramp);   // NaN when the 8-bit row is completely flat
    expect(c8 >= 0.95).toBe(false);
  });

  it('terrain jobs use the low plane, and it changes the cache key', () => {
    const p = heightsToPlanes(Float32Array.from({ length: 16 }, (_, i) => i / 15));
    const ut = { name: 'x', kind: 'image', w: 4, h: 4, mirror: 1, data: bytesToBase64(p.hi) };
    const params = { terrainA: TERRAIN_INDEX.user };
    const k8 = jobKey(jobFor(params, ut, 'A', 64));
    const k16 = jobKey(jobFor(params, { ...ut, lo: bytesToBase64(p.lo) }, 'A', 64));
    expect(k16).not.toBe(k8);
    const t = buildTerrainData(jobFor(params, { ...ut, lo: bytesToBase64(p.lo) }, 'A', 64));
    expect(t.length).toBe(64 * 64);
    expect(t.every(Number.isFinite)).toBe(true);
  });

  it('stores wavetables at 16 bits too, compatible with 8-bit readers', async () => {
    const a = new Float64Array([0, 1, 0, -1]);
    const { hi, lo } = framesToPlanes([a]);
    // centred on 32767.5: 0 -> 32768 (0x8000), 1 -> 65535, -1 -> 0
    expect(Array.from(hi)).toEqual([0x80, 0xff, 0x80, 0]);
    expect(Array.from(lo)).toEqual([0, 0xff, 0, 0]);
    const mono = new Float32Array(2048 * 2).map((_, i) => Math.sin(2 * Math.PI * (i % 2048) / 2048));
    const ut = await wavetableFromSamples(mono, { yieldToUI: false });
    expect(typeof ut.lo).toBe('string');
    expect(base64ToBytes(ut.lo).length).toBe(256 * 2);
  });
});

describe('importTerrainFile with options (PNG path, Node)', { timeout: 60000 }, () => {
  it('imports a 16-bit DEM with channel, smoothing and tiling options', async () => {
    const W = 300, H = 300;
    const s = dem(W, H, (x, y) => 32768 + 1000 * Math.sin(x / 9) * Math.cos(y / 13));
    const file = new File([encodePng({ width: W, height: H, colorType: 0, bitDepth: 16, samples: s })], 'alps.png', { type: 'image/png' });
    const store = createStore(defaultState());
    const ut = await importTerrainFile(store, 1, 'B', file, { smooth: 0, tile: 'wrap' });
    expect(ut).toMatchObject({ name: 'alps', kind: 'image', w: 256, h: 256, mirror: 0 });
    expect(typeof ut.lo).toBe('string');
    expect(store.get('parts.1.params.terrainB')).toBe(TERRAIN_INDEX.user);
    expect(store.get('parts.1.userTerrain.B')).toBe(ut);
    const smooth = await readTerrainFile(file, 'alps', { smooth: 1 });
    expect(smooth.mirror).toBe(1);
    // smoothing removes detail: neighbouring samples differ less
    const rough = (u) => { const b = base64ToBytes(u.data); let d = 0; for (let i = 1; i < b.length; i++) d += Math.abs(b[i] - b[i - 1]); return d; };
    expect(rough(smooth)).toBeLessThan(rough(ut) * 0.8);
    // migrate keeps the terrain usable (it may drop `lo`, then the 8-bit plane is used)
    expect(sanitizePart({ userTerrain: { A: ut } }, 0).userTerrain.A).not.toBeNull();
  });

  it('normalises options', () => {
    expect(importOptions()).toEqual({ channel: 'luma', smooth: 0.3, tile: 'mirror' });
    expect(importOptions({ channel: 'b', smooth: 7, tile: 'wrap' })).toEqual({ channel: 'b', smooth: 1, tile: 'wrap' });
    expect(importOptions({ channel: 'alpha', smooth: NaN, tile: 'x' })).toEqual({ channel: 'luma', smooth: 0.3, tile: 'mirror' });
  });

  it('commits imports into one slot in the order they were started', async () => {
    const store = createStore(defaultState());
    const big = new File([encodePng({ width: 900, height: 900, colorType: 0, bitDepth: 16, samples: dem(900, 900, (x) => x * 70) })], 'big.png');
    const small = new File([encodePng({ width: 8, height: 8, colorType: 0, bitDepth: 8, samples: dem(8, 8, (x, y) => x * y) })], 'small.png');
    const a = importTerrainFile(store, 0, 'A', big);
    const b = importTerrainFile(store, 0, 'A', small);
    await Promise.all([a, b]);
    expect(store.get('parts.0.userTerrain.A').name).toBe('small');
  });

  it('rejects broken PNGs with the reason (no canvas fallback in Node)', async () => {
    const store = createStore(defaultState());
    const png = encodePng({ width: 8, height: 8, colorType: 0, bitDepth: 8, samples: new Array(64).fill(1) });
    await expect(importTerrainFile(store, 0, 'A', new File([png.subarray(0, 50)], 'cut.png'))).rejects.toThrow(/cut short|damaged/);
    expect(store.get('parts.0.params.terrainA')).toBe(TERRAIN_INDEX.swell);
  });
});
