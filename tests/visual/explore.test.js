import { describe, it, expect } from 'vitest';
import { ExtremumDetector, Explorer, PEAK, VALLEY, exploreDelta, exploreRefractory, windFraction } from '../../src/visual/explore.js';
import { G } from '../../src/visual/physics.js';

describe('extremum detector', () => {
  it('reports each peak and valley of a wave once, at its extreme', () => {
    const d = new ExtremumDetector();
    const events = [];
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 8; i++) {
      const t = i * dt;
      const h = 0.8 * Math.sin(2 * Math.PI * 0.5 * t);   // a peak every 2 s, valleys in between
      const k = d.push(h, t, 0, dt, 0.2, 0.1);
      if (k) events.push({ k, h: d.height, at: d.u });
    }
    expect(events.length).toBe(8);
    for (let i = 0; i < events.length; i++) expect(events[i].k).toBe(i % 2 === 0 ? PEAK : VALLEY);
    for (const e of events) expect(Math.abs(Math.abs(e.h) - 0.8)).toBeLessThan(0.01);
    // the reported position is where the extreme was, not where it was noticed
    expect(events[0].at).toBeCloseTo(0.5, 1);
  });

  it('ignores jitter smaller than the hysteresis', () => {
    const d = new ExtremumDetector();
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const h = 0.3 + 0.05 * Math.sin(i * 1.7) + 0.04 * Math.sin(i * 0.31);
      if (d.push(h, 0, 0, 1 / 60, 0.2, 0)) n++;
    }
    expect(n).toBe(0);
  });

  it('swallows events inside the refractory time but keeps tracking', () => {
    const d = new ExtremumDetector();
    const ev = [];
    const dt = 1 / 120;
    for (let i = 0; i < 120 * 4; i++) {
      const t = i * dt;
      const h = Math.sin(2 * Math.PI * 4 * t);          // 8 events a second
      const k = d.push(h, 0, 0, dt, 0.3, 0.5);
      if (k) ev.push(t);
    }
    for (let i = 1; i < ev.length; i++) expect(ev[i] - ev[i - 1]).toBeGreaterThanOrEqual(0.5 - 1e-9);
    expect(ev.length).toBeGreaterThanOrEqual(6);
  });

  it('maps the Explore rate to denser, livelier notes', () => {
    expect(exploreDelta(1)).toBeLessThan(exploreDelta(0));
    expect(exploreRefractory(1)).toBeLessThan(exploreRefractory(0));
    expect(windFraction(1)).toBeGreaterThan(windFraction(0));
    expect(exploreDelta(NaN)).toBeCloseTo(exploreDelta(0.5), 12);
  });
});

describe('explorer push', () => {
  it('turns slowly, scales with the rate and leans harder when stuck', () => {
    const e = new Explorer(2);
    const out = { x: 0, z: 0 };
    const angles = [];
    for (let i = 0; i < 60 * 10; i++) {
      e.step(1 / 60, 0.5, 3, out);
      if (i % 60 === 0) angles.push(Math.atan2(out.z, out.x));
      e.heard();
    }
    const mag = Math.hypot(out.x, out.z);
    expect(mag).toBeCloseTo(windFraction(0.5) * G, 6);   // default g
    // it turned, but less than a full turn in 10 s
    let turned = 0;
    for (let i = 1; i < angles.length; i++) { let d = angles[i] - angles[i - 1]; d = Math.atan2(Math.sin(d), Math.cos(d)); turned += d; }
    expect(Math.abs(turned)).toBeGreaterThan(0.5);
    expect(Math.abs(turned)).toBeLessThan(2 * Math.PI);
    // stuck: no notes and no speed for a while -> the push grows
    for (let i = 0; i < 60 * 8; i++) e.step(1 / 60, 0.5, 0, out);
    expect(Math.hypot(out.x, out.z)).toBeGreaterThan(mag * 2);
    for (const v of [out.x, out.z]) expect(Number.isFinite(v)).toBe(true);
  });
});
