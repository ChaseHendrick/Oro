import { describe, it, expect } from 'vitest';
import {
  bytesToBase64, srgbToLinear, linearToSrgb8, luminance, centreCrop, rgbaToHeight, sniffType,
  detectFrameSize, selectFrames, resampleCycle, fft, framesToBytes, wavetableFromSamples, closeLoop,
  cleanName, importTerrainFile, MAX_IMPORT_BYTES,
} from '../../src/audio/importers.js';
import { base64ToBytes, decodeUserTerrain } from '../../src/dsp/terrains.js';
import { sanitizePart } from '../../src/core/migrate.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { encodeWav24, wavInfo } from '../../src/audio/wav.js';

const rand = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

describe('base64', () => {
  it('matches Node and round-trips through the DSP decoder for every length mod 3', () => {
    const r = rand(3);
    for (const n of [0, 1, 2, 3, 4, 5, 255, 65536, 65537]) {
      const b = new Uint8Array(n).map(() => Math.floor(r() * 256));
      const s = bytesToBase64(b);
      expect(s).toBe(Buffer.from(b).toString('base64'));
      expect([...base64ToBytes(s)]).toEqual([...b]);
    }
  });
});

describe('luminance', () => {
  it('keeps grey levels exactly (sRGB-correct round trip)', () => {
    for (let v = 0; v < 256; v++) {
      expect(linearToSrgb8(luminance(v, v, v))).toBe(v);
      expect(linearToSrgb8(srgbToLinear(v))).toBe(v);
    }
  });
  it('weights green over red over blue, in linear light', () => {
    const g = linearToSrgb8(luminance(0, 255, 0));
    const r = linearToSrgb8(luminance(255, 0, 0));
    const b = linearToSrgb8(luminance(0, 0, 255));
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(b);
    expect(g).toBe(220);   // 0.7152 linear
    expect(r).toBe(127);   // 0.2126 linear
    expect(b).toBe(76);    // 0.0722 linear
  });
});

describe('image reduction', () => {
  it('centre-crops to a square', () => {
    expect(centreCrop(400, 300)).toEqual({ sx: 50, sy: 0, size: 300 });
    expect(centreCrop(300, 401)).toEqual({ sx: 0, sy: 50, size: 300 });
    expect(centreCrop(64, 64)).toEqual({ sx: 0, sy: 0, size: 64 });
  });

  it('area-averages in linear light (a 50% checkerboard is not code 128)', () => {
    const w = 512;
    const rgba = new Uint8Array(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const v = (x + y) & 1 ? 255 : 0;
      rgba.set([v, v, v, 255], (y * w + x) * 4);
    }
    const out = rgbaToHeight(rgba, w, w, 256);
    expect(out.length).toBe(256 * 256);
    // half white in linear light encodes to sRGB 188, not 128
    for (const v of [out[0], out[1000], out[65535]]) expect(v).toBe(188);
  });

  it('keeps a gradient monotonic, handles alpha and non-integer ratios', () => {
    const w = 300, h = 300;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = Math.round(x * 255 / (w - 1));
      rgba.set([v, v, v, y < 150 ? 255 : 0], (y * w + x) * 4);
    }
    const out = rgbaToHeight(rgba, w, h, 256);
    for (let j = 1; j < 256; j++) expect(out[10 * 256 + j]).toBeGreaterThanOrEqual(out[10 * 256 + j - 1]);
    expect(out[10 * 256]).toBeLessThan(3);
    expect(out[10 * 256 + 255]).toBeGreaterThan(252);
    for (let j = 0; j < 256; j += 17) expect(out[250 * 256 + j]).toBe(0);   // transparent = lowest
  });
});

describe('file type sniffing', () => {
  const b = (...xs) => new Uint8Array(xs.flatMap(x => typeof x === 'string' ? [...x].map(c => c.charCodeAt(0)) : [x]));
  it('recognises formats by magic bytes, whatever the name says', () => {
    expect(sniffType(b('RIFF', 0, 0, 0, 0, 'WAVE'), 'x.bin')).toBe('wav');
    expect(sniffType(b('RIFF', 0, 0, 0, 0, 'WEBP'), 'x')).toBe('image');
    expect(sniffType(b(0x89, 'PNG', 13, 10), 'photo.wav')).toBe('image');
    expect(sniffType(b(0xff, 0xd8, 0xff, 0xe0), '')).toBe('image');
    expect(sniffType(b('GIF89a'), '')).toBe('image');
    expect(sniffType(b('BM', 0, 0), '')).toBe('image');
    expect(sniffType(b('  <svg xmlns="http://www.w3.org/2000/svg">'), 'a')).toBe('svg');
    expect(sniffType(b('<?xml version="1.0"?><svg>'), '')).toBe('svg');
  });
  it('falls back to extension / MIME and rejects the rest', () => {
    expect(sniffType(new Uint8Array(4), 'scan.webp')).toBe('image');
    expect(sniffType(new Uint8Array(4), 'x', 'image/avif')).toBe('image');
    expect(sniffType(new Uint8Array(4), 'table.wav')).toBe('wav');
    expect(sniffType(b('ID3', 4, 0), 'song.mp3', 'audio/mpeg')).toBe(null);
    expect(sniffType(b('%PDF-1.7'), 'doc.pdf', 'application/pdf')).toBe(null);
  });
});

describe('wavetable frames', () => {
  it('detects frame sizes in the documented order', () => {
    expect(detectFrameSize(2048 * 64, { clm: 0 })).toEqual({ frameSize: 2048, count: 64, mode: 'serum' });
    expect(detectFrameSize(2048 * 3, { clm: 1024 })).toEqual({ frameSize: 1024, count: 6, mode: 'clm' });
    expect(detectFrameSize(1024 * 5)).toEqual({ frameSize: 1024, count: 5, mode: 'pow2' });
    expect(detectFrameSize(512 * 3)).toEqual({ frameSize: 512, count: 3, mode: 'pow2' });
    expect(detectFrameSize(256 * 7)).toEqual({ frameSize: 256, count: 7, mode: 'pow2' });
    expect(detectFrameSize(600)).toEqual({ frameSize: 600, count: 1, mode: 'single' });
    expect(detectFrameSize(44100 * 3 + 1)).toEqual({ frameSize: 2048, count: 64, mode: 'chop' });
    expect(() => detectFrameSize(1)).toThrow();
  });

  it('spreads frame picks evenly when there are more than 256', () => {
    expect(selectFrames(5)).toEqual([0, 1, 2, 3, 4]);
    const p = selectFrames(1000, 256);
    expect(p.length).toBe(256);
    expect(p[0]).toBe(0);
    expect(p[255]).toBe(999);
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
  });

  it('FFT matches a direct DFT', () => {
    const n = 64, r = rand(9);
    const x = Array.from({ length: n }, () => r() - 0.5);
    const re = Float64Array.from(x), im = new Float64Array(n);
    fft(re, im);
    for (const k of [0, 1, 5, 31, 32, 63]) {
      let sr = 0, si = 0;
      for (let i = 0; i < n; i++) { sr += x[i] * Math.cos(-2 * Math.PI * k * i / n); si += x[i] * Math.sin(-2 * Math.PI * k * i / n); }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
  });

  it('resamples a band-limited cycle exactly, for power-of-two and odd lengths', () => {
    for (const n of [2048, 600, 100, 256]) {
      const src = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        src[i] = 0.3 + 0.6 * Math.sin(2 * Math.PI * t) + 0.25 * Math.cos(2 * Math.PI * 7 * t + 0.4) + 0.1 * Math.sin(2 * Math.PI * 30 * t);
      }
      const out = resampleCycle(src, 0, n, 256);
      let err = 0;
      for (let m = 0; m < 256; m++) {
        const t = m / 256;
        const want = 0.6 * Math.sin(2 * Math.PI * t) + 0.25 * Math.cos(2 * Math.PI * 7 * t + 0.4) + 0.1 * Math.sin(2 * Math.PI * 30 * t);
        err = Math.max(err, Math.abs(out[m] - want));   // DC removed
      }
      expect(err).toBeLessThan(1e-9);
    }
  });

  it('removes harmonics the 256-sample table cannot hold', () => {
    const n = 2048, src = new Float64Array(n);
    for (let i = 0; i < n; i++) src[i] = Math.sin(2 * Math.PI * 3 * i / n) + Math.sin(2 * Math.PI * 200 * i / n);
    const out = resampleCycle(src, 0, n, 256);
    let err = 0;
    for (let m = 0; m < 256; m++) err = Math.max(err, Math.abs(out[m] - Math.sin(2 * Math.PI * 3 * m / 256)));
    expect(err).toBeLessThan(1e-9);
  });

  it('closes the loop of an arbitrary slice', () => {
    const n = 100, x = new Float64Array(n).map((_, i) => i / n);   // a ramp with a big wrap jump
    const y = closeLoop(x, 0, n);
    expect(Math.abs(y[0] - y[n - 1])).toBeLessThan(0.03);
  });

  it('quantises frames with one shared scale', () => {
    const a = new Float64Array([0, 1, 0, -1]), b = new Float64Array([0, 0.5, 0, -0.5]);
    const bytes = framesToBytes([a, b]);
    expect([...bytes]).toEqual([128, 255, 128, 0, 128, 191, 128, 64]);
  });

  it('turns a Serum-style table into a valid wavetable UserTerrain', async () => {
    const frames = 300, n = 2048;
    const mono = new Float32Array(frames * n);
    for (let f = 0; f < frames; f++) for (let i = 0; i < n; i++) {
      const t = i / n, k = f / (frames - 1);
      mono[f * n + i] = (1 - k) * Math.sin(2 * Math.PI * t) + k * Math.sin(2 * Math.PI * 5 * t);
    }
    const ut = await wavetableFromSamples(mono, { name: 'morph.wav', yieldToUI: false });
    expect(ut).toMatchObject({ name: 'morph', kind: 'wavetable', w: 256, h: 256, mirror: 1, frameSize: 2048, frameCount: 300, frameMode: 'serum' });
    const bytes = base64ToBytes(ut.data);
    expect(bytes.length).toBe(256 * 256);
    // first row is a single sine
    const row0 = Array.from(bytes.subarray(0, 256), v => v / 127.5 - 1);
    expect(row0[64]).toBeGreaterThan(0.97);
    expect(row0[192]).toBeLessThan(-0.97);
    // survives store sanitising and decodes to a table
    const part = sanitizePart({ userTerrain: { A: ut } }, 0);
    expect(part.userTerrain.A).not.toBeNull();
    const table = decodeUserTerrain(part.userTerrain.A, 128);
    expect(table.length).toBe(128 * 128);
    expect(table.every(Number.isFinite)).toBe(true);
  });

  it('makes a single cycle into two rows (the store needs h >= 2)', async () => {
    const mono = new Float32Array(600).map((_, i) => Math.sin(2 * Math.PI * i / 600));
    const ut = await wavetableFromSamples(mono, { yieldToUI: false });
    expect(ut.h).toBe(2);
    expect(ut.frameMode).toBe('single');
    expect(sanitizePart({ userTerrain: { B: ut } }, 1).userTerrain.B).not.toBeNull();
  });

  it('cleans names', () => {
    expect(cleanName('My Table.wav')).toBe('My Table');
    expect(cleanName('')).toBe('Imported');
    expect(cleanName('x'.repeat(200)).length).toBe(80);
  });
});

describe('importTerrainFile (Node, WAV path)', () => {
  it('imports a WAV wavetable into the store in one batch', async () => {
    const store = createStore(defaultState());
    const seen = [];
    store.subscribe('parts.2', (path) => seen.push(path));
    const n = 2048 * 4;
    const ch = new Float32Array(n).map((_, i) => Math.sin(2 * Math.PI * (i % 2048) / 2048));
    const file = new File([encodeWav24([ch], 44100)], 'four.wav', { type: 'audio/wav' });
    const ut = await importTerrainFile(store, 2, 'B', file);
    expect(ut.kind).toBe('wavetable');
    expect(ut.h).toBe(4);
    expect(store.get('parts.2.params.terrainB')).toBe(TERRAIN_INDEX.user);
    expect(store.get('parts.2.userTerrain.B').data).toBe(ut.data);
    expect(seen).toEqual(['parts.2.userTerrain.B', 'parts.2.params.terrainB']);
  });

  it('reads only the frames it needs from a long stereo file', async () => {
    const store = createStore(defaultState());
    const frames = 2048 * 1500;                       // 3 M frames, 1500 wavetable frames, ~18 MB
    const L = new Float32Array(frames), R = new Float32Array(frames);
    for (let i = 0; i < frames; i++) { const t = (i % 2048) / 2048; L[i] = Math.sin(2 * Math.PI * t); R[i] = Math.sin(2 * Math.PI * t); }
    const bytes = encodeWav24([L, R], 48000);
    expect(bytes.length).toBeLessThan(25 * 1024 * 1024);
    // What reading every frame costs on this machine right now (the importer
    // must read about a sixth of them), so a busy CPU does not fail the test.
    const tf = performance.now();
    wavInfo(bytes).readMono(0, frames);
    const fullRead = performance.now() - tf;
    const t0 = performance.now();
    const ut = await importTerrainFile(store, 0, 'A', new File([bytes], 'long.wav'));
    const ms = performance.now() - t0;
    expect(ut.h).toBe(256);
    const row = Array.from(base64ToBytes(ut.data).subarray(0, 256), v => v / 127.5 - 1);
    expect(row[64]).toBeGreaterThan(0.97);                // stereo mix of two equal sines
    expect(ms).toBeLessThan(Math.max(1500, 2 * fullRead));
  }, 60000);

  it('rejects empty, oversized and unsupported files with helpful messages', async () => {
    const store = createStore(defaultState());
    await expect(importTerrainFile(store, 0, 'A', new File([], 'empty.png'))).rejects.toThrow(/empty/);
    const big = { name: 'huge.png', size: MAX_IMPORT_BYTES + 1, type: 'image/png', slice: () => new Blob([]) };
    await expect(importTerrainFile(store, 0, 'A', big)).rejects.toThrow(/25 MB/);
    await expect(importTerrainFile(store, 0, 'A', new File(['ID3abc'], 'song.mp3', { type: 'audio/mpeg' }))).rejects.toThrow(/not an image or a WAV/);
    await expect(importTerrainFile(store, 7, 'A', new File(['x'], 'a.png'))).rejects.toThrow(/no part/);
    await expect(importTerrainFile(store, 0, 'C', new File(['x'], 'a.png'))).rejects.toThrow(/A or B/);
    expect(store.get('parts.0.params.terrainA')).toBe(TERRAIN_INDEX.swell);
  });
});
