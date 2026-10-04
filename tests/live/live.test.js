// Live performance mode (2.12): the saved setup and its migration, default
// pads, pad dispatch per type, quantised switching on the fake clock,
// setlist navigation, the lock, keys, tap tempo and MIDI learn persistence.

import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, PART_COLORS } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { describeEdit, createHistory } from '../../src/core/history.js';
import { createMusic } from '../../src/music/music.js';
import { createPresets } from '../../src/presets/presets.js';
import { setSmartMap } from '../../src/core/smart.js';
import { KIT_BASE_NOTE } from '../../src/dsp/drum-kit.js';
import { createMidi, STORAGE_KEY, LEARNABLE_ACTIONS } from '../../src/midi/midi.js';
import {
  sanitizeLive, sanitizePad, readLive, patchLive, defaultPads, parseNotes, formatNotes, chordName, scaleTriad,
  stepSetlist, nowNext, moveEntry, createTapTempo, liveKeyAction, lockBlocks, liveMidiAction, LIVE_ACTIONS, PAD_COUNT, PAD_CODES,
} from '../../src/live/setup.js';
import { createLiveController, SEQ_MARGIN } from '../../src/live/controller.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { fakeInput, fakeOutput, fakeAccess, fakeNavigator } from '../midi/fake-midi.js';

function setup({ state = defaultState(), startSec = 1 } = {}) {
  const clock = createFakeClock({ startSec });
  const engine = createFakeEngine(clock);
  const store = createStore(state);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const presets = createPresets({ store, storage: createMemoryStorage() });
  const live = createLiveController({ store, music, presets, timers: clock.timers, now: clock.perfNow });
  return { clock, engine, store, music, presets, live };
}

/** A session whose track 1 has two patterns with different notes (degree 0 and degree 4). */
function twoPatternState() {
  const s = defaultState();
  const p = s.parts[0];
  const a = JSON.parse(JSON.stringify(p.patterns[0]));
  a.steps.forEach((st, i) => { st.on = i % 4 === 0 ? 1 : 0; st.degree = 0; });
  const b = JSON.parse(JSON.stringify(a));
  b.id = 'p2'; b.name = 'Pattern 2';
  b.steps.forEach((st) => { st.degree = 4; });
  p.patterns = [a, b];
  p.activePattern = 0;
  p.seqOn = 1;
  for (let t = 1; t < s.parts.length; t++) s.parts[t].seqOn = 0;
  return migrateState(s);
}

describe('live setup: saved data and migration', () => {
  it('is left out of sessions that never used live mode (defaults and old sessions unchanged)', () => {
    const d = defaultState();
    expect('live' in migrateState(d)).toBe(false);
    expect(migrateState(d)).toEqual(migrateState(JSON.parse(JSON.stringify(d))));
    expect(JSON.stringify(migrateState(d))).toBe(JSON.stringify(migrateState(migrateState(d))));
    expect(sanitizeLive(null)).toBe(null);
    expect(sanitizeLive({})).toBe(null);
    expect(sanitizeLive({ lock: 0, songChange: 'bar', backdrop: 'dim', look: 'dark', setlist: [] })).toBe(null);
    expect('live' in migrateState({ ...d, live: { lock: 0 } })).toBe(false);
  });

  it('keeps a set-up live mode through a save and load, and cleans bad values', () => {
    const live = {
      pads: [{ type: 'mute', track: 1, label: 'Bass', color: '#FF7A45', quant: 'beat' }, { type: 'bogus' }, null,
        { type: 'note', track: 'sel', notes: [60, 64, 67, 300, 'x'], label: 'C' }, { type: 'scene', scene: '' }],
      setlist: [{ kind: 'scene', ref: 'u-1', name: 'Opener', key: 'A minor', tempo: 112, cues: 'Long intro' }, { kind: 'nope', ref: 'x' }],
      lock: 1, songChange: 'confirm', backdrop: 'off', extra: 'dropped',
    };
    const out = migrateState({ ...defaultState(), live });
    expect(out.live.pads).toHaveLength(PAD_COUNT);
    expect(out.live.pads[0]).toEqual({ type: 'mute', track: 1, label: 'Bass', color: '#ff7a45', quant: 'beat' });
    expect(out.live.pads[1]).toBe(null);
    expect(out.live.pads[3].notes).toEqual([60, 64, 67]);
    expect(out.live.pads[4]).toBe(null);
    expect(out.live.setlist).toEqual([{ kind: 'scene', ref: 'u-1', name: 'Opener', key: 'A minor', tempo: 112, cues: 'Long intro' }]);
    expect(out.live).toMatchObject({ lock: 1, songChange: 'confirm', backdrop: 'off' });
    expect('extra' in out.live).toBe(false);
    // A second pass changes nothing.
    expect(migrateState(JSON.parse(JSON.stringify(out)))).toEqual(out);
  });

  it('defaults quantise to Bar for scenes and patterns and Off for the rest', () => {
    expect(sanitizePad({ type: 'scene', scene: 'a' }).quant).toBe('bar');
    expect(sanitizePad({ type: 'pattern', track: 0, pattern: 1 }).quant).toBe('bar');
    expect(sanitizePad({ type: 'section', pattern: 1 }).quant).toBe('bar');
    expect(sanitizePad({ type: 'mute', track: 0 }).quant).toBe('off');
    expect(sanitizePad({ type: 'drum', track: 0, pad: 3 }).quant).toBe('off');
    expect(sanitizePad({ type: 'macros', values: [1, 0.5] }).values).toEqual([1, 0.5, 0, 0]);
  });

  it('patchLive merges and drops the key when everything is back to default', () => {
    const a = patchLive(undefined, { lock: 1 });
    expect(a).toEqual({ lock: 1 });
    expect(patchLive(a, { lock: 0 })).toBe(null);
    expect(readLive(a)).toEqual({ pads: null, setlist: [], lock: 1, songChange: 'bar', backdrop: 'dim', look: 'dark' });
    expect(patchLive(a, { lock: 0, look: 'app' })).toEqual({ look: 'app' });
  });

  it('loading a scene keeps the live setup, and saved scenes leave it out', () => {
    const { store, presets } = setup();
    store.set('live', { lock: 1, setlist: [{ kind: 'scene', ref: 'f-x', name: 'X', key: '', tempo: 0, cues: '' }] }, { source: 'live' });
    const id = presets.saveScene('Song A');
    expect('live' in presets.getScene(id)).toBe(false);
    presets.loadScene(0);
    expect(store.get('live')).toEqual({ lock: 1, setlist: [{ kind: 'scene', ref: 'f-x', name: 'X', key: '', tempo: 0, cues: '' }] });
  });

  it('live edits are one undo step labelled Live setup', () => {
    expect(describeEdit('live.pads')).toBe('Live setup');
    expect(describeEdit('live')).toBe('Live setup');
    const clock = createFakeClock();
    const store = createStore(defaultState());
    const hist = createHistory(store, { timers: clock.timers });
    store.set('live', { lock: 1 }, { source: 'live' });
    clock.advance(1);
    expect(hist.list().past).toEqual(['Live setup']);
    hist.undo();
    expect(store.get('live')).toBe(undefined);
    // the lock written as a preference is not an undo step
    store.set('live', { lock: 1 }, { source: 'prefs' });
    clock.advance(1);
    expect(hist.list().past).toEqual([]);
  });
});

describe('default pads', () => {
  it('builds mutes, chords in the key and the selected track\'s patterns from a plain session', () => {
    const s = defaultState();
    const pads = defaultPads({ ...s, ui: { selectedPart: 0 } });
    expect(pads).toHaveLength(16);
    // no scenes and one pattern per track: solos
    expect(pads.slice(0, 4).map(p => [p.type, p.track])).toEqual([['solo', 0], ['solo', 1], ['solo', 2], ['solo', 3]]);
    expect(pads.slice(4, 8).map(p => p.type)).toEqual(['mute', 'mute', 'mute', 'mute']);
    expect(pads[5].track).toBe(1);
    expect(pads[4].color).toBe(s.parts[0].color.toLowerCase());
    // A minor: i, iv, v, VI
    expect(pads.slice(8, 12).map(p => p.label)).toEqual(['Am', 'Dm', 'Em', 'F']);
    expect(pads[8]).toMatchObject({ type: 'note', track: 'sel', notes: [69, 72, 76] });
    expect(pads[12]).toMatchObject({ type: 'pattern', track: 0, pattern: 0, quant: 'bar' });
    expect(pads.slice(13)).toEqual([null, null, null]);
  });

  it('uses saved scenes, sections and a drum kit when the session has them', () => {
    const s = twoPatternState();
    s.parts[2].drum.on = 1;
    const pads = defaultPads({ ...s, ui: { selectedPart: 0 } }, [{ id: 'u-1', name: 'Verse' }]);
    expect(pads[0]).toMatchObject({ type: 'scene', scene: 'u-1', label: 'Verse', quant: 'bar' });
    expect(pads[1]).toMatchObject({ type: 'section', pattern: 0, label: 'Section 1' });
    expect(pads[2]).toMatchObject({ type: 'section', pattern: 1 });
    expect(pads[3]).toBe(null);
    expect(pads.slice(8, 12).map(p => [p.type, p.track, p.pad, p.label])).toEqual([['drum', 2, 0, 'Kick'], ['drum', 2, 1, 'Snare'], ['drum', 2, 2, 'Closed hat'], ['drum', 2, 3, 'Open hat']]);
    expect(pads[13]).toMatchObject({ type: 'pattern', pattern: 1, label: 'Pattern 2' });
    expect(PART_COLORS).toContain(pads[0].color);
  });

  it('parses and names notes and chords', () => {
    expect(parseNotes('C4 E4 G4')).toEqual([60, 64, 67]);
    expect(parseNotes('Bb3, 62 x C#5')).toEqual([58, 62, 73]);
    expect(formatNotes([60, 63, 67])).toBe('C4 D#4 G4');
    expect(chordName([60, 63, 67])).toBe('Cm');
    expect(chordName([59, 62, 65])).toBe('Bdim');
    expect(chordName([64])).toBe('E4');
    expect(scaleTriad(0, 0, 4)).toEqual([67, 71, 74]);
  });
});

describe('pad dispatch (transport stopped: every pad acts at once)', () => {
  it('section, pattern, mute and solo pads', () => {
    const { store, live } = setup({ state: twoPatternState() });
    live.setPad(0, { type: 'pattern', track: 0, pattern: 1, label: 'B', color: '#3fd0c9', quant: 'bar' });
    live.setPad(1, { type: 'section', pattern: 0, label: 'A', color: '#3fd0c9', quant: 'bar' });
    live.setPad(2, { type: 'mute', track: 1, label: 'M', color: '#3fd0c9' });
    live.setPad(3, { type: 'solo', track: 2, label: 'S', color: '#3fd0c9' });
    expect(live.press(0)).toBe('fired');
    expect(store.get('parts.0.activePattern')).toBe(1);
    expect(live.status(0)).toBe('active');
    expect(live.status(1)).toBe('armed');
    expect(live.press(1)).toBe('fired');
    expect(store.get('parts.0.activePattern')).toBe(0);
    expect(live.status(1)).toBe('active');
    live.press(2);
    expect(store.get('parts.1.params.mute')).toBe(1);
    expect(live.status(2)).toBe('active');
    live.press(2);
    expect(store.get('parts.1.params.mute')).toBe(0);
    live.press(3);
    expect(store.get('parts.2.params.solo')).toBe(1);
  });

  it('a pattern pad for a pattern the track lacks shows as missing and does nothing', () => {
    const { store, live } = setup();
    live.setPad(0, { type: 'pattern', track: 0, pattern: 5, label: 'X', color: '#3fd0c9' });
    live.setPad(1, { type: 'mute', track: 9, label: 'X', color: '#3fd0c9' });
    expect(live.status(0)).toBe('missing');
    expect(live.press(0)).toBe('missing');
    expect(live.status(1)).toBe('missing');
    expect(store.get('parts.0.activePattern')).toBe(0);
    expect(live.status(13)).toBe('empty');   // the default pads leave this one empty
  });

  it('scene pads load the scene and light up', () => {
    const { store, presets, live } = setup();
    store.set('global.tempo', 99, { source: 'test' });
    const id = presets.saveScene('Chorus');
    store.set('global.tempo', 130, { source: 'test' });
    live.setPad(0, { type: 'scene', scene: id, label: 'Chorus', color: '#3fd0c9' });
    expect(live.press(0)).toBe('fired');
    expect(store.get('global.tempo')).toBe(99);
    expect(live.status(0)).toBe('active');
    expect(store.get('live.pads.0.scene')).toBe(id);   // the live setup survived the load
  });

  it('drum pads hit the kit note; note pads hold until released', () => {
    const { clock, engine, live } = setup();
    live.setPad(0, { type: 'drum', track: 2, pad: 3, label: 'Hat', color: '#3fd0c9' });
    live.setPad(1, { type: 'note', track: 1, notes: [60, 64, 67], label: 'C', color: '#3fd0c9' });
    live.press(0);
    expect(engine.ons(2).map(e => e.note)).toEqual([KIT_BASE_NOTE + 3]);
    clock.advance(0.2);
    expect(engine.offs(2).map(e => e.note)).toEqual([KIT_BASE_NOTE + 3]);
    live.press(1);
    expect(engine.ons(1).map(e => e.note).sort()).toEqual([60, 64, 67]);
    expect(live.status(1)).toBe('active');
    clock.advance(1);
    expect(engine.offs(1)).toHaveLength(0);
    live.release(1);
    expect(engine.offs(1).map(e => e.note).sort()).toEqual([60, 64, 67]);
    expect(live.status(1)).toBe('armed');
    // a press that is not held (a MIDI button) ends by itself
    live.press(1, { hold: false });
    clock.advance(0.5);
    expect(engine.offs(1)).toHaveLength(6);
  });

  it('macro and smart control presets', () => {
    const { store, live } = setup();
    live.setPad(0, { type: 'macros', values: [1, 0.25, 0, 0.5], label: 'Big', color: '#3fd0c9' });
    live.press(0);
    expect([1, 2, 3, 4].map(k => store.get(`global.macro${k}`))).toEqual([1, 0.25, 0, 0.5]);
    expect(live.status(0)).toBe('active');
    store.set('global.macro2', 0.3, { source: 'ui' });
    expect(live.status(0)).toBe('armed');
    setSmartMap(store, 0, 0, 'cutoff', 200, 8000);
    live.setPad(1, { type: 'smart', track: 0, values: [1, null, null, null, null, null, null, null], label: 'Open', color: '#3fd0c9' });
    live.setPad(2, { type: 'smart', track: 0, values: [null, 1, null, null, null, null, null, null], label: 'None', color: '#3fd0c9' });
    live.press(1);
    expect(Math.abs(store.get('parts.0.params.cutoff') - 8000)).toBeLessThan(8000 * 0.002);
    expect(store.get('parts.0.smart.knobs.0.value')).toBe(1);
    expect(live.status(1)).toBe('active');
    expect(live.status(2)).toBe('missing');   // knob 2 has no targets
  });

  it('the first pad edit keeps the other default pads', () => {
    const { store, live } = setup();
    const before = live.pads();
    live.setPad(15, { type: 'solo', track: 0, label: 'Solo 1', color: '#3fd0c9' });
    const after = live.pads();
    expect(after.slice(0, 15)).toEqual(before.slice(0, 15));
    expect(store.get('live.pads')).toHaveLength(16);
    live.setPad(15, null);
    expect(live.pads()[15]).toBe(null);
  });
});

describe('quantised switching (fake clock)', () => {
  function playing(opts) {
    const env = setup(opts);
    env.music.transport.play();
    env.clock.advance(0.3);
    return env;
  }

  it('a Bar pad waits for the next bar; steps before the line play the old pattern, from the line the new one', () => {
    const { clock, engine, store, music, live } = playing({ state: twoPatternState() });
    live.setPad(0, { type: 'pattern', track: 0, pattern: 1, label: 'B', color: '#3fd0c9', quant: 'bar' });
    expect(live.press(0)).toBe('queued');
    expect(live.status(0)).toBe('queued');
    const [q] = live.queued();
    const spb = music.transport.spb();
    expect(music.transport.beatAt(q.boundary)).toBeCloseTo(4, 6);
    expect(q.fireAt).toBeLessThan(q.boundary - music.transport.lookahead());
    expect(store.get('parts.0.activePattern')).toBe(0);
    expect(live.progress(0)).toBeLessThan(0.2);
    clock.advance(q.fireAt - clock.now() - 0.01);
    expect(store.get('parts.0.activePattern')).toBe(0);
    expect(live.progress(0)).toBeGreaterThan(0.5);
    clock.advance(0.02);
    expect(store.get('parts.0.activePattern')).toBe(1);
    expect(live.status(0)).toBe('queued');          // still shown as waiting until the line
    clock.advance(q.boundary - clock.now() + 0.01);
    expect(live.status(0)).toBe('active');
    clock.advance(4 * spb);
    const ons = engine.ons(0);
    const before = ons.filter(e => e.time < q.boundary - 1e-6);
    const after = ons.filter(e => e.time >= q.boundary - 1e-6);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    const firstNote = before[0].note;
    expect(before.every(e => e.note === firstNote)).toBe(true);
    expect(after.every(e => e.note !== firstNote)).toBe(true);
    expect(after[0].time).toBeCloseTo(q.boundary, 6);
  });

  it('pressing a queued pad again cancels it', () => {
    const { clock, store, live } = playing({ state: twoPatternState() });
    live.setPad(0, { type: 'pattern', track: 0, pattern: 1, label: 'B', color: '#3fd0c9', quant: 'bar' });
    live.press(0);
    expect(live.press(0)).toBe('cancelled');
    expect(live.queued()).toEqual([]);
    clock.advance(3);
    expect(store.get('parts.0.activePattern')).toBe(0);
  });

  it('a Beat mute flips on the next beat, not before', () => {
    const { clock, store, music, live } = playing();
    live.setPad(0, { type: 'mute', track: 1, label: 'M', color: '#3fd0c9', quant: 'beat' });
    live.press(0);
    const [q] = live.queued();
    expect(q.kind).toBe('now');
    const b = music.transport.beatAt(q.boundary);
    expect(Math.abs(b - Math.round(b))).toBeLessThan(1e-6);
    clock.advance(q.boundary - clock.now() - 0.01);
    expect(store.get('parts.1.params.mute')).toBe(0);
    clock.advance(0.02);
    expect(store.get('parts.1.params.mute')).toBe(1);
  });

  it('a newer change of the same thing replaces the queued one; others queue side by side', () => {
    const { live } = playing({ state: twoPatternState() });
    live.setPad(0, { type: 'pattern', track: 0, pattern: 1, label: 'B', color: '#3fd0c9' });
    live.setPad(1, { type: 'pattern', track: 0, pattern: 0, label: 'A', color: '#3fd0c9' });
    live.setPad(2, { type: 'mute', track: 2, label: 'M', color: '#3fd0c9', quant: 'bar' });
    live.press(0); live.press(1); live.press(2);
    expect(live.queued().map(q => q.pad)).toEqual([1, 2]);
  });

  it('stopping the transport applies what was waiting; stopped, quantised pads act at once', () => {
    const { store, music, live } = playing({ state: twoPatternState() });
    live.setPad(0, { type: 'pattern', track: 0, pattern: 1, label: 'B', color: '#3fd0c9' });
    live.press(0);
    music.transport.stop();
    expect(store.get('parts.0.activePattern')).toBe(1);
    expect(live.queued()).toEqual([]);
    live.setPad(1, { type: 'section', pattern: 0, label: 'A', color: '#3fd0c9' });
    expect(live.press(1)).toBe('fired');
    expect(store.get('parts.0.activePattern')).toBe(0);
  });

  it('a quantised note pad plays on the line and, released early, for one beat', () => {
    const { clock, engine, music, live } = playing();
    live.setPad(0, { type: 'note', track: 1, notes: [72], label: 'C', color: '#3fd0c9', quant: 'beat' });
    live.press(0);
    live.release(0);
    const [q] = live.queued();
    clock.advance(q.boundary - clock.now() + 0.02);
    expect(engine.ons(1).filter(e => e.note === 72)).toHaveLength(1);
    expect(engine.offs(1).filter(e => e.note === 72)).toHaveLength(0);
    clock.advance(music.transport.spb() + 0.05);
    expect(engine.offs(1).filter(e => e.note === 72)).toHaveLength(1);
  });

  it('keeps the margin ahead of the scheduler', () => {
    expect(SEQ_MARGIN).toBeGreaterThan(0);
    expect(SEQ_MARGIN).toBeLessThan(0.1);
  });
});

describe('setlist', () => {
  function withSongs(opts = {}) {
    const env = setup(opts);
    const { store, presets, live } = env;
    const ids = [90, 100, 110].map((bpm, i) => { store.set('global.tempo', bpm, { source: 'test' }); return presets.saveScene(`Song ${i + 1}`); });
    store.set('global.tempo', 120, { source: 'test' });
    live.writeLive({ setlist: ids.map((ref, i) => ({ kind: 'scene', ref, name: `Song ${i + 1}`, key: '', tempo: 0, cues: '' })), ...(opts.songChange ? { songChange: opts.songChange } : {}) });
    return { ...env, ids };
  }

  it('steps through the songs with Next and Previous (stopped: at once)', async () => {
    const { store, live } = withSongs();
    expect(live.position()).toBe(-1);
    expect(await live.prev()).toBe('start');
    expect(await live.next()).toBe('loaded');
    expect(live.position()).toBe(0);
    expect(store.get('global.tempo')).toBe(90);
    expect(await live.next()).toBe('loaded');
    expect(store.get('global.tempo')).toBe(100);
    expect(await live.next()).toBe('loaded');
    expect(await live.next()).toBe('end');
    expect(live.position()).toBe(2);
    expect(await live.prev()).toBe('loaded');
    expect(store.get('global.tempo')).toBe(100);
    expect(store.get('live.setlist')).toHaveLength(3);   // still there after every load
  });

  it('waits for the bar while playing; Next again cancels', async () => {
    const { clock, store, music, live } = withSongs();
    music.transport.play();
    clock.advance(0.3);
    expect(await live.next()).toBe('queued');
    expect(live.queuedSong()).toBe(0);
    expect(store.get('global.tempo')).toBe(120);
    expect(await live.next()).toBe('cancelled');
    expect(await live.next()).toBe('queued');
    clock.advance(2.5);
    expect(store.get('global.tempo')).toBe(90);
    expect(live.position()).toBe(0);
    expect(live.songQueued()).toBe(false);
  });

  it('asks first when set to confirm, then waits for the bar', async () => {
    const { clock, store, music, live } = withSongs({ songChange: 'confirm' });
    music.transport.play();
    clock.advance(0.3);
    expect(await live.next()).toBe('confirm');
    expect(await live.goTo(1, { confirmed: true })).toBe('queued');
    clock.advance(2.5);
    expect(store.get('global.tempo')).toBe(100);
  });

  it('loads at once when set to now', async () => {
    const { clock, store, music, live } = withSongs({ songChange: 'now' });
    music.transport.play();
    clock.advance(0.3);
    expect(await live.goTo(2)).toBe('loaded');
    expect(store.get('global.tempo')).toBe(110);
  });

  it('plays versions from version history, keeping the setlist', async () => {
    const clock = createFakeClock();
    const store = createStore(defaultState());
    const old = migrateState({ ...defaultState(), global: { ...defaultState().global, tempo: 77 } });
    const versions = { list: () => [{ id: 'v1' }], get: async (id) => (id === 'v1' ? JSON.parse(JSON.stringify(old)) : null) };
    const live = createLiveController({ store, timers: clock.timers, getVersions: () => versions });
    live.writeLive({ setlist: [{ kind: 'version', ref: 'v1', name: 'Demo' }, { kind: 'version', ref: 'gone', name: 'Gone' }] });
    expect(await live.goTo(0)).toBe('loaded');
    expect(store.get('global.tempo')).toBe(77);
    expect(store.get('live.setlist')).toHaveLength(2);
    expect(live.songMissing(1)).toMatch(/no longer stored/);
    expect(await live.goTo(1)).toBe('missing');
  });

  it('helpers: step, now and next, and reorder', () => {
    expect(stepSetlist(-1, 1, 3)).toBe(0);
    expect(stepSetlist(2, 1, 3)).toBe(2);
    expect(stepSetlist(0, -1, 3)).toBe(0);
    expect(stepSetlist(0, 1, 0)).toBe(-1);
    const list = [{ name: 'a' }, { name: 'b' }];
    expect(nowNext(list, -1)).toEqual({ now: null, next: list[0], nextIndex: 0 });
    expect(nowNext(list, 1)).toEqual({ now: list[1], next: null, nextIndex: -1 });
    expect(moveEntry(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveEntry(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('big controls', () => {
  it('tap tempo averages the last taps and starts again after a pause', () => {
    let t = 0;
    const tap = createTapTempo({ now: () => t });
    expect(tap.tap()).toBe(null);
    t += 500; expect(tap.tap()).toBe(120);
    t += 500; t += 0; expect(tap.tap()).toBe(120);
    t += 400; expect(tap.tap()).toBe(129);
    t += 5000; expect(tap.tap()).toBe(null);
    t += 250; expect(tap.tap()).toBe(240);
  });

  it('the controller sets the tempo from taps and Panic stops held notes and the queue', () => {
    const { clock, engine, store, music, live } = setup();
    for (let i = 0; i < 4; i++) { live.tap(); clock.advance(0.6); }
    expect(store.get('global.tempo')).toBe(100);
    live.setPad(0, { type: 'note', track: 0, notes: [60], label: 'C', color: '#3fd0c9' });
    live.press(0);
    music.transport.play();
    clock.advance(0.3);
    live.setPad(1, { type: 'mute', track: 0, label: 'M', color: '#3fd0c9', quant: 'bar' });
    live.press(1);
    live.panic();
    expect(live.queued()).toEqual([]);
    expect(engine.offs(0).some(e => e.note === 60)).toBe(true);
    expect(engine.of('panic').length + engine.of('allOff').length).toBeGreaterThan(0);
  });
});

describe('keys, lock and MIDI', () => {
  it('maps 1 to 0 and Q to Y to the 16 pads, Space, arrows and Esc', () => {
    const key = (code, key = '', mods = {}) => liveKeyAction({ code, key, ...mods });
    expect(PAD_CODES).toHaveLength(16);
    expect(key('Digit1', '1')).toEqual({ kind: 'pad', index: 0 });
    expect(key('Digit0', '0')).toEqual({ kind: 'pad', index: 9 });
    expect(key('KeyQ', 'q')).toEqual({ kind: 'pad', index: 10 });
    expect(key('KeyY', 'y')).toEqual({ kind: 'pad', index: 15 });
    expect(key('KeyU', 'u')).toBe(null);
    expect(key('KeyP', 'p')).toBe(null);
    expect(key('Space', ' ')).toEqual({ kind: 'play' });
    expect(key('ArrowRight', 'ArrowRight')).toEqual({ kind: 'next' });
    expect(key('ArrowLeft', 'ArrowLeft')).toEqual({ kind: 'prev' });
    expect(key('Escape', 'Escape')).toEqual({ kind: 'exit' });
    expect(key('KeyL', 'L', { shiftKey: true })).toEqual({ kind: 'exit' });
    expect(key('KeyZ', 'z', { metaKey: true })).toBe(null);
    expect(key('Digit1', '!', { shiftKey: true })).toBe(null);
  });

  it('the lock lets only the pads and the unlock control take clicks', () => {
    const el = (safe) => ({ closest: (sel) => (sel === '[data-live-safe]' && safe ? {} : null) });
    expect(lockBlocks(el(false), false)).toBe(false);
    expect(lockBlocks(el(false), true)).toBe(true);
    expect(lockBlocks(el(true), true)).toBe(false);
    expect(lockBlocks({ parentElement: el(true) }, true)).toBe(false);   // a text node inside a pad
    expect(lockBlocks(null, true)).toBe(true);
  });

  it('pads, Next, Previous and Play are MIDI-learnable and the mappings persist', async () => {
    expect(LEARNABLE_ACTIONS.slice(0, 6)).toEqual(['looper.main', 'looper.stop', 'looper.undo', 'looper.clear', 'looper.mute', 'looper.resample']);
    for (const id of LIVE_ACTIONS) expect(LEARNABLE_ACTIONS).toContain(id);
    expect(liveMidiAction('live.pad16')).toEqual({ kind: 'pad', index: 15 });
    expect(liveMidiAction('live.pad17')).toBe(null);
    expect(liveMidiAction('live.next')).toEqual({ kind: 'next' });
    expect(liveMidiAction('looper.main')).toBe(null);
    const clock = createFakeClock({ startSec: 1 });
    const storage = createMemoryStorage();
    const store = createStore(defaultState());
    const input = fakeInput('in-1', 'Pads', 'Acme');
    const access = fakeAccess({ inputs: [input], outputs: [fakeOutput('out-1', 'Pads', 'Acme')] });
    const midi = await createMidi({ store, router: null, navigator: fakeNavigator(access, { permission: 'granted' }), storage, secure: true, perfNow: clock.perfNow, timers: clock.timers });
    const fired = [];
    midi.on('action', (e) => fired.push(e.id));
    const p = midi.learn({ scope: 'action', id: 'live.pad3' });
    input.fire([0xb0, 20, 127]);
    await p;
    input.fire([0xb0, 20, 0]);
    const q = midi.learn({ scope: 'action', id: 'live.next' });
    input.fire([0xb0, 21, 127]);
    await q;
    input.fire([0xb0, 21, 0]);
    input.fire([0xb0, 20, 127]);
    input.fire([0xb0, 21, 127]);
    expect(fired).toEqual(['live.pad3', 'live.next']);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)).mappings.map(m => m.target.id)).toEqual(['live.pad3', 'live.next']);
    const again = await createMidi({ store, router: null, navigator: fakeNavigator(fakeAccess()), storage });
    expect(again.mappings()).toEqual([{ cc: 20, channel: 1, target: { scope: 'action', id: 'live.pad3' } }, { cc: 21, channel: 1, target: { scope: 'action', id: 'live.next' } }]);
  });
});

describe('screen wake lock and full screen', () => {
  function fakeDoc() {
    const handlers = new Set();
    return {
      visibilityState: 'visible', fullscreenElement: null,
      addEventListener: (t, fn) => { if (t === 'visibilitychange') handlers.add(fn); },
      removeEventListener: (t, fn) => handlers.delete(fn),
      fire() { for (const fn of [...handlers]) fn(); },
      handlers,
    };
  }
  function fakeNav() {
    const calls = { requested: 0, released: 0 };
    const nav = { wakeLock: { request: async () => {
      calls.requested++;
      const listeners = [];
      const s = { released: false, addEventListener: (t, fn) => listeners.push(fn), release: async () => { s.released = true; calls.released++; listeners.forEach(fn => fn()); } };
      nav.last = s;
      return s;
    } } };
    return { nav, calls };
  }

  it('asks on enter, asks again when the page is visible again, lets go on exit', async () => {
    const { createWakeLock } = await import('../../src/live/wake.js');
    const doc = fakeDoc();
    const { nav, calls } = fakeNav();
    const w = createWakeLock({ nav, doc });
    expect(await w.acquire()).toBe(true);
    expect(w.held()).toBe(true);
    // the browser drops the lock when the page is hidden
    await nav.last.release();
    expect(w.held()).toBe(false);
    doc.visibilityState = 'visible';
    doc.fire();
    await Promise.resolve(); await Promise.resolve();
    expect(calls.requested).toBe(2);
    expect(w.held()).toBe(true);
    w.release();
    expect(w.held()).toBe(false);
    expect(doc.handlers.size).toBe(0);
  });

  it('fails quietly where there is no wake lock or full screen', async () => {
    const { createWakeLock, enterFullscreen } = await import('../../src/live/wake.js');
    const w = createWakeLock({ nav: {}, doc: fakeDoc() });
    expect(w.supported).toBe(false);
    expect(await w.acquire()).toBe(false);
    w.release();
    const refused = createWakeLock({ nav: { wakeLock: { request: async () => { throw new Error('NotAllowedError'); } } }, doc: fakeDoc() });
    expect(await refused.acquire()).toBe(false);
    expect(await enterFullscreen({}, fakeDoc())).toBe(false);
    expect(await enterFullscreen({ requestFullscreen: async () => { throw new Error('no'); } }, fakeDoc())).toBe(false);
    const doc = fakeDoc();
    const el = { requestFullscreen: async () => { doc.fullscreenElement = el; } };
    expect(await enterFullscreen(el, doc)).toBe(true);
  });
});
