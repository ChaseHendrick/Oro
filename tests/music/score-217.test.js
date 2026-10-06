import { describe, it, expect } from 'vitest';
import { check, compose, schema, formatScore, STYLES, styleFromPrompt } from '../../src/music/score.js';
import { planTracks } from '../../src/music/desk.js';
import { PITCHED, PERC_VOICES, percussionKits, voicePatch } from '../../src/music/orchestra.js';
import { GROOVES } from '../../src/music/score-styles.js';
import { scoreMidi, scoreLink, scoreFromHash, GM_DRUMS } from '../../src/music/score-export.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function setup() {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}
const head = 'title T\nbpm 120\nbars 2\n';

describe('2.16 score bugs, fixed in 2.17', () => {
  it('reads Am7 as a minor seventh, not A minor in octave 7', () => {
    const r = check(`${head}piano Am7 0 1 0.8\n`);
    expect(r.ok).toBe(true);
    expect(r.score.notes.map((n) => n.midi)).toEqual([57, 60, 64, 67]);   // piano voices chords from octave 3
    expect(check(`${head}piano Am7@4 0 1 0.8\n`).score.notes[0].midi).toBe(69);
    expect(check(`${head}piano Am74 0 1 0.8\n`).score.notes[0].midi).toBe(69);
    expect(check(`${head}piano Cmaj4 0 1 0.8\n`).score.notes.map((n) => n.midi)).toEqual([60, 64, 67]);
    expect(check(`${head}piano C5 0 1 0.8\n`).score.notes.map((n) => n.midi)).toEqual([72]);
  });

  it('plays a pitched tom on a kit pad and keeps its pitch in the normalised text', () => {
    const low = check(`${head}tom D3 0 0.5 0.8\n`);
    const high = check(`${head}tom A3 1 0.5 0.8\n`);
    expect(low.score.notes[0].midi).toBe(41);    // low tom pad
    expect(high.score.notes[0].midi).toBe(42);   // high tom pad
    expect(high.text).toContain('tom A3 1 0.5 0.8');
    const again = check(high.text);
    expect(again.score.notes[0].midi).toBe(42);
    expect(again.hash).toBe(high.hash);
  });

  it('rejects a chord on a drum', () => {
    const r = check(`${head}tom Cmaj 0 0.5 0.8\n`);
    expect(r.ok).toBe(false);
    expect(r.errors[0].field).toBe('pitch');
  });
});

describe('score grammar 2.17', () => {
  it('repeats a note with every, until and times', () => {
    const r = check(`${head}hat x 0 0.08 0.4 every 0.5\nkick x 0 0.2 1 every 1 times 3\nsnare x 1 0.1 0.8 every 2 until 6\n`);
    expect(r.ok).toBe(true);
    const count = (v) => r.score.notes.filter((n) => n.voice === v).length;
    expect(count('hat')).toBe(16);
    expect(count('kick')).toBe(3);
    expect(count('snare')).toBe(3);   // beats 1, 3, 5
  });

  it('takes time signatures, a key with its mode, tempo and inline comments', () => {
    const r = check('title W\ntempo 90\nbars 2\ntime 3/4\nkey Am\n\npiano A4 0 3 0.7 # a held A\n');
    expect(r.ok).toBe(true);
    expect(r.score).toMatchObject({ bpm: 90, beats: 3, key: 'A', mode: 'minor' });
    expect(r.durationSeconds).toBeCloseTo(2 * 3 * 60 / 90, 3);
  });

  it('accepts numeric MIDI pitches and every in JSON scores', () => {
    const r = check({ bpm: 100, bars: 1, notes: [{ voice: 'violin', pitch: 69, beat: 0, len: 1 }, { voice: 'hat', pitch: 'x', beat: 0, len: 0.1, every: 1 }] });
    expect(r.ok).toBe(true);
    expect(r.score.notes.find((n) => n.voice === 'violin').midi).toBe(69);
    expect(r.score.notes.filter((n) => n.voice === 'hat')).toHaveLength(4);
  });

  it('warns once when a voice leaves its range, and still plays it', () => {
    const r = check(`${head}violin C3 0 1 0.5\nviolin B2 1 1 0.5\n`);
    expect(r.ok).toBe(true);
    expect(r.warnings.filter((w) => w.field === 'violin')).toHaveLength(1);
  });

  it('knows aliases and plurals', () => {
    const r = check(`${head}vlns A4 0 1 0.5\ntimp D2 0 1 0.8\ncym x 0 1 0.6\nglockenspiel C7 1 1 0.4\n`);
    expect(r.ok).toBe(true);
    expect(r.voices.map((v) => v.voice).sort()).toEqual(['crash', 'glock', 'timpani', 'violin']);
  });

  it('builds drum kits from the pieces a score uses, eight to a kit', () => {
    const many = PERC_VOICES.slice(0, 10).map((v, i) => `${v} x ${i % 8} 0.2 0.7`).join('\n');
    const r = check(`${head}${many}\n`);
    expect(r.ok).toBe(true);
    const kits = new Set(r.score.notes.map((n) => n.kit));
    expect([...kits].sort()).toEqual([1, 2]);
    for (const n of r.score.notes) expect(n.midi).toBeGreaterThanOrEqual(36);
    const { kits: built } = percussionKits(PERC_VOICES.slice(0, 10));
    expect(built).toHaveLength(2);
    expect(built[0].pads).toHaveLength(8);
    expect(built[1].pads.filter((p) => p.level > 0)).toHaveLength(2);
  });

  it('lists every voice, its section and how to render in the schema', () => {
    const s = schema();
    expect(s.voices).toEqual(expect.arrayContaining(['violin', 'timpani', 'crash', 'rain', 'conga', 'celesta', 'tuba']));
    expect(s.orchestra.timpani).toMatchObject({ family: 'resonator', section: 'percussion' });
    expect(s.render).toMatch(/oro-score\.mjs render/);
    expect(s.voicings).toHaveProperty('patch');
  });

  it('gives every pitched voice a patch that sounds at the written pitch', () => {
    for (const v of Object.keys(PITCHED)) {
      const p = voicePatch(v);
      expect(p.params.octave).toBe(0);
      expect(p.params.tune).toBe(0);
    }
  });
});

describe('compose 2.17', () => {
  it('writes every style in both modes without errors', () => {
    for (const style of Object.keys(STYLES)) {
      for (const mode of ['major', 'minor']) {
        const r = compose({ style, key: 'E', mode });
        expect(r.ok, `${style} ${mode}: ${JSON.stringify(r.errors)}`).toBe(true);
        expect(r.noteCount).toBeGreaterThan(0);
      }
    }
  });

  it('is repeatable: the same prompt writes the same score', () => {
    const a = compose('anime opening song in D minor');
    const b = compose('anime opening song in D minor');
    expect(a.hash).toBe(b.hash);
    expect(compose({ prompt: 'anime opening song in D minor', seed: 5 }).hash).not.toBe(a.hash);
  });

  it('writes an anime opening with its sections, a kime break and a key change', () => {
    const r = compose({ prompt: 'anime opening song in D minor' });
    expect(r.ok).toBe(true);
    expect(r.score.style).toBe('anime-song');
    expect(r.score.voicing).toBe('patch');
    expect(r.cues.map((c) => c.name)).toEqual(['intro', 'verse', 'pre', 'chorus', 'break', 'hits', 'chorus-2', 'outro', 'end']);
    const chorus = r.cues.find((c) => c.name === 'chorus').beat, last = r.cues.find((c) => c.name === 'chorus-2').beat;
    // the last chorus's bass roots sit a semitone above the first chorus's
    const firstBass = r.score.notes.find((n) => n.voice === 'bass' && n.beat === chorus).midi;
    const lastBass = r.score.notes.find((n) => n.voice === 'bass' && n.beat === last).midi;
    expect(((lastBass - firstBass) % 12 + 12) % 12).toBe(1);
  });

  it('picks styles and grooves from prompt words', () => {
    expect(styleFromPrompt('anime opening at 180 bpm in D minor, 8 bars')).toBe('opening');
    expect(styleFromPrompt('a j-rock anime theme song')).toBe('anime-song');
    expect(styleFromPrompt('trap beat')).toBe('drums');
    expect(styleFromPrompt('house')).toBe('drums');
    expect(styleFromPrompt('sparse, no drums')).toBe('sparse');
    expect(styleFromPrompt('rain on a window')).toBe('ambient');
    expect(styleFromPrompt('lofi study beat')).toBe('lofi');
    expect(styleFromPrompt('epic trailer')).toBe('epic');
    expect(compose('trap beat').score.bpm).toBe(GROOVES.trap.bpm);
    expect(compose('metal drums').score.bpm).toBe(GROOVES.metal.bpm);
  });

  it('drops the drums and the percussion when asked', () => {
    const r = compose('epic trailer, no drums');
    expect(r.ok).toBe(true);
    expect(r.score.notes.some((n) => n.family === 'drum' || n.family === 'perc')).toBe(false);
  });
});

describe('planTracks', () => {
  const receiptOf = (text) => check(text);
  it('keeps the 2.16 layout on four tracks: pitched first, the kit on the last', () => {
    const p = planTracks(receiptOf(`${head}violin A4 0 1 0.8\nkick x 0 0.2 1\n`), 4);
    expect(p.partOf.get('violin')).toBe(0);
    expect(p.partOf.get('kick')).toBe(3);
    expect(p.slots.every((s) => !s.add)).toBe(true);
  });
  it('adds tracks for more voices, and percussion kits of their own', () => {
    const text = `${head}${['violin', 'viola', 'cello', 'contrabass', 'flute', 'horn'].map((v, i) => `${v} C4 ${i % 4} 1 0.5`).join('\n')}\nkick x 0 0.2 1\ncrash x 0 1 0.6\n`;
    const p = planTracks(receiptOf(text), 4);
    expect(p.slots.filter((s) => s.add).length).toBe(4);   // two more pitched, the percussion kit... and one kit fallback none
    expect(new Set(p.partOf.values()).size).toBe(8);
    expect(p.fallback.size).toBe(0);
  });
  it('shares tracks and borrows classic pads in share mode', () => {
    const text = `${head}violin A4 0 1 0.8\nviola A3 0 1 0.8\ncello A2 0 1 0.8\nflute A5 0 1 0.8\nkick x 0 0.2 1\ncrash x 0 1 0.6\n`;
    const p = planTracks(receiptOf(text), 4, { tracks: 'share' });
    expect(p.slots.some((s) => s.add)).toBe(false);
    expect(p.fallback.has('crash')).toBe(true);
    expect(p.warnings.map((w) => w.field)).toContain('tracks');
  });
});

describe('score desk 2.17', () => {
  it('adds tracks for a patch-voiced score and removes them afterwards', () => {
    const { clock, engine, store, music } = setup();
    const ids = store.get('parts').map((p) => p.id);
    const r = music.score.play(`${head}voicing patch\n${['violin', 'viola', 'cello', 'contrabass', 'horn'].map((v) => `${v} C4 0 1 0.5`).join('\n')}\nkick x 0 0.2 1\n`);
    expect(r.ok).toBe(true);
    expect(store.get('parts').length).toBe(6);
    expect(store.get(`parts.${r.voices.find((v) => v.voice === 'violin').part}.patchName`)).toMatch(/Violin/);
    clock.advance(4);
    expect(engine.ons().length).toBeGreaterThan(0);
    expect(music.score.borrowing()).toBe(true);
    // the release tails done: the tracks are back as they were
    clock.advance(4);
    expect(store.get('parts').map((p) => p.id)).toEqual(ids);
    expect(music.score.borrowing()).toBe(false);
  });

  it('never saves borrowed tracks', () => {
    const { store, music } = setup();
    const before = store.serialize();
    music.score.play(`${head}voicing patch\nviolin A4 0 4 0.8\nviola A3 0 4 0.8\ncello A2 0 4 0.8\nflute A5 0 4 0.8\ntuba A1 0 4 0.8\n`);
    expect(store.get('parts').length).toBe(5);
    const saved = music.score.cleanState(store.serialize());
    expect(saved.parts.map((p) => p.id)).toEqual(before.parts.map((p) => p.id));
    expect(saved.parts[0]).toEqual(before.parts[0]);
    expect(saved.global.tempo).toBe(before.global.tempo);
  });

  it('lets go of the tracks without writing them back when a session is loaded', () => {
    const { store, music } = setup();
    music.score.play(`${head}violin A4 0 4 0.8\n`);
    const next = defaultState();
    next.parts[0].name = 'Loaded';
    store.load(next);
    expect(music.score.playing()).toBe(false);
    expect(store.get('parts.0.name')).toBe('Loaded');
  });

  it('stops with a panic and puts the tracks back', () => {
    const { store, music } = setup();
    const name = store.get('parts.0.name');
    music.score.play(`${head}violin A4 0 4 0.8\n`);
    expect(store.get('parts.0.name')).toBe('violin');
    music.router.allNotesOff();
    expect(music.score.playing()).toBe(false);
    expect(store.get('parts.0.name')).toBe(name);
  });

  it('puts the tracks back by id when someone else reorders them', () => {
    const { store, music } = setup();
    const before = store.get('parts').map((p) => ({ id: p.id, name: p.name }));
    music.score.play(`${head}violin A4 0 4 0.8\n`);
    const list = store.get('parts').slice().reverse();
    store.set('parts', list, { source: 'tracks' });
    expect(music.score.playing()).toBe(false);
    for (const p of store.get('parts')) expect(p.name).toBe(before.find((b) => b.id === p.id).name);
  });

  it('reports cues as they pass, and where it is', () => {
    const { clock, music } = setup();
    const events = [];
    music.on('score', (e) => events.push(e));
    music.score.play('title C\nbpm 120\nbars 2\ncue hit 4\nviolin A4 0 8 0.5\n');
    expect(music.score.status()).toMatchObject({ playing: true, title: 'C' });
    clock.advance(2.2);
    expect(events.find((e) => e.type === 'cue')).toMatchObject({ name: 'hit', seconds: 2 });
    expect(music.score.status().cue).toBe('hit');
  });
});

describe('score export', () => {
  it('writes a MIDI file with one track per voice and General MIDI drums', () => {
    const r = check(`${head}piano C4 0 1 0.8\nkick x 0 0.2 1\ncrash x 0 1 0.6\n`);
    const bytes = scoreMidi(r);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    // header + conductor + three tracks
    expect(bytes[10] * 256 + bytes[11]).toBe(4);
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toContain(`99${GM_DRUMS.crash.toString(16)}`);   // note on, channel 10, crash
  });

  it('round-trips a score through a link', async () => {
    const r = check(`${head}piano C4 0 1 0.8\n`);
    const url = await scoreLink(r.text, 'https://example.org/oro/');
    expect(url).toMatch(/^https:\/\/example\.org\/oro\/#score=[zj]\./);
    expect(await scoreFromHash(new URL(url).hash)).toBe(r.text);
    expect(await scoreFromHash('#score=z.!!!')).toBeNull();
  });
});

describe('offline render', () => {
  it('renders a short score to a finished, finite stereo mix', async () => {
    const { renderScore, encodeScoreWav, loudness } = await import('../../src/music/score-render.js');
    const r = await renderScore('title R\nbpm 120\nbars 1\nvoicing patch\npiano Cmaj 0 2 0.8\nkick x 0 0.2 1 every 1\n', { quality: 'eco', tail: 0.5, sampleRate: 24000 });
    expect(r.ok).toBe(true);
    expect(r.left.length).toBe(r.right.length);
    let peak = 0;
    for (const x of r.left) { expect(Number.isFinite(x)).toBe(true); peak = Math.max(peak, Math.abs(x)); }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
    expect(r.stats.loudness).toBeCloseTo(loudness(r.left, r.right, r.sampleRate), 1);
    const wav = encodeScoreWav(r, { format: 'float32' });
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(wav[20]).toBe(3);   // IEEE float
  });

  it('refuses a score that fails the check', async () => {
    const { renderScore } = await import('../../src/music/score-render.js');
    const r = await renderScore('nope');
    expect(r.ok).toBe(false);
    expect(r.receipt.errors.length).toBeGreaterThan(0);
  });
});
