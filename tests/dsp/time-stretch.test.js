import { describe, it, expect } from 'vitest';
import { timeStretch, stretchToLength, hann, MIN_RATIO, MAX_RATIO } from '../../src/dsp/time-stretch.js';

const SR = 48000;
const sine = (f, secs, amp = 0.5) => {
  const x = new Float32Array(Math.round(SR * secs));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / SR);
  return x;
};
/** Frequency from upward zero crossings between a and b. */
function zcFreq(x, a = 0, b = x.length) {
  let first = -1, last = -1, count = 0;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + x[i - 1] / (x[i - 1] - x[i]);
      if (first < 0) first = t; else count++;
      last = t;
    }
  }
  return count > 0 ? (count * SR) / (last - first) : 0;
}
/** Frequency of the first strong autocorrelation peak (period) between 50 and 2000 Hz. */
function acFreq(x, a, n) {
  const ac = (lag) => { let s = 0; for (let i = 0; i < n; i++) s += x[a + i] * x[a + i + lag]; return s; };
  const zero = ac(0);
  let prev = ac(Math.floor(SR / 2000) - 1), cur = ac(Math.floor(SR / 2000));
  for (let lag = Math.floor(SR / 2000); lag <= Math.ceil(SR / 50); lag++) {
    const next = ac(lag + 1);
    if (cur > 0.8 * zero && cur >= prev && cur >= next) return SR / (lag + 0.5 * (prev - next) / (prev - 2 * cur + next));
    prev = cur; cur = next;
  }
  return 0;
}
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const finite = (x) => x.every(Number.isFinite);

describe('time stretch (WSOLA)', () => {
  it('gives the requested length for a range of ratios', () => {
    const x = sine(440, 0.5);
    for (const r of [0.5, 0.8, 1.25, 2, 3]) {
      const y = timeStretch(x, r, { sampleRate: SR });
      expect(Math.abs(y.length / x.length - r)).toBeLessThan(0.001);
      expect(finite(y)).toBe(true);
    }
  });

  it('keeps the pitch of a sine (zero crossings and autocorrelation)', () => {
    for (const [f, r] of [[440, 1.5], [220, 0.6], [330, 2], [880, 0.75]]) {
      const y = timeStretch(sine(f, 0.6), r, { sampleRate: SR });
      const a = Math.round(y.length * 0.1), b = Math.round(y.length * 0.9);
      expect(Math.abs(zcFreq(y, a, b) / f - 1)).toBeLessThan(0.01);
      expect(Math.abs(acFreq(y, a, 2048) / f - 1)).toBeLessThan(0.02);
    }
  });

  it('keeps the level and adds no clicks inside a steady tone', () => {
    const x = sine(220, 0.5);
    const y = timeStretch(x, 1.7, { sampleRate: SR });
    const a = 2000, b = y.length - 2000;
    expect(Math.abs(rms(y, a, b) / rms(x) - 1)).toBeLessThan(0.05);
    const slope = 0.5 * 2 * Math.PI * 220 / SR;
    let jump = 0;
    for (let i = a + 1; i < b; i++) jump = Math.max(jump, Math.abs(y[i] - y[i - 1]));
    expect(jump).toBeLessThan(slope * 1.6);
  });

  it('returns an exact copy at ratio 1', () => {
    const x = sine(300, 0.2);
    const y = timeStretch(x, 1, { sampleRate: SR });
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('stretches several channels with the same frames and keeps their shape', () => {
    const L = sine(440, 0.3), R = sine(440, 0.3, 0.25);
    const out = timeStretch([L, R], 1.4, { sampleRate: SR });
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(out[1].length);
    for (let i = 1000; i < out[0].length - 1000; i += 97) expect(out[1][i]).toBeCloseTo(out[0][i] / 2, 5);
  });

  it('makes a seamless loop when asked', () => {
    const f = 200, x = sine(f, 0.5); // exactly 100 periods: a seamless loop
    const { L } = stretchToLength(x, x, 36000, { sampleRate: SR, loop: true });
    expect(L.length).toBe(36000);
    expect(finite(L)).toBe(true);
    const slope = 0.5 * 2 * Math.PI * f / SR;
    let jump = 0;
    for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
    jump = Math.max(jump, Math.abs(L[0] - L[L.length - 1]));
    expect(jump).toBeLessThan(slope * 1.6);
    expect(Math.abs(zcFreq(L) / f - 1)).toBeLessThan(0.01);
  });

  it('survives silence, noise, tiny inputs and odd ratios without NaN', () => {
    expect(finite(timeStretch(new Float32Array(10000), 1.5))).toBe(true);
    const nz = new Float32Array(20000);
    let s = 1;
    for (let i = 0; i < nz.length; i++) { s = (s * 16807) % 2147483647; nz[i] = s / 2147483647 - 0.5; }
    const y = timeStretch(nz, 0.7);
    expect(y.length).toBe(14000);
    expect(finite(y)).toBe(true);
    expect(timeStretch(new Float32Array(3), 2).length).toBe(6);
    expect(timeStretch(sine(100, 0.1), 100).length).toBe(Math.round(4800 * MAX_RATIO));
    expect(timeStretch(sine(100, 0.1), 0.001).length).toBe(Math.round(4800 * MIN_RATIO));
    expect(finite(timeStretch(sine(100, 0.1), NaN))).toBe(true);
  });

  it('uses a periodic Hann window that sums to one at half overlap', () => {
    const w = hann(64);
    for (let i = 0; i < 32; i++) expect(w[i] + w[i + 32]).toBeCloseTo(1, 6);
  });
});
