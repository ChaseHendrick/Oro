import { describe, it, expect } from 'vitest';
import { clampEdge, PLAY_MIN, PLAY_MAX } from '../../src/visual/visuals.js';

describe('dot moves: the whole 3 x 3 plane is playable, with walls at its outer edge', () => {
  it('covers three tiles per axis', () => {
    expect(PLAY_MIN).toBe(-1);
    expect(PLAY_MAX).toBe(2);
  });
  it('passes through the neighbouring tiles instead of wrapping at the tile seams', () => {
    expect(clampEdge(0.42)).toBe(0.42);
    expect(clampEdge(1.3)).toBe(1.3);
    expect(clampEdge(-0.6)).toBe(-0.6);
  });
  it('stops at the outer edge', () => {
    expect(clampEdge(-1.4)).toBe(-1);
    expect(clampEdge(2.5)).toBeCloseTo(2 - 1e-4, 9);
    expect(clampEdge(2)).toBeLessThan(2);
    expect(clampEdge(NaN)).toBe(0.5);
  });
});
