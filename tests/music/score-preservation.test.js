import { describe, it, expect } from 'vitest';
import { createStore, deepClone } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createHistory } from '../../src/core/history.js';
import { createVersions, memoryBackend } from '../../src/core/versions.js';
import { createMusic } from '../../src/music/music.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup() {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(defaultState());
  store.set('global.tempo', 96);
  store.set('parts.0.params.cutoff', 1234);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

const score = 'title Keep edits\nbpm 120\nbars 1\nviolin A4 0 1 0.8\n';
const edit = { source: 'ui' };
const addedScore = `${score}${['viola', 'cello', 'flute', 'horn'].map((v) => `${v} C4 0 1 0.5`).join('\n')}\n`;

describe('score-safe history and versions', () => {
  it('keeps two settled edits undoable without reviving score tracks or tempo', () => {
    const { clock, store, music } = setup();
    const before = store.serialize();
    const history = createHistory(store, { timers: clock.timers, filter: (state) => music.score.cleanState(state) });
    music.score.play(addedScore);
    store.set('parts.0.params.cutoff', 2300, edit);
    clock.advance(0.4);
    store.set('parts.0.patterns.0.name', 'Second settled edit', edit);
    clock.advance(0.4);
    const first = deepClone(before);
    first.parts[0].params.cutoff = 2300;
    const second = deepClone(first);
    second.parts[0].patterns[0].name = 'Second settled edit';
    expect(history.undo()).toBeTruthy();
    expect(music.score.status()).toMatchObject({ playing: false, restoring: false });
    expect(store.serialize()).toEqual(first);
    history.undo();
    expect(store.serialize()).toEqual(before);
    history.redo();
    expect(store.serialize()).toEqual(first);
    history.redo();
    expect(store.serialize()).toEqual(second);
    history.dispose();
    music.dispose();
  });

  it('saves ordinary edits in named and automatic versions without temporary score state', async () => {
    const { clock, store, music } = setup();
    const before = store.serialize();
    const versions = createVersions({
      store, backend: memoryBackend(), timers: clock.timers, now: () => clock.now() * 1000,
      quietMs: 100, maxMs: 1000, filter: (state) => music.score.cleanState(state),
    });
    await versions.ready;
    music.score.play(addedScore);
    clock.advance(0.11);
    await versions.store.settled();
    expect(versions.list()).toHaveLength(0);
    store.set('parts.0.patterns.0.name', 'Saved during score', edit);
    clock.advance(0.11);
    await versions.store.settled();
    const automatic = versions.list()[0];
    expect(automatic.kind).toBe('auto');
    const expected = deepClone(before);
    expected.parts[0].patterns[0].name = 'Saved during score';
    expect(await versions.get(automatic.id)).toEqual(expected);
    const named = await versions.saveNamed('During score');
    expect(await versions.get(named.id)).toEqual(expected);
    expect(store.get('parts')).toHaveLength(5);
    expect(music.score.playing()).toBe(true);
    versions.dispose();
    music.dispose();
  });

  it('returns from version preview to live edits without resurrecting a score', async () => {
    const { clock, store, music } = setup();
    const before = store.serialize();
    const versions = createVersions({
      store, backend: memoryBackend(), timers: clock.timers, now: () => clock.now() * 1000,
      filter: (state) => music.score.cleanState(state),
    });
    await versions.ready;
    const old = await versions.saveNamed('Before score');
    music.score.play(addedScore);
    store.set('parts.0.params.cutoff', 2800, edit);
    const expected = deepClone(before);
    expected.parts[0].params.cutoff = 2800;
    await versions.preview(old.id);
    expect(store.serialize()).toEqual(before);
    expect(music.score.status()).toMatchObject({ playing: false, restoring: false });
    store.set('parts.0.params.cutoff', 3300, edit);
    expect(versions.goBack()).toBe(true);
    expect(store.serialize()).toEqual(expected);
    versions.dispose();
    music.dispose();
  });
});

describe('score restoration preserves live edits', () => {
  it.each(['stop', 'end'])('preserves ordinary edits on %s and reverts only untouched score fields', (finish) => {
    const { clock, store, music } = setup();
    store.set('parts.2.params.solo', 1);
    const before = store.serialize();
    music.score.play(score);
    store.set('parts.0.name', 'My lead', edit);
    store.set('parts.0.params.cutoff', 2400, edit);       // changed by the score
    store.set('parts.0.params.centerX', 0.17, edit);     // untouched by tint voicing
    store.set('parts.0.patterns.0.steps.0.on', 1, edit);
    store.set('parts.0.seqOn', 1, edit);
    store.set('parts.2.patterns.0.name', 'Edited while solo was borrowed', edit);
    store.set('global.tempo', 144, edit);
    const expected = deepClone(before);
    expected.parts[0].name = 'My lead';
    expected.parts[0].params.cutoff = 2400;
    expected.parts[0].params.centerX = 0.17;
    expected.parts[0].patterns[0].steps[0].on = 1;
    expected.parts[0].seqOn = 1;
    expected.parts[2].patterns[0].name = 'Edited while solo was borrowed';
    expected.global.tempo = 144;
    if (finish === 'stop') music.score.stop();
    else clock.advance(5);
    expect(music.score.borrowing()).toBe(false);
    expect(store.serialize()).toEqual(expected);
    music.dispose();
  });

  it('keeps edits made after the last note, during release tails', () => {
    const { clock, store, music } = setup();
    const attack = store.get('parts.0.params.attack');
    music.score.play(score);
    clock.advance(2.2);
    expect(music.score.status()).toMatchObject({ playing: false, restoring: true });
    store.set('parts.0.params.cutoff', 3000, edit);
    store.set('parts.0.patterns.0.name', 'Tail edit', edit);
    store.set('global.tempo', 150, edit);
    clock.advance(3);
    expect(store.get('parts.0.params.cutoff')).toBe(3000);
    expect(store.get('parts.0.patterns.0.name')).toBe('Tail edit');
    expect(store.get('parts.0.params.attack')).toBe(attack);
    expect(store.get('global.tempo')).toBe(150);
    music.dispose();
  });

  it('cleans autosave without discarding edits or mutating the live session', () => {
    const { store, music } = setup();
    const before = store.serialize();
    music.score.play(addedScore);
    expect(store.get('parts')).toHaveLength(5);
    store.set('parts.0.name', 'Saved lead', edit);
    store.set('parts.0.patterns.0.steps.3.vel', 0.42, edit);
    store.set('parts.0.params.cutoff', 3100, edit);
    store.set('global.tempo', 160, edit);
    const live = store.serialize();
    const expected = deepClone(before);
    expected.parts[0].name = 'Saved lead';
    expected.parts[0].patterns[0].steps[3].vel = 0.42;
    expected.parts[0].params.cutoff = 3100;
    expected.global.tempo = 160;
    const saved = music.score.cleanState(live);
    expect(saved).toEqual(expected);
    expect(live).toEqual(store.serialize());
    expect(store.get('parts')).toHaveLength(5);
    music.score.stop();
    expect(store.serialize()).toEqual(saved);
    music.dispose();
  });

  it('keeps deliberate edits changed back to the score-applied value', () => {
    const { store, music } = setup();
    music.score.play(score);
    expect(store.get('parts.0.params.cutoff')).toBe(7000);
    store.set('parts.0.params.cutoff', 1800, edit);
    store.set('parts.0.params.cutoff', 7000, edit);
    store.set('global.tempo', 130, edit);
    store.set('global.tempo', 120, edit);
    expect(music.score.cleanState(store.serialize()).parts[0].params.cutoff).toBe(7000);
    music.score.stop();
    expect(store.get('parts.0.params.cutoff')).toBe(7000);
    expect(store.get('global.tempo')).toBe(120);
    music.dispose();
  });

  it('relinquishes all fields in an explicitly replaced params object', () => {
    const { store, music } = setup();
    const name = store.get('parts.0.name');
    music.score.play(score);
    const params = { ...store.get('parts.0.params'), level: 0.25 };
    store.set('parts.0.params', params, edit);
    music.score.stop();
    expect(store.get('parts.0.params')).toEqual(params);  // same-valued cutoff was intentionally kept
    expect(store.get('parts.0.name')).toBe(name);
    expect(store.get('global.tempo')).toBe(96);
    music.dispose();
  });

  it('preserves a whole-track replacement, including same-valued score fields', () => {
    const { store, music } = setup();
    music.score.play(score);
    const replacement = deepClone(store.get('parts.0'));
    replacement.patchName = 'My edited patch';
    store.set('parts.0', replacement, { source: 'preset' });
    expect(music.score.cleanState(store.serialize()).parts[0]).toEqual(replacement);
    music.score.stop();
    expect(store.get('parts.0')).toEqual(replacement);
    music.dispose();
  });

  it('preserves edited tracks by stable id when the list is reordered', () => {
    const { store, music } = setup();
    const id = store.get('parts.0.id');
    const attack = store.get('parts.0.params.attack');
    music.score.play(score);
    store.set('parts.0.params.cutoff', 2100, edit);
    store.set('parts.0.patterns.0.name', 'Moves with my track', edit);
    store.set('parts', store.get('parts').slice().reverse(), { source: 'tracks' });
    expect(music.score.playing()).toBe(false);
    const moved = store.get('parts').find((p) => p.id === id);
    expect(moved.params.cutoff).toBe(2100);
    expect(moved.patterns[0].name).toBe('Moves with my track');
    expect(moved.params.attack).toBe(attack);
    music.dispose();
  });

  it('attributes a batched parent edit to its original track before a reorder', () => {
    const { store, music } = setup();
    const id = store.get('parts.0.id');
    music.score.play(score);
    const params = { ...store.get('parts.0.params'), level: 0.25 };
    store.batch(() => {
      store.set('parts.0.params', params, edit);
      store.set('parts', store.get('parts').slice().reverse(), { source: 'tracks' });
    });
    expect(music.score.playing()).toBe(false);
    expect(store.get('parts').find((p) => p.id === id).params).toEqual(params);
    music.dispose();
  });

  it('releases a held score note on its moved track without cutting another held note', () => {
    const { clock, engine, store, music } = setup();
    const scoreId = store.get('parts.0.id');
    const otherId = store.get('parts.3.id');
    music.router.noteOn(3, 69, 0.6, { source: 'keyboard' });
    music.score.play('bpm 120\nbars 2\nviolin A4 0 8 0.8\nviolin B4 2 1 0.8\n');
    clock.advance(0.1);
    expect(engine.ons(0).map((e) => e.note)).toEqual([69]);
    engine.clear();
    store.set('parts', store.get('parts').slice().reverse(), { source: 'tracks' });
    const moved = store.get('parts').findIndex((p) => p.id === scoreId);
    const other = store.get('parts').findIndex((p) => p.id === otherId);
    expect(engine.offs().map((e) => ({ part: e.part, note: e.note }))).toEqual([{ part: moved, note: 69 }]);
    expect([...music.router.heldNotes(other)]).toEqual([69]);
    clock.advance(2);
    expect(engine.ons()).toHaveLength(0);     // no later score callback fires
    expect(engine.offs(other)).toHaveLength(0);
    expect(music.score.borrowing()).toBe(false);
    music.dispose();
  });

  it('skips the removed score track instead of sending its note-off to the shifted track', () => {
    const { clock, engine, store, music } = setup();
    const otherId = store.get('parts.1.id');
    music.router.noteOn(1, 69, 0.6, { source: 'keyboard' });
    music.score.play('bpm 120\nbars 2\nviolin A4 0 8 0.8\n');
    clock.advance(0.1);
    engine.clear();
    store.set('parts', store.get('parts').slice(1), { source: 'tracks' });
    expect(store.get('parts.0.id')).toBe(otherId);
    expect([...music.router.heldNotes(0)]).toEqual([69]);
    expect(engine.offs()).toHaveLength(0);    // engine track removal releases its own voices
    expect(music.score.status()).toMatchObject({ playing: false, restoring: false });
    clock.advance(2);
    expect(engine.ons()).toHaveLength(0);
    music.dispose();
  });

  it('round-trips optional fields, arrays and patch voicing when there are no edits', () => {
    const { store, music } = setup();
    store.set('parts.0.smart', { name: 'Original optional field', values: [0.1, 0.2] });
    store.set('parts.0.mods.cutoff.steps', Array(32).fill(0.25));
    store.set('parts.0.mods.cutoff.lfoDepth', 0.6);
    store.set('parts.0.userTerrain.A', { name: 'Original land', data: 'AA==' });
    const before = store.serialize();
    music.score.play(`${score}voicing patch\n`);
    expect(store.get('parts.0.smart')).toBeUndefined();
    expect(music.score.cleanState(store.serialize())).toEqual(before);
    music.score.stop();
    expect(store.serialize()).toEqual(before);
    music.dispose();
  });

  it('leaves tempo unowned while the sequencer is playing', () => {
    const { store, music } = setup();
    music.transport.play();
    music.score.play(score);
    expect(store.get('global.tempo')).toBe(96);
    store.set('global.tempo', 132, edit);
    expect(music.score.cleanState(store.serialize()).global.tempo).toBe(132);
    music.score.stop();
    expect(store.get('global.tempo')).toBe(132);
    music.dispose();
  });

  it('keeps repeated playback edits and abandons ownership on session load', () => {
    const { store, music } = setup();
    for (const cutoff of [2200, 2600, 3200]) {
      music.score.play(score);
      store.set('parts.0.params.cutoff', cutoff, edit);
      music.score.stop();
      expect(store.get('parts.0.params.cutoff')).toBe(cutoff);
    }
    music.score.play(score);
    const next = defaultState();
    next.parts[0].name = 'Loaded session';
    next.global.tempo = 170;
    store.load(next);
    music.score.stop();
    expect(store.serialize()).toEqual(next);
    music.dispose();
  });
});
