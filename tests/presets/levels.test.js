// Renders every factory patch and the first four bars of every factory scene
// offline through the real DSP engine, and checks for NaN, silence, overload
// and badly balanced loudness. A few renders are written to
// /tmp/orograph-shots/music/ for listening.

import { describe, it, expect, beforeAll } from 'vitest';
import { OrographDSP } from '../../src/dsp/dsp-core.js';
import { FACTORY_PATCHES } from '../../src/presets/factory-patches.js';
import { FACTORY_SCENES } from '../../src/presets/factory-scenes.js';
import { loadPatch, render, renderScene, stats, db, writeWav, roughMix, SR } from './render.js';
import { NOTES, TARGET } from './levels-setup.js';

const OUT_DIR = '/tmp/orograph-shots/music';
const WAV_PATCHES = new Set(['Basalt Bass', 'Tidal Flats', 'Cirque Bell', 'Pebble Pluck', 'Summit Saw', 'Dust Devil']);

function renderPatch(patch) {
  const dsp = new OrographDSP(SR);
  dsp.handleMessage({ t: 'global', p: { tempo: 120 } });
  loadPatch(dsp, 0, patch);
  const { events, length } = NOTES(patch);
  for (const e of events) dsp.handleMessage(e);
  return render(dsp, length);
}

describe('factory patch levels', () => {
  const results = [];
  beforeAll(() => {
    for (const patch of FACTORY_PATCHES) {
      const out = renderPatch(patch);
      results.push({ patch, out, ...stats(out.L, out.R) });
      if (WAV_PATCHES.has(patch.name)) {
        const mixed = roughMix(out);
        writeWav(`${OUT_DIR}/patch-${patch.name.toLowerCase().replace(/\s+/g, '-')}.wav`, mixed.L, mixed.R);
      }
    }
  }, 240000);

  it('renders every patch without NaN, silence or overload', () => {
    for (const r of results) {
      expect(r.finite, r.patch.name).toBe(true);
      expect(db(r.rms), `${r.patch.name} is nearly silent`).toBeGreaterThan(-45);
      expect(r.peak, `${r.patch.name} peak`).toBeLessThan(1.5);
      expect(r.peak, `${r.patch.name} peak`).toBeLessThan(0.9);
    }
  });

  it('keeps every patch within 9 dB of the median loudness', () => {
    const levels = results.map(r => db(r.rms)).sort((a, b) => a - b);
    const median = levels[Math.floor(levels.length / 2)];
    for (const r of results) {
      expect(Math.abs(db(r.rms) - median), `${r.patch.name}: ${db(r.rms).toFixed(1)} dB vs median ${median.toFixed(1)}`).toBeLessThan(9);
    }
  });

  it('lands each patch near its category target', () => {
    for (const r of results) {
      const off = db(r.rms) - TARGET[r.patch.category];
      expect(Math.abs(off), `${r.patch.name} is ${off.toFixed(1)} dB from target`).toBeLessThan(4);
    }
  });
});

describe('factory scenes render', () => {
  for (const [i, scene] of FACTORY_SCENES.entries()) {
    it(`"${scene.name}" plays all its tracks without clipping`, () => {
      const { out, notes, state } = renderScene(scene, 4);
      const s = stats(out.L, out.R);
      expect(s.finite).toBe(true);
      for (let p = 0; p < state.parts.length; p++) expect(notes[p], `track ${p + 1} played no notes`).toBeGreaterThan(0);
      expect(db(s.meanRms), 'too quiet').toBeGreaterThan(-36);
      // Dry mix before the master limiter: leave real headroom.
      expect(s.peak, 'dry mix peak').toBeLessThan(1);
      const g = state.global;
      const mixed = roughMix(out, {
        tempo: g.tempo, delayBeats: [2, 1.5, 1, 0.75, 2 / 3, 0.5, 0.375, 1 / 3, 0.25, 0.125][g.delayDiv],
        feedback: g.delayFeedback, delayLevel: g.delayLevel, reverbLevel: g.reverbLevel,
      });
      writeWav(`${OUT_DIR}/scene-${i}-${scene.name.toLowerCase().replace(/\s+/g, '-')}.wav`, mixed.L, mixed.R);
    }, 120000);
  }
});
