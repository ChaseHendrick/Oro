import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { featuresOf, searchFromFeatures, searchPatch, applyPatch, CANDIDATES } from '../../src/music/sound-match.js';

describe('match a sound', () => {
  it('hears a sine near its frequency and silence as quiet', () => {
    const rate = 48000;
    const n = 512;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * 440 * i / rate);
    const feat = featuresOf(sine, rate);
    expect(feat.centroid).toBeGreaterThan(200);
    expect(feat.centroid).toBeLessThan(900);
    const silence = featuresOf(new Float32Array(n), rate);
    expect(silence.rms).toBeLessThan(1e-6);
  });

  it('picks the closest candidate features and uses real catalog ids', () => {
    const sample = { spec: [0, 1, 0], env: [1, 0, 0, 0, 0, 0, 0, 0] };
    const list = [
      { terrain: 'swell', path: 'ellipse', features: { spec: [0, 0, 1], env: [0, 0, 0, 0, 0, 0, 0, 0] } },
      { terrain: 'spectra', path: 'scan', features: { spec: [0, 1, 0], env: [1, 0, 0, 0, 0, 0, 0, 0] } },
    ];
    const best = searchFromFeatures(sample, list);
    expect(best.terrain).toBe('spectra');
    expect(best.tried).toBe(2);
    const idsT = new Set(TERRAINS.map((t) => t.id));
    const idsP = new Set(PATHS.map((p) => p.id));
    expect(CANDIDATES.length).toBeGreaterThan(0);
    expect(CANDIDATES.length).toBeLessThanOrEqual(24);
    for (const c of CANDIDATES) {
      expect(idsT.has(c.terrain)).toBe(true);
      expect(idsP.has(c.path)).toBe(true);
      expect(c.terrain).not.toBe('user');
      expect(c.path).not.toBe('oro');
    }
    const found = searchPatch(new Float32Array(64), 48000);
    expect(found.tried).toBe(CANDIDATES.length);
  });

  it('writes the chosen patch through the store', () => {
    const sets = [];
    const store = { set(path, value) { sets.push([path, value]); } };
    const paths = applyPatch(store, 0, { terrain: 'spectra', path: 'scan', params: { terrainA: 1, pathShape: 2, cutoff: 800, attack: 0.01 } });
    expect(paths).toContain('parts.0.params.terrainA');
    expect(sets.some((s) => s[0] === 'parts.0.params.cutoff' && s[1] === 800)).toBe(true);
    const src = readFileSync(new URL('../../src/ui/sound-match.js', import.meta.url), 'utf8');
    expect(src.includes('\u2014')).toBe(false);
    expect(src.includes('Match a sound')).toBe(true);
  });
});
