import { describe, it, expect } from 'vitest';
import { captureToWavetable, extractCycle, framesToPlanes, WAVETABLE_WIDTH } from '../../src/pedals/guitar.js';
import { makeRandom } from '../../src/pedals/signal.js';
import { decodeUserTerrain, base64ToBytes } from '../../src/dsp/terrains.js';
import { pluck, midiToHz } from './signals.js';

const HEAVY = 60000;

describe('extractCycle', () => {
  it('turns one period at a fractional start into a band-limited, phase-aligned 256-sample cycle', () => {
    const sr = 48000, f = 196.3;
    const P = sr / f;
    const x = new Float32Array(sr / 2);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * f * i / sr + 1.1) + 0.5 * Math.sin(2 * Math.PI * 3 * f * i / sr + 0.4);
    const a = extractCycle(x, 1000.37, P);
    const b = extractCycle(x, 5000.81, P);
    expect(a.length).toBe(WAVETABLE_WIDTH);
    // Same waveform wherever it was cut, because every frame is phase-aligned the same way.
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeLessThan(1e-3);
    // Fundamental starts like a sine: zero at 0 and rising.
    const fund = (i) => Math.sin(2 * Math.PI * i / 256);
    let dot = 0, norm = 0;
    for (let i = 0; i < 256; i++) { dot += a[i] * fund(i); norm += fund(i) * fund(i); }
    expect(dot / norm).toBeCloseTo(1, 2);
  });

  it('drops harmonics the source could not hold', () => {
    const sr = 48000, f = 1318.5;
    const x = new Float32Array(sr / 4);
    for (let i = 0; i < x.length; i++) for (let k = 1; k <= 30; k++) if (k * f < sr / 2) x[i] += Math.sin(2 * Math.PI * k * f * i / sr) / k;
    const c = extractCycle(x, 2000, sr / f);
    // 36-sample period: at most 17 harmonics survive, so the cycle is smooth.
    let step = 0;
    for (let i = 1; i < c.length; i++) step = Math.max(step, Math.abs(c[i] - c[i - 1]));
    expect(step).toBeLessThan(0.5);
    expect(c.every(Number.isFinite)).toBe(true);
  });
});

describe('captureToWavetable', () => {
  it.each([
    [48000, 40, 0], [48000, 57, 0], [44100, 64, 2e-5], [48000, 88, 0], [48000, 45, 1e-4],
  ])('%i Hz, MIDI %i (inharmonicity %f): finds the period and fills a wavetable terrain', { timeout: HEAVY }, (sr, m, inharm) => {
    const sig = pluck({ sampleRate: sr, freq: midiToHz(m), duration: 1.5, start: 0.2, inharm, seed: m });
    const r = captureToWavetable(sig, sr, { name: 'Low E' });
    expect(r.ok).toBe(true);
    const cents = 1200 * Math.log2(r.freq / midiToHz(m));
    expect(Math.abs(cents)).toBeLessThan(inharm ? 8 : 1);
    expect(Math.round(r.note)).toBe(m);
    // The importer's wavetable shape (src/audio/importers.js): w 256, h <= 256 frames, mirror 1, 16-bit planes.
    const ut = r.userTerrain;
    expect(ut).toMatchObject({ kind: 'wavetable', w: 256, mirror: 1, name: 'Low E' });
    expect(ut.h).toBeGreaterThanOrEqual(2);
    expect(ut.h).toBeLessThanOrEqual(256);
    expect(base64ToBytes(ut.data).length).toBe(ut.w * ut.h);
    expect(base64ToBytes(ut.lo).length).toBe(ut.w * ut.h);
    // Starts at the attack, runs into the decay.
    expect(r.startSec).toBeGreaterThan(0.15);
    expect(r.startSec).toBeLessThan(0.22);
    expect(r.endSec).toBeGreaterThan(1.0);
    // Rows are periodic (wrap without a jump) and neighbouring rows are close (a smooth terrain).
    let wrap = 0, rows = 0;
    for (let k = 0; k < r.frames.length; k++) {
      const f = r.frames[k];
      wrap = Math.max(wrap, Math.abs(f[0] - f[f.length - 1]));
      if (k) { let d = 0; for (let i = 0; i < 256; i++) d += (f[i] - r.frames[k - 1][i]) ** 2; rows = Math.max(rows, Math.sqrt(d / 256)); }
    }
    let peak = 0;
    for (const f of r.frames) for (const v of f) peak = Math.max(peak, Math.abs(v));
    expect(wrap / peak).toBeLessThan(0.15);
    // The attack changes fastest (upper partials die first); still a gentle slope.
    expect(rows / peak).toBeLessThan(0.15);
    // And the DSP's own decoder turns it into a full terrain table.
    const table = decodeUserTerrain(ut, 64);
    expect(table.length).toBe(64 * 64);
    expect(table.every(Number.isFinite)).toBe(true);
  });

  it('caps the frame count and honours a requested count', () => {
    const sig = pluck({ sampleRate: 48000, freq: 440, duration: 2.5, start: 0.1 });
    expect(captureToWavetable(sig, 48000).userTerrain.h).toBe(256);
    expect(captureToWavetable(sig, 48000, { frames: 64 }).userTerrain.h).toBe(64);
  }, HEAVY);

  it("'each' lifts the quiet decay; 'shared' keeps the natural fade", () => {
    const sig = pluck({ sampleRate: 48000, freq: 220, duration: 2, start: 0.1, decay: 0.5 });
    const level = (f) => Math.max(...f.map(Math.abs));
    const each = captureToWavetable(sig, 48000, { frames: 32 });
    const shared = captureToWavetable(sig, 48000, { frames: 32, normalize: 'shared' });
    const ratio = (r) => level(r.frames[r.frames.length - 1]) / level(r.frames[0]);
    expect(ratio(shared)).toBeLessThan(0.2);
    // Lifted as far as the +24 dB cap allows (the cap keeps the noise floor down).
    const cap = Math.pow(10, 24 / 20);
    expect(ratio(each)).toBeCloseTo(Math.min(1, ratio(shared) * cap), 1);
    expect(ratio(each)).toBeGreaterThan(ratio(shared) * 10);
  }, HEAVY);

  it('explains, in plain words, why it could not capture', () => {
    const r = makeRandom(3);
    const noise = new Float32Array(48000).map(() => 0.3 * (r() * 2 - 1));
    const cases = [
      captureToWavetable(noise, 48000),
      captureToWavetable(new Float32Array(48000), 48000),
      captureToWavetable(new Float32Array(1000), 48000),
    ];
    expect(cases.map(c => c.ok)).toEqual([false, false, false]);
    expect(cases[0].reason).toMatch(/steady pitch/);
    expect(cases[1].reason).toMatch(/silent/);
    expect(cases[2].reason).toMatch(/too short/);
    for (const c of cases) expect(c.reason).not.toMatch(/\u2014/);
  });

  it('16-bit planes match the importer encoding (high byte is the 8-bit table)', async () => {
    const frames = [new Float64Array([0, 0.5, -1, 1]), new Float64Array([0.25, -0.25, 0, 0])];
    const { hi, lo } = framesToPlanes(frames);
    const flat = frames.flatMap(f => [...f]);
    flat.forEach((f, i) => {
      const v = Math.round(32767.5 + f * 32767.5); // peak is 1 here
      expect((hi[i] << 8) | lo[i]).toBe(v);
    });
    expect([...hi]).toEqual([128, 191, 0, 255, 159, 96, 128, 128]);
    // Cross-check against the audio host's own encoder when its module loads (it is being edited in parallel).
    let importers = null;
    try { importers = await import('../../src/audio/importers.js'); } catch { /* in progress elsewhere */ }
    if (importers && typeof importers.framesToPlanes === 'function') {
      const ref = importers.framesToPlanes(frames);
      expect([...hi]).toEqual([...ref.hi]);
      expect([...lo]).toEqual([...ref.lo]);
    }
  });
});
