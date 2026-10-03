// v2.9 Day and night: local hour to palette tint.
import { describe, it, expect } from 'vitest';
import { dayTint, dayPhase, isNightOwlHour, hourOf, stepTint, DAY_KEYS } from '../../src/visual/day-night.js';

describe('day and night tint', () => {
  it('is neutral at noon and deep blue at night', () => {
    expect(dayTint(12)).toEqual([1, 1, 1]);
    const night = dayTint(2);
    expect(night[2]).toBe(1);
    expect(night[0]).toBeLessThan(0.7);
    expect(night[2] - night[0]).toBeGreaterThan(0.3);
  });

  it('is warm at dawn and orange at dusk', () => {
    const dawn = dayTint(6.5), dusk = dayTint(18.5);
    expect(dawn[0]).toBeGreaterThan(1);
    expect(dawn[0]).toBeGreaterThan(dawn[2]);
    expect(dusk[0]).toBeGreaterThan(dusk[1]);
    expect(dusk[1]).toBeGreaterThan(dusk[2]);
    expect(dusk[0] - dusk[2]).toBeGreaterThan(dawn[0] - dawn[2]);
  });

  it('wraps and changes smoothly through the day', () => {
    expect(dayTint(0)).toEqual(dayTint(24));
    expect(dayTint(-1)).toEqual(dayTint(23));
    expect(dayTint(NaN)).toEqual([1, 1, 1]);
    let prev = dayTint(0);
    for (let m = 1; m <= 24 * 60; m++) {
      const cur = dayTint(m / 60);
      for (let c = 0; c < 3; c++) expect(Math.abs(cur[c] - prev[c])).toBeLessThan(0.02);
      prev = cur;
    }
    expect(DAY_KEYS[0][0]).toBe(0);
    expect(DAY_KEYS[DAY_KEYS.length - 1][0]).toBe(24);
  });

  it('names the time of day and the night owl hours', () => {
    expect([dayPhase(2), dayPhase(6), dayPhase(12), dayPhase(18), dayPhase(22)]).toEqual(['night', 'dawn', 'day', 'dusk', 'night']);
    expect(isNightOwlHour(0)).toBe(true);
    expect(isNightOwlHour(3.99)).toBe(true);
    expect(isNightOwlHour(4)).toBe(false);
    expect(isNightOwlHour(23.5)).toBe(false);
    expect(hourOf(new Date(2026, 0, 1, 14, 30))).toBe(14.5);
  });

  it('eases towards a target in small steps', () => {
    const cur = [1, 1, 1];
    let steps = 0;
    while (stepTint(cur, [0.52, 0.62, 1], 0.012)) steps++;
    expect(cur).toEqual([0.52, 0.62, 1]);
    expect(steps).toBeGreaterThan(30);
  });
});
