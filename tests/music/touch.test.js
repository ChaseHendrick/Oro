import { describe, it, expect } from 'vitest';
import { createTouchTool, strumNote } from '../../src/music/touch.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup() {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const sent = [];
  engine.touchMap = (...args) => sent.push(args);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const tool = createTouchTool({ store, engine, router: music.router, timers: clock.timers, now: () => clock.now() * 1000 });
  return { clock, engine, store, music, tool, sent };
}

describe('touch tool (2.17)', () => {
  it('maps height to in-key notes, higher ground higher', () => {
    const { store } = setup();
    const low = strumNote(store, 0, -1), mid = strumNote(store, 0, 0), high = strumNote(store, 0, 1);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high - low).toBeGreaterThanOrEqual(30);   // about three octaves
    store.set('parts.3.drum.on', 1);
    expect(strumNote(store, 3, -1)).toBe(36);
    expect(strumNote(store, 3, 1)).toBe(43);
  });

  it('strums a new note each time the finger crosses to new ground', () => {
    const { tool, engine, clock } = setup();
    const t0 = clock.now() * 1000;
    tool.handle({ phase: 'down', mode: 'strum', part: 0, height: -0.8, x: 0, y: 0, time: t0 });
    tool.handle({ phase: 'move', mode: 'strum', part: 0, height: -0.79, x: 0.01, y: 0, time: t0 + 50 });   // same note
    tool.handle({ phase: 'move', mode: 'strum', part: 0, height: 0.5, x: 0.4, y: 0, time: t0 + 100 });
    tool.handle({ phase: 'move', mode: 'strum', part: 0, height: 0.9, x: 0.5, y: 0, time: t0 + 110 });     // too soon
    tool.handle({ phase: 'up', mode: 'strum', part: 0, height: 0.9, x: 0.5, y: 0, time: t0 + 200 });
    clock.advance(0.1);
    expect(engine.ons().filter((e) => e.part === 0)).toHaveLength(2);
    clock.advance(1);
    expect(engine.offs().filter((e) => e.part === 0)).toHaveLength(2);
  });

  it('drives the engine rig in FX mode and lets go on release', () => {
    const { tool, sent, engine } = setup();
    tool.handle({ phase: 'down', mode: 'fx', part: 2, height: 0.3, x: 0.5, y: -0.2 });
    tool.handle({ phase: 'up', mode: 'fx', part: 2, height: 0.3, x: 0.5, y: -0.2 });
    expect(sent[0]).toEqual([2, 0.5, -0.2, 0.3, 1, true]);
    expect(sent[1][4]).toBe(0);
    expect(engine.ons()).toHaveLength(0);
  });
});
