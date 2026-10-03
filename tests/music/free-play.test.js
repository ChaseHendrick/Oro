// v2.9 coin slot: with Free Play on nothing changes in the note path; with it
// off, no note-on reaches the engine until a coin goes in, and a credit runs
// out after 3 minutes of play.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createCoinGate, CREDIT_MS, formatLeft } from '../../src/music/coin-gate.js';
import { createFakeClock, createFakeEngine } from './fakes.js';
import { installFakeDom } from '../ui/fake-dom.js';

function setup() {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = JSON.parse(JSON.stringify(defaultState()));
  s.global.tempo = 120;
  s.parts[0].seqOn = 1;
  s.parts[0].patterns[0].length = 4;
  s.parts[0].patterns[0].steps.forEach((st, i) => { st.on = i < 4 ? 1 : 0; st.degree = i; });
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

/** Keys, then two bars of the sequencer: every engine event. */
function play({ music, clock, engine }) {
  music.router.noteOn('sel', 60, 0.8, 'qwerty');
  clock.advance(0.1);
  music.router.noteOff('sel', 60, 'qwerty');
  music.router.noteOn('sel', 64, 0.7, 'midi');
  music.router.noteOff('sel', 64, 'midi');
  music.transport.play();
  clock.advance(4);
  music.transport.stop();
  return engine.events.map(e => ({ ...e }));
}

describe('coin gate', () => {
  it('blocks until a coin, then runs one credit for 3 minutes of play', () => {
    let t = 0;
    const g = createCoinGate({ now: () => t });
    expect(g.allow()).toBe(false);
    expect(g.credits()).toBe(0);
    g.insert(); g.insert();
    expect(g.credits()).toBe(2);
    t = 5000;                       // the credit starts with the first note, not the coin
    expect(g.allow()).toBe(true);
    expect(g.credits()).toBe(2);
    expect(g.left()).toBe(CREDIT_MS);
    t += CREDIT_MS - 1;
    expect(g.allow()).toBe(true);
    t += 1;                         // first credit over: the second one starts
    expect(g.allow()).toBe(true);
    expect(g.credits()).toBe(1);
    t += CREDIT_MS;
    expect(g.allow()).toBe(false);
    expect(g.credits()).toBe(0);
    expect(formatLeft(161000)).toBe('2:41');
  });
});

describe('Free Play in the note path', () => {
  it('on (no gate): the events are exactly the same', () => {
    const a = play(setup());
    const env = setup();
    env.music.router.setGate(() => false);
    env.music.router.setGate(null);
    expect(play(env)).toEqual(a);
    expect(a.filter(e => e.type === 'on').length).toBeGreaterThan(4);
  });

  it('off: keys, MIDI and the sequencer stay silent until a coin, and the credit expires', () => {
    const env = setup();
    let ms = 0;
    const gate = createCoinGate({ now: () => ms });
    env.music.router.setGate((part, note, source) => gate.allow());
    play(env);
    expect(env.engine.ons().length).toBe(0);
    // note-offs still go through, so nothing can hang
    expect(env.engine.offs().length).toBeGreaterThan(0);
    env.engine.clear();
    gate.insert();
    play(env);
    const ons = env.engine.ons().length;
    expect(ons).toBeGreaterThan(4);
    env.engine.clear();
    ms += CREDIT_MS + 1;
    play(env);
    expect(env.engine.ons().length).toBe(0);
  });

  it('the coin slot puts the gate in only while Free Play is off', async () => {
    const dom = installFakeDom();
    try {
      const { createCoinSlot } = await import('../../src/ui/coin-slot.js');
      const store = createStore(defaultState());
      let gate = 'none';
      const router = { setGate: (fn) => { gate = fn; } };
      let t = 0;
      const revealed = [];
      const slot = createCoinSlot({ store, music: { router }, root: document.createElement('div'), eggs: { reveal: (id) => revealed.push(id) } }, { now: () => t });
      expect(gate).toBe('none');
      expect(slot.coinKey()).toBe(false);
      expect(slot.insert()).toBe(false);
      store.set('operator', { freePlay: 0 });
      expect(typeof gate).toBe('function');
      expect(slot.coinKey()).toBe(true);
      expect(slot.text()).toEqual({ label: 'INSERT COIN', credits: 'Credits: 0' });
      expect(gate(0, 60, 'qwerty')).toBe(false);
      expect(gate(0, 60, 'bounce')).toBe(true);
      slot.insert();
      expect(revealed).toEqual(['insert-coin']);
      expect(gate(0, 60, 'seq')).toBe(true);
      t = 1000;
      expect(slot.text()).toEqual({ label: '2:59 left', credits: 'Credits: 1' });
      store.set('operator', { freePlay: 1 });
      expect(gate).toBe(null);
      slot.dispose();
    } finally {
      dom.restore();
    }
  });
});
