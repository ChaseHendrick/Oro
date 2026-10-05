// Text scores for an agent (skills/oro-music). One land, many desks.
//
// A score is headers, cue marks, and note lines. check() is the contract:
// it returns ok, the errors to fix, and a receipt (seconds, cues, a hash)
// so a caller can match a render to a picture without guessing.
// compose() writes a score from a style or a short prompt. It does not
// call a model. Playback lives in desk.js.

import { KIT_BASE_NOTE } from '../dsp/drum-kit.js';

export const LIMITS = Object.freeze({
  bpm: [40, 220],
  bars: [1, 32],
  beats: [1, 16],
  notes: 2000,
  velocity: [0, 1],
  pan: [-1, 1],
  swing: [0, 0.6],
});

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']);

/** voice -> family. Drums are a kit, not a terrain desk. */
export const VOICES = Object.freeze({
  violin: 'terrain', viola: 'terrain', cello: 'terrain', bass: 'terrain',
  flute: 'terrain', oboe: 'terrain', clarinet: 'terrain', bassoon: 'terrain',
  horn: 'terrain', trumpet: 'terrain', trombone: 'terrain', choir: 'terrain', harp: 'terrain',
  piano: 'physical', guitar: 'physical', marimba: 'physical',
  rhodes: 'fm', bell: 'fm',
  organ: 'additive',
  lead: 'subtractive', clav: 'subtractive',
  sub: 'wavetable',
  pad: 'vector',
  cloud: 'granular',
  kick: 'drum', snare: 'drum', hat: 'drum', clap: 'drum', tom: 'drum',
  ride: 'drum', crash: 'drum', shaker: 'drum', rim: 'drum', timpani: 'drum',
});

export const ALIASES = Object.freeze({
  vln: 'violin', vla: 'viola', vc: 'cello', cb: 'bass',
  fl: 'flute', ob: 'oboe', cl: 'clarinet', bsn: 'bassoon',
  hn: 'horn', tpt: 'trumpet', tbn: 'trombone',
  hp: 'harp', pno: 'piano', gtr: 'guitar', mba: 'marimba',
  ep: 'rhodes', bell: 'bell', org: 'organ',
  bd: 'kick', sd: 'snare', hh: 'hat', cp: 'clap',
});

const CHORDS = Object.freeze({
  maj: [0, 4, 7], min: [0, 3, 7], m: [0, 3, 7],
  dim: [0, 3, 6], aug: [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7],
  '5th': [0, 7],
  '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10],
});

const STYLES = Object.freeze({
  'orchestra-type': { bpm: 156, bars: 4, about: 'Strings in 8ths, brass stabs, a choir pad, hats on 16ths, kick and bass' },
  strings: { bpm: 112, bars: 4, about: 'Strings and bass, no drums' },
  'brass-choir': { bpm: 96, bars: 4, about: 'Horn, trumpet, trombone and choir' },
  sparse: { bpm: 84, bars: 4, about: 'Long tones, little rhythm' },
  atlas: { bpm: 108, bars: 4, about: 'One gesture from every synthesis family' },
  opening: { bpm: 180, bars: 8, about: 'Cold flash, three name-card stabs, eight hits, a title hold. Cues: cold, card-1, card-2, card-3, hits, title' },
});

const DRUM_PAD = Object.freeze({
  kick: 0, snare: 1, hat: 2, clap: 4, tom: 5, rim: 7,
  ride: 3, crash: 4, shaker: 2, timpani: 5,
});

const DRUM_NOTE = Object.freeze({
  ride: 'ride plays the open-hat pad. There is no ride sample.',
  crash: 'crash plays the clap pad. There is no crash sample.',
  shaker: 'shaker plays the closed-hat pad. There is no shaker sample.',
  timpani: 'timpani plays the low-tom pad. The pitch is not tuned.',
});

const DEFAULT_OCTAVE = Object.freeze({
  terrain: 4, physical: 3, fm: 4, additive: 4, subtractive: 4, wavetable: 2, vector: 4, granular: 4, drum: 3,
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const round = (n) => Math.round(n * 1000) / 1000;

function pcOf(letter, acc) {
  let n = LETTER[letter];
  if (acc === '#') n += 1;
  if (acc === 'b') n -= 1;
  return (n + 12) % 12;
}

function spell(midi, flats) {
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
    limits: LIMITS,
    voices: Object.keys(VOICES),
    aliases: ALIASES,
    families: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, v])),
    drums: {
      pitch: 'x',
      openHat: 'hat length of 0.2 quarters or more',
      pads: 'kick snare closed-hat open-hat clap low-tom high-tom rim, MIDI 36 to 43',
      notSamples: Object.keys(DRUM_NOTE),
    },
    chords: Object.keys(CHORDS),
    styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.about])),
    time: 'Quarter notes from 0. A number, a fraction (1/3), or Nt / Ntt for one or two triplet eighths after beat N.',
    cues: 'cue NAME BEAT. The receipt gives that beat in seconds.',
    headers: ['title', 'bpm', 'bars', 'beats', 'key', 'mode', 'style', 'swing'],
    note: 'voice pitch beat length velocity [pan]',
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

function resolveVoice(tok) {
  const key = String(tok || '').toLowerCase();
  if (VOICES[key]) return key;
  if (ALIASES[key]) return ALIASES[key];
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
  const chord = tok.match(/^([A-G])([#b]?)(maj7|min7|m7b5|sus2|sus4|maj|min|dim|aug|5th|7|m)(\d)?$/);
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
    title: 'Untitled', bpm: 120, bars: 4, beats: 4, key: 'C', mode: 'major', style: '', swing: 0,
  };
  const cues = [];
  const notes = [];
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
      pushNote(line, bits, notes, errors);
      continue;
    }
    if (HEADER.has(word) && bits.length >= 2) {
      applyHeader(word, bits.slice(1).join(' '), line, head, errors);
      continue;
    }
    errors.push(err(line, 'line', `Could not read "${text}".`, 'A header (bpm 180), a cue (cue title 12), or a note (violin A4 0 0.5 0.8).'));
  }

  if (!errors.length) {
    const end = head.bars * head.beats;
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
    })).sort((a, b) => a.beat - b.beat || a.voice.localeCompare(b.voice) || a.midi - b.midi),
  };
  warnDrums(score.notes, warnings);
  const text = formatScore(score, flats);
  return receipt(true, [], warnings, score, text);
}

const HEADER = new Set(['title', 'bpm', 'bars', 'beats', 'key', 'mode', 'style', 'swing']);

function sourceLines(raw, errors) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return jsonLines(raw, errors);
  if (typeof raw !== 'string' || !raw.trim()) {
    errors.push(err(0, 'score', 'The score is empty.', 'Send a text score, or a JSON score with notes.'));
    return null;
  }
  const out = [];
  raw.split(/\r?\n/).forEach((row, i) => {
    const text = row.trim();
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
  const push = (line, text) => rows.push({ line, text });
  if (obj.title) push(0, `title ${obj.title}`);
  if (obj.bpm != null) push(0, `bpm ${obj.bpm}`);
  if (obj.bars != null) push(0, `bars ${obj.bars}`);
  if (obj.beats != null) push(0, `beats ${obj.beats}`);
  if (obj.key) push(0, `key ${obj.key}`);
  if (obj.mode) push(0, `mode ${obj.mode}`);
  if (obj.style) push(0, `style ${obj.style}`);
  if (obj.swing != null) push(0, `swing ${obj.swing}`);
  (obj.cues || []).forEach((c, i) => push(i + 1, `cue ${c.name} ${c.beat}`));
  obj.notes.forEach((n, i) => {
    const len = n.len ?? n.length;
    const vel = n.vel ?? n.velocity ?? 0.8;
    const pan = n.pan != null ? ` ${n.pan}` : '';
    push(i + 1, `${n.voice} ${n.pitch} ${n.beat} ${len} ${vel}${pan}`);
  });
  return rows;
}

function applyHeader(word, value, line, head, errors) {
  if (word === 'title') {
    head.title = value.slice(0, 80);
    return;
  }
  if (word === 'key') {
    const m = value.match(/^([A-G])([#b]?)$/);
    if (!m) errors.push(err(line, 'key', `Key "${value}" is not a note name.`, 'Use a name like A, Bb or F#.'));
    else head.key = m[1] + (m[2] || '');
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
  const n = num(value);
  const lim = word === 'bpm' ? LIMITS.bpm : word === 'bars' ? LIMITS.bars : word === 'beats' ? LIMITS.beats : LIMITS.swing;
  if (!Number.isFinite(n)) {
    errors.push(err(line, word, `${word} needs a number.`, `Write ${word} ${lim[0]}.`));
    return;
  }
  if (n < lim[0] || n > lim[1]) {
    errors.push(err(line, word, `${word} ${n} is outside ${lim[0]} to ${lim[1]}.`, `Keep ${word} between ${lim[0]} and ${lim[1]}.`));
    return;
  }
  head[word] = word === 'swing' || word === 'bpm' ? n : Math.round(n);
}

function pushNote(line, bits, notes, errors) {
  const voice = resolveVoice(bits[0]);
  const pitch = parsePitch(bits[1], voice);
  const beat = parseBeat(bits[2]);
  const len = num(bits[3]);
  const vel = bits[4] == null ? 0.8 : num(bits[4]);
  const pan = bits[5] == null ? null : num(bits[5]);
  if (!pitch || pitch.error === 'pitch') {
    errors.push(err(line, 'pitch', `"${bits[1]}" is not a pitch or a chord.`, 'Write A4, or a chord like Cmaj, Cm, C7, Cmaj7. A bare C is not enough.'));
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
  if (!Number.isFinite(len) || len <= 0 || len > 64) {
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
  if (VOICES[voice] === 'drum' && pitch.kind !== 'drum' && voice !== 'tom') {
    errors.push(err(line, 'pitch', `${voice} is unpitched. Write x, not ${bits[1]}.`, `Write: ${voice} x ${bits[2]} ${bits[3]} ${bits[4] ?? 0.8}`));
    return;
  }
  if (VOICES[voice] !== 'drum' && pitch.kind === 'drum') {
    errors.push(err(line, 'pitch', `${voice} needs a pitch.`, `Write a note like ${voice} A4, not x.`));
    return;
  }
  const midis = pitch.kind === 'chord' ? pitch.midis : [pitch.kind === 'note' ? pitch.midi : drumMidi(voice, len, pitch)];
  for (const midi of midis) {
    notes.push({ line, voice, pitch: pitch.kind === 'drum' ? 'x' : spell(midi, false), midi, beat, len, vel, pan });
  }
}

function drumMidi(voice, len, pitch) {
  let pad = DRUM_PAD[voice] ?? 0;
  if (voice === 'hat' && len >= 0.2) pad = 3;
  if (voice === 'tom' && pitch.kind === 'note') pad = pitch.midi < 52 ? 5 : 6;
  return KIT_BASE_NOTE + pad;
}

function warnDrums(notes, warnings) {
  const seen = new Set();
  for (const n of notes) {
    if (!DRUM_NOTE[n.voice] || seen.has(n.voice)) continue;
    seen.add(n.voice);
    warnings.push({ line: 0, field: n.voice, message: DRUM_NOTE[n.voice], fix: 'Use hat, clap, tom or rim when the pad matters.' });
  }
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
  if (score.cues.length || score.notes.length) lines.push('');
  for (const c of score.cues) lines.push(`cue ${c.name} ${round(c.beat)}`);
  if (score.cues.length && score.notes.length) lines.push('');
  for (const n of score.notes) {
    const pitch = n.family === 'drum' ? 'x' : spell(n.midi, flats);
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
    if (!byVoice.has(n.voice)) byVoice.set(n.voice, { voice: n.voice, family: n.family, notes: 0 });
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
 * Write a score from { prompt, style, bpm, key, mode, bars }.
 * Prompt words pick a style when style is omitted: opening, atlas, strings,
 * brass, sparse. A number of bpm and "N bars" are read from the prompt.
 * "no drums" drops the kit. "faster" and "slower" nudge the tempo.
 */
export function compose(input = {}) {
  const src = typeof input === 'string' ? { prompt: input } : { ...input };
  const prompt = String(src.prompt || '');
  const style = src.style || styleFromPrompt(prompt);
  if (!STYLES[style]) {
    return receipt(false, [err(0, 'style', `Style "${style}" is not one Oro writes.`, `Use one of: ${Object.keys(STYLES).join(', ')}.`)], [], null);
  }
  const known = STYLES[style];
  const keyMode = keyFrom(src, prompt);
  let bpm = src.bpm != null ? Number(src.bpm) : bpmFrom(prompt, known.bpm);
  if (src.bpm == null && /\bfaster\b/i.test(prompt)) bpm += 16;
  if (src.bpm == null && /\bslower\b/i.test(prompt)) bpm -= 16;
  bpm = clamp(Math.round(bpm), LIMITS.bpm[0], LIMITS.bpm[1]);
  const bars = clamp(Math.round(src.bars != null ? Number(src.bars) : barsFrom(prompt, known.bars)), LIMITS.bars[0], LIMITS.bars[1]);
  const built = writeStyle(style, { bpm, bars, key: keyMode.key, mode: keyMode.mode, prompt });
  const checked = check(built);
  if (/\bno drums\b/i.test(prompt) && checked.ok) {
    checked.score.notes = checked.score.notes.filter((n) => n.family !== 'drum');
    checked.warnings.push({ line: 0, field: 'drums', message: 'Drums left out, as the prompt asked.', fix: '' });
    const again = check(formatScore(checked.score));
    again.warnings = checked.warnings.concat(again.warnings);
    return again;
  }
  return checked;
}

function styleFromPrompt(prompt) {
  const p = prompt.toLowerCase();
  if (/\b(opening|anime|shonen|shōnen|name card|title card)\b/.test(p) || /\bop\b/.test(p)) return 'opening';
  if (/\b(all instruments|every voice|all desks|atlas)\b/.test(p)) return 'atlas';
  if (/\bstrings?\b/.test(p) && !/\bbrass\b/.test(p)) return 'strings';
  if (/\b(brass|choir)\b/.test(p)) return 'brass-choir';
  if (/\b(sparse|ambient|hazy|air)\b/.test(p)) return 'sparse';
  return 'orchestra-type';
}

function keyFrom(src, prompt) {
  if (src.key) {
    const m = String(src.key).match(/^([A-G])([#b]?)$/);
    return { key: m ? m[1] + (m[2] || '') : 'C', mode: src.mode === 'minor' ? 'minor' : (src.mode || 'major') };
  }
  const m = prompt.match(/\b([A-G])([#b])?\s*(minor|major|min|maj)\b/i);
  if (!m) return { key: 'A', mode: 'minor' };
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

function writeStyle(style, o) {
  const pc = pcOf(o.key[0], o.key[1] || '');
  const third = o.mode === 'minor' ? 3 : 4;
  const fifth = 7;
  const notes = [];
  const cues = [];
  const add = (voice, midi, beat, len, vel) => notes.push({ voice, midi, beat, len, vel });
  const chord = (voice, oct, beat, len, vel) => {
    add(voice, midiOf(pc, oct), beat, len, vel);
    add(voice, midiOf(pc, oct) + third, beat, len, vel * 0.9);
    add(voice, midiOf(pc, oct) + fifth, beat, len, vel * 0.85);
  };

  if (style === 'opening') fillOpening(o, add, chord, cues);
  else if (style === 'strings') fillStrings(o, add, chord);
  else if (style === 'brass-choir') fillBrass(o, add, chord);
  else if (style === 'sparse') fillSparse(o, add);
  else if (style === 'atlas') fillAtlas(o, add, chord);
  else fillOrchestra(o, add, chord);

  const endBeat = o.bars * 4;
  const kept = [];
  for (const n of notes) {
    if (n.beat >= endBeat) continue;
    if (n.beat + n.len > endBeat) n.len = Math.max(0.05, endBeat - n.beat - 0.01);
    if (n.len > 0) kept.push(n);
  }

  const score = {
    title: style === 'opening' ? 'Opening' : style,
    bpm: o.bpm,
    bars: o.bars,
    beats: 4,
    key: o.key,
    mode: o.mode,
    style,
    swing: 0,
    cues: cues.filter((c) => c.beat >= 0 && c.beat <= endBeat),
    notes: kept.map((n) => ({
      voice: n.voice,
      family: VOICES[n.voice],
      pitch: 'x',
      midi: n.midi,
      beat: round(n.beat),
      len: round(n.len),
      vel: round(n.vel),
    })),
  };
  return formatScore(score);
}

function fillOpening(o, add, chord, cues) {
  const end = o.bars * 4;
  let cold = 0;
  let cards = [];
  let hits = null;
  let title = null;
  if (o.bars >= 8) {
    cards = [4, 8, 12];
    hits = 16;
    title = 24;
  } else if (o.bars >= 4) {
    cards = [2, 4, 6];
    hits = 8;
    title = 12;
  }
  cues.push({ name: 'cold', beat: cold });
  add('violin', midiOf(pcOf(o.key[0], o.key[1] || ''), 5), cold, 0.25, 0.9);
  add('rim', KIT_BASE_NOTE + 7, cold, 0.1, 0.7);
  cards.forEach((beat, i) => {
    if (beat >= end) return;
    cues.push({ name: `card-${i + 1}`, beat });
    chord('trumpet', 4, beat, 0.45, 0.88);
    add('kick', KIT_BASE_NOTE, beat, 0.15, 1);
  });
  if (hits != null && hits + 4 <= end) {
    cues.push({ name: 'hits', beat: hits });
    for (let i = 0; i < 8; i++) {
      const beat = hits + i * 0.5;
      add('kick', KIT_BASE_NOTE, beat, 0.12, i % 2 === 0 ? 1 : 0.75);
      if (i % 2 === 1) add('snare', KIT_BASE_NOTE + 1, beat, 0.12, 0.85);
      add('trumpet', midiOf(pcOf(o.key[0], o.key[1] || ''), 4), beat, 0.2, 0.7);
    }
  }
  if (title != null && title < end) {
    cues.push({ name: 'title', beat: title });
    const len = end - title - 0.05;
    chord('choir', 4, title, len, 0.6);
    add('violin', midiOf(pcOf(o.key[0], o.key[1] || ''), 5), title, len, 0.55);
    add('bass', midiOf(pcOf(o.key[0], o.key[1] || ''), 2), title, len, 0.7);
  }
}

function fillOrchestra(o, add, chord) {
  const root = pcOf(o.key[0], o.key[1] || '');
  const scale = o.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  for (let bar = 0; bar < o.bars; bar++) {
    const b = bar * 4;
    add('kick', KIT_BASE_NOTE, b, 0.15, 1);
    add('kick', KIT_BASE_NOTE, b + 2, 0.15, 0.9);
    add('snare', KIT_BASE_NOTE + 1, b + 2, 0.12, 0.8);
    for (let s = 0; s < 16; s++) add('hat', KIT_BASE_NOTE + 2, b + s * 0.25, 0.06, 0.35);
    for (let s = 0; s < 8; s++) {
      const deg = scale[(bar * 2 + s) % scale.length];
      add('violin', midiOf(root, 5) + deg, b + s * 0.5, 0.4, 0.6);
    }
    add('bass', midiOf(root, 2) + (bar % 2 === 0 ? 0 : 5), b, 1.8, 0.75);
    chord('trumpet', 4, b, 0.4, 0.55);
    if (bar % 2 === 0) chord('choir', 4, b, 3.5, 0.4);
  }
}

function fillStrings(o, add, chord) {
  for (let bar = 0; bar < o.bars; bar++) {
    const b = bar * 4;
    chord('violin', 5, b, 3.5, 0.55);
    chord('viola', 4, b, 3.5, 0.45);
    add('cello', midiOf(pcOf(o.key[0], o.key[1] || ''), 3), b, 3.5, 0.6);
    add('bass', midiOf(pcOf(o.key[0], o.key[1] || ''), 2), b, 3.5, 0.7);
  }
}

function fillBrass(o, add, chord) {
  for (let bar = 0; bar < o.bars; bar++) {
    const b = bar * 4;
    chord('horn', 3, b, 3.2, 0.55);
    chord('trumpet', 4, b + (bar % 2) * 2, 1.2, 0.6);
    add('trombone', midiOf(pcOf(o.key[0], o.key[1] || ''), 3), b, 3.2, 0.6);
    chord('choir', 4, b, 3.6, 0.4);
  }
}

function fillSparse(o, add) {
  const root = midiOf(pcOf(o.key[0], o.key[1] || ''), 4);
  add('pad', root, 0, o.bars * 4 - 0.1, 0.45);
  add('choir', root + (o.mode === 'minor' ? 3 : 4), 0, o.bars * 4 - 0.1, 0.35);
  add('bell', root + 12, o.bars * 2, 2, 0.4);
}

function fillAtlas(o, add, chord) {
  const b = [0, 4, 8, 12].map((x) => Math.min(x, Math.max(0, o.bars * 4 - 1)));
  chord('piano', 3, b[0], 3, 0.7);
  add('guitar', midiOf(pcOf(o.key[0], o.key[1] || ''), 2), b[0], 1.2, 0.65);
  add('rhodes', midiOf(pcOf(o.key[0], o.key[1] || ''), 4) + 5, b[1] || b[0], 2, 0.6);
  add('organ', midiOf(pcOf(o.key[0], o.key[1] || ''), 4), b[1] || b[0], 2, 0.5);
  add('marimba', midiOf(pcOf(o.key[0], o.key[1] || ''), 5), b[2] || b[0], 0.4, 0.7);
  add('lead', midiOf(pcOf(o.key[0], o.key[1] || ''), 4) + 7, b[2] || b[0], 1.2, 0.6);
  add('sub', midiOf(pcOf(o.key[0], o.key[1] || ''), 2), b[2] || b[0], 2, 0.75);
  add('pad', midiOf(pcOf(o.key[0], o.key[1] || ''), 4), b[3] || b[0], 2, 0.4);
  add('cloud', midiOf(pcOf(o.key[0], o.key[1] || ''), 4) + 3, b[3] || b[0], 2, 0.35);
  add('bell', midiOf(pcOf(o.key[0], o.key[1] || ''), 5) + 7, (b[3] || b[0]) + 1, 1, 0.5);
  add('kick', KIT_BASE_NOTE, b[0], 0.15, 1);
  add('hat', KIT_BASE_NOTE + 2, b[0] + 0.5, 0.06, 0.3);
}
