import { describe, it, expect } from 'vitest';
import { clampEdge, PLAY_LIMIT } from '../../src/visual/visuals.js';
import { axisCoords, MESH_RES } from '../../src/visual/terrain-layer.js';
import { EXTENT, W, TILES } from '../../src/visual/heightfield.js';

describe('the map is endless', () => {
  it('lets the dot travel any distance over the copies (no walls)', () => {
    expect(clampEdge(0.42)).toBe(0.42);
    expect(clampEdge(1.3)).toBe(1.3);
    expect(clampEdge(-0.6)).toBe(-0.6);
    expect(clampEdge(-1.4)).toBe(-1.4);
    expect(clampEdge(2.5)).toBe(2.5);
    expect(clampEdge(-37.25)).toBe(-37.25);
    expect(clampEdge(512.75)).toBe(512.75);
  });
  it('only keeps coordinates finite and far from float trouble', () => {
    expect(clampEdge(NaN)).toBe(0.5);
    expect(clampEdge(Infinity)).toBe(0.5);
    expect(clampEdge(1e9)).toBe(PLAY_LIMIT);
    expect(clampEdge(-1e9)).toBe(-PLAY_LIMIT);
  });
  it('draws enough land that its edge stays in the distance fog', () => {
    expect(TILES).toBe(11);
    expect(EXTENT).toBe(W * 5.5);
    for (const q of Object.keys(MESH_RES)) {
      const xs = axisCoords(MESH_RES[q]);
      expect(xs[0]).toBeCloseTo(-EXTENT, 9);
      expect(xs[xs.length - 1]).toBeCloseTo(EXTENT, 9);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
      // the centre tile is the densest, each ring outwards no denser than the one inside
      const spacing = (x) => { let i = 1; while (xs[i] <= x) i++; return xs[i] - xs[i - 1]; };
      expect(spacing(0)).toBeLessThan(spacing(W));
      expect(spacing(W)).toBeLessThanOrEqual(spacing(2 * W));
      expect(spacing(2 * W)).toBeLessThanOrEqual(spacing(3 * W));
    }
  });
});
