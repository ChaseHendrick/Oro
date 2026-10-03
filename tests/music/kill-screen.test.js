// v2.9 Kill screen quirk: after 256 loops a pattern's playback corrupts,
// deterministically, without touching the stored pattern; Stop resets it.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, stepToMidi } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { KILL_LOOPS, killStep, killChance } from '../../src/music/kill-screen.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const LEN = 2;
const STEP_SEC = 60 / 400 / 4;     // a 16th at 400 BPM
const NOTE = stepToMidi({ degree: 0, octave: 0 }, 3, 0, 0);

function setup(killScreen) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = JSON.parse(JSON.stringify(defaultState()));
  s.global.tempo = 400;
  s.global.swing = 0;
  s.global.scaleRoot = 0;
  s.global.scaleType = 0;
  const part = s.parts[0];
  part.seqOn = 1;
  const pat = part.patterns[part.activePattern || 0];
  pat.length = LEN;
  pat.rate = 3;
  pat.steps.forEach((st) => { st.on = 1; st.degree = 0; st.vel = 0.8; st.accent = 0; });
  if (killScreen) s.operator = { killScreen: 1 };
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

function run(env, loops) {
  const fired = [];
  const off = env.music.transport.on('killscreen', (e) => fired.push(e));
  env.music.transport.play();
  env.clock.advance(loops * LEN * STEP_SEC, 0.02);
  env.music.transport.stop();
  if (typeof off === 'function') off();
  return { ons: env.engine.ons(0).map(e => ({ note: e.note, vel: e.vel })), fired };
}

describe('kill screen', () => {
  it('killStep is pure, deterministic and quiet before 256 loops', () => {
    const step = Object.freeze({ on: 1, degree: 2, vel: 0.8 });
    expect(killChance(KILL_LOOPS - 1)).toBe(0);
    expect(killStep(step, 0, 0, 0)).toBe(step);
    expect(killChance(KILL_LOOPS)).toBeGreaterThan(0);
    expect(killChance(KILL_LOOPS + 100)).toBeGreaterThan(killChance(KILL_LOOPS + 10));
    const a = [], b = [];
    for (let l = KILL_LOOPS; l < KILL_LOOPS + 300; l++) for (let i = 0; i < 4; i++) { a.push(killStep(step, l, 1, i)); b.push(killStep(step, l, 1, i)); }
    expect(a).toEqual(b);
    expect(a.some(x => x === null)).toBe(true);
    expect(a.some(x => x && x.degree !== 2)).toBe(true);
    expect(a.some(x => x && x !== step && x.vel !== 0.8)).toBe(true);
    expect(step).toEqual({ on: 1, degree: 2, vel: 0.8 });
  });

  it('off: the pattern plays unchanged however long it loops', () => {
    const env = setup(false);
    const { ons, fired } = run(env, KILL_LOOPS + 120);
    expect(ons.length).toBeGreaterThan((KILL_LOOPS + 100) * LEN);
    expect(ons.every(o => o.note === NOTE && o.vel === 0.8)).toBe(true);
    expect(fired).toEqual([]);
  });

  it('on: clean for 256 loops, then corrupts the same way each run, and the store stays intact', () => {
    const env = setup(true);
    const before = JSON.stringify(env.store.get('parts.0.patterns'));
    const { ons, fired } = run(env, KILL_LOOPS + 120);
    const clean = ons.slice(0, KILL_LOOPS * LEN);
    expect(clean.every(o => o.note === NOTE && o.vel === 0.8)).toBe(true);
    const late = ons.slice(KILL_LOOPS * LEN);
    expect(late.some(o => o.note !== NOTE || o.vel !== 0.8)).toBe(true);
    // some steps were skipped
    expect(ons.length).toBeLessThan(run(setup(false), KILL_LOOPS + 120).ons.length);
    expect(fired.length).toBe(1);
    expect(JSON.stringify(env.store.get('parts.0.patterns'))).toBe(before);
    // a second machine plays exactly the same
    expect(run(setup(true), KILL_LOOPS + 120).ons).toEqual(ons);
  });

  it('Stop resets the count', () => {
    const env = setup(true);
    run(env, KILL_LOOPS + 40);
    env.engine.clear();
    const { ons } = run(env, KILL_LOOPS - 10);
    expect(ons.length).toBeGreaterThan((KILL_LOOPS - 20) * LEN);
    expect(ons.every(o => o.note === NOTE && o.vel === 0.8)).toBe(true);
  });
});
