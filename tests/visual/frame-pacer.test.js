import { describe, it, expect } from 'vitest';
import { createPacer, FPS_CAPS } from '../../src/visual/visuals.js';
import { sanitizePrefs, PREF_DEFAULTS } from '../../src/ui/prefs.js';

/** Paints per second for a display running at `hz`, over two seconds after a warm-up. */
function rate(hz, cap) {
  const p = createPacer();
  const step = 1000 / hz;
  let t = 0, painted = 0;
  for (let i = 0; i < hz; i++) { p.shouldPaint(t, cap); t += step; }      // learn the display
  for (let i = 0; i < 2 * hz; i++) { if (p.shouldPaint(t, cap)) painted++; t += step; }
  return painted / 2;
}

describe('opt-in frame-rate cap', () => {
  it('is uncapped by default', () => {
    expect(FPS_CAPS[0]).toBe(0);
    expect(PREF_DEFAULTS.fpsCap).toBe(0);
    expect(rate(60, 0)).toBe(60);
    expect(rate(120, 0)).toBe(120);
  });
  it('paints every frame when the cap matches the screen', () => {
    expect(rate(60, 60)).toBe(60);
    expect(rate(120, 120)).toBe(120);
  });
  it('halves or quarters faster screens to the cap', () => {
    expect(rate(120, 60)).toBe(60);
    expect(rate(120, 30)).toBe(30);
    expect(rate(60, 30)).toBe(30);
  });
  it('accepts only the offered caps as a saved preference', () => {
    expect(sanitizePrefs({ fpsCap: 60 }).fpsCap).toBe(60);
    expect(sanitizePrefs({ fpsCap: 45 }).fpsCap).toBe(0);
    expect(sanitizePrefs({ fpsCap: '60' }).fpsCap).toBe(0);
  });
});
