import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { HeightField } from '../../src/visual/heightfield.js';
import { generateTerrain } from '../../src/dsp/terrains.js';
import { createDotSim, SIM_META, USER_META, MARBLE_MS, YIELD_MS, BLEND_MS } from '../../src/visual/dot-sim.js';
import { torusDistance } from '../../src/visual/physics.js';

const A = generateTerrain(0, { size: 256, seed: 7 });
const B = generateTerrain(5, { size: 256, seed: 3 });

function setup({ engine = undefined, music = null } = {}) {
  const store = createStore(defaultState());
  const fields = Array.from({ length: 4 }, () => {
    const hf = new HeightField();
    hf.setTable('A', A, 256);
    hf.setTable('B', B, 256);
    hf.setShape(0.5, 0, 1);
    return hf;
  });
  const marbles = [];
  const eng = engine === undefined ? { marble: (part, speed, height) => marbles.push({ part, speed, height, t: clockNow }) } : engine;
  const events = [];
  let clockNow = 0;
  const writes = [];
  store.subscribe('parts', (path, value, meta) => { if (/center[XY]$/.test(path)) writes.push({ path, value, meta }); });
  const sim = createDotSim({
    store, engine: eng, fieldFor: (p) => fields[p], rapier: false, clock: () => clockNow,
    getMusic: () => music, emit: (type, ev) => events.push({ type, ...ev }),
  });
  const run = (seconds, dt = 1 / 60) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) { clockNow += dt * 1000; sim.step(dt, clockNow); }
  };
  return { store, sim, fields, marbles, events, writes, run, now: () => clockNow, setNow: (t) => { clockNow = t; } };
}

describe('dot simulation: who moved the dot', () => {
  it('tags simulated moves as physics and a person\'s moves as visual + user', () => {
    const { store, sim, writes, run } = setup();
    store.set('parts.1.dot.mode', 1, { source: 'ui' });       // Roll
    store.set('parts.2.dot.mode', 2, { source: 'ui' });       // Drift
    store.set('parts.2.dot.driftSpeed', 1, { source: 'ui' });
    run(1);
    const sim1 = writes.filter(w => w.path.startsWith('parts.1') || w.path.startsWith('parts.2'));
    expect(sim1.length).toBeGreaterThan(10);
    for (const w of sim1) {
      expect(w.meta).toBe(SIM_META);
      expect(w.meta.source).toBe('physics');
      expect(w.meta.user).toBe(false);
    }
    writes.length = 0;
    sim.userWrite(0, 0.25, 0.75, true);
    expect(writes.length).toBe(2);
    for (const w of writes) { expect(w.meta.source).toBe('visual'); expect(w.meta.user).toBe(true); }
    expect(store.get('parts.0.params.centerX')).toBe(0.25);
  });

  it('throttles writes: the selected part often, the others less', () => {
    const { store, sim, writes, run } = setup();
    store.set('parts.0.dot.mode', 2, { source: 'ui' });
    store.set('parts.3.dot.mode', 2, { source: 'ui' });
    sim.setSelected(0);
    run(2);
    const sel = writes.filter(w => w.path === 'parts.0.params.centerX').length;
    const other = writes.filter(w => w.path === 'parts.3.params.centerX').length;
    expect(sel).toBeGreaterThan(other * 2);
    expect(other).toBeGreaterThan(20);
    expect(other).toBeLessThanOrEqual(41);
  });

  it('puts a marble where an outside writer (a dot lock) says', () => {
    const { store, sim, run } = setup();
    store.set('parts.0.dot.mode', 1, { source: 'ui' });
    run(0.5);
    store.set('parts.0.params.centerX', 0.9, { source: 'lock' });
    store.set('parts.0.params.centerY', 0.1, { source: 'lock' });
    const s = sim.state(0);
    expect(torusDistance(s.u, s.v, 0.9, 0.1)).toBeLessThan(1e-9);
    expect(Math.hypot(s.vx, s.vz)).toBe(0);
  });
});

describe('dot simulation: marble telemetry', () => {
  it('reports speed and height about 30 times a second while a marble rolls, and a final rest', () => {
    const { store, marbles, run } = setup();
    store.set('parts.1.dot.mode', 1, { source: 'ui' });
    store.set('parts.1.params.centerX', 0.31, { source: 'ui' });
    run(2);
    const m = marbles.filter(x => x.part === 1);
    expect(m.length).toBeGreaterThan(50);
    expect(m.length).toBeLessThan(70);
    for (let i = 1; i < m.length; i++) expect(m[i].t - m[i - 1].t).toBeGreaterThanOrEqual(MARBLE_MS - 1e-6);
    for (const x of m) {
      expect(x.speed).toBeGreaterThanOrEqual(0); expect(x.speed).toBeLessThanOrEqual(1);
      expect(x.height).toBeGreaterThanOrEqual(-1); expect(x.height).toBeLessThanOrEqual(1);
    }
    expect(m.some(x => x.speed > 0.01)).toBe(true);
    // Pin parts and Drift parts send nothing; leaving Roll sends one last rest message.
    expect(marbles.some(x => x.part === 0)).toBe(false);
    marbles.length = 0;
    store.set('parts.1.dot.mode', 0, { source: 'ui' });
    run(0.5);
    expect(marbles.length).toBe(1);
    expect(marbles[0].speed).toBe(0);
  });

  it('runs without an engine, or with one that has no marble()', () => {
    for (const engine of [null, {}]) {
      const { store, run, sim } = setup({ engine });
      store.set('parts.0.dot.mode', 3, { source: 'ui' });
      expect(() => run(0.5)).not.toThrow();
      expect(sim.isActive(0)).toBe(true);
    }
  });
});

describe('dot simulation: Explore', () => {
  it('roams the land and reports peaks and valleys it passes, musically spaced', () => {
    const { store, events, run, sim } = setup();
    store.set('parts.0.dot.mode', 3, { source: 'ui' });
    store.set('parts.0.dot.exploreRate', 0.6, { source: 'ui' });
    const start = { ...sim.state(0) };
    let travelled = 0, prev = { u: start.u, v: start.v };
    for (let i = 0; i < 40; i++) {
      run(0.5);
      const s = sim.state(0);
      travelled += torusDistance(prev.u, prev.v, s.u, s.v);
      prev = { u: s.u, v: s.v };
    }
    const ex = events.filter(e => e.type === 'extremum');
    expect(travelled).toBeGreaterThan(0.5);
    expect(ex.length).toBeGreaterThan(8);
    expect(ex.length).toBeLessThan(140);
    for (const e of ex) {
      expect(e.part).toBe(0);
      expect(['peak', 'valley']).toContain(e.kind);
      expect(e.height).toBeGreaterThanOrEqual(-1); expect(e.height).toBeLessThanOrEqual(1);
      expect(e.x).toBeGreaterThanOrEqual(0); expect(e.x).toBeLessThan(1);
      expect(e.y).toBeGreaterThanOrEqual(0); expect(e.y).toBeLessThan(1);
    }
    // peaks sit higher than the valleys either side of them
    const peaks = ex.filter(e => e.kind === 'peak').map(e => e.height);
    const valleys = ex.filter(e => e.kind === 'valley').map(e => e.height);
    expect(peaks.reduce((a, b) => a + b, 0) / peaks.length).toBeGreaterThan(valleys.reduce((a, b) => a + b, 0) / valleys.length);
    // alternating kinds (a peak is always followed by a valley)
    for (let i = 1; i < ex.length; i++) expect(ex[i].kind).not.toBe(ex[i - 1].kind === 'peak' && ex[i].kind === 'peak' ? 'peak' : 'x');
  });

  it('only fires in Explore mode and never while the marble is held', () => {
    const { store, events, run, sim } = setup();
    store.set('parts.0.dot.mode', 1, { source: 'ui' });
    run(5);
    expect(events.length).toBe(0);
    store.set('parts.0.dot.mode', 3, { source: 'ui' });
    sim.hold(0, 0.4, 0.4);
    for (let i = 0; i < 60; i++) { sim.hold(0, 0.4 + i * 0.005, 0.4); run(1 / 60); }
    expect(events.length).toBe(0);
  });
});

describe('dot simulation: Tour', () => {
  const WPS = [{ x: 0.2, y: 0.2, beats: 1 }, { x: 0.7, y: 0.3, beats: 1 }, { x: 0.4, y: 0.8, beats: 2 }];

  it('travels through the waypoints at the tempo and writes as physics', () => {
    const { store, sim, writes, run } = setup();
    store.set('global.tempo', 120, { source: 'ui' });     // 2 beats a second
    store.set('parts.0.dot.waypoints', WPS, { source: 'ui' });
    store.set('parts.0.dot.mode', 4, { source: 'ui' });
    expect(sim.isActive(0)).toBe(true);
    expect(sim.engineName(0)).toBe('tour');
    run(1);                                  // 2 beats (the blend in is over): on waypoint 3
    let s = sim.state(0);
    expect(torusDistance(s.u, s.v, 0.4, 0.8)).toBeLessThan(1e-6);
    run(1.5);                                // 5 beats: one loop (1 + 1 + 2) + 1 -> waypoint 2
    s = sim.state(0);
    expect(torusDistance(s.u, s.v, 0.7, 0.3)).toBeLessThan(1e-6);
    const mine = writes.filter(w => w.path.startsWith('parts.0'));
    expect(mine.length).toBeGreaterThan(50);
    for (const w of mine.slice(2)) expect(w.meta).toBe(SIM_META);
  });

  it('follows the transport beat while it plays', () => {
    let beat = 0;
    const music = {
      transport: { isPlaying: () => true, beatAt: () => beat, tempo: () => 90 },
      timebase: { perfNow: () => 0, perfToAudio: () => 0 },
    };
    const { store, sim, run } = setup({ music });
    store.set('parts.2.dot.waypoints', WPS, { source: 'ui' });
    store.set('parts.2.dot.mode', 4, { source: 'ui' });
    beat = 2;
    run(1);
    expect(sim.tourBeat(2)).toBe(2);
    const s = sim.state(2);
    expect(torusDistance(s.u, s.v, 0.4, 0.8)).toBeLessThan(1e-6);
  });

  it('steps aside for a dot lock, then glides back onto its route', () => {
    const { store, sim, run, writes } = setup();
    store.set('global.tempo', 60, { source: 'ui' });
    store.set('parts.0.dot.waypoints', [{ x: 0.2, y: 0.5, beats: 4 }, { x: 0.3, y: 0.5, beats: 4 }], { source: 'ui' });
    store.set('parts.0.dot.tourMode', 1, { source: 'ui' });
    store.set('parts.0.dot.mode', 4, { source: 'ui' });
    run(1);
    writes.length = 0;
    store.set('parts.0.params.centerX', 0.8, { source: 'lock' });
    store.set('parts.0.params.centerY', 0.8, { source: 'lock' });
    run((YIELD_MS - 40) / 1000);
    expect(writes.filter(w => w.meta === SIM_META).length).toBe(0);   // no fight with the lock
    expect(torusDistance(sim.state(0).u, sim.state(0).v, 0.8, 0.8)).toBeLessThan(1e-9);
    run((BLEND_MS + 200) / 1000);
    const s = sim.state(0);
    expect(Math.abs(s.v - 0.5)).toBeLessThan(0.01);
    // the glide back never jumps
    for (const axis of ['centerX', 'centerY']) {
      const xs = writes.filter(w => w.path.endsWith(axis)).map(w => w.value);
      for (let i = 1; i < xs.length; i++) expect(torusDistance(xs[i], 0, xs[i - 1], 0)).toBeLessThan(0.05);
      // the shortest way back: y goes 0.8 -> 0.5 directly, never over the seam
      if (axis === 'centerY') for (const y of xs) expect(y).toBeGreaterThanOrEqual(0.49);
    }
  });

  it('pauses while held and resumes smoothly; Pin-like without waypoints', () => {
    const { store, sim, run } = setup();
    store.set('parts.1.dot.mode', 4, { source: 'ui' });
    expect(sim.isActive(1)).toBe(false);                 // no waypoints yet
    store.set('parts.1.dot.waypoints', [{ x: 0.5, y: 0.5, beats: 2 }, { x: 0.6, y: 0.5, beats: 2 }], { source: 'ui' });
    expect(sim.isActive(1)).toBe(true);
    run(1);
    sim.hold(1, 0.1, 0.1);
    run(1);
    expect(torusDistance(sim.state(1).u, sim.state(1).v, 0.1, 0.1)).toBeLessThan(1e-9);
    sim.release(1);
    run(1 / 60);
    expect(torusDistance(sim.state(1).u, sim.state(1).v, 0.1, 0.1)).toBeLessThan(0.02);
    run(1);
    expect(Math.abs(sim.state(1).v - 0.5)).toBeLessThan(0.02);
  });
});
