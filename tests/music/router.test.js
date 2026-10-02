import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { ARP } from '../../src/music/router.js';
import { START_DELAY } from '../../src/music/transport.js';
import { makeRng } from '../../src/music/patterns.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup({ tempo = 120 } = {}) {
  const clock = createFakeClock({ startSec: 2 });
  const engine = createFakeEngine(clock);
  const s = defaultState();
  s.global.tempo = tempo;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow, random: makeRng(42) });
  return { clock, engine, store, music, router: music.router };
}

function setArp(store, part, arp) {
  store.set(`parts.${part}.arp`, { ...store.get(`parts.${part}.arp`), ...arp });
}

describe('router: key modes', () => {
  it('plays the selected part in Selected mode', () => {
    const { engine, store, router } = setup();
    store.set('ui.selectedPart', 2);
    router.noteOn('sel', 60, 0.7);
    expect(engine.ons()).toEqual([{ type: 'on', part: 2, note: 60, vel: 0.7, time: 0 }]);
    router.noteOff('sel', 60);
    expect(engine.offs()).toEqual([{ type: 'off', part: 2, note: 60, time: 0 }]);
  });

  it('layers every unmuted part and releases the same parts after a mode change', () => {
    const { engine, store, router } = setup();
    store.set('global.keyMode', 1);
    store.set('parts.1.params.mute', 1);
    router.noteOn('sel', 64);
    expect(engine.ons().map(e => e.part)).toEqual([0, 2, 3]);
    store.set('global.keyMode', 0);
    router.noteOff('sel', 64);
    expect(engine.offs().map(e => e.part)).toEqual([0, 2, 3]);
  });

  it('routes explicit parts directly and ignores invalid ones', () => {
    const { engine, router } = setup();
    router.noteOn(3, 50);
    router.noteOn(9, 50);
    router.noteOn(0, 200);
    expect(engine.ons()).toHaveLength(1);
    expect(router.heldNotes(3).has(50)).toBe(true);
  });

  it('fires note events for the UI', () => {
    const { router } = setup();
    const seen = [];
    router.on('note', e => seen.push(e));
    router.noteOn(1, 60, 0.5);
    router.noteOff(1, 60);
    expect(seen.map(e => [e.part, e.note, e.on])).toEqual([[1, 60, true], [1, 60, false]]);
  });
});

describe('router: sustain', () => {
  it('holds released notes until the pedal lifts', () => {
    const { engine, router } = setup();
    router.sustain(0, true);
    router.noteOn(0, 60);
    router.noteOff(0, 60);
    expect(engine.offs()).toHaveLength(0);
    expect(router.heldNotes(0).has(60)).toBe(true);
    router.sustain(0, false);
    expect(engine.offs().map(e => e.note)).toEqual([60]);
  });

  it('does not release keys that are still physically down', () => {
    const { engine, router } = setup();
    router.sustain('sel', true);
    router.noteOn('sel', 60);
    router.noteOn('sel', 64);
    router.noteOff('sel', 60);
    router.sustain('sel', false);
    expect(engine.offs().map(e => e.note)).toEqual([60]);
    router.noteOff('sel', 64);
    expect(engine.offs().map(e => e.note)).toEqual([60, 64]);
  });
});

describe('arpeggiator', () => {
  const run = (mode, { octaves = 1, notes = [60, 64, 67], steps = 8, played } = {}) => {
    const { clock, engine, store, router } = setup({ tempo: 120 });
    setArp(store, 0, { mode, rate: 3, octaves, gate: 0.5 });
    for (const n of played || notes) router.noteOn(0, n, 0.8);
    clock.advance(steps * 0.125 - 0.06);
    return { ons: engine.ons(0), offs: engine.offs(0), clock, engine, store, router };
  };

  it('Up spans octaves at the arp rate, starting immediately', () => {
    const { ons } = run(ARP.UP, { octaves: 2, steps: 8 });
    expect(ons.map(e => e.note).slice(0, 7)).toEqual([60, 64, 67, 72, 76, 79, 60]);
    for (let i = 1; i < ons.length; i++) expect(ons[i].time - ons[i - 1].time).toBeCloseTo(0.125, 9);
  });

  it('Down, Up/Down, As Played and Chord', () => {
    expect(run(ARP.DOWN).ons.map(e => e.note).slice(0, 4)).toEqual([67, 64, 60, 67]);
    expect(run(ARP.UPDOWN, { notes: [60, 64, 67, 71], steps: 8 }).ons.map(e => e.note).slice(0, 7)).toEqual([60, 64, 67, 71, 67, 64, 60]);
    expect(run(ARP.PLAYED, { played: [67, 60, 64] }).ons.map(e => e.note).slice(0, 4)).toEqual([67, 60, 64, 67]);
    const chord = run(ARP.CHORD, { octaves: 2, steps: 3 }).ons;
    expect(chord.slice(0, 3).map(e => e.note)).toEqual([60, 64, 67]);
    expect(chord.slice(3, 6).map(e => e.note)).toEqual([72, 76, 79]);
    expect(chord[0].time).toBe(chord[2].time);
  });

  it('Random never repeats the same note twice in a row', () => {
    const { ons } = run(ARP.RANDOM, { notes: [60, 62, 64, 65, 67], steps: 40 });
    expect(ons.length).toBeGreaterThan(30);
    for (let i = 1; i < ons.length; i++) expect(ons[i].note).not.toBe(ons[i - 1].note);
    expect(new Set(ons.map(e => e.note)).size).toBe(5);
  });

  it('stops when keys are released, every note gets its off', () => {
    const { clock, engine, router } = run(ARP.UP, { steps: 4 });
    for (const n of [60, 64, 67]) router.noteOff(0, n);
    const count = engine.ons(0).length;
    clock.advance(1);
    expect(engine.ons(0).length).toBe(count);
    expect(engine.offs(0).length).toBe(count);
  });

  it('hold latches the chord and a new gesture replaces it', () => {
    const { clock, engine, store, router } = setup({ tempo: 120 });
    setArp(store, 0, { mode: ARP.UP, rate: 3, hold: 1 });
    router.noteOn(0, 60); router.noteOn(0, 63);
    router.noteOff(0, 60); router.noteOff(0, 63);
    clock.advance(0.45);
    expect(engine.ons(0).map(e => e.note).slice(0, 4)).toEqual([60, 63, 60, 63]);
    expect([...router.heldNotes(0)].sort()).toEqual([60, 63]);
    router.noteOn(0, 70);
    router.noteOff(0, 70);
    engine.clear();
    clock.advance(0.3);
    expect(new Set(engine.ons(0).map(e => e.note))).toEqual(new Set([70]));
    setArp(store, 0, { hold: 0 });
    engine.clear();
    clock.advance(0.5);
    expect(engine.ons(0)).toHaveLength(0);
  });

  it('runs while the transport is stopped and locks to the bar grid when it plays', () => {
    const { clock, engine, store, router, music } = setup({ tempo: 120 });
    setArp(store, 1, { mode: ARP.UP, rate: 1 }); // eighths
    const t0 = clock.ctx.currentTime;
    music.transport.play();
    clock.advance(0.33);
    router.noteOn(1, 60);
    router.noteOn(1, 67);
    clock.advance(1.2);
    const ons = engine.ons(1);
    expect(ons.length).toBeGreaterThan(3);
    const start = t0 + START_DELAY;
    // The first note may sound right away if the key was pressed just after a grid line.
    for (const e of ons.slice(1)) {
      const beats = (e.time - start) / 0.5;
      expect(Math.abs(beats * 2 - Math.round(beats * 2))).toBeLessThan(1e-6); // on an 8th
    }
    music.transport.stop();
    const before = engine.ons(1).length;
    clock.advance(0.6);
    expect(engine.ons(1).length).toBeGreaterThan(before); // keeps free-running
  });

  it('switching the arp off makes held keys sound directly', () => {
    const { clock, engine, store, router } = setup();
    setArp(store, 0, { mode: ARP.UP });
    router.noteOn(0, 60);
    clock.advance(0.2);
    engine.clear();
    setArp(store, 0, { mode: ARP.OFF });
    expect(engine.ons(0).map(e => [e.note, e.time])).toEqual([[60, 0]]);
    router.noteOff(0, 60);
    expect(engine.offs(0).map(e => e.note)).toEqual([60]);
  });

  it('allNotesOff clears keys, latches and the engine', () => {
    const { engine, store, router } = setup();
    setArp(store, 2, { mode: ARP.UP, hold: 1 });
    router.noteOn(2, 60);
    router.noteOn(0, 61);
    router.allNotesOff();
    expect(router.heldNotes(2).size).toBe(0);
    expect(router.heldNotes(0).size).toBe(0);
    expect(engine.events.filter(e => e.type === 'allOff').length).toBe(4);
  });
});
