import { describe, it, expect } from 'vitest';
import { check, compose, schema } from '../../src/music/score.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const EXAMPLE = `title Paced
bpm 156
bars 4
beats 4
key A
mode minor

violin A4 0 0.5 0.8
piano C3 0 2 0.7
kick x 0 0.2 1
hat x 0.5 0.08 0.4
`;

function setup() {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

describe('score contract', () => {
  it('checks the skill example and returns a receipt in seconds', () => {
    const r = check(EXAMPLE);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.noteCount).toBe(4);
    expect(r.durationSeconds).toBeCloseTo(4 * 4 * 60 / 156, 2);
    expect(r.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(check(r.text).hash).toBe(r.hash);
    expect(r.score.notes.find((n) => n.voice === 'kick').midi).toBe(36);
    expect(r.score.notes.find((n) => n.voice === 'hat').midi).toBe(38);
  });

  it('names the fix for a bad line and does not invent a voice', () => {
    const r = check('violin C 0 1 0.8\nzither A4 0 1 0.8\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0].fix).toMatch(/C4/);
    expect(r.errors[1].message).toMatch(/zither/);
  });

  it('treats C5 as a note and Cmaj as a chord', () => {
    const note = check('title T\nbpm 120\nbars 1\npiano C5 0 1 0.8\n');
    expect(note.ok).toBe(true);
    expect(note.score.notes.map((n) => n.midi)).toEqual([72]);
    const chord = check('title T\nbpm 120\nbars 1\npiano Cmaj 0 1 0.8\n');
    expect(chord.ok).toBe(true);
    expect(chord.score.notes.map((n) => n.midi)).toEqual([48, 52, 55]);
  });

  it('opens a hat when the hat is 0.2 quarters or longer', () => {
    const r = check('title T\nbpm 120\nbars 1\nhat x 0 0.2 0.5\n');
    expect(r.score.notes[0].midi).toBe(39);
  });

  it('puts picture cues on a clock', () => {
    const r = check('title T\nbpm 180\nbars 4\ncue title 4\nviolin A5 4 1 0.8\n');
    expect(r.ok).toBe(true);
    expect(r.cues).toEqual([{ name: 'title', beat: 4, seconds: 1.333 }]);
  });

  it('writes an opening with the hits a picture needs', () => {
    const r = compose({ prompt: 'anime opening at 180 bpm in D minor, 8 bars' });
    expect(r.ok).toBe(true);
    expect(r.score.bpm).toBe(180);
    expect(r.score.key).toBe('D');
    expect(r.score.mode).toBe('minor');
    expect(r.score.style).toBe('opening');
    expect(r.cues.map((c) => c.name)).toEqual(['cold', 'card-1', 'card-2', 'card-3', 'hits', 'title']);
    expect(r.durationSeconds).toBeCloseTo(8 * 4 * 60 / 180, 2);
    expect(r.score.notes.filter((n) => n.voice === 'kick').length).toBeGreaterThanOrEqual(8);
    const quiet = compose('sparse, no drums, 4 bars');
    expect(quiet.ok).toBe(true);
    expect(quiet.score.notes.some((n) => n.family === 'drum')).toBe(false);
  });

  it('rejects a note that runs off the end of the picture', () => {
    const r = check('title T\nbpm 120\nbars 1\nviolin A4 3 2 0.8\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0].field).toBe('length');
  });

  it('lists the live voices from schema()', () => {
    const s = schema();
    expect(s.voices).toContain('violin');
    expect(s.aliases.tpt).toBe('trumpet');
    expect(s.http).toBeNull();
    expect(s.styles.opening).toMatch(/title/);
  });
});

describe('score desk', () => {
  it('plays a score and puts the tracks back', () => {
    const { clock, engine, store, music } = setup();
    store.set('parts.0.params.cutoff', 1234);
    const before = store.get('parts.0.name');
    const r = music.score.play('title T\nbpm 120\nbars 1\nviolin A4 0 1 0.8\nkick x 0 0.2 1\n');
    expect(r.ok).toBe(true);
    expect(r.voices.find((v) => v.voice === 'violin').part).toBe(0);
    expect(r.voices.find((v) => v.voice === 'kick').part).toBe(3);
    expect(store.get('parts.0.params.cutoff')).toBe(7000);
    expect(store.get('parts.3.drum.on')).toBe(1);
    clock.advance(3);
    const ons = engine.ons();
    const offs = engine.offs();
    expect(ons.some((e) => e.note === 69 && e.part === 0)).toBe(true);
    expect(ons.some((e) => e.note === 36 && e.part === 3)).toBe(true);
    expect(offs.filter((e) => e.note === 69).length).toBe(1);
    music.score.stop();
    expect(store.get('parts.0.params.cutoff')).toBe(1234);
    expect(store.get('parts.0.name')).toBe(before);
    expect(store.get('parts.3.drum.on')).toBe(0);
    expect(music.score.playing()).toBe(false);
  });

  it('does not play a score that failed the check', () => {
    const { engine, music } = setup();
    const r = music.score.play('nope');
    expect(r.ok).toBe(false);
    expect(engine.events.length).toBe(0);
    expect(music.score.playing()).toBe(false);
  });

  it('compose leaves a score that play() can run', () => {
    const { clock, engine, music } = setup();
    const wrote = music.score.compose({ style: 'sparse', key: 'D', mode: 'minor', bars: 2 });
    expect(wrote.ok).toBe(true);
    expect(music.score.getScore()).toContain('style sparse');
    const played = music.score.play();
    expect(played.ok).toBe(true);
    clock.advance(played.durationSeconds + 1);
    expect(engine.ons().length).toBeGreaterThan(0);
    music.score.stop();
  });
});
