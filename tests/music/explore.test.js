import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, SCALES, SCALE_NAMES } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { exploreGapBeats, exploreNoteFor, EXPLORE_MODE } from '../../src/music/explore.js';
import { START_DELAY } from '../../src/music/transport.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup({ tempo = 120, mode = EXPLORE_MODE, rate = 1, range = 2, notes = 1 } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = defaultState();
  s.global.tempo = tempo;
  for (const part of s.parts) Object.assign(part.dot, { mode, exploreRate: rate, exploreRange: range, exploreNotes: notes });
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

const inScale = (note, root, scaleType) => SCALES[SCALE_NAMES[scaleType]].includes(((note - root) % 12 + 12) % 12);

describe('explore note mapping', () => {
  it('spreads height over the range in key, low valleys to high peaks', () => {
    const opts = { range: 2, baseOctave: 3, root: 9, scaleType: 1 };
    expect(exploreNoteFor(-1, opts)).toBe(57);          // A3: the bottom of the range
    expect(exploreNoteFor(1, opts)).toBe(81);           // A5: two octaves up
    expect(exploreNoteFor(0, opts)).toBe(69);           // the middle
    let prev = -1;
    for (let h = -1; h <= 1.0001; h += 0.05) {
      const n = exploreNoteFor(h, opts);
      expect(n).toBeGreaterThanOrEqual(prev);
      expect(inScale(n, 9, 1)).toBe(true);
      prev = n;
    }
  });

  it('widens around the part octave for bigger ranges', () => {
    const lo = exploreNoteFor(-1, { range: 4, baseOctave: 3, root: 0, scaleType: 0 });
    const hi = exploreNoteFor(1, { range: 4, baseOctave: 3, root: 0, scaleType: 0 });
    expect(hi - lo).toBe(48);
    expect(lo).toBe(36);
    expect(exploreNoteFor(1, { range: 1, baseOctave: 3, root: 0, scaleType: 0 }) - exploreNoteFor(-1, { range: 1, baseOctave: 3, root: 0, scaleType: 0 })).toBe(12);
  });

  it('maps the rate to a gap from two beats down to a 16th', () => {
    expect(exploreGapBeats(0)).toBeCloseTo(2, 9);
    expect(exploreGapBeats(1)).toBeCloseTo(0.25, 9);
    expect(exploreGapBeats(0.5)).toBeLessThan(exploreGapBeats(0.2));
  });
});

describe('music.exploreNote', () => {
  it('plays only in Explore mode with notes switched on', () => {
    const off = setup({ mode: 1 });
    expect(off.music.exploreNote({ part: 0, kind: 'peak', height: 0.5 })).toBeNull();
    const muted = setup({ notes: 0 });
    expect(muted.music.exploreNote({ part: 0, kind: 'peak', height: 0.5 })).toBeNull();
    const { engine, music } = setup();
    const n = music.exploreNote({ part: 0, kind: 'peak', height: 0.5, x: 0.2, y: 0.3 });
    expect(n).toMatchObject({ part: 0, kind: 'peak', x: 0.2, y: 0.3 });
    expect(engine.ons(0).map(e => e.note)).toEqual([n.note]);
    expect(engine.offs(0)[0].time).toBeCloseTo(n.time + n.length, 9);
  });

  it('takes velocity from |height| and ignores bad input', () => {
    const { music } = setup({ rate: 1 });
    const soft = music.exploreNote({ part: 1, kind: 'valley', height: -0.1 });
    expect(music.exploreNote({ part: 1, kind: 'peak', height: NaN })).toBeNull();
    expect(music.exploreNote({ part: 9, kind: 'peak', height: 0.5 })).toBeNull();
    const { music: m2 } = setup({ rate: 1 });
    const loud = m2.exploreNote({ part: 1, kind: 'peak', height: 0.95 });
    expect(loud.vel).toBeGreaterThan(soft.vel);
    expect(soft.vel).toBeGreaterThan(0.2);
    expect(loud.vel).toBeLessThanOrEqual(1);
    expect(loud.note).toBeGreaterThan(soft.note);
  });

  it('limits density with exploreRate', () => {
    const { clock, engine, music } = setup({ tempo: 120, rate: 0 });  // one note per 2 beats = 1 s
    let played = 0;
    for (let i = 0; i < 40; i++) {
      if (music.exploreNote({ part: 0, kind: i % 2 ? 'peak' : 'valley', height: i % 2 ? 0.7 : -0.7 })) played++;
      clock.advance(0.1);
    }
    expect(played).toBe(4);
    const ons = engine.ons(0);
    for (let i = 1; i < ons.length; i++) expect(ons[i].time - ons[i - 1].time).toBeGreaterThanOrEqual(1 - 0.003);
    // Every note ends before the next may start, so a mono patch never hangs.
    const offs = engine.offs(0);
    for (let i = 0; i < offs.length - 1; i++) expect(offs[i].time).toBeLessThan(ons[i + 1].time);
  });

  it('snaps to 16ths while the transport plays', () => {
    const { clock, engine, store, music } = setup({ tempo: 120, rate: 1 });
    store.set('parts.0.seq.enabled', 1);
    const t0 = clock.ctx.currentTime;
    music.transport.play();
    clock.advance(0.33);
    engine.clear();
    const n = music.exploreNote({ part: 2, kind: 'peak', height: 0.3 });
    const grid = 0.125; // a 16th at 120 bpm
    const k = (n.time - (t0 + START_DELAY)) / grid;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    expect(n.time).toBeGreaterThanOrEqual(clock.ctx.currentTime);
    expect(n.time - clock.ctx.currentTime).toBeLessThanOrEqual(grid + 0.01);
  });

  it('emits an explore event', () => {
    const { music } = setup();
    const seen = [];
    music.on('explore', e => seen.push(e));
    music.exploreNote({ part: 'sel', kind: 'valley', height: -0.6 });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ part: 0, kind: 'valley' });
  });
});
