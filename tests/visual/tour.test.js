import { describe, it, expect } from 'vitest';
import {
  makePlan, buildPlan, tourPoint, sampleRoute, easeLeg, planKey,
  TOUR_LOOP, TOUR_PINGPONG, TOUR_ONCE, ARRIVE_SPEED,
} from '../../src/visual/tour.js';
import { torusDistance } from '../../src/visual/physics.js';

const WPS = [{ x: 0.2, y: 0.2, beats: 2 }, { x: 0.8, y: 0.25, beats: 1 }, { x: 0.5, y: 0.7, beats: 4 }];

function at(plan, beat) { const o = {}; tourPoint(plan, beat, o); return o; }

describe('tour route', () => {
  it('lands on every waypoint exactly on its beat (Loop)', () => {
    const plan = buildPlan(WPS, TOUR_LOOP);
    expect(plan.legs).toBe(3);
    expect(plan.forward).toBe(7);
    expect(plan.period).toBe(7);
    const arrivals = [0, 2, 3, 7, 9, 10];
    const expected = [0, 1, 2, 0, 1, 2];
    arrivals.forEach((b, i) => {
      const p = at(plan, b);
      const w = WPS[expected[i]];
      expect(torusDistance(p.u, p.v, w.x, w.y)).toBeLessThan(1e-9);
    });
  });

  it('eases into waypoints: slower near them than mid-leg, never backwards', () => {
    const plan = buildPlan(WPS, TOUR_LOOP);
    const speed = (b) => { const a = at(plan, b - 0.001), c = at(plan, b + 0.001); return torusDistance(a.u, a.v, c.u, c.v) / 0.002; };
    expect(speed(0.02)).toBeLessThan(speed(1));          // leaving waypoint 1
    expect(speed(1.98)).toBeLessThan(speed(1));          // arriving at waypoint 2
    expect(speed(2)).toBeGreaterThan(0);                 // a loop does not stop
    for (let b = 0; b < 7; b += 0.05) {
      const p = at(plan, b), q = at(plan, b + 0.05);
      expect(p.leg <= q.leg || q.leg === 0).toBe(true);
    }
    // monotonic time easing for every legal end speed
    for (const a of [0, ARRIVE_SPEED, 1]) for (const e of [0, ARRIVE_SPEED, 1]) {
      let prev = -1;
      for (let t = 0; t <= 1.0001; t += 0.01) { const v = easeLeg(Math.min(1, t), a, e); expect(v).toBeGreaterThanOrEqual(prev - 1e-12); prev = v; }
      expect(easeLeg(0, a, e)).toBe(0);
      expect(easeLeg(1, a, e)).toBeCloseTo(1, 12);
    }
  });

  it('ping-pongs back the same way and rests at the turnarounds', () => {
    const plan = buildPlan(WPS, TOUR_PINGPONG);
    expect(plan.legs).toBe(2);
    expect(plan.period).toBe(6);
    for (const b of [0.7, 1.5, 2.4]) {
      const fwd = at(plan, b), back = at(plan, 6 - b);
      expect(torusDistance(fwd.u, fwd.v, back.u, back.v)).toBeLessThan(1e-9);
    }
    const end = at(plan, 3), justBefore = at(plan, 2.99), justAfter = at(plan, 3.01);
    expect(torusDistance(end.u, end.v, 0.5, 0.7)).toBeLessThan(1e-9);
    expect(torusDistance(justBefore.u, justBefore.v, end.u, end.v)).toBeLessThan(1e-4); // nearly at rest
    expect(torusDistance(justAfter.u, justAfter.v, justBefore.u, justBefore.v)).toBeLessThan(1e-6);
  });

  it('Once stops on the last waypoint', () => {
    const plan = buildPlan(WPS, TOUR_ONCE);
    expect(plan.period).toBe(Infinity);
    const p = at(plan, 50);
    expect(p.done).toBe(true);
    expect(torusDistance(p.u, p.v, 0.5, 0.7)).toBeLessThan(1e-9);
    expect(at(plan, 1).done).toBe(false);
  });

  it('takes the shortest way round the torus and stays continuous across the seam', () => {
    const plan = buildPlan([{ x: 0.95, y: 0.5, beats: 1 }, { x: 0.05, y: 0.5, beats: 1 }, { x: 0.05, y: 0.9, beats: 1 }], TOUR_LOOP);
    let prev = at(plan, 0), maxStep = 0;
    for (let b = 0.01; b <= 6; b += 0.01) {
      const p = at(plan, b);
      expect(p.u).toBeGreaterThanOrEqual(0); expect(p.u).toBeLessThan(1);
      expect(p.v).toBeGreaterThanOrEqual(0); expect(p.v).toBeLessThan(1);
      maxStep = Math.max(maxStep, torusDistance(prev.u, prev.v, p.u, p.v));
      prev = p;
    }
    expect(maxStep).toBeLessThan(0.02); // never jumps across the map
    // the first leg crosses the right-hand seam (0.95 -> 1.05), not the long way back
    const mid = at(plan, 0.5);
    expect(mid.u > 0.9 || mid.u < 0.1).toBe(true);
  });

  it('handles none, one and the maximum number of waypoints', () => {
    expect(tourPoint(buildPlan([], TOUR_LOOP), 3, {})).toBe(false);
    const one = buildPlan([{ x: 0.3, y: 0.6, beats: 4 }], TOUR_LOOP);
    const p = at(one, 12.5);
    expect(p.u).toBeCloseTo(0.3, 12);
    expect(p.v).toBeCloseTo(0.6, 12);
    const many = Array.from({ length: 12 }, (_, i) => ({ x: i / 12, y: (i * 5 % 12) / 12, beats: 0.25 }));
    const plan = buildPlan(many, TOUR_LOOP);
    expect(plan.n).toBe(8);
    for (let b = 0; b < 4; b += 0.013) {
      const q = at(plan, b);
      expect(Number.isFinite(q.u) && Number.isFinite(q.v)).toBe(true);
    }
    // bad values are clamped / defaulted, not propagated
    const odd = buildPlan([{ x: NaN, y: 2.5, beats: 99 }, { x: 0.1, beats: -3 }], TOUR_PINGPONG);
    expect(odd.beats[0]).toBe(16);
    const q = at(odd, 1);
    expect(Number.isFinite(q.u) && Number.isFinite(q.v)).toBe(true);
  });

  it('samples the dashed route through every waypoint and reuses its plan object', () => {
    const plan = makePlan();
    buildPlan(WPS, TOUR_LOOP, plan);
    const uv = new Float64Array(2 * (3 * 16 + 1));
    const n = sampleRoute(plan, 16, uv, {});
    expect(n).toBe(49);
    expect(torusDistance(uv[0], uv[1], 0.2, 0.2)).toBeLessThan(1e-9);
    expect(torusDistance(uv[32], uv[33], 0.8, 0.25)).toBeLessThan(1e-9);
    expect(torusDistance(uv[96], uv[97], 0.2, 0.2)).toBeLessThan(1e-9); // closed loop
    const again = buildPlan(WPS, TOUR_PINGPONG, plan);
    expect(again).toBe(plan);
    expect(planKey(WPS, 0)).not.toBe(planKey(WPS, 1));
  });
});
