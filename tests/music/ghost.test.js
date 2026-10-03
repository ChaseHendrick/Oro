// v2.9 Ghost replay: recording notes, knob moves and the dot path in beats,
// looped replay through the engine (never the store), stop and restore,
// the caps, and the saved form.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { createGhosts } from '../../src/music/ghost.js';
import { sanitizeGhost, dotAtBeat, GHOST_MAX_BARS, GHOST_MAX_EVENTS } from '../../src/music/ghost-data.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup() {
  const s = JSON.parse(JSON.stringify(defaultState()));
  s.global.tempo = 120;          // a beat is 0.5 s, a bar 2 s
  s.global.swing = 0;
  for (const p of s.parts) p.seqOn = 0;
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const ghosts = createGhosts({ store, router: music.router, transport: music.transport, timebase: music.timebase, timers: clock.timers });
  const T = music.transport;
  /** Advance to transport beat `b`. */
  const toBeat = (b) => clock.advance(Math.max(0, T.timeAtBeat(b) - clock.ctx.currentTime), 0.005);
  return { clock, engine, store, music, ghosts, T, toBeat };
}

/** Record: a note at beat 1 to 1.5, cutoff and the dot moved at 1.5, stop at 2.5 (one bar). */
function recordOne(env) {
  const { ghosts, store, music, toBeat } = env;
  const cutoff0 = store.get('parts.0.params.cutoff');
  const cy0 = store.get('parts.0.params.centerY');
  const cx0 = store.get('parts.0.params.centerX');
  const res = ghosts.record(0);
  expect(res.ok).toBe(true);
  toBeat(1);
  music.router.noteOn(0, 60, 0.8, 'ui');
  toBeat(1.5);
  music.router.noteOff(0, 60, 'ui');
  store.set('parts.0.params.cutoff', 2000, { source: 'ui' });
  store.set('parts.0.params.centerX', 0.3, { source: 'visual', user: true });
  // not recorded: Roll physics and the sequencer's own writes
  store.set('parts.0.params.centerY', 0.9, { source: 'physics', user: false });
  store.set('parts.0.params.centerY', cy0, { source: 'physics', user: false });
  store.set('parts.0.params.resonance', 0.5, { source: 'preset' });
  toBeat(2.5);
  const done = ghosts.stopRecording();
  return { done, cutoff0, cy0, cx0 };
}

describe('ghost recording', () => {
  it('captures notes, knob moves and the dot in beats from the start bar', () => {
    const env = setup();
    const { done, cutoff0, cy0 } = recordOne(env);
    expect(done.ok).toBe(true);
    const g = env.store.get('parts.0.ghost');
    expect(g.bars).toBe(1);
    expect(g.startBar).toBe(0);
    expect(g.notes.length).toBe(2);
    expect(g.notes[0][0]).toBeCloseTo(1, 2);
    expect(g.notes[0].slice(1)).toEqual([60, 0.8]);
    expect(g.notes[1][0]).toBeCloseTo(1.5, 2);
    expect(g.notes[1][2]).toBe(0);
    expect(g.knobs.map(e => [e[1], e[2]])).toEqual([['cutoff', cutoff0], ['cutoff', 2000]]);
    expect(g.knobs[1][0]).toBeCloseTo(1.5, 2);
    expect(g.dots.length).toBe(2);
    expect(g.dots[1].slice(1)).toEqual([0.3, cy0]);
    expect(done.message).toMatch(/1 bar, 1 note, 2 knob values, 2 dot points/);
  });

  it('records later bars from the bar it started in and rounds the length up', () => {
    const env = setup();
    env.T.play();
    env.toBeat(9.2);                 // bar 3 (0-based 2)
    env.ghosts.record(0);
    env.toBeat(10);
    env.music.router.noteOn(0, 62, 0.5, 'midi');
    env.toBeat(10.25);
    env.music.router.noteOff(0, 62, 'midi');
    env.music.router.noteOn(1, 70, 0.5, 'ui');       // another track: not in this ghost
    env.toBeat(13.1);                // past one bar: two bars
    env.ghosts.stopRecording();
    const g = env.store.get('parts.0.ghost');
    expect(g.startBar).toBe(2);
    expect(g.bars).toBe(2);
    expect(g.notes[0][0]).toBeCloseTo(2, 2);
    expect(g.notes.every(e => e[1] === 62)).toBe(true);
  });

  it('stops by itself at 64 bars and at the event cap', () => {
    const env = setup();
    env.ghosts.record(0);
    env.music.router.noteOn(0, 60, 0.8, 'ui');
    env.clock.advance(GHOST_MAX_BARS * 2 + 1, 0.025);
    expect(env.ghosts.isRecording()).toBe(false);
    const g = env.store.get('parts.0.ghost');
    expect(g.bars).toBe(GHOST_MAX_BARS);
    // the held note ends with the ghost
    expect(g.notes[g.notes.length - 1][2]).toBe(0);

    const e2 = setup();
    e2.ghosts.record(1);
    for (let i = 0; i < GHOST_MAX_EVENTS / 2 + 5; i++) { e2.music.router.noteOn(1, 40 + (i % 40), 0.7, 'ui'); e2.music.router.noteOff(1, 40 + (i % 40), 'ui'); }
    e2.clock.advance(0.05);
    expect(e2.ghosts.isRecording()).toBe(false);
    const g2 = e2.store.get('parts.1.ghost');
    expect(g2.notes.length).toBeLessThanOrEqual(GHOST_MAX_EVENTS);
    expect(g2.notes.length).toBeGreaterThan(GHOST_MAX_EVENTS - 10);
  });

  it('keeps nothing when nothing was played', () => {
    const env = setup();
    env.ghosts.record(0);
    env.toBeat(2);
    const res = env.ghosts.stopRecording();
    expect(res.ok).toBe(false);
    expect(env.store.get('parts.0.ghost')).toBeUndefined();
  });
});

describe('ghost replay', () => {
  it('loops on its track in time, through the engine only, and restores on stop', () => {
    const env = setup();
    const { cutoff0, cy0, cx0 } = recordOne(env);
    const { engine, ghosts, store, T, toBeat } = env;
    engine.clear();
    expect(ghosts.play(0).ok).toBe(true);
    // a person plays another track meanwhile
    env.music.router.noteOn(1, 64, 0.8, 'ui');
    toBeat(13.2);
    const ons = engine.ons(0);
    expect(ons.map(e => e.note)).toEqual([60, 60, 60]);
    ons.forEach((e, k) => expect(e.time).toBeCloseTo(T.timeAtBeat(4 * (k + 1) + 1), 3));
    const offs = engine.offs(0);
    offs.slice(0, 2).forEach((e, k) => expect(e.time).toBeCloseTo(T.timeAtBeat(4 * (k + 1) + 1.5), 3));
    expect(engine.ons(1).map(e => e.note)).toEqual([64]);
    const params = engine.of('params').filter(e => e.part === 0);
    const at = (b) => params.filter(e => Math.abs(e.time - T.timeAtBeat(b)) < 1e-3).map(e => e.p);
    expect(at(4)).toEqual([{ cutoff: cutoff0, centerX: cx0, centerY: cy0 }]);
    expect(at(5.5)).toEqual([{ cutoff: 2000, centerX: 0.3, centerY: cy0 }]);
    expect(at(9.5)).toEqual([{ cutoff: 2000, centerX: 0.3, centerY: cy0 }]);
    // the store keeps the person's values (no writes from the ghost)
    expect(store.get('parts.0.params.cutoff')).toBe(2000);
    // the ghost dot follows the path
    toBeat(14);
    const d = ghosts.dotAt(0);
    expect(d).not.toBe(null);
    expect(d.u).toBeCloseTo(0.3, 5);
    expect(d.v).toBeCloseTo(cy0, 5);
    engine.clear();
    expect(ghosts.stop(0).ok).toBe(true);
    const restore = engine.of('params').filter(e => e.part === 0);
    expect(restore.length).toBe(1);
    expect(restore[0].p).toEqual({ cutoff: 2000, centerX: 0.3, centerY: cy0 });
    engine.clear();
    toBeat(17);
    expect(engine.ons(0)).toEqual([]);
    expect(ghosts.dotAt(0)).toBe(null);
  });

  it('goes quiet when the transport stops and carries on with the next Play', () => {
    const env = setup();
    recordOne(env);
    const { engine, ghosts, T, toBeat, clock } = env;
    ghosts.play(0);
    toBeat(5.2);
    engine.clear();
    T.stop();
    expect(engine.of('params').filter(e => e.part === 0).length).toBe(1);
    clock.advance(1);
    expect(engine.ons(0)).toEqual([]);
    expect(ghosts.isPlaying(0)).toBe(true);
    T.play();
    engine.clear();
    toBeat(5.1);
    // aligned to the bar it was recorded from: beat 1 of every bar again
    expect(engine.ons(0).map(e => e.time)).toEqual([expect.closeTo(T.timeAtBeat(1), 3), expect.closeTo(T.timeAtBeat(5), 3)]);
  });

  it('stops when the ghost is cleared', () => {
    const env = setup();
    recordOne(env);
    env.ghosts.play(0);
    expect(env.ghosts.clear(0).ok).toBe(true);
    expect(env.ghosts.isPlaying(0)).toBe(false);
    expect(env.store.get('parts.0.ghost')).toBeUndefined();
    expect('ghost' in migrateState(env.store.serialize()).parts[0]).toBe(false);
  });
});

describe('ghost data', () => {
  it('survives a session round trip and drops what is not a ghost', () => {
    const env = setup();
    recordOne(env);
    const saved = JSON.parse(JSON.stringify(env.store.serialize()));
    const back = migrateState(saved);
    expect(back.parts[0].ghost).toEqual(env.store.get('parts.0.ghost'));
    expect(migrateState(back).parts[0].ghost).toEqual(back.parts[0].ghost);
    expect('ghost' in back.parts[1]).toBe(false);
    for (const bad of [null, 5, { bars: 0, notes: [[0, 60, 1]] }, { bars: 2 }, { bars: 2, notes: [['x', 60, 1]], knobs: [[0, 'nope', 1], [0, 'mute', 1]], dots: [[0, 'a', 0]] }]) {
      saved.parts[1].ghost = bad;
      expect('ghost' in migrateState(saved).parts[1]).toBe(false);
    }
    const g = sanitizeGhost({ bars: 999, startBar: -4, notes: [[0, 60, 1]] });
    expect(g).toBe(null);
    const c = sanitizeGhost({ bars: 1, startBar: -4, notes: [[9, 60, 1], [1, 300, 1], [0.5, 61.4, 3]], knobs: [[0, 'cutoff', 1e9]], dots: [[0, 2, -1]] });
    expect(c.startBar).toBe(0);
    expect(c.notes).toEqual([[0.5, 61, 1]]);
    expect(c.knobs[0][2]).toBe(18000);
    expect(c.dots).toEqual([[0, 1, 0]]);
  });

  it('places the ghost dot between path points, the short way round the map', () => {
    const g = { bars: 1, startBar: 1, notes: [], knobs: [], dots: [[0, 0.9, 0.5], [2, 0.1, 0.5]] };
    expect(dotAtBeat(g, 4).u).toBeCloseTo(0.9);
    expect(dotAtBeat(g, 5).u).toBeCloseTo(0.0, 5);
    expect(dotAtBeat(g, 7).u).toBeCloseTo(0.1);
    expect(dotAtBeat(g, 11).u).toBeCloseTo(0.1);      // the next loop, after the last point
  });
});
