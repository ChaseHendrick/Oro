import { describe, it, expect } from 'vitest';
import { logHz, logBands, bandLevels, dbNorm, estimatePeriod, correlation, VISUALIZER_IDS, FFT_SIZE, DB_FLOOR, DB_TOP, TILT_DB_PER_OCTAVE } from '../../src/ui/visualizer.js';
import { sanitizePrefs, UI_PREF_KEYS, PREF_DEFAULTS } from '../../src/ui/prefs.js';
import { DEFAULT_UI } from '../../src/core/store.js';

describe('visualizer maths', () => {
  it('spans 20 Hz to 20 kHz on a log axis', () => {
    expect(logHz(0)).toBeCloseTo(20);
    expect(logHz(1)).toBeCloseTo(20000);
    expect(logHz(0.5)).toBeCloseTo(Math.sqrt(20 * 20000));
  });
  it('maps every band to at least one FFT bin, in order', () => {
    const b = logBands(200, 48000);
    for (let i = 0; i < 200; i++) {
      expect(b.to[i]).toBeGreaterThan(b.from[i]);
      expect(b.from[i]).toBeGreaterThanOrEqual(1);
      expect(b.to[i]).toBeLessThanOrEqual(FFT_SIZE / 2);
      if (i) expect(b.from[i]).toBeGreaterThanOrEqual(b.from[i - 1]);
    }
  });
  it('reads a tone in the band that holds it, tilted around 1 kHz', () => {
    const b = logBands(120, 48000);
    const freq = new Float32Array(FFT_SIZE / 2).fill(-140);
    const bin = Math.round(1000 / (48000 / FFT_SIZE));
    freq[bin] = -20;
    const out = bandLevels(freq, b);
    const loud = out.indexOf(Math.max(...out));
    expect(b.hz[loud]).toBeGreaterThan(900);
    expect(b.hz[loud]).toBeLessThan(1100);
    expect(out[loud]).toBeCloseTo(-20 + TILT_DB_PER_OCTAVE * Math.log2(b.hz[loud] / 1000), 3);
  });
  it('clamps dB to 0..1', () => {
    expect(dbNorm(DB_FLOOR - 10)).toBe(0);
    expect(dbNorm(DB_TOP + 10)).toBe(1);
  });
  it('finds the period of a wave', () => {
    const n = 4096, period = 109;
    const buf = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / period));
    // from a rising zero crossing, the next one is a period on
    expect(Math.abs(estimatePeriod(buf, period) - period)).toBeLessThanOrEqual(1);
    expect(estimatePeriod(new Float32Array(n), 0)).toBe(0);
  });
  it('measures stereo correlation', () => {
    const L = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 7));
    expect(correlation(L, L)).toBeCloseTo(1);
    expect(correlation(L, L.map((x) => -x))).toBeCloseTo(-1);
    expect(correlation(new Float32Array(512), new Float32Array(512))).toBe(0);
  });
});

describe('visualizer preference', () => {
  it('is a device setting with the map as the default', () => {
    expect(DEFAULT_UI.visualizer).toBe('map');
    expect(PREF_DEFAULTS.visualizer).toBe('map');
    expect(UI_PREF_KEYS).toContain('visualizer');
    for (const id of VISUALIZER_IDS) expect(sanitizePrefs({ visualizer: id }).visualizer).toBe(id);
    expect(sanitizePrefs({ visualizer: 'lasers' }).visualizer).toBe('map');
  });
});
