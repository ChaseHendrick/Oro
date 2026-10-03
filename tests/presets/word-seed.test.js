// v2.9 Seed from a word: a stable hash, the same land and sound everywhere.
import { describe, it, expect } from 'vitest';
import { fnv1a, normalizeWord, wordSeed, wordPatch } from '../../src/presets/word-seed.js';

describe('seed from a word', () => {
  it('uses 32-bit FNV-1a over UTF-8', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
    // UTF-8 bytes, not UTF-16 code units
    expect(fnv1a('\u00e9')).toBe(0x1e9de8c1); // bytes C3 A9
    expect(fnv1a('é')).toBe(fnv1a('é'.normalize('NFC')));
  });

  it('tidies the word first', () => {
    expect(normalizeWord('  Tide  ')).toBe('tide');
    expect(normalizeWord('Salt   Marsh')).toBe('salt marsh');
    expect(normalizeWord('Café')).toBe('café');
    expect(wordSeed('TIDE')).toEqual(wordSeed(' tide '));
  });

  it('gives stable seeds for known words', () => {
    expect(wordSeed('tide')).toEqual({ word: 'tide', hash: fnv1a('tide'), seed: fnv1a('tide') % 100 });
    expect([wordSeed('oro').seed, wordSeed('tide').seed, wordSeed('mountain').seed, wordSeed('été').seed]).toEqual(KNOWN);
  });

  it('builds the same patch for the same word', () => {
    const a = wordPatch('Tide'), b = wordPatch('tide');
    expect(a).toEqual(b);
    expect(a.name).toBe('Tide');
    expect(a.params.seed).toBe(wordSeed('tide').seed);
    expect(a.tags[0]).toBe('word');
    expect(wordPatch('ember')).not.toEqual(a);
    expect(wordPatch('   ')).toBe(null);
  });
});

const KNOWN = [21, 65, 82, 35];
