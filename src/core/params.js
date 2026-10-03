// Parameter registry. Pure data + pure functions, no DOM.
// Shared by the UI (knobs), the store (defaults, presets), and the audio worklet
// (modulation is applied in normalised 0..1 space, then mapped back through the
// same curves). Keep this file dependency-free apart from the catalog.

import { defaultTrackFx } from '../dsp/track-fx-config.js';
import { TERRAIN_NAMES, PATH_NAMES, TERRAIN_INDEX, PATH_INDEX } from '../dsp/catalog.js';
import { COLLAPSE_NAMES, COLLAPSE_BARS } from '../dsp/science-sources.js';
import { FILTER2_TYPES, FILTER_ROUTES } from '../dsp/filter2.js';
import { defaultFuncPoints } from '../dsp/function-gen.js';
import { defaultDrum } from '../dsp/drum-kit.js';

// v2.2 unison: how detune positions are spread, and transposing stacks
// (semitones cycled across the copies from the outside in; the centre copy
// stays at the note).
export const UNISON_MODES = ['Linear', 'Super', 'Exp', 'Random'];
export const WARP_MODES = ['Off', 'PWM', 'Quantize', 'Flip', 'Spiral'];
export const UNISON_STACKS = Object.freeze([
  { name: 'Off', semis: [0] },
  { name: '+12', semis: [0, 12] },
  { name: '±12', semis: [0, 12, -12] },
  { name: '+7', semis: [0, 7] },
  { name: '+12 +19', semis: [0, 12, 19] },
  { name: '+12 +24', semis: [0, 12, 24] },
]);

// Tracks (called parts in the code). The store holds a variable-length list
// of 1..MAX_PARTS tracks, each with a stable `id`; what exists, and in which
// order, is always `state.parts`. Code that allocates per-track resources
// (DSP parts, MIDI channel maps, visual fields, telemetry) sizes them for
// MAX_PARTS and maps them by index; code that shows, plays or schedules
// tracks iterates the live list (`parts.length`, see src/core/tracks.js).
// MAX_PARTS is the practical CPU ceiling and the one place to raise it.
export const MAX_PARTS = 16;
export const MIN_PARTS = 1;
/** Tracks in a new session (and in every session saved before tracks could be added). */
export const DEFAULT_PARTS = 4;
export const VOICES_PER_PART = 8;
// One colour per track slot, picked to stay apart from each other; the UI
// derives a contrast-safe tone for each theme (src/ui/color.js partVars).
export const PART_COLORS = [
  '#ff7a45', '#3fd0c9', '#b98cff', '#ffd23f',
  '#ff5d8f', '#7ddf64', '#5aa9ff', '#e86bf0',
  '#c6e84a', '#ff4d4d', '#4fe0a0', '#8a93ff',
  '#ffb38a', '#4dd2ff', '#e0c27a', '#a0b8c8',
];
export const PART_NAMES = Array.from({ length: MAX_PARTS }, (_, i) => `Track ${i + 1}`);

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
  Major:      [0, 2, 4, 5, 7, 9, 11],
  Minor:      [0, 2, 3, 5, 7, 8, 10],
  Dorian:     [0, 2, 3, 5, 7, 9, 10],
  Phrygian:   [0, 1, 3, 5, 7, 8, 10],
  Lydian:     [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'Pent Maj': [0, 2, 4, 7, 9],
  'Pent Min': [0, 3, 5, 7, 10],
  Blues:      [0, 3, 5, 6, 7, 10],
  'Harm Min': [0, 2, 3, 5, 7, 8, 11],
  Chromatic:  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
  'Melodic Minor': [0, 2, 3, 5, 7, 9, 11],
  'Whole Tone': [0, 2, 4, 6, 8, 10],
  'Diminished Whole Half': [0, 2, 3, 5, 6, 8, 9, 11],
  'Diminished Half Whole': [0, 1, 3, 4, 6, 7, 9, 10],
  Augmented: [0, 3, 4, 7, 8, 11],
  'Double Harmonic Major': [0, 1, 4, 5, 7, 8, 11],
  'Hungarian Minor': [0, 2, 3, 6, 7, 8, 11],
  'Harmonic Major': [0, 2, 4, 5, 7, 8, 11],
  'Neapolitan Minor': [0, 1, 3, 5, 7, 8, 11],
  'Neapolitan Major': [0, 1, 3, 5, 7, 9, 11],
  Persian: [0, 1, 4, 5, 6, 8, 11],
  Enigmatic: [0, 1, 4, 6, 8, 10, 11],
  Insen: [0, 1, 5, 7, 10],
  Hirajoshi: [0, 2, 3, 7, 8],
  Iwato: [0, 1, 5, 6, 10],
  Ritusen: [0, 2, 5, 7, 9],
  Prometheus: [0, 2, 4, 6, 9, 10],
  'Bebop Dominant': [0, 2, 4, 5, 7, 9, 10, 11],
  'Bebop Major': [0, 2, 4, 5, 7, 8, 9, 11],
  'Bebop Minor': [0, 2, 3, 4, 5, 7, 9, 10],
  Altered: [0, 1, 3, 4, 6, 8, 10],
  'Lydian Dominant': [0, 2, 4, 6, 7, 9, 10],
  'Phrygian Dominant': [0, 1, 4, 5, 7, 8, 10],
  'Lydian Augmented': [0, 2, 4, 6, 8, 9, 11],
  'Locrian #2': [0, 2, 3, 5, 6, 8, 10],
  'Dorian b2': [0, 1, 3, 5, 7, 9, 10],
  Egyptian: [0, 2, 5, 7, 10],
  'Minor Six Pentatonic': [0, 3, 5, 7, 9],
};
export const SCALE_NAMES = Object.keys(SCALES);

export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw', 'Square', 'S&H', 'Drift', 'Steps'];
export const LFO_STEP_COUNT = 32;
// Tempo-synced LFO / delay divisions, expressed in beats (quarter notes).
export const SYNC_DIVS = [
  { name: '4 bar', beats: 16 }, { name: '2 bar', beats: 8 }, { name: '1 bar', beats: 4 },
  { name: '1/2', beats: 2 }, { name: '1/4.', beats: 1.5 }, { name: '1/4', beats: 1 },
  { name: '1/8.', beats: 0.75 }, { name: '1/4T', beats: 2 / 3 }, { name: '1/8', beats: 0.5 },
  { name: '1/16.', beats: 0.375 }, { name: '1/8T', beats: 1 / 3 }, { name: '1/16', beats: 0.25 },
  { name: '1/32', beats: 0.125 },
];
export const DELAY_DIVS = SYNC_DIVS.slice(3); // 1/2 .. 1/32

// Curves:
//   lin     v = min + n (max - min)
//   exp     v = min (max/min)^n            (min > 0)
//   pow     v = min + (max - min) n^k      (k = def.k, default 2)
//   bipow   v = sign(2n-1) |2n-1|^k max    (symmetric around 0, min = -max)
//   int     v = round(lin)
//   enum    v = round(n (options.length - 1))  (stored as the integer index)
//   bool    v = n >= 0.5 ? 1 : 0
const P = (id, label, group, curve, min, max, def, extra = {}) =>
  ({ id, label, group, curve, min, max, default: def, ...extra });

export const SUB_WAVES = ['Sine', 'Triangle', 'Saw', 'Pulse 25%', 'Square', 'Organ', 'Soft saw'];
export const NOISE_TYPES = ['Legacy', 'White', 'Pink', 'Blue', 'Brown', 'Vinyl texture', 'Waves texture', 'City texture', 'Recording'];
export const INHARMONIC_PROFILES = ['Harmonic', 'Stretched', 'Compressed', 'Odd', 'Metal', 'Glass', 'Bells', 'Golden', 'Cluster', 'Detuned', 'Folded'];
export const ENV_MODES = ['Gate', 'One-shot', 'Loop', 'Ping-pong', 'Trigger hold', 'Pluck'];

export const PART_PARAMS = [
  // Terrain
  P('terrainA', 'Terrain A', 'terrain', 'enum', 0, TERRAIN_NAMES.length - 1, TERRAIN_INDEX.swell, { options: TERRAIN_NAMES, regen: true }),
  P('terrainB', 'Terrain B', 'terrain', 'enum', 0, TERRAIN_NAMES.length - 1, TERRAIN_INDEX.massif, { options: TERRAIN_NAMES, regen: true }),
  P('morph',    'Morph',     'terrain', 'lin', 0, 1, 0,   { mod: true, hint: 'Blend from terrain A to terrain B' }),
  P('warp',     'Warp',      'terrain', 'lin', 0, 1, 0,   { mod: true, hint: 'Bend the map coordinates (the land itself ripples)' }),
  P('lift',     'Lift',      'terrain', 'exp', 0.25, 4, 1, { mod: true, unit: 'x', hint: 'Terrain height / drive into the folder' }),
  P('fold',     'Fold',      'terrain', 'lin', 0, 1, 0,   { mod: true, hint: 'Wavefold peaks back down: adds bright harmonics' }),
  P('seed',     'Seed',      'terrain', 'int', 0, 99, 7,  { regen: true, hint: 'Variation of the procedural terrain' }),
  P('detail',   'Detail',    'terrain', 'lin', 0, 1, 0.5, { regen: true, hint: 'Amount of fine detail in the terrain' }),
  // Path / orbit
  P('pathShape', 'Path',     'path', 'enum', 0, PATH_NAMES.length - 1, PATH_INDEX.ellipse, { options: PATH_NAMES }),
  P('pathOrder', 'Order',    'path', 'int', 1, 8, 2,      { hint: 'Petals / sides / ratio, depends on the path' }),
  P('pathParam', 'Shape',    'path', 'lin', 0, 1, 0.5,    { mod: true, hint: 'Continuous shape control for the path' }),
  P('size',      'Size',     'path', 'pow', 0, 0.5, 0.22, { k: 1.6, mod: true, hint: 'Orbit radius: bigger = brighter' }),
  P('stretch',   'Stretch',  'path', 'lin', -1, 1, 0,     { mod: true, hint: 'Squash the orbit wide or tall' }),
  P('rotate',    'Rotate',   'path', 'lin', 0, 360, 0,    { mod: true, unit: '°' }),
  P('spin',      'Spin',     'path', 'bipow', -4, 4, 0,   { k: 2.5, unit: 'Hz', hint: 'Continuous rotation speed' }),
  P('centerX',   'Dot X',    'path', 'lin', 0, 1, 0.5,    { mod: true, hint: 'Where the dot sits on the map (east-west)' }),
  P('centerY',   'Dot Y',    'path', 'lin', 0, 1, 0.5,    { mod: true, hint: 'Where the dot sits on the map (north-south)' }),
  // Voice / pitch
  P('octave',    'Octave',   'voice', 'int', -3, 3, 0),
  P('tune',      'Tune',     'voice', 'int', -12, 12, 0,  { unit: 'st' }),
  P('fine',      'Fine',     'voice', 'lin', -100, 100, 0, { mod: true, unit: 'ct' }),
  P('glide',     'Glide',    'voice', 'pow', 0, 2, 0,     { mod: true, k: 3, unit: 's' }),
  P('polyMode',  'Mode',     'voice', 'enum', 0, 2, 0,    { options: ['Poly', 'Mono', 'Legato'] }),
  P('unison',    'Unison',   'voice', 'int', 1, 16, 1),
  P('detune',    'Detune',   'voice', 'lin', 0, 50, 12,   { mod: true, unit: 'ct' }),
  P('spread',    'Width',    'voice', 'lin', 0, 1, 0.6, { mod: true }),
  P('velSens',   'Velocity', 'voice', 'lin', 0, 1, 0.6, { mod: true }),
  P('bendRange', 'Bend',     'voice', 'int', 0, 24, 2,    { unit: 'st' }),
  // Filter
  P('filterType', 'Filter',  'filter', 'enum', 0, 11, 1,   { options: ['Off', 'Low', 'Band', 'High', 'Notch', 'Comb', 'Vowel', 'Ladder warm', 'Ladder clean', 'Ladder driven', 'SEM', 'Diode'] }),
  P('cutoff',    'Cutoff',   'filter', 'exp', 30, 18000, 9000, { mod: true, unit: 'Hz' }),
  P('resonance', 'Reso',     'filter', 'lin', 0, 1, 0.15, { mod: true }),
  P('filterEnv', 'Env Amt',  'filter', 'lin', -1, 1, 0.15, { mod: true, hint: 'Envelope 2 to cutoff, up to ±6 octaves' }),
  P('keyTrack',  'Key Trk',  'filter', 'lin', 0, 1, 0.5, { mod: true }),
  P('drive',     'Drive',    'filter', 'lin', 0, 1, 0,    { mod: true }),
  // Amp envelope (Envelope 1)
  P('attack',    'Attack',   'amp', 'pow', 0.001, 8, 0.005, { k: 3, unit: 's' }),
  P('decay',     'Decay',    'amp', 'pow', 0.001, 8, 0.35,  { k: 3, unit: 's' }),
  P('sustain',   'Sustain',  'amp', 'lin', 0, 1, 0.75),
  P('release',   'Release',  'amp', 'pow', 0.001, 10, 0.45, { k: 3, unit: 's' }),
  // Mod envelope (Envelope 2): drives filterEnv and every per-parameter "Env" depth
  P('env2Attack',  'Attack',  'env2', 'pow', 0.001, 8, 0.01, { k: 3, unit: 's' }),
  P('env2Decay',   'Decay',   'env2', 'pow', 0.001, 8, 0.6,  { k: 3, unit: 's' }),
  P('env2Sustain', 'Sustain', 'env2', 'lin', 0, 1, 0.25),
  P('env2Release', 'Release', 'env2', 'pow', 0.001, 10, 0.5, { k: 3, unit: 's' }),
  // Mixer
  P('level',      'Level',   'mix', 'lin', 0, 1, 0.75),
  P('pan',        'Pan',     'mix', 'lin', -1, 1, 0,     { mod: true }),
  P('delaySend',  'Delay',   'mix', 'lin', 0, 1, 0.12),
  P('reverbSend', 'Reverb',  'mix', 'lin', 0, 1, 0.22),
  P('mute',       'Mute',    'mix', 'bool', 0, 1, 0),
  P('solo',       'Solo',    'mix', 'bool', 0, 1, 0),
  // Added after v0.1 contract (appended so numeric slots stay stable)
  P('laps',      'Laps',     'path', 'lin', 1, 8, 1,     { mod: true, hint: 'Trace the path this many times per cycle and restart it each cycle (hard sync). In-between values give sync sweeps' }),
  P('pace',      'Pace',     'path', 'lin', -1, 1, 0,    { mod: true, hint: 'Speed up and slow down along the path within each cycle (phase distortion)' }),
  P('paceShape', 'Curve',    'path', 'enum', 0, 2, 0,    { options: ['Bend', 'Skew', 'Pinch'], hint: 'How Pace bends the traversal speed' }),
  P('sub',       'Sub',      'voice', 'lin', 0, 1, 0,    { mod: true, hint: 'Oscillator one octave below the note' }),
  P('traverse',  'Travel',   'path', 'enum', 0, 1, 0,    { options: ['Natural', 'Even'], hint: 'Natural follows the curve maths (corners speed up and slow down); Even moves at constant speed along the path' }),
  P('direction', 'Direction','path', 'enum', 0, 1, 0,    { options: ['Forward', 'Ping-pong'], hint: 'Ping-pong runs the path forward then backward each cycle, so open paths never jump' }),
  P('noteSize',  'Key>Size', 'path', 'lin', -1, 1, 0,    { hint: 'Higher notes shrink (negative) or grow (positive) the orbit. Negative keeps high notes smooth' }),
  P('air',       'Air',      'voice', 'lin', 0, 1, 0,    { mod: true, hint: 'Breathy noise layer that follows the amp envelope' }),
  P('airTone',   'Air Tone', 'voice', 'lin', -1, 1, 0,   { hint: 'Dark to bright noise colour' }),
  P('formant',   'Vowel',    'filter', 'lin', 0, 1, 0.5, { mod: true, hint: 'Vowel filter position A, E, I, O, U (also sets the Comb filter spread)' }),
  // v1.1 pedal loop (docs/PEDALS.md). Only heard when Settings > Pedals has the
  // pedal send running on outputs 3/4; otherwise they change nothing.
  P('pedalSend',   'Pedal',  'mix', 'lin', 0, 1, 0,  { hint: 'Send to the guitar pedals on outputs 3 and 4 (set up in Settings > Pedals)' }),
  P('pedalPre',    'Pre',    'mix', 'bool', 0, 1, 0, { hint: 'Pedal send before the level fader (on) or after it (off)' }),
  P('pedalInsert', 'Insert', 'mix', 'bool', 0, 1, 0, { hint: 'Hear this part only through the pedals: its dry sound is muted while the pedal send is running' }),

  // v2 additions are appended to preserve the numeric parameter contract.
  P('subWave', 'Sub wave', 'voice', 'enum', 0, 6, 0, { options: SUB_WAVES }),
  P('sub2', 'Sub two', 'voice', 'lin', 0, 1, 0, { mod: true, hint: 'Oscillator two octaves below the note' }),
  P('sub2Wave', 'Sub two wave', 'voice', 'enum', 0, 6, 0, { options: SUB_WAVES }),
  P('airType', 'Noise type', 'voice', 'enum', 0, 8, 0, { options: NOISE_TYPES }),
  P('airTexture', 'Texture position', 'voice', 'lin', 0, 1, 0, { mod: true }),
  P('inharmProfile', 'Partial profile', 'voice', 'lin', 0, 10, 0, { mod: true, hint: 'Morph continuously between eleven original partial-ratio profiles' }),
  P('inharmAmount', 'Partials', 'voice', 'lin', 0, 1, 0, { mod: true }),
  P('phaseMod', 'Phase mod', 'voice', 'lin', 0, 1, 0, { mod: true }),
  P('phaseRatio', 'PM ratio', 'voice', 'exp', 0.125, 16, 1, { mod: true, unit: 'x' }),
  P('ringMod', 'Ring mod', 'voice', 'lin', 0, 1, 0, { mod: true }),
  P('ringRatio', 'Ring ratio', 'voice', 'exp', 0.125, 16, 1, { mod: true, unit: 'x' }),
  P('pluck', 'Pluck', 'voice', 'lin', 0, 1, 0, { mod: true }),
  P('pluckDecay', 'Pluck decay', 'voice', 'exp', 0.05, 8, 1, { mod: true, unit: 's' }),
  P('pluckTone', 'Pluck tone', 'voice', 'lin', 0, 1, 0.5, { mod: true }),
  P('pluckDispersion', 'Dispersion', 'voice', 'lin', 0, 1, 0, { mod: true }),
  P('ampDelay', 'Delay', 'amp', 'pow', 0, 8, 0, { k: 3, unit: 's' }),
  P('ampHold', 'Hold', 'amp', 'pow', 0, 8, 0, { k: 3, unit: 's' }),
  P('ampMode', 'Mode', 'amp', 'enum', 0, 5, 0, { options: ENV_MODES }),
  P('env2Delay', 'Delay', 'env2', 'pow', 0, 8, 0, { k: 3, unit: 's' }),
  P('env2Hold', 'Hold', 'env2', 'pow', 0, 8, 0, { k: 3, unit: 's' }),
  P('env2Mode', 'Mode', 'env2', 'enum', 0, 5, 0, { options: ENV_MODES }),
  P('imageChannelA', 'Channel A', 'terrain', 'lin', 0, 3, 0, { regen: true, hint: 'Morph red, green, blue and brightness' }),
  P('imageChannelB', 'Channel B', 'terrain', 'lin', 0, 3, 0, { regen: true, hint: 'Morph red, green, blue and brightness' }),
  P('imageMappingA', 'Mapping A', 'terrain', 'enum', 0, 1, 0, { regen: true, options: ['Cartesian', 'Polar'] }),
  P('imageMappingB', 'Mapping B', 'terrain', 'enum', 0, 1, 0, { regen: true, options: ['Cartesian', 'Polar'] }),
  P('pathWindow', 'Window', 'path', 'lin', 0, 1, 0, { mod: true, hint: 'Taper the path radius with a Hann window' }),
  P('pathMangle', 'Mangle', 'path', 'lin', -1, 1, 0, { mod: true, hint: 'Smooth coordinate distortion of the path' }),
  P('pathMirror', 'Mirror', 'path', 'enum', 0, 3, 0, { options: ['Off', 'X', 'Y', 'Both'] }),
  // v2.2: Filter 2 and its routing (src/dsp/filter2.js), richer unison
  P('filter2Type', 'Filter 2', 'filter2', 'enum', 0, FILTER2_TYPES.length - 1, 0, { options: FILTER2_TYPES, hint: 'A second filter after (or beside) Filter 1' }),
  P('filter2Cutoff', 'Cutoff', 'filter2', 'exp', 30, 18000, 2000, { mod: true, unit: 'Hz' }),
  P('filter2Reso', 'Reso', 'filter2', 'lin', 0, 1, 0.2, { mod: true }),
  P('filter2Env', 'Env Amt', 'filter2', 'lin', -1, 1, 0, { mod: true, hint: 'Envelope 2 to Filter 2 cutoff, up to ±6 octaves' }),
  P('filter2Key', 'Key Trk', 'filter2', 'lin', 0, 1, 0.5),
  P('filterRoute', 'Routing', 'filter2', 'enum', 0, FILTER_ROUTES.length - 1, 0, { options: FILTER_ROUTES, hint: 'Serial: Filter 1 then Filter 2. Parallel: both hear the oscillator and Mix balances them. Split: Filter 1 on the left, Filter 2 on the right' }),
  P('filter2Mix', 'Mix', 'filter2', 'lin', 0, 1, 1, { mod: true, hint: 'Serial: how much of Filter 2 you hear. Parallel: Filter 1 (0) to Filter 2 (1)' }),
  P('unisonBlend', 'Blend', 'voice', 'lin', 0, 1, 1, { mod: true, hint: 'Level of the detuned copies against the centre one' }),
  P('unisonMode', 'Spread', 'voice', 'enum', 0, UNISON_MODES.length - 1, 0, { options: UNISON_MODES, hint: 'How the detune spreads the copies: evenly, bunched at the centre (Super), towards the edges (Exp) or at random per note' }),
  P('unisonStack', 'Stack', 'voice', 'enum', 0, UNISON_STACKS.length - 1, 0, { options: UNISON_STACKS.map(s => s.name), hint: 'Transpose some unison copies by octaves or fifths' }),
  P('unisonMap', 'Map spread', 'voice', 'lin', 0, 1, 0, { mod: true, hint: 'Each unison copy reads the land at its own spot around the dot, so the copies differ in tone, not just pitch' }),
  // v2.3: warp modes on the path read (Laps already does hard sync and Pace bend/asym)
  P('warpMode', 'Warp mode', 'path', 'enum', 0, WARP_MODES.length - 1, 0, { options: WARP_MODES, hint: 'PWM traces the path in part of the cycle and waits; Quantize steps the point along the path; Flip turns the end of the path through the centre; Spiral shrinks the loop through each cycle' }),
  P('warpAmount', 'Warp amt', 'path', 'lin', 0, 1, 0, { mod: true }),
  // v2.4: the track's Function (src/dsp/function-gen.js); its points live in part.funcPoints
  P('funcMode', 'Mode', 'func', 'enum', 0, 1, 0, { options: ['Loop', 'Once'], hint: 'Loop repeats the curve; Once plays it from each note start and holds the end' }),
  P('funcRate', 'Rate', 'func', 'exp', 0.05, 20, 1, { unit: 'Hz', hint: 'Cycles per second (when not synced)' }),
  P('funcSync', 'Sync', 'func', 'bool', 0, 1, 0, { hint: 'Lock the Function to the tempo' }),
  P('funcDiv', 'Length', 'func', 'enum', 0, SYNC_DIVS.length - 1, 2, { options: SYNC_DIVS.map(d => d.name), hint: 'One cycle when synced' }),
  P('funcSmooth', 'Smooth', 'func', 'lin', 0, 1, 0, { hint: 'Straight lines (0) to S curves between the points (1)' }),
  // v2.8 send effects (src/dsp/send-fx.js): post-fader sends to the two shared
  // return buses. At 0 (the default) the buses do not run at all.
  P('sendA', 'Send A', 'mix', 'lin', 0, 1, 0, { hint: 'Send to the shared Send A reverb, after the level fader' }),
  P('sendB', 'Send B', 'mix', 'lin', 0, 1, 0, { hint: 'Send to the shared Send B delay, after the level fader' }),
];

// Pedal routing belongs to the rig, not the sound: patch loads keep a part's
// values (like Mute and Solo) and patches never store them.
export const PEDAL_PARAM_IDS = Object.freeze(['pedalSend', 'pedalPre', 'pedalInsert']);
// v2.8 Send A and Send B amounts belong to the mix as well: a patch load keeps them.
export const SEND_PARAM_IDS = Object.freeze(['sendA', 'sendB']);

export const GLOBAL_PARAMS = [
  P('masterVolume', 'Volume',   'master', 'lin', 0, 1, 0.8),
  P('tempo',        'Tempo',    'master', 'int', 40, 240, 112, { unit: 'bpm' }),
  P('swing',        'Swing',    'master', 'lin', 0, 0.6, 0),
  P('scaleRoot',    'Key',      'master', 'enum', 0, 11, 9, { options: NOTE_NAMES }),
  P('scaleType',    'Scale',    'master', 'enum', 0, SCALE_NAMES.length - 1, 1, { options: SCALE_NAMES }),
  P('delayDiv',     'Time',     'delay', 'enum', 0, DELAY_DIVS.length - 1, 3, { options: DELAY_DIVS.map(d => d.name) }),
  P('delayFeedback','Feedback', 'delay', 'lin', 0, 0.95, 0.42),
  P('delayTone',    'Tone',     'delay', 'lin', 0, 1, 0.55),
  P('delayLevel',   'Return',   'delay', 'lin', 0, 1, 0.7),
  P('reverbSize',   'Size',     'reverb', 'lin', 0, 1, 0.62),
  P('reverbDamp',   'Damp',     'reverb', 'lin', 0, 1, 0.45),
  P('reverbLevel',  'Return',   'reverb', 'lin', 0, 1, 0.75),
  P('chorus',       'Chorus',   'master', 'lin', 0, 1, 0.15),
  P('saturation',   'Warmth',   'master', 'lin', 0, 1, 0.15),
  P('keyMode',      'Keys',     'master', 'enum', 0, 1, 0, { options: ['Selected', 'Layer'], hint: 'Keyboard/MIDI plays the selected part, or every unmuted part at once' }),
  P('macro1',       'Macro 1',  'macro', 'lin', 0, 1, 0, { hint: 'Assign with Links in any part' }),
  P('macro2',       'Macro 2',  'macro', 'lin', 0, 1, 0, { hint: 'Assign with Links in any part' }),
  P('macro3',       'Macro 3',  'macro', 'lin', 0, 1, 0, { hint: 'Assign with Links in any part' }),
  P('macro4',       'Macro 4',  'macro', 'lin', 0, 1, 0, { hint: 'Assign with Links in any part' }),
  P('ceiling',      'Ceiling',  'master', 'lin', -6, 0, -0.3, { unit: 'dB', hint: 'Output limiter ceiling' }),
  P('vectorMix', 'Vector mix', 'master', 'lin', 0, 1, 0),
  P('vectorX', 'Vector X', 'master', 'lin', 0, 1, 0.5),
  P('vectorY', 'Vector Y', 'master', 'lin', 0, 1, 0.5),
  P('vectorBank', 'Vector bank', 'master', 'int', 0, 3, 0),
  // v2.1 science sources (src/dsp/science-sources.js): global generators that Links can route anywhere.
  P('sciNeuronCurrent', 'Current', 'science', 'lin', 0, 20, 8, { unit: 'uA/cm2', hint: 'Steady current into the Hodgkin-Huxley neuron. Below about 6.3 it rests; 6.3 to 9.8 it fires only after a note kicks it; above 9.8 it fires on its own' }),
  P('sciNeuronKick', 'Kick', 'science', 'lin', 0, 1, 0.5, { hint: 'How hard each note start kicks the neuron (a 1 ms pulse)' }),
  P('sciNeuronTemp', 'Temp', 'science', 'lin', 0, 30, 6.3, { unit: 'C', hint: 'Membrane temperature. Warmer is faster (3x per 10 C)' }),
  P('sciNeuronRate', 'Speed', 'science', 'exp', 0.005, 1, 0.05, { hint: 'Neuron time per real time. 1 is real time (about 60 spikes a second at 8)' }),
  P('sciLorenzRate', 'Speed', 'science', 'exp', 0.02, 5, 0.5, { hint: 'How fast the Lorenz system runs' }),
  P('sciPendEnergy', 'Energy', 'science', 'lin', -2.95, 4, 0, { hint: 'Double pendulum energy. Low swings gently; above -1 the lower arm can flip; above 1 both can' }),
  P('sciPendRate', 'Speed', 'science', 'exp', 0.1, 5, 1, { hint: 'How fast the pendulum swings' }),
  P('sciSmoothTime', 'Time', 'science', 'exp', 0.05, 20, 1, { unit: 's', hint: 'How long the smooth random source takes to wander' }),
  P('sciSmoothness', 'Smooth', 'science', 'enum', 0, 2, 1, { options: ['Rough', 'Smooth', 'Silky'], hint: 'Rough jitters, Silky glides' }),
  P('sciCollapseShape', 'Shape', 'science', 'enum', 0, COLLAPSE_NAMES.length - 1, 0, { options: COLLAPSE_NAMES, hint: 'Which vortex collapse: each spirals inward at its own winding' }),
  P('sciCollapseBars', 'Cycle', 'science', 'enum', 0, COLLAPSE_BARS.length - 1, 3, { options: COLLAPSE_BARS.map(b => `${b} bar${b === 1 ? '' : 's'}`), hint: 'One collapse per this many bars' }),
  P('sciCollapseDir', 'Direction', 'science', 'enum', 0, 1, 0, { options: ['Collapse', 'Expand'] }),
  P('sciTuringChance', 'Chance', 'science', 'lin', 0, 1, 0.1, { hint: 'How often a step of the Turing loop changes: 0 locks the loop, 1 is always new' }),
  P('sciTuringLength', 'Length', 'science', 'int', 2, 16, 8, { hint: 'Steps in the Turing loop' }),
  P('sciTuringDiv', 'Step', 'science', 'enum', 0, SYNC_DIVS.length - 1, 11, { options: SYNC_DIVS.map(d => d.name), hint: 'How long each Turing step lasts' }),
  // v2.8 send effects: the two shared return buses (src/dsp/send-fx.js).
  // Send A is a reverb, Send B a delay; each runs once for the whole mix.
  P('sendASize', 'Size', 'sendA', 'lin', 0, 1, 0.55, { hint: 'Room size: longer reflection paths' }),
  P('sendADecay', 'Decay', 'sendA', 'exp', 0.3, 12, 2.5, { unit: 's', hint: 'Time for the reverb to fall by 60 dB' }),
  P('sendADamp', 'Damping', 'sendA', 'lin', 0, 1, 0.45, { hint: 'How quickly the high frequencies die away' }),
  P('sendAPredelay', 'Pre-delay', 'sendA', 'lin', 0, 250, 20, { unit: 'ms', hint: 'Gap before the reverb starts' }),
  P('sendAReturn', 'Return', 'sendA', 'lin', 0, 1, 0.8, { hint: 'Level of the Send A reverb in the mix' }),
  P('sendBSync', 'Sync', 'sendB', 'bool', 0, 1, 1, { hint: 'Delay time in note values at the tempo (on) or in milliseconds (off)' }),
  P('sendBDiv', 'Time', 'sendB', 'enum', 0, DELAY_DIVS.length - 1, 3, { options: DELAY_DIVS.map(d => d.name), hint: 'Delay time as a note value at the tempo' }),
  P('sendBTime', 'Time', 'sendB', 'exp', 20, 2000, 375, { unit: 'ms', hint: 'Delay time in milliseconds (when Sync is off)' }),
  P('sendBFeedback', 'Feedback', 'sendB', 'lin', 0, 0.9, 0.4, { hint: 'How much of each echo comes round again' }),
  P('sendBTone', 'Tone', 'sendB', 'lin', 0, 1, 0.6, { hint: 'Dark to bright echoes' }),
  P('sendBPingPong', 'Ping-pong', 'sendB', 'bool', 0, 1, 1, { hint: 'Echoes alternate between left and right' }),
  P('sendBReturn', 'Return', 'sendB', 'lin', 0, 1, 0.8, { hint: 'Level of the Send B delay in the mix' }),
];

export const PART_PARAM_MAP = Object.fromEntries(PART_PARAMS.map(p => [p.id, p]));
export const GLOBAL_PARAM_MAP = Object.fromEntries(GLOBAL_PARAMS.map(p => [p.id, p]));
export const MOD_PARAM_IDS = PART_PARAMS.filter(p => p.mod).map(p => p.id);
// Fixed numeric slot for every part parameter, used by the worklet's flat Float64Array.
export const PART_PARAM_INDEX = Object.fromEntries(PART_PARAMS.map((p, i) => [p.id, i]));

// Per-parameter modulation settings (one set per modulatable parameter per part).
//   lfoShape: index into LFO_SHAPES
//   lfoRate:  Hz, 0.01..30 (used when lfoSync = 0)
//   lfoSync:  0 = free Hz, 1 = tempo synced using lfoDiv
//   lfoDiv:   index into SYNC_DIVS
//   lfoDepth: -1..1, in normalised knob units (1 = full knob travel)
//   envDepth: -1..1, Envelope 2 contribution in normalised knob units
//   retrig:   1 = LFO phase resets on each new note when no other notes are held
//   steps:    LFO_STEP_COUNT values in -1..1 used by the 'Steps' LFO shape (one step per
//             1/LFO_STEP_COUNT of the LFO period, held, with a 2 ms de-click slew)
export const DEFAULT_LFO_STEPS = Object.freeze([0.8, -0.4, 0.2, -0.9, 0.6, -0.1, 0.4, -0.7, 0.9, -0.3, 0.1, -0.8, 0.5, 0, 0.3, -0.6].flatMap(v => [v, v]));
export const MOD_DEFAULT = Object.freeze({ lfoShape: 0, lfoRate: 0.5, lfoSync: 0, lfoDiv: 5, lfoDepth: 0, envDepth: 0, retrig: 0, steps: DEFAULT_LFO_STEPS,
  lfoSkew: 0, lfoDelay: 0, lfoAttack: 0, lfoPhase: 0, lfoOffset: 0, lfoCount: 0, stepGlide: 0, stepSmooth: 0,
  envOwn: 0, envDelay: 0, envAttack: 0.01, envHold: 0, envDecay: 0.6, envSustain: 0.25, envRelease: 0.5, envMode: 0,
  ctrl1Source: 0, ctrl1Depth: 0, ctrl1Curve: 0, ctrl2Source: 0, ctrl2Depth: 0, ctrl2Curve: 0,
  ctrl3Source: 0, ctrl3Depth: 0, ctrl3Curve: 0, ctrl4Source: 0, ctrl4Depth: 0, ctrl4Curve: 0,
});
export const MOD_FIELDS = Object.keys(MOD_DEFAULT);

// Links: per-part modulation routing (source -> any modulatable parameter), applied
// in normalised space on top of the per-parameter LFO/Env depths.
// Source value ranges: Velocity, Mod Wheel, Pressure, Slide, Macros, Marble Speed,
// Env 1, Env 2, Guitar Level (envelope of the guitar on the pedal return, v1.1), Voice Level (envelope of the
// microphone, v1.4) are 0..1; Key ((note - 60) / 48), Marble Height, Random (per note) and
// Terrain Height (height under the modulated dot) are -1..1. Science sources (v2.1): Neuron (membrane potential),
// Neuron Spike (1 at each spike, decaying) and Collapse (0 = wide, near 1 = collapsed) are 0..1; Lorenz,
// Pendulum 1/2, Smooth Random and Swirl X/Y are -1..1. New sources are only ever appended, so saved
// links keep their meaning; an older build clamps an index it does not know to its own last source.
export const LINK_SOURCES = ['Velocity', 'Mod Wheel', 'Pressure', 'Key', 'Slide', 'Macro 1', 'Macro 2', 'Macro 3', 'Macro 4',
  'Marble Speed', 'Marble Height', 'Env 1', 'Env 2', 'Random', 'Terrain Height', 'Guitar Level', 'Voice Level', 'Expression pedal', 'Sustain pedal', 'Breath',
  // v2.1 science sources (global; Swirl X and Y are per voice)
  'Neuron', 'Neuron Spike', 'Lorenz', 'Pendulum 1', 'Pendulum 2', 'Smooth Random', 'Collapse', 'Swirl X', 'Swirl Y',
  // v2.4: the Turing looping random source (global) and the track's Function (per voice)
  'Turing', 'Function'];
export const LINK_CURVES = ['Linear', 'Soft', 'Hard']; // y = x, sign(x)|x|^2, sign(x)|x|^0.5
export const MAX_LINKS = 8;
export function defaultLinks() {
  // Mod wheel -> Morph used to be hard-wired; it is now an ordinary, editable link.
  return [{ src: 1, dst: 'morph', amt: 1, curve: 0 }];
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Plain value -> normalised 0..1 knob position. */
export function toNorm(def, v) {
  const { curve, min, max } = def;
  switch (curve) {
    case 'exp': return clamp(Math.log(v / min) / Math.log(max / min), 0, 1);
    case 'pow': return clamp(Math.pow(clamp((v - min) / (max - min), 0, 1), 1 / (def.k || 2)), 0, 1);
    case 'bipow': {
      const x = clamp(v / max, -1, 1);
      return clamp(0.5 + 0.5 * Math.sign(x) * Math.pow(Math.abs(x), 1 / (def.k || 2)), 0, 1);
    }
    case 'enum': case 'int': case 'lin': case 'bool':
    default: return max === min ? 0 : clamp((v - min) / (max - min), 0, 1);
  }
}

/** Normalised 0..1 knob position -> plain value (snapped for int/enum/bool). */
export function fromNorm(def, n) {
  n = clamp(n, 0, 1);
  const { curve, min, max } = def;
  switch (curve) {
    case 'exp': return min * Math.pow(max / min, n);
    case 'pow': return min + (max - min) * Math.pow(n, def.k || 2);
    case 'bipow': { const x = 2 * n - 1; return Math.sign(x) * Math.pow(Math.abs(x), def.k || 2) * max; }
    case 'int': case 'enum': return Math.round(min + n * (max - min));
    case 'bool': return n >= 0.5 ? 1 : 0;
    case 'lin': default: return min + n * (max - min);
  }
}

/** Human readable value for tooltips / value readouts. */
export function formatValue(def, v) {
  if (def.options) return def.options[Math.round(v)] ?? String(v);
  if (def.curve === 'bool') return v ? 'On' : 'Off';
  const unit = def.unit || '';
  if (unit === 'Hz' && v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz';
  if (unit === 's') return v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s';
  if (def.curve === 'int') return (v > 0 && def.min < 0 ? '+' : '') + Math.round(v) + (unit ? ' ' + unit : '');
  if (unit === '°') return Math.round(v) + '°';
  if (def.min < 0 && unit !== 'Hz') return (v > 0 ? '+' : '') + (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)) + (unit ? ' ' + unit : '');
  if (unit === 'Hz') return (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0)) + ' Hz';
  if (unit === 'x') return v.toFixed(2) + 'x';
  if (unit) return (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)) + ' ' + unit;
  return Math.round(v * 100) + '%';
}

export function defaultPartParams() {
  return Object.fromEntries(PART_PARAMS.map(p => [p.id, p.default]));
}
export function defaultGlobalParams() {
  return Object.fromEntries(GLOBAL_PARAMS.map(p => [p.id, p.default]));
}
export function defaultMods() {
  return Object.fromEntries(MOD_PARAM_IDS.map(id => [id, { ...MOD_DEFAULT, steps: [...DEFAULT_LFO_STEPS] }]));
}

export const SEQ_STEPS = 16;
export const SEQ_RATES = [
  { name: '1/4', beats: 1 }, { name: '1/8', beats: 0.5 }, { name: '1/8T', beats: 1 / 3 },
  { name: '1/16', beats: 0.25 }, { name: '1/16T', beats: 1 / 6 }, { name: '1/32', beats: 0.125 },
];
// Original trigger masks, repeated at the selected arp rate. One = note, zero = rest.
export const ARP_RHYTHMS = Object.freeze([
  ['Every step', '1'], ['Offbeat', '01'], ['Half time', '10'], ['Quarter time', '1000'],
  ['Three pulse', '1110'], ['Tresillo', '10010010'], ['Cinquillo', '10110110'], ['Clave', '1001001000101000'],
  ['Backbeat', '0000100000001000'], ['Four and pickup', '1000100010001010'], ['Disco', '1001100110011001'],
  ['Skipping', '11011010'], ['Heartbeat', '11000000'], ['Gallop', '1011'], ['Reverse gallop', '1101'],
  ['Triplet pair', '110'], ['Triplet tail', '011'], ['Seven pulse', '1010101'], ['Five pulse', '10101'],
  ['Syncopation', '10100101'], ['Broken eighths', '11001010'], ['Double time burst', '11110000'],
  ['Sparse nine', '100010001'], ['Seven of sixteen', '1010100101010010'], ['Long answer', '1000010001000100'],
  ['Rising density', '1000101011111111'], ['Falling density', '1111111110101000'], ['Call and response', '1110000010101010'],
].map(([name, mask]) => Object.freeze({ name, steps: Object.freeze([...mask].map(Number)) })));
export const ARP_MODES = ['Off', 'Up', 'Down', 'Up/Down', 'Random', 'As Played', 'Chord'];

/**
 * A sequencer step. `degree` is a scale degree relative to the global key
 * (0 = root, 7 = root an octave up in a 7-note scale, negatives go down),
 * so changing key/scale re-harmonises every pattern.
 */
export function defaultStep() {
  // lock/lx/ly: optional dot lock. When lock = 1 the dot glides to (lx, ly) as the step plays.
  // Optional fields, absent unless changed (read them with stepProb / stepRatchet):
  //   prob: chance (0..1) the step plays each time it comes round (absent = 1, always).
  //   ratchet: 1..RATCHET_MAX hits that split the step evenly (absent = 1, a single note).
  // Keeping them out of the default step keeps older sessions and scenes byte-for-byte the same.
  return { on: 0, degree: 0, octave: 0, vel: 0.8, gate: 0.5, slide: 0, accent: 0, lock: 0, lx: 0.5, ly: 0.5 };
}

/** Most hits a ratcheted step can play. */
export const RATCHET_MAX = 4;
/** Each ratchet repeat plays at this fraction of the previous hit's velocity. */
export const RATCHET_DECAY = 0.85;

const finiteOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** A step's play probability, 0..1 (missing = 1). */
export function stepProb(step) {
  return clamp(finiteOr(step && step.prob, 1), 0, 1);
}
/** A step's ratchet count, 1..RATCHET_MAX (missing = 1). */
export function stepRatchet(step) {
  return clamp(Math.round(finiteOr(step && step.ratchet, 1)), 1, RATCHET_MAX);
}

function mix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  return h ^ (h >>> 16);
}
/**
 * Deterministic random number in [0, 1) for one pass of a step: a hash of
 * (seed, track index, absolute step count since play started). The same
 * inputs always give the same answer, so playback, offline renders and tests
 * agree, while every pass of a looping pattern gets a fresh roll.
 */
export function stepChance(seed, part, absStep) {
  const h = mix32(mix32(mix32((absStep | 0) + 0x9e3779b9) ^ Math.imul((part | 0) + 1, 0x85ebca6b)) ^ Math.imul(seed | 0, 0xc2b2ae35));
  return (h >>> 0) / 4294967296;
}
/** Whether a step that is on plays this pass, given its probability. */
export function stepPlays(step, seed, part, absStep) {
  const pr = stepProb(step);
  if (pr >= 1) return true;
  if (pr <= 0) return false;
  return stepChance(seed, part, absStep) < pr;
}
/**
 * v2.9 parameter locks: a step may hold values for up to PLOCK_MAX part
 * parameters in `plocks` ({ cutoff: 1200, resonance: 0.6 }, absent when it
 * has none). The dot has its own lock (lock/lx/ly), so Dot X and Dot Y are
 * left out.
 */
export const PLOCK_MAX = 8;
export const PLOCK_IDS = Object.freeze(MOD_PARAM_IDS.filter(id => id !== 'centerX' && id !== 'centerY'));
const PLOCK_SET = new Set(PLOCK_IDS);
/** A step's parameter locks as { id: value } (known ids, clamped to range, at most PLOCK_MAX), or null. */
export function stepPlocks(step) {
  const src = step && step.plocks;
  if (!src || typeof src !== 'object') return null;
  let out = null, n = 0;
  for (const id of Object.keys(src)) {
    if (n >= PLOCK_MAX) break;
    const v = src[id];
    if (!PLOCK_SET.has(id) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    const d = PART_PARAM_MAP[id];
    if (!out) out = {};
    out[id] = clamp(v, Math.min(d.min, d.max), Math.max(d.min, d.max));
    n++;
  }
  return out;
}

/**
 * v2.9 song mode: a track may hold `chain` = { on, entries: [{ pattern, repeats }] }
 * (absent until used). While it is on, the track plays the entries in order,
 * each pattern `repeats` passes, and loops the list.
 */
export const CHAIN_MAX = 32;
export const CHAIN_REPEATS_MAX = 16;
/** The chain a track plays (entries with valid pattern indices), or null when it is off or empty. */
export function activeChain(part) {
  const c = part && part.chain;
  if (!c || !c.on || !Array.isArray(c.entries) || !c.entries.length) return null;
  const n = Array.isArray(part.patterns) ? part.patterns.length : 0;
  const out = [];
  for (const e of c.entries.slice(0, CHAIN_MAX)) {
    if (!e || typeof e !== 'object') continue;
    const k = Math.round(finiteOr(e.pattern, -1));
    if (!(k >= 0 && k < n)) continue;
    out.push({ pattern: k, repeats: clamp(Math.round(finiteOr(e.repeats, 1)), 1, CHAIN_REPEATS_MAX) });
  }
  return out.length ? out : null;
}

/** Patterns a track can hold (the arrangement picks between them). */
export const MAX_PATTERNS = 16;
/**
 * One step-sequencer pattern. A track holds `patterns` (1..MAX_PATTERNS, each
 * with a stable `id`) and plays `patterns[activePattern]`; whether it plays at
 * all is the track's `seqOn`.
 */
export function defaultPattern(n = 1) {
  // lockGlide: how long the dot takes to reach a step's lock, as a fraction of one step (0 = jump).
  return { id: `p${n}`, name: `Pattern ${n}`, rate: 3, length: 16, baseOctave: 3, lockGlide: 0.5, steps: Array.from({ length: SEQ_STEPS }, defaultStep) };
}
/** Index of the pattern a track plays (always valid for a track with patterns). */
export function activePatternIndex(part) {
  const list = part && Array.isArray(part.patterns) ? part.patterns : [];
  const i = Math.round(Number(part && part.activePattern) || 0);
  return list.length ? Math.max(0, Math.min(list.length - 1, i)) : 0;
}
/**
 * The pattern a track plays, as the sequencer reads it: the pattern's fields
 * plus `enabled` (the track's seqOn). null for a missing track.
 */
export function activeSeq(part) {
  if (!part || !Array.isArray(part.patterns) || !part.patterns.length) return null;
  return { ...part.patterns[activePatternIndex(part)], enabled: part.seqOn ? 1 : 0 };
}
/** Store path of the pattern track `p` plays, e.g. 'parts.2.patterns.0'. */
export function patternPath(store, p) {
  return `parts.${p}.patterns.${activePatternIndex(store.get(`parts.${p}`))}`;
}
export function defaultArp() {
  return { mode: 0, rate: 3, octaves: 1, gate: 0.6, hold: 0, rhythm: 0 };
}

// How the dot (orbit centre) behaves on the map.
//   Pin: stays where you put it. Roll: a marble under gravity. Drift: smooth wander.
//   Explore: the marble roams under slowly turning gravity and plays in-key notes at peaks/valleys.
//   Tour: the dot travels through up to MAX_WAYPOINTS waypoints.
//   Pendulum (v2.1): the dot is the tip of a chaotic double pendulum hung where you put it.
export const DOT_MODES = ['Pin', 'Roll', 'Drift', 'Explore', 'Tour', 'Pendulum'];
export const TOUR_MODES = ['Loop', 'Ping-pong', 'Once'];
export const MAX_WAYPOINTS = 8;

/**
 * A fresh track for slot `i`: id `t<i+1>`, name 'Track <i+1>' and the slot's
 * colour unless given. src/core/tracks.js makes ids unique within a list.
 */
export function defaultPart(i = 0, { id, name, color } = {}) {
  const k = Math.max(0, Math.round(Number(i) || 0));
  return {
    id: id || `t${k + 1}`,
    name: name || `Track ${k + 1}`,
    color: color || PART_COLORS[k % PART_COLORS.length],
    patchName: 'Init',
    params: defaultPartParams(),
    mods: defaultMods(),
    seqOn: 0,
    patterns: [defaultPattern(1)],
    activePattern: 0,
    arp: defaultArp(),
    // gravity 0..1 maps to 0..2 g; tiltX/tiltY lean the world (-1..1); flick scales throws;
    // explore*: Explore mode note density, range in octaves, play notes on/off;
    // pendEnergy -2.95..4 (pendulum energy, as the science source), pendReach and pendRate 0..1;
    // waypoints [{x, y, beats}] (beats = travel time to the next waypoint, 0.25..16), tourMode index into TOUR_MODES.
    dot: { mode: 0, gravity: 0.5, friction: 0.25, driftSpeed: 0.3, bounce: 0.25, tiltX: 0, tiltY: 0, flick: 0.5,
      exploreRate: 0.5, exploreRange: 2, exploreNotes: 1, waypoints: [], tourMode: 0,
      pendEnergy: 0.5, pendReach: 0.4, pendRate: 0.5 },
    funcPoints: defaultFuncPoints(),
    drum: defaultDrum(),
    links: defaultLinks(),
    userTerrain: { A: null, B: null },
    trackFx: defaultTrackFx(),
    noiseRecording: null,
  };
}

// Saved state format. 2 = v1.1 (pedal send params, Guitar Level link source);
// migrateState() loads version 1 sessions with the new values at their defaults (off).
// 3 = v1.1 pedal presets: a scene may carry `pedalPresets` (one Program Change
// per pedal, see src/pedals/pedal-presets.js) next to its state. Sessions are
// unchanged; migrateScene() loads version 1 and 2 scenes with none.
// 4 = v1.3 tracks: `parts` is a list of 1..MAX_PARTS tracks with stable ids,
// and each track's sequencer holds `patterns` (with ids) and `activePattern`
// plus a `seqOn` switch instead of one `seq`. migrateState() turns the four
// parts of older sessions and scenes into four tracks (ids t1..t4, the old
// `seq` as pattern 1).
export const STATE_VERSION = 5;

export function defaultState(count = DEFAULT_PARTS) {
  const n = Math.max(MIN_PARTS, Math.min(MAX_PARTS, Math.round(Number(count) || DEFAULT_PARTS)));
  return {
    version: STATE_VERSION,
    global: defaultGlobalParams(),
    parts: Array.from({ length: n }, (_, i) => defaultPart(i)),
  };
}

/** Note number -> frequency (A4 = 440 Hz = MIDI 69). */
export function mtof(n) { return 440 * Math.pow(2, (n - 69) / 12); }

/** Resolve a sequencer step to a MIDI note using the global key/scale. */
export function stepToMidi(step, baseOctave, root, scaleType) {
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor;
  const len = scale.length;
  const d = step.degree;
  const oct = Math.floor(d / len);
  const idx = ((d % len) + len) % len;
  return 12 * (baseOctave + 1 + (step.octave || 0) + oct) + root + scale[idx];
}
