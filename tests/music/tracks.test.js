// Music side of tracks (v1.3): the router, the transport and the dot locks
// follow the live track list. Held notes reach their track after it moved, a
// removed track leaves nothing hanging, tracks past the fourth play their
// patterns, and a track plays the pattern it has selected.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { addTrack, removeTrack, moveTrack, duplicateTrack, addPattern, selectPattern } from '../../src/core/tracks.js';
import { createMusic } from '../../src/music/music.js';
import { ARP } from '../../src/music/router.js';
import { makeRng } from '../../src/music/patterns.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup({ tracks = 4, tempo = 120 } = {}) {
  const clock = createFakeClock({ startSec: 2 });
  const engine = createFakeEngine(clock);
  const s = defaultState(tracks);
  s.global.tempo = tempo;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow, random: makeRng(7) });
  return { clock, engine, store, music, router: music.router };
}

/** Track `p` plays `degree` on every step of its active pattern. */
function fill(store, p, degree = 0) {
  const path = `parts.${p}.patterns.${store.get(`parts.${p}.activePattern`)}`;
  const pat = store.get(path);
  pat.length = 4;
  pat.steps = pat.steps.map(st => ({ ...st, on: 1, degree, gate: 0.5 }));
  store.batch(() => { store.set(path, pat); store.set(`parts.${p}.seqOn`, 1); });
}

describe('router: tracks', () => {
  it('plays the selected track and layers every unmuted track in the list', () => {
    const { engine, store, router } = setup({ tracks: 6 });
    store.set('ui.selectedPart', 5);
    router.noteOn('sel', 60);
    expect(engine.ons().map(e => e.part)).toEqual([5]);
    router.noteOff('sel', 60);
    store.set('global.keyMode', 1);
    store.set('parts.2.params.mute', 1);
    router.noteOn('sel', 62);
    expect(engine.ons().slice(1).map(e => e.part)).toEqual([0, 1, 3, 4, 5]);
    router.noteOn(6, 50);                                      // no track 7
    expect(engine.ons()).toHaveLength(6);
  });

  it('sends a held note\'s note-off to its track after the track moved', () => {
    const { engine, store, router } = setup();
    router.noteOn(1, 64, 1, 'midi:x:1');
    moveTrack(store, 1, 3);
    router.noteOff(1, 64, 'midi:x:1');
    expect(engine.offs()).toEqual([{ type: 'off', part: 3, note: 64, time: 0 }]);
  });

  it('forgets a removed track\'s keys and arp, without sending notes to whichever track takes its index', () => {
    const { clock, engine, store, router } = setup();
    store.set('parts.1.arp', { ...store.get('parts.1.arp'), mode: ARP.UP, hold: 1 });
    router.noteOn(1, 60, 1, 'ui');
    router.noteOff(1, 60, 'ui');
    clock.advance(0.3);
    expect(router.arpActive()).toBe(true);
    removeTrack(store, 1);
    const before = engine.events.length;
    clock.advance(0.5);
    expect(router.arpActive()).toBe(false);
    expect(engine.events.slice(before).filter(e => e.type === 'on')).toEqual([]);
    expect(router.heldNotes(1).size).toBe(0);
  });
});

describe('transport: tracks', () => {
  it('plays the patterns of tracks past the fourth', () => {
    const { clock, engine, store, music } = setup({ tracks: 8 });
    fill(store, 7, 2);
    music.transport.play();
    clock.advance(1.05);
    const ons = engine.ons();
    expect(ons.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ons.map(e => e.part))).toEqual(new Set([7]));
    music.dispose();
  });

  it('plays the pattern a track has selected', () => {
    const { clock, engine, store, music } = setup();
    fill(store, 0, 0);
    addPattern(store, 0, { copy: false });                    // pattern 2 is empty and now active
    music.transport.play();
    clock.advance(0.6);
    expect(engine.ons()).toEqual([]);
    selectPattern(store, 0, 0);
    clock.advance(0.6);
    expect(engine.ons().length).toBeGreaterThan(0);
    music.dispose();
  });

  it('keeps each track in time through a reorder, and lets a new or duplicated track join on the grid', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    fill(store, 0, 0);
    music.transport.play();
    clock.advance(0.52);
    moveTrack(store, 0, 2);
    duplicateTrack(store, 2);                                 // a copy at index 3
    clock.advance(1);
    const ons = engine.ons();
    const moved = ons.filter(e => e.part === 2).map(e => e.time);
    const copy = ons.filter(e => e.part === 3).map(e => e.time);
    expect(ons.filter(e => e.part === 0 && e.time > ons[0].time + 0.6)).toEqual([]);
    expect(copy.length).toBeGreaterThan(0);
    // 16ths at 120 BPM: every note on the same 125 ms grid as the original
    const grid = (t) => Math.abs(((t - ons[0].time) / 0.125) - Math.round((t - ons[0].time) / 0.125));
    for (const t of [...moved, ...copy]) expect(grid(t)).toBeLessThan(1e-6);
    expect(copy[0]).toBeCloseTo(moved.find(t => t >= copy[0]), 9);
    music.dispose();
  });

  it('stops scheduling a removed track and reports no step for it', () => {
    const { clock, engine, store, music } = setup({ tracks: 5 });
    fill(store, 4, 1);
    music.transport.play();
    clock.advance(0.3);
    removeTrack(store, 4);
    const before = engine.ons().length;
    clock.advance(0.6);
    expect(engine.ons().length).toBe(before);
    expect(music.currentStep(4)).toBe(-1);
    music.dispose();
  });

  it('renders the events of every track for a bounce, track 6 included', () => {
    const { store, music } = setup({ tracks: 6 });
    fill(store, 5, 3);
    const evs = music.renderEvents(1);
    expect(new Set(evs.filter(e => e.msg.t === 'noteOn').map(e => e.msg.part))).toEqual(new Set([5]));
    expect(music.renderEvents(1, { parts: [0, 1] }).some(e => e.msg.t === 'noteOn')).toBe(false);
  });

  it('records dot moves into the active pattern of the selected track', () => {
    const { clock, store, music } = setup({ tracks: 6 });
    store.set('ui.selectedPart', 5);
    addPattern(store, 5, { copy: false });
    music.setLockRecord(true);
    music.transport.play();
    clock.advance(0.2);
    store.set('parts.5.params.centerX', 0.3, { source: 'ui' });
    const pat = store.get('parts.5.patterns.1');
    expect(pat.steps.some(s => s.lock)).toBe(true);
    expect(store.get('parts.5.patterns.0').steps.some(s => s.lock)).toBe(false);
    expect(store.get('parts.5.seqOn')).toBe(1);
    music.dispose();
  });

  it('adds a track that plays at once when its pattern is filled while playing', () => {
    const { clock, engine, store, music } = setup();
    music.transport.play();
    clock.advance(0.2);
    expect(addTrack(store)).toBe(4);
    fill(store, 4, 0);
    clock.advance(0.5);
    expect(engine.ons().some(e => e.part === 4)).toBe(true);
    music.dispose();
  });
});
