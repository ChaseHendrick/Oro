// v2.9 song mode (pattern chains): the live transport, the bounce events
// (offline render and fallback), migration, pattern removal and undo.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, defaultPattern, stepToMidi, activeChain } from '../../src/core/params.js';
import { sanitizePart, sanitizeChain, migrateState } from '../../src/core/migrate.js';
import { removePattern } from '../../src/core/tracks.js';
import { createHistory } from '../../src/core/history.js';
import { createMusic } from '../../src/music/music.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const KEY = { root: 0, scale: 0 };   // C major
const midi = (degree) => stepToMidi({ degree, octave: 0 }, 3, KEY.root, KEY.scale);

/** Track 0 with pattern A (degree 0, `lenA` steps) and pattern B (degree 2, `lenB` steps, rate `rateB`). */
function state({ chain, lenA = 4, lenB = 2, rateB = 3 } = {}) {
  const s = JSON.parse(JSON.stringify(defaultState()));
  s.global.tempo = 120;
  s.global.swing = 0;
  s.global.scaleRoot = KEY.root;
  s.global.scaleType = KEY.scale;
  const part = s.parts[0];
  part.seqOn = 1;
  const a = defaultPattern(1), b = defaultPattern(2);
  a.length = lenA;
  b.length = lenB;
  b.rate = rateB;
  a.steps.forEach((st) => { st.on = 1; st.degree = 0; });
  b.steps.forEach((st) => { st.on = 1; st.degree = 2; });
  part.patterns = [a, b];
  part.activePattern = 0;
  if (chain) part.chain = chain;
  return s;
}

function setup(st) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(st);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

function live(st, seconds = 2.02) {
  const env = setup(st);
  const steps = [];
  env.music.transport.on('step', (e) => { if (e.part === 0) steps.push(e); });
  env.music.transport.play();
  env.clock.advance(seconds);
  const entryNow = env.music.chainEntry(0);
  env.music.transport.stop();
  return { ...env, steps, entryNow, notes: env.engine.ons(0).map(e => e.note) };
}

const CHAIN = { on: 1, entries: [{ pattern: 0, repeats: 2 }, { pattern: 1, repeats: 1 }] };

describe('song mode in the live transport', () => {
  it('plays the entries in order, each for its repeats, and loops the chain', () => {
    const { notes } = live(state({ chain: CHAIN }));
    const a = midi(0), b = midi(2);
    // A twice (2 x 4 steps), B once (2 steps), then round again
    expect(notes.slice(0, 16)).toEqual([...Array(8).fill(a), b, b, ...Array(6).fill(a)]);
  });

  it('reports the chain entry being played with each step and to chainEntry()', () => {
    const { steps, entryNow } = live(state({ chain: CHAIN }), 1.45);
    expect(steps.slice(0, 11).map(s => s.entry)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0]);
    expect(steps.slice(0, 11).map(s => s.pattern)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0]);
    expect(steps.slice(0, 11).map(s => s.step)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 0]);
    expect(entryNow).toBeGreaterThanOrEqual(0);
  });

  it('is exactly today\'s loop with the chain off (or absent)', () => {
    const off = live(state({ chain: { on: 0, entries: CHAIN.entries } }));
    const none = live(state());
    expect(off.engine.events).toEqual(none.engine.events);
    expect(off.steps.length).toBeGreaterThan(0);
    expect(off.steps.every(s => !('entry' in s))).toBe(true);
    expect(none.notes.slice(0, 8)).toEqual(Array(8).fill(midi(0)));
  });

  it('continues from the same musical position when an entry has another rate', () => {
    // B at 1/8 (rate 1): two 1/8 steps after two passes of A (8 x 1/16 = 2 beats)
    const { engine } = live(state({ chain: CHAIN, rateB: 1 }), 2.2);
    const ons = engine.ons(0);
    const t0 = ons[0].time;
    const rel = ons.slice(0, 12).map(e => Math.round((e.time - t0) * 1000) / 1000);
    expect(rel.slice(0, 8)).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
    expect(rel.slice(8, 11)).toEqual([1, 1.25, 1.5]);   // B's two 1/8 steps, then A again
    expect(ons[10].note).toBe(midi(0));
  });

  it('switched on while playing, starts at the next pass of the pattern playing', () => {
    const env = setup(state({ lenA: 4 }));
    env.music.transport.play();
    env.clock.advance(0.2);   // A is playing its first pass
    env.store.set('parts.0.chain', { on: 1, entries: [{ pattern: 1, repeats: 1 }] });
    env.clock.advance(1.2);
    env.music.transport.stop();
    const notes = env.engine.ons(0).map(e => e.note);
    expect(notes.slice(0, 4)).toEqual(Array(4).fill(midi(0)));
    expect(notes.slice(4, 8)).toEqual(Array(4).fill(midi(2)));
  });
});

describe('song mode in bounces', () => {
  it('the offline render follows the chain like the live transport', () => {
    const { music, store } = setup(state({ chain: CHAIN }));
    const ev = music.renderEvents(1).filter(e => e.msg.t === 'noteOn' && e.msg.part === 0);
    expect(ev.map(e => e.msg.note)).toEqual([...Array(8).fill(midi(0)), midi(2), midi(2), ...Array(6).fill(midi(0))]);
    expect(store.get('parts.0.activePattern')).toBe(0);
  });

  it('the fallback event list follows the chain too, and is unchanged with it off', () => {
    const on = sequencerEvents(state({ chain: CHAIN }), 1).filter(e => e.msg.t === 'noteOn');
    expect(on.map(e => e.msg.note)).toEqual([...Array(8).fill(midi(0)), midi(2), midi(2), ...Array(6).fill(midi(0))]);
    expect(on.map(e => e.time)).toEqual(Array.from({ length: 16 }, (_, i) => i * 0.125));
    const off = sequencerEvents(state({ chain: { on: 0, entries: CHAIN.entries } }), 2);
    expect(off).toEqual(sequencerEvents(state(), 2));
  });

  it('the fallback keeps the musical position across rates', () => {
    const on = sequencerEvents(state({ chain: CHAIN, rateB: 1 }), 1).filter(e => e.msg.t === 'noteOn');
    expect(on.slice(7, 11).map(e => e.time)).toEqual([0.875, 1, 1.25, 1.5]);
  });
});

describe('song mode data', () => {
  it('is omitted when unused and sanitized when present', () => {
    expect('chain' in sanitizePart(state().parts[0], 0)).toBe(false);
    expect(sanitizeChain({ on: 0, entries: [] }, 2)).toBe(null);
    const c = sanitizeChain({ on: 5, entries: [{ pattern: 1, repeats: 40 }, { pattern: 7, repeats: 2 }, null, { pattern: 0.2 }] }, 2);
    expect(c).toEqual({ on: 1, entries: [{ pattern: 1, repeats: 16 }, { pattern: 0, repeats: 1 }] });
    const many = sanitizeChain({ on: 1, entries: Array.from({ length: 40 }, () => ({ pattern: 0, repeats: 1 })) }, 1);
    expect(many.entries.length).toBe(32);
  });

  it('survives a save and load round trip', () => {
    const st = state({ chain: CHAIN });
    const once = migrateState(JSON.parse(JSON.stringify(st)));
    expect(once.parts[0].chain).toEqual(CHAIN);
    expect(migrateState(JSON.parse(JSON.stringify(once)))).toEqual(once);
    expect(activeChain(once.parts[0])).toEqual(CHAIN.entries);
  });

  it('removing a pattern drops its entries and renumbers the later ones', () => {
    const st = state({ chain: { on: 1, entries: [{ pattern: 0, repeats: 1 }, { pattern: 1, repeats: 3 }, { pattern: 0, repeats: 2 }] } });
    const store = createStore(st);
    removePattern(store, 0, 0);
    expect(store.get('parts.0.chain')).toEqual({ on: 1, entries: [{ pattern: 0, repeats: 3 }] });
  });

  it('chain edits are one undo step each', () => {
    const clock = createFakeClock();
    const store = createStore(state());
    const history = createHistory(store, { timers: clock.timers });
    store.set('parts.0.chain', CHAIN, { source: 'ui' });
    history.flush();
    expect(history.list().past).toEqual(['Song mode, track 1']);
    history.undo();
    expect(store.get('parts.0.chain')).toBe(undefined);
    history.redo();
    expect(store.get('parts.0.chain')).toEqual(CHAIN);
  });
});
