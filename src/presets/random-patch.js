// Musical patch randomiser. Pure randomness over every knob mostly gives
// silence or noise, so it first picks an archetype (pluck, pad, lead, bass,
// keys, bell) that fixes the envelope, filter and voice settings within
// sensible ranges, then rolls the terrain pair, orbit and a few modulation
// recipes from a list of moves that show off the terrain (including Laps sync
// sweeps and Pace phase distortion), and sometimes a Sub under basses.
// Each archetype also gets an expressive Link or two (velocity, key, macro)
// and sometimes a Steps LFO pattern.

import { LFO_STEP_COUNT } from '../core/params.js';
import { TERRAINS, PATHS } from '../dsp/catalog.js';

const ADJECTIVES = ['Hidden', 'Distant', 'Silent', 'Northern', 'Sunken', 'Painted', 'Shifting', 'Hollow', 'Amber', 'Iron', 'Salt', 'Upper', 'Faded', 'Lost'];
const PLACES = ['Valley', 'Ridge', 'Cove', 'Basin', 'Mesa', 'Inlet', 'Moor', 'Delta', 'Plateau', 'Strait', 'Butte', 'Reef', 'Gorge', 'Tarn'];

const ARCHETYPES = {
  pluck: {
    category: 'Pluck',
    params: (r) => ({
      size: r.range(0.06, 0.12), attack: 0.001, decay: r.range(0.25, 0.9), sustain: 0, release: r.range(0.2, 0.6),
      env2Attack: 0.001, env2Decay: r.range(0.1, 0.3), env2Sustain: 0, env2Release: 0.2,
      cutoff: r.range(2500, 7000), resonance: r.range(0.05, 0.35), filterEnv: r.range(0.2, 0.45),
      delaySend: r.range(0.15, 0.35), reverbSend: r.range(0.15, 0.35), level: 0.72,
    }),
    mods: [['size', { envDepth: 0.3 }]],
  },
  pad: {
    category: 'Pad',
    params: (r) => ({
      size: r.range(0.16, 0.26), attack: r.range(0.8, 2.5), decay: 2, sustain: r.range(0.7, 1), release: r.range(2, 4.5),
      cutoff: r.range(1500, 4500), resonance: r.range(0.05, 0.25), filterEnv: 0,
      unison: r.int(2, 4), detune: r.range(8, 24), spread: r.range(0.7, 1),
      delaySend: r.range(0.05, 0.2), reverbSend: r.range(0.4, 0.65), level: 0.6,
    }),
    mods: [['centerX', { lfoShape: 5, lfoRate: 0.05, lfoDepth: 0.12 }], ['centerY', { lfoShape: 5, lfoRate: 0.04, lfoDepth: 0.12 }]],
  },
  lead: {
    category: 'Lead',
    params: (r) => ({
      size: r.range(0.18, 0.3), attack: r.range(0.003, 0.02), decay: 0.5, sustain: r.range(0.7, 0.9), release: r.range(0.15, 0.35),
      cutoff: r.range(3000, 7000), resonance: r.range(0.1, 0.3), filterEnv: r.range(0.1, 0.35),
      polyMode: 2, glide: r.range(0.03, 0.1), unison: r.int(1, 2), detune: r.range(6, 14),
      delaySend: r.range(0.15, 0.3), reverbSend: r.range(0.1, 0.25), level: 0.62,
    }),
    mods: [['fine', { lfoShape: 0, lfoRate: 5.4, lfoDepth: 0.025 }]],
  },
  bass: {
    category: 'Bass',
    params: (r) => ({
      size: r.range(0.16, 0.26), attack: 0.002, decay: r.range(0.3, 0.6), sustain: r.range(0.6, 0.9), release: 0.12,
      env2Attack: 0.002, env2Decay: r.range(0.15, 0.35), env2Sustain: 0.1, env2Release: 0.2,
      cutoff: r.range(500, 1400), resonance: r.range(0.15, 0.45), filterEnv: r.range(0.3, 0.55), drive: r.range(0.15, 0.4),
      polyMode: r.int(1, 2), glide: r.range(0, 0.06), octave: r.int(-1, 0),
      // Sub is on a squared taper: below about 0.3 it is barely there.
      sub: r.pick([0, 0, 0.35, 0.45, 0.6]),
      delaySend: 0, reverbSend: r.range(0, 0.08), level: 0.75,
    }),
    mods: [['size', { envDepth: 0.12 }]],
  },
  keys: {
    category: 'Keys',
    params: (r) => ({
      size: r.range(0.1, 0.16), attack: 0.002, decay: r.range(1, 2.4), sustain: r.range(0.2, 0.4), release: r.range(0.4, 0.8),
      env2Attack: 0.001, env2Decay: r.range(0.4, 0.8), env2Sustain: 0.15, env2Release: 0.5,
      cutoff: r.range(4000, 8000), resonance: 0.08, filterEnv: r.range(0.1, 0.3), velSens: 0.8,
      delaySend: 0.08, reverbSend: r.range(0.15, 0.3), level: 0.72,
    }),
    mods: [['size', { envDepth: 0.18 }]],
  },
  bell: {
    category: 'Bell',
    params: (r) => ({
      size: r.range(0.18, 0.28), attack: 0.001, decay: r.range(2, 4), sustain: 0, release: r.range(2, 3.5),
      env2Attack: 0.001, env2Decay: r.range(0.8, 1.6), env2Sustain: 0, env2Release: 1.2,
      cutoff: r.range(7000, 12000), resonance: 0.05, filterEnv: 0, spin: r.range(-0.5, 0.5),
      delaySend: r.range(0.1, 0.25), reverbSend: r.range(0.35, 0.55), level: 0.58,
    }),
    mods: [['morph', { envDepth: 0.25 }]],
  },
};

// Optional extra moves, each tasteful on its own.
const RECIPES = [
  (r) => ['morph', { lfoShape: r.pick([0, 1, 5]), lfoRate: r.range(0.03, 0.2), lfoDepth: r.range(0.15, 0.4) }],
  (r) => ['rotate', { lfoShape: r.pick([1, 2]), lfoRate: r.range(0.05, 0.4), lfoDepth: r.range(0.05, 0.25) }],
  (r) => ['pathParam', { lfoShape: 0, lfoRate: r.range(0.05, 0.3), lfoDepth: r.range(0.1, 0.3) }],
  (r) => ['warp', { lfoShape: 5, lfoRate: r.range(0.05, 0.2), lfoDepth: r.range(0.1, 0.3) }],
  (r) => ['centerX', { lfoShape: 5, lfoRate: r.range(0.02, 0.15), lfoDepth: r.range(0.05, 0.15) }],
  (r) => ['fold', { envDepth: r.range(0.1, 0.3) }],
  (r) => ['cutoff', { lfoShape: 0, lfoSync: 1, lfoDiv: r.pick([2, 3, 5]), lfoDepth: r.range(0.05, 0.2) }],
  // Envelope 2 sweeps Laps up from the plain orbit: a hard-sync zap on every note.
  (r) => ['laps', { envDepth: r.range(0.15, 0.4) }],
  // Pace wobbling either side of zero: phase distortion that breathes.
  (r) => ['pace', { lfoShape: r.pick([0, 1]), lfoRate: r.range(0.1, 0.6), lfoDepth: r.range(0.1, 0.25) }],
  // A Steps pattern over one bar: the orbit shape changes on every 16th.
  (r) => ['pathParam', { lfoShape: 6, lfoSync: 1, lfoDiv: 2, lfoDepth: r.range(0.08, 0.2), steps: stepValues(r) }],
];

const tidy = (v) => Math.round(v * 1000) / 1000;

// Indices into LINK_SOURCES: 0 Velocity, 1 Mod Wheel, 3 Key, 5 Macro 1, 6 Macro 2.
// Velocity links are small so a random patch stays within its archetype's level.
const LINKS = {
  pluck: (r) => [{ src: 0, dst: 'size', amt: r.range(0.05, 0.1), curve: 0 }, { src: 3, dst: 'cutoff', amt: r.range(0.1, 0.25), curve: 0 }],
  pad: (r) => [{ src: 5, dst: 'morph', amt: r.range(0.3, 0.6), curve: 0 }, { src: 6, dst: 'warp', amt: r.range(0.2, 0.4), curve: 1 }],
  lead: (r) => [{ src: 3, dst: 'cutoff', amt: r.range(0.15, 0.3), curve: 0 }, { src: 5, dst: 'morph', amt: r.range(0.3, 0.6), curve: 0 }],
  bass: (r) => [{ src: 5, dst: 'fold', amt: r.range(0.2, 0.4), curve: 0 }],
  keys: (r) => [{ src: 0, dst: 'size', amt: r.range(0.05, 0.1), curve: 0 }, { src: 5, dst: 'morph', amt: r.range(0.3, 0.5), curve: 0 }],
  bell: (r) => [{ src: 5, dst: 'morph', amt: r.range(0.3, 0.6), curve: 0 }],
};

/** 32 Steps LFO values: a strong downbeat and a loose, repeatable figure. */
function stepValues(r) {
  return Array.from({ length: LFO_STEP_COUNT }, (_, i) => (i % 4 === 0 ? tidy(0.6 + 0.4 * r.range(0, 1)) : r.range(-1, 0.8)));
}

export function randomPatch(rng = Math.random) {
  const r = {
    range: (lo, hi) => tidy(lo + (hi - lo) * rng()),
    int: (lo, hi) => lo + Math.min(hi - lo, Math.floor(rng() * (hi - lo + 1))),
    pick: (arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))],
  };
  const kind = r.pick(Object.keys(ARCHETYPES));
  const arch = ARCHETYPES[kind];
  const terrainIds = TERRAINS.map((t, i) => (t.id === 'user' ? -1 : i)).filter(i => i >= 0);
  // Scan and Scribble are specialist orbits; keep them rarer.
  const pathIds = PATHS.map((p, i) => i).filter(i => PATHS[i].id !== 'scan' || rng() < 0.3);
  const a = r.pick(terrainIds);
  let b = r.pick(terrainIds);
  if (b === a) b = terrainIds[(terrainIds.indexOf(a) + 1 + r.int(0, terrainIds.length - 2)) % terrainIds.length];
  const params = {
    terrainA: a, terrainB: b,
    morph: r.range(0, 0.5), warp: rng() < 0.3 ? r.range(0.05, 0.3) : 0,
    fold: rng() < 0.25 ? r.range(0.05, 0.3) : 0,
    seed: r.int(0, 99), detail: r.range(0.2, 0.8),
    pathShape: r.pick(pathIds), pathOrder: r.int(1, 6), pathParam: r.range(0.2, 0.8),
    stretch: rng() < 0.3 ? r.range(-0.3, 0.3) : 0,
    rotate: r.int(0, 359),
    paceShape: r.int(0, 2),
    filterType: 1, keyTrack: 0.5,
    ...arch.params(r),
  };
  // A Scan orbit only tiles seamlessly at full size.
  if (PATHS[params.pathShape].id === 'scan') { params.size = 0.5; params.stretch = 0; }
  const mods = {};
  for (const [id, m] of arch.mods) mods[id] = { ...m };
  const extra = 1 + r.int(0, 2);
  for (let i = 0; i < extra; i++) {
    const [id, m] = r.pick(RECIPES)(r);
    if (!mods[id]) mods[id] = m;
  }
  // The wheel keeps its classic job (Morph) on top of the archetype's own Links.
  const links = [{ src: 1, dst: 'morph', amt: 1, curve: 0 }, ...LINKS[kind](r)];
  return {
    name: `${r.pick(ADJECTIVES)} ${r.pick(PLACES)}`,
    category: arch.category,
    tags: ['random', kind],
    params,
    mods,
    links,
  };
}
