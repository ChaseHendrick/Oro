// v2.8 Chord trigger (src/music/chord-trigger.js and the note router).
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, SCALE_NAMES } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { ARP } from '../../src/music/router.js';
import { makeRng } from '../../src/music/patterns.js';
import { renderSessionEvents } from '../../src/music/render.js';
import { CHORD_PRESETS, CHORD_LEARNED, chordNotes, sanitizeChord, learnChord } from '../../src/music/chord-trigger.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const MAJOR = SCALE_NAMES.indexOf('Major'), MINOR = SCALE_NAMES.indexOf('Minor');
const C = { root: 0, scaleType: MAJOR };
const chord = (preset, inKey = 0, notes) => sanitizeChord({ on: 1, preset, inKey, notes });

function setup({ chord: ch = null, seq = false } = {}) {
  const clock = createFakeClock({ startSec: 2 });
  const engine = createFakeEngine(clock);
  const s = defaultState();
  s.global.tempo = 120; s.global.scaleRoot = 0; s.global.scaleType = MAJOR;
  if (ch) s.parts[0].chord = ch;
  if (seq) {
    s.parts[0].seqOn = 1;
    Object.assign(s.parts[0].patterns[0].steps[0], { on: 1, degree: 1 });   // D
    Object.assign(s.parts[0].patterns[0].steps[4], { on: 1, degree: 4 });   // G
  }
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow, random: makeRng(7) });
  return { clock, engine, store, music, router: music.router };
}
const notesOf = (evs) => evs.map(e => e.note);

describe('chord trigger: chords', () => {
  it('presets, moved chromatically', () => {
    expect(CHORD_PRESETS.map(p => p.name)).toEqual(['Triad', '7th', 'Sus2', 'Sus4', 'Power', 'Octaves']);
    expect(chordNotes(60, chord(0), C)).toEqual([60, 64, 67]);
    expect(chordNotes(62, chord(1), C)).toEqual([62, 66, 69, 72]);
    expect(chordNotes(60, chord(2), C)).toEqual([60, 62, 67]);
    expect(chordNotes(60, chord(3), C)).toEqual([60, 65, 67]);
    expect(chordNotes(60, chord(4), C)).toEqual([60, 67, 72]);
    expect(chordNotes(60, chord(5), C)).toEqual([60, 72]);
    expect(chordNotes(125, chord(0), C)).toEqual([125]);          // nothing above 127
  });

  it('In key: built from the scale, so the chord quality follows the note', () => {
    expect(chordNotes(62, chord(0, 1), C)).toEqual([62, 65, 69]);       // D minor
    expect(chordNotes(67, chord(1, 1), C)).toEqual([67, 71, 74, 77]);   // G7
    expect(chordNotes(71, chord(0, 1), C)).toEqual([71, 74, 77]);       // B diminished
    expect(chordNotes(64, chord(0, 1), { root: 9, scaleType: MINOR })).toEqual([64, 67, 71]);  // E minor in A minor
    expect(chordNotes(64, chord(3, 1), C)).toEqual([64, 69, 71]);       // E sus4 in key: E A B
    expect(chordNotes(62, chord(4, 1), C)).toEqual([62, 69, 74]);
    // a note outside the scale keeps its offset from the scale note below it
    expect(chordNotes(61, chord(0, 1), C)).toEqual([61, 65, 68]);
  });

  it('learns a chord from held keys and plays it on any key, in key too', () => {
    const notes = learnChord([67, 60, 71, 64]);
    expect(notes).toEqual([0, 4, 7, 11]);
    expect(learnChord([])).toBe(null);
    expect(chordNotes(62, chord(CHORD_LEARNED, 0, notes), C)).toEqual([62, 66, 69, 73]);
    expect(chordNotes(62, chord(CHORD_LEARNED, 1, notes), C)).toEqual([62, 65, 69, 72]);   // Dm7 in C major
  });

  it('sanitizes saved settings, and sessions without it stay without it', () => {
    expect(sanitizeChord(null)).toEqual({ on: 0, preset: 0, inKey: 0, notes: [0, 4, 7] });
    expect(sanitizeChord({ on: 1, preset: 99, inKey: 2, notes: [7, 3, 'x', 3, 200] })).toEqual({ on: 1, preset: CHORD_LEARNED, inKey: 1, notes: [0, 3, 7] });
    const st = defaultState(2);
    st.parts[1].chord = { on: 1, preset: 1, inKey: 1, notes: [0, 4, 7] };
    const m = migrateState(JSON.parse(JSON.stringify(st)));
    expect(m.parts[0]).not.toHaveProperty('chord');
    expect(m.parts[1].chord).toEqual({ on: 1, preset: 1, inKey: 1, notes: [0, 4, 7] });
    expect(migrateState(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
});

describe('chord trigger: note router', () => {
  it('off (or absent) leaves every note exactly as before', () => {
    const play = (ch) => {
      const { clock, engine, router, music } = setup({ chord: ch, seq: true });
      router.noteOn('sel', 60, 0.7); router.noteOn('sel', 64, 0.6); router.noteOff('sel', 60); router.noteOff('sel', 64);
      music.transport.play(); clock.advance(2.2); music.transport.stop();
      return engine.events.slice();
    };
    const ref = play(null);
    expect(ref.length).toBeGreaterThan(8);
    expect(play({ on: 0, preset: 3, inKey: 1, notes: [0, 5] })).toEqual(ref);
  });

  it('keys and MIDI play the chord, and release exactly what they started', () => {
    const { engine, router, store } = setup({ chord: { on: 1, preset: 0, inKey: 1 } });
    router.noteOn('sel', 62, 0.8, 'midi');
    expect(notesOf(engine.ons())).toEqual([62, 65, 69]);
    store.set('parts.0.chord.preset', 5);           // the chord changes while the key is down
    router.noteOff('sel', 62, 'midi');
    expect(notesOf(engine.offs()).sort()).toEqual([62, 65, 69]);
  });

  it('two keys sharing chord notes each hold them', () => {
    const { engine, router } = setup({ chord: { on: 1, preset: 0, inKey: 1 } });
    router.noteOn('sel', 60);   // C E G
    router.noteOn('sel', 64);   // E G B
    engine.clear();
    router.noteOff('sel', 60);
    expect(notesOf(engine.offs())).toEqual([60]);
    router.noteOff('sel', 64);
    expect(notesOf(engine.offs()).sort()).toEqual([60, 64, 67, 71]);
  });

  it('the sequencer plays the chord on every step (offline renders too)', () => {
    const { clock, engine, music, store } = setup({ chord: { on: 1, preset: 0, inKey: 1 }, seq: true });
    music.transport.play(); clock.advance(1.0); music.transport.stop();
    const ons = engine.ons(0);
    expect(notesOf(ons.slice(0, 3))).toEqual([50, 53, 57]);   // D3 minor
    expect(new Set(ons.slice(0, 3).map(e => e.time)).size).toBe(1);
    expect(notesOf(ons.slice(3, 6))).toEqual([55, 59, 62]);   // G3 major
    const offs = engine.offs(0).filter(e => [50, 53, 57].includes(e.note));
    expect(offs.length).toBeGreaterThanOrEqual(3);
    const evs = renderSessionEvents(store, 1, { parts: [0] }).filter(e => e.msg.t === 'noteOn');
    expect(evs.slice(0, 3).map(e => e.msg.note)).toEqual([50, 53, 57]);
  });

  it('the arpeggiator steps through the chord of the key it holds', () => {
    const { clock, engine, router, store } = setup({ chord: { on: 1, preset: 0, inKey: 0 } });
    store.set('parts.0.arp', { ...store.get('parts.0.arp'), mode: ARP.UP, rate: 3 });
    router.noteOn('sel', 60);
    clock.advance(0.6);
    expect(notesOf(engine.ons().slice(0, 4))).toEqual([60, 64, 67, 60]);
  });

  it('remembers the keys physically held (for Learn), and ignores drum kit tracks', () => {
    const { engine, router, store } = setup({ chord: { on: 1, preset: 0 } });
    router.noteOn('sel', 64); router.noteOn('sel', 60); router.noteOn('sel', 67);
    expect(router.rawHeld(0)).toEqual([60, 64, 67]);
    router.allNotesOff();
    expect(router.rawHeld(0)).toEqual([]);
    store.set('parts.0.drum.on', 1);
    engine.clear();
    router.noteOn('sel', 36);
    expect(notesOf(engine.ons())).toEqual([36]);
  });
});
