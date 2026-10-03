// Per-step probability and ratchets: the live transport, the bounce fallback
// event list and the session migration.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import {
  defaultState, defaultStep, stepChance, stepPlays, stepProb, stepRatchet, RATCHET_DECAY, RATCHET_MAX,
} from '../../src/core/params.js';
import { sanitizePattern, migrateState } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { START_DELAY } from '../../src/music/transport.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup({ tempo = 120 } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = defaultState();
  s.global.tempo = tempo;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

/** Fill track `part`'s pattern; `extra(i)` adds fields (prob, ratchet, ...) to step i. */
function fill(store, part, { on = () => 1, extra = () => ({}), gate = 0.5, slide = () => 0 } = {}) {
  const seq = store.get(`parts.${part}.patterns.0`);
  store.set(`parts.${part}.seqOn`, 1);
  seq.rate = 3;
  seq.length = 16;
  seq.steps = seq.steps.map((st, i) => ({ ...st, on: on(i) ? 1 : 0, degree: i % 7, gate, slide: slide(i) ? 1 : 0, ...extra(i) }));
  store.set(`parts.${part}.patterns.0`, seq);
}

function liveEvents(opts, seconds = 2.05) {
  const { clock, engine, store, music } = setup();
  fill(store, 0, opts);
  const t0 = clock.ctx.currentTime;
  music.transport.play();
  clock.advance(seconds);
  music.transport.stop();
  return { t0, ons: engine.ons(0), offs: engine.offs(0), events: engine.events.filter(e => e.type === 'on' || e.type === 'off') };
}

function session(edit) {
  const st = JSON.parse(JSON.stringify(defaultState()));
  st.global.tempo = 120;
  st.global.swing = 0;
  st.parts[0].seqOn = 1;
  st.parts[0].patterns[0].steps.forEach((s, i) => { s.on = 1; s.degree = i % 7; });
  if (edit) edit(st.parts[0].patterns[0].steps);
  return st;
}

describe('step probability and ratchet helpers', () => {
  it('read missing fields as the defaults and clamp the rest', () => {
    expect(stepProb(defaultStep())).toBe(1);
    expect(stepRatchet(defaultStep())).toBe(1);
    expect(stepProb({ prob: 3 })).toBe(1);
    expect(stepProb({ prob: -1 })).toBe(0);
    expect(stepProb({ prob: NaN })).toBe(1);
    expect(stepRatchet({ ratchet: 9 })).toBe(RATCHET_MAX);
    expect(stepRatchet({ ratchet: 0 })).toBe(1);
    expect(stepRatchet({ ratchet: 2.6 })).toBe(3);
  });

  it('rolls deterministically, in [0, 1), with a fair spread', () => {
    let sum = 0, under = 0;
    for (let k = 0; k < 4000; k++) {
      const r = stepChance(1, k % 4, k);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
      expect(stepChance(1, k % 4, k)).toBe(r);
      sum += r;
      if (r < 0.25) under++;
    }
    expect(sum / 4000).toBeGreaterThan(0.47);
    expect(sum / 4000).toBeLessThan(0.53);
    expect(under / 4000).toBeGreaterThan(0.22);
    expect(under / 4000).toBeLessThan(0.28);
    // Different seeds and tracks roll differently.
    expect(stepChance(1, 0, 5)).not.toBe(stepChance(2, 0, 5));
    expect(stepChance(1, 0, 5)).not.toBe(stepChance(1, 1, 5));
    expect(stepPlays({ prob: 1 }, 1, 0, 0)).toBe(true);
    expect(stepPlays({ prob: 0 }, 1, 0, 0)).toBe(false);
  });
});

describe('transport: probability', () => {
  it('defaults play exactly the same events as steps without the fields', () => {
    const plain = liveEvents({});
    const explicit = liveEvents({ extra: () => ({ prob: 1, ratchet: 1 }) });
    expect(explicit.events).toEqual(plain.events);
    expect(plain.ons.length).toBeGreaterThanOrEqual(16);
  });

  it('never plays a step with probability 0, and still moves on to the next step', () => {
    const none = liveEvents({ extra: () => ({ prob: 0 }) });
    expect(none.ons).toHaveLength(0);
    const odd = liveEvents({ extra: (i) => (i % 2 ? { prob: 0 } : {}) });
    expect(odd.ons.length).toBeGreaterThanOrEqual(8);
    odd.ons.slice(0, 8).forEach((e, k) => expect(e.time).toBeCloseTo(odd.t0 + START_DELAY + k * 0.25, 9));
  });

  it('plays a probability 0.5 step about half the time, the same way every run', () => {
    // 16 s at 120 bpm = 128 sixteenths.
    const a = liveEvents({ extra: () => ({ prob: 0.5 }) }, 16);
    const b = liveEvents({ extra: () => ({ prob: 0.5 }) }, 16);
    expect(a.ons.length).toBeGreaterThan(128 * 0.35);
    expect(a.ons.length).toBeLessThan(128 * 0.65);
    expect(b.events).toEqual(a.events);
  });

  it('rolls again on the next Play', () => {
    const { clock, engine, store, music } = setup();
    fill(store, 0, { extra: () => ({ prob: 0.5 }) });
    const pattern = () => {
      music.transport.play();
      const t0 = clock.ctx.currentTime + START_DELAY;
      clock.advance(4.05);
      music.transport.stop();
      clock.advance(0.5);
      const hits = engine.ons(0).map(e => Math.round((e.time - t0) / 0.125)).filter(k => k >= 0 && k < 32);
      engine.clear();
      return hits;
    };
    const first = pattern();
    const second = pattern();
    expect(first).not.toEqual(second);
  });
});

describe('transport: ratchets', () => {
  it('splits a ratchet 3 step into three evenly spaced notes with scaled gates and decaying velocity', () => {
    const r = liveEvents({ on: (i) => i === 0, extra: (i) => (i === 0 ? { ratchet: 3, vel: 0.8 } : {}) }, 0.3);
    const start = r.t0 + START_DELAY;
    const sub = 0.125 / 3;
    expect(r.ons).toHaveLength(3);
    r.ons.forEach((e, k) => {
      expect(e.time).toBeCloseTo(start + k * sub, 9);
      expect(e.vel).toBeCloseTo(0.8 * RATCHET_DECAY ** k, 9);
      expect(e.note).toBe(r.ons[0].note);
    });
    // Gate 0.5 of each third of the step.
    expect(r.offs).toHaveLength(3);
    r.offs.forEach((e, k) => expect(e.time - r.ons[k].time).toBeCloseTo(0.5 * sub, 9));
  });

  it('keeps ratchet hits inside their slot at full gate, and an accent starts the decay from 1', () => {
    const r = liveEvents({ on: (i) => i === 0, gate: 1, extra: (i) => (i === 0 ? { ratchet: 4, accent: 1 } : {}) }, 0.3);
    expect(r.ons.map(e => e.vel)).toEqual([1, RATCHET_DECAY, RATCHET_DECAY ** 2, RATCHET_DECAY ** 3].map(v => expect.closeTo(v, 9)));
    for (let k = 0; k < 3; k++) expect(r.offs[k].time).toBeLessThan(r.ons[k + 1].time);
  });

  it('slides out of the last hit of a ratcheted step', () => {
    const r = liveEvents({ on: (i) => i < 2, slide: (i) => i === 0, extra: (i) => (i === 0 ? { ratchet: 2 } : {}) }, 0.4);
    const start = r.t0 + START_DELAY;
    expect(r.ons.map(e => e.time)).toEqual([start, start + 0.0625, start + 0.125].map(t => expect.closeTo(t, 9)));
    // The second hit is held until just after step 2 starts (legato), not cut at its gate.
    const secondOff = r.offs.find(e => e.note === r.ons[1].note && e.time > r.ons[1].time);
    expect(secondOff.time).toBeGreaterThan(start + 0.125);
  });
});

describe('bounce events: probability and ratchets', () => {
  it('defaults give the same events as before', () => {
    const plain = sequencerEvents(session(), 2);
    const explicit = sequencerEvents(session((steps) => steps.forEach(s => { s.prob = 1; s.ratchet = 1; })), 2);
    expect(explicit).toEqual(plain);
    expect(plain.filter(e => e.msg.t === 'noteOn')).toHaveLength(32);
  });

  it('drops probability 0 steps and plays about half of probability 0.5 steps', () => {
    const none = sequencerEvents(session((steps) => steps.forEach(s => { s.prob = 0; })), 4);
    expect(none.filter(e => e.msg.t === 'noteOn')).toHaveLength(0);
    const half = sequencerEvents(session((steps) => steps.forEach(s => { s.prob = 0.5; })), 64);
    const n = half.filter(e => e.msg.t === 'noteOn').length;
    expect(n).toBeGreaterThan(1024 * 0.45);
    expect(n).toBeLessThan(1024 * 0.55);
    expect(sequencerEvents(session((steps) => steps.forEach(s => { s.prob = 0.5; })), 64)).toEqual(half);
  });

  it('ratchets a step into evenly spaced hits', () => {
    const ev = sequencerEvents(session((steps) => steps.forEach((s, i) => { s.on = i === 0 ? 1 : 0; if (i === 0) s.ratchet = 3; })), 1);
    const ons = ev.filter(e => e.msg.t === 'noteOn');
    expect(ons.map(e => e.time)).toEqual([0, 0.125 / 3, 0.25 / 3].map(t => expect.closeTo(t, 9)));
    expect(ons.map(e => e.msg.vel)).toEqual([0.8, 0.8 * RATCHET_DECAY, 0.8 * RATCHET_DECAY ** 2].map(v => expect.closeTo(v, 9)));
    expect(ev.filter(e => e.msg.t === 'noteOff')).toHaveLength(3);
  });
});

describe('migration: probability and ratchets', () => {
  it('clamps saved values and leaves defaults out', () => {
    const pat = sanitizePattern({ steps: [
      { on: 1, prob: 2, ratchet: 9 },
      { on: 1, prob: -1, ratchet: 0 },
      { on: 1, prob: 0.25, ratchet: 2.6 },
      { on: 1, prob: 'often', ratchet: null },
      { on: 1 },
    ] });
    expect(pat.steps[0].prob).toBeUndefined();
    expect(pat.steps[0].ratchet).toBe(RATCHET_MAX);
    expect(pat.steps[1].prob).toBe(0);
    expect(pat.steps[1].ratchet).toBeUndefined();
    expect(pat.steps[2]).toMatchObject({ prob: 0.25, ratchet: 3 });
    for (const k of [3, 4]) {
      expect('prob' in pat.steps[k]).toBe(false);
      expect('ratchet' in pat.steps[k]).toBe(false);
    }
  });

  it('round-trips a session with probability and ratchets', () => {
    const st = session((steps) => { steps[3].prob = 0.4; steps[5].ratchet = 2; });
    const m = migrateState(st);
    expect(m.parts[0].patterns[0].steps[3].prob).toBe(0.4);
    expect(m.parts[0].patterns[0].steps[5].ratchet).toBe(2);
    expect(migrateState(m)).toEqual(m);
  });
});
