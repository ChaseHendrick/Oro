// Reference scenes for the "new features are transparent at their defaults"
// test. dev/dsp/capture-reference.mjs rendered them with the engine as it was
// before Laps / Pace / Sub existed (commit 3544926) and stored the result in
// reference-v1.f32; tests/dsp/features.test.js renders them again with the
// current engine (laps 1, pace 0, sub 0 sent explicitly) and compares.
//
// The scenes deliberately cover every code path the features touch: the
// path block renderer (closed and open paths, unison, ramped param), the mip
// level choice (high note, big orbit), glide, envelopes, filter and the
// per-voice DC blocker. Do not edit them: the fixture would no longer match.

import { TERRAIN_INDEX as T, PATH_INDEX as P } from '../../../src/dsp/catalog.js';

export const REF_SR = 48000;
export const REF_FRAMES = 4800;   // 0.1 s per scene, stereo

const on = (note, time = 0, vel = 0.8) => ({ t: 'noteOn', part: 0, note, vel, time });
const off = (note, time) => ({ t: 'noteOff', part: 0, note, time });

export const REF_SCENES = [
  {
    name: 'default-chord',
    terrainA: T.swell, terrainB: T.massif,
    params: { release: 0.02 },
    mods: null,
    events: [on(57), on(64), off(57, 0.07)],
  },
  {
    name: 'spiro-unison-mono-glide',
    terrainA: T.massif, terrainB: T.ridge,
    params: {
      pathShape: P.spiro, pathOrder: 3, pathParam: 0.4, unison: 2, detune: 18, morph: 0.4, warp: 0.3,
      fold: 0.3, lift: 1.6, drive: 0.3, filterType: 2, resonance: 0.5, cutoff: 2500, polyMode: 1, glide: 0.05,
    },
    mods: {
      size: { lfoDepth: 0.2, lfoRate: 6 }, pathParam: { envDepth: 0.3 }, cutoff: { envDepth: -0.3 },
      centerX: { lfoDepth: 0.1, lfoRate: 3, lfoShape: 1 },
    },
    events: [on(48, 0, 1), on(55, 0.05, 0.9)],
  },
  {
    name: 'scan-high-spin',
    terrainA: T.spectra, terrainB: null,
    params: { pathShape: P.scan, pathOrder: 2, size: 0.5, centerY: 0.2, filterType: 0, spin: 2, stretch: 0.4, rotate: 30, attack: 0.001 },
    mods: null,
    events: [on(96, 0, 1)],
  },
  {
    name: 'lissa-poly-unison3',
    terrainA: T.cells, terrainB: T.fm,
    params: { pathShape: P.lissa, pathOrder: 2, unison: 3, spread: 1, detune: 25, size: 0.35, filterType: 1, cutoff: 5000, resonance: 0.3 },
    mods: { pan: { lfoDepth: 0.3, lfoRate: 8 }, morph: { lfoDepth: 0.5, lfoRate: 5, lfoShape: 2 } },
    events: [on(40), on(52, 0.01), on(59, 0.02), on(67, 0.03), { t: 'bend', part: 0, v: 0.5 }],
  },
];

/** Plays a scene on a fresh engine. `render` and `makeDSP` come from tests/dsp/helpers.js. */
export function renderScene(scene, { makeDSP, render }, extraParams = {}) {
  const dsp = makeDSP({ terrainA: scene.terrainA, terrainB: scene.terrainB, params: { ...scene.params, ...extraParams }, mods: scene.mods });
  for (const ev of scene.events) dsp.handleMessage(ev.time ? { ...ev } : { ...ev, time: 0 });
  return render(dsp, REF_FRAMES / REF_SR);
}
