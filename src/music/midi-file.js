// Standard MIDI Files (v2.9): write the sequencers out as a type 1 file and
// read a type 0 or 1 file back into a pattern.
//
// Export takes its notes from the same offline replay as the WAV bounce
// (music.renderEvents: sequencers, arpeggiators on held or latched keys,
// chord trigger), or from sequencerEvents() (src/audio/bounce-events.js)
// when the music module is not there, so swing, ratchets and probability
// come out as a bounce plays them. Drum kit tracks go out on channel 10 as
// keys 36..43, one per lane.
//
// Import quantizes one track's notes to the pattern's step rate, starting at
// the bar of its first note, and writes the first `length` steps as scale
// degrees in the global key and scale (out-of-scale notes snap to the
// nearest scale note), or, on a drum kit track, as drum lanes.

import { sequencerEvents } from '../audio/bounce-events.js';
import { KIT_PADS, KIT_BASE_NOTE } from '../dsp/drum-kit.js';
import { SCALES, SCALE_NAMES, SEQ_RATES, SEQ_STEPS, MAX_PARTS, activePatternIndex, defaultStep, clamp } from '../core/params.js';

export const PPQ = 480;
export const DRUM_CHANNEL = 9; // channel 10
const MAX_FILE = 8 * 1024 * 1024;
const MAX_EVENTS = 500000;

const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ------------------------------------------------------------------ writing

function vlq(n) {
  n = Math.max(0, Math.min(0x0fffffff, Math.round(n)));
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
function textBytes(s) {
  // meta text is plain bytes: keep printable ASCII, replace anything else
  return [...String(s || '')].slice(0, 120).map((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c < 127 ? c : 63; });
}
function chunk(type, body) { return [...[...type].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body]; }

/**
 * Write a type 1 Standard MIDI File: track 1 holds the tempo (and the
 * name), then one track per entry of `tracks`.
 * @param {{bpm: number, name?: string, ppq?: number, tracks: {name: string, channel: number, notes: {tick: number, dur: number, note: number, vel: number}[]}[]}} o
 * @returns {Uint8Array}
 */
export function writeMidi({ bpm = 120, name = '', ppq = PPQ, tracks = [] }) {
  const uspq = Math.round(60000000 / clamp(finite(bpm, 120), 10, 1000));
  const head = chunk('MThd', [...u16(1), ...u16(tracks.length + 1), ...u16(ppq)]);
  const conductor = [];
  if (name) { const t = textBytes(name); conductor.push(0, 0xff, 0x03, ...vlq(t.length), ...t); }
  conductor.push(0, 0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255);
  conductor.push(0, 0xff, 0x58, 0x04, 4, 2, 24, 8); // 4/4
  conductor.push(0, 0xff, 0x2f, 0x00);
  const out = [...head, ...chunk('MTrk', conductor)];
  for (const tr of tracks) {
    const ch = clamp(Math.round(finite(tr.channel, 0)), 0, 15);
    const ev = [];
    for (const n of tr.notes || []) {
      const note = clamp(Math.round(n.note), 0, 127);
      const vel = clamp(Math.round(n.vel), 1, 127);
      const on = Math.max(0, Math.round(n.tick));
      ev.push({ tick: on, kind: 1, note, vel });
      ev.push({ tick: Math.max(on + 1, Math.round(n.tick + n.dur)), kind: 0, note, vel: 64 });
    }
    // at the same tick a note ends before the next one starts
    ev.sort((a, b) => a.tick - b.tick || a.kind - b.kind);
    const body = [];
    const t = textBytes(tr.name);
    body.push(0, 0xff, 0x03, ...vlq(t.length), ...t);
    let last = 0;
    for (const e of ev) {
      body.push(...vlq(e.tick - last), (e.kind ? 0x90 : 0x80) | ch, e.note, e.vel);
      last = e.tick;
    }
    body.push(0, 0xff, 0x2f, 0x00);
    out.push(...chunk('MTrk', body));
  }
  return Uint8Array.from(out);
}

/** Pair a time-sorted noteOn/noteOff event list (seconds) into notes in ticks. */
function eventsToNotes(events, spb, part, ppq) {
  const open = new Map();
  const notes = [];
  const tick = (sec) => Math.round((sec / spb) * ppq);
  for (const { time, msg } of events) {
    if (!msg || msg.part !== part) continue;
    if (msg.t === 'noteOn') {
      if (open.has(msg.note)) { const o = open.get(msg.note); o.dur = tick(time) - o.tick; }
      const n = { tick: tick(time), dur: 0, note: msg.note, vel: Math.round(clamp(msg.vel, 0, 1) * 127) };
      open.set(msg.note, n);
      notes.push(n);
    } else if (msg.t === 'noteOff' && open.has(msg.note)) {
      const o = open.get(msg.note);
      o.dur = tick(time) - o.tick;
      open.delete(msg.note);
    }
  }
  for (const n of notes) if (!(n.dur > 0)) n.dur = 1;
  return notes;
}

function trackChannel(part, i) {
  if (part && part.drum && part.drum.on) return DRUM_CHANNEL;
  const ch = i % 15; // melodic tracks skip channel 10
  return ch >= DRUM_CHANNEL ? ch + 1 : ch;
}

/**
 * MIDI bytes for the sequencers of `state` (store.serialize()).
 * mode 'pattern': one pass of the active pattern of track `part` (whether or
 * not its sequencer is on). mode 'session': `bars` bars of every track whose
 * sequencer is on, one MIDI track each. Accented steps come out at velocity
 * 127. `render(bars, {parts, forceOn})` is the music module's offline replay
 * (music.renderEvents, which adds the arpeggiators and the chord trigger);
 * without it the plain step sequencers (sequencerEvents) are written.
 * @returns {{bytes: Uint8Array, tracks: number, notes: number}}
 */
export function exportMidi(state, { mode = 'pattern', part = 0, bars = 4, render = null } = {}) {
  const parts = (state && Array.isArray(state.parts) ? state.parts : []).slice(0, MAX_PARTS);
  const g = (state && state.global) || {};
  const bpm = clamp(finite(g.tempo, 112), 20, 400);
  const spb = 60 / bpm;
  let list, nBars, endTick = Infinity, src = state;
  if (mode === 'pattern') {
    const p = parts[part];
    if (!p || !Array.isArray(p.patterns) || !p.patterns.length) return { bytes: writeMidi({ bpm, tracks: [] }), tracks: 0, notes: 0 };
    const pat = p.patterns[activePatternIndex(p)];
    const rate = SEQ_RATES[clamp(Math.round(finite(pat.rate, 3)), 0, SEQ_RATES.length - 1)].beats;
    const beats = clamp(Math.round(finite(pat.length, 16)), 1, SEQ_STEPS) * rate;
    nBars = Math.max(1, Math.ceil(beats / 4 - 1e-9));
    endTick = Math.round(beats * PPQ);
    src = { ...state, parts: parts.map((q, i) => (i === part ? { ...q, seqOn: 1 } : q)) };
    list = [part];
  } else {
    nBars = clamp(Math.round(finite(bars, 4)), 1, 512);
    // tracks whose sequencer is on, plus any whose arpeggiator plays (kept only if it made notes)
    list = parts.map((q, i) => i).filter((i) => parts[i] && (parts[i].seqOn || (render && parts[i].arp && parts[i].arp.mode)) && Array.isArray(parts[i].patterns) && parts[i].patterns.length);
  }
  const forceOn = mode === 'pattern' ? list : [];
  const events = typeof render === 'function' ? render(nBars, { parts: list, forceOn }) : sequencerEvents(src, nBars, { parts: list });
  const tracks = [];
  let total = 0;
  for (const i of list) {
    const p = parts[i];
    let notes = eventsToNotes(events, spb, i, PPQ).filter((n) => n.tick < endTick);
    if (Number.isFinite(endTick)) notes = notes.map((n) => ({ ...n, dur: Math.max(1, Math.min(n.dur, endTick - n.tick)) }));
    if (!notes.length && mode !== 'pattern' && !p.seqOn) continue;
    total += notes.length;
    const pat = p.patterns[activePatternIndex(p)];
    const trackName = mode === 'pattern' ? `${p.name || `Track ${i + 1}`}, ${pat.name || 'Pattern'}` : (p.name || `Track ${i + 1}`);
    tracks.push({ name: trackName, channel: trackChannel(p, i), notes });
  }
  return { bytes: writeMidi({ bpm, name: 'Oro', tracks }), tracks: tracks.length, notes: total };
}

// ------------------------------------------------------------------ reading

/**
 * Parse a Standard MIDI File (format 0, 1 or 2). Handles running status,
 * note-on with velocity 0 as note-off, and the tempo map; skips sysex and
 * every meta event but tempo and track names. Throws an Error with a
 * readable message for files it cannot read.
 * @returns {{format: number, ppq: number|null, tempos: {tick: number, uspq: number}[], bpm: number,
 *   tracks: {name: string, notes: {tick: number, dur: number, beat: number, beats: number, sec: number, note: number, vel: number, ch: number}[]}[]}}
 */
export function parseMidi(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length > MAX_FILE) throw new Error('The MIDI file is too large');
  const str = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const rd32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const rd16 = (o) => (b[o] << 8) | b[o + 1];
  if (b.length < 14 || str(0) !== 'MThd') throw new Error('This is not a MIDI file');
  const hlen = rd32(4);
  if (hlen < 6 || 8 + hlen > b.length) throw new Error('The MIDI header is damaged');
  const format = rd16(8), div = rd16(12);
  if (format > 2) throw new Error(`MIDI format ${format} is not supported`);
  let ppq = null, tps = 0;
  if (div & 0x8000) { const fps = 256 - (div >> 8); tps = (fps === 29 ? 29.97 : fps) * (div & 0xff); if (!(tps > 0)) throw new Error('The MIDI timing is damaged'); }
  else { ppq = div; if (!ppq) throw new Error('The MIDI timing is damaged'); }
  const raw = [];
  const tempos = [];
  let pos = 8 + hlen, count = 0;
  while (pos + 8 <= b.length && raw.length < 1024) {
    const type = str(pos), len = rd32(pos + 4);
    const start = pos + 8, end = Math.min(b.length, start + len);
    pos = start + len;
    if (type !== 'MTrk') continue;
    const tr = { name: '', events: [] };
    raw.push(tr);
    let p = start, tick = 0, status = 0;
    const vl = () => { let v = 0; for (let k = 0; k < 4 && p < end; k++) { const c = b[p++]; v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) return v; } return v; };
    while (p < end) {
      tick += vl();
      if (p >= end) break;
      let st = b[p];
      if (st & 0x80) p++; else if (status) st = status; else break; // a data byte with no status: stop this track
      if (st === 0xff) {
        const mt = b[p++], ml = vl(), md = p;
        p += ml;
        if (p > end) break;
        if (mt === 0x51 && ml >= 3) tempos.push({ tick, uspq: (b[md] << 16) | (b[md + 1] << 8) | b[md + 2] });
        else if (mt === 0x03 && !tr.name) tr.name = String.fromCharCode(...b.subarray(md, md + Math.min(ml, 80))).replace(/[^\x20-\x7e]/g, '').trim();
        else if (mt === 0x2f) break;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) { const sl = vl(); p += sl; continue; }
      if (st >= 0xf0) break; // not valid in a file
      status = st;
      const hi = st & 0xf0, ch = st & 0x0f;
      const d1 = b[p++];
      const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : b[p++];
      if (p > end) break;
      if (hi === 0x90 && d2 > 0) tr.events.push({ tick, on: 1, note: d1 & 0x7f, vel: d2 & 0x7f, ch });
      else if (hi === 0x80 || hi === 0x90) tr.events.push({ tick, on: 0, note: d1 & 0x7f, vel: 0, ch });
      if (++count > MAX_EVENTS) throw new Error('The MIDI file has too many events');
    }
  }
  if (!raw.length) throw new Error('The MIDI file has no tracks');
  // tempo map: seconds at any tick (metrical files)
  tempos.sort((x, y) => x.tick - y.tick);
  const map = [];
  if (ppq) {
    let sec = 0, lt = 0, us = 500000;
    for (const t of tempos) { sec += ((t.tick - lt) * us) / 1e6 / ppq; lt = t.tick; us = t.uspq || 500000; map.push({ tick: t.tick, sec, us }); }
  }
  const secAt = (tick) => {
    if (!ppq) return tick / tps;
    let s = 0, lt = 0, us = 500000;
    for (const m of map) { if (m.tick > tick) break; s = m.sec; lt = m.tick; us = m.us; }
    return s + ((tick - lt) * us) / 1e6 / ppq;
  };
  const bpm = tempos.length ? 60000000 / (tempos[0].uspq || 500000) : 120;
  const tracks = raw.map((tr) => {
    const open = new Map();
    const notes = [];
    for (const e of tr.events) {
      const k = e.ch * 128 + e.note;
      if (e.on) {
        const n = { tick: e.tick, dur: 0, note: e.note, vel: e.vel, ch: e.ch };
        if (!open.has(k)) open.set(k, []);
        open.get(k).push(n);
        notes.push(n);
      } else if (open.has(k) && open.get(k).length) {
        const n = open.get(k).shift();
        n.dur = e.tick - n.tick;
      }
    }
    for (const n of notes) {
      n.sec = secAt(n.tick);
      // beats: from ticks (metrical) or from seconds at 120 BPM (SMPTE timing)
      n.beat = ppq ? n.tick / ppq : n.sec * 2;
      n.beats = ppq ? n.dur / ppq : (secAt(n.tick + n.dur) - n.sec) * 2;
    }
    notes.sort((x, y) => x.tick - y.tick || x.note - y.note);
    return { name: tr.name, notes };
  });
  return { format, ppq, tempos, bpm, tracks };
}

/**
 * The note groups an import can choose from: each track with notes, split by
 * channel when a track uses several (type 0 files keep everything in one).
 * Sorted as in the file; `best` is the index with the most notes (on a drum
 * kit track, the busiest on channel 10 if any).
 */
export function midiChoices(parsed, { drum = false } = {}) {
  const out = [];
  parsed.tracks.forEach((tr, ti) => {
    const chans = [...new Set(tr.notes.map((n) => n.ch))].sort((a, b) => a - b);
    for (const ch of chans) {
      const notes = tr.notes.filter((n) => n.ch === ch);
      const base = tr.name || `Track ${ti + 1}`;
      out.push({ track: ti, ch, notes, label: `${chans.length > 1 || !tr.name ? `${base}, channel ${ch + 1}` : base}: ${notes.length} note${notes.length === 1 ? '' : 's'}` });
    }
  });
  let best = -1;
  const pick = (list) => { for (const c of list) if (best < 0 || c.notes.length > out[best].notes.length) best = out.indexOf(c); };
  if (drum) pick(out.filter((c) => c.ch === DRUM_CHANNEL));
  if (best < 0) pick(out);
  return { choices: out, best };
}

/** A MIDI note -> {degree, octave, snapped} in the key and scale, relative to the pattern's base octave. */
export function noteToDegree(note, { root = 0, scaleType = 0, baseOctave = 3 } = {}) {
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor;
  const len = scale.length;
  const rel = note - (12 * (baseOctave + 1) + root);
  let oct = Math.floor(rel / 12);
  const pc = rel - 12 * oct;
  let idx = scale.indexOf(pc), snapped = false;
  if (idx < 0) {
    snapped = true;
    // nearest scale note (the lower one on a tie), wrapping into the next octave
    let bestD = Infinity;
    for (let i = 0; i <= len; i++) {
      const v = i === len ? 12 : scale[i];
      const d = Math.abs(v - pc);
      if (d < bestD) { bestD = d; idx = i; }
    }
    if (idx === len) { idx = 0; oct += 1; }
  }
  // octave -2..2 on the step, anything further moves into the degree
  const so = clamp(oct, -2, 2);
  let degree = idx + (oct - so) * len;
  degree = clamp(degree, -21, 28);
  return { degree, octave: so, snapped };
}

/** Import velocity at or above this (of 127) marks a step as accented. */
export const ACCENT_VEL = 120;
/** How chords (several notes on one step) are imported. */
export const CHORD_MODES = Object.freeze([
  { id: 'high', name: 'Highest note' }, { id: 'low', name: 'Lowest note' }, { id: 'split', name: 'Split across tracks' },
]);

/**
 * Turn one note group of a parsed file into the pattern's new content.
 * `chord` picks the note a step keeps when several land on it: 'high' or
 * 'low' (the others are dropped), or 'split' with `voice` k (0 = highest):
 * the k-th note from the top of each step, for writing voice k to another
 * track. A drum kit pattern keeps every note (in 'split', only voice k).
 * Notes with velocity >= ACCENT_VEL become accented steps (velocity kept).
 * @param {object[]} notes from midiChoices()
 * @param {object} pattern the pattern being replaced (rate, length, baseOctave, steps, drumLanes)
 * @param {{root: number, scaleType: number, drum: boolean, chord: string, voice: number}} o
 * @returns {{steps?: object[], drumLanes?: number[][], used: number, snapped: number, dropped: number, outside: number, voices: number}}
 */
export function notesToPattern(notes, pattern, { root = 0, scaleType = 0, drum = false, chord = 'high', voice = 0 } = {}) {
  const rate = SEQ_RATES[clamp(Math.round(finite(pattern.rate, 3)), 0, SEQ_RATES.length - 1)].beats;
  const len = clamp(Math.round(finite(pattern.length, 16)), 1, SEQ_STEPS);
  const baseOctave = clamp(Math.round(finite(pattern.baseOctave, 3)), 0, 7);
  const split = chord === 'split';
  const sorted = [...notes].sort((a, b) => a.beat - b.beat || (chord === 'low' ? a.note - b.note : b.note - a.note));
  const start = sorted.length ? Math.floor(sorted[0].beat / 4 + 1e-9) * 4 : 0;
  // the notes of each step, in chord order (highest first, or lowest for 'low')
  const groups = Array.from({ length: len }, () => []);
  let used = 0, snapped = 0, dropped = 0, outside = 0;
  for (const n of sorted) {
    const s = Math.round((n.beat - start) / rate);
    if (s < 0 || s >= len) outside++;
    else groups[s].push(n);
  }
  const voices = groups.reduce((m, g) => Math.max(m, g.length), 0);
  const k = Math.max(0, Math.round(finite(voice, 0)));
  if (drum) {
    const old = Array.isArray(pattern.drumLanes) ? pattern.drumLanes : [];
    const lanes = Array.from({ length: KIT_PADS }, (_, r) => Array.from({ length: SEQ_STEPS }, (_, c) => (c >= len ? finite(old[r] && old[r][c], 0) : 0)));
    groups.forEach((g, s) => {
      for (const n of split ? g.slice(k, k + 1) : g) {
        const r = (((n.note - KIT_BASE_NOTE) % KIT_PADS) + KIT_PADS) % KIT_PADS;
        if (lanes[r][s] > 0) dropped++; else used++;
        lanes[r][s] = Math.max(lanes[r][s], Math.max(0.01, Math.round((n.vel / 127) * 100) / 100));
      }
    });
    return { drumLanes: lanes, used, snapped, dropped, outside, voices };
  }
  const chosen = groups.map((g) => (split ? g[k] || null : g[0] || null));
  if (!split) for (const g of groups) dropped += Math.max(0, g.length - 1);
  const old = Array.isArray(pattern.steps) ? pattern.steps : [];
  const steps = Array.from({ length: SEQ_STEPS }, (_, i) => {
    const prev = old[i] && typeof old[i] === 'object' ? old[i] : defaultStep();
    if (i >= len) return { ...prev };
    const keep = { lock: prev.lock ? 1 : 0, lx: finite(prev.lx, 0.5), ly: finite(prev.ly, 0.5) };
    const n = chosen[i];
    if (!n) return { ...defaultStep(), ...keep };
    const d = noteToDegree(n.note, { root, scaleType, baseOctave });
    if (d.snapped) snapped++;
    used++;
    const next = chosen.slice(i + 1).find(Boolean);
    const slide = next && n.beat + n.beats > next.beat + 1e-6 ? 1 : 0;
    return {
      ...defaultStep(), on: 1, degree: d.degree, octave: d.octave,
      vel: Math.max(0.01, Math.round((n.vel / 127) * 1000) / 1000),
      gate: clamp(Math.round((n.beats / rate) * 100) / 100, 0.05, 1),
      slide, accent: n.vel >= ACCENT_VEL ? 1 : 0, ...keep,
    };
  });
  return { steps, used, snapped, dropped, outside, voices };
}

/**
 * Write one note group into the session in `store`, as one undo step: into
 * track `part`'s active pattern, and with chord 'split' chord voice k
 * (highest first) into the active pattern of track part + k while there is
 * one. A drum kit track as the target keeps every note in its lanes.
 * @returns {{used: number, snapped: number, dropped: number, outside: number, voices: number, tracks: number, voicesDropped: number, pattern: string}|null}
 */
export function importMidiNotes(store, notes, { part = 0, chord = 'high' } = {}) {
  const parts = store.get('parts') || [];
  const target = (q) => {
    const p = parts[q];
    if (!p || !Array.isArray(p.patterns) || !p.patterns.length) return null;
    const idx = activePatternIndex(p);
    return { path: `parts.${q}.patterns.${idx}`, pattern: p.patterns[idx], drum: !!(p.drum && p.drum.on) };
  };
  const first = target(part);
  if (!first) return null;
  const o = { root: finite(store.get('global.scaleRoot'), 0), scaleType: finite(store.get('global.scaleType'), 0) };
  const r0 = notesToPattern(notes, first.pattern, { ...o, drum: first.drum, chord: first.drum && chord === 'split' ? 'high' : chord, voice: 0 });
  const writes = [[first, r0]];
  let voicesDropped = 0;
  if (chord === 'split' && !first.drum) {
    for (let k = 1; k < r0.voices; k++) {
      const t = target(part + k);
      if (!t) { voicesDropped = r0.voices - k; break; }
      writes.push([t, notesToPattern(notes, t.pattern, { ...o, drum: t.drum, chord, voice: k })]);
    }
  }
  store.batch(() => {
    for (const [t, r] of writes) {
      if (t.drum) store.set(`${t.path}.drumLanes`, r.drumLanes, { source: 'import' });
      else store.set(`${t.path}.steps`, r.steps, { source: 'import' });
    }
  });
  const sum = (f) => writes.reduce((a, [, r]) => a + r[f], 0);
  return {
    used: sum('used'), snapped: sum('snapped'), dropped: r0.dropped, outside: r0.outside, voices: r0.voices,
    tracks: writes.length, voicesDropped, pattern: first.pattern.name || 'the pattern', drum: first.drum,
  };
}
