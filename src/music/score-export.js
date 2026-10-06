// Scores out of Oro (2.17): a standard MIDI file for a DAW, and a link that
// opens an Oro page with the score on the desk.
//
//   scoreMidi(receipt)        type 1 SMF, one track per voice; drums on
//                             channel 10 with General MIDI notes
//   scoreLink(text, base)     base + '#score=' + 'z.' base64url(deflate-raw)
//   scoreFromHash(hash)       the score text in a #score= link, or null

import { writeMidi, PPQ, DRUM_CHANNEL } from './midi-file.js';
import { toBase64Url, fromBase64Url, SHARE_BASE } from '../presets/postcard.js';
import { swingBeat } from './transport.js';

export const MAX_SCORE_LINK_BYTES = 512 * 1024;

/** General MIDI drum notes for Oro's drum voices, so a DAW's drum kit plays them. */
export const GM_DRUMS = Object.freeze({
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, hitom: 50, rim: 37,
  crash: 49, crash2: 57, splash: 55, china: 52, ride: 51, ridebell: 53,
  kick2: 36, subkick: 35, snare2: 40, rimshot: 37, snap: 39, pedalhat: 44, floortom: 41, midtom: 47,
  shaker: 70, tambourine: 54, cowbell: 56, agogo: 67, conga: 63, tumba: 64, bongo: 60, timbale: 65,
  claves: 75, block: 76, triangle: 81, taiko: 35, bassdrum: 35, zap: 81, burst: 39,
});

/** A type 1 MIDI file of a checked score (check(text) with ok true). */
export function scoreMidi(receipt) {
  const score = receipt.score;
  const tick = (beat) => Math.round(swingBeat(beat, score.swing || 0) * PPQ);
  const byVoice = new Map();
  for (const n of score.notes) {
    if (!byVoice.has(n.voice)) byVoice.set(n.voice, []);
    byVoice.get(n.voice).push(n);
  }
  const tracks = [];
  let ch = 0;
  for (const [voice, notes] of byVoice) {
    const drum = notes[0].family === 'drum' || notes[0].family === 'perc';
    const channel = drum ? DRUM_CHANNEL : ch;
    if (!drum) { ch = (ch + 1) % 16; if (ch === DRUM_CHANNEL) ch = (ch + 1) % 16; }
    tracks.push({
      name: voice,
      channel,
      notes: notes.map((n) => ({
        note: drum ? (GM_DRUMS[voice] ?? 38) : n.midi,
        vel: Math.max(1, Math.round(n.vel * 127)),
        tick: tick(n.beat),
        dur: Math.max(1, tick(n.beat + n.len) - tick(n.beat)),
      })),
    });
  }
  return writeMidi({ bpm: score.bpm, name: score.title, ppq: PPQ, tracks });
}

async function pipe(bytes, stream, max) {
  const out = [];
  let total = 0;
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch { /* gone */ } throw new Error('too large'); }
    out.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of out) { all.set(c, o); o += c.length; }
  return all;
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** A link that opens an Oro page with this score on the desk (press play there). */
export async function scoreLink(text, base = SHARE_BASE) {
  const bytes = new TextEncoder().encode(String(text || ''));
  const data = canCompress()
    ? 'z.' + toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw'), Infinity))
    : 'j.' + toBase64Url(bytes);
  return `${base || SHARE_BASE}#score=${data}`;
}

/** The score text carried by a location hash ('#score=...'), or null. */
export async function scoreFromHash(hash) {
  const m = String(hash || '').match(/[#&]score=([zj])\.([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const raw = fromBase64Url(m[2]);
    if (!raw || raw.length > MAX_SCORE_LINK_BYTES) return null;
    const bytes = m[1] === 'z' ? (canCompress() ? await pipe(raw, new DecompressionStream('deflate-raw'), MAX_SCORE_LINK_BYTES) : null) : raw;
    return bytes ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
}
