import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, SCALES, SCALE_NAMES, SCALE_NAMES as NAMES } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createPresets } from '../../src/presets/presets.js';
import { PHRASES, adaptDegree, guessCategory, phraseEvents, phraseNote } from '../../src/music/phrases.js';
import { START_DELAY } from '../../src/music/transport.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from './fakes.js';

function setup({ tempo = 120, withPresets = true } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = defaultState();
  s.global.tempo = tempo;
  const store = createStore(s);
  const presets = withPresets ? createPresets({ store, storage: createMemoryStorage() }) : null;
  const music = createMusic({ store, engine, presets, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music, presets };
}

/** Every note-on has exactly one later note-off for the same part and note. */
function balanced(events) {
  const open = new Map();
  for (const e of events.filter(x => x.type === 'on' || x.type === 'off').sort((a, b) => a.time - b.time || (a.type === 'off' ? -1 : 1))) {
    const k = `${e.part}:${e.note}`;
    if (e.type === 'on') open.set(k, (open.get(k) || 0) + 1);
    else {
      if (!open.get(k)) return false;
      open.set(k, open.get(k) - 1);
    }
  }
  return [...open.values()].every(n => n === 0);
}

const inScale = (note, root, scaleType) => {
  const scale = SCALES[SCALE_NAMES[scaleType]];
  return scale.includes(((note - root) % 12 + 12) % 12);
};

describe('phrases', () => {
  it('every category has at least two original phrases that fit in two bars', () => {
    for (const [cat, set] of Object.entries(PHRASES)) {
      expect(set.list.length, cat).toBeGreaterThanOrEqual(2);
      for (const ph of set.list) {
        expect(ph.notes.length, `${cat} ${ph.name}`).toBeGreaterThan(0);
        for (const [beat, , len] of ph.notes) expect(beat + len, `${cat} ${ph.name}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it('keeps triads as triads in five- and six-note scales', () => {
    const pentMin = NAMES.indexOf('Pent Min');
    const triad = [0, 2, 4].map(d => phraseNote(d, 3, 0, pentMin));
    expect(triad.map(n => n - triad[0])).toEqual([0, 3, 7]);
    const pentMaj = NAMES.indexOf('Pent Maj');
    expect([0, 2, 4].map(d => phraseNote(d, 3, 0, pentMaj) - 48)).toEqual([0, 4, 7]);
    const blues = NAMES.indexOf('Blues');
    expect([0, 2, 4].map(d => phraseNote(d, 3, 0, blues) - 48)).toEqual([0, 3, 7]);
    // Seven-note scales are untouched; octaves carry over.
    expect(adaptDegree(9, 1)).toBe(9);
    expect(adaptDegree(7, pentMin)).toBe(5);
    expect(adaptDegree(-1, pentMin)).toBe(-1);
  });

  it('never lets a note overlap itself, in any scale', () => {
    for (let scaleType = 0; scaleType < SCALE_NAMES.length; scaleType++) {
      for (const set of Object.values(PHRASES)) {
        for (const ph of set.list) {
          const ev = phraseEvents(ph, { baseOctave: set.baseOctave, root: 9, scaleType });
          const byNote = new Map();
          for (const e of ev) {
            expect(e.end).toBeGreaterThan(e.beat);
            const prev = byNote.get(e.note);
            if (prev) expect(prev.end, `${ph.name} ${e.note}`).toBeLessThanOrEqual(e.beat + 1e-9);
            byNote.set(e.note, e);
            expect(inScale(e.note, 9, scaleType)).toBe(true);
          }
        }
      }
    }
  });

  it('guesses a category from the sound for unknown patches', () => {
    expect(guessCategory({ attack: 1.2 })).toBe('Pad');
    expect(guessCategory({ attack: 0.001, decay: 3, sustain: 0 })).toBe('Bell');
    expect(guessCategory({ attack: 0.001, decay: 0.4, sustain: 0 })).toBe('Pluck');
    expect(guessCategory({ polyMode: 1, cutoff: 700 })).toBe('Bass');
    expect(guessCategory({ polyMode: 2, cutoff: 5000 })).toBe('Lead');
    expect(guessCategory({})).toBe('Keys');
  });
});

describe('music.preview', () => {
  it('plays an in-key phrase for the patch category and releases every note', () => {
    const { clock, engine, store, music, presets } = setup();
    presets.loadPatch(0, 'Basalt Bass');
    const seen = [];
    music.on('preview', e => seen.push(e));
    const info = music.preview('sel');
    expect(info).toMatchObject({ part: 0, playing: true, category: 'Bass', phrase: 'Pocket' });
    expect(seen[0]).toMatchObject({ playing: true, category: 'Bass' });
    clock.advance(info.duration + 0.5);
    const ons = engine.ons(0);
    expect(ons.length).toBe(16);
    // A minor (the default key): every note in the scale, and bass register.
    for (const e of ons) {
      expect(inScale(e.note, store.get('global.scaleRoot'), store.get('global.scaleType'))).toBe(true);
      expect(e.note).toBeLessThan(60);
    }
    expect(balanced(engine.events)).toBe(true);
    expect(seen[seen.length - 1]).toMatchObject({ playing: false, reason: 'end' });
    expect(music.isPreviewing()).toBe(false);
  });

  it('follows the tempo: notes land on the beat grid of the set tempo', () => {
    const { clock, engine, music } = setup({ tempo: 90 });
    const t0 = clock.ctx.currentTime;
    music.preview(1, { category: 'Bass', phrase: 'Stepping' });
    clock.advance(6);
    const ons = engine.ons(1);
    expect(ons.length).toBe(8);
    const spb = 60 / 90;
    ons.forEach((e, i) => expect(e.time - ons[0].time).toBeCloseTo(i * spb, 6));
    expect(ons[0].time).toBeGreaterThan(t0);
    expect(ons[0].time - t0).toBeLessThan(0.1);
  });

  it('starts on the next beat of the running sequencer', () => {
    const { clock, engine, store, music } = setup({ tempo: 120 });
    store.set('parts.0.seqOn', 1);
    const t0 = clock.ctx.currentTime;
    music.transport.play();
    clock.advance(0.7);
    engine.clear();
    const info = music.preview(2, { category: 'Keys', phrase: 'Comp' });
    // Beat 0 is at t0 + START_DELAY; beats are 0.5 s apart; we are 0.7 s in, so the next beat is beat 2.
    expect(info.start).toBeCloseTo(t0 + START_DELAY + 1.0, 6);
    clock.advance(5);
    const first = engine.ons(2)[0];
    expect(first.time).toBeCloseTo(t0 + START_DELAY + 1.0, 6);
  });

  it('stops cleanly: sounding notes get a note-off, nothing new starts', () => {
    const { clock, engine, music } = setup();
    const ended = [];
    music.on('preview', e => { if (!e.playing) ended.push(e.reason); });
    music.preview(0, { category: 'Pad', phrase: 'Drift' });
    clock.advance(1);
    expect(engine.ons(0).length).toBe(3);
    expect(engine.offs(0).length).toBe(0);
    music.stopPreview();
    expect(engine.offs(0).length).toBe(3);
    expect(balanced(engine.events)).toBe(true);
    clock.advance(6);
    expect(engine.ons(0).length).toBe(3);
    expect(ended).toEqual(['stop']);
    expect(music.isPreviewing()).toBe(false);
  });

  it('restarts with the next phrase of the category when called again', () => {
    const { clock, engine, music } = setup();
    const a = music.preview(0, { category: 'Lead' });
    clock.advance(0.6);
    const b = music.preview(0, { category: 'Lead' });
    clock.advance(0.6);
    const c = music.preview(0, { category: 'Lead' });
    expect([a.phrase, b.phrase, c.phrase]).toEqual(['Call', 'Climb', 'Glide']);
    clock.advance(6);
    expect(balanced(engine.events)).toBe(true);
  });

  it('a panic or a scene load ends the preview', () => {
    const { clock, engine, store, music } = setup();
    music.preview(0, { category: 'Drone' });
    clock.advance(0.5);
    music.router.allNotesOff();
    expect(music.isPreviewing()).toBe(false);
    expect(balanced(engine.events)).toBe(true);
    music.preview(0, { category: 'Drone' });
    clock.advance(0.5);
    store.load(defaultState());
    expect(music.isPreviewing()).toBe(false);
    expect(balanced(engine.events)).toBe(true);
  });

  it('works without a preset library by guessing the category', () => {
    const { clock, engine, store, music } = setup({ withPresets: false });
    store.set('parts.0.params.attack', 1.5);
    expect(music.previewCategory(0)).toBe('Pad');
    music.preview(0);
    clock.advance(6);
    expect(engine.ons(0).length).toBeGreaterThan(0);
    expect(balanced(engine.events)).toBe(true);
  });

  it('follows key changes and ignores bad parts', () => {
    const { clock, engine, store, music } = setup();
    store.set('global.scaleRoot', 2);
    store.set('global.scaleType', NAMES.indexOf('Pent Maj'));
    expect(music.preview(7)).toBeNull();
    music.preview(3, { category: 'Arp', phrase: 'Climber' });
    clock.advance(6);
    const ons = engine.ons(3);
    expect(ons.length).toBeGreaterThan(20);
    for (const e of ons) expect(inScale(e.note, 2, NAMES.indexOf('Pent Maj'))).toBe(true);
    expect(balanced(engine.events)).toBe(true);
  });

  it('does not schedule while the audio clock is suspended', () => {
    const { clock, engine, music } = setup();
    clock.ctx.state = 'suspended';
    music.preview(0, { category: 'Bell' });
    clock.advanceWall(1);
    expect(engine.ons().length).toBe(0);
    music.stopPreview();
    expect(engine.offs().length).toBe(0);
  });
});
