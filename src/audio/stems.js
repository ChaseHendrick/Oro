// Export stems (2.11): one offline render per track, optional send-return
// stems and the full mix, all the same length from beat 0, packed into a
// single store-only .zip with the session's MIDI, a tempo map and a README.
//
// Passes (engine.renderPasses, one AudioBuffer held at a time):
//   mix      everything, as the 2.10 bounce renders it. Rendered first: with
//            the automatic tail it decides where the files end (the mix holds
//            every tail; it is rendered with the longest tail and cut where
//            it falls below -90 dBFS).
//   track    one track on its own (passInit's solo), through its own track
//            effects. Dry stems set the track's delay, reverb, Send A and
//            Send B amounts to 0; pre-fader stems set its level to 1.
//   return   every track that plays, with the dry signal switched off in the
//            DSP ({t:'stemTap', dry: 0}) and all sends but one at 0, so only
//            that effect's return is heard: Send A reverb, Send B delay, or
//            the master delay or reverb.
//   mixraw   the mix tapped before the master chain (when Master processing
//            is off), so the stems can be checked against it.
// Master processing off (the default): track and return stems are tapped
// before the master chorus, warmth, volume and limiter, so they add up to
// "Mix (no master processing)" exactly (within float rounding). On: every
// file goes through the master chain like the mix; warmth and the limiter
// are not linear, so the sum is then close to the mix, not exact.
//
// Encoding happens straight after each pass (16- or 24-bit integer with
// optional TPDF dither, or 32-bit float). With common normalisation every
// peak must be known first, so the passes are kept as raw float Blobs and
// encoded at the end.

import { MAX_PARTS, NOTE_NAMES, SCALE_NAMES, SEQ_RATES, activeChain, activePatternIndex } from '../core/params.js';
import { partCount } from '../core/tracks.js';
import { bounceOptions, normaliseEvents, stemParts, MAX_TAIL_SECONDS } from './bounce.js';
import { sequencerEvents } from './bounce-events.js';
import { wavHeader, wavHeaderExtensible, createDitherRng } from './wav.js';
import { SURROUND_LAYOUTS, SPACE_MODES } from '../dsp/spatial.js';
import { createZipWriter } from './zip.js';
import { exportMidi, writeMidi } from '../music/midi-file.js';
import { FX_TYPE_MAP } from '../dsp/track-fx-config.js';

export const STEM_RATES = Object.freeze([44100, 48000, 88200, 96000]);
export const STEM_BITS = Object.freeze([16, 24, 32]);
export const STEM_TAILS = Object.freeze(['auto', 0, 1, 2, 4, 8]);
export const DEFAULT_PATTERN = '{index} {track name} {tempo}bpm {key}';
export const SILENCE_DB = -90;
export const AUTO_TAIL_MAX = MAX_TAIL_SECONDS;
export const NORMALISE_PEAK = 10 ** (-1 / 20);   // -1 dBFS
export const SIZE_WARN = 1.5e9;
export const SIZE_MAX = 3.5e9;
// 2.12 surround file: Spread sends this share of the power of stereo tracks
// and the effect returns to the rear pair; the LFE (when on) is a 120 Hz
// low-pass of the whole mix.
export const SURROUND_CHOICES = Object.freeze(['off', '5.1', '7.1']);
export const SURROUND_SPREAD = 0.2;
export const LFE_HZ = 120;
const ENCODE_FRAMES = 1 << 15;
const YIELD_MS = 12;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldTask = () => new Promise(r => setTimeout(r, 0));
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Options with defaults and limits applied. */
export function stemOptions(o = {}) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const tail = o.tail === 'auto' || o.tail === undefined ? 'auto' : clamp(finite(Number(o.tail), 2), 0, MAX_TAIL_SECONDS);
  const bits = pick(Number(o.bits), STEM_BITS, 24);
  return {
    length: o.length === 'song' ? 'song' : 'bars',
    bars: clamp(Math.round(finite(Number(o.bars), 4)), 1, 512),
    sampleRate: pick(Number(o.sampleRate), STEM_RATES, 48000),
    bits,
    dither: bits !== 32 && o.dither !== false,
    normalise: pick(o.normalise, ['off', 'common', 'each'], 'off'),
    wet: o.wet !== false,
    returns: o.wet === false && !!o.returns,
    tail,
    fader: o.fader === 'pre' ? 'pre' : 'post',
    master: !!o.master,
    pattern: typeof o.pattern === 'string' && o.pattern.trim() ? o.pattern.slice(0, 200) : DEFAULT_PATTERN,
    surround: pick(o.surround, SURROUND_CHOICES, 'off'),
    lfe: !!o.lfe,
    spread: !!o.spread,
  };
}

/**
 * Bars in the whole song: the longest song-mode chain of a track whose
 * sequencer is on (each entry's pattern length x rate x repeats), or one
 * pass of the longest playing pattern when no track uses a chain.
 */
export function songBars(state) {
  const parts = (state && Array.isArray(state.parts) ? state.parts : []).slice(0, MAX_PARTS);
  const beatsOf = (pat) => clamp(Math.round(finite(pat && pat.length, 16)), 1, 16) * SEQ_RATES[clamp(Math.round(finite(pat && pat.rate, 3)), 0, SEQ_RATES.length - 1)].beats;
  let chainBeats = 0, loopBeats = 0;
  for (const p of parts) {
    if (!p || !p.seqOn || !Array.isArray(p.patterns) || !p.patterns.length) continue;
    const chain = activeChain(p);
    if (chain) chainBeats = Math.max(chainBeats, chain.reduce((s, e) => s + beatsOf(p.patterns[e.pattern]) * e.repeats, 0));
    else loopBeats = Math.max(loopBeats, beatsOf(p.patterns[activePatternIndex(p)]));
  }
  const beats = chainBeats || loopBeats || 16;
  return clamp(Math.ceil(beats / 4 - 1e-9), 1, 512);
}

export function keyName(state) {
  const g = (state && state.global) || {};
  return `${NOTE_NAMES[clamp(Math.round(finite(g.scaleRoot, 9)), 0, 11)]} ${SCALE_NAMES[clamp(Math.round(finite(g.scaleType, 1)), 0, SCALE_NAMES.length - 1)]}`;
}

export function tempoText(bpm) {
  const t = Math.round(finite(bpm, 112) * 100) / 100;
  return String(t);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** A file name that every common file system accepts (no extension handling). */
export function sanitizeFileName(s, fallback = 'stem') {
  let out = String(s ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (out.length > 120) out = out.slice(0, 120).trim();
  if (!out) out = fallback;
  if (RESERVED.test(out.split('.')[0])) out = `_${out}`;
  return out;
}

/** "{index} {track name} {tempo}bpm {key}" filled in and made safe, plus ".wav". */
export function stemFileName(pattern, { index = 0, name = '', tempo = 120, key = '' } = {}) {
  const idx = String(index).padStart(2, '0');
  const filled = String(pattern || DEFAULT_PATTERN)
    .replace(/\{index\}/gi, idx)
    .replace(/\{track name\}|\{name\}/gi, name)
    .replace(/\{tempo\}/gi, tempoText(tempo))
    .replace(/\{key\}/gi, key);
  return `${sanitizeFileName(filled, `${idx} stem`)}.wav`;
}

/** Make names unique (case-insensitively), adding " (2)", " (3)" ... before the extension. */
export function uniqueNames(names) {
  const seen = new Set();
  return names.map((n) => {
    const dot = n.lastIndexOf('.');
    const base = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : '';
    let out = n, k = 2;
    while (seen.has(out.toLowerCase())) out = `${base} (${k++})${ext}`;
    seen.add(out.toLowerCase());
    return out;
  });
}

/** Bytes of a stereo WAV set: `files` files of `seconds` each, plus MIDI and README slack. */
export function estimateBytes({ seconds, sampleRate, bits, files }) {
  const frames = Math.ceil(Math.max(0, seconds) * sampleRate);
  return files * (frames * 2 * (bits >> 3) + 44 + 200) + 64 * 1024;
}

/**
 * 2.12 surround mix-down helpers (pure, for the tests): add a stereo pass
 * (the effect returns) to the speaker channels, front left/right, with
 * Spread a little into the rear pair.
 */
export function addStereoToSurround(acc, layout, L, R, frames, spread = 0) {
  const fs = Math.sqrt(1 - spread), rs = Math.sqrt(spread);
  const [rl, rr] = layout.rear;
  for (let i = 0; i < frames; i++) {
    acc[0][i] += L[i] * fs; acc[1][i] += R[i] * fs;
    if (rs > 0) { acc[rl][i] += L[i] * rs; acc[rr][i] += R[i] * rs; }
  }
}

/** The LFE channel: a 120 Hz low-pass (two 2nd-order Butterworth stages) of half the sum of the other channels. */
export function fillLfe(acc, layout, frames, sampleRate) {
  const out = acc[layout.lfe];
  const w0 = 2 * Math.PI * LFE_HZ / sampleRate, al = Math.sin(w0) / (2 * Math.SQRT1_2), cw = Math.cos(w0), a0 = 1 + al;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
  const st = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < frames; i++) {
    let x = 0;
    for (let c = 0; c < layout.channels; c++) if (c !== layout.lfe) x += acc[c][i];
    x *= 0.5;
    for (let k = 0; k < 2; k++) {
      const o = k * 4;
      const y = b0 * x + b1 * st[o] + b2 * st[o + 1] - a1 * st[o + 2] - a2 * st[o + 3];
      st[o + 1] = st[o]; st[o] = x; st[o + 3] = st[o + 2]; st[o + 2] = y;
      x = y;
    }
    out[i] = x;
  }
}

const RETURNS = [
  { id: 'sendA', label: 'Send A reverb return', keep: 'sendA', level: 'sendAReturn' },
  { id: 'sendB', label: 'Send B delay return', keep: 'sendB', level: 'sendBReturn' },
  { id: 'delay', label: 'Delay return', keep: 'delaySend', level: 'delayLevel' },
  { id: 'reverb', label: 'Reverb return', keep: 'reverbSend', level: 'reverbLevel' },
];
const SEND_IDS = ['delaySend', 'reverbSend', 'sendA', 'sendB'];

/** Remove overridden parameters from timed parameter locks (so a lock cannot undo a dry stem). */
function stripEvents(events, overrides) {
  if (!overrides.size) return events;
  const out = [];
  for (const e of events) {
    const o = e.msg.t === 'params' && overrides.get(e.msg.part);
    if (!o) { out.push(e); continue; }
    const p = {};
    let any = false;
    for (const k of Object.keys(e.msg.p || {})) if (!(k in o)) { p[k] = e.msg.p[k]; any = true; }
    if (any) out.push({ time: e.time, msg: { ...e.msg, p } });
  }
  return out;
}

/**
 * The passes of an export: [{kind, id, label, part, solo, extra, events}],
 * the mix first. `events` must be normalised (normaliseEvents).
 */
export function planStems(state, events, options = {}) {
  const o = stemOptions(options);
  const parts = (state && state.parts) || [];
  const count = Math.min(partCount(state), MAX_PARTS);
  const g = (state && state.global) || {};
  const playing = stemParts(state, events);
  const tap = o.master ? null : 'bus';
  // Every pass draws each track's random voice phases from that track's own
  // stream, so a track alone sounds exactly as it does in the mix.
  const streams = { t: 'stemTap', streams: 1 };
  const passes = [{ kind: 'mix', id: 'mix', label: 'Full mix', part: null, solo: null, extra: [streams], events, tap: null }];
  if (!o.master) passes.push({ kind: 'mixraw', id: 'mixraw', label: 'Mix (no master processing)', part: null, solo: null, extra: [streams], events, tap });
  for (const p of playing) {
    const over = {};
    if (!o.wet) for (const k of SEND_IDS) over[k] = 0;
    if (o.fader === 'pre') over.level = 1;
    const ov = new Map(Object.keys(over).length ? [[p, over]] : []);
    passes.push({
      kind: 'track', id: `track${p + 1}`, label: (parts[p] && parts[p].name) || `Track ${p + 1}`, part: p, solo: p, tap,
      extra: ov.size ? [streams, { t: 'params', part: p, p: over }] : [streams], events: stripEvents(events, ov),
    });
  }
  if (o.surround !== 'off') {
    // 2.12 surround: one pass with every track dry on its speakers (3D tracks
    // where they are, the others on front left/right), every send at 0; one
    // stereo pass of all the effect returns. Neither is a file of its own.
    const layout = SURROUND_LAYOUTS[o.surround];
    const surMsg = { t: 'surround', layout: layout.id, spread: o.spread ? SURROUND_SPREAD : 0 };
    const over = {};
    for (const k of SEND_IDS) over[k] = 0;
    const ov = new Map();
    for (let p = 0; p < count; p++) ov.set(p, over);
    passes.push({
      kind: 'surround', id: 'surround', label: `Surround ${layout.id}`, part: null, solo: null, tap: null, surround: layout.channels, file: false,
      extra: [streams, surMsg, ...[...ov.keys()].map(p => ({ t: 'params', part: p, p: { ...over } }))],
      events: stripEvents(events, ov),
    });
    const sends = playing.some(p => SEND_IDS.some(k => finite(parts[p] && parts[p].params && parts[p].params[k], 0) > 0));
    if (sends) {
      passes.push({
        kind: 'surround-fx', id: 'surroundfx', label: `Surround ${layout.id} effects`, part: null, solo: null, tap: 'bus', file: false,
        extra: [{ t: 'stemTap', dry: 0, streams: 1 }, surMsg], events,
      });
    }
  }
  if (o.returns) {
    for (const r of RETURNS) {
      const used = playing.some(p => finite(parts[p] && parts[p].params && parts[p].params[r.keep], 0) > 0);
      if (!used || !(finite(g[r.level], 1) > 0)) continue;
      const over = {};
      for (const k of SEND_IDS) if (k !== r.keep) over[k] = 0;
      const ov = new Map();
      for (let p = 0; p < count; p++) ov.set(p, over);
      passes.push({
        kind: 'return', id: r.id, label: r.label, part: null, solo: null, tap,
        extra: [{ t: 'stemTap', dry: 0, streams: 1 }, ...[...ov.keys()].map(p => ({ t: 'params', part: p, p: { ...over } }))],
        events: stripEvents(events, ov),
      });
    }
  }
  return passes;
}

/** Highest absolute sample of the first `frames` frames. */
export function measurePeak(chans, frames) {
  let peak = 0;
  for (const d of chans) {
    const n = Math.min(frames, d.length);
    for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak && a === a) peak = a; }
  }
  return peak;
}

/**
 * Where the automatic tail ends: the first frame after the last sample above
 * SILENCE_DB, never before `songFrames`, never past the buffer.
 */
export function autoTailFrames(chans, songFrames, sampleRate) {
  const thr = 10 ** (SILENCE_DB / 20);
  const len = chans.length ? chans[0].length : 0;
  let last = -1;
  for (const d of chans) for (let i = len - 1; i > last; i--) if (Math.abs(d[i]) > thr) { last = i; break; }
  const end = Math.max(songFrames, last + 1);
  // round up to a whole millisecond
  const ms = Math.max(1, Math.round(sampleRate / 1000));
  return Math.min(len, Math.ceil(end / ms) * ms);
}

/**
 * Interleaved stereo PCM for frames [start, start + n): 16/24-bit integer
 * (TPDF dither of +-1 LSB peak when `rng` is given; exact silence stays 0)
 * or 32-bit float. `gain` scales first.
 */
export function encodeSlice(chans, start, n, { bits = 24, gain = 1, rng = null } = {}) {
  const nch = chans.length;
  const bytes = bits >> 3;
  const out = new Uint8Array(n * nch * bytes);
  if (bits === 32) {
    const v = new DataView(out.buffer);
    let o = 0;
    for (let i = start; i < start + n; i++) for (let c = 0; c < nch; c++) {
      const x = chans[c][i] * gain;
      v.setFloat32(o, Number.isFinite(x) ? x : 0, true);
      o += 4;
    }
    return out;
  }
  const scale = bits === 16 ? 32768 : 8388608;
  const max = scale - 1, min = -scale;
  let o = 0;
  for (let i = start; i < start + n; i++) {
    for (let c = 0; c < nch; c++) {
      const x = chans[c][i] * gain;
      let s = 0;
      if (x === x && x !== 0) {
        s = Math.round(rng ? x * scale + (rng() - rng()) : x * scale);
        if (s > max) s = max; else if (s < min) s = min;
      }
      out[o] = s & 255;
      out[o + 1] = (s >> 8) & 255;
      if (bytes === 3) out[o + 2] = (s >> 16) & 255;
      o += bytes;
    }
  }
  return out;
}

/** WAV pieces (header first) for `frames` frames of `chans`, encoded in slices that yield. */
export async function encodeStemPieces(chans, frames, sampleRate, { bits = 24, dither = true, gain = 1, seed = 1, isCancelled = () => false, channelMask = 0 } = {}) {
  const rng = bits !== 32 && dither ? createDitherRng(0x9e3779b9 ^ Math.imul(seed, 2654435761)) : null;
  // 2.12 a speaker mask means a multichannel (WAVE_FORMAT_EXTENSIBLE) file; stereo files keep the plain header
  const head = { sampleRate, channels: chans.length, bitsPerSample: bits, frames, format: bits === 32 ? 3 : 1 };
  const pieces = [channelMask ? wavHeaderExtensible({ ...head, channelMask }) : wavHeader(head)];
  let t0 = nowMs();
  for (let f = 0; f < frames; f += ENCODE_FRAMES) {
    if (isCancelled()) throw new CancelError();
    pieces.push(encodeSlice(chans, f, Math.min(ENCODE_FRAMES, frames - f), { bits, gain, rng }));
    if (nowMs() - t0 > YIELD_MS) { await yieldTask(); t0 = nowMs(); }
  }
  if (((frames * chans.length * (bits >> 3)) & 1) === 1) pieces.push(new Uint8Array(1));
  return pieces;
}

/** One-shot stereo WAV bytes (tests and small files). */
export function encodeStemWav(chans, sampleRate, { bits = 24, dither = true, gain = 1, seed = 1 } = {}) {
  const frames = chans[0] ? chans[0].length : 0;
  const rng = bits !== 32 && dither ? createDitherRng(0x9e3779b9 ^ Math.imul(seed, 2654435761)) : null;
  const head = wavHeader({ sampleRate, channels: chans.length, bitsPerSample: bits, frames, format: bits === 32 ? 3 : 1 });
  const body = encodeSlice(chans, 0, frames, { bits, gain, rng });
  const out = new Uint8Array(head.length + body.length + (body.length & 1));
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export class CancelError extends Error {
  constructor() { super('Export cancelled'); this.name = 'CancelError'; this.cancelled = true; }
}

const pct = (v) => `${Math.round(finite(v, 0) * 100)}%`;
function trackLine(state, p) {
  const part = (state.parts || [])[p] || {};
  const pr = part.params || {};
  const pan = finite(pr.pan, 0);
  const sp = Math.round(finite(pr.space, 0));
  const fx = ((part.trackFx && part.trackFx.slots) || []).filter(s => s && s.type && s.type !== 'bypass').map(s => (FX_TYPE_MAP[s.type] || {}).name || s.type);
  const pat = Array.isArray(part.patterns) && part.patterns.length ? part.patterns[activePatternIndex(part)] : null;
  return [
    `level ${pct(pr.level ?? 0.75)}`,
    sp > 0 ? `3D ${SPACE_MODES[sp] || 'on'} (headphone render${sp === 1 ? `, direction ${Math.round(finite(pr.spaceAz, 0))} degrees, height ${Math.round(finite(pr.spaceEl, 0))} degrees, ${finite(pr.spaceDist, 1).toFixed(1)} m` : ''})`
      : `pan ${Math.abs(pan) < 0.005 ? 'centre' : `${pct(Math.abs(pan))} ${pan < 0 ? 'left' : 'right'}`}`,
    `delay send ${pct(pr.delaySend)}`, `reverb send ${pct(pr.reverbSend)}`, `Send A ${pct(pr.sendA)}`, `Send B ${pct(pr.sendB)}`,
    pr.mute ? 'muted in the mix' : null, pr.solo ? 'soloed in the mix' : null,
    part.drum && part.drum.on ? 'drum kit' : part.sampler && part.sampler.on ? `sampler${part.sampler.name ? ` ("${part.sampler.name}")` : ''}` : null,
    pat ? `pattern "${pat.name || 'Pattern'}"` : null,
    activeChain(part) ? 'song mode chain' : null,
    `track effects: ${fx.length ? fx.join(', ') : 'none'}`,
  ].filter(Boolean).join(', ');
}

/** README line for the surround file. */
function surroundText(o) {
  const L = SURROUND_LAYOUTS[o.surround];
  if (!L) return '';
  return `a ${L.id} surround mix (${L.channels} channels in the order ${L.names.join(', ')}; WAVE_FORMAT_EXTENSIBLE, speaker mask 0x${L.mask.toString(16).toUpperCase()}). `
    + 'Tracks in 3D sit on the speakers at their direction (pairwise constant-power panning, distance as level); the other tracks are on front left and right'
    + `${o.spread ? ', with a little sent to the rear pair (Spread)' : ''}. The effects are on front left and right${o.spread ? ' and a little in the rear pair' : ''}. `
    + `LFE: ${o.lfe ? `a ${LFE_HZ} Hz low-pass copy of the whole mix` : 'silent'}. Taken before the master chorus, warmth, volume and limiter.`;
}

/** README.txt for the zip. */
export function readmeText({ state, options, bars, songSeconds, frames, sampleRate, files, date = new Date(), midiName = null }) {
  const o = stemOptions(options);
  const g = state.global || {};
  const t = state.tuning;
  const tuning = (t && (t.name || t.id)) || '12-TET (equal temperament)';
  const seconds = frames / sampleRate;
  const depth = o.bits === 32 ? '32-bit float' : `${o.bits}-bit integer PCM${o.dither ? ', TPDF dither' : ', no dither'}`;
  const norm = { off: 'off (levels as in the session)', common: 'peak, one common gain for every file (keeps the mix balance), peaks at -1 dBFS', each: 'peak, each file on its own, peaks at -1 dBFS' }[o.normalise];
  const L = [];
  L.push('Oro stems export', '');
  L.push(`Exported: ${date.toLocaleString()}`);
  L.push(`Tempo: ${tempoText(g.tempo)} BPM, constant. Oro has no tempo changes, so the tempo map is one tempo event at bar 1 (see Tempo map.mid).`);
  L.push('Time signature: 4/4');
  L.push(`Key: ${keyName(state)}`);
  L.push(`Tuning: ${tuning}`);
  L.push(`Sample rate: ${sampleRate} Hz`);
  L.push(`Bit depth: ${depth}`);
  L.push(`Length: ${bars} bar${bars === 1 ? '' : 's'} (${songSeconds.toFixed(3)} s) plus ${(seconds - songSeconds).toFixed(3)} s tail = ${seconds.toFixed(3)} s, ${frames} samples per file`);
  L.push(`Stems: ${o.wet ? 'wet (each track with its delay, reverb and send effects)' : 'dry (no delay, reverb or send effects on the tracks)'}, ${o.fader === 'pre' ? 'pre-fader (track level ignored)' : 'post-fader'}`);
  L.push(`Send returns: ${o.returns ? 'included as their own files' : 'not included'}`);
  L.push(`Master processing on stems: ${o.master ? 'on (each file through the master chorus, warmth, volume and limiter)' : 'off (stems taken before the master chorus, warmth, volume and limiter, so they add up to the no-master mix)'}`);
  L.push(`Normalise: ${norm}`);
  L.push('', 'Files');
  for (const f of files) {
    if (f.kind === 'track') L.push(`${f.name}: track ${f.part + 1} "${f.label}" (${trackLine(state, f.part)})`);
    else if (f.kind === 'mix') L.push(`${f.name}: the full mix, as Bounce renders it`);
    else if (f.kind === 'mixraw') L.push(`${f.name}: the same mix before the master chorus, warmth, volume and limiter; the stems add up to this one`);
    else if (f.kind === 'surround') L.push(`${f.name}: ${surroundText(o)}`);
    else L.push(`${f.name}: ${f.label}, every track's send into it`);
  }
  if (midiName) L.push(`${midiName}: the notes of every track whose sequencer or arpeggiator plays, one MIDI track each`);
  L.push('Tempo map.mid: the tempo and time signature only');
  L.push('', 'How to import into a DAW');
  L.push(`1. Make a project at ${tempoText(g.tempo)} BPM in 4/4, at ${sampleRate} Hz if you can.`);
  L.push('2. Place every WAV file at bar 1 (time 0). They all start on the first beat and have the same length, so they line up sample for sample.');
  L.push('3. Drag the MIDI file in at bar 1 too if you want the notes; its tempo matches.');
  if (!o.wet && o.returns) L.push(o.master
    ? '4. The dry stems plus the return files add up to the mix. The master warmth and limiter act on the whole mix, so the sum can differ slightly when the mix drives them.'
    : '4. The dry stems plus the return files add up to "Mix (no master processing)". Put your own master processing on their sum.');
  else if (!o.master) L.push('4. The stems add up to "Mix (no master processing)". Put your own master processing on their sum.');
  L.push('');
  return L.join('\r\n');
}

/** Zip file name: oro-stems-YYYYMMDD-HHMMSS.zip */
export function zipName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `oro-stems-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.zip`;
}

/** Frames and size of an export before it starts (for the dialog's warning). */
export function exportSize(state, options = {}) {
  const o = stemOptions(options);
  const bars = o.length === 'song' ? songBars(state) : o.bars;
  const tempo = finite(state && state.global && state.global.tempo, 112);
  const tail = o.tail === 'auto' ? AUTO_TAIL_MAX : o.tail;
  const b = bounceOptions({ bars, tailSeconds: tail }, tempo);
  const evs = normaliseEvents(sequencerEvents(state, bars), b.songSeconds);
  const plan = planStems(state, evs, o);
  // a surround file counts as channels / 2 stereo files
  const files = plan.filter(p => p.file !== false).length + (o.surround !== 'off' ? 1 : 0);
  const weight = files + (o.surround !== 'off' ? SURROUND_LAYOUTS[o.surround].channels / 2 - 1 : 0);
  const bytes = estimateBytes({ seconds: b.songSeconds + tail, sampleRate: o.sampleRate, bits: o.bits, files: weight });
  return { bars, songSeconds: b.songSeconds, seconds: b.songSeconds + tail, files, bytes, warn: bytes > SIZE_WARN, refuse: bytes > SIZE_MAX };
}

/**
 * Render and pack. `engine.renderPasses` does the audio; `render(bars, o)`
 * (music.renderEvents) gives the events, the plain sequencers otherwise.
 * onProgress({ fraction, stage, label }). Resolves to
 * { blob, name, files: [names], frames, bytes }; rejects with a CancelError
 * when isCancelled() turns true.
 */
export async function exportStems({ state, engine, render = null, options = {}, onProgress = () => {}, isCancelled = () => false, date = new Date() }) {
  const o = stemOptions(options);
  const bars = o.length === 'song' ? songBars(state) : o.bars;
  const tempo = finite(state.global && state.global.tempo, 112);
  const sr = o.sampleRate;
  const maxTail = o.tail === 'auto' ? AUTO_TAIL_MAX : o.tail;
  const b = bounceOptions({ bars, tailSeconds: maxTail }, tempo);
  const n = Math.min(partCount(state), MAX_PARTS);
  const all = Array.from({ length: n }, (_, i) => i);
  const raw = typeof render === 'function' ? await render(bars, { parts: all }) : sequencerEvents(state, bars, { parts: all });
  const events = normaliseEvents(raw, b.songSeconds);
  const passes = planStems(state, events, o);
  const songFrames = Math.ceil(b.songSeconds * sr);
  let frames = songFrames + Math.round(maxTail * sr);
  const layout = o.surround !== 'off' ? SURROUND_LAYOUTS[o.surround] : null;
  const fileCount = passes.filter(p => p.file !== false).length;
  const est = estimateBytes({ seconds: frames / sr, sampleRate: sr, bits: o.bits, files: fileCount + (layout ? layout.channels / 2 : 0) });
  if (est > SIZE_MAX) throw new Error(`That export would be about ${(est / 1e9).toFixed(1)} GB, more than the ${SIZE_MAX / 1e9} GB limit. Use fewer bars, a lower sample rate or bit depth.`);

  const key = keyName(state);
  let index = 0;
  const rawNames = passes.map((p) => (p.file === false ? '' : stemFileName(o.pattern, { index: p.kind === 'mix' || p.kind === 'mixraw' ? 0 : ++index, name: p.label, tempo, key })));
  // 2.12 the surround file, after every other name
  if (layout) rawNames.push(`${sanitizeFileName(`Oro surround ${layout.id} ${tempoText(tempo)}bpm ${key}`)}.wav`);
  const names = uniqueNames(rawNames);
  const surIndex = layout ? names.length - 1 : -1;
  let surAcc = null;
  const surroundPass = { kind: 'surround', label: layout ? `Surround ${layout.id}` : '', part: null };
  const zip = createZipWriter();
  const files = [];
  const held = [];   // common normalisation: { blob, peak, i }
  const total = passes.length + 1;
  const report = (fraction, stage, label) => onProgress({ fraction: clamp(fraction, 0, 1), stage, label });

  const addWav = async (chans, i, gain) => {
    const sur = i === surIndex;
    const pieces = await encodeStemPieces(chans, frames, sr, { bits: o.bits, dither: o.dither, gain, seed: i + 1, isCancelled, channelMask: sur ? layout.mask : 0 });
    zip.add(names[i], pieces, { date });
    const p = sur ? surroundPass : passes[i];
    files.push({ name: names[i], kind: p.kind, label: p.label, part: p.part });
  };

  const done = await engine.renderPasses({
    sampleRate: sr,
    frames: (i) => (i === 0 ? songFrames + Math.round(maxTail * sr) : frames),
    passes,
    isCancelled,
    onFrames: (i, f) => report((i + 0.9 * f / Math.max(1, i === 0 ? songFrames + maxTail * sr : frames)) / total, 'render', passes[i].label),
    onPass: async (buffer, pass, i) => {
      if (isCancelled()) throw new CancelError();
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      if (i === 0) frames = o.tail === 'auto' ? autoTailFrames(chans, songFrames, sr) : Math.min(chans[0].length, frames);
      if (pass.file === false) {
        // 2.12 surround passes add up into the speaker channels
        if (!surAcc) surAcc = Array.from({ length: layout.channels }, () => new Float32Array(frames));
        const n = Math.min(frames, chans[0].length);
        if (chans.length >= layout.channels) { for (let c = 0; c < layout.channels; c++) { const a = surAcc[c], d = chans[c]; for (let f = 0; f < n; f++) a[f] += d[f]; } }
        else addStereoToSurround(surAcc, layout, chans[0], chans[1] || chans[0], n, o.spread ? SURROUND_SPREAD : 0);
        return;
      }
      const peak = measurePeak(chans, frames);
      report((i + 0.92) / total, 'encode', pass.label);
      if (o.normalise === 'common') {
        const pieces = [];
        for (let f = 0; f < frames; f += ENCODE_FRAMES) pieces.push(encodeSlice(chans, f, Math.min(ENCODE_FRAMES, frames - f), { bits: 32 }));
        held.push({ blob: new Blob(pieces), peak, i, channels: chans.length });
      } else {
        await addWav(chans, i, o.normalise === 'each' && peak > 1e-6 ? NORMALISE_PEAK / peak : 1);
      }
    },
  });
  if (done === false || isCancelled()) throw new CancelError();

  if (layout && surAcc) {
    if (o.lfe) fillLfe(surAcc, layout, frames, sr);
    const peak = measurePeak(surAcc, frames);
    report((passes.length + 0.2) / total, 'encode', surroundPass.label);
    if (o.normalise === 'common') {
      const pieces = [];
      for (let f = 0; f < frames; f += ENCODE_FRAMES) pieces.push(encodeSlice(surAcc, f, Math.min(ENCODE_FRAMES, frames - f), { bits: 32 }));
      held.push({ blob: new Blob(pieces), peak, i: surIndex, channels: layout.channels });
    } else await addWav(surAcc, surIndex, o.normalise === 'each' && peak > 1e-6 ? NORMALISE_PEAK / peak : 1);
    surAcc = null;
  }

  if (o.normalise === 'common') {
    const maxPeak = held.reduce((m, h) => Math.max(m, h.peak), 0);
    const gain = maxPeak > 1e-6 ? NORMALISE_PEAK / maxPeak : 1;
    for (const h of held.splice(0)) {
      const inter = new Float32Array(await h.blob.arrayBuffer());
      const chans = Array.from({ length: h.channels }, () => new Float32Array(frames));
      for (let f = 0, k = 0; f < frames; f++) for (let c = 0; c < h.channels; c++) chans[c][f] = inter[k++];
      await addWav(chans, h.i, gain);
      report((passes.length + 0.5) / total, 'encode', h.i === surIndex ? surroundPass.label : passes[h.i].label);
    }
  }

  let midiName = null;
  try {
    const midi = exportMidi(state, { mode: 'session', bars, render: typeof render === 'function' ? render : null });
    if (midi.tracks) {
      midiName = `${sanitizeFileName(`Oro session ${tempoText(tempo)}bpm ${key}`)}.mid`;
      zip.add(midiName, midi.bytes, { date });
    }
  } catch (err) { console.warn('[stems] MIDI export skipped', err); }
  zip.add('Tempo map.mid', writeMidi({ bpm: tempo, name: 'Tempo map', tracks: [] }), { date });
  zip.add('README.txt', readmeText({ state, options: o, bars, songSeconds: b.songSeconds, frames, sampleRate: sr, files, date, midiName }), { date });
  report(1, 'done', '');
  const blob = zip.finish();
  return { blob, name: zipName(date), files: zip.names.slice(), frames, bytes: blob.size, bars };
}
