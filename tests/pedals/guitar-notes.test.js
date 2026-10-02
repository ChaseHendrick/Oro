// v1.1 Guitar plays notes (src/pedals/guitar-notes.js): the pitch tracker's
// events (and the level stream) drive one part through the real note router,
// fed here with synthetic tracker / envelope frames and, at the end, with the
// events the real tracker produces from a synthetic plucked string.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { makeRng } from '../../src/music/patterns.js';
import {
  createGuitarNotes, GUITAR_SOURCE, DEFAULT_BEND_RANGE, STEP_BEND_RANGE, GATE_HYSTERESIS_DB, normalizeTarget,
} from '../../src/pedals/guitar-notes.js';
import { trackBuffer } from '../../src/pedals/pitch.js';
import { createFakeClock, createFakeEngine } from '../music/fakes.js';
import { pluck, midiToHz } from './signals.js';

function setup({ enabled = true, ...cfg } = {}) {
  const clock = createFakeClock({ startSec: 2 });
  const engine = createFakeEngine(clock);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow, random: makeRng(7) });
  const sched = [];
  music.router.on('sched', (e) => sched.push(e));
  const notes = createGuitarNotes({ store, router: music.router, engine });
  notes.configure({ enabled, ...cfg });
  const notesOf = () => engine.events.filter(e => e.type === 'on' || e.type === 'off').map(e => `${e.type}:${e.part}:${e.note}`);
  return { clock, engine, store, router: music.router, notes, sched, notesOf };
}

describe('guitar notes: note on / off', () => {
  it('does nothing while switched off (the default)', () => {
    const clock = createFakeClock();
    const engine = createFakeEngine(clock);
    const store = createStore(defaultState());
    const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
    const notes = createGuitarNotes({ store, router: music.router, engine });
    expect(notes.config.enabled).toBe(false);
    notes.handle({ type: 'noteOn', note: 45, velocity: 0.7 });
    notes.handle({ type: 'bend', semitones: 1 });
    expect(engine.events).toEqual([]);
  });

  it('plays the selected part through the router with source "guitar"', () => {
    const { engine, store, notes, sched } = setup();
    store.set('ui.selectedPart', 2);
    notes.handle({ type: 'noteOn', note: 45, velocity: 0.62, freq: 110 });
    expect(engine.ons()).toEqual([{ type: 'on', part: 2, note: 45, vel: 0.62, time: 0 }]);
    expect(sched[0]).toMatchObject({ part: 2, note: 45, on: true, source: GUITAR_SOURCE });
    expect(notes.sounding).toBe(45);
    notes.handle({ type: 'noteOff', note: 45 });
    expect(engine.offs()).toEqual([{ type: 'off', part: 2, note: 45, time: 0 }]);
    expect(sched[1]).toMatchObject({ part: 2, note: 45, on: false, source: GUITAR_SOURCE });
    expect(notes.sounding).toBe(null);
  });

  it('ignores a note-off for a note that is not sounding', () => {
    const { notesOf, notes } = setup();
    notes.handle({ type: 'noteOn', note: 52, velocity: 0.5 });
    notes.handle({ type: 'noteOff', note: 50 });
    expect(notesOf()).toEqual(['on:0:52']);
  });

  it('keeps one guitar note at a time: a legato change releases the old note first', () => {
    const { notesOf, notes } = setup();
    notes.handle({ type: 'noteOn', note: 57, velocity: 0.8 });
    notes.handle({ type: 'noteOn', note: 59, velocity: 0.8, legato: true });
    notes.handle({ type: 'noteOff', note: 57 });   // stale: already released
    expect(notesOf()).toEqual(['on:0:57', 'off:0:57', 'on:0:59']);
    expect(notes.stats()).toMatchObject({ notes: 2, lastNote: 59, sounding: 59 });
  });

  it('ends the note when the envelope falls below the gate (with hysteresis)', () => {
    const { notesOf, notes } = setup({ gateDb: -50 });
    notes.handle({ type: 'noteOn', note: 64, velocity: 0.9 });
    // Frames ringing out: above the gate, at it, and just inside the hysteresis.
    for (const db of [-20, -35, -49, -50, -50 - GATE_HYSTERESIS_DB + 0.5]) notes.handle({ type: 'level', db, value: 0.1 });
    expect(notesOf()).toEqual(['on:0:64']);
    notes.handle({ type: 'level', db: -50 - GATE_HYSTERESIS_DB - 0.5, value: 0 });
    expect(notesOf()).toEqual(['on:0:64', 'off:0:64']);
    // Quiet frames with nothing sounding do nothing.
    notes.handle({ type: 'level', db: -90, value: 0 });
    expect(notesOf()).toHaveLength(2);
  });

  it('a more sensitive gate keeps quieter notes alive', () => {
    const { notesOf, notes } = setup({ gateDb: -70 });
    notes.handle({ type: 'noteOn', note: 64, velocity: 0.3 });
    notes.handle({ type: 'level', db: -60 });
    expect(notesOf()).toEqual(['on:0:64']);
    notes.configure({ gateDb: -40 });
    notes.handle({ type: 'level', db: -60 });
    expect(notesOf()).toEqual(['on:0:64', 'off:0:64']);
  });

  it('plays a fixed part, or every unmuted part in Layer key mode', () => {
    const a = setup({ target: 3 });
    a.store.set('ui.selectedPart', 1);
    a.notes.handle({ type: 'noteOn', note: 40, velocity: 0.5 });
    expect(a.notesOf()).toEqual(['on:3:40']);
    const b = setup();
    b.store.set('global.keyMode', 1);
    b.store.set('parts.1.params.mute', 1);
    b.notes.handle({ type: 'noteOn', note: 40, velocity: 0.5 });
    b.notes.handle({ type: 'noteOff', note: 40 });
    expect(b.notesOf()).toEqual(['on:0:40', 'on:2:40', 'on:3:40', 'off:0:40', 'off:2:40', 'off:3:40']);
  });

  it('releases the sounding note when switched off, retargeted or stopped', () => {
    const { notesOf, notes, engine } = setup();
    notes.handle({ type: 'noteOn', note: 50, velocity: 0.5 });
    notes.configure({ target: 1 });
    expect(notesOf()).toEqual(['on:0:50', 'off:0:50']);
    notes.handle({ type: 'noteOn', note: 52, velocity: 0.5 });
    notes.configure({ enabled: false });
    notes.configure({ enabled: true });
    notes.handle({ type: 'noteOn', note: 53, velocity: 0.5 });
    notes.handle({ type: 'stop' });   // the return closed
    expect(notesOf()).toEqual(['on:0:50', 'off:0:50', 'on:1:52', 'off:1:52', 'on:1:53', 'off:1:53']);
    engine.clear();
    notes.handle({ type: 'stop' });
    expect(engine.events).toEqual([]);
  });

  it('normalises the target', () => {
    expect(normalizeTarget('sel')).toBe('sel');
    expect(normalizeTarget(null)).toBe('sel');
    expect(normalizeTarget(2)).toBe(2);
    expect(normalizeTarget('3')).toBe(3);
    expect(normalizeTarget(9)).toBe('sel');
  });
});

describe('guitar notes: bends', () => {
  it('scales bends into the part\'s Bend range and clears them at note-off', () => {
    const { engine, notes, store } = setup();
    expect(store.get('parts.0.params.bendRange')).toBe(2);
    expect(notes.trackerConfig()).toEqual({ gateDb: -50, bendRange: 2 });
    notes.handle({ type: 'noteOn', note: 60, velocity: 0.5 });
    notes.handle({ type: 'bend', semitones: 1 });
    notes.handle({ type: 'bend', semitones: -0.5 });
    notes.handle({ type: 'bend', semitones: 3 });   // past the range: clamped
    notes.handle({ type: 'noteOff', note: 60 });
    expect(engine.of('bend').map(e => [e.part, e.v])).toEqual([[0, 0.5], [0, -0.25], [0, 1], [0, 0]]);
  });

  it('follows a wider Bend range and tells the tracker about it', () => {
    const { engine, notes, store } = setup();
    store.set('parts.0.params.bendRange', 12);
    expect(notes.trackerConfig().bendRange).toBe(12);
    notes.handle({ type: 'noteOn', note: 60, velocity: 0.5 });
    notes.handle({ type: 'bend', semitones: 3 });
    expect(engine.of('bend').pop().v).toBeCloseTo(0.25, 9);
  });

  it('uses the smallest range when the guitar plays several parts', () => {
    const { notes, store } = setup();
    store.set('global.keyMode', 1);
    store.set('parts.2.params.bendRange', 1);
    store.set('parts.3.params.bendRange', 7);
    expect(notes.bendRange()).toBe(1);
  });

  it('steps through notes instead when bends are off or the part has Bend at 0', () => {
    const a = setup({ bends: false });
    expect(a.notes.trackerConfig().bendRange).toBe(STEP_BEND_RANGE);
    a.notes.handle({ type: 'noteOn', note: 60, velocity: 0.5 });
    a.notes.handle({ type: 'bend', semitones: 0.3 });
    expect(a.engine.of('bend')).toEqual([]);
    const b = setup();
    b.store.set('parts.0.params.bendRange', 0);
    expect(b.notes.trackerConfig().bendRange).toBe(STEP_BEND_RANGE);
    b.notes.handle({ type: 'noteOn', note: 60, velocity: 0.5 });
    b.notes.handle({ type: 'bend', semitones: 0.3 });
    expect(b.engine.of('bend')).toEqual([]);
  });

  it('falls back to +/-2 semitones when no Bend range is known', () => {
    const played = [], bends = [];
    const router = { resolve: () => [1], noteOn: (t, n) => played.push(n), noteOff: () => {} };
    const store = { get: () => undefined };
    const notes = createGuitarNotes({ store, router, engine: { bend: (p, v) => bends.push([p, v]) } });
    notes.configure({ enabled: true });
    expect(notes.bendRange()).toBe(DEFAULT_BEND_RANGE);
    notes.handle({ type: 'noteOn', note: 62, velocity: 0.5 });
    notes.handle({ type: 'bend', semitones: 1 });
    expect(bends).toEqual([[1, 0.5]]);
    expect(played).toEqual([62]);
  });

  it('turning bends off mid-note puts the pitch back', () => {
    const { engine, notes } = setup();
    notes.handle({ type: 'noteOn', note: 60, velocity: 0.5 });
    notes.handle({ type: 'bend', semitones: 1 });
    notes.configure({ bends: false });
    expect(engine.of('bend').map(e => e.v)).toEqual([0.5, 0]);
    expect(notes.sounding).toBe(60);
  });
});

describe('guitar notes: from the real tracker', () => {
  it('a plucked A2 with a whole-tone bend plays A2 and bends the part up to the top of its range', { timeout: 60000 }, () => {
    const sr = 48000;
    const sig = pluck({ sampleRate: sr, freq: midiToHz(45), duration: 1.4, start: 0.1, seed: 3, bend: { at: 0.4, rise: 0.15, semis: 2, hold: 0.3 } });
    const { notes, engine, notesOf } = setup();
    const { events } = trackBuffer(sig, sr, notes.trackerConfig());
    for (const e of events) notes.handle(e);
    expect(notesOf()[0]).toBe('on:0:45');
    const bends = engine.of('bend').map(e => e.v);
    // Up to about +1 (two semitones in a +/-2 range), then back.
    expect(Math.max(...bends)).toBeGreaterThan(0.85);
    expect(Math.max(...bends)).toBeLessThanOrEqual(1);
    // The bend stays a bend: no extra notes while it lasts.
    expect(engine.ons().filter(e => e.note !== 45)).toEqual([]);
  });

  it('with bends off, the same bend steps up to B2 and back', { timeout: 60000 }, () => {
    const sr = 48000;
    const sig = pluck({ sampleRate: sr, freq: midiToHz(45), duration: 1.4, start: 0.1, seed: 3, bend: { at: 0.4, rise: 0.15, semis: 2, hold: 0.3 } });
    const { notes, engine } = setup({ bends: false });
    const { events } = trackBuffer(sig, sr, notes.trackerConfig());
    for (const e of events) notes.handle(e);
    const ons = engine.ons().map(e => e.note);
    expect(ons[0]).toBe(45);
    expect(ons).toContain(47);
    expect(engine.of('bend')).toEqual([]);
  });
});
