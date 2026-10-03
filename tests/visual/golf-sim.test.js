// v2.9 Golf in the dot simulation: the golf feel is an override (the
// stored dot settings never change) and the ball's moves are not edits.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { createHistory } from '../../src/core/history.js';
import { defaultState } from '../../src/core/params.js';
import { HeightField } from '../../src/visual/heightfield.js';
import { generateTerrain } from '../../src/dsp/terrains.js';
import { createDotSim } from '../../src/visual/dot-sim.js';
import { GOLF_PHYSICS } from '../../src/core/golf.js';

const A = generateTerrain(0, { size: 128, seed: 7 });

function setup() {
  const store = createStore(defaultState());
  const fields = Array.from({ length: 4 }, () => { const hf = new HeightField(); hf.setTable('A', A, 128); hf.setShape(0, 0, 1); return hf; });
  let now = 0;
  const sim = createDotSim({ store, engine: null, fieldFor: (p) => fields[p], rapier: false, clock: () => now });
  const timers = { setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {} };
  const history = createHistory(store, { timers });
  return { store, sim, history, tick(ms = 16) { now += ms; sim.step(ms / 1000, now); } };
}

describe('golf override in the dot simulation', () => {
  it('rolls the ball without touching the stored dot or the undo history', () => {
    const { store, sim, history, tick } = setup();
    const before = JSON.stringify(store.get('parts.0.dot'));
    const cx = store.get('parts.0.params.centerX'), cy = store.get('parts.0.params.centerY');
    sim.setOverride(0, GOLF_PHYSICS);
    expect(sim.isMarble(0)).toBe(true);
    expect(JSON.stringify(store.get('parts.0.dot'))).toBe(before);
    sim.teleport(0, 0.3, 0.3);
    sim.hold(0, 0.3, 0.3);
    sim.simWrite(0, 0.3, 0.3);
    expect(store.get('parts.0.params.centerX')).toBe(0.3);
    sim.release(0, 4, 0);
    for (let i = 0; i < 30; i++) tick();
    expect(store.get('parts.0.params.centerX')).not.toBe(0.3);
    expect(history.canUndo).toBe(false);
    // quit: back to the stored place, then the stored mode
    sim.release(0, 0, 0);
    store.batch(() => { store.set('parts.0.params.centerX', cx, { source: 'physics' }); store.set('parts.0.params.centerY', cy, { source: 'physics' }); });
    sim.setOverride(0, null);
    for (let i = 0; i < 10; i++) tick();
    expect(sim.isMarble(0)).toBe(false);
    expect(store.get('parts.0.params.centerX')).toBe(cx);
    expect(store.get('parts.0.params.centerY')).toBe(cy);
    expect(JSON.stringify(store.get('parts.0.dot'))).toBe(before);
    expect(history.canUndo).toBe(false);
  });
});
