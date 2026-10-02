import { describe, it, expect } from 'vitest';
import { encodeWav, encodePCM24Dither, createDitherRng, decodeWav, wavInfo, encodeWav24 } from '../../src/audio/wav.js';

const LSB = 1 / 8388608;

describe('looper WAV export', () => {
  it('24-bit with TPDF dither: right header, error within the dither range, unbiased', () => {
    const n = 48000;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = 0.5 * Math.sin(i / 37); R[i] = -0.25 * Math.cos(i / 53); }
    const bytes = encodeWav([L, R], 44100);
    const info = wavInfo(bytes);
    expect(info).toMatchObject({ sampleRate: 44100, channels: 2, frames: n, bitsPerSample: 24, float: false });
    const d = decodeWav(bytes);
    let worst = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const e = (d.channels[0][i] - L[i]) / LSB;
      worst = Math.max(worst, Math.abs(e));
      sum += e;
    }
    expect(worst).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(Math.abs(sum / n)).toBeLessThan(0.02);
  });

  it('dither keeps detail below one LSB (a plain rounder would erase it)', () => {
    const n = 200000;
    const x = new Float32Array(n).fill(0.25 * LSB);
    const plain = decodeWav(encodeWav24([x], 48000)).channels[0];
    const dith = decodeWav(encodeWav([x], 48000)).channels[0];
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length / LSB;
    expect(mean(plain)).toBe(0);
    expect(mean(dith)).toBeCloseTo(0.25, 1);
  });

  it('exact digital silence stays silent and full scale stays in range', () => {
    const z = new Float32Array(1000);
    const out = encodePCM24Dither([z]);
    expect(out.every(b => b === 0)).toBe(true);
    const loud = new Float32Array([1, -1, 1.5, -1.5]);
    const d = decodeWav(encodeWav([loud], 48000)).channels[0];
    for (const v of d) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('is reproducible (seeded noise)', () => {
    const x = new Float32Array(500).map((_, i) => Math.sin(i));
    expect(encodePCM24Dither([x], 500, createDitherRng(5))).toEqual(encodePCM24Dither([x], 500, createDitherRng(5)));
  });

  it('32-bit float keeps every sample exactly at the context rate', () => {
    const L = new Float32Array([0, 0.1, -0.3333, 1.75, -2.5, 1e-30]);
    const R = new Float32Array([1, 2, 3, 4, 5, 6]).map(v => v / 7);
    const bytes = encodeWav([L, R], 96000, { format: 'float32' });
    const info = wavInfo(bytes);
    expect(info).toMatchObject({ sampleRate: 96000, channels: 2, frames: 6, bitsPerSample: 32, float: true });
    const d = decodeWav(bytes);
    expect(Array.from(d.channels[0])).toEqual(Array.from(L));
    expect(Array.from(d.channels[1])).toEqual(Array.from(R));
    expect(new DataView(bytes.buffer).getUint16(20, true)).toBe(3);
  });
});
