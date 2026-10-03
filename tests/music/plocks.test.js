// v2.9 parameter locks: the live transport (timed engine params, returns to
// the knob value, Stop), dot locks alongside, bounce events, migration, undo.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, stepPlocks, PLOCK_IDS, PLOCK_MAX } from '../../src/core/params.js';
import { sanitizePattern, migrateState } from '../../src/core/migrate.js';
import { createHistory } from '../../src/core/history.js';
import { createMusic } from '../../src/music/music.js';
import { START_DELAY } from '../../src/music/transport.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const STEP = 0.125;   // a 1/16 at 120 BPM

/** Track 0 plays 4 steps; `locks[i]` are step i's plocks, `dot[i]` its dot lock. */
function state({ locks = {}, dot = {}, cutoff = 5000 } = {}) {
  const s = JSON.parse(JSON.stringify(defaultState()));
  s.global.tempo = 120;
  s.global.swing = 0;
  const part = s.parts[0];
  part.seqOn = 1;
  part.params.cutoff = cutoff;
  const pat = part.patterns[0];
  pat.length = 4;
  pat.lockGlide = 0;
  pat.steps.forEach((st, i) => {
    st.on = 1;
    if (locks[i]) st.plocks = locks[i];
    if (dot[i]) Object.assign(st, { lock: 1, lx: dot[i][0], ly: dot[i][1] });
  });
  return s;
}

function setup(st) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(st);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

function run(st, seconds = 0.6) {
  const env = setup(st);
  const t0 = env.clock.ctx.currentTime + START_DELAY;
  env.music.transport.play();
  env.clock.advance(seconds);
  return { ...env, t0, params: () => env.engine.of('params').map(e => ({ ...e, at: Math.round((e.time - t0) / STEP * 1000) / 1000 })) };
}

describe('parameter locks in the live transport', () => {
  it('sends a step\'s locks at the step time and the knob value at the next step without them', () => {
    const { params, store, music } = run(state({ locks: { 1: { cutoff: 1200, resonance: 0.6 } } }));
    const p = params();
    expect(p[0]).toMatchObject({ part: 0, p: { cutoff: 1200, resonance: 0.6 }, at: 1 });
    expect(p[1]).toMatchObject({ part: 0, p: { cutoff: 5000, resonance: 0.15 }, at: 2 });
    // the knobs keep their own values
    expect(store.get('parts.0.params.cutoff')).toBe(5000);
    expect(store.get('parts.0.params.resonance')).toBe(0.15);
    music.transport.stop();
  });

  it('keeps a lock over consecutive locked steps and returns only what the next step does not lock', () => {
    const { params } = run(state({ locks: { 0: { cutoff: 800, drive: 0.5 }, 1: { cutoff: 900 } } }), 0.45);
    const p = params();
    expect(p.slice(0, 3).map(e => [e.at, e.p])).toEqual([
      [0, { cutoff: 800, drive: 0.5 }],
      [1, { drive: 0, cutoff: 900 }],
      [2, { cutoff: 5000 }],
    ]);
  });

  it('loops the locks with the pattern', () => {
    const { params } = run(state({ locks: { 3: { pan: -1 } } }), 1.2);
    expect(params().map(e => [e.at, e.p.pan])).toEqual([[3, -1], [4, 0], [7, -1], [8, 0]]);
  });

  it('Stop returns every locked parameter to the knob, after the locks already queued', () => {
    const { params, music, engine, clock } = run(state({ locks: { 0: { cutoff: 700 }, 1: { cutoff: 700 }, 2: { cutoff: 700 }, 3: { cutoff: 700 } } }), 0.2);
    const before = params();
    music.transport.stop();
    const after = engine.of('params').slice(before.length);
    expect(after.length).toBe(1);
    expect(after[0].p).toEqual({ cutoff: 5000 });
    expect(after[0].time).toBeGreaterThanOrEqual(Math.max(...before.map(e => e.time)));
    expect(after[0].time).toBeGreaterThanOrEqual(clock.ctx.currentTime - 1e-9);
  });

  it('a knob turned while a return is queued is sent again at that time, so the return cannot undo it', () => {
    const env = setup(state({ locks: { 0: { cutoff: 700 } } }));
    env.music.transport.play();
    env.clock.advance(0.13);   // step 1 (the return) is queued but not yet due
    const n = env.engine.of('params').length;
    env.store.set('parts.0.params.cutoff', 3000, { source: 'ui' });
    const extra = env.engine.of('params').slice(n);
    expect(extra.length).toBe(1);
    expect(extra[0].p).toEqual({ cutoff: 3000 });
    expect(extra[0].time).toBeCloseTo(env.engine.of('params')[n - 1].time, 9);
    env.music.transport.stop();
  });

  it('sends nothing for patterns without locks (unchanged output)', () => {
    const { engine, music } = run(state(), 1);
    expect(engine.of('params')).toEqual([]);
    music.transport.stop();
    expect(engine.of('params')).toEqual([]);
  });

  it('works next to dot locks: the dot still glides through the store, the lock goes to the engine', () => {
    const { store, params, music } = run(state({ locks: { 1: { cutoff: 1000 } }, dot: { 1: [0.2, 0.7] } }), 0.4);
    expect(store.get('parts.0.params.centerX')).toBeCloseTo(0.2, 6);
    expect(store.get('parts.0.params.centerY')).toBeCloseTo(0.7, 6);
    expect(params()[0]).toMatchObject({ p: { cutoff: 1000 }, at: 1 });
    music.transport.stop();
  });

  it('a switched-off sequencer sends the locked parameters back', () => {
    const env = setup(state({ locks: { 0: { cutoff: 700 }, 1: { cutoff: 700 }, 2: { cutoff: 700 }, 3: { cutoff: 700 } } }));
    env.music.transport.play();
    env.clock.advance(0.3);
    env.store.set('parts.0.seqOn', 0);
    env.clock.advance(0.3);
    const last = env.engine.of('params').at(-1);
    expect(last.p).toEqual({ cutoff: 5000 });
    env.music.transport.stop();
  });
});

describe('parameter locks in bounces', () => {
  it('the offline render includes the locks and returns as params messages', () => {
    const { music } = setup(state({ locks: { 1: { cutoff: 1200 } } }));
    const ev = music.renderEvents(1).filter(e => e.msg.t === 'params' && 'cutoff' in e.msg.p);
    expect(ev.slice(0, 4).map(e => [e.time, e.msg.p.cutoff])).toEqual([[0.125, 1200], [0.25, 5000], [0.625, 1200], [0.75, 5000]]);
    expect(ev[0].msg).toMatchObject({ part: 0, time: 0.125 });
  });

  it('the fallback event list does too, and is unchanged without locks', () => {
    const ev = sequencerEvents(state({ locks: { 1: { cutoff: 1200 } } }), 1).filter(e => e.msg.t === 'params');
    expect(ev.slice(0, 2).map(e => [e.time, e.msg])).toEqual([[0.125, { t: 'params', part: 0, p: { cutoff: 1200 } }], [0.25, { t: 'params', part: 0, p: { cutoff: 5000 } }]]);
    expect(sequencerEvents(state(), 2).some(e => e.msg.t === 'params')).toBe(false);
  });
});

describe('parameter lock data', () => {
  it('stepPlocks keeps known part parameters (not the dot), clamped, at most PLOCK_MAX', () => {
    expect(PLOCK_IDS).toContain('cutoff');
    expect(PLOCK_IDS).not.toContain('centerX');
    expect(stepPlocks({})).toBe(null);
    expect(stepPlocks({ plocks: { centerX: 0.1, nope: 1, cutoff: 1e9, resonance: NaN } })).toEqual({ cutoff: 18000 });
    const many = Object.fromEntries(PLOCK_IDS.slice(0, 12).map(id => [id, 0.5]));
    expect(Object.keys(stepPlocks({ plocks: many })).length).toBe(PLOCK_MAX);
  });

  it('are saved only on steps that have them and survive a round trip', () => {
    const st = state({ locks: { 2: { cutoff: 1500, pan: 3 } } });
    const pat = sanitizePattern(st.parts[0].patterns[0]);
    expect(pat.steps[2].plocks).toEqual({ cutoff: 1500, pan: 1 });
    expect('plocks' in pat.steps[0]).toBe(false);
    expect('plocks' in sanitizePattern({ steps: [{ plocks: { nope: 1 } }] }).steps[0]).toBe(false);
    const once = migrateState(JSON.parse(JSON.stringify(st)));
    expect(migrateState(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('a lock edit is one undo step', () => {
    const clock = createFakeClock();
    const store = createStore(state());
    const history = createHistory(store, { timers: clock.timers });
    const path = 'parts.0.patterns.0.steps.3';
    store.set(path, { ...store.get(path), plocks: { cutoff: 900 } }, { source: 'ui' });
    history.flush();
    history.undo();
    expect('plocks' in store.get(path)).toBe(false);
    history.redo();
    expect(store.get(path).plocks).toEqual({ cutoff: 900 });
  });
});
