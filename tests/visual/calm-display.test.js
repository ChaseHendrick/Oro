// Photosensitivity guard: the map's shape and the scene glow ease in, so fast
// modulation cannot strobe large areas of the screen.
import { describe, it, expect } from 'vitest';
import { CALM, calmShapeStep, calmGlowStep } from '../../src/visual/visuals.js';

// Count WCAG-style transitions (opposing swings of at least `min`) per second.
function flashesPerSecond(values, dt, min) {
  let ref = values[0], dir = 0, n = 0;
  for (const v of values) {
    if (dir >= 0 && v > ref) ref = v;
    if (dir <= 0 && v < ref) ref = v;
    if (dir >= 0 && ref - v >= min) { n++; dir = -1; ref = v; }
    else if (dir <= 0 && v - ref >= min) { n++; dir = 1; ref = v; }
  }
  return n / 2 / (values.length * dt);
}

describe('calm display', () => {
  const dt = 1 / 120;
  // A bass envelope on Morph: a 0.6 jump every eighth note at 104 bpm (3.47/s), 0.28 s decay.
  const period = 60 / 104 / 2;
  const target = (t) => 0.6 * Math.exp(-(t % period) / 0.28);

  it('cuts a per-note Morph envelope to a small ripple', () => {
    const cur = {}, raw = [], shown = [];
    for (let i = 0; i < 1200; i++) {
      const v = target(i * dt);
      calmShapeStep(cur, { morph: v, warp: 0, lift: 1, fold: 0 }, dt, false);
      if (i > 240) { raw.push(v); shown.push(cur.morph); }
    }
    const swing = (a) => Math.max(...a) - Math.min(...a);
    expect(swing(raw)).toBeGreaterThan(0.3);
    expect(swing(shown)).toBeLessThan(0.25 * swing(raw));
  });

  it('reduced motion eases more', () => {
    const a = {}, b = {};
    calmShapeStep(a, { morph: 1 }, 0.1, false);
    calmShapeStep(b, { morph: 1 }, 0.1, true);
    a.morph = 0; b.morph = 0;
    calmShapeStep(a, { morph: 1 }, 0.1, false);
    calmShapeStep(b, { morph: 1 }, 0.1, true);
    expect(b.morph).toBeLessThan(a.morph);
  });

  it('keeps bloom pulsing under three flashes a second on a gated level', () => {
    // level jumping 0 <-> 1 eight times a second
    let glow = 0; const strength = [];
    for (let i = 0; i < 1200; i++) {
      const level = Math.floor(i * dt * 16) % 2;
      glow = calmGlowStep(glow, level, dt);
      strength.push(CALM.bloomBase + CALM.bloomSwing * glow);
    }
    expect(flashesPerSecond(strength, dt, 0.1)).toBeLessThanOrEqual(3);
    expect(Math.max(...strength)).toBeLessThanOrEqual(CALM.bloomBase + CALM.bloomSwing + 1e-9);
  });
});
