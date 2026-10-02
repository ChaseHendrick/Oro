import { describe, it, expect } from 'vitest';
import { generateImpulse, reverbTime, preDelayTime, dampingModel } from '../../src/audio/reverb-ir.js';
import { fft } from '../../src/audio/importers.js';

const SR = 48000;

/**
 * Band energy decay: STFT (Hann 2048, hop 512), energy between lo..hi Hz per
 * frame, Schroeder backward integration over frames, T30 extrapolated to 60 dB.
 */
function bandT30(h, lo, hi) {
  const N = 2048, hop = 512;
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const k0 = Math.ceil(lo * N / SR), k1 = Math.floor(hi * N / SR);
  const e = [];
  for (let o = 0; o + N <= h.length; o += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = h[o + i] * win[i];
    fft(re, im);
    let s = 0;
    for (let k = k0; k <= k1; k++) s += re[k] * re[k] + im[k] * im[k];
    e.push(s);
  }
  const edc = new Float64Array(e.length);
  let acc = 0;
  for (let i = e.length - 1; i >= 0; i--) { acc += e[i]; edc[i] = acc; }
  const db = (i) => 10 * Math.log10(edc[i] / edc[0] + 1e-30);
  let i5 = 0;
  while (i5 < e.length && db(i5) > -5) i5++;
  let i35 = i5;
  while (i35 < e.length && db(i35) > -35) i35++;
  return 2 * (i35 - i5) * hop / SR;
}

function corr(a, b, from, to) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = from; i < to; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb);
}

describe('reverb impulse response', () => {
  it('maps size to 0.4 s .. 7 s exponentially', () => {
    expect(reverbTime(0)).toBeCloseTo(0.4, 6);
    expect(reverbTime(1)).toBeCloseTo(7, 6);
    expect(reverbTime(0.5)).toBeCloseTo(Math.sqrt(0.4 * 7), 6);
    expect(reverbTime(-3)).toBeCloseTo(0.4, 6);
    expect(reverbTime(NaN)).toBeCloseTo(0.4, 6);
  });

  it('is finite, deterministic, energy-normalised and silent during the pre-delay', () => {
    const a = generateImpulse({ sampleRate: SR, size: 0.62, damp: 0.45, seed: 3 });
    const b = generateImpulse({ sampleRate: SR, size: 0.62, damp: 0.45, seed: 3 });
    expect(a.left.length).toBe(a.length);
    expect(a.left.every(Number.isFinite) && a.right.every(Number.isFinite)).toBe(true);
    expect(Buffer.compare(Buffer.from(a.left.buffer), Buffer.from(b.left.buffer))).toBe(0);
    let e = 0;
    for (let i = 0; i < a.length; i++) e += a.left[i] ** 2 + a.right[i] ** 2;
    expect(e / 2).toBeCloseTo(1, 4);
    const pre = Math.floor(preDelayTime(0.62) * SR);
    for (let i = 0; i < pre; i++) expect(a.left[i]).toBe(0);
    expect(a.length / SR).toBeGreaterThan(reverbTime(0.62));
    expect(a.length / SR).toBeLessThan(reverbTime(0.62) * 1.2 + 0.05);
  });

  it('low frequencies decay at the room RT60, highs faster', () => {
    for (const size of [0.2, 0.62, 0.9]) {
      const rt = reverbTime(size);
      const ir = generateImpulse({ sampleRate: SR, size, damp: 0.45 });
      const low = bandT30(ir.left, 60, 400);
      const high = bandT30(ir.left, 8000, 14000);
      expect(low / rt).toBeGreaterThan(0.85);
      expect(low / rt).toBeLessThan(1.15);
      expect(high).toBeLessThan(0.8 * low);
      expect(high).toBeGreaterThan(dampingModel(rt, 0.45).highRT * 0.8);
    }
  });

  it('damps highs faster when Damp goes up, keeping the low end', () => {
    const bright = generateImpulse({ sampleRate: SR, size: 0.6, damp: 0 });
    const mid = generateImpulse({ sampleRate: SR, size: 0.6, damp: 0.5 });
    const dark = generateImpulse({ sampleRate: SR, size: 0.6, damp: 1 });
    const hb = bandT30(bright.left, 8000, 14000), hm = bandT30(mid.left, 8000, 14000), hd = bandT30(dark.left, 8000, 14000);
    expect(hm).toBeLessThan(hb);
    expect(hd).toBeLessThan(hm);
    expect(hd).toBeLessThan(0.45 * hb);
    const ratio = bandT30(dark.left, 60, 400) / bandT30(bright.left, 60, 400);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  it('is wide: left and right tails are decorrelated', () => {
    const ir = generateImpulse({ sampleRate: SR, size: 0.62, damp: 0.45 });
    const c = corr(ir.left, ir.right, Math.round(0.03 * SR), ir.length);
    expect(Math.abs(c)).toBeLessThan(0.1);
  });

  it('works at 44.1 and 96 kHz', () => {
    for (const sr of [44100, 96000]) {
      const ir = generateImpulse({ sampleRate: sr, size: 1, damp: 0.3 });
      expect(ir.length).toBeGreaterThan(7 * sr);
      expect(ir.left.every(Number.isFinite)).toBe(true);
    }
  });

  it('generates the largest room fast enough for the main thread', () => {
    const t0 = performance.now();
    generateImpulse({ sampleRate: 48000, size: 1, damp: 0.5 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(120);
  });
});
