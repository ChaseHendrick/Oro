// v2.9 Standard MIDI Files: export from the sequencers, import into a pattern.
import { describe, it, expect } from 'vitest';
import { writeMidi, parseMidi, exportMidi, midiChoices, notesToPattern, noteToDegree, importMidiNotes, PPQ, DRUM_CHANNEL } from '../../src/music/midi-file.js';
import { createStore } from '../../src/core/store.js';
import { createHistory } from '../../src/core/history.js';
import { renderSessionEvents } from '../../src/music/render.js';
import { createPresets } from '../../src/presets/presets.js';
import { createMemoryStorage } from './fakes.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import { defaultState, defaultStep, stepToMidi, SCALE_NAMES, SEQ_STEPS } from '../../src/core/params.js';

const MINOR = SCALE_NAMES.indexOf('Minor');

function session({ swing = 0, tempo = 112 } = {}) {
  const s = defaultState();
  s.global.tempo = tempo;
  s.global.swing = swing;
  s.global.scaleRoot = 9;
  s.global.scaleType = MINOR;
  return s;
}

/** A melodic pattern of canonical in-scale steps (degree within one octave, no accent/slide/prob). */
function melodic(s, part = 0) {
  const pat = s.parts[part].patterns[0];
  pat.rate = 3; pat.length = 16; pat.baseOctave = 3;
  pat.steps = Array.from({ length: SEQ_STEPS }, (_, i) => (i % 3 === 2 ? defaultStep() : {
    ...defaultStep(), on: 1, degree: (i * 5) % 7, octave: (i % 5) - 2, vel: 0.3 + (i % 7) * 0.1, gate: 0.2 + (i % 4) * 0.2,
  }));
  return pat;
}

const chunks = (b) => {
  const out = [];
  for (let p = 0; p + 8 <= b.length;) {
    const type = String.fromCharCode(...b.subarray(p, p + 4));
    const len = (b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7];
    out.push({ type, len, data: b.subarray(p + 8, p + 8 + len) });
    p += 8 + len;
  }
  return out;
};

describe('writing', () => {
  it('writes a type 1 header, 480 PPQ, the tempo and track names', () => {
    const bytes = writeMidi({ bpm: 125, name: 'Song', tracks: [{ name: 'Bass', channel: 2, notes: [{ tick: 0, dur: 240, note: 40, vel: 100 }] }] });
    const c = chunks(bytes);
    expect(c.map(x => x.type)).toEqual(['MThd', 'MTrk', 'MTrk']);
    expect([...c[0].data]).toEqual([0, 1, 0, 2, (PPQ >> 8) & 255, PPQ & 255]);
    const m = parseMidi(bytes);
    expect(m.format).toBe(1);
    expect(m.ppq).toBe(480);
    expect(m.bpm).toBeCloseTo(125, 6);
    expect(m.tracks.map(t => t.name)).toEqual(['Song', 'Bass']);
    expect(m.tracks[1].notes).toEqual([expect.objectContaining({ tick: 0, dur: 240, note: 40, vel: 100, ch: 2, beat: 0, beats: 0.5 })]);
  });
});

describe('export', () => {
  it('one pass of the selected pattern, notes on the step grid, even with the sequencer off', () => {
    const s = session();
    const pat = melodic(s);
    s.parts[0].seqOn = 0;
    const res = exportMidi(s, { mode: 'pattern', part: 0 });
    const m = parseMidi(res.bytes);
    const notes = m.tracks[1].notes;
    const on = pat.steps.filter(x => x.on);
    expect(res.notes).toBe(on.length);
    expect(notes.length).toBe(on.length);
    expect(m.tracks[1].name).toBe(`${s.parts[0].name}, ${pat.name}`);
    for (const n of notes) expect(n.tick % 120).toBe(0);
    notes.forEach((n, k) => expect(n.note).toBe(stepToMidi(on[k], 3, 9, MINOR)));
    expect(notes.every(n => n.ch === 0)).toBe(true);
  });

  it('timing follows the bounce: swing, ratchets and probability', () => {
    const s = session({ swing: 0.4 });
    const pat = s.parts[0].patterns[0];
    pat.steps = pat.steps.map((st, i) => ({ ...st, on: 1, degree: 0, gate: 0.4, ...(i === 1 ? { ratchet: 3 } : {}), ...(i >= 8 ? { prob: 0.5 } : {}) }));
    const res = exportMidi(s, { mode: 'pattern', part: 0 });
    const m = parseMidi(res.bytes);
    const spb = 60 / 112;
    const want = sequencerEvents({ ...s, parts: s.parts.map((p, i) => (i === 0 ? { ...p, seqOn: 1 } : p)) }, 1, { parts: [0] })
      .filter(e => e.msg.t === 'noteOn').map(e => Math.round(e.time / spb * PPQ));
    expect(m.tracks[1].notes.map(n => n.tick)).toEqual(want);
    expect(want.length).toBeGreaterThan(8 + 2);           // the ratchet adds hits
    expect(want.length).toBeLessThan(16 + 2);             // some 50% steps were skipped
  });

  it('whole session: one track per sequencer that is on, drum kits on channel 10 as keys 36..43', () => {
    const s = session();
    melodic(s, 0);
    s.parts[0].seqOn = 1;
    s.parts[1].seqOn = 1;
    s.parts[1].drum = { on: 1 };
    const lanes = Array.from({ length: 8 }, (_, r) => Array.from({ length: SEQ_STEPS }, (_, c) => ((c + r) % 4 === 0 ? 0.5 + r * 0.05 : 0)));
    s.parts[1].patterns[0].drumLanes = lanes;
    const res = exportMidi(s, { mode: 'session', bars: 2 });
    const m = parseMidi(res.bytes);
    expect(res.tracks).toBe(2);
    expect(m.tracks.length).toBe(3);
    const drums = m.tracks[2].notes;
    expect(drums.every(n => n.ch === DRUM_CHANNEL && n.note >= 36 && n.note <= 43)).toBe(true);
    expect(drums.length).toBe(2 * lanes.flat().filter(v => v > 0).length);
    expect(Math.max(...m.tracks[1].notes.map(n => n.tick))).toBeGreaterThan(4 * PPQ); // the second bar is there
  });
});

describe('import', () => {
  it('round trip pattern -> .mid -> pattern keeps every in-scale step', () => {
    const s = session();
    const pat = melodic(s);
    const m = parseMidi(exportMidi(s, { mode: 'pattern', part: 0 }).bytes);
    const { choices, best } = midiChoices(m);
    expect(choices.length).toBe(1);
    const res = notesToPattern(choices[best].notes, { ...pat, steps: Array.from({ length: SEQ_STEPS }, defaultStep) }, { root: 9, scaleType: MINOR });
    expect(res.snapped).toBe(0);
    expect(res.used).toBe(pat.steps.filter(x => x.on).length);
    res.steps.forEach((st, i) => {
      const o = pat.steps[i];
      expect(st.on).toBe(o.on);
      if (!o.on) return;
      expect([st.degree, st.octave]).toEqual([o.degree, o.octave]);
      expect(Math.abs(st.vel - o.vel)).toBeLessThan(0.005);
      expect(Math.abs(st.gate - o.gate)).toBeLessThan(0.02);
      expect(st.slide).toBe(0);
    });
  });

  it('drum lanes survive the round trip exactly; other keys wrap onto the lanes', () => {
    const s = session();
    s.parts[0].drum = { on: 1 };
    const lanes = Array.from({ length: 8 }, (_, r) => Array.from({ length: SEQ_STEPS }, (_, c) => ((c * 3 + r) % 5 === 0 ? Math.round((0.2 + 0.1 * r) * 100) / 100 : 0)));
    const pat = s.parts[0].patterns[0];
    pat.drumLanes = lanes;
    const m = parseMidi(exportMidi(s, { mode: 'pattern', part: 0 }).bytes);
    const { choices, best } = midiChoices(m, { drum: true });
    const res = notesToPattern(choices[best].notes, { ...pat, drumLanes: undefined }, { drum: true });
    expect(res.drumLanes).toEqual(lanes);
    const wrapped = notesToPattern([{ beat: 0, beats: 0.1, note: 44, vel: 127 }, { beat: 0.25, beats: 0.1, note: 35, vel: 64 }], pat, { drum: true });
    expect(wrapped.drumLanes[0][0]).toBe(1);   // 44 -> lane 1 (key 36)
    expect(wrapped.drumLanes[7][1]).toBe(0.5); // 35 -> lane 8 (key 43)
  });

  it('snaps out-of-scale notes, keeps one note per step and reports the rest', () => {
    // A minor, base octave 3: A3 = 57
    expect(noteToDegree(57, { root: 9, scaleType: MINOR, baseOctave: 3 })).toEqual({ degree: 0, octave: 0, snapped: false });
    expect(noteToDegree(58, { root: 9, scaleType: MINOR, baseOctave: 3 })).toEqual({ degree: 0, octave: 0, snapped: true });
    expect(noteToDegree(68, { root: 9, scaleType: MINOR, baseOctave: 3 })).toEqual({ degree: 6, octave: 0, snapped: true }); // a tie snaps down
    expect(noteToDegree(57 + 36, { root: 9, scaleType: MINOR, baseOctave: 3 })).toEqual({ degree: 7, octave: 2, snapped: false });
    const notes = [
      { beat: 4.01, beats: 0.2, note: 58, vel: 100 },   // first note in bar 2: the import starts there
      { beat: 4, beats: 0.2, note: 64, vel: 90 },       // same step, higher: wins
      { beat: 4.5, beats: 0.25, note: 60, vel: 127 },
      { beat: 20, beats: 0.25, note: 60, vel: 127 },    // past the pattern
    ];
    const r = notesToPattern(notes, { rate: 3, length: 16, baseOctave: 3, steps: [] }, { root: 9, scaleType: MINOR });
    expect([r.used, r.snapped, r.dropped, r.outside]).toEqual([2, 0, 1, 1]);
    expect(r.steps[0]).toMatchObject({ on: 1, degree: 4, octave: 0 });
    expect(r.steps[2]).toMatchObject({ on: 1, degree: 2, octave: 0, vel: 1, gate: 1 });
  });

  it('reads a type 0 file with running status, note-on velocity 0, sysex, a tempo change and two channels', () => {
    const trk = [
      0x00, 0xff, 0x03, 0x04, 0x53, 0x6f, 0x6e, 0x67,          // name "Song"
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,                // 120 BPM
      0x00, 0xf0, 0x03, 0x7e, 0x09, 0xf7,                      // sysex, skipped
      0x00, 0x90, 60, 100,                                     // C4 on
      0x00, 64, 90,                                            // running status: E4 on
      0x83, 0x60, 60, 0,                                       // 480 ticks later: C4 off (velocity 0)
      0x00, 64, 0,                                             // E4 off
      0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,                // 60 BPM from beat 1
      0x00, 0x99, 36, 120,                                     // a kick on channel 10
      0x83, 0x60, 0x89, 36, 0,                                 // its note-off
      0x00, 0xff, 0x2f, 0x00,
    ];
    const bytes = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk]);
    const m = parseMidi(bytes);
    expect(m.format).toBe(0);
    expect(m.ppq).toBe(480);
    expect(m.tempos.map(t => t.uspq)).toEqual([500000, 1000000]);
    const n = m.tracks[0].notes;
    expect(n.map(x => [x.note, x.tick, x.dur, x.ch])).toEqual([[60, 0, 480, 0], [64, 0, 480, 0], [36, 480, 480, 9]]);
    expect(n[2].sec).toBeCloseTo(0.5, 9);    // one beat at 120 BPM
    const { choices, best } = midiChoices(m);
    expect(choices.map(c => c.label)).toEqual(['Song, channel 1: 2 notes', 'Song, channel 10: 1 note']);
    expect(best).toBe(0);
    expect(midiChoices(m, { drum: true }).best).toBe(1);
  });

  it('rejects files that are not MIDI', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3]))).toThrow(/not a MIDI file/);
    expect(() => parseMidi(Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 3, 0, 1, 0, 96]))).toThrow(/format 3/);
    expect(() => parseMidi(Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0, 96]))).toThrow(/no tracks/);
  });
});

describe('2.9 follow-ups', () => {
  const fakeTimers = () => {
    let id = 0; const q = new Map();
    return { setTimeout: (fn) => { q.set(++id, fn); return id; }, clearTimeout: (i) => q.delete(i), flush: () => { const f = [...q.values()]; q.clear(); f.forEach(x => x()); } };
  };
  // A minor, base octave 3: a three-note chord on step 1, two notes on step 3, one on step 5
  const CHORDS = [
    { beat: 0, beats: 0.2, note: 64, vel: 100 }, { beat: 0, beats: 0.2, note: 60, vel: 100 }, { beat: 0, beats: 0.2, note: 57, vel: 100 },
    { beat: 0.5, beats: 0.2, note: 62, vel: 100 }, { beat: 0.5, beats: 0.2, note: 69, vel: 100 },
    { beat: 1, beats: 0.2, note: 59, vel: 100 },
  ];
  const tracksOf = (store, k) => store.get(`parts.${k}.patterns.0.steps`).slice(0, 5).map(st => (st.on ? noteFromStep(st) : null));
  const noteFromStep = (st) => stepToMidi(st, 3, 9, MINOR);

  it('chords: highest or lowest note, or split voice k onto track sel + k as one undo step', () => {
    const base = session();
    base.parts = base.parts.slice(0, 3);
    let store = createStore(base);
    let r = importMidiNotes(store, CHORDS, { part: 0, chord: 'high' });
    expect(tracksOf(store, 0)).toEqual([64, null, 69, null, 59]);
    expect([r.dropped, r.voices, r.tracks]).toEqual([3, 3, 1]);
    store = createStore(base);
    importMidiNotes(store, CHORDS, { part: 0, chord: 'low' });
    expect(tracksOf(store, 0)).toEqual([57, null, 62, null, 59]);
    // split from track 2 of 3: voice 2 has no track left
    store = createStore(base);
    const timers = fakeTimers();
    const h = createHistory(store, { timers });
    r = importMidiNotes(store, CHORDS, { part: 1, chord: 'split' });
    timers.flush();
    expect(tracksOf(store, 1)).toEqual([64, null, 69, null, 59]);
    expect(tracksOf(store, 2)).toEqual([60, null, 62, null, null]);
    expect([r.tracks, r.voicesDropped, r.dropped, r.used]).toEqual([2, 1, 0, 5]);
    expect(h.list().past).toEqual(['Import']);
    h.undo();
    expect(tracksOf(store, 1)).toEqual([null, null, null, null, null]);
    expect(tracksOf(store, 2)).toEqual([null, null, null, null, null]);
  });

  it('accents: exported at velocity 127 and read back from velocity 120 up, velocity kept', () => {
    const s = session();
    const pat = melodic(s);
    pat.steps[0] = { ...pat.steps[0], accent: 1, vel: 0.4 };
    pat.steps[3] = { ...pat.steps[3], accent: 1 };
    const m = parseMidi(exportMidi(s, { mode: 'pattern', part: 0 }).bytes);
    const notes = m.tracks[1].notes;
    expect(notes[0].vel).toBe(127);
    const res = notesToPattern(notes, { ...pat, steps: [] }, { root: 9, scaleType: MINOR });
    res.steps.forEach((st, i) => expect(st.accent).toBe(pat.steps[i].accent ? 1 : 0));
    expect(res.steps[0].vel).toBe(1);
    expect(notesToPattern([{ beat: 0, beats: 0.2, note: 57, vel: 121 }], pat, { root: 9, scaleType: MINOR }).steps[0]).toMatchObject({ accent: 1, vel: 0.953 });
  });

  it('export takes the bounce replay when given: arpeggiated held keys come out too', () => {
    const s = session();
    s.parts[0].arp = { mode: 1, rate: 3, octaves: 1, gate: 0.5, hold: 1, rhythm: 0 };
    s.parts[0].seqOn = 0;
    const store = createStore(s);
    const held = (p) => (p === 0 ? [{ note: 60, vel: 0.8 }, { note: 64, vel: 0.8 }] : []);
    const calls = [];
    const render = (bars, o) => { calls.push(o); return renderSessionEvents(store, bars, { ...o, held }); };
    const plain = exportMidi(store.serialize(), { mode: 'pattern', part: 0 });
    expect(plain.notes).toBe(0);
    const res = exportMidi(store.serialize(), { mode: 'pattern', part: 0, render });
    expect(calls[0]).toEqual({ parts: [0], forceOn: [0] });
    const notes = parseMidi(res.bytes).tracks[1].notes;
    expect(notes.length).toBeGreaterThanOrEqual(8);
    expect(new Set(notes.map(n => n.note))).toEqual(new Set([60, 64]));
    // session export lists the arp-only track because it made notes
    const all = exportMidi(store.serialize(), { mode: 'session', bars: 1, render });
    expect(all.tracks).toBe(1);
  });

  it('scenes record their tuning; a scene without one keeps the current tuning', () => {
    const store = createStore(defaultState());
    const presets = createPresets({ store, storage: createMemoryStorage() });
    presets.saveScene('Plain');
    const plain = presets.getScene(presets.scenes().find(x => x.name === 'Plain').id);
    expect(plain.tuning).toEqual({ id: 'equal12', ref: 440, root: -1 });
    store.set('tuning', { id: 'equal19', ref: 440, root: 0 });
    presets.saveScene('Nineteen');
    expect(presets.getScene(presets.scenes().find(x => x.name === 'Nineteen').id).tuning).toEqual({ id: 'equal19', ref: 440, root: 0 });
    // an older scene (no tuning record) leaves the tuning alone
    const old = { ...defaultState(), name: 'Old' };
    presets.loadScene(old);
    expect(store.get('tuning')).toEqual({ id: 'equal19', ref: 440, root: 0 });
    // a scene that recorded 12-TET switches back to it; the session then saves no tuning
    presets.loadScene(plain.id);
    expect(store.get('tuning')).toBe(undefined);
    expect('tuning' in JSON.parse(JSON.stringify(store.serialize()))).toBe(false);
  });
});
