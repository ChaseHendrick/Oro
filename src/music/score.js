// Text scores for an agent (skills/oro-music). One land, many desks.
//
// A score is headers, cue marks, and note lines. check() is the contract:
// it returns ok, the errors to fix, and a receipt (seconds, cues, a hash)
// so a caller can match a render to a picture without guessing.
// compose() writes a score from a style or a short prompt. It does not
// call a model; the styles live in score-styles.js. Playback is desk.js
// (an open page) or score-render.js (offline, a WAV with no page).
//
// 2.17: the orchestra (orchestra.js) lists every voice; chords take sevenths
// and an explicit octave (Am7, Am7@3); a pitched tom picks the low or high
// pad; `every` repeats a note; `voicing patch` plays each voice through its
// own patch; out-of-range notes warn.

import { KIT_BASE_NOTE } from '../dsp/drum-kit.js';
import { PITCHED, KIT_PADS, KIT_VOICES, PERC, PERC_VOICES, PERC_FALLBACK, orchestraTable, percussionKits } from './orchestra.js';
import { STYLES, GROOVES, writeStyle, drumTempo } from './score-styles.js';

export const LIMITS = Object.freeze({
  bpm: [40, 240],
  bars: [1, 128],
  beats: [1, 16],
  notes: 8000,
  velocity: [0, 1],
  pan: [-1, 1],
  swing: [0, 0.6],
});

export const VOICINGS = Object.freeze(['tint', 'patch']);

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']);

/** voice -> family. Drums are the Kit, perc the Percussion kit, the rest are pitched. */
export const VOICES = Object.freeze({
  ...Object.fromEntries(Object.entries(PITCHED).map(([k, v]) => [k, v.family])),
  ...Object.fromEntries(KIT_VOICES.map((k) => [k, 'drum'])),
  ...Object.fromEntries(PERC_VOICES.map((k) => [k, 'perc'])),
});

export const ALIASES = Object.freeze({
  vln: 'violin', vla: 'viola', vc: 'cello', vcl: 'cello', cb: 'contrabass', db: 'contrabass', basses: 'contrabass',
  str: 'strings', stacc: 'spiccato', trem: 'tremolo',
  picc: 'piccolo', fl: 'flute', ob: 'oboe', eh: 'cor', cl: 'clarinet', bsn: 'bassoon', cbsn: 'bassoon',
  hn: 'horn', tpt: 'trumpet', tbn: 'trombone', tba: 'tuba',
  hp: 'harp', pno: 'piano', cel: 'celesta', celeste: 'celesta', glk: 'glock', glockenspiel: 'glock',
  xyl: 'xylo', xylophone: 'xylo', mba: 'marimba', vib: 'vibes', vibraphone: 'vibes', tubular: 'chimes',
  timp: 'timpani', tamtam: 'gong',
  gtr: 'guitar', ep: 'rhodes', org: 'organ', synth: 'saw', whoosh: 'riser', boom: 'impact', hit: 'impact',
  bd: 'kick', sd: 'snare', hh: 'hat', oh: 'openhat', ohh: 'openhat', cp: 'clap', lt: 'tom', ht: 'hitom',
  cym: 'crash', cymbal: 'crash', shk: 'shaker', tamb: 'tambourine', tri: 'triangle', gran: 'bassdrum',
  woodblock: 'block',
});

const CHORDS = Object.freeze({
  maj: [0, 4, 7], min: [0, 3, 7], m: [0, 3, 7],
  dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7],
  '5th': [0, 7],
  '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9], '7sus4': [0, 5, 7, 10], add9: [0, 4, 7, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
});
// Longest names first, so Am7 is a minor seventh, not A minor in octave 7.
const CHORD_TYPES = Object.keys(CHORDS).sort((a, b) => b.length - a.length);
const CHORD_RE = new RegExp(`^([A-G])([#b]?)(${CHORD_TYPES.join('|')})(?:@?(-?\\d))?$`);

/** Kit pads the classic drum voices play (MIDI 36 + pad). */
const DRUM_PAD = Object.freeze({ ...KIT_PADS });

const DEFAULT_OCTAVE = Object.freeze({
  terrain: 4, physical: 3, fm: 4, additive: 4, subtractive: 4, wavetable: 2, vector: 4, granular: 4, resonator: 2, drum: 3, perc: 3,
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const round = (n) => Math.round(n * 1000) / 1000;

function pcOf(letter, acc) {
  let n = LETTER[letter];
  if (acc === '#') n += 1;
  if (acc === 'b') n -= 1;
  return (n + 12) % 12;
}

export function spell(midi, flats) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return (flats ? FLAT : SHARP)[pc] + oct;
}

function midiOf(pc, oct) {
  return (oct + 1) * 12 + pc;
}

export function schema() {
  return {
    instrument: 'oro',
    kind: 'wave-terrain score',
    version: 2,
    limits: LIMITS,
    voices: Object.keys(VOICES),
    aliases: ALIASES,
    families: { ...VOICES },
    orchestra: orchestraTable(),
    drums: {
      pitch: 'x',
      openHat: 'hat length of 0.2 quarters or more, or the openhat voice',
      tom: 'tom takes x (low tom) or a note: below E3 is the low tom, E3 and up the high tom',
      pads: 'Kit: kick snare hat openhat clap tom hitom rim, MIDI 36 to 43 on the drum track',
      pieces: Object.fromEntries(Object.entries(PERC).map(([k, p]) => [k, p.made])),
      kits: 'Pieces beyond the classic kit get their own kit tracks, eight pieces to a kit, built from the pieces a score uses. A note\'s kit is in the receipt.',
    },
    chords: Object.keys(CHORDS),
    chordOctave: 'An octave digit after the type (Cmaj4) or after @ (Am7@3). Without one, the voice picks.',
    styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.about])),
    voicings: {
      tint: 'Each track keeps its own land and patch; the score only changes envelope and filter.',
      patch: 'Each voice plays through its own patch from the orchestra (fuller, closer to the instrument).',
    },
    time: 'Quarter notes from 0. A number, a fraction (1/3), or Nt / Ntt for one or two triplet eighths after beat N.',
    repeat: 'End a note line with `every STEP` and optionally `until BEAT` or `times N`: hat x 0 0.08 0.4 every 0.5 until 16',
    cues: 'cue NAME BEAT. The receipt gives that beat in seconds.',
    headers: ['title', 'bpm', 'tempo', 'bars', 'beats', 'time', 'key', 'mode', 'style', 'swing', 'voicing'],
    note: 'voice pitch beat length velocity [pan] [every STEP [until BEAT | times N]]',
    render: 'node scripts/oro-score.mjs render score.txt out.wav (no page), or oro.render(score) on an open page',
    http: null,
  };
}

function err(line, field, message, fix) {
  return { line, field, message, fix };
}

function parseBeat(tok) {
  if (/^\d+tt$/.test(tok)) return Number(tok.slice(0, -2)) + 2 / 3;
  if (/^\d+t$/.test(tok)) return Number(tok.slice(0, -1)) + 1 / 3;
  if (/^\d+\/\d+$/.test(tok)) {
    const [a, b] = tok.split('/').map(Number);
    return b ? a / b : NaN;
  }
  if (/^\d+(\.\d+)?$/.test(tok)) return Number(tok);
  return NaN;
}

export function resolveVoice(tok) {
  const key = String(tok || '').toLowerCase();
  if (VOICES[key]) return key;
  if (ALIASES[key]) return ALIASES[key];
  // plurals: violins, horns, trumpets
  if (key.endsWith('s')) {
    const one = key.slice(0, -1);
    if (VOICES[one]) return one;
    if (ALIASES[one]) return ALIASES[one];
  }
  return null;
}

function parsePitch(tok, voice) {
  if (tok === 'x') return { kind: 'drum' };
  const note = tok.match(/^([A-G])([#b]?)(-?\d)$/);
  if (note) {
    const midi = midiOf(pcOf(note[1], note[2]), Number(note[3]));
    if (midi < 0 || midi > 127) return { error: 'pitch' };
    return { kind: 'note', midi };
  }
  const chord = tok.match(CHORD_RE);
  if (chord) {
    const oct = chord[4] != null ? Number(chord[4]) : (DEFAULT_OCTAVE[VOICES[voice]] ?? 4);
    const root = midiOf(pcOf(chord[1], chord[2]), oct);
    const steps = CHORDS[chord[3]];
    const midis = steps.map((s) => root + s).filter((n) => n >= 0 && n <= 127);
    if (!midis.length) return { error: 'pitch' };
    return { kind: 'chord', midis };
  }
  if (/^[A-G][#b]?$/.test(tok)) return { error: 'bare' };
  return { error: 'pitch' };
}

function num(tok) {
  const n = Number(tok);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse and check a text score or a JSON score `{ bpm, key, mode, notes }`.
 * @returns {{ ok: boolean, errors: object[], warnings: object[], score: object|null, text: string, durationSeconds: number, noteCount: number, voices: object[], cues: object[], hash: string }}
 */
export function check(input) {
  const warnings = [];
  const errors = [];
  const raw = typeof input === 'string' ? input : input && input.score ? input.score : input;
  const lines = sourceLines(raw, errors);
  if (!lines) return receipt(false, errors, warnings, null);

  const head = {
    title: 'Untitled', bpm: 120, bars: 4, beats: 4, key: 'C', mode: 'major', style: '', swing: 0, voicing: '',
  };
  const cues = [];
  const notes = [];
  const repeats = [];
  const seenCue = new Set();

  for (const { line, text } of lines) {
    const bits = text.split(/\s+/);
    const word = bits[0].toLowerCase();
    if (word === 'cue') {
      const name = bits[1];
      const beat = parseBeat(bits[2] || '');
      if (!name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
        errors.push(err(line, 'cue', `Cue "${bits[1] || ''}" needs a name.`, 'Write: cue title 12'));
      } else if (!Number.isFinite(beat)) {
        errors.push(err(line, 'cue', `Cue ${name} has no beat.`, 'Put a beat after the name: cue title 12'));
      } else if (seenCue.has(name)) {
        errors.push(err(line, 'cue', `Cue ${name} is already used.`, 'Give this hit a different name.'));
      } else {
        seenCue.add(name);
        cues.push({ name, beat, line });
      }
      continue;
    }
    if (bits.length >= 4 && resolveVoice(word)) {
      pushNote(line, bits, notes, errors, repeats);
      continue;
    }
    if (HEADER.has(word) && bits.length >= 2) {
      applyHeader(word, bits.slice(1).join(' '), line, head, errors);
      continue;
    }
    errors.push(err(line, 'line', `Could not read "${text}".`, 'A header (bpm 180), a cue (cue title 12), or a note (violin A4 0 0.5 0.8).'));
  }

  const end = head.bars * head.beats;
  // `every` lines become notes now that the length of the score is known
  if (!errors.length) {
    for (const r of repeats) {
      const stop = Math.min(end, r.until != null ? r.until : end);
      let k = 0;
      for (let b = r.note.beat; b < stop - 1e-9 && k < (r.times ?? Infinity); b = r.note.beat + (++k) * r.step) {
        if (notes.length > LIMITS.notes) break;
        notes.push({ ...r.note, beat: b });
      }
    }
  }
  if (!errors.length) {
    for (const c of cues) {
      if (c.beat < 0 || c.beat > end) {
        errors.push(err(c.line, 'cue', `Cue ${c.name} is outside the ${head.bars} bars.`, `Keep it between 0 and ${end}, or raise bars.`));
      }
    }
    for (const n of notes) {
      if (n.beat < 0 || n.beat >= end) {
        errors.push(err(n.line, 'beat', `${n.voice} starts at beat ${round(n.beat)}, outside the score.`, `Move it before beat ${end}, or raise bars.`));
      } else if (n.beat + n.len > end + 1e-6) {
        errors.push(err(n.line, 'length', `${n.voice} runs past the end.`, `Shorten it, or raise bars above ${head.bars}.`));
      }
    }
  }
  if (notes.length > LIMITS.notes) {
    errors.push(err(0, 'notes', `${notes.length} notes is over the limit of ${LIMITS.notes}.`, 'Split the piece, or cut notes.'));
  }

  if (errors.length) return receipt(false, errors, warnings, null);

  // drum pieces beyond the classic kit: kit tracks built from the pieces used
  const { where } = percussionKits([...new Set(notes.filter((n) => VOICES[n.voice] === 'perc').map((n) => n.voice))]);
  for (const n of notes) {
    const w = where[n.voice];
    if (w) { n.midi = w.note; n.kit = w.kit; }
  }

  const flats = FLAT_KEYS.has(head.key);
  const score = {
    title: head.title,
    bpm: head.bpm,
    bars: head.bars,
    beats: head.beats,
    key: head.key,
    mode: head.mode,
    style: head.style,
    swing: head.swing,
    voicing: head.voicing,
    cues: cues.map(({ name, beat }) => ({ name, beat })).sort((a, b) => a.beat - b.beat || a.name.localeCompare(b.name)),
    notes: notes.map((n) => ({
      voice: n.voice,
      family: VOICES[n.voice],
      pitch: n.pitch,
      midi: n.midi,
      beat: round(n.beat),
      len: round(n.len),
      vel: round(n.vel),
      ...(n.pan != null ? { pan: round(n.pan) } : {}),
      ...(n.kit ? { kit: n.kit } : {}),
    })).sort((a, b) => a.beat - b.beat || a.voice.localeCompare(b.voice) || a.midi - b.midi),
  };
  warnRanges(score.notes, warnings);
  const text = formatScore(score, flats);
  return receipt(true, [], warnings, score, text);
}

const HEADER = new Set(['title', 'bpm', 'tempo', 'bars', 'beats', 'time', 'key', 'mode', 'style', 'swing', 'voicing']);

function sourceLines(raw, errors) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return jsonLines(raw, errors);
  if (typeof raw !== 'string' || !raw.trim()) {
    errors.push(err(0, 'score', 'The score is empty.', 'Send a text score, or a JSON score with notes.'));
    return null;
  }
  const out = [];
  raw.split(/\r?\n/).forEach((row, i) => {
    const text = row.replace(/\s+#.*$/, '').trim();
    if (!text || text.startsWith('#')) return;
    out.push({ line: i + 1, text });
  });
  return out;
}

function jsonLines(obj, errors) {
  if (!Array.isArray(obj.notes)) {
    errors.push(err(0, 'notes', 'JSON scores need a notes array.', 'Each note is { voice, pitch, beat, len, vel }.'));
    return null;
  }
  const rows = [];
  // line numbers count headers, then cues, then notes, so an error points at one item
  const push = (text) => rows.push({ line: rows.length + 1, text });
  const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim();
  if (obj.title) push(`title ${oneLine(obj.title)}`);
  if (obj.bpm != null) push(`bpm ${obj.bpm}`);
  if (obj.bars != null) push(`bars ${obj.bars}`);
  if (obj.beats != null) push(`beats ${obj.beats}`);
  if (obj.key) push(`key ${oneLine(obj.key)}`);
  if (obj.mode) push(`mode ${oneLine(obj.mode)}`);
  if (obj.style) push(`style ${oneLine(obj.style)}`);
  if (obj.swing != null) push(`swing ${obj.swing}`);
  if (obj.voicing) push(`voicing ${oneLine(obj.voicing)}`);
  (Array.isArray(obj.cues) ? obj.cues : []).forEach((c) => push(`cue ${oneLine(c && c.name)} ${c && c.beat}`));
  obj.notes.forEach((n) => {
    if (!n || typeof n !== 'object') { push('?'); return; }
    const len = n.len ?? n.length;
    const vel = n.vel ?? n.velocity ?? 0.8;
    const pitch = typeof n.pitch === 'number' && Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127 ? spell(n.pitch, false) : oneLine(n.pitch);
    const pan = n.pan != null ? ` ${n.pan}` : (n.every != null ? ' -' : '');
    let rep = '';
    if (n.every != null) rep = ` every ${n.every}${n.until != null ? ` until ${n.until}` : ''}${n.times != null ? ` times ${n.times}` : ''}`;
    push(`${oneLine(n.voice)} ${pitch} ${n.beat} ${len} ${vel}${pan}${rep}`);
  });
  return rows;
}

function applyHeader(word, value, line, head, errors) {
  if (word === 'title') {
    head.title = value.slice(0, 80);
    return;
  }
  if (word === 'key') {
    const m = value.match(/^([A-G])([#b]?)\s*(m|min|minor|maj|major)?$/);
    if (!m) errors.push(err(line, 'key', `Key "${value}" is not a note name.`, 'Use a name like A, Bb or F#.'));
    else {
      head.key = m[1] + (m[2] || '');
      if (m[3]) head.mode = /^m(in)?(or)?$/.test(m[3]) ? 'minor' : 'major';
    }
    return;
  }
  if (word === 'mode') {
    const m = value.toLowerCase();
    if (m !== 'major' && m !== 'minor') errors.push(err(line, 'mode', `Mode "${value}" is not major or minor.`, 'Write mode minor or mode major.'));
    else head.mode = m;
    return;
  }
  if (word === 'style') {
    const s = value.toLowerCase();
    if (!STYLES[s]) errors.push(err(line, 'style', `Style "${value}" is not one Oro writes.`, `Use one of: ${Object.keys(STYLES).join(', ')}.`));
    else head.style = s;
    return;
  }
  if (word === 'voicing') {
    const v = value.toLowerCase();
    if (!VOICINGS.includes(v)) errors.push(err(line, 'voicing', `Voicing "${value}" is not tint or patch.`, 'Write voicing patch for an instrument per voice, or voicing tint.'));
    else head.voicing = v;
    return;
  }
  if (word === 'time') {
    const m = value.match(/^(\d+)\/(2|4|8|16)$/);
    if (!m) { errors.push(err(line, 'time', `Time "${value}" is not a signature.`, 'Write time 3/4, 6/8 or 4/4.')); return; }
    const beats = Number(m[1]) * 4 / Number(m[2]);
    if (beats < LIMITS.beats[0] || beats > LIMITS.beats[1] || !Number.isInteger(beats)) {
      errors.push(err(line, 'time', `Time ${value} is ${round(beats)} quarter notes a bar.`, 'Use a bar of 1 to 16 whole quarter notes.'));
      return;
    }
    head.beats = beats;
    return;
  }
  const key = word === 'tempo' ? 'bpm' : word;
  const n = num(value);
  const lim = key === 'bpm' ? LIMITS.bpm : key === 'bars' ? LIMITS.bars : key === 'beats' ? LIMITS.beats : LIMITS.swing;
  if (!Number.isFinite(n)) {
    errors.push(err(line, key, `${key} needs a number.`, `Write ${key} ${lim[0]}.`));
    return;
  }
  if (n < lim[0] || n > lim[1]) {
    errors.push(err(line, key, `${key} ${n} is outside ${lim[0]} to ${lim[1]}.`, `Keep ${key} between ${lim[0]} and ${lim[1]}.`));
    return;
  }
  head[key] = key === 'swing' || key === 'bpm' ? n : Math.round(n);
}

function pushNote(line, all, notes, errors, repeats) {
  // optional repeat: ... every STEP [until BEAT | times N]
  let bits = all;
  let rep = null;
  const at = all.findIndex((b, i) => i >= 4 && b.toLowerCase() === 'every');
  if (at >= 0) {
    bits = all.slice(0, at);
    const tail = all.slice(at + 1);
    const step = parseBeat(tail[0] || '');
    rep = { step, until: null, times: null };
    if (!(step > 0)) {
      errors.push(err(line, 'every', `"every ${tail[0] || ''}" needs a step in quarter notes.`, 'Write every 0.5 for eighths, every 1 for quarters.'));
      return;
    }
    for (let i = 1; i < tail.length; i += 2) {
      const word = (tail[i] || '').toLowerCase();
      const val = word === 'until' ? parseBeat(tail[i + 1] || '') : num(tail[i + 1]);
      if (word === 'until' && Number.isFinite(val)) rep.until = val;
      else if (word === 'times' && Number.isInteger(val) && val >= 1) rep.times = val;
      else {
        errors.push(err(line, 'every', `Could not read "${tail.slice(i).join(' ')}" after every.`, 'Write every 0.5 until 16, or every 1 times 8.'));
        return;
      }
    }
  }
  const voice = resolveVoice(bits[0]);
  const family = VOICES[voice];
  const pitch = parsePitch(bits[1], voice);
  const beat = parseBeat(bits[2]);
  const len = num(bits[3]);
  const vel = bits[4] == null ? 0.8 : num(bits[4]);
  const pan = bits[5] == null || bits[5] === '-' ? null : num(bits[5]);
  if (!pitch || pitch.error === 'pitch') {
    errors.push(err(line, 'pitch', `"${bits[1]}" is not a pitch or a chord.`, 'Write A4, or a chord like Cmaj, Cm, C7, Cmaj7, Am7. A bare C is not enough.'));
    return;
  }
  if (pitch.error === 'bare') {
    errors.push(err(line, 'pitch', `"${bits[1]}" needs an octave or a chord type.`, `Write ${bits[1]}4 for a note, or ${bits[1]}maj for a chord.`));
    return;
  }
  if (!Number.isFinite(beat)) {
    errors.push(err(line, 'beat', `Beat "${bits[2]}" is not a time.`, 'Use a quarter-note number, a fraction like 1/3, or 2t for a triplet.'));
    return;
  }
  if (!Number.isFinite(len) || len <= 0 || len > 2048) {
    errors.push(err(line, 'length', `Length "${bits[3]}" is not a duration.`, 'Length is in quarter notes, greater than 0.'));
    return;
  }
  if (!Number.isFinite(vel) || vel < 0 || vel > 1) {
    errors.push(err(line, 'velocity', `Velocity "${bits[4]}" is outside 0 to 1.`, 'Write a velocity like 0.8.'));
    return;
  }
  if (pan != null && (!Number.isFinite(pan) || pan < -1 || pan > 1)) {
    errors.push(err(line, 'pan', `Pan "${bits[5]}" is outside -1 to 1.`, 'Leave pan off, or use -1 (left) to 1 (right).'));
    return;
  }
  const unpitched = family === 'drum' || family === 'perc';
  const pitchedTom = voice === 'tom' && pitch.kind === 'note';
  if (unpitched && pitch.kind !== 'drum' && !pitchedTom) {
    errors.push(err(line, 'pitch', `${voice} is unpitched. Write x, not ${bits[1]}.`, `Write: ${voice} x ${bits[2]} ${bits[3]} ${bits[4] ?? 0.8}`));
    return;
  }
  if (!unpitched && pitch.kind === 'drum') {
    errors.push(err(line, 'pitch', `${voice} needs a pitch.`, `Write a note like ${voice} ${voice === 'timpani' ? 'D2' : 'A4'}, not x.`));
    return;
  }
  let midis;
  let shown = null;
  if (family === 'drum') {
    midis = [drumMidi(voice, len, pitch)];
    if (pitchedTom) shown = spell(pitch.midi, false);
  } else if (family === 'perc') {
    midis = [KIT_BASE_NOTE];   // the pad is known once every piece the score uses is (percussionKits)
  } else {
    midis = pitch.kind === 'chord' ? pitch.midis : [pitch.midi];
  }
  for (const midi of midis) {
    const note = { line, voice, pitch: unpitched ? (shown || 'x') : spell(midi, false), midi, beat, len, vel, pan };
    if (rep) repeats.push({ note, step: rep.step, until: rep.until, times: rep.times });
    else notes.push(note);
  }
}

function drumMidi(voice, len, pitch) {
  let pad = DRUM_PAD[voice] ?? 0;
  if (voice === 'hat' && len >= 0.2) pad = KIT_PADS.openhat;
  if (voice === 'tom' && pitch.kind === 'note') pad = pitch.midi < 52 ? KIT_PADS.tom : KIT_PADS.hitom;
  return KIT_BASE_NOTE + pad;
}

/** Notes outside an instrument's comfortable range: one warning per voice. */
function warnRanges(notes, warnings) {
  const seen = new Set();
  for (const n of notes) {
    const v = PITCHED[n.voice];
    if (!v || !v.range || seen.has(n.voice)) continue;
    const [lo, hi] = v.range;
    if (n.midi >= lo && n.midi <= hi) continue;
    seen.add(n.voice);
    const where = n.midi < lo ? `below ${n.voice}'s range (lowest ${spell(lo)})` : `above ${n.voice}'s range (highest ${spell(hi)})`;
    warnings.push({ line: 0, field: n.voice, message: `${spell(n.midi)} is ${where}. It still plays.`, fix: n.midi < lo ? 'Move it up an octave, or give it to a lower voice.' : 'Move it down an octave, or give it to a higher voice.' });
  }
}

/** The pad a percussion voice plays on the Kit when there is no Percussion track. */
export function percOnKit(voice) {
  return KIT_BASE_NOTE + (PERC_FALLBACK[voice] ?? 4);
}

export function formatScore(score, flats = FLAT_KEYS.has(score.key)) {
  const lines = [
    `title ${score.title}`,
    `bpm ${score.bpm}`,
    `bars ${score.bars}`,
    `beats ${score.beats}`,
    `key ${score.key}`,
    `mode ${score.mode}`,
  ];
  if (score.style) lines.push(`style ${score.style}`);
  if (score.swing) lines.push(`swing ${score.swing}`);
  if (score.voicing) lines.push(`voicing ${score.voicing}`);
  if (score.cues.length || score.notes.length) lines.push('');
  for (const c of score.cues) lines.push(`cue ${c.name} ${round(c.beat)}`);
  if (score.cues.length && score.notes.length) lines.push('');
  for (const n of score.notes) {
    let pitch;
    if (n.family === 'drum' || n.family === 'perc') pitch = n.voice === 'tom' && n.pitch && n.pitch !== 'x' ? n.pitch : 'x';
    else pitch = spell(n.midi, flats);
    const pan = n.pan != null ? ` ${round(n.pan)}` : '';
    lines.push(`${n.voice} ${pitch} ${round(n.beat)} ${round(n.len)} ${round(n.vel)}${pan}`);
  }
  return lines.join('\n') + '\n';
}

function receipt(ok, errors, warnings, score, text = '') {
  if (!ok || !score) {
    return { ok: false, errors, warnings, score: null, text: '', durationSeconds: 0, noteCount: 0, voices: [], cues: [], hash: '' };
  }
  const spb = 60 / score.bpm;
  const seconds = (beat) => round(beat * spb);
  const cues = score.cues.map((c) => ({ ...c, seconds: seconds(c.beat) }));
  const byVoice = new Map();
  for (const n of score.notes) {
    if (!byVoice.has(n.voice)) byVoice.set(n.voice, { voice: n.voice, family: n.family, notes: 0, ...(n.kit ? { kit: n.kit } : {}) });
    byVoice.get(n.voice).notes += 1;
  }
  return {
    ok: true,
    errors,
    warnings,
    score,
    text,
    durationSeconds: round(score.bars * score.beats * spb),
    noteCount: score.notes.length,
    voices: [...byVoice.values()],
    cues,
    hash: scoreHash(text),
  };
}

export function scoreHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Write a score from { prompt, style, bpm, key, mode, bars, seed, voicing }.
 * Prompt words pick a style when style is omitted (see styleFromPrompt).
 * A number of bpm and "N bars" are read from the prompt. "no drums" drops
 * the kit and percussion. "faster" and "slower" nudge the tempo.
 */
export function compose(input = {}) {
  const src = typeof input === 'string' ? { prompt: input } : { ...input };
  const prompt = String(src.prompt || '');
  const style = src.style || styleFromPrompt(prompt);
  if (!STYLES[style]) {
    return receipt(false, [err(0, 'style', `Style "${style}" is not one Oro writes.`, `Use one of: ${Object.keys(STYLES).join(', ')}.`)], [], null);
  }
  const known = STYLES[style];
  const keyMode = keyFrom(src, prompt, known);
  let bpm = src.bpm != null ? Number(src.bpm) : bpmFrom(prompt, style === 'drums' ? drumTempo(prompt) : known.bpm);
  if (src.bpm == null && /\bfaster\b/i.test(prompt)) bpm += 16;
  if (src.bpm == null && /\bslower\b/i.test(prompt)) bpm -= 16;
  bpm = clamp(Math.round(bpm), LIMITS.bpm[0], LIMITS.bpm[1]);
  const bars = clamp(Math.round(src.bars != null ? Number(src.bars) : barsFrom(prompt, known.bars)), LIMITS.bars[0], LIMITS.bars[1]);
  const seed = Number.isFinite(Number(src.seed)) ? Math.round(Number(src.seed)) : scoreHash(`${style}|${keyMode.key}|${keyMode.mode}|${prompt}`).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const voicing = src.voicing && VOICINGS.includes(String(src.voicing)) ? String(src.voicing) : (known.voicing || '');
  const built = writeStyle(style, { bpm, bars, key: keyMode.key, mode: keyMode.mode, prompt, seed, voicing, title: src.title });
  const checked = check(built.text);
  if (checked.ok && built.warnings) checked.warnings.push(...built.warnings);
  if (/\bno drums\b/i.test(prompt) && checked.ok) {
    checked.score.notes = checked.score.notes.filter((n) => n.family !== 'drum' && n.family !== 'perc');
    checked.warnings.push({ line: 0, field: 'drums', message: 'Drums left out, as the prompt asked.', fix: '' });
    const again = check(formatScore(checked.score));
    again.warnings = checked.warnings.concat(again.warnings);
    return again;
  }
  return checked;
}

/** The style a prompt asks for. */
export function styleFromPrompt(prompt) {
  const p = prompt.toLowerCase();
  const anime = /\b(anime|opening|shonen|shōnen|op)\b/.test(p);
  if (anime && /\b(song|tv[ -]?size|theme|full|chorus|verse|j-?rock|j-?pop)\b/.test(p)) return 'anime-song';
  if (/\b(j-?rock|j-?pop)\b/.test(p)) return 'anime-song';
  if (/\b(opening|anime|shonen|shōnen|name card|title card)\b/.test(p) || /\bop\b/.test(p)) return 'opening';
  if (/\b(lo-?fi|chillhop|study beat)\b/.test(p)) return 'lofi';
  const withDrums = p.replace(/\bno drums?\b/g, '');
  const groove = new RegExp(`\\b(${Object.keys(GROOVES).filter((g) => g !== 'rock' && g !== 'jazz' && g !== 'march').join('|')}|boom ?bap|drum ?(and|&|n) ?bass)\\b`);
  if (groove.test(withDrums) && !/\b(orchestra|strings|brass|song)\b/.test(p)) return 'drums';
  if (/\b(drums?|drum solo|groove|beat|breakbeat|percussion)\b/.test(withDrums) && !/\b(orchestra|strings|brass|sparse)\b/.test(p)) return 'drums';
  if (/\b(ambien\w*|soundscape|rain|ocean|waves|forest|nature|field recording|room tone|atmosphere)\b/.test(p)) return 'ambient';
  if (/\b(epic|trailer|cinematic|battle|hybrid|taiko)\b/.test(p)) return 'epic';
  if (/\b(lullaby|music box|celesta|twinkle|fairy)\b/.test(p)) return 'lullaby';
  if (/\b(all instruments|every voice|all desks|atlas)\b/.test(p)) return 'atlas';
  if (/\b(full orchestra|symphon\w*|tutti)\b/.test(p)) return 'symphonic';
  if (/\bstrings?\b/.test(p) && !/\bbrass\b/.test(p)) return 'strings';
  if (/\b(brass|choir)\b/.test(p)) return 'brass-choir';
  if (/\b(sparse|hazy|air)\b/.test(p)) return 'sparse';
  return 'orchestra-type';
}

function keyFrom(src, prompt, known) {
  if (src.key) {
    const m = String(src.key).match(/^([A-G])([#b]?)$/);
    return { key: m ? m[1] + (m[2] || '') : 'C', mode: src.mode === 'minor' ? 'minor' : (src.mode || 'major') };
  }
  const m = prompt.match(/\b([A-G])([#b])?\s*(minor|major|min|maj)\b/i);
  if (!m) return { key: known.key || 'A', mode: known.mode || 'minor' };
  const mode = /min/i.test(m[3]) ? 'minor' : 'major';
  return { key: m[1].toUpperCase() + (m[2] || ''), mode };
}

function bpmFrom(prompt, fallback) {
  const m = prompt.match(/\b(\d{2,3})\s*bpm\b/i);
  return m ? Number(m[1]) : fallback;
}

function barsFrom(prompt, fallback) {
  const m = prompt.match(/\b(\d+)\s*bars?\b/i);
  return m ? Number(m[1]) : fallback;
}

export { STYLES };
