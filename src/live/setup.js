// Live performance mode (2.12): the saved live setup and the pure helpers
// around it (no DOM, no audio), so they can be tested in Node.
//
// The setup is saved with the session as the optional top-level `live` key:
//
//   live = {
//     pads:       16 x (pad | null)   absent: build the pads from the session (defaultPads)
//     setlist:    [entry]             absent: no songs
//     lock:       1                   absent: unlocked
//     songChange: 'confirm' | 'now'   absent: 'bar' (song changes wait for the next bar)
//     backdrop:   'map' | 'off'       absent: 'dim' (the 3D map, dimmed)
//     look:       'app'               absent: 'dark' (live mode's own dark, high-contrast colours)
//   }
//
//   pad   = { type, label, color, quant: 'off' | 'beat' | 'bar', ...fields of the type }
//   entry = { kind: 'scene' | 'version', ref, name, key, tempo, cues }
//
// Tracks and patterns are referred to by position (track 1, pattern 2), so a
// pad keeps working when a setlist loads another song with its own tracks.
// A session that never used live mode has no `live` key at all, so saved
// sessions, scenes and the defaults are unchanged.

import { PART_COLORS, NOTE_NAMES, SCALES, SCALE_NAMES, MAX_PARTS, MAX_PATTERNS, clamp } from '../core/params.js';
import { KIT_PADS } from '../dsp/drum-kit.js';
import { SMART_KNOBS } from '../core/smart.js';

export const PAD_COUNT = 16;
export const PAD_COLS = 4;
export const SETLIST_MAX = 64;
export const NOTES_MAX = 8;
export const PAD_TYPES = Object.freeze(['scene', 'section', 'pattern', 'mute', 'solo', 'drum', 'note', 'macros', 'smart']);
export const PAD_TYPE_LABEL = Object.freeze({
  scene: 'Scene', section: 'Section (pattern on every track)', pattern: 'Pattern on a track', mute: 'Track mute', solo: 'Track solo',
  drum: 'Drum pad', note: 'Note or chord', macros: 'Macro preset', smart: 'Smart control preset',
});
export const QUANTS = Object.freeze(['off', 'beat', 'bar']);
export const QUANT_LABEL = Object.freeze({ off: 'Off', beat: 'Beat', bar: 'Bar' });
/** Beats per quantise step (4/4 bars). */
export const QUANT_BEATS = Object.freeze({ beat: 1, bar: 4 });
export const SONG_CHANGES = Object.freeze(['bar', 'confirm', 'now']);
export const BACKDROPS = Object.freeze(['map', 'dim', 'off']);
export const PAD_COLORS = PART_COLORS;
// Default keys: 1 to 0, then Q to Y (the first 16 of 1-0 and Q-P).
export const PAD_CODES = Object.freeze(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY']);
export const PAD_KEY_LABELS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Q', 'W', 'E', 'R', 'T', 'Y']);

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, max) : '');
const int = (v, lo, hi, d) => Math.round(clamp(num(v, d), lo, hi));
const round4 = (v) => Math.round(v * 10000) / 10000;

/** What a pad does by default for each type: scenes and patterns wait for the bar. */
export function defaultQuant(type) {
  return type === 'scene' || type === 'section' || type === 'pattern' ? 'bar' : 'off';
}

/** Kinds of action: 'seq' changes what the sequencer plays (applied a little ahead of the boundary), 'now' sounds at once. */
export function actionKind(type) {
  return type === 'scene' || type === 'section' || type === 'pattern' || type === 'song' ? 'seq' : 'now';
}

function trackRef(v, allowSel) {
  if (allowSel && (v === 'sel' || v == null)) return 'sel';
  return int(v, 0, MAX_PARTS - 1, 0);
}

/** One pad, cleaned, or null for an empty or unknown pad. */
export function sanitizePad(src) {
  if (!src || typeof src !== 'object' || !PAD_TYPES.includes(src.type)) return null;
  const type = src.type;
  const color = typeof src.color === 'string' && /^#[0-9a-f]{6}$/i.test(src.color) ? src.color.toLowerCase() : PAD_COLORS[0];
  const out = { type, label: str(src.label, 24).trim(), color, quant: QUANTS.includes(src.quant) ? src.quant : defaultQuant(type) };
  switch (type) {
    case 'scene': {
      const scene = str(src.scene, 80);
      if (!scene) return null;
      out.scene = scene;
      break;
    }
    case 'section': out.pattern = int(src.pattern, 0, MAX_PATTERNS - 1, 0); break;
    case 'pattern': out.track = trackRef(src.track, false); out.pattern = int(src.pattern, 0, MAX_PATTERNS - 1, 0); break;
    case 'mute': case 'solo': out.track = trackRef(src.track, false); break;
    case 'drum': out.track = trackRef(src.track, false); out.pad = int(src.pad, 0, KIT_PADS - 1, 0); out.vel = round4(clamp(num(src.vel, 0.9), 0.05, 1)); break;
    case 'note': {
      const notes = (Array.isArray(src.notes) ? src.notes : []).map(n => num(n, NaN)).filter(n => n >= 0 && n <= 127).map(Math.round);
      const uniq = [...new Set(notes)].slice(0, NOTES_MAX);
      if (!uniq.length) return null;
      out.track = trackRef(src.track, true);
      out.notes = uniq;
      out.vel = round4(clamp(num(src.vel, 0.8), 0.05, 1));
      break;
    }
    case 'macros': out.values = Array.from({ length: 4 }, (_, i) => round4(clamp(num(Array.isArray(src.values) ? src.values[i] : 0, 0), 0, 1))); break;
    case 'smart': {
      out.track = trackRef(src.track, true);
      out.values = Array.from({ length: SMART_KNOBS }, (_, i) => {
        const v = Array.isArray(src.values) ? src.values[i] : null;
        return typeof v === 'number' && Number.isFinite(v) ? round4(clamp(v, 0, 1)) : null;
      });
      if (out.values.every(v => v == null)) return null;
      break;
    }
    default: return null;
  }
  return out;
}

/** One setlist entry, cleaned, or null. */
export function sanitizeEntry(src) {
  if (!src || typeof src !== 'object') return null;
  const kind = src.kind === 'version' ? 'version' : src.kind === 'scene' ? 'scene' : null;
  const ref = str(src.ref, 80);
  if (!kind || !ref) return null;
  const tempo = num(src.tempo, 0);
  return {
    kind, ref,
    name: str(src.name, 60).trim() || 'Untitled song',
    key: str(src.key, 24).trim(),
    tempo: tempo >= 20 && tempo <= 400 ? Math.round(tempo * 10) / 10 : 0,
    cues: str(src.cues, 400),
  };
}

/** The saved live setup, cleaned; null when it holds nothing but defaults (the key is then left out). */
export function sanitizeLive(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  if (Array.isArray(src.pads)) out.pads = Array.from({ length: PAD_COUNT }, (_, i) => sanitizePad(src.pads[i]));
  const setlist = (Array.isArray(src.setlist) ? src.setlist : []).map(sanitizeEntry).filter(Boolean).slice(0, SETLIST_MAX);
  if (setlist.length) out.setlist = setlist;
  if (src.lock === 1 || src.lock === true) out.lock = 1;
  if (src.songChange === 'confirm' || src.songChange === 'now') out.songChange = src.songChange;
  if (src.backdrop === 'map' || src.backdrop === 'off') out.backdrop = src.backdrop;
  if (src.look === 'app') out.look = 'app';
  return Object.keys(out).length ? out : null;
}

/** The live setup with every field filled in (for reading; write with sanitizeLive). */
export function readLive(raw) {
  const s = sanitizeLive(raw) || {};
  return {
    pads: s.pads || null,
    setlist: s.setlist || [],
    lock: s.lock ? 1 : 0,
    songChange: s.songChange || 'bar',
    backdrop: s.backdrop || 'dim',
    look: s.look || 'dark',
  };
}

/** Merge `patch` into the saved setup and clean it (null when it is back to defaults). */
export function patchLive(raw, patch) {
  const cur = readLive(raw);
  const next = { ...cur, ...patch };
  if (!next.pads) delete next.pads;
  return sanitizeLive(next);
}

// ------------------------------------------------------------ default pads

const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

/** Parse "C4 E4 G4" (or MIDI numbers) into notes; unknown words are skipped. */
export function parseNotes(text) {
  const out = [];
  for (const word of String(text || '').split(/[\s,]+/)) {
    if (!word) continue;
    if (/^\d{1,3}$/.test(word)) { const n = Number(word); if (n <= 127) out.push(n); continue; }
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(word);
    if (!m) continue;
    const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    const n = 12 * (Number(m[3]) + 1) + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    if (n >= 0 && n <= 127) out.push(n);
  }
  return [...new Set(out)].slice(0, NOTES_MAX);
}

export function formatNotes(notes) {
  return (Array.isArray(notes) ? notes : []).map(noteName).join(' ');
}

/** A triad on scale degree `deg` (0-based) of the key, around octave 4. */
export function scaleTriad(root, scaleType, deg, octave = 4) {
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Major;
  const n = scale.length;
  const at = (d) => 12 * (octave + 1 + Math.floor(d / n)) + root + scale[((d % n) + n) % n];
  return [at(deg), at(deg + 2), at(deg + 4)];
}

/** A chord's name from its notes ("C", "Am", "Bdim"), or its root note name. */
export function chordName(notes) {
  if (!Array.isArray(notes) || !notes.length) return '';
  const r = notes[0];
  const name = NOTE_NAMES[((r % 12) + 12) % 12];
  if (notes.length !== 3) return notes.length === 1 ? noteName(r) : name;
  const a = notes[1] - r, b = notes[2] - r;
  if (a === 4 && b === 7) return name;
  if (a === 3 && b === 7) return `${name}m`;
  if (a === 3 && b === 6) return `${name}dim`;
  if (a === 4 && b === 8) return `${name}aug`;
  return name;
}

/**
 * Sixteen pads built from what the session has:
 *   row 1  your saved scenes, then sections (pattern N on every track) the session has;
 *   row 2  mutes of tracks 1 to 4;
 *   row 3  the first four pads of the first drum kit track, otherwise four chords in the key;
 *   row 4  the selected track's patterns 1 to 4.
 * `state` is the store root ({ parts, global, ui }); `scenes` the user's scenes [{ id, name }].
 */
export function defaultPads(state, scenes = []) {
  const parts = Array.isArray(state && state.parts) ? state.parts : [];
  const g = (state && state.global) || {};
  const sel = clamp(Math.round(num(state && state.ui && state.ui.selectedPart, 0)), 0, Math.max(0, parts.length - 1));
  const color = (i) => PAD_COLORS[i % PAD_COLORS.length];
  const trackColor = (t) => (parts[t] && /^#[0-9a-f]{6}$/i.test(parts[t].color) ? parts[t].color.toLowerCase() : color(t));
  const pads = Array(PAD_COUNT).fill(null);

  // Row 1: scenes, then sections.
  const row1 = [];
  for (const s of scenes) {
    if (row1.length >= 4) break;
    if (s && typeof s.id === 'string') row1.push({ type: 'scene', scene: s.id, label: str(s.name, 24) || 'Scene', color: color(row1.length + 2), quant: 'bar' });
  }
  const maxPatterns = parts.reduce((m, p) => Math.max(m, Array.isArray(p && p.patterns) ? p.patterns.length : 0), 0);
  for (let k = 0; row1.length < 4 && k < maxPatterns && maxPatterns > 1; k++) {
    row1.push({ type: 'section', pattern: k, label: `Section ${k + 1}`, color: color(row1.length + 2), quant: 'bar' });
  }
  row1.forEach((p, i) => { pads[i] = p; });

  // Row 2: track mutes.
  for (let t = 0; t < Math.min(4, parts.length); t++) {
    pads[4 + t] = { type: 'mute', track: t, label: `Mute ${str(parts[t].name, 16) || `Track ${t + 1}`}`, color: trackColor(t), quant: 'off' };
  }

  // Row 3: drum pads of a kit track, else chords in the key.
  const kit = parts.findIndex(p => p && p.drum && p.drum.on);
  if (kit >= 0) {
    const kitPads = (parts[kit].drum && Array.isArray(parts[kit].drum.pads)) ? parts[kit].drum.pads : [];
    for (let k = 0; k < 4; k++) {
      pads[8 + k] = { type: 'drum', track: kit, pad: k, vel: 0.9, label: str(kitPads[k] && kitPads[k].name, 24) || `Pad ${k + 1}`, color: trackColor(kit), quant: 'off' };
    }
  } else if (parts.length) {
    const root = int(g.scaleRoot, 0, 11, 0), scaleType = int(g.scaleType, 0, SCALE_NAMES.length - 1, 0);
    const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Major;
    // I, IV, V, vi in seven-note scales; the first four degrees otherwise.
    const degrees = scale.length === 7 ? [0, 3, 4, 5] : [0, 1, 2, 3];
    degrees.forEach((d, k) => {
      const notes = scaleTriad(root, scaleType, d, 4);
      pads[8 + k] = { type: 'note', track: 'sel', notes, vel: 0.8, label: chordName(notes), color: color(8 + k), quant: 'off' };
    });
  }

  // Row 4: the selected track's patterns.
  const own = parts[sel] && Array.isArray(parts[sel].patterns) ? parts[sel].patterns : [];
  for (let k = 0; k < Math.min(4, own.length); k++) {
    pads[12 + k] = { type: 'pattern', track: sel, pattern: k, label: str(own[k] && own[k].name, 24) || `Pattern ${k + 1}`, color: trackColor(sel), quant: 'bar' };
  }
  return pads.map(sanitizePad);
}

// ---------------------------------------------------------------- setlist

/** Index after moving `dir` from `pos` in a list of `n` songs (stays inside; -1 before the first). */
export function stepSetlist(pos, dir, n) {
  if (!(n > 0)) return -1;
  const p = Number.isInteger(pos) ? pos : -1;
  return clamp(p + (dir < 0 ? -1 : 1), 0, n - 1);
}

/** The "Now" and "Next" songs for position `pos` (-1: nothing loaded yet). */
export function nowNext(setlist, pos) {
  const list = Array.isArray(setlist) ? setlist : [];
  const now = pos >= 0 && pos < list.length ? list[pos] : null;
  const nextIdx = pos + 1;
  return { now, next: nextIdx >= 0 && nextIdx < list.length ? list[nextIdx] : null, nextIndex: nextIdx < list.length ? nextIdx : -1 };
}

/** Move setlist item `i` by `dir` (-1 up, 1 down): a new array. */
export function moveEntry(list, i, dir) {
  const out = list.slice();
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// -------------------------------------------------------------- tap tempo

/**
 * Tap tempo: tap() returns the tempo from the average of the last few gaps
 * (rounded, within min..max), or null until there are two taps. A pause of
 * more than `resetMs` starts again.
 */
export function createTapTempo({ now = () => Date.now(), keep = 4, resetMs = 2000, min = 40, max = 240 } = {}) {
  let taps = [];
  return {
    tap() {
      const t = now();
      if (taps.length && t - taps[taps.length - 1] > resetMs) taps = [];
      taps.push(t);
      if (taps.length > keep + 1) taps.shift();
      if (taps.length < 2) return null;
      const span = taps[taps.length - 1] - taps[0];
      const gap = span / (taps.length - 1);
      if (!(gap > 0)) return null;
      return clamp(Math.round(60000 / gap), min, max);
    },
    reset() { taps = []; },
    count: () => taps.length,
  };
}

// --------------------------------------------------------------- keyboard

/**
 * The live mode action for a key press, or null:
 *   { kind: 'pad', index } | { kind: 'play' } | { kind: 'next' } | { kind: 'prev' } | { kind: 'exit' }
 * Keys with Ctrl, Cmd or Alt are left alone (undo still works).
 */
export function liveKeyAction(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return { kind: 'exit' };
  if (e.shiftKey) return e.code === 'KeyL' ? { kind: 'exit' } : null;
  if (e.code === 'Space' || e.key === ' ') return { kind: 'play' };
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return { kind: 'next' };
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return { kind: 'prev' };
  const i = PAD_CODES.indexOf(e.code);
  return i >= 0 ? { kind: 'pad', index: i } : null;
}

// ------------------------------------------------------------------ lock

/** True when a pointer event on `target` must be ignored: the lock is on and it is outside the pads (and the unlock control). */
export function lockBlocks(target, locked) {
  if (!locked) return false;
  const el = target && typeof target.closest === 'function' ? target : (target && target.parentElement) || null;
  return !(el && typeof el.closest === 'function' && el.closest('[data-live-safe]'));
}

// ------------------------------------------------------------- MIDI learn

/** MIDI-learnable live actions (src/midi/midi.js LEARNABLE_ACTIONS). */
export const LIVE_ACTIONS = Object.freeze([
  ...Array.from({ length: PAD_COUNT }, (_, i) => `live.pad${i + 1}`),
  'live.next', 'live.prev', 'live.play',
]);

/** 'live.pad3' -> { kind: 'pad', index: 2 }, 'live.next' -> { kind: 'next' }, others null. */
export function liveMidiAction(id) {
  const m = /^live\.pad(\d+)$/.exec(String(id || ''));
  if (m) { const i = Number(m[1]) - 1; return i >= 0 && i < PAD_COUNT ? { kind: 'pad', index: i } : null; }
  if (id === 'live.next') return { kind: 'next' };
  if (id === 'live.prev') return { kind: 'prev' };
  if (id === 'live.play') return { kind: 'play' };
  return null;
}
