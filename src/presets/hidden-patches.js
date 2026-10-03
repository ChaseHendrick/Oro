// v2.9 hidden patches: not in the factory list, offered only by the secrets
// that unlock them (src/ui/eggs.js). Same shape as a factory patch; loaded
// through presets.loadPatch(part, patchObject).

import { TERRAIN_INDEX as T, PATH_INDEX as P } from '../dsp/catalog.js';

const LOW = 1;
const LEGATO = 2;

/** A square-ish arcade lead: a lattice land traced by a square path, with a quick vibrato. */
export const CABINET_PATCH = Object.freeze({
  name: 'Cabinet', category: 'Lead', folder: 'Secret', tags: ['arcade', 'square', 'bright'],
  params: {
    terrainA: T.lattice, terrainB: T.terrace, morph: 0.18, seed: 81, detail: 0.3, lift: 1.2,
    pathShape: P.square, pathOrder: 1, pathParam: 0.05, size: 0.3,
    polyMode: LEGATO, glide: 0.015, velSens: 0.3,
    filterType: LOW, cutoff: 5200, resonance: 0.12, filterEnv: 0.1, keyTrack: 0.3, drive: 0.12,
    attack: 0.001, decay: 0.2, sustain: 0.75, release: 0.08,
    level: 0.5, delaySend: 0.12, reverbSend: 0.05,
  },
  mods: { centerX: { lfoDepth: 0.015, lfoRate: 5.5, lfoShape: 1 } },
});

/** A squelchy acid bass: resonant low-pass, strong filter envelope, drive and slides. */
export const ACID_PATCH = Object.freeze({
  name: 'Squelch', category: 'Bass', folder: 'Secret', tags: ['acid', 'resonant', 'mono'],
  params: {
    terrainA: T.spectra, terrainB: T.ridge, morph: 0.12, seed: 33, detail: 0.4, lift: 1.4, fold: 0.1,
    pathShape: P.polygon, pathOrder: 3, pathParam: 0.2, size: 0.24,
    polyMode: LEGATO, glide: 0.06, velSens: 0.6,
    filterType: LOW, cutoff: 420, resonance: 0.7, filterEnv: 0.8, keyTrack: 0.2, drive: 0.5,
    attack: 0.001, decay: 0.25, sustain: 0.45, release: 0.06,
    env2Attack: 0.001, env2Decay: 0.18, env2Sustain: 0, env2Release: 0.1,
    level: 0.5, delaySend: 0.08, reverbSend: 0.03,
  },
  mods: { fold: { envDepth: 0.15 } },
});

export const HIDDEN_PATCHES = Object.freeze([CABINET_PATCH, ACID_PATCH]);
