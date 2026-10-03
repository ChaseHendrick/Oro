// Drum generators: Euclidean lanes and the Groove pad.
import { describe, it, expect } from 'vitest';
import { KIT_PADS } from '../../src/dsp/drum-kit.js';
import { euclid, euclidLane, grooveLanes, countHits, GROOVE_STYLES } from '../../src/music/drum-gen.js';

const pattern = (a) => a.map(x => (x ? 'x' : '.')).join('');

describe('Euclidean rhythms', () => {
  it('spreads hits evenly (Bjorklund)', () => {
    expect(pattern(euclid(3, 8))).toBe('x..x..x.');
    expect(pattern(euclid(5, 8))).toBe('x.xx.xx.');
    expect(pattern(euclid(4, 16))).toBe('x...x...x...x...');
    expect(pattern(euclid(7, 16))).toBe('x..x.x.x..x.x.x.');
    expect(pattern(euclid(0, 4))).toBe('....');
    expect(pattern(euclid(9, 4))).toBe('xxxx');
    expect(euclid(3, 0)).toEqual([]);
    for (let n = 1; n <= 16; n++) for (let k = 0; k <= n; k++) expect(euclid(k, n).filter(Boolean).length).toBe(k);
  });

  it('rotates later by whole steps', () => {
    expect(pattern(euclid(3, 8, 1))).toBe('.x..x..x');
    expect(pattern(euclid(3, 8, 8))).toBe('x..x..x.');
    expect(pattern(euclid(3, 8, -1))).toBe('..x..x.x');
  });

  it('writes one lane over the pattern length and leaves the others', () => {
    const lanes = Array.from({ length: KIT_PADS }, () => new Array(16).fill(0));
    lanes[1][4] = 1;
    const out = euclidLane(lanes, 0, 3, 0, 8);
    expect(pattern(out[0])).toBe('x..x..x.........');
    expect(out[0][0]).toBe(0.8);
    expect(out[1][4]).toBe(1);
    expect(lanes[0].every(v => v === 0)).toBe(true);
  });
});

describe('Groove pad', () => {
  it('is deterministic, in range and empty past the pattern length', () => {
    for (const s of GROOVE_STYLES) {
      const a = grooveLanes({ style: s.id, complexity: 0.6, loudness: 0.5, fill: true, length: 12, seed: 3 });
      expect(a).toEqual(grooveLanes({ style: s.id, complexity: 0.6, loudness: 0.5, fill: true, length: 12, seed: 3 }));
      expect(a).toHaveLength(KIT_PADS);
      for (const row of a) {
        expect(row).toHaveLength(16);
        expect(row.every(v => v >= 0 && v <= 1)).toBe(true);
        expect(row.slice(12).every(v => v === 0)).toBe(true);
      }
      expect(countHits(a)).toBeGreaterThan(0);
    }
  });

  it('adds hits as complexity rises, never removes them', () => {
    for (const s of GROOVE_STYLES) for (const fill of [false, true]) for (const seed of [0, 1, 7]) {
      let prev = -1;
      for (let c = 0; c <= 1.0001; c += 0.05) {
        const n = countHits(grooveLanes({ style: s.id, complexity: c, loudness: 0.7, fill, seed }));
        expect(n).toBeGreaterThanOrEqual(prev);
        prev = n;
      }
      expect(countHits(grooveLanes({ style: s.id, complexity: 1, fill, seed }))).toBeGreaterThan(countHits(grooveLanes({ style: s.id, complexity: 0, fill, seed })));
    }
  });

  it('plays louder with loudness, without moving hits', () => {
    const q = grooveLanes({ style: 'broken', complexity: 0.7, loudness: 0.1 });
    const l = grooveLanes({ style: 'broken', complexity: 0.7, loudness: 1 });
    q.forEach((row, r) => row.forEach((v, c) => { expect(v > 0).toBe(l[r][c] > 0); expect(l[r][c]).toBeGreaterThanOrEqual(v); }));
  });

  it('has the backbone of each style at the lowest complexity', () => {
    const at = (style) => grooveLanes({ style, complexity: 0 });
    expect(at('four')[0].filter((v, i) => v > 0 && i % 4 === 0).length).toBe(4);
    expect(at('straight')[1][4]).toBeGreaterThan(0);
    expect(at('half')[1][8]).toBeGreaterThan(0);
    expect(at('half')[1][4]).toBe(0);
  });

  it('a fill ends the pattern with snare or toms', () => {
    const f = grooveLanes({ style: 'straight', complexity: 1, fill: true });
    for (let st = 12; st < 16; st++) expect(f[1][st] + f[5][st] + f[6][st]).toBeGreaterThan(0);
    expect(f[2].slice(12).every(v => v === 0)).toBe(true);
  });

  it('Vary changes the pattern but not the backbone', () => {
    const a = grooveLanes({ style: 'broken', complexity: 0.6, seed: 0 });
    const differs = [1, 2, 3, 4, 5].some(seed => JSON.stringify(grooveLanes({ style: 'broken', complexity: 0.6, seed })) !== JSON.stringify(a));
    expect(differs).toBe(true);
    for (const seed of [1, 2, 3]) expect(grooveLanes({ style: 'broken', complexity: 0.6, seed })[0][0]).toBeGreaterThan(0);
  });
});
