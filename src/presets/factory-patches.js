// Factory patches. Each one is a partial parameter set applied over the
// defaults, plus per-parameter modulation. They are written to show what
// terrain synthesis does that other synths do not: the dot wandering over the
// map (centerX / centerY LFOs), terrains morphing into each other, rotating
// and spinning orbits, orbit-size envelopes for plucks and bells (the orbit
// grows from almost nothing, so brightness and loudness bloom together) and
// Fold for grit. Later patches add Laps (hard sync: the path is traced several
// times per cycle and restarted each cycle, so sweeping it gives the classic
// sync scream), Pace (phase distortion along the path) and the Sub sine.
//
// Levels were balanced by rendering every patch offline through the DSP
// engine (tests/presets/levels.test.js).

import { TERRAIN_INDEX as T, PATH_INDEX as P } from '../dsp/catalog.js';

const F = { off: 0, low: 1, band: 2, high: 3, notch: 4 };
const MODE = { poly: 0, mono: 1, legato: 2 };
const SH = { sine: 0, tri: 1, saw: 2, square: 3, sh: 4, drift: 5 };
const DIV = { '4bar': 0, '2bar': 1, '1bar': 2, '1/2': 3, '1/4.': 4, '1/4': 5, '1/8.': 6, '1/4T': 7, '1/8': 8, '1/16.': 9, '1/8T': 10, '1/16': 11, '1/32': 12 };
const DOT = { pin: 0, roll: 1, drift: 2 };
const PACE = { bend: 0, skew: 1, pinch: 2 };

/** Free-running LFO: depth in knob travel, rate in Hz. */
const lfo = (depth, rate, shape = SH.sine, more = {}) => ({ lfoDepth: depth, lfoRate: rate, lfoShape: shape, ...more });
/** Tempo-synced LFO. */
const synced = (depth, div, shape = SH.sine, more = {}) => ({ lfoDepth: depth, lfoSync: 1, lfoDiv: DIV[div], lfoShape: shape, ...more });
/** Envelope 2 amount. */
const env = (depth, more = {}) => ({ envDepth: depth, ...more });
const amp = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const env2 = (a, d, s, r) => ({ env2Attack: a, env2Decay: d, env2Sustain: s, env2Release: r });

export const CATEGORIES = ['Bass', 'Lead', 'Pad', 'Keys', 'Pluck', 'Bell', 'Texture', 'Drone', 'FX', 'Arp'];

export const FACTORY_PATCHES = [
  // ------------------------------------------------------------------ Bass
  {
    name: 'Basalt Bass', category: 'Bass', tags: ['round', 'punchy', 'mono'],
    params: {
      terrainA: T.swell, terrainB: T.ridge, morph: 0.18, lift: 1.3, fold: 0.08, seed: 11, detail: 0.35,
      pathShape: P.ellipse, pathOrder: 2, size: 0.2, sub: 0.45,
      polyMode: MODE.legato, glide: 0.04, velSens: 0.5,
      filterType: F.low, cutoff: 700, resonance: 0.28, filterEnv: 0.4, keyTrack: 0.4, drive: 0.3,
      ...amp(0.002, 0.5, 0.75, 0.12), ...env2(0.002, 0.28, 0.12, 0.2),
      level: 0.64, delaySend: 0, reverbSend: 0.06,
    },
    mods: { size: env(0.12), morph: env(0.15), centerX: lfo(0.025, 0.11, SH.drift) },
  },
  {
    name: 'Tar Pit Sub', category: 'Bass', tags: ['sub', 'clean', 'mono'],
    params: {
      terrainA: T.swell, terrainB: T.spectra, seed: 7, detail: 0.2,
      pathShape: P.ellipse, pathOrder: 1, size: 0.16, lift: 1.4,
      polyMode: MODE.mono, glide: 0.03, velSens: 0.4,
      filterType: F.low, cutoff: 280, resonance: 0.1, filterEnv: 0.2, keyTrack: 0.6, drive: 0.12,
      ...amp(0.004, 0.3, 0.9, 0.15), ...env2(0.002, 0.15, 0, 0.1),
      level: 0.87, delaySend: 0, reverbSend: 0,
    },
    mods: { size: env(0.08) },
  },
  {
    name: 'Fault Line', category: 'Bass', tags: ['gritty', 'folded', 'acid'],
    params: {
      terrainA: T.terrace, terrainB: T.lattice, morph: 0.3, lift: 1.6, fold: 0.3, seed: 23, detail: 0.6,
      pathShape: P.polygon, pathOrder: 3, pathParam: 0.25, size: 0.24,
      polyMode: MODE.mono, velSens: 0.6,
      filterType: F.low, cutoff: 1200, resonance: 0.38, filterEnv: 0.55, keyTrack: 0.3, drive: 0.45,
      ...amp(0.001, 0.35, 0.6, 0.1), ...env2(0.001, 0.22, 0.05, 0.15),
      level: 0.63, delaySend: 0.05, reverbSend: 0.05,
    },
    mods: { fold: env(0.25), rotate: synced(0.25, '1bar', SH.tri) },
  },
  {
    name: 'Delta Wobble', category: 'Bass', tags: ['wobble', 'synced', 'morph'],
    params: {
      terrainA: T.dunes, terrainB: T.fm, morph: 0.3, seed: 5, detail: 0.5,
      pathShape: P.ellipse, pathOrder: 3, size: 0.26, sub: 0.5,
      polyMode: MODE.legato, glide: 0.06,
      filterType: F.low, cutoff: 600, resonance: 0.45, filterEnv: 0.2, keyTrack: 0.4, drive: 0.35,
      ...amp(0.003, 0.5, 0.85, 0.15), ...env2(0.003, 0.3, 0.3, 0.2),
      level: 0.63, delaySend: 0.04, reverbSend: 0.05,
    },
    mods: { morph: synced(0.45, '1/8'), cutoff: synced(0.25, '1/8'), size: synced(0.08, '1/8') },
  },
  {
    name: 'Moraine Reese', category: 'Bass', tags: ['detuned', 'wide', 'dark'],
    params: {
      terrainA: T.massif, terrainB: T.ridge, morph: 0.4, lift: 1.4, seed: 42, detail: 0.45,
      pathShape: P.ellipse, pathOrder: 2, size: 0.22, spin: 0.25,
      // The detuned unison smears the low end; the Sub keeps a solid mono root under it.
      polyMode: MODE.mono, glide: 0.05, unison: 3, detune: 22, spread: 0.35, sub: 0.55,
      filterType: F.low, cutoff: 900, resonance: 0.2, filterEnv: 0.25, keyTrack: 0.4, drive: 0.35,
      ...amp(0.004, 0.6, 0.9, 0.2), ...env2(0.004, 0.4, 0.3, 0.3),
      level: 0.54, delaySend: 0.05, reverbSend: 0.1,
    },
    mods: { rotate: lfo(0.15, 0.2, SH.tri), morph: lfo(0.2, 0.13, SH.drift) },
  },
  {
    name: 'Undertow Bass', category: 'Bass', tags: ['phase distortion', 'pace', 'sub'],
    params: {
      terrainA: T.fm, terrainB: T.dunes, morph: 0.25, seed: 9, detail: 0.4, lift: 1.2,
      pathShape: P.ellipse, pathOrder: 2, size: 0.2, pace: -0.15, paceShape: PACE.skew, sub: 0.45,
      polyMode: MODE.mono, glide: 0.03, velSens: 0.5,
      filterType: F.low, cutoff: 1100, resonance: 0.3, filterEnv: 0.35, keyTrack: 0.4, drive: 0.3,
      ...amp(0.002, 0.45, 0.7, 0.12), ...env2(0.001, 0.25, 0.1, 0.2),
      level: 0.58, delaySend: 0, reverbSend: 0.05,
    },
    // Pace leans on the attack, then a quarter-note sweep keeps the tone rocking.
    mods: { pace: env(-0.3, synced(0.22, '1/4', SH.tri)), size: env(0.08) },
  },
  {
    name: 'Sinkhole Sub', category: 'Bass', tags: ['sub', 'deep', 'mono'],
    params: {
      terrainA: T.ripple, terrainB: T.massif, morph: 0.2, seed: 16, detail: 0.35, lift: 1.3,
      pathShape: P.lissa, pathOrder: 1, pathParam: 0.5, size: 0.12, sub: 0.7,
      polyMode: MODE.mono, glide: 0.02, velSens: 0.45,
      filterType: F.low, cutoff: 900, resonance: 0.1, filterEnv: 0.25, keyTrack: 0.5, drive: 0.2,
      ...amp(0.003, 0.4, 0.85, 0.14), ...env2(0.001, 0.2, 0, 0.15),
      level: 0.64, delaySend: 0, reverbSend: 0,
    },
    // The Sub carries the weight; the small orbit only adds a growl an octave up.
    mods: { size: env(0.15), morph: lfo(0.1, 0.13, SH.drift) },
  },

  // ------------------------------------------------------------------ Lead
  {
    name: 'Ridgeline Lead', category: 'Lead', tags: ['bright', 'expressive', 'legato'],
    params: {
      terrainA: T.ridge, terrainB: T.swell, morph: 0.35, seed: 3, detail: 0.55,
      pathShape: P.rose, pathOrder: 3, pathParam: 0.55, size: 0.27,
      polyMode: MODE.legato, glide: 0.07, unison: 2, detune: 9, spread: 0.5,
      filterType: F.low, cutoff: 4200, resonance: 0.22, filterEnv: 0.3, keyTrack: 0.6, drive: 0.15,
      ...amp(0.006, 0.6, 0.8, 0.25), ...env2(0.01, 0.5, 0.35, 0.4),
      level: 0.79, delaySend: 0.22, reverbSend: 0.2,
    },
    mods: { fine: lfo(0.025, 5.4), centerY: lfo(0.05, 0.17, SH.tri), size: env(0.08) },
  },
  {
    name: 'Summit Saw', category: 'Lead', tags: ['wavetable', 'supersaw', 'classic'],
    params: {
      terrainA: T.spectra, terrainB: T.lattice, morph: 0, seed: 7, detail: 0.7,
      pathShape: P.scan, pathOrder: 1, pathParam: 0.5, size: 0.5, centerY: 0.27,
      polyMode: MODE.legato, glide: 0.05, unison: 3, detune: 16, spread: 0.7,
      filterType: F.low, cutoff: 5200, resonance: 0.18, filterEnv: 0.35, keyTrack: 0.5,
      ...amp(0.005, 0.4, 0.85, 0.3), ...env2(0.005, 0.45, 0.3, 0.35),
      level: 0.45, delaySend: 0.2, reverbSend: 0.2,
    },
    mods: { centerY: lfo(0.06, 0.3, SH.tri) },
  },
  {
    name: 'Glacier Whistle', category: 'Lead', tags: ['pure', 'airy', 'vibrato'],
    params: {
      terrainA: T.swell, terrainB: T.ripple, morph: 0.1, seed: 2, detail: 0.2,
      pathShape: P.lissa, pathOrder: 1, pathParam: 0.5, size: 0.1, octave: 1, lift: 1.6,
      polyMode: MODE.legato, glide: 0.12,
      filterType: F.low, cutoff: 6000, resonance: 0.1, filterEnv: 0, keyTrack: 0.5,
      ...amp(0.04, 0.3, 0.9, 0.35),
      level: 0.83, delaySend: 0.3, reverbSend: 0.35,
    },
    mods: { fine: lfo(0.03, 5.8), size: lfo(0.04, 0.25, SH.tri) },
  },
  {
    name: 'Escarpment Sync', category: 'Lead', tags: ['sweep', 'aggressive', 'size envelope'],
    params: {
      terrainA: T.canyon, terrainB: T.fm, morph: 0.25, seed: 17, detail: 0.6,
      pathShape: P.star, pathOrder: 5, pathParam: 0.35, size: 0.15,
      polyMode: MODE.mono,
      filterType: F.low, cutoff: 3800, resonance: 0.25, filterEnv: 0.2, keyTrack: 0.5, drive: 0.25,
      ...amp(0.003, 0.5, 0.75, 0.2), ...env2(0.001, 0.45, 0.2, 0.3),
      level: 0.62, delaySend: 0.18, reverbSend: 0.15,
    },
    mods: { size: env(0.35), rotate: env(0.2) },
  },
  {
    name: 'Contour Lead', category: 'Lead', tags: ['nasal', 'resonant', 'stretch'],
    params: {
      terrainA: T.cells, terrainB: T.swell, morph: 0.2, seed: 31, detail: 0.4,
      pathShape: P.ellipse, pathOrder: 2, pathParam: 0.35, size: 0.27, stretch: 0.2, lift: 1.3,
      polyMode: MODE.legato, glide: 0.05,
      filterType: F.low, cutoff: 2400, resonance: 0.42, filterEnv: 0.35, keyTrack: 0.7,
      ...amp(0.005, 0.4, 0.8, 0.25), ...env2(0.005, 0.35, 0.3, 0.3),
      level: 0.82, delaySend: 0.2, reverbSend: 0.18,
    },
    mods: { stretch: lfo(0.2, 0.4, SH.tri), fine: lfo(0.02, 5) },
  },
  {
    name: 'Rift Sync', category: 'Lead', tags: ['hard sync', 'laps sweep', 'envelope'],
    params: {
      terrainA: T.swell, terrainB: T.canyon, morph: 0.15, seed: 21, detail: 0.4,
      pathShape: P.ellipse, pathOrder: 1, pathParam: 0.5, size: 0.26, lift: 1.4, laps: 1.5,
      polyMode: MODE.legato, glide: 0.06, unison: 2, detune: 7, spread: 0.5,
      filterType: F.low, cutoff: 5500, resonance: 0.18, filterEnv: 0.15, keyTrack: 0.5, drive: 0.15,
      ...amp(0.004, 0.5, 0.85, 0.25), ...env2(0.002, 0.9, 0.25, 0.4),
      level: 0.68, delaySend: 0.2, reverbSend: 0.18,
    },
    // Envelope 2 throws Laps up to about 4.4 and lets it fall back to about 2.2: the sync sweep.
    mods: { laps: env(0.42), fine: lfo(0.02, 5.2) },
  },

  // ------------------------------------------------------------------- Pad
  {
    name: 'Tidal Flats', category: 'Pad', tags: ['warm', 'drifting', 'wide'],
    params: {
      terrainA: T.swell, terrainB: T.dunes, morph: 0.3, seed: 8, detail: 0.4,
      pathShape: P.ellipse, pathOrder: 2, size: 0.21,
      unison: 3, detune: 16, spread: 0.9,
      filterType: F.low, cutoff: 3200, resonance: 0.12, filterEnv: 0.1, keyTrack: 0.5,
      ...amp(1.4, 1.5, 0.85, 2.8), ...env2(1.5, 2, 0.6, 2.5),
      level: 0.68, delaySend: 0.15, reverbSend: 0.5,
    },
    mods: { morph: lfo(0.3, 0.06), centerX: lfo(0.12, 0.05, SH.drift), centerY: lfo(0.12, 0.043, SH.drift) },
    dot: { mode: DOT.drift, driftSpeed: 0.2 },
  },
  {
    name: 'Aurora Plateau', category: 'Pad', tags: ['shimmer', 'slow morph', 'spin'],
    params: {
      terrainA: T.spectra, terrainB: T.vortex, morph: 0.2, seed: 12, detail: 0.5,
      pathShape: P.rose, pathOrder: 5, pathParam: 0.75, size: 0.24, spin: 0.12,
      unison: 2, detune: 12, spread: 0.8,
      filterType: F.low, cutoff: 4500, resonance: 0.15, filterEnv: 0, keyTrack: 0.5,
      ...amp(2, 2, 0.8, 3.5),
      level: 0.56, delaySend: 0.2, reverbSend: 0.55,
    },
    mods: { morph: synced(0.35, '4bar', SH.tri), pathParam: lfo(0.2, 0.08), centerY: lfo(0.05, 0.07, SH.drift) },
  },
  {
    name: 'Fjord Choir', category: 'Pad', tags: ['vocal', 'formant', 'airy'],
    params: {
      terrainA: T.ripple, terrainB: T.swell, morph: 0.45, seed: 19, detail: 0.45,
      pathShape: P.lissa, pathOrder: 2, pathParam: 0.3, size: 0.19,
      unison: 3, detune: 10, spread: 0.85,
      filterType: F.band, cutoff: 1200, resonance: 0.28, filterEnv: 0.05, keyTrack: 0.6,
      ...amp(0.9, 1.2, 0.9, 2.2),
      level: 0.67, delaySend: 0.1, reverbSend: 0.6,
    },
    mods: { centerX: lfo(0.1, 0.07, SH.tri), cutoff: lfo(0.06, 0.11), fine: lfo(0.015, 4.7) },
  },
  {
    name: 'Monsoon Haze', category: 'Pad', tags: ['thick', 'warped', 'evolving'],
    params: {
      terrainA: T.massif, terrainB: T.crater, morph: 0.4, seed: 27, detail: 0.5, warp: 0.15,
      pathShape: P.spiral, pathOrder: 2, pathParam: 0.6, size: 0.24,
      unison: 4, detune: 24, spread: 1,
      filterType: F.low, cutoff: 2400, resonance: 0.2, filterEnv: 0, keyTrack: 0.5,
      ...amp(1.6, 2, 0.8, 3),
      level: 0.84, delaySend: 0.2, reverbSend: 0.5,
    },
    mods: { warp: lfo(0.3, 0.09, SH.drift), morph: lfo(0.25, 0.05), centerX: lfo(0.08, 0.04, SH.drift) },
  },
  {
    name: 'Lowland Mist', category: 'Pad', tags: ['soft', 'dark', 'slow'],
    params: {
      terrainA: T.fm, terrainB: T.swell, morph: 0.6, seed: 4, detail: 0.25,
      pathShape: P.ellipse, pathOrder: 1, pathParam: 0.62, size: 0.17,
      unison: 2, detune: 8, spread: 0.7,
      filterType: F.low, cutoff: 1500, resonance: 0.1, filterEnv: 0, keyTrack: 0.6,
      ...amp(2.5, 2, 1, 4),
      level: 0.63, delaySend: 0.08, reverbSend: 0.65,
    },
    mods: { morph: lfo(0.35, 0.04, SH.drift), size: lfo(0.08, 0.07, SH.tri) },
  },
  {
    name: 'Orbital Haze', category: 'Pad', tags: ['laps', 'slow sync sweep', 'wide'],
    params: {
      terrainA: T.swell, terrainB: T.vortex, morph: 0.3, seed: 33, detail: 0.45,
      pathShape: P.ellipse, pathOrder: 2, size: 0.2, laps: 2.3, sub: 0.15,
      unison: 3, detune: 14, spread: 0.9,
      filterType: F.low, cutoff: 2800, resonance: 0.15, filterEnv: 0, keyTrack: 0.5,
      ...amp(1.5, 2, 0.85, 3),
      level: 0.72, delaySend: 0.15, reverbSend: 0.55,
    },
    // A very slow Laps LFO (about 1.5 to 3.1 laps over 16 s) makes the sync harmonics drift like weather.
    mods: { laps: lfo(0.12, 0.06), morph: lfo(0.2, 0.045, SH.drift), centerX: lfo(0.06, 0.03, SH.drift) },
  },

  // ------------------------------------------------------------------ Keys
  {
    name: 'Sandstone Keys', category: 'Keys', tags: ['piano-ish', 'velocity', 'warm'],
    params: {
      terrainA: T.swell, terrainB: T.fm, morph: 0.25, seed: 9, detail: 0.35,
      pathShape: P.ellipse, pathOrder: 3, size: 0.12, velSens: 0.8,
      filterType: F.low, cutoff: 5500, resonance: 0.1, filterEnv: 0.25, keyTrack: 0.7,
      ...amp(0.002, 1.6, 0.3, 0.6), ...env2(0.001, 0.7, 0.15, 0.5),
      level: 0.75, delaySend: 0.08, reverbSend: 0.25,
    },
    mods: { size: env(0.2), morph: env(0.2) },
  },
  {
    name: 'Lagoon EP', category: 'Keys', tags: ['electric piano', 'tremolo', 'mellow'],
    params: {
      terrainA: T.fm, terrainB: T.ripple, morph: 0.15, seed: 14, detail: 0.3,
      pathShape: P.ellipse, pathOrder: 2, size: 0.13, velSens: 0.75,
      unison: 2, detune: 6, spread: 0.6,
      filterType: F.low, cutoff: 7000, resonance: 0.05, filterEnv: 0.15, keyTrack: 0.6,
      ...amp(0.002, 2.2, 0.25, 0.7), ...env2(0.001, 0.35, 0, 0.4),
      level: 0.52, delaySend: 0.1, reverbSend: 0.22,
    },
    mods: { size: env(0.18), pan: lfo(0.25, 4.5) },
  },
  {
    name: 'Mesa Organ', category: 'Keys', tags: ['organ', 'rotary', 'sustained'],
    params: {
      terrainA: T.lattice, terrainB: T.spectra, morph: 0.25, seed: 6, detail: 0.3,
      pathShape: P.polygon, pathOrder: 4, pathParam: 0.8, size: 0.2,
      filterType: F.low, cutoff: 6500, resonance: 0.05, filterEnv: 0, keyTrack: 0.5, drive: 0.18,
      ...amp(0.008, 0.2, 1, 0.08),
      level: 0.35, delaySend: 0.05, reverbSend: 0.2,
    },
    mods: { pan: lfo(0.2, 5.8), centerX: lfo(0.02, 5.8) },
  },
  {
    name: 'Atoll Clav', category: 'Keys', tags: ['funky', 'percussive', 'resonant'],
    params: {
      terrainA: T.terrace, terrainB: T.cells, morph: 0.35, seed: 21, detail: 0.55, fold: 0.12,
      pathShape: P.polygon, pathOrder: 6, pathParam: 0.3, size: 0.2, lift: 1.4, velSens: 0.85,
      filterType: F.low, cutoff: 3000, resonance: 0.38, filterEnv: 0.4, keyTrack: 0.7, drive: 0.15,
      ...amp(0.001, 0.45, 0.15, 0.12), ...env2(0.001, 0.2, 0, 0.1),
      level: 0.68, delaySend: 0.1, reverbSend: 0.12,
    },
    mods: { fold: env(0.2), size: env(0.12) },
  },
  {
    name: 'Kiln Keys', category: 'Keys', tags: ['phase distortion', 'skew', 'bright attack'],
    params: {
      terrainA: T.swell, terrainB: T.terrace, morph: 0.15, seed: 41, detail: 0.35,
      pathShape: P.ellipse, pathOrder: 1, size: 0.16, lift: 1.5, pace: -0.1, paceShape: PACE.skew, sub: 0.12, velSens: 0.8,
      filterType: F.low, cutoff: 6000, resonance: 0.08, filterEnv: 0.2, keyTrack: 0.7,
      ...amp(0.002, 1.5, 0.3, 0.6), ...env2(0.001, 0.6, 0.1, 0.5),
      level: 0.68, delaySend: 0.08, reverbSend: 0.25,
    },
    // A skewed Pace on the strike, relaxing as Envelope 2 decays: the bright-then-mellow keys of phase distortion.
    mods: { pace: env(-0.42), size: env(0.15) },
  },

  // ----------------------------------------------------------------- Pluck
  {
    name: 'Pebble Pluck', category: 'Pluck', tags: ['soft', 'size envelope', 'clean'],
    params: {
      terrainA: T.ripple, terrainB: T.swell, morph: 0.2, seed: 1, detail: 0.5,
      pathShape: P.ellipse, pathOrder: 2, size: 0.07,
      filterType: F.low, cutoff: 5000, resonance: 0.15, filterEnv: 0.35, keyTrack: 0.6,
      ...amp(0.001, 0.55, 0, 0.35), ...env2(0.001, 0.16, 0, 0.2),
      level: 0.83, delaySend: 0.25, reverbSend: 0.3,
    },
    mods: { size: env(0.38), morph: env(0.25) },
  },
  {
    name: 'Scree Pluck', category: 'Pluck', tags: ['bright', 'folded', 'snappy'],
    params: {
      terrainA: T.ridge, terrainB: T.terrace, morph: 0.2, seed: 44, detail: 0.6, fold: 0.05,
      pathShape: P.star, pathOrder: 4, pathParam: 0.4, size: 0.1, lift: 1.3,
      filterType: F.low, cutoff: 4200, resonance: 0.3, filterEnv: 0.4, keyTrack: 0.6, drive: 0.2,
      ...amp(0.001, 0.35, 0, 0.25), ...env2(0.001, 0.12, 0, 0.15),
      level: 0.84, delaySend: 0.2, reverbSend: 0.2,
    },
    mods: { size: env(0.32), fold: env(0.3) },
  },
  {
    name: 'Harbour Harp', category: 'Pluck', tags: ['harp', 'ringing', 'star path'],
    params: {
      terrainA: T.swell, terrainB: T.spectra, morph: 0.35, seed: 13, detail: 0.45,
      pathShape: P.star, pathOrder: 5, pathParam: 0.7, size: 0.11, lift: 1.3, velSens: 0.7,
      filterType: F.low, cutoff: 6500, resonance: 0.08, filterEnv: 0.2, keyTrack: 0.8,
      ...amp(0.001, 1.8, 0, 1.4), ...env2(0.001, 0.4, 0, 0.6),
      level: 0.78, delaySend: 0.15, reverbSend: 0.45,
    },
    mods: { size: env(0.3), rotate: lfo(0.05, 0.3) },
  },
  {
    name: 'Kelp Pizzicato', category: 'Pluck', tags: ['short', 'woody', 'figure eight'],
    params: {
      terrainA: T.cells, terrainB: T.swell, morph: 0.15, seed: 35, detail: 0.4,
      pathShape: P.eight, pathOrder: 1, pathParam: 0.5, size: 0.2, lift: 1.7,
      filterType: F.low, cutoff: 2600, resonance: 0.2, filterEnv: 0.4, keyTrack: 0.8,
      ...amp(0.001, 0.3, 0, 0.18), ...env2(0.001, 0.1, 0, 0.1),
      level: 0.87, delaySend: 0.12, reverbSend: 0.2,
    },
    mods: { size: env(0.2) },
  },
  {
    name: 'Shale Pluck', category: 'Pluck', tags: ['gritty', 'triangle orbit', 'echo'],
    params: {
      terrainA: T.terrace, terrainB: T.ridge, morph: 0.25, seed: 52, detail: 0.7, fold: 0.1,
      pathShape: P.polygon, pathOrder: 3, pathParam: 0.15, size: 0.1,
      filterType: F.low, cutoff: 3600, resonance: 0.35, filterEnv: 0.45, keyTrack: 0.6, drive: 0.3,
      ...amp(0.001, 0.4, 0, 0.25), ...env2(0.001, 0.15, 0, 0.15),
      level: 1, delaySend: 0.3, reverbSend: 0.2,
    },
    mods: { size: env(0.3), fold: env(0.35), rotate: lfo(0.1, 0.5, SH.tri) },
  },
  {
    name: 'Flint Sync', category: 'Pluck', tags: ['hard sync', 'zap', 'laps envelope'],
    params: {
      terrainA: T.fm, terrainB: T.canyon, morph: 0.2, seed: 48, detail: 0.5,
      pathShape: P.ellipse, pathOrder: 1, size: 0.12, lift: 1.6,
      filterType: F.low, cutoff: 5000, resonance: 0.15, filterEnv: 0.35, keyTrack: 0.6,
      ...amp(0.001, 0.5, 0, 0.3), ...env2(0.001, 0.25, 0, 0.2),
      level: 0.7, delaySend: 0.25, reverbSend: 0.25,
    },
    // Each note starts as a sync zap (about 3.8 laps) and settles onto the plain orbit.
    mods: { laps: env(0.4), size: env(0.36) },
  },

  // ------------------------------------------------------------------ Bell
  {
    name: 'Cirque Bell', category: 'Bell', tags: ['bell', 'rose path', 'shimmer'],
    params: {
      terrainA: T.fm, terrainB: T.ripple, morph: 0.3, seed: 15, detail: 0.7,
      pathShape: P.rose, pathOrder: 7, pathParam: 0.35, size: 0.24, spin: 0.4, velSens: 0.7,
      filterType: F.low, cutoff: 9000, resonance: 0.05, filterEnv: 0.1, keyTrack: 0.8,
      ...amp(0.001, 3.5, 0, 3), ...env2(0.001, 1.5, 0, 1.5),
      level: 0.7, delaySend: 0.15, reverbSend: 0.45,
    },
    mods: { size: env(0.12), morph: env(0.25), pathParam: lfo(0.08, 0.2) },
  },
  {
    name: 'Iceshelf Chime', category: 'Bell', tags: ['glassy', 'high', 'cusps'],
    params: {
      terrainA: T.fm, terrainB: T.spectra, morph: 0.15, seed: 29, detail: 0.85,
      pathShape: P.cusp, pathOrder: 5, pathParam: 0.5, size: 0.2, octave: 1,
      filterType: F.low, cutoff: 12000, resonance: 0.05, filterEnv: 0, keyTrack: 0.5,
      ...amp(0.001, 2.4, 0, 2.2), ...env2(0.001, 0.9, 0, 1),
      level: 0.61, delaySend: 0.25, reverbSend: 0.5,
    },
    mods: { size: env(0.15), rotate: lfo(0.1, 0.15) },
  },
  {
    name: 'Caldera Gong', category: 'Bell', tags: ['gong', 'deep', 'long'],
    params: {
      terrainA: T.crater, terrainB: T.fm, morph: 0.35, seed: 38, detail: 0.6,
      pathShape: P.spiro, pathOrder: 5, pathParam: 0.4, size: 0.26, octave: -1, spin: 0.08,
      filterType: F.low, cutoff: 5000, resonance: 0.1, filterEnv: 0.15, keyTrack: 0.5,
      ...amp(0.002, 6, 0, 5), ...env2(0.002, 4, 0, 4),
      level: 0.67, delaySend: 0.1, reverbSend: 0.5,
    },
    mods: { morph: env(0.3), size: env(0.1), rotate: lfo(0.2, 0.12) },
  },
  {
    name: 'Meridian Bell', category: 'Bell', tags: ['bell', 'polygon', 'spinning'],
    params: {
      terrainA: T.ripple, terrainB: T.fm, morph: 0.5, seed: 46, detail: 0.6,
      pathShape: P.polygon, pathOrder: 5, pathParam: 0.7, size: 0.2, spin: -0.3,
      filterType: F.low, cutoff: 10000, resonance: 0.05, filterEnv: 0, keyTrack: 0.5,
      ...amp(0.001, 2.8, 0, 2.6), ...env2(0.001, 1.2, 0, 1.2),
      level: 0.81, delaySend: 0.2, reverbSend: 0.4,
    },
    mods: { size: env(0.12), morph: env(-0.3) },
  },
  {
    name: 'Tidepool Bell', category: 'Bell', tags: ['pace', 'pinch', 'shimmer'],
    params: {
      terrainA: T.vortex, terrainB: T.fm, morph: 0.4, seed: 53, detail: 0.6,
      pathShape: P.cusp, pathOrder: 4, pathParam: 0.45, size: 0.22, spin: 0.2, paceShape: PACE.pinch, velSens: 0.7,
      filterType: F.low, cutoff: 9000, resonance: 0.05, filterEnv: 0, keyTrack: 0.8,
      ...amp(0.001, 3, 0, 2.6), ...env2(0.001, 1.2, 0, 1.2),
      level: 0.65, delaySend: 0.18, reverbSend: 0.45,
    },
    // Pace swinging either side of zero ripples the partials while the bell rings.
    mods: { pace: lfo(0.25, 0.35), size: env(0.12) },
  },

  // --------------------------------------------------------------- Texture
  {
    name: 'Dust Devil', category: 'Texture', tags: ['swirling', 'vortex', 'drift'],
    params: {
      terrainA: T.vortex, terrainB: T.massif, morph: 0.3, seed: 61, detail: 0.7, warp: 0.2,
      pathShape: P.scribble, pathOrder: 3, pathParam: 0.55, size: 0.18, spin: 1.6,
      unison: 2, detune: 25, spread: 1,
      filterType: F.band, cutoff: 1800, resonance: 0.3, filterEnv: 0, keyTrack: 0.4,
      ...amp(0.4, 1, 0.8, 1.5),
      level: 0.72, delaySend: 0.25, reverbSend: 0.45,
    },
    mods: { centerX: lfo(0.15, 0.23, SH.drift), centerY: lfo(0.15, 0.19, SH.drift), cutoff: lfo(0.15, 0.3, SH.drift) },
    dot: { mode: DOT.drift, driftSpeed: 0.5 },
  },
  {
    name: 'Lichen Grain', category: 'Texture', tags: ['stepped', 'sample and hold', 'rhythmic'],
    params: {
      terrainA: T.cells, terrainB: T.massif, morph: 0.5, seed: 66, detail: 0.65,
      pathShape: P.scan, pathOrder: 3, pathParam: 0.6, size: 0.5,
      filterType: F.low, cutoff: 4000, resonance: 0.2, filterEnv: 0, keyTrack: 0.5,
      ...amp(0.01, 0.8, 0.7, 0.6),
      level: 0.73, delaySend: 0.3, reverbSend: 0.35,
    },
    mods: { centerY: synced(0.35, '1/16', SH.sh), morph: synced(0.3, '1/8', SH.sh) },
  },
  {
    name: 'Rain Shadow', category: 'Texture', tags: ['crackle', 'superformula', 'airy'],
    params: {
      terrainA: T.massif, terrainB: T.ripple, morph: 0.35, seed: 72, detail: 0.6, warp: 0.25,
      pathShape: P.super, pathOrder: 6, pathParam: 0.3, size: 0.2,
      filterType: F.band, cutoff: 2500, resonance: 0.25, filterEnv: 0, keyTrack: 0.5,
      ...amp(0.6, 1, 0.7, 2),
      level: 0.88, delaySend: 0.15, reverbSend: 0.55,
    },
    mods: { warp: lfo(0.3, 6, SH.sh), pathParam: lfo(0.2, 0.15, SH.drift) },
  },
  {
    name: 'Tectonic Drift', category: 'Texture', tags: ['slow', 'rolling dot', 'canyon'],
    params: {
      terrainA: T.canyon, terrainB: T.ridge, morph: 0.4, seed: 77, detail: 0.55,
      pathShape: P.ellipse, pathOrder: 4, pathParam: 0.4, size: 0.25,
      unison: 2, detune: 14, spread: 0.8,
      filterType: F.low, cutoff: 2000, resonance: 0.25, filterEnv: 0, keyTrack: 0.5, drive: 0.2,
      ...amp(1, 1.5, 0.85, 2.5),
      level: 0.61, delaySend: 0.15, reverbSend: 0.45,
    },
    mods: { morph: lfo(0.4, 0.03, SH.drift), centerX: lfo(0.2, 0.02, SH.drift), centerY: lfo(0.2, 0.025, SH.drift) },
    dot: { mode: DOT.roll, gravity: 0.5, friction: 0.2 },
  },
  {
    name: 'Salt Flat Shimmer', category: 'Texture', tags: ['high', 'glittering', 'lissajous'],
    params: {
      terrainA: T.spectra, terrainB: T.vortex, morph: 0.3, seed: 81, detail: 0.5,
      pathShape: P.lissa, pathOrder: 6, pathParam: 0.5, size: 0.11, octave: 1, spin: 2.5,
      filterType: F.high, cutoff: 600, resonance: 0.1, filterEnv: 0, keyTrack: 0.3,
      ...amp(1.5, 1, 0.8, 3),
      level: 0.74, delaySend: 0.3, reverbSend: 0.65,
    },
    mods: { pathParam: lfo(0.3, 0.1, SH.tri), size: lfo(0.1, 0.13) },
  },

  // ----------------------------------------------------------------- Drone
  {
    name: 'Bedrock Drone', category: 'Drone', tags: ['deep', 'wandering', 'unison'],
    params: {
      terrainA: T.massif, terrainB: T.swell, morph: 0.3, seed: 88, detail: 0.55,
      pathShape: P.ellipse, pathOrder: 2, size: 0.2, octave: -1,
      unison: 4, detune: 12, spread: 1,
      filterType: F.low, cutoff: 1400, resonance: 0.2, filterEnv: 0, keyTrack: 0.3,
      ...amp(2.5, 2, 1, 5),
      level: 0.81, delaySend: 0.05, reverbSend: 0.5,
    },
    mods: {
      centerX: lfo(0.15, 0.015, SH.drift), centerY: lfo(0.15, 0.012, SH.drift),
      cutoff: lfo(0.1, 0.03, SH.drift), morph: lfo(0.3, 0.02),
    },
    dot: { mode: DOT.drift, driftSpeed: 0.15 },
  },
  {
    name: 'Ocean Trench', category: 'Drone', tags: ['sub', 'spiral', 'synced morph'],
    params: {
      terrainA: T.canyon, terrainB: T.swell, morph: 0.5, seed: 91, detail: 0.5,
      pathShape: P.spiral, pathOrder: 3, pathParam: 0.4, size: 0.22, octave: -2,
      filterType: F.low, cutoff: 900, resonance: 0.3, filterEnv: 0, keyTrack: 0.5, drive: 0.25,
      ...amp(3, 2, 1, 6),
      level: 0.59, delaySend: 0.05, reverbSend: 0.45,
    },
    mods: { morph: synced(0.4, '4bar', SH.tri), pathParam: lfo(0.3, 0.05), cutoff: synced(0.15, '2bar') },
  },
  {
    name: 'Magma Chamber', category: 'Drone', tags: ['molten', 'folded', 'heavy'],
    params: {
      terrainA: T.ridge, terrainB: T.terrace, morph: 0.3, seed: 95, detail: 0.7, lift: 1.8, fold: 0.2,
      pathShape: P.cusp, pathOrder: 3, pathParam: 0.6, size: 0.21, octave: -1,
      filterType: F.low, cutoff: 1800, resonance: 0.35, filterEnv: 0, keyTrack: 0.4, drive: 0.45,
      ...amp(1.5, 2, 1, 4),
      level: 0.44, delaySend: 0.05, reverbSend: 0.35,
    },
    mods: { fold: lfo(0.25, 0.07, SH.tri), rotate: lfo(0.3, 0.05, SH.saw), centerY: lfo(0.1, 0.04, SH.drift) },
  },
  {
    name: 'Polar Night', category: 'Drone', tags: ['cold', 'vast', 'reverb'],
    params: {
      terrainA: T.ripple, terrainB: T.vortex, morph: 0.4, seed: 97, detail: 0.5,
      pathShape: P.rose, pathOrder: 2, pathParam: 0.6, size: 0.2, spin: 0.05,
      unison: 3, detune: 8, spread: 1,
      filterType: F.low, cutoff: 2600, resonance: 0.15, filterEnv: 0, keyTrack: 0.5,
      ...amp(3, 2, 1, 6),
      level: 0.55, delaySend: 0.15, reverbSend: 0.7,
    },
    mods: { morph: lfo(0.35, 0.025, SH.drift), size: lfo(0.1, 0.035) },
  },

  // -------------------------------------------------------------------- FX
  {
    name: 'Landslide', category: 'FX', tags: ['falling', 'impact', 'envelopes'],
    params: {
      terrainA: T.massif, terrainB: T.ridge, morph: 0.1, seed: 13, detail: 0.8, fold: 0.2,
      pathShape: P.spiral, pathOrder: 4, pathParam: 0.3, size: 0.35, octave: -1,
      filterType: F.low, cutoff: 6000, resonance: 0.4, filterEnv: -0.6, keyTrack: 0.3, drive: 0.4,
      ...amp(0.01, 3, 0, 2), ...env2(0.01, 2.5, 0, 2),
      level: 0.6, delaySend: 0.3, reverbSend: 0.5,
    },
    mods: { size: env(-0.5), morph: env(0.6), rotate: env(0.5), fold: env(0.4), fine: env(-0.5) },
  },
  {
    name: 'Seismograph', category: 'FX', tags: ['glitch', 'stepped', 'scribble'],
    params: {
      terrainA: T.lattice, terrainB: T.terrace, morph: 0.4, seed: 99, detail: 0.6, fold: 0.25,
      pathShape: P.scribble, pathOrder: 6, pathParam: 0.7, size: 0.2,
      filterType: F.band, cutoff: 2000, resonance: 0.4, filterEnv: 0, keyTrack: 0.5,
      ...amp(0.005, 0.3, 0.6, 0.3),
      level: 0.75, delaySend: 0.35, reverbSend: 0.2,
    },
    mods: { centerX: synced(0.3, '1/16', SH.sh), centerY: synced(0.3, '1/16', SH.sh), cutoff: synced(0.25, '1/8', SH.sh) },
  },
  {
    name: 'Satellite Ping', category: 'FX', tags: ['blip', 'echo', 'high'],
    params: {
      terrainA: T.fm, terrainB: T.ripple, seed: 3, detail: 0.5,
      pathShape: P.ellipse, pathOrder: 5, size: 0.2, lift: 1.6, octave: 2,
      filterType: F.low, cutoff: 9000, resonance: 0.05, filterEnv: 0, keyTrack: 0.5,
      ...amp(0.001, 0.35, 0, 0.4), ...env2(0.001, 0.1, 0, 0.1),
      level: 0.7, delaySend: 0.6, reverbSend: 0.4,
    },
    mods: { size: env(0.25) },
  },
  {
    name: 'Wind Gap', category: 'FX', tags: ['wind', 'noisy', 'resonant'],
    params: {
      terrainA: T.ridge, terrainB: T.massif, morph: 0.5, seed: 18, detail: 1, warp: 0.5,
      pathShape: P.scribble, pathOrder: 8, pathParam: 1, size: 0.45, spin: 3.5,
      filterType: F.band, cutoff: 1200, resonance: 0.55, filterEnv: 0, keyTrack: 0.3,
      ...amp(1.2, 1, 0.9, 2.5),
      level: 0.88, delaySend: 0.1, reverbSend: 0.6,
    },
    mods: { cutoff: lfo(0.25, 0.1, SH.drift), warp: lfo(0.3, 0.2, SH.drift), centerX: lfo(0.3, 0.05, SH.drift) },
  },

  // ------------------------------------------------------------------- Arp
  {
    name: 'Survey Arp', category: 'Arp', tags: ['wavetable', 'tight', 'echo'],
    params: {
      terrainA: T.spectra, terrainB: T.swell, morph: 0, seed: 7, detail: 0.6,
      pathShape: P.scan, pathOrder: 1, pathParam: 0.5, size: 0.5, centerY: 0.3,
      filterType: F.low, cutoff: 3000, resonance: 0.3, filterEnv: 0.4, keyTrack: 0.6,
      ...amp(0.001, 0.3, 0.1, 0.2), ...env2(0.001, 0.15, 0, 0.15),
      level: 0.5, delaySend: 0.3, reverbSend: 0.2,
    },
    mods: { centerY: synced(0.08, '2bar', SH.tri) },
  },
  {
    name: 'Isobar Arp', category: 'Arp', tags: ['plucky', 'synced morph', 'bright'],
    params: {
      terrainA: T.fm, terrainB: T.ridge, morph: 0.2, seed: 24, detail: 0.5,
      pathShape: P.ellipse, pathOrder: 3, size: 0.14, lift: 1.3,
      filterType: F.low, cutoff: 4500, resonance: 0.25, filterEnv: 0.35, keyTrack: 0.6,
      ...amp(0.001, 0.5, 0.05, 0.25), ...env2(0.001, 0.14, 0, 0.15),
      level: 0.8, delaySend: 0.28, reverbSend: 0.2,
    },
    mods: { size: env(0.3), morph: synced(0.3, '1bar', SH.tri) },
  },
  {
    name: 'Waypoint Arp', category: 'Arp', tags: ['bouncy', 'square orbit', 'rotating'],
    params: {
      terrainA: T.lattice, terrainB: T.swell, morph: 0.4, seed: 33, detail: 0.5,
      pathShape: P.polygon, pathOrder: 4, pathParam: 0.5, size: 0.14,
      filterType: F.low, cutoff: 3500, resonance: 0.3, filterEnv: 0.3, keyTrack: 0.6,
      ...amp(0.001, 0.28, 0.05, 0.18), ...env2(0.001, 0.12, 0, 0.12),
      level: 0.68, delaySend: 0.25, reverbSend: 0.18,
    },
    mods: { rotate: synced(0.25, '1bar', SH.saw), size: env(0.15) },
  },
  {
    name: 'Compass Arp', category: 'Arp', tags: ['circling dot', 'rose', 'airy'],
    params: {
      terrainA: T.swell, terrainB: T.ridge, morph: 0.3, seed: 57, detail: 0.5,
      pathShape: P.rose, pathOrder: 4, pathParam: 0.5, size: 0.16, lift: 1.5,
      filterType: F.low, cutoff: 5000, resonance: 0.2, filterEnv: 0.3, keyTrack: 0.6,
      ...amp(0.001, 0.4, 0.1, 0.3), ...env2(0.001, 0.18, 0, 0.2),
      level: 0.86, delaySend: 0.3, reverbSend: 0.25,
    },
    mods: { centerX: synced(0.12, '1bar'), centerY: synced(0.12, '2bar'), size: env(0.2) },
  },
  {
    name: 'Gyre Arp', category: 'Arp', tags: ['hard sync', 'stepped laps', 'star'],
    params: {
      terrainA: T.ripple, terrainB: T.cells, morph: 0.3, seed: 62, detail: 0.5,
      pathShape: P.star, pathOrder: 3, pathParam: 0.5, size: 0.13, lift: 1.5, laps: 1.8,
      filterType: F.low, cutoff: 4200, resonance: 0.25, filterEnv: 0.35, keyTrack: 0.6,
      ...amp(0.001, 0.3, 0.05, 0.2), ...env2(0.001, 0.14, 0, 0.15),
      level: 0.69, delaySend: 0.3, reverbSend: 0.2,
    },
    // A sample-and-hold on Laps every 16th: each arp note gets its own sync colour.
    mods: { laps: synced(0.2, '1/16', SH.sh), size: env(0.25) },
  },
];
