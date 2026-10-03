// v2.9 Golf: course layout, par, sinking and saved scores.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HOLES, HOLE_RADIUS, SINK_SPEED, MAX_HOLE_SLOPE, layoutCourse, layoutHole, holeSeed, parFor, sinks, torusDist,
  createRest, restStep, REST_TIME, SHOT_TIMEOUT, holeMessage, holeBadges, roundBadges, golfScores, recordHole, recordRound,
  sumStrokes, slopeAt, roundName, bestTotal, YARDS_PER_TILE, YARDS_PER_UNIT, yardsFor, createCarry, carryStep, carryYards, rangeTee, rangeFlags, recordDrive,
  driveDegree, RANGE_FLAGS,
} from '../../src/core/golf.js';
import { funData, setFunData, _useStorage } from '../../src/core/fun.js';
import { createMemoryStorage } from '../music/fakes.js';

const hills = (u, v) => 0.6 * Math.sin(2 * Math.PI * 3 * u) * Math.cos(2 * Math.PI * 2 * v);

describe('golf course', () => {
  it('lays out the same holes every time, the front nine first', () => {
    const a = layoutCourse(hills, 18), b = layoutCourse(hills, 18);
    expect(HOLES).toBe(18);
    expect(a).toHaveLength(18);
    expect(a).toEqual(b);
    expect(layoutCourse(hills)).toEqual(a.slice(0, 9));
    expect(layoutCourse(hills, 9)).toHaveLength(9);
    expect(new Set(a.map(h => h.seed)).size).toBe(18);
    expect(roundName(9)).toBe('Front nine');
    expect(roundName(18)).toBe('Full 18');
    expect(holeSeed(0)).toBe(holeSeed(0));
    for (const h of a) {
      for (const p of [h.start, h.hole]) {
        expect(p.u).toBeGreaterThanOrEqual(0); expect(p.u).toBeLessThan(1);
        expect(p.v).toBeGreaterThanOrEqual(0); expect(p.v).toBeLessThan(1);
      }
      expect(torusDist(h.start.u, h.start.v, h.hole.u, h.hole.v)).toBeGreaterThanOrEqual(0.1);
      expect(h.par).toBeGreaterThanOrEqual(2);
      expect(h.par).toBeLessThanOrEqual(6);
    }
  });

  it('puts land between tee and hole and keeps the hole fairly level', () => {
    for (const h of layoutCourse(hills, 18)) {
      expect(h.rough).toBeGreaterThan(0.3);
      expect(slopeAt(hills, h.hole.u, h.hole.v)).toBeLessThanOrEqual(MAX_HOLE_SLOPE + 1e-9);
    }
  });

  it('still lays out a course on flat land', () => {
    const flat = layoutCourse(() => 0, 18);
    expect(flat).toHaveLength(18);
    expect(flat[0]).toEqual(layoutHole(0, () => 0));
    for (const h of flat) expect(h.rough).toBe(0);
  });

  it('sets par from distance and land', () => {
    expect(parFor(0.16, 0)).toBe(3);
    expect(parFor(0.4, 0)).toBe(4);
    expect(parFor(0.4, 2)).toBe(5);
    expect(parFor(5, 5)).toBe(6);
    expect(parFor(0, 0)).toBe(2);
    expect(parFor(0.3, 2)).toBeGreaterThan(parFor(0.3, 0));
  });
});

describe('sinking and resting', () => {
  it('sinks only when close and slow', () => {
    expect(sinks(0, 0)).toBe(true);
    expect(sinks(HOLE_RADIUS, SINK_SPEED)).toBe(true);
    expect(sinks(HOLE_RADIUS * 1.01, 0)).toBe(false);
    expect(sinks(0, SINK_SPEED + 0.1)).toBe(false);
  });

  it('measures distance across the wrap', () => {
    expect(torusDist(0.99, 0.5, 0.01, 0.5)).toBeCloseTo(0.02, 9);
  });

  it('calls a ball at rest after it stays slow, or after the timeout', () => {
    const r = createRest();
    expect(restStep(r, 3, 0.1)).toBe(false);
    let done = false;
    for (let t = 0; t < REST_TIME + 0.05; t += 0.1) done = restStep(r, 0.01, 0.1);
    expect(done).toBe(true);
    const w = createRest();
    let n = 0;
    while (!restStep(w, 1, 0.1)) n++;
    expect(n * 0.1).toBeGreaterThan(SHOT_TIMEOUT - 0.25);
    expect(n * 0.1).toBeLessThan(SHOT_TIMEOUT + 0.05);
  });

  it('words the hole result and the badges', () => {
    expect(holeMessage(3, 4, 3)).toBe('Hole 3: 4 strokes (par 3)');
    expect(holeMessage(1, 1, 3)).toBe('Hole 1: 1 stroke (par 3)');
    expect(holeBadges(1, 3)).toEqual(['golf-first-hole', 'golf-hole-in-one', 'golf-under-par']);
    expect(holeBadges(3, 3)).toEqual(['golf-first-hole']);
    expect(roundBadges(30, 32)).toEqual(['golf-round', 'golf-under-par']);
    expect(roundBadges(40, 32)).toEqual(['golf-round']);
    expect(sumStrokes([3, null, 4])).toBe(7);
  });
});

describe('golf scores', () => {
  beforeEach(() => _useStorage(createMemoryStorage()));
  afterEach(() => _useStorage(null));

  it('keeps the best per hole and the best round of each length', () => {
    expect(golfScores(null)).toEqual({ best9: null, best18: null, bestHoles: Array(HOLES).fill(null), rounds: 0, bestDrive: null });
    let r = recordHole(funData('golf'), 2, 4);
    expect(r.best).toBe(true);
    setFunData('golf', r.scores);
    r = recordHole(funData('golf'), 2, 5);
    expect(r.best).toBe(false);
    expect(r.scores.bestHoles[2]).toBe(4);
    r = recordHole(funData('golf'), 2, 3);
    setFunData('golf', r.scores);
    expect(funData('golf').bestHoles[2]).toBe(3);
    r = recordHole(funData('golf'), 15, 2);
    setFunData('golf', r.scores);
    expect(funData('golf').bestHoles[15]).toBe(2);
    let t = recordRound(funData('golf'), 40, 9);
    expect(t.best).toBe(true);
    setFunData('golf', t.scores);
    t = recordRound(funData('golf'), 44, 9);
    expect(t.best).toBe(false);
    setFunData('golf', t.scores);
    t = recordRound(funData('golf'), 80, 18);
    expect(t.best).toBe(true);
    setFunData('golf', t.scores);
    t = recordRound(funData('golf'), 79, 18);
    expect(t.best).toBe(true);
    setFunData('golf', t.scores);
    expect(funData('golf')).toMatchObject({ best9: 40, best18: 79, rounds: 4 });
    expect(bestTotal(golfScores(funData('golf')), 9)).toBe(40);
    expect(bestTotal(golfScores(funData('golf')), 18)).toBe(79);
    const odd = golfScores({ best9: -3, bestHoles: ['x', 2.5, 3], rounds: 'a', bestDrive: 0 });
    expect(odd.best9).toBe(null);
    expect(odd.bestHoles.slice(0, 4)).toEqual([null, null, 3, null]);
    expect(odd.bestHoles).toHaveLength(18);
    expect(odd.rounds).toBe(0);
    expect(odd.bestDrive).toBe(null);
  });

  it('counts either round for the round badge', () => {
    expect(roundBadges(40, 36)).toContain('golf-round');
    expect(roundBadges(80, 72)).toContain('golf-round');
  });
});

describe('driving range', () => {
  beforeEach(() => _useStorage(createMemoryStorage()));
  afterEach(() => _useStorage(null));

  it('measures distance from the tee in yards, across the wrap and beyond a tile', () => {
    expect(YARDS_PER_TILE).toBe(200);
    expect(yardsFor(0.5)).toBe(100);
    expect(yardsFor(-1)).toBe(0);
    const c = createCarry(0.95, 0.5);
    expect(carryYards(c)).toBe(0);
    // roll 1.2 tiles east in small steps, through the edge of the map
    let u = 0.95;
    for (let i = 0; i < 120; i++) { u = (u + 0.01) % 1; carryStep(c, u, 0.5); }
    expect(carryYards(c)).toBe(240);
    // and back 0.2 tiles: distance is from the tee, not the path length
    for (let i = 0; i < 20; i++) { u = (u - 0.01 + 1) % 1; carryStep(c, u, 0.5); }
    expect(carryYards(c)).toBe(200);
    const d = createCarry(0.5, 0.5);
    carryStep(d, 0.53, 0.54);
    expect(carryYards(d)).toBe(10);
  });

  it('puts the tee and the flags in the same place every time', () => {
    const t = rangeTee(hills);
    expect(rangeTee(hills)).toEqual(t);
    const flags = rangeFlags(t);
    expect(flags.map(f => f.yards)).toEqual([...RANGE_FLAGS]);
    for (const f of flags) expect(Math.hypot(f.dx, f.dz) * YARDS_PER_UNIT).toBeCloseTo(f.yards, 3);
  });

  it('keeps the longest shot and pitches the note by distance', () => {
    let r = recordDrive(funData('golf'), 120);
    expect(r.best).toBe(true);
    setFunData('golf', r.scores);
    r = recordDrive(funData('golf'), 90);
    expect(r.best).toBe(false);
    setFunData('golf', r.scores);
    r = recordDrive(funData('golf'), 0);
    expect(r.best).toBe(false);
    expect(funData('golf').bestDrive).toBe(120);
    expect(driveDegree(0)).toBe(0);
    expect(driveDegree(100)).toBeGreaterThan(driveDegree(40));
    expect(driveDegree(5000)).toBe(14);
  });
});
