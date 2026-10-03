// v2.2: Filter 2 and its routing, richer unison and Map spread.
import { describe, it, expect, vi } from 'vitest';
import { Filter2, F2, FILTER2_TYPES } from '../../src/dsp/filter2.js';
import { makeDSP, render, rms, allFinite } from './helpers.js';

vi.setConfig({ testTimeout: 120000 });

const FS = 96000;
function tone(f, n) { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = Math.sin(2 * Math.PI * f * i / FS); return a; }
function through(type, fc, res, f, extra = {}) {
  const flt = new Filter2(), n = 9600, L = tone(f, n), R = new Float64Array(n);
  for (let o = 0; o < n; o += 64) { flt.setTargets(type, fc, res, FS, 64, o === 0, extra.env ?? 1); flt.process(L.subarray(o, o + 64), R.subarray(o, o + 64), 64, false); }
  return rms(L, n / 2, n) / rms(tone(f, n), n / 2, n);
}

describe('Filter 2 types', () => {
  it('low-pass slopes: 24 dB cuts more than 12 dB an octave above', () => {
    const lp12 = through(F2.LP12, 1000, 0, 4000), lp24 = through(F2.LP24, 1000, 0, 4000);
    expect(lp12).toBeLessThan(0.2); expect(lp24).toBeLessThan(lp12 * 0.5);
    expect(through(F2.LP12, 1000, 0, 100)).toBeGreaterThan(0.95);
  });
  it('high-pass, notch and peak do what they say', () => {
    expect(through(F2.HP24, 1000, 0, 100)).toBeLessThan(0.01);
    expect(through(F2.NOTCH, 1000, 0, 1000)).toBeLessThan(0.1);
    expect(through(F2.PEAK, 1000, 1, 1000)).toBeGreaterThan(4);
  });
  it('the low-pass gate closes as the envelope falls', () => {
    expect(through(F2.LPG, 4000, 0, 1000, { env: 0 })).toBeLessThan(0.01);
    expect(through(F2.LPG, 4000, 0, 1000, { env: 1 })).toBeGreaterThan(0.8);
  });
  it('every type stays finite and bounded', () => {
    for (let t = 1; t < FILTER2_TYPES.length; t++) {
      const g = through(t, 800, 0.95, 800);
      expect(Number.isFinite(g)).toBe(true); expect(g).toBeLessThan(12);
    }
  });
});

describe('engine', () => {
  const base = { terrainA: 0, size: 0.3, attack: 0.001, sustain: 1, filterType: 0 };
  const play = (p) => render(makeDSP({ params: { ...base, ...p } }), 0.5, (d, t, k) => { if (k === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 45, vel: 1, time: 0 }); });
  it('Filter 2 in each routing changes the sound and stays finite', () => {
    const dry = play({});
    for (const route of [0, 1, 2]) {
      const out = play({ filter2Type: F2.LP24, filter2Cutoff: 300, filterRoute: route });
      expect(allFinite(out.L) && allFinite(out.R)).toBe(true);
      expect(rms(route === 2 ? out.R : out.L)).toBeLessThan(0.8 * rms(dry.L));
    }
  });
  it('16-voice unison with stack, blend, every spread mode and Map spread plays', () => {
    for (const mode of [0, 1, 2, 3]) {
      const out = play({ unison: 16, detune: 30, unisonMode: mode, unisonStack: 2, unisonBlend: 0.5, unisonMap: 0.7 });
      expect(allFinite(out.L)).toBe(true);
      expect(rms(out.L)).toBeGreaterThan(0.01); expect(rms(out.L)).toBeLessThan(2);
    }
  });
  it('Map spread changes the tone of the copies', () => {
    const a = play({ unison: 4, detune: 0, spread: 0 }), b = play({ unison: 4, detune: 0, spread: 0, unisonMap: 1 });
    let d = 0; for (let i = 0; i < a.L.length; i++) d += (a.L[i] - b.L[i]) ** 2;
    expect(Math.sqrt(d / a.L.length)).toBeGreaterThan(0.05 * rms(a.L));
  });
});
