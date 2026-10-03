// v2.6: humanize in the sequencer, and the undo history.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { sanitizePattern } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { HUMAN_TIME_MAX, HUMAN_VEL_MAX } from '../../src/music/transport.js';
import { createHistory, snapshotState, describeEdit } from '../../src/core/history.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function play(patch = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = defaultState(); s.global.tempo = 120; s.global.swing = 0;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const seq = store.get('parts.0.patterns.0');
  store.set('parts.0.seqOn', 1);
  seq.rate = 3; seq.length = 16;
  seq.steps = seq.steps.map((st, i) => ({ ...st, on: 1, degree: i % 7, gate: 0.5, slide: 0, vel: 0.6, accent: 0 }));
  Object.assign(seq, patch);
  store.set('parts.0.patterns.0', seq);
  music.transport.play(); clock.advance(2.05); music.transport.stop();
  return engine.ons(0);
}

describe('humanize', () => {
  it('off plays exactly on the grid with the set velocity', () => {
    const a = play(), b = play({ humanTime: 0, humanVel: 0 });
    expect(b.map(e => e.time)).toEqual(a.map(e => e.time));
    expect(b.every(e => Math.abs(e.vel - 0.6) < 1e-9)).toBe(true);
  });
  it('pushes notes late by at most 20 ms and wobbles velocity by at most 30%', () => {
    const grid = play(), hum = play({ humanTime: 1, humanVel: 1 });
    expect(hum.length).toBe(grid.length);
    let moved = 0, changed = 0;
    hum.forEach((e, i) => {
      const d = e.time - grid[i].time;
      expect(d).toBeGreaterThanOrEqual(-1e-9); expect(d).toBeLessThanOrEqual(HUMAN_TIME_MAX + 1e-9);
      if (d > 1e-4) moved++;
      expect(Math.abs(e.vel / 0.6 - 1)).toBeLessThanOrEqual(HUMAN_VEL_MAX + 1e-9);
      if (Math.abs(e.vel - 0.6) > 1e-3) changed++;
    });
    expect(moved).toBeGreaterThan(hum.length / 2); expect(changed).toBeGreaterThan(hum.length / 2);
  });
  it('is saved only when set, and clamped', () => {
    const p = sanitizePattern({ ...defaultState().parts[0].patterns[0], humanTime: 3, humanVel: 0 });
    expect(p.humanTime).toBe(1); expect('humanVel' in p).toBe(false);
  });
});

function fakeTimers() {
  let id = 0; const q = new Map();
  return { setTimeout: (fn) => { q.set(++id, fn); return id; }, clearTimeout: (i) => q.delete(i), flush: () => { const fns = [...q.values()]; q.clear(); fns.forEach(f => f()); } };
}

describe('undo history', () => {
  it('coalesces a drag into one step, undoes and redoes it', () => {
    const store = createStore(defaultState()), timers = fakeTimers();
    const h = createHistory(store, { timers });
    const c0 = store.get('parts.0.params.cutoff');
    for (const v of [1000, 1200, 1500]) store.set('parts.0.params.cutoff', v, { source: 'ui' });
    timers.flush();
    expect(h.list().past).toEqual(['Cutoff, track 1']);
    expect(h.undo()).toBe('Cutoff, track 1');
    expect(store.get('parts.0.params.cutoff')).toBe(c0);
    expect(h.redo()).toBe('Cutoff, track 1');
    expect(store.get('parts.0.params.cutoff')).toBe(1500);
  });
  it('ignores the moving dot and preferences, and a new edit clears redo', () => {
    const store = createStore(defaultState()), timers = fakeTimers();
    const h = createHistory(store, { timers });
    store.set('parts.0.params.centerX', 0.3, { source: 'physics' });
    store.set('ui.view', 'top', { source: 'ui' });
    timers.flush();
    expect(h.canUndo).toBe(false);
    store.set('global.tempo', 99, { source: 'ui' }); timers.flush();
    h.undo(); expect(h.canRedo).toBe(true);
    store.set('global.tempo', 101, { source: 'ui' }); timers.flush();
    expect(h.canRedo).toBe(false);
  });
  it('snapshots share imported terrains instead of copying them', () => {
    const s = defaultState(); s.parts[0].userTerrain = { A: { name: 'x', w: 2, h: 2, data: 'AAAA' }, B: null };
    const store = createStore(s);
    const snap = snapshotState(store);
    expect(snap.parts[0].userTerrain).toBe(store.get('parts.0.userTerrain'));
    expect(snap.parts[0].params).not.toBe(store.get('parts.0.params'));
    expect(describeEdit('parts.1.links')).toBe('Links, track 2');
  });
});
