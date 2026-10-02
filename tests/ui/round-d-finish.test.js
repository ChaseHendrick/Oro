import { describe, it, expect } from 'vitest';
import { barHeights, subLevel, SUB_GAIN } from '../../src/ui/scope.js';
import { bounceSeconds, BOUNCE_BARS } from '../../src/ui/bounce.js';
import { macroUsage, macroSourceIndex, MACRO_IDS } from '../../src/ui/macros.js';
import { paletteList, rampGradient } from '../../src/ui/palettes.js';
import { LINK_SOURCES } from '../../src/core/params.js';

describe('harmonic bars with the Sub', () => {
  it('puts the Sub first and scales everything to the strongest bar', () => {
    const mags = new Float32Array([1, 0.5, 0, 0.001]);
    const out = barHeights(mags, 0);
    expect(out.length).toBe(5);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1);
    // 0.5 is 6 dB down on a 48 dB scale
    expect(out[2]).toBeCloseTo(1 - 6.02 / 48, 2);
    expect(out[3]).toBe(0);
    // 0.001 is 60 dB down, below the 48 dB floor
    expect(out[4]).toBe(0);
  });
  it('lets a loud Sub become the reference', () => {
    const out = barHeights(new Float32Array([0.4]), subLevel(1));
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeLessThan(1);
  });
  it('follows the DSP sub curve', () => {
    expect(subLevel(0)).toBe(0);
    expect(subLevel(1)).toBeCloseTo(SUB_GAIN);
    expect(subLevel(0.5)).toBeCloseTo(SUB_GAIN * 0.25);
    expect(subLevel(7)).toBeCloseTo(SUB_GAIN);
    expect(subLevel('x')).toBe(0);
  });
  it('stays silent for a silent cycle', () => {
    const out = barHeights(new Float32Array(16), 0);
    expect([...out].every(v => v === 0)).toBe(true);
  });
});

describe('bounce helpers', () => {
  it('works out the musical length', () => {
    expect(bounceSeconds(4, 120)).toBeCloseTo(8);
    expect(bounceSeconds(1, 60)).toBeCloseTo(4);
    expect(bounceSeconds(0, 0)).toBeCloseTo(2);
    expect(BOUNCE_BARS).toContain(4);
  });
});

describe('macros', () => {
  it('finds each macro in the Links sources', () => {
    expect(MACRO_IDS).toEqual(['macro1', 'macro2', 'macro3', 'macro4']);
    for (let n = 1; n <= 4; n++) expect(LINK_SOURCES[macroSourceIndex(n)]).toBe(`Macro ${n}`);
  });
  it('counts the links that use each macro, ignoring zero amounts', () => {
    const m1 = macroSourceIndex(1), m3 = macroSourceIndex(3);
    const parts = [
      { links: [{ src: m1, dst: 'cutoff', amt: 0.5 }, { src: m3, dst: 'size', amt: 0 }] },
      { links: [{ src: m1, dst: 'morph', amt: -1 }, { src: 0, dst: 'morph', amt: 1 }] },
      {},
      { links: null },
    ];
    expect(macroUsage(parts)).toEqual([2, 0, 0, 0]);
    expect(macroUsage(null)).toEqual([0, 0, 0, 0]);
  });
});

describe('palettes', () => {
  it('normalises what the visuals report', () => {
    const v = { palettes: () => [{ name: 'Ember', dark: ['#000', '#ff0000', 'nope'], light: ['#fff'] }, 'Mono'] };
    const list = paletteList(v);
    expect(list).toEqual([
      { name: 'Ember', dark: ['#000', '#ff0000'], light: ['#fff'] },
      { name: 'Mono', dark: [], light: [] },
    ]);
    expect(paletteList({ palettes: ['A', 'B'] }).map(p => p.name)).toEqual(['A', 'B']);
    expect(paletteList(null)).toEqual([]);
    expect(paletteList({ palettes() { throw new Error('boom'); } }).length).toBeGreaterThan(0);
  });
  it('draws ramps as gradients', () => {
    expect(rampGradient([])).toBe('');
    expect(rampGradient(['#123'])).toBe('#123');
    expect(rampGradient(['#000', '#888', '#fff'])).toBe('linear-gradient(90deg, #000 0%, #888 50%, #fff 100%)');
  });
});
