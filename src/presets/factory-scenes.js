// Factory scenes: complete four-part demo songs. Scene 0 loads on first
// launch, so it has to sound inviting the moment Play is pressed.
//
// Patterns are written in a compact step notation, one token per step:
//   .      rest
//   4      scale degree (0 = key root, 7 = an octave up in a 7-note scale)
//   '  ,   octave up / down (repeatable)
//   !      accent        ~  slide (ties into the next step)
//   >      long gate     <  short gate        *  softer
// Degrees follow the global key, so changing key re-harmonises every part.
//
// Dot locks are given separately as { step: [x, y] }: when that step plays,
// the part's dot glides to (x, y) on the map over `lockGlide` of a step.
//
// Every sequence, step and arp starts from the registry defaults
// (defaultSeq / defaultStep / defaultArp), so fields added to the state later
// are filled in here too and the scenes keep passing migrateState unchanged.

import { defaultState, defaultGlobalParams, defaultSeq, defaultStep, defaultArp, SEQ_STEPS, NUM_PARTS, clamp } from '../core/params.js';
import { FACTORY_PATCHES } from './factory-patches.js';
import { partWithPatch } from './apply.js';

const RATE = { '1/4': 0, '1/8': 1, '1/8T': 2, '1/16': 3, '1/16T': 4, '1/32': 5 };
const SCALE = { major: 0, minor: 1, dorian: 2, phrygian: 3, lydian: 4, mixolydian: 5, pentMaj: 6, pentMin: 7, blues: 8, harmMin: 9, chromatic: 10 };
const KEY = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const DELAY = { '1/2': 0, '1/4.': 1, '1/4': 2, '1/8.': 3, '1/4T': 4, '1/8': 5, '1/16.': 6, '1/8T': 7, '1/16': 8, '1/32': 9 };
const ARP = { off: 0, up: 1, down: 2, upDown: 3, random: 4, played: 5, chord: 6 };

/** Parse the step notation above into 16 sequencer steps (unused steps stay off). */
export function parsePattern(text, { gate = 0.5, vel = 0.8 } = {}) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (tokens.length > SEQ_STEPS) throw new Error(`Pattern has ${tokens.length} steps, max ${SEQ_STEPS}`);
  const steps = Array.from({ length: SEQ_STEPS }, defaultStep);
  tokens.forEach((tok, i) => {
    const st = steps[i];
    st.gate = gate;
    st.vel = vel;
    if (tok === '.') return;
    const m = /^(-?\d+)([',!~><*]*)$/.exec(tok);
    if (!m) throw new Error(`Bad pattern token "${tok}"`);
    st.on = 1;
    st.degree = Number(m[1]);
    for (const c of m[2]) {
      if (c === '\'') st.octave += 1;
      else if (c === ',') st.octave -= 1;
      else if (c === '!') st.accent = 1;
      else if (c === '~') st.slide = 1;
      else if (c === '>') st.gate = 0.95;
      else if (c === '<') st.gate = 0.2;
      else if (c === '*') st.vel = 0.55;
    }
  });
  return { steps, length: tokens.length };
}

/**
 * Add dot locks to parsed steps. `locks` maps a step index to [x, y]; a lock
 * may sit on a rest (the dot still moves). Throws on a step outside the
 * pattern so a typo cannot silently drop a lock.
 */
export function applyLocks(steps, locks, length = SEQ_STEPS) {
  for (const [key, xy] of Object.entries(locks || {})) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i >= length) throw new Error(`Lock on step ${key} is outside the pattern`);
    if (!Array.isArray(xy) || xy.length !== 2 || !xy.every(v => Number.isFinite(v) && v >= 0 && v < 1)) throw new Error(`Lock on step ${key} needs [x, y] in 0..1`);
    steps[i] = { ...steps[i], lock: 1, lx: xy[0], ly: xy[1] };
  }
  return steps;
}

function seq(text, { rate = '1/16', baseOctave = 3, gate, vel, locks, lockGlide } = {}) {
  const { steps, length } = parsePattern(text, { gate, vel });
  const out = { ...defaultSeq(), enabled: 1, rate: RATE[rate], length, baseOctave, steps: applyLocks(steps, locks, length) };
  if (lockGlide != null) out.lockGlide = lockGlide;
  return out;
}

const PATCH_BY_NAME = Object.fromEntries(FACTORY_PATCHES.map(p => [p.name, p]));
const round2 = (v) => Math.round(v * 100) / 100;

function buildScene({ name, description, global, parts }) {
  const state = defaultState();
  state.global = { ...defaultGlobalParams(), ...global };
  state.parts = state.parts.map((base, i) => {
    const spec = parts[i];
    const patch = PATCH_BY_NAME[spec.patch];
    if (!patch) throw new Error(`Scene "${name}" uses unknown patch "${spec.patch}"`);
    const part = partWithPatch(base, patch);
    part.name = spec.name || base.name;
    part.params.level = round2(clamp(part.params.level * (spec.gain ?? 1), 0, 1));
    if (spec.pan != null) part.params.pan = spec.pan;
    if (spec.reverbSend != null) part.params.reverbSend = spec.reverbSend;
    if (spec.delaySend != null) part.params.delaySend = spec.delaySend;
    part.seq = spec.seq;
    part.arp = { ...defaultArp(), mode: ARP.off, rate: RATE['1/16'], ...(spec.arp || {}) };
    return part;
  });
  if (state.parts.length !== NUM_PARTS) throw new Error('Scenes need four parts');
  return { ...state, name, description };
}

export const FACTORY_SCENES = [
  buildScene({
    name: 'First Light',
    description: 'A mellow groove in A minor: a round bass, a drifting pad, a rippling line and a far-off bell. Press Play.',
    global: {
      tempo: 104, swing: 0.12, scaleRoot: KEY.A, scaleType: SCALE.minor,
      delayDiv: DELAY['1/8.'], delayFeedback: 0.38, delayTone: 0.5, delayLevel: 0.6,
      reverbSize: 0.7, reverbDamp: 0.45, reverbLevel: 0.7, chorus: 0.2, saturation: 0.2,
    },
    parts: [
      { name: 'Bass', patch: 'Basalt Bass', gain: 0.9, seq: seq('0! . 0 0\' . 0 4~ 2 5! . 5 5\' . 5 4 6', { rate: '1/8', baseOctave: 2, gate: 0.6 }) },
      { name: 'Pad', patch: 'Tidal Flats', gain: 0.85, pan: -0.15, seq: seq('2~ 2~ 2~ 2> 0~ 0~ 0~ 0>', { rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.7 }) },
      {
        name: 'Ripple', patch: 'Isobar Arp', gain: 0.9, pan: 0.2,
        seq: seq('0! . 4 2 7 . 4 2 9* . 7 4 2 . 4 6', { rate: '1/16', baseOctave: 4, gate: 0.45, vel: 0.75 }),
        arp: { mode: ARP.upDown, rate: RATE['1/16'], octaves: 2, gate: 0.5 },
      },
      { name: 'Bell', patch: 'Cirque Bell', gain: 0.85, pan: 0.35, seq: seq('. . . 4 . . . . . . 7 . . . 2 .', { rate: '1/8', baseOctave: 4, vel: 0.6 }) },
    ],
  }),
  buildScene({
    name: 'Glass Archipelago',
    description: 'Ambient in D Lydian at 72 bpm: a wandering drone, cold pad, harp figures and glassy chimes in a huge space.',
    global: {
      tempo: 72, swing: 0, scaleRoot: KEY.D, scaleType: SCALE.lydian,
      delayDiv: DELAY['1/4.'], delayFeedback: 0.55, delayTone: 0.45, delayLevel: 0.65,
      reverbSize: 0.9, reverbDamp: 0.35, reverbLevel: 0.85, chorus: 0.3, saturation: 0.1,
    },
    parts: [
      { name: 'Drone', patch: 'Bedrock Drone', gain: 0.85, seq: seq('0~ 0~ 0~ 0~ 0~ 0~ 0~ 0> 5~ 5~ 5~ 5> 4~ 4~ 4~ 4>', { rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.7 }) },
      {
        // Each chord gets its own corner of the map, reached with a slow
        // full-beat glide: open centre, the glassy ring, a warm ridge, a dark shelf.
        name: 'Pad', patch: 'Polar Night', gain: 0.9, pan: -0.2,
        seq: seq('2~ 2~ 2~ 2> 4~ 4~ 4~ 4> 2~ 2~ 2~ 2> 1~ 1~ 1~ 1>', {
          rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.65, lockGlide: 1,
          locks: { 0: [0.5, 0.5], 4: [0.25, 0.55], 8: [0.65, 0.35], 12: [0.9, 0.9] },
        }),
      },
      {
        name: 'Harp', patch: 'Harbour Harp', gain: 1, pan: 0.2,
        seq: seq('0 4 7 . 3 . 9 . 7 4 . 2 . 6 . .', { rate: '1/8', baseOctave: 4, gate: 0.8, vel: 0.65 }),
        arp: { mode: ARP.up, rate: RATE['1/8'], octaves: 3, gate: 0.8 },
      },
      { name: 'Chime', patch: 'Iceshelf Chime', gain: 0.85, pan: 0.4, seq: seq('. . . . 4 . . . . . . 1 . . . .', { rate: '1/8', baseOctave: 4, vel: 0.55 }) },
    ],
  }),
  buildScene({
    name: 'Neon Coastline',
    description: 'Synthwave in E minor: pulsing octave bass, a wide pad, a saw lead hook and a sparkling arp.',
    global: {
      tempo: 100, swing: 0, scaleRoot: KEY.E, scaleType: SCALE.minor,
      delayDiv: DELAY['1/8.'], delayFeedback: 0.45, delayTone: 0.55, delayLevel: 0.65,
      reverbSize: 0.75, reverbDamp: 0.4, reverbLevel: 0.7, chorus: 0.35, saturation: 0.25,
    },
    parts: [
      { name: 'Bass', patch: 'Moraine Reese', gain: 0.9, seq: seq('0 0\' 0 0\' 0 0\' 0 0\' 5 5\' 5 5\' 6 6\' 6 6\'', { rate: '1/8', baseOctave: 2, gate: 0.55 }) },
      { name: 'Pad', patch: 'Aurora Plateau', gain: 0.85, pan: -0.15, seq: seq('4~ 4~ 4~ 4> 2~ 2> 3~ 3>', { rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.7 }) },
      {
        // The Scan orbit reads one row of the Spectra wavetable, so locking the
        // dot's height swaps the waveform under each phrase: saw on the downbeat,
        // hollow square, nasal pulse, then a soft triangle that slides home.
        name: 'Lead', patch: 'Summit Saw', gain: 0.9, pan: 0.1,
        seq: seq('7! . . 6 . 4 . . 2 . 4 . 6~ 7 . .', {
          rate: '1/16', baseOctave: 4, gate: 0.6, lockGlide: 0.6,
          locks: { 0: [0.5, 0.27], 5: [0.5, 0.33], 8: [0.5, 0.44], 12: [0.5, 0.21] },
        }),
      },
      {
        name: 'Arp', patch: 'Survey Arp', gain: 0.9, pan: 0.3,
        seq: seq('0 4 7 4 0 4 7 4 0 4 7 4 2 4 7 9', { rate: '1/16', baseOctave: 4, gate: 0.35, vel: 0.7 }),
        arp: { mode: ARP.up, rate: RATE['1/16'], octaves: 2, gate: 0.45 },
      },
    ],
  }),
  buildScene({
    name: 'Isoline Pulse',
    description: 'Minimal techno in C Phrygian at 124 bpm: an off-beat bass, snapping plucks, glitch accents and a stepped texture.',
    global: {
      tempo: 124, swing: 0.08, scaleRoot: KEY.C, scaleType: SCALE.phrygian,
      delayDiv: DELAY['1/8.'], delayFeedback: 0.5, delayTone: 0.5, delayLevel: 0.6,
      reverbSize: 0.5, reverbDamp: 0.5, reverbLevel: 0.55, chorus: 0.1, saturation: 0.3,
    },
    parts: [
      { name: 'Bass', patch: 'Fault Line', gain: 1, seq: seq('. . 0! . . . 0 . . . 0 . . 0 . 1', { rate: '1/16', baseOctave: 2, gate: 0.4 }) },
      { name: 'Pluck', patch: 'Scree Pluck', gain: 0.85, pan: 0.15, seq: seq('0 . . 3 . . 0 . . 6 . . 0 . 4 .', { rate: '1/16', baseOctave: 4, gate: 0.5 }) },
      { name: 'Glitch', patch: 'Seismograph', gain: 0.85, pan: -0.3, seq: seq('. . . . . . . 7! . . . . . . 5 .', { rate: '1/16', baseOctave: 4, gate: 0.6 }) },
      { name: 'Grain', patch: 'Lichen Grain', gain: 0.9, pan: 0.25, seq: seq('0~ 0~ 0~ 0> . . . . 4~ 4~ 4~ 4> . . . .', { rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.65 }) },
    ],
  }),
  buildScene({
    name: 'Paper Maps',
    description: 'Lo-fi in D Dorian with a heavy swing: a soft sub, dusty keys, a mellow electric piano and pizzicato flecks.',
    global: {
      tempo: 84, swing: 0.4, scaleRoot: KEY.D, scaleType: SCALE.dorian,
      delayDiv: DELAY['1/4.'], delayFeedback: 0.35, delayTone: 0.3, delayLevel: 0.5,
      reverbSize: 0.55, reverbDamp: 0.7, reverbLevel: 0.6, chorus: 0.4, saturation: 0.45,
    },
    parts: [
      { name: 'Sub', patch: 'Tar Pit Sub', gain: 0.85, seq: seq('0! . . 0 . . 4 . 3! . . 3 . 2 . 1', { rate: '1/8', baseOctave: 2, gate: 0.7 }) },
      {
        name: 'Keys', patch: 'Sandstone Keys', gain: 1, pan: -0.1,
        seq: seq('2 . 4 . 6 . 4 . 3 . 5 . 7 . 5 .', { rate: '1/8', baseOctave: 4, gate: 0.8, vel: 0.7 }),
        arp: { mode: ARP.played, rate: RATE['1/8'], octaves: 1, gate: 0.8 },
      },
      { name: 'EP', patch: 'Lagoon EP', gain: 1, pan: 0.15, seq: seq('6~ 6~ 6~ 6> 5~ 5~ 5~ 5>', { rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.65 }) },
      { name: 'Flecks', patch: 'Kelp Pizzicato', gain: 0.85, pan: 0.35, seq: seq('. . 4* . . . . 2* . . 4* . . . . .', { rate: '1/16', baseOctave: 5 }) },
    ],
  }),
  buildScene({
    name: 'Continental Shelf',
    description: 'Cinematic in D harmonic minor at 70 bpm: a deep spiral drone, an urgent ostinato, a swelling pad and a distant gong.',
    global: {
      tempo: 70, swing: 0, scaleRoot: KEY.D, scaleType: SCALE.harmMin,
      delayDiv: DELAY['1/2'], delayFeedback: 0.4, delayTone: 0.45, delayLevel: 0.5,
      reverbSize: 0.95, reverbDamp: 0.5, reverbLevel: 0.9, chorus: 0.2, saturation: 0.2,
    },
    parts: [
      { name: 'Drone', patch: 'Ocean Trench', gain: 0.85, seq: seq('0~ 0~ 0~ 0~ 0~ 0~ 0~ 0> 5~ 5~ 5~ 5> 4~ 4~ 4~ 4>', { rate: '1/4', baseOctave: 4, gate: 0.95, vel: 0.75 }) },
      { name: 'Ostinato', patch: 'Shale Pluck', gain: 0.95, pan: 0.2, seq: seq('0 2 4 2 0 2 4 2 0 2 5 2 0 2 4 6', { rate: '1/8', baseOctave: 3, gate: 0.5, vel: 0.7 }) },
      { name: 'Pad', patch: 'Monsoon Haze', gain: 0.85, pan: -0.2, seq: seq('4~ 4~ 4~ 4~ 4~ 4~ 4~ 4> 2~ 2~ 2~ 2> 6~ 6~ 6~ 6>', { rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.65 }) },
      { name: 'Gong', patch: 'Caldera Gong', gain: 0.85, pan: -0.35, seq: seq('0 . . . . . . . 5 . . . 4 . . .', { rate: '1/4', baseOctave: 3, vel: 0.7 }) },
    ],
  }),
  buildScene({
    name: 'Signal Fault',
    description: 'Glitch in A minor pentatonic at 138 bpm: a wobbling bass, 32nd-note stutters, a swirling texture and triplet pings.',
    global: {
      tempo: 138, swing: 0, scaleRoot: KEY.A, scaleType: SCALE.pentMin,
      delayDiv: DELAY['1/8T'], delayFeedback: 0.55, delayTone: 0.6, delayLevel: 0.6,
      reverbSize: 0.4, reverbDamp: 0.5, reverbLevel: 0.5, chorus: 0.1, saturation: 0.35,
    },
    parts: [
      { name: 'Bass', patch: 'Delta Wobble', gain: 0.9, seq: seq('0! . 0 . . 0~ 2 . 0! . . 3 . 0 . 4', { rate: '1/16', baseOctave: 2, gate: 0.45 }) },
      { name: 'Stutter', patch: 'Seismograph', gain: 0.7, pan: 0.25, seq: seq('7 . 7 . . 9 . . 7 7 7 . . . 12 .', { rate: '1/32', baseOctave: 3, gate: 0.6 }) },
      { name: 'Swirl', patch: 'Dust Devil', gain: 0.95, pan: -0.25, seq: seq('0~ 0~ 0~ 0> . . . . 3~ 3~ 3~ 3> . . . .', { rate: '1/4', baseOctave: 3, gate: 0.95, vel: 0.65 }) },
      { name: 'Pings', patch: 'Satellite Ping', gain: 0.65, pan: 0.4, seq: seq('. 7 . . 9 . . . 7 . . 5 . . . .', { rate: '1/16T', baseOctave: 2, vel: 0.7 }) },
    ],
  }),
];
