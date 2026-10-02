import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, stepToMidi } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { swingBeat, swingOffsetBeats, START_DELAY } from '../../src/music/transport.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup({ tempo = 120, state } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = state || defaultState();
  s.global.tempo = tempo;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

function fillPattern(store, part, { rate = 3, steps = 16, degree = (i) => i % 7, slide = () => 0, on = () => 1, gate = 0.5 } = {}) {
  const seq = store.get(`parts.${part}.patterns.0`);
  store.set(`parts.${part}.seqOn`, 1);
  seq.rate = rate;
  seq.length = steps;
  seq.steps = seq.steps.map((st, i) => ({ ...st, on: on(i) ? 1 : 0, degree: degree(i), gate, slide: slide(i) ? 1 : 0 }));
  store.set(`parts.${part}.patterns.0`, seq);
}

describe('swing', () => {
  it('leaves eighth notes alone and delays the off-beat 16th', () => {
    expect(swingBeat(0, 0.6)).toBe(0);
    expect(swingBeat(0.5, 0.6)).toBeCloseTo(0.5, 9);
    expect(swingBeat(1, 0.3)).toBeCloseTo(1, 9);
    expect(swingBeat(0.25, 0)).toBe(0.25);
    expect(swingBeat(0.25, 0.6)).toBeCloseTo(0.25 + 0.125, 9);
    expect(swingBeat(0.75, 0.3)).toBeCloseTo(0.75 + swingOffsetBeats(0.3), 9);
  });
  it('is monotonic so steps never reorder', () => {
    let prev = -1;
    for (let b = 0; b < 4; b += 1 / 64) {
      const w = swingBeat(b, 0.6);
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });
});

describe('transport', () => {
  it('plays a 16th-note pattern with exact timestamps', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    fillPattern(store, 0);
    const t0 = clock.ctx.currentTime;
    music.transport.play();
    expect(store.get('ui.playing')).toBe(1);
    clock.advance(2.05);
    const ons = engine.ons(0);
    expect(ons.length).toBeGreaterThanOrEqual(16);
    const start = t0 + START_DELAY;
    ons.slice(0, 16).forEach((e, i) => {
      expect(e.time).toBeCloseTo(start + i * 0.125, 9);
      expect(e.note).toBe(stepToMidi({ degree: i % 7, octave: 0 }, 3, 9, 1));
    });
    // Gate 0.5 of a 16th at 120 bpm = 62.5 ms.
    const offs = engine.offs(0);
    expect(offs[0].time - ons[0].time).toBeCloseTo(0.0625, 9);
    // Nothing is ever scheduled in the past.
    music.transport.stop();
    expect(store.get('ui.playing')).toBe(0);
  });

  it('never schedules a note earlier than the moment it was scheduled', () => {
    const { clock, engine, store, music } = setup({ tempo: 140 });
    fillPattern(store, 0);
    fillPattern(store, 1, { rate: 2 });
    const realOn = engine.noteOn;
    let worst = 0;
    engine.noteOn = (p, n, v, t) => { worst = Math.min(worst, t - clock.ctx.currentTime); realOn(p, n, v, t); };
    music.transport.play();
    clock.advance(3);
    expect(worst).toBeGreaterThanOrEqual(0);
  });

  it('applies swing to odd 16ths only', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    store.set('global.swing', 0.3);
    fillPattern(store, 0);
    const t0 = clock.ctx.currentTime;
    music.transport.play();
    clock.advance(1.2);
    const ons = engine.ons(0);
    const start = t0 + START_DELAY;
    const d = swingOffsetBeats(0.3) * 0.5; // seconds at 120 bpm
    expect(ons[0].time).toBeCloseTo(start, 9);
    expect(ons[1].time).toBeCloseTo(start + 0.125 + d, 9);
    expect(ons[2].time).toBeCloseTo(start + 0.25, 9);
    expect(ons[3].time).toBeCloseTo(start + 0.375 + d, 9);
  });

  it('handles per-part rates and pattern lengths (polymeter)', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    fillPattern(store, 0, { rate: 1, steps: 3 }); // 1/8 notes, 3-step loop
    fillPattern(store, 2, { rate: 0, steps: 16 }); // quarter notes
    const seen = { 0: [], 2: [] };
    music.transport.on('step', e => { if (seen[e.part]) seen[e.part].push(e.step); });
    music.transport.play();
    clock.advance(2.2);
    expect(seen[0].slice(0, 7)).toEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(seen[2].slice(0, 4)).toEqual([0, 1, 2, 3]);
    const q = engine.ons(2);
    expect(q[1].time - q[0].time).toBeCloseTo(0.5, 9);
    const e8 = engine.ons(0);
    expect(e8[1].time - e8[0].time).toBeCloseTo(0.25, 9);
  });

  it('emits step events in order, close to when they are heard', () => {
    const { clock, store, music } = setup({ tempo: 112 });
    fillPattern(store, 0);
    const got = [];
    music.transport.on('step', e => { if (e.part === 0) got.push({ ...e, firedAt: clock.now() }); });
    music.transport.play();
    clock.advance(3);
    expect(got.length).toBeGreaterThan(20);
    for (let i = 0; i < got.length; i++) {
      expect(got[i].step).toBe(i % 16);
      expect(Math.abs(got[i].firedAt - got[i].time)).toBeLessThan(0.006);
    }
  });

  it('keeps time across tempo changes without reordering', () => {
    const { clock, engine, store, music } = setup({ tempo: 100 });
    fillPattern(store, 0);
    music.transport.play();
    clock.advance(1);
    store.set('global.tempo', 160);
    clock.advance(1);
    const times = engine.ons(0).map(e => e.time);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    const last = times.slice(-3);
    expect(last[2] - last[1]).toBeCloseTo(60 / 160 / 4, 6);
  });

  it('emits 24 PPQ clock: 48 pulses in one second at 120 bpm', () => {
    const { clock, music } = setup({ tempo: 120 });
    const pulses = [];
    let start = null;
    music.transport.on('clock', e => { if (e.type === 'tick') pulses.push(e.time); if (e.type === 'start') start = e.time; });
    music.transport.play();
    clock.advance(2);
    expect(start).not.toBeNull();
    const t0 = pulses[0];
    const inFirstSecond = pulses.filter(t => t >= t0 && t < t0 + 1 - 1e-9);
    expect(inFirstSecond.length).toBe(48);
    expect(pulses[1] - pulses[0]).toBeCloseTo(0.5 / 24, 9);
  });

  it('defers playback until the audio context is running', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    fillPattern(store, 0);
    clock.ctx.state = 'suspended';
    music.transport.play();
    clock.advanceWall(0.5);
    expect(engine.ons().length).toBe(0);
    expect(store.get('ui.playing')).toBe(1);
    clock.ctx.state = 'running';
    const resumeAt = clock.ctx.currentTime;
    clock.advance(0.3);
    const ons = engine.ons(0);
    expect(ons.length).toBeGreaterThan(0);
    expect(ons[0].time).toBeGreaterThanOrEqual(resumeAt);
  });

  it('ties slid steps: same pitch holds, new pitch overlaps for legato', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    // steps 0-1 same degree with slide on 0 -> one long note; step 2 different with slide on 1
    fillPattern(store, 0, {
      steps: 4,
      degree: (i) => (i < 2 ? 0 : 2),
      slide: (i) => i === 0 || i === 1,
      on: (i) => i < 3,
    });
    music.transport.play();
    clock.advance(0.6);
    const ev = engine.events.filter(e => e.part === 0 && (e.type === 'on' || e.type === 'off')).slice(0, 4);
    const [on0, on2, off0, off2] = [ev[0], ev[1], ev[2], ev[3]];
    expect(on0.type).toBe('on');
    expect(on2.type).toBe('on');
    expect(on2.note).not.toBe(on0.note);
    expect(on2.time - on0.time).toBeCloseTo(0.25, 9); // step 1 was tied, no new attack
    expect(off0.type).toBe('off');
    expect(off0.note).toBe(on0.note);
    expect(off0.time).toBeGreaterThan(on2.time); // legato overlap
    expect(off2.note).toBe(on2.note);
  });

  it('mirrors ui.playing both ways', () => {
    const { store, music } = setup();
    store.set('ui.playing', 1, { source: 'ui' });
    expect(music.transport.isPlaying()).toBe(true);
    store.set('ui.playing', 0, { source: 'ui' });
    expect(music.transport.isPlaying()).toBe(false);
    const states = [];
    music.transport.on('state', s => states.push(s));
    music.transport.toggle();
    music.transport.toggle();
    expect(states).toEqual([{ playing: true, external: false, source: 'internal' }, { playing: false, external: false, source: null }]);
  });

  it('reports a sensible position', () => {
    const { clock, music } = setup({ tempo: 120 });
    music.transport.play();
    clock.advance(START_DELAY + 2.6); // 5.2 beats
    const pos = music.transport.position();
    expect(pos.bar).toBe(1);
    expect(pos.beat).toBe(1);
    expect(pos.step).toBe(4);
  });

  it('follows external clock pulses', () => {
    const { clock, engine, store, music } = setup({ tempo: 90 });
    fillPattern(store, 0);
    music.transport.setFollow(true);
    // A clock is arriving, so Play leaves starting to the master.
    music.transport.syncTick({ beat: 0, time: clock.ctx.currentTime, bpm: 120 });
    expect(music.transport.play()).toBe(false);
    expect(music.transport.isPlaying()).toBe(false);
    music.transport.syncStart({ beat: 0 });
    const spt = 0.5 / 24; // 120 bpm master
    let k = 0;
    const t0 = clock.ctx.currentTime + 0.01;
    // Deliver pulses as they "arrive" in real time.
    for (let i = 0; i < 24 * 4; i++) {
      const at = t0 + i * spt;
      clock.advance(Math.max(0, at - clock.ctx.currentTime), 0.002);
      music.transport.syncTick({ beat: k / 24, time: at, bpm: 120 });
      k++;
    }
    const ons = engine.ons(0);
    expect(ons.length).toBeGreaterThanOrEqual(15);
    ons.slice(0, 15).forEach((e, i) => expect(e.time).toBeCloseTo(t0 + i * 0.125, 6));
    music.transport.syncStop();
    expect(music.transport.isPlaying()).toBe(false);
  });

  it('plays on its own while following when no clock arrives, and hands over on Start', () => {
    const { clock, engine, store, music } = setup({ tempo: 100 });
    fillPattern(store, 0);
    const clocks = [];
    music.transport.on('clock', e => clocks.push(e.type));
    music.transport.setFollow(true);
    expect(music.transport.play()).toBe(true);
    clock.advance(0.5);
    expect(engine.ons(0).length).toBeGreaterThan(0);
    expect(music.transport.isExternal()).toBe(false);
    music.transport.syncStart({ beat: 0 });
    expect(music.transport.isExternal()).toBe(true);
    expect(clocks).toContain('stop');
    music.transport.syncStop();
    expect(music.transport.isPlaying()).toBe(false);
  });

  it('tells the engine where the beat is, when the engine supports it', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    const calls = [];
    engine.setTransport = (t) => calls.push(t);
    const t0 = clock.ctx.currentTime;
    music.transport.play();
    expect(calls[0]).toMatchObject({ playing: true, beat: 0 });
    expect(calls[0].beatTime).toBeCloseTo(t0 + START_DELAY, 9);
    clock.advance(1);
    store.set('global.tempo', 90);
    expect(calls.at(-1).spb).toBeCloseTo(60 / 90, 9);
    music.transport.stop();
    expect(calls.at(-1).playing).toBe(false);
  });
});

describe('transport: stalls', () => {
  it('grows the lookahead after a stall so the next one drops no steps, then shrinks back', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    fillPattern(store, 0);
    music.transport.play();
    clock.advance(1);
    expect(music.transport.lookahead()).toBeCloseTo(0.12, 6);
    // First stall: the main thread is busy for 0.3 s; steps in that window come too late.
    clock.advance(0.3, 0.3);
    const grown = music.transport.lookahead();
    expect(grown).toBeGreaterThan(0.4);
    clock.advance(0.2);
    const from = clock.ctx.currentTime;
    // A second stall of the same length: everything was already scheduled.
    clock.advance(0.3, 0.3);
    clock.advance(0.5);
    const ons = engine.ons(0).filter(e => e.time >= from);
    for (let i = 1; i < ons.length; i++) expect(ons[i].time - ons[i - 1].time).toBeCloseTo(0.125, 6);
    expect(ons.length).toBeGreaterThanOrEqual(Math.floor((clock.ctx.currentTime - from) / 0.125));
    // Smooth running brings it back to normal within a few seconds.
    clock.advance(4);
    expect(music.transport.lookahead()).toBeLessThan(0.125);
    music.transport.stop();
  });

  it('following external clock, a stall does not drop steps once the lookahead has grown', () => {
    const { clock, engine, store, music } = setup({ tempo: 90 });
    fillPattern(store, 0);
    music.transport.setFollow(true);
    music.transport.syncStart({ beat: 0 });
    const spt = 0.5 / 24; // 120 bpm master
    const t0 = clock.ctx.currentTime + 0.01;
    let k = 0;
    // Pulses arrive on time, except during a stall: then nothing runs and the
    // backlog is handled at once when the main thread is free again.
    const runTo = (end) => {
      for (; t0 + k * spt <= end; k++) {
        const at = t0 + k * spt;
        if (at > clock.ctx.currentTime) clock.advance(at - clock.ctx.currentTime, 0.002);
        music.transport.syncTick({ beat: k / 24, time: at, bpm: 120 });
      }
    };
    const stall = (sec) => { clock.advance(sec, sec); runTo(clock.ctx.currentTime); };
    runTo(t0 + 1);
    stall(0.3);                       // first stall grows the lookahead
    expect(music.transport.lookahead()).toBeGreaterThan(0.4);
    runTo(clock.ctx.currentTime + 0.2);
    const from = clock.ctx.currentTime;
    stall(0.3);                       // the second one is already covered
    runTo(clock.ctx.currentTime + 0.5);
    const ons = engine.ons(0).filter(e => e.time >= from && e.time <= clock.ctx.currentTime);
    for (let i = 1; i < ons.length; i++) expect(ons[i].time - ons[i - 1].time).toBeCloseTo(0.125, 6);
    expect(ons.length).toBeGreaterThanOrEqual(Math.floor((clock.ctx.currentTime - from) / 0.125));
    // Stop cancels the sequencer notes queued past it, so none play late.
    const cancels = [];
    engine.cancelNotes = (after, tag) => cancels.push({ after, tag });
    music.transport.syncStop();
    expect(cancels).toEqual([{ after: clock.ctx.currentTime, tag: 'seq' }]);
  });

  it('does not treat the pause between two plays as a stall', () => {
    const { clock, store, music } = setup({ tempo: 120 });
    fillPattern(store, 0);
    music.transport.play();
    clock.advance(0.5);
    music.transport.stop();
    clock.advance(5);
    music.transport.play();
    clock.advance(0.2);
    expect(music.transport.lookahead()).toBeCloseTo(0.12, 6);
    music.transport.stop();
  });
});
