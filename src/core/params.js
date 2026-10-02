// Parameter registry. Pure data + pure functions, no DOM.
// Shared by the UI (knobs), the store (defaults, presets), and the audio worklet
// (modulation is applied in normalised 0..1 space, then mapped back through the
// same curves). Keep this file dependency-free apart from the catalog.

import { TERRAIN_NAMES, PATH_NAMES, TERRAIN_INDEX, PATH_INDEX } from '../dsp/catalog.js';

export const NUM_PARTS = 4;
export const VOICES_PER_PART = 8;
export const PART_COLORS = ['#ff7a45', '#3fd0c9', '#b98cff', '#ffd23f'];
export const PART_NAMES = ['Part 1', 'Part 2', 'Part 3', 'Part 4'];

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
};
export const SCALE_NAMES = Object.keys(SCALES);

export const LFO_SHAPES = ['Sine', 'Triangle', 'Saw', 'Square', 'S&H', 'Drift', 'Steps'];
export const LFO_STEP_COUNT = 16;
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
  P('glide',     'Glide',    'voice', 'pow', 0, 2, 0,     { k: 3, unit: 's' }),
  P('polyMode',  'Mode',     'voice', 'enum', 0, 2, 0,    { options: ['Poly', 'Mono', 'Legato'] }),
  P('unison',    'Unison',   'voice', 'int', 1, 4, 1),
  P('detune',    'Detune',   'voice', 'lin', 0, 50, 12,   { unit: 'ct' }),
  P('spread',    'Width',    'voice', 'lin', 0, 1, 0.6),
  P('velSens',   'Velocity', 'voice', 'lin', 0, 1, 0.6),
  P('bendRange', 'Bend',     'voice', 'int', 0, 24, 2,    { unit: 'st' }),
  // Filter
  P('filterType', 'Filter',  'filter', 'enum', 0, 6, 1,   { options: ['Off', 'Low', 'Band', 'High', 'Notch', 'Comb', 'Vowel'] }),
  P('cutoff',    'Cutoff',   'filter', 'exp', 30, 18000, 9000, { mod: true, unit: 'Hz' }),
  P('resonance', 'Reso',     'filter', 'lin', 0, 1, 0.15, { mod: true }),
  P('filterEnv', 'Env Amt',  'filter', 'lin', -1, 1, 0.15, { hint: 'Envelope 2 to cutoff, up to ±6 octaves' }),
  P('keyTrack',  'Key Trk',  'filter', 'lin', 0, 1, 0.5),
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
  P('sub',       'Sub',      'voice', 'lin', 0, 1, 0,    { hint: 'Clean sine one octave below the note' }),
  P('traverse',  'Travel',   'path', 'enum', 0, 1, 0,    { options: ['Natural', 'Even'], hint: 'Natural follows the curve maths (corners speed up and slow down); Even moves at constant speed along the path' }),
  P('direction', 'Direction','path', 'enum', 0, 1, 0,    { options: ['Forward', 'Ping-pong'], hint: 'Ping-pong runs the path forward then backward each cycle, so open paths never jump' }),
  P('noteSize',  'Key>Size', 'path', 'lin', -1, 1, 0,    { hint: 'Higher notes shrink (negative) or grow (positive) the orbit. Negative keeps high notes smooth' }),
  P('air',       'Air',      'voice', 'lin', 0, 1, 0,    { hint: 'Breathy noise layer that follows the amp envelope' }),
  P('airTone',   'Air Tone', 'voice', 'lin', -1, 1, 0,   { hint: 'Dark to bright noise colour' }),
  P('formant',   'Vowel',    'filter', 'lin', 0, 1, 0.5, { mod: true, hint: 'Vowel filter position A, E, I, O, U (also sets the Comb filter spread)' }),
];

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
export const DEFAULT_LFO_STEPS = Object.freeze([0.8, -0.4, 0.2, -0.9, 0.6, -0.1, 0.4, -0.7, 0.9, -0.3, 0.1, -0.8, 0.5, 0, 0.3, -0.6]);
export const MOD_DEFAULT = Object.freeze({ lfoShape: 0, lfoRate: 0.5, lfoSync: 0, lfoDiv: 5, lfoDepth: 0, envDepth: 0, retrig: 0, steps: DEFAULT_LFO_STEPS });
export const MOD_FIELDS = Object.keys(MOD_DEFAULT);

// Links: per-part modulation routing (source -> any modulatable parameter), applied
// in normalised space on top of the per-parameter LFO/Env depths.
// Source value ranges: Velocity, Mod Wheel, Pressure, Slide, Macros, Marble Speed,
// Env 1, Env 2 are 0..1; Key ((note - 60) / 48), Marble Height, Random (per note) and
// Terrain Height (height under the modulated dot) are -1..1.
export const LINK_SOURCES = ['Velocity', 'Mod Wheel', 'Pressure', 'Key', 'Slide', 'Macro 1', 'Macro 2', 'Macro 3', 'Macro 4',
  'Marble Speed', 'Marble Height', 'Env 1', 'Env 2', 'Random', 'Terrain Height'];
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
export const ARP_MODES = ['Off', 'Up', 'Down', 'Up/Down', 'Random', 'As Played', 'Chord'];

/**
 * A sequencer step. `degree` is a scale degree relative to the global key
 * (0 = root, 7 = root an octave up in a 7-note scale, negatives go down),
 * so changing key/scale re-harmonises every pattern.
 */
export function defaultStep() {
  // lock/lx/ly: optional dot lock. When lock = 1 the dot glides to (lx, ly) as the step plays.
  return { on: 0, degree: 0, octave: 0, vel: 0.8, gate: 0.5, slide: 0, accent: 0, lock: 0, lx: 0.5, ly: 0.5 };
}
export function defaultSeq() {
  // lockGlide: how long the dot takes to reach a step's lock, as a fraction of one step (0 = jump).
  return { enabled: 0, rate: 3, length: 16, baseOctave: 3, lockGlide: 0.5, steps: Array.from({ length: SEQ_STEPS }, defaultStep) };
}
export function defaultArp() {
  return { mode: 0, rate: 3, octaves: 1, gate: 0.6, hold: 0 };
}

// How the dot (orbit centre) behaves on the map.
//   Pin: stays where you put it. Roll: a marble under gravity. Drift: smooth wander.
//   Explore: the marble roams under slowly turning gravity and plays in-key notes at peaks/valleys.
//   Tour: the dot travels through up to MAX_WAYPOINTS waypoints.
export const DOT_MODES = ['Pin', 'Roll', 'Drift', 'Explore', 'Tour'];
export const TOUR_MODES = ['Loop', 'Ping-pong', 'Once'];
export const MAX_WAYPOINTS = 8;

export function defaultPart(i) {
  return {
    name: PART_NAMES[i],
    color: PART_COLORS[i],
    patchName: 'Init',
    params: defaultPartParams(),
    mods: defaultMods(),
    seq: defaultSeq(),
    arp: defaultArp(),
    // gravity 0..1 maps to 0..2 g; tiltX/tiltY lean the world (-1..1); flick scales throws;
    // explore*: Explore mode note density, range in octaves, play notes on/off;
    // waypoints [{x, y, beats}] (beats = travel time to the next waypoint, 0.25..16), tourMode index into TOUR_MODES.
    dot: { mode: 0, gravity: 0.5, friction: 0.25, driftSpeed: 0.3, bounce: 0.25, tiltX: 0, tiltY: 0, flick: 0.5,
      exploreRate: 0.5, exploreRange: 2, exploreNotes: 1, waypoints: [], tourMode: 0 },
    links: defaultLinks(),
    userTerrain: { A: null, B: null },
  };
}

export function defaultState() {
  return {
    version: 1,
    global: defaultGlobalParams(),
    parts: Array.from({ length: NUM_PARTS }, (_, i) => defaultPart(i)),
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
