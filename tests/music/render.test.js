import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, stepToMidi } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { swingBeat } from '../../src/music/transport.js';
import { FACTORY_SCENES } from '../../src/presets/factory-scenes.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup({ tempo = 120, state } = {}) {
  const clock = createFakeClock({ startSec: 3 });
  const engine = createFakeEngine(clock);
  const s = state || defaultState();
  s.global.tempo = tempo;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

function fill(store, part, { rate = 3, steps = 16, on = () => 1, slide = () => 0, gate = 0.5, lock = null } = {}) {
  const seq = store.get(`parts.${part}.seq`);
  seq.enabled = 1;
  seq.rate = rate;
  seq.length = steps;
  seq.steps = seq.steps.map((st, i) => ({ ...st, on: on(i) ? 1 : 0, degree: i % 7, gate, slide: slide(i) ? 1 : 0, ...(lock && lock(i) ? { lock: 1, lx: lock(i)[0], ly: lock(i)[1] } : {}) }));
  store.set(`parts.${part}.seq`, seq);
}

const notes = (ev, t) => ev.filter(e => e.msg.t === t);

/** Note-ons and offs pair up, nothing starts at or after `end`, nothing ends after it. */
function checkBalanced(ev, end) {
  const open = new Map();
  for (const e of ev) {
    if (e.msg.t !== 'transport') expect(e.msg.time).toBe(e.time);
    if (e.msg.t === 'noteOn') {
      expect(e.time).toBeLessThan(end);
      const k = e.msg.part * 128 + e.msg.note;
      open.set(k, (open.get(k) || 0) + 1);
    } else if (e.msg.t === 'noteOff') {
      expect(e.time).toBeLessThanOrEqual(end + 1e-9);
      const k = e.msg.part * 128 + e.msg.note;
      expect(open.get(k) || 0).toBeGreaterThan(0);
      open.set(k, open.get(k) - 1);
    }
  }
  for (const n of open.values()) expect(n).toBe(0);
}

describe('music.renderEvents', () => {
  it('renders the sequencer from time 0 with exact step times', () => {
    const { store, music } = setup({ tempo: 120 });
    fill(store, 0);
    const ev = music.renderEvents(2);
    expect(ev[0]).toEqual({ time: 0, msg: { t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 } });
    const ons = notes(ev, 'noteOn');
    expect(ons.length).toBe(32);
    ons.forEach((e, i) => {
      expect(e.time).toBeCloseTo(i * 0.125, 9);
      expect(e.msg).toMatchObject({ part: 0, note: stepToMidi({ degree: (i % 16) % 7, octave: 0 }, 3, 9, 1) });
    });
    // Gate 0.5 of a 16th.
    const offs = notes(ev, 'noteOff');
    expect(offs[0].time).toBeCloseTo(0.0625, 9);
    checkBalanced(ev, 4);
    // Sorted by time.
    for (let i = 1; i < ev.length; i++) expect(ev[i].time).toBeGreaterThanOrEqual(ev[i - 1].time);
  });

  it('swings like live playback', () => {
    const { store, music } = setup({ tempo: 100 });
    store.set('global.swing', 0.4);
    fill(store, 1);
    const ons = notes(music.renderEvents(1), 'noteOn');
    const spb = 0.6;
    ons.forEach((e, i) => expect(e.time).toBeCloseTo(swingBeat(i * 0.25, 0.4) * spb, 9));
  });

  it('releases slides and long notes by the end of the render', () => {
    const { store, music } = setup({ tempo: 120 });
    // Every step slides into the next: one long tie that would never end on its own.
    fill(store, 2, { rate: 0, steps: 4, slide: () => 1, gate: 1 });
    const ev = music.renderEvents(1);
    checkBalanced(ev, 2);
    const offs = notes(ev, 'noteOff');
    expect(offs[offs.length - 1].time).toBeCloseTo(2, 9);
  });

  it('turns dot locks into timed parameter ramps', () => {
    const { store, music } = setup({ tempo: 120 });
    store.set('parts.0.seq.lockGlide', 0.5);
    fill(store, 0, { rate: 3, steps: 4, on: (i) => i === 0, lock: (i) => (i === 0 ? [0.2, 0.3] : i === 2 ? [0.8, 0.9] : null) });
    const ev = music.renderEvents(1);
    const locks = notes(ev, 'params');
    // Steps 0 and 2 of a four-step pattern, four times per bar.
    expect(locks.length).toBe(8);
    expect(locks[0]).toEqual({ time: 0, msg: { t: 'params', part: 0, p: { centerX: 0.2, centerY: 0.3 }, time: 0, ramp: 0.0625 } });
    expect(locks[1].time).toBeCloseTo(0.25, 9);
    expect(locks[1].msg.p).toEqual({ centerX: 0.8, centerY: 0.9 });
    // The live dot is untouched.
    expect(store.get('parts.0.params.centerX')).toBe(0.5);
  });

  it('only includes the requested parts', () => {
    const { store, music } = setup();
    fill(store, 0);
    fill(store, 3);
    const ev = music.renderEvents(1, { parts: [3] });
    const parts = new Set(ev.filter(e => e.msg.part != null).map(e => e.msg.part));
    expect([...parts]).toEqual([3]);
  });

  it('replays an arp hold', () => {
    const { store, music, clock } = setup({ tempo: 120 });
    store.set('parts.1.arp', { mode: 1, rate: 3, octaves: 1, gate: 0.5, hold: 1 });
    for (const n of [60, 64, 67]) music.router.noteOn(1, n, 0.7);
    for (const n of [60, 64, 67]) music.router.noteOff(1, n);
    clock.advance(0.3);
    const ons = notes(music.renderEvents(1, { parts: [1] }), 'noteOn');
    expect(ons.length).toBe(16);
    expect(ons.slice(0, 4).map(e => e.msg.note)).toEqual([60, 64, 67, 60]);
    ons.forEach((e, i) => expect(e.time).toBeCloseTo(i * 0.125, 9));
    expect(ons[0].msg.vel).toBe(0.7);
    music.router.allNotesOff();
  });

  it('never touches the live session or transport', () => {
    const { store, music, engine } = setup();
    fill(store, 0);
    const changes = [];
    store.subscribe('', (path) => changes.push(path));
    const before = JSON.stringify(store.serialize());
    music.renderEvents(4);
    expect(changes).toEqual([]);
    expect(JSON.stringify(store.serialize())).toBe(before);
    expect(store.get('ui.playing')).toBe(0);
    expect(music.transport.isPlaying()).toBe(false);
    expect(engine.events.length).toBe(0);
  });

  it('renders every factory scene cleanly', () => {
    for (const scene of FACTORY_SCENES) {
      const { music, store } = setup({ state: migrateState(scene), tempo: scene.global.tempo });
      const ev = music.renderEvents(4);
      const end = 16 * 60 / store.get('global.tempo');
      checkBalanced(ev, end);
      const parts = new Set(notes(ev, 'noteOn').map(e => e.msg.part));
      expect(parts.size, scene.name).toBe(4);
    }
  });
});
