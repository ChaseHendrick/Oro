import { describe, it, expect } from 'vitest';
import { budgetPixelRatio, quantizeRatio, createDynamicScale, MAX_PIXELS, MIN_SCALE } from '../../src/visual/resolution.js';
import { sanitizePrefs, PREF_DEFAULTS } from '../../src/ui/prefs.js';

describe('render budget (2.11)', () => {
  it('caps the drawing buffer in Auto, keeps device pixels in Full', () => {
    // 5K2K ultrawide at 100%: 11 MP of device pixels
    const pr = budgetPixelRatio(5120, 2160, 1, 2, 'auto');
    expect(5120 * 2160 * pr * pr).toBeLessThanOrEqual(MAX_PIXELS * 1.0001);
    expect(budgetPixelRatio(5120, 2160, 1, 2, 'full')).toBe(1);
    // Retina laptop: a 1512 x 700 map at DPR 2 is under the budget, so it stays sharp
    expect(budgetPixelRatio(1512, 700, 2, 2, 'auto')).toBe(2);
    // 16-inch Retina, larger map: capped
    expect(budgetPixelRatio(1728, 900, 2, 2, 'auto')).toBeLessThan(2);
    // the quality preset's cap still applies
    expect(budgetPixelRatio(800, 600, 2, 1.5, 'auto')).toBe(1.5);
    expect(budgetPixelRatio(800, 600, 3, 2, 'full')).toBe(2);
  });

  it('quantizes ratios', () => {
    expect(quantizeRatio(0.7071)).toBe(23 / 32);
    expect(quantizeRatio(0)).toBe(1 / 32);
  });

  it('steps down on slow frames, back up after steady headroom, never below the floor', () => {
    const d = createDynamicScale();
    let t = 0;
    const run = (ms, gap, target = 16.7) => { let changed = 0; for (const end = t + ms; t < end; t += gap) if (d.frame(t, gap, target)) changed++; return changed; };
    run(1000, 16.7);
    expect(d.scale).toBe(1);
    run(4000, 40);                       // GPU-bound: 25 fps on a 60 Hz screen
    expect(d.scale).toBeLessThan(1);
    expect(d.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    run(20000, 40);
    expect(d.scale).toBe(MIN_SCALE);
    const low = d.scale;
    run(10000, 16.7);                    // headroom again
    expect(d.scale).toBeGreaterThan(low);
    run(60000, 16.7);
    expect(d.scale).toBe(1);
  });

  it('a frame-rate cap is not mistaken for slow frames', () => {
    const d = createDynamicScale();
    for (let t = 0; t < 10000; t += 33.3) d.frame(t, 33.3, 33.3);
    expect(d.scale).toBe(1);
  });

  it('ignores stalls and settles after a resize', () => {
    const d = createDynamicScale();
    for (let t = 0; t < 10000; t += 2000) d.frame(t, 2000, 16.7);  // tab switch / hitch gaps
    expect(d.scale).toBe(1);
    d.settle(10000, 1000);
    expect(d.frame(10500, 100, 16.7)).toBe(false);
  });

  it('the Map resolution preference defaults to Auto and validates', () => {
    expect(PREF_DEFAULTS.renderScale).toBe('auto');
    expect(sanitizePrefs({ renderScale: 'full' }).renderScale).toBe('full');
    expect(sanitizePrefs({ renderScale: 'huge' }).renderScale).toBe('auto');
  });
});
