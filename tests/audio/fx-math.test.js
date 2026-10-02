import { describe, it, expect } from 'vitest';
import {
  delaySeconds, delayToneFreqs, delayGlideTau, volumeGain, chorusSettings, warmthSettings,
  makeWarmthCurve, softClip, makeSoftClipCurve,
} from '../../src/audio/fx.js';
import { DELAY_DIVS } from '../../src/core/params.js';

describe('delay mappings', () => {
  it('derives the time from tempo and division', () => {
    const quarter = DELAY_DIVS.findIndex(d => d.name === '1/4');
    const eighth = DELAY_DIVS.findIndex(d => d.name === '1/8');
    expect(delaySeconds(120, quarter)).toBeCloseTo(0.5, 9);
    expect(delaySeconds(120, eighth)).toBeCloseTo(0.25, 9);
    expect(delaySeconds(112, 3)).toBeCloseTo(DELAY_DIVS[3].beats * 60 / 112, 9);
    expect(delaySeconds(40, 0)).toBeCloseTo(3, 9);                 // longest: 1/2 at 40 bpm
    expect(delaySeconds(NaN, 99)).toBeGreaterThan(0);               // garbage in, sane out
    expect(delaySeconds(1, 0)).toBeLessThan(4);                     // never beyond the DelayNode
  });

  it('maps tone to a darker or thinner loop', () => {
    const d = delayToneFreqs(0), m = delayToneFreqs(0.5), b = delayToneFreqs(1);
    expect(d.lowpass).toBeCloseTo(900, 6);
    expect(b.lowpass).toBeGreaterThan(18000);
    expect(d.highpass).toBeCloseTo(30, 6);
    expect(b.highpass).toBeLessThan(700);
    expect(m.lowpass).toBeGreaterThan(d.lowpass);
    expect(m.highpass).toBeLessThan(b.highpass);
  });

  it('glides delay time no faster than the slew cap (no pitch-wobble explosions)', () => {
    for (const [a, b] of [[0.5, 0.25], [0.1, 3], [0.268, 0.27]]) {
      const tau = delayGlideTau(a, b);
      const maxSlope = Math.abs(b - a) / tau;   // setTargetAtTime's initial slope
      expect(maxSlope).toBeLessThanOrEqual(0.6 + 1e-9);
      expect(tau).toBeGreaterThanOrEqual(0.05);
    }
  });
});

describe('master mappings', () => {
  it('uses an audio taper for volume', () => {
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(1)).toBe(2);
    expect(volumeGain(0.8)).toBeCloseTo(1.28, 9);
    expect(volumeGain(0.5)).toBeCloseTo(0.5, 9);
  });

  it('chorus at 0 is a clean bypass', () => {
    expect(chorusSettings(0)).toMatchObject({ dry: 1, wet: 0 });
    const c = chorusSettings(1);
    expect(c.wet).toBeCloseTo(0.5, 9);
    expect(c.depth).toBeLessThan(0.0125);   // never sweeps through zero delay
  });

  it('warmth is near-transparent at 0 and gain-compensated at the reference level', () => {
    const curve = makeWarmthCurve(8193);
    const shape = (s, w) => {
      // emulate WaveShaper: x = s * pre in [-1,1], linear interpolation on the curve
      const x = Math.max(-1, Math.min(1, s * w.pre));
      const pos = (x + 1) / 2 * (curve.length - 1);
      const i = Math.min(curve.length - 2, Math.floor(pos));
      const y = curve[i] + (pos - i) * (curve[i + 1] - curve[i]);
      return y * w.post;
    };
    const w0 = warmthSettings(0);
    for (const s of [0.01, 0.25, 0.5, 0.9]) expect(Math.abs(shape(s, w0) - s) / s).toBeLessThan(0.025);
    for (const a of [0.15, 0.5, 1]) {
      const w = warmthSettings(a);
      expect(shape(0.25, w)).toBeCloseTo(0.25, 3);              // reference level unchanged
      expect(shape(0.9, w)).toBeLessThan(0.9);                   // peaks compressed
      expect(shape(-0.25, w)).toBeCloseTo(-0.25, 3);             // symmetric (no DC)
    }
    // monotonic curve
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
  });

  it('soft clip is the identity below the knee and never reaches 1', () => {
    for (const x of [0, 0.1, -0.5, 0.85, -0.85]) expect(softClip(x)).toBe(x);
    for (const x of [0.9, 1, 1.5, 2, 10, -3]) {
      expect(Math.abs(softClip(x))).toBeLessThanOrEqual(1);
      expect(Math.abs(softClip(x))).toBeGreaterThan(0.85);
    }
    let prev = -Infinity;
    for (let x = -3; x <= 3; x += 0.01) { const y = softClip(x); expect(y).toBeGreaterThanOrEqual(prev); prev = y; }
    const c = makeSoftClipCurve(4097);
    expect(c[2048]).toBe(0);
    expect(c[4096]).toBeLessThanOrEqual(1);
    expect(c[0]).toBeGreaterThanOrEqual(-1);
    // the identity part is exactly linear, so WaveShaper interpolation is exact there
    expect(c[2048 + 512]).toBeCloseTo(0.5, 6);
  });
});

describe('ceiling', () => {
  it('maps dB to a linear peak level and clamps to the -6..0 dB range', async () => {
    const { ceilingGain } = await import('../../src/audio/fx.js');
    expect(ceilingGain(0)).toBe(1);
    expect(ceilingGain(-6)).toBeCloseTo(0.501, 3);
    expect(ceilingGain(-0.3)).toBeCloseTo(0.966, 3);
    expect(ceilingGain(-20)).toBeCloseTo(0.501, 3);
    expect(ceilingGain(3)).toBe(1);
    expect(ceilingGain(NaN)).toBeCloseTo(0.966, 3);
  });
});
