import { describe, it, expect } from 'vitest';
import { createTouchTool, strumNote } from '../../src/music/touch.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createFakeClock, createFakeEngine } from './fakes.js';
import { moveTrack, removeTrack } from '../../src/core/tracks.js';

function setup() {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const sent = [];
  engine.touchMap = (...args) => sent.push(args);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const tool = createTouchTool({ store, engine, router: music.router, timers: clock.timers, now: () => clock.now() * 1000 });
  return { clock, engine, store, music, tool, sent };
}

describe('touch tool (2.17)', () => {
  it('maps height to in-key notes, higher ground higher', () => {
    const { store } = setup();
    const low = strumNote(store, 0, -1), mid = strumNote(store, 0, 0), high = strumNote(store, 0, 1);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high - low).toBeGreaterThanOrEqual(30);   // about three octaves
    store.set('parts.3.drum.on', 1);
    expect(strumNote(store, 3, -1)).toBe(36);
    expect(strumNote(store, 3, 1)).toBe(43);
  });

  it('strums a new note each time the finger crosses to new ground', () => {
    const { tool, engine, clock } = setup();
    const t0 = clock.now() * 1000;
    tool.handle({ phase: 'down', mode: 'strum', part: 0, height: -0.8, x: 0, y: 0, time: t0 });
    tool.handle({ phase: 'move', mode: 'strum', part: 0, height: -0.79, x: 0.01, y: 0, time: t0 + 50 });   // same note
    tool.handle({ phase: 'move', mode: 'strum', part: 0, height: 0.5, x: 0.4, y: 0, time: t0 + 100 });
    tool.handle({ phase: 'move', mode: 'strum', part: 0, height: 0.9, x: 0.5, y: 0, time: t0 + 110 });     // too soon
    tool.handle({ phase: 'up', mode: 'strum', part: 0, height: 0.9, x: 0.5, y: 0, time: t0 + 200 });
    clock.advance(0.1);
    expect(engine.ons().filter((e) => e.part === 0)).toHaveLength(2);
    clock.advance(1);
    expect(engine.offs().filter((e) => e.part === 0)).toHaveLength(2);
  });

  it('drives the engine rig in FX mode and lets go on release', () => {
    const { tool, sent, engine } = setup();
    tool.handle({ phase: 'down', mode: 'fx', part: 2, height: 0.3, x: 0.5, y: -0.2 });
    tool.handle({ phase: 'up', mode: 'fx', part: 2, height: 0.3, x: 0.5, y: -0.2 });
    expect(sent[0]).toEqual([2, 0.5, -0.2, 0.3, 1, true]);
    expect(sent[1][4]).toBe(0);
    expect(engine.ons()).toHaveLength(0);
  });

  it('keeps a repeated same-pitch strike held for its own 400 ms', () => {
    const { tool, music, clock, engine } = setup();
    const strike = () => tool.handle({ phase: 'down', mode: 'strum', part: 0, height: 0, x: 0, y: 0 });
    const { note } = strike();
    clock.advance(0.25);
    strike();
    clock.advance(0.16); // the first strike's obsolete deadline has passed
    expect(music.router.heldNotes(0).has(note)).toBe(true);
    expect(engine.offs(0)).toHaveLength(1); // the retrigger's release only
    clock.advance(0.25);
    expect(music.router.heldNotes(0).has(note)).toBe(false);
    expect(engine.offs(0)).toHaveLength(2);
  });

  it('releases a strum on its original track after a reorder', () => {
    const { tool, music, clock, store } = setup();
    const { note } = tool.handle({ phase: 'down', mode: 'strum', part: 0, height: 0, x: 0, y: 0 });
    clock.advance(0.2);
    moveTrack(store, 0, 2);
    music.router.noteOn(0, note, 0.8);
    clock.advance(0.21);
    expect(music.router.heldNotes(2).has(note)).toBe(false);
    expect(music.router.heldNotes(0).has(note)).toBe(true);
  });

  it('routes a gesture release by track id after the track list moves', () => {
    const { tool, sent, store } = setup();
    const trackId = store.get('parts.0.id');
    tool.handle({ phase: 'down', mode: 'fx', part: 0, trackId, height: 0.3, x: 0.5, y: 0.2 });
    moveTrack(store, 0, 2);
    tool.handle({ phase: 'up', mode: 'fx', part: 0, trackId, height: 0.3, x: 0.5, y: 0.2 });
    expect(sent.at(-1)).toEqual([2, 0.5, 0.2, 0.3, 0, true]);
  });

  it('releases global touch sources after the touched track is removed', () => {
    const { tool, sent, store } = setup();
    const trackId = store.get('parts.0.id');
    tool.handle({ phase: 'down', mode: 'fx', part: 0, trackId, height: 0.3, x: 0.5, y: 0.2 });
    removeTrack(store, 0);
    tool.handle({ phase: 'up', mode: 'fx', part: -1, trackId, height: 0.3, x: 0.5, y: 0.2 });
    expect(sent.at(-1)).toEqual([-1, 0.5, 0.2, 0.3, 0, false]);
  });

  it('does not release a piano key or a same-pitch strum on another track', () => {
    const { tool, music, clock } = setup();
    const strike = (part) => tool.handle({ phase: 'down', mode: 'strum', part, height: 0, x: 0, y: 0 });
    const { note } = strike(0);
    music.router.noteOn(0, note, 0.8);
    clock.advance(0.2);
    strike(1);
    clock.advance(0.21);
    expect(music.router.heldNotes(0).has(note)).toBe(true);
    expect(music.router.heldNotes(1).has(note)).toBe(true);
    clock.advance(0.2);
    expect(music.router.heldNotes(1).has(note)).toBe(false);
    expect(music.router.heldNotes(0).has(note)).toBe(true);
    expect(music.router.captured(0).length).toBeGreaterThan(0);
  });

  it('forgets old deadlines after Panic and a session load', () => {
    for (const reset of ['panic', 'load']) {
      const { tool, music, clock, store } = setup();
      const strike = () => tool.handle({ phase: 'down', mode: 'strum', part: 0, height: 0, x: 0, y: 0 });
      const { note } = strike();
      clock.advance(0.2);
      if (reset === 'panic') music.router.allNotesOff();
      else store.load(defaultState());
      music.router.noteOn(0, note, 0.8);
      clock.advance(0.21);
      expect(music.router.heldNotes(0).has(note)).toBe(true);
    }
  });

  it('releases owned notes on session load without releasing held piano sources', () => {
    const { tool, music, clock, store } = setup();
    const strike = part => tool.handle({ phase: 'down', mode: 'strum', part, height: 0, x: 0, y: 0 });
    const { note } = strike(0);
    strike(1);
    music.router.noteOn(0, note, 0.8);
    store.load(defaultState());
    clock.advance(1);
    expect([...music.router.heldNotes(0)]).toEqual([note]);
    expect(music.router.heldNotes(1).size).toBe(0);
    music.router.noteOff(0, note);
    expect(music.router.heldNotes(0).size).toBe(0);
  });

  it('does not leave a pre-load strum held when the next strike has another pitch', () => {
    const { tool, music, clock, store } = setup();
    const { note: oldNote } = tool.handle({ phase: 'down', mode: 'strum', part: 0, height: -0.8, x: 0, y: 0 });
    clock.advance(0.2);
    store.load(defaultState());
    const { note: newNote } = tool.handle({ phase: 'down', mode: 'strum', part: 0, height: 0.8, x: 0, y: 0 });
    expect(newNote).not.toBe(oldNote);
    clock.advance(0.21);
    expect([...music.router.heldNotes(0)]).toEqual([newNote]);
    clock.advance(0.2);
    expect(music.router.heldNotes(0).size).toBe(0);
  });

  it('forgets a removed track and starts a fresh contour on a new track', () => {
    const { tool, music, clock, store } = setup();
    const { note } = tool.handle({ phase: 'down', mode: 'strum', part: 0, height: 0, x: 0, y: 0 });
    removeTrack(store, 0);
    const next = tool.handle({ phase: 'move', mode: 'strum', part: 0, height: 0, x: 0, y: 0 });
    expect(next.note).toBe(note);
    clock.advance(0.41);
    expect(music.router.heldNotes(0).has(note)).toBe(false);
  });

  it('disposes held notes and timers once and ignores further touches', () => {
    const { tool, engine, clock } = setup();
    tool.handle({ phase: 'down', mode: 'strum', part: 0, height: 0, x: 0, y: 0 });
    tool.dispose();
    tool.dispose();
    clock.advance(1);
    expect(engine.offs(0)).toHaveLength(1);
    expect(tool.handle({ phase: 'down', mode: 'strum', part: 0, height: 0 })).toBeNull();
  });
});
