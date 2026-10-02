import { describe, it, expect } from 'vitest';
import { sampleCycle, findTrigger } from '../../src/ui/scope.js';
import { pathOutline, generateTerrain, hasPaths, hasGenerator, makeTransform, applyTransform } from '../../src/ui/dsp-bridge.js';
import { downsample } from '../../src/ui/terrain-art.js';
import { adaptGuide, mpcGuide, BUILTIN_GUIDE } from '../../src/ui/mpc-guide.js';
import { PART_PARAMS } from '../../src/core/params.js';
import { PATHS, PATH_NAMES } from '../../src/dsp/catalog.js';

const defaults = Object.fromEntries(PART_PARAMS.map(p => [p.id, p.default]));

describe('cycle view', () => {
  it('samples one finite cycle from a terrain', () => {
    const table = generateTerrain(0, { size: 64, seed: 7, detail: 0.5 }) || { size: 2, data: new Float32Array([0, 1, -1, 0]) };
    const out = sampleCycle(defaults, table, null, 128);
    expect(out.length).toBe(128);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    expect(Math.max(...out) - Math.min(...out)).toBeGreaterThan(0);
  });
  it('returns silence without a terrain', () => {
    const out = sampleCycle(defaults, null, null, 16);
    expect([...out].every(v => v === 0)).toBe(true);
  });
  it('triggers on a rising zero crossing', () => {
    const buf = new Float32Array(400);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((i + 30) / 20);
    const t = findTrigger(buf);
    expect(buf[t - 1]).toBeLessThanOrEqual(0);
    expect(buf[t]).toBeGreaterThan(0);
  });
  it('applies the shared path transform', () => {
    const xf = makeTransform(0, 0.25, 0, 0, 0.5, 0.5);
    const uv = applyTransform(xf, 1, 0, {});
    expect(uv.u).toBeCloseTo(0.75);
    expect(uv.v).toBeCloseTo(0.5);
  });
});

describe('path icons and previews', () => {
  it('outlines every path shape', () => {
    expect(hasPaths).toBe(true);
    expect(PATH_NAMES.length).toBe(PATHS.length);
    for (let i = 0; i < PATHS.length; i++) {
      const d = pathOutline(i, 3, 0.5, 24, 2, 64);
      expect(d.startsWith('M')).toBe(true);
      expect(d).not.toMatch(/NaN/);
    }
  });
  it('downsamples terrain tables for thumbnails', () => {
    if (!hasGenerator) return;
    const t = generateTerrain(5, { size: 128, seed: 3, detail: 0.5 });
    const d = downsample(t, 32);
    expect(d.size).toBe(32);
    expect(d.data.length).toBe(1024);
  });
});

describe('MPC guide', () => {
  it('normalises different guide shapes', () => {
    const g = adaptGuide([{ title: 'A', steps: ['one', { text: 'two', detail: 'more' }], checks: ['check'] }, 'loose']);
    expect(g[0].steps[1]).toEqual({ text: 'two', detail: 'more' });
    expect(g[0].checks).toEqual(['check']);
    expect(g[1].steps[0].text).toBe('loose');
    expect(adaptGuide(null)).toBeNull();
  });
  it('always has a guide to show', () => {
    const g = mpcGuide();
    expect(g.sections.length).toBeGreaterThan(2);
    expect(typeof g.intro).toBe('string');
    expect(adaptGuide(BUILTIN_GUIDE).length).toBe(BUILTIN_GUIDE.length);
    const text = JSON.stringify(g) + JSON.stringify(BUILTIN_GUIDE);
    expect(text).not.toMatch(/—/);
  });
});
