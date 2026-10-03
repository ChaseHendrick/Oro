// Seed from a word (v2.9): the same word gives the same land and the same
// sound on any computer. The word is tidied (Unicode NFC, trimmed, lower
// case, runs of spaces made one), hashed with 32-bit FNV-1a over its UTF-8
// bytes, and the hash seeds both the terrain Seed and the random patch
// generator (random-patch.js) through a small seeded generator.

import { randomPatch } from './random-patch.js';
import { mulberry32 } from '../dsp/terrain-math.js';

export const MAX_WORD = 40;

/** The tidied word ('' when nothing is left). */
export function normalizeWord(word) {
  let s = String(word ?? '');
  try { s = s.normalize('NFC'); } catch { /* very old engines */ }
  return s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_WORD);
}

function utf8(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (const ch of unescape(encodeURIComponent(str))) out.push(ch.charCodeAt(0));
  return out;
}

/** 32-bit FNV-1a of the UTF-8 bytes of `str` (unsigned). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const b of utf8(String(str))) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Hash and terrain seed (0..99, the range of the Seed knob) for a word. */
export function wordSeed(word) {
  const w = normalizeWord(word);
  const hash = fnv1a(w);
  return { word: w, hash, seed: hash % 100 };
}

/** The patch a word stands for, or null for an empty word. */
export function wordPatch(word) {
  const { word: w, hash, seed } = wordSeed(word);
  if (!w) return null;
  const patch = randomPatch(mulberry32(hash));
  patch.params.seed = seed;
  patch.name = w.charAt(0).toUpperCase() + w.slice(1);
  patch.tags = ['word', ...patch.tags.filter(t => t !== 'random')];
  return patch;
}
