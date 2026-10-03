// Microtuning (v2.9): built-in tunings, Scala .scl / .kbm import and the
// 128-entry key -> Hz table the engine plays from.
//
// A session's tuning is stored at the root of the state as `tuning` and is
// absent for the default (12-TET with A4 = 440 Hz), so a session that never
// touches it saves exactly as before and the engine keeps its original pitch
// code. Pitch bend, Tune, Fine and the Octave switch are applied on top of
// the tuned key in equal-tempered semitones (an octave is always 2/1).
//
// Mapping without a .kbm: the scale's first degree (1/1) sits on the tuning
// root key in the octave of middle C (C4 = key 60), and every key above or
// below steps one scale degree. A 12-note scale is then pinned so that key
// A4 (69) plays the reference pitch; scales of any other size keep the root
// key at its 12-TET pitch for that reference. A .kbm sets all of this itself
// (key range, middle key, reference key and frequency, the repeating map).

export const MAX_DEGREES = 128;
export const REF_MIN = 400;
export const REF_MAX = 480;
export const REF_DEFAULT = 440;
/** Every tuned key is clamped into this range (Hz). */
export const HZ_MIN = 8;
export const HZ_MAX = 20000;
const MAX_TEXT = 256 * 1024;

const cents = (num, den = 1) => 1200 * Math.log2(num / den);
const edo = (n, period = 1200) => Array.from({ length: n }, (_, i) => (period * (i + 1)) / n);
const ratios = (list) => list.map((r) => { const [a, b] = r.split('/').map(Number); return cents(a, b || 1); });

/**
 * A 12-note circle of fifths from C: `fifths[i]` is the size (cents) of the
 * fifth from the i-th note of the chain C G D A E B F# C# G# D# A# F.
 * Returns the 11 degrees above C plus the octave, in Scala order.
 */
function fromFifths(fifths) {
  const out = new Array(12).fill(0);
  let c = 0;
  for (let i = 0; i < 11; i++) {
    c += fifths[i];
    const pc = (7 * (i + 1)) % 12;
    out[pc] = c - 1200 * Math.floor(c / 1200);
  }
  return [...out.slice(1), 1200];
}

const PURE = cents(3, 2);
const COMMA = cents(531441, 524288); // Pythagorean comma
const QC_FIFTH = 1200 * Math.log2(5) / 4; // a fifth narrowed by a quarter of the syntonic comma

/** Quarter-comma meantone, the usual Eb..G# chain (11 meantone fifths, one wolf). */
function meantone() {
  const out = new Array(12).fill(0);
  for (let k = -3; k <= 8; k++) {
    const c = k * QC_FIFTH;
    out[(((7 * k) % 12) + 12) % 12] = c - 1200 * Math.floor(c / 1200);
  }
  return [...out.slice(1), 1200];
}

/** Built-in tunings: `cents` lists the degrees above 1/1, the last one the period. */
export const TUNINGS = Object.freeze([
  { id: 'equal12', name: '12-TET (equal temperament)', cents: edo(12) },
  { id: 'just5', name: 'Just intonation (5-limit)', cents: ratios(['16/15', '9/8', '6/5', '5/4', '4/3', '45/32', '3/2', '8/5', '5/3', '9/5', '15/8', '2/1']) },
  { id: 'pythagorean', name: 'Pythagorean', cents: ratios(['256/243', '9/8', '32/27', '81/64', '4/3', '729/512', '3/2', '128/81', '27/16', '16/9', '243/128', '2/1']) },
  { id: 'meantone', name: 'Quarter-comma meantone', cents: meantone() },
  // C-G, G-D, D-A and B-F# narrowed by a quarter of the Pythagorean comma, the rest pure
  { id: 'werckmeister3', name: 'Werckmeister III', cents: fromFifths([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (i <= 2 || i === 5 ? PURE - COMMA / 4 : PURE))) },
  { id: 'equal19', name: '19-TET', cents: edo(19) },
  { id: 'equal24', name: '24-TET (quarter tones)', cents: edo(24) },
  { id: 'equal31', name: '31-TET', cents: edo(31) },
  { id: 'bohlenPierce', name: 'Bohlen-Pierce (13 equal steps of 3/1)', cents: edo(13, cents(3)) },
].map((t) => Object.freeze({ ...t, cents: Object.freeze(t.cents) })));
export const TUNING_MAP = Object.freeze(Object.fromEntries(TUNINGS.map((t) => [t.id, t])));

const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function readLines(text, what) {
  if (typeof text !== 'string') throw new Error(`The ${what} file is not text`);
  if (text.length > MAX_TEXT) throw new Error(`The ${what} file is too large`);
  return text.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter((l) => !l.startsWith('!'));
}

/** One Scala pitch: cents when it has a dot, otherwise a ratio (n/d or a whole number). */
function parsePitch(line, n) {
  const tok = line.trim().split(/\s+/)[0] || '';
  if (tok.includes('.')) {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) throw new Error(`Note ${n}: "${tok}" is not a number of cents`);
    const c = Number(tok);
    if (!Number.isFinite(c) || Math.abs(c) > 100000) throw new Error(`Note ${n}: ${tok} cents is out of range`);
    return c;
  }
  const m = /^(\d+)(?:\/(\d+))?$/.exec(tok);
  if (!m) throw new Error(`Note ${n}: "${tok}" is not a ratio or a number of cents`);
  const a = Number(m[1]), b = m[2] === undefined ? 1 : Number(m[2]);
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a / b)) throw new Error(`Note ${n}: ${tok} is not a positive ratio`);
  const c = cents(a, b);
  if (Math.abs(c) > 100000) throw new Error(`Note ${n}: ${tok} is out of range`);
  return c;
}

/**
 * Parse a Scala scale (.scl). Lines starting with "!" are comments; the first
 * other line is the description, the next the number of notes, then one
 * pitch per line (cents if it contains a dot, else a ratio). The unison is
 * implied and the last pitch is the period. Throws an Error with a readable
 * message when the file is not a usable scale.
 * @returns {{name: string, cents: number[]}}
 */
export function parseScl(text, fallbackName = 'Imported scale') {
  const lines = readLines(text, 'scale');
  if (lines.length < 2) throw new Error('This is not a Scala scale: the description and note count are missing');
  const name = lines[0].trim().slice(0, 80) || String(fallbackName || 'Imported scale').slice(0, 80);
  const countTok = lines[1].trim().split(/\s+/)[0];
  if (!/^\d+$/.test(countTok || '')) throw new Error('The note count is not a whole number');
  const count = Number(countTok);
  if (count < 1) throw new Error('The scale has no notes');
  if (count > MAX_DEGREES) throw new Error(`The scale has ${count} notes; up to ${MAX_DEGREES} are supported`);
  const pitches = lines.slice(2).filter((l) => l.trim() !== '');
  if (pitches.length < count) throw new Error(`The scale lists ${pitches.length} of its ${count} notes`);
  const out = pitches.slice(0, count).map((l, i) => parsePitch(l, i + 1));
  if (!(out[count - 1] > 0.5)) throw new Error('The last note (the period, usually 2/1) must be above 1/1');
  return { name, cents: out };
}

/**
 * Parse a Scala keyboard mapping (.kbm): map size, first and last key,
 * middle key (where degree 0 sits), reference key and its frequency, the
 * scale degree that counts as the formal octave, then one entry per map
 * slot (a degree, or "x" for an unmapped key; missing entries are unmapped).
 */
export function parseKbm(text) {
  const lines = readLines(text, 'keyboard map').filter((l) => l.trim() !== '');
  if (lines.length < 7) throw new Error('This is not a Scala keyboard map: its 7 header values are missing');
  const tok = (i) => lines[i].trim().split(/\s+/)[0];
  const int = (i, lo, hi, what) => {
    const t = tok(i);
    if (!/^[-+]?\d+$/.test(t)) throw new Error(`The ${what} is not a whole number`);
    const v = Number(t);
    if (v < lo || v > hi) throw new Error(`The ${what} (${v}) is outside ${lo} to ${hi}`);
    return v;
  };
  const size = int(0, 0, MAX_DEGREES, 'map size');
  const first = int(1, 0, 127, 'first key');
  const last = int(2, 0, 127, 'last key');
  const middle = int(3, 0, 127, 'middle key');
  const refNote = int(4, 0, 127, 'reference key');
  const refHz = Number(tok(5));
  if (!Number.isFinite(refHz) || refHz < 1 || refHz > 100000) throw new Error('The reference frequency is not a frequency in Hz');
  const octave = int(6, 0, 100000, 'octave degree');
  if (first > last) throw new Error('The first key is above the last key');
  const keys = [];
  for (let j = 0; j < size; j++) {
    const t = lines[7 + j] === undefined ? 'x' : tok(7 + j);
    if (t === 'x' || t === 'X') keys.push(-1);
    else if (/^\d+$/.test(t)) keys.push(Number(t));
    else throw new Error(`Map entry ${j + 1}: "${t}" is not a degree or x`);
  }
  if (size > 0 && keys.every((k) => k < 0)) throw new Error('The keyboard map leaves every key unmapped');
  return { size, first, last, middle, refNote, refHz, octave, keys };
}

function sanitizeScale(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.cents)) return null;
  const c = s.cents.slice(0, MAX_DEGREES);
  if (!c.length || !c.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000)) return null;
  if (!(c[c.length - 1] > 0.5)) return null;
  const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 80) : 'Imported scale';
  return { name, cents: c };
}

function sanitizeMap(m) {
  if (!m || typeof m !== 'object') return null;
  const int = (v, lo, hi, d) => Math.round(clamp(finite(v, d), lo, hi));
  const size = int(m.size, 0, MAX_DEGREES, 0);
  const first = int(m.first, 0, 127, 0), last = int(m.last, 0, 127, 127);
  if (first > last) return null;
  const refHz = finite(m.refHz, NaN);
  if (!(refHz >= 1 && refHz <= 100000)) return null;
  const keys = Array.from({ length: size }, (_, j) => {
    const k = Array.isArray(m.keys) ? m.keys[j] : -1;
    return typeof k === 'number' && Number.isFinite(k) && k >= 0 ? Math.round(Math.min(k, 100000)) : -1;
  });
  if (size > 0 && keys.every((k) => k < 0)) return null;
  const out = {
    size, first, last, middle: int(m.middle, 0, 127, 60), refNote: int(m.refNote, 0, 127, 69), refHz,
    octave: int(m.octave, 0, 100000, 0), keys,
  };
  if (typeof m.name === 'string' && m.name.trim()) out.name = m.name.trim().slice(0, 80);
  return out;
}

/**
 * A saved tuning, made safe: null for the default (12-TET, A4 = 440 Hz, no
 * keyboard map) and for anything unusable, else {id, ref, root, scale?, map?}.
 * `root` is the tuning root's pitch class (0 = C), or -1 to follow the
 * global Key.
 */
export function sanitizeTuning(src) {
  if (!src || typeof src !== 'object') return null;
  const ref = Math.round(clamp(finite(src.ref, REF_DEFAULT), REF_MIN, REF_MAX) * 100) / 100;
  const root = Math.round(clamp(finite(src.root, -1), -1, 11));
  let id = typeof src.id === 'string' ? src.id : 'equal12';
  let scale = null;
  if (id === 'scala') {
    scale = sanitizeScale(src.scale);
    if (!scale) id = 'equal12';
  } else if (!TUNING_MAP[id]) id = 'equal12';
  const map = src.map ? sanitizeMap(src.map) : null;
  if (id === 'equal12' && ref === REF_DEFAULT && !map) return null;
  const out = { id, ref, root };
  if (scale) out.scale = scale;
  if (map) out.map = map;
  return out;
}

/** The degrees (cents, last = period) of a sanitized tuning. */
function scaleCents(t) {
  return t && t.id === 'scala' && t.scale ? t.scale.cents : (TUNING_MAP[t && t.id] || TUNINGS[0]).cents;
}

/** Note number -> frequency with A4 = `ref`, the plain 12-TET formula. */
function equal12(n, ref) { return ref * Math.pow(2, (n - 69) / 12); }

/**
 * Frequency (Hz) of every MIDI key 0..127 for a tuning, always a table (the
 * default gives exactly 440 * 2^((n - 69) / 12)). `keyRoot` is the global Key
 * (pitch class), used when the tuning follows it.
 */
export function tuningHz(src, keyRoot = 0) {
  const t = sanitizeTuning(src);
  const out = new Float64Array(128);
  if (!t || (t.id === 'equal12' && !t.map)) {
    const ref = t ? t.ref : REF_DEFAULT;
    for (let n = 0; n < 128; n++) out[n] = equal12(n, ref);
    return out;
  }
  const c = scaleCents(t);
  const N = c.length, period = c[N - 1];
  const degCents = (d) => { const k = Math.floor(d / N), j = d - k * N; return k * period + (j === 0 ? 0 : c[j - 1]); };
  const map = t.map;
  let degreeOf, refKey, refHz;
  if (map) {
    const octDeg = map.octave > 0 ? map.octave : N;
    degreeOf = (key) => {
      if (key < map.first || key > map.last) return null;
      const i = key - map.middle;
      if (map.size === 0) return i;
      const k = Math.floor(i / map.size), d = map.keys[i - k * map.size];
      return d < 0 ? null : d + k * octDeg;
    };
    refKey = map.refNote; refHz = map.refHz;
  } else {
    const middle = 60 + (t.root >= 0 ? t.root : (((Math.round(finite(keyRoot, 0)) % 12) + 12) % 12));
    degreeOf = (key) => key - middle;
    if (N === 12) { refKey = 69; refHz = t.ref; } else { refKey = middle; refHz = equal12(middle, t.ref); }
  }
  let refDeg = degreeOf(refKey);
  if (refDeg === null) refDeg = refKey - (map ? map.middle : 0);
  const refC = degCents(refDeg);
  let any = false;
  for (let n = 0; n < 128; n++) {
    const d = degreeOf(n);
    out[n] = d === null ? NaN : refHz * Math.pow(2, (degCents(d) - refC) / 1200);
    if (d !== null) any = true;
  }
  if (!any) { for (let n = 0; n < 128; n++) out[n] = equal12(n, t.ref); return out; }
  // keys a map leaves out play the nearest mapped key below (or above, below the first)
  let last = NaN;
  for (let n = 0; n < 128; n++) { if (Number.isNaN(out[n])) out[n] = last; else last = out[n]; }
  for (let n = 127; n >= 0; n--) { if (Number.isNaN(out[n])) out[n] = last; else last = out[n]; }
  for (let n = 0; n < 128; n++) out[n] = clamp(out[n], HZ_MIN, HZ_MAX);
  return out;
}

/** The table to send to the engine: null for the default tuning (the engine then keeps its own 12-TET code). */
export function tuningTable(src, keyRoot = 0) {
  return sanitizeTuning(src) ? tuningHz(src, keyRoot) : null;
}

/** Whether the table depends on the global Key (so a Key change must resend it). */
export function tuningFollowsKey(src) {
  const t = sanitizeTuning(src);
  return !!t && !t.map && t.root < 0 && !(t.id === 'equal12');
}

/** Short facts for the UI readout. */
export function describeTuning(src) {
  const t = sanitizeTuning(src);
  const c = scaleCents(t || { id: 'equal12' });
  const name = t && t.id === 'scala' ? t.scale.name : (TUNING_MAP[t ? t.id : 'equal12'] || TUNINGS[0]).name;
  const period = c[c.length - 1];
  const per = Math.abs(period - 1200) < 1e-6 ? 'octave' : `${period.toFixed(1)} cents`;
  return { name, notes: c.length, period, text: `${name}: ${c.length} note${c.length === 1 ? '' : 's'} per ${per}` };
}
