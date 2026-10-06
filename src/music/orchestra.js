// The score desk's orchestra (2.17). Every voice an agent can write in a
// score, what it is made from, and where it sits in the mix.
//
// One land, many desks: a pitched voice is a factory patch (already level
// balanced by tests/presets/levels.test.js) with a few changes for the
// instrument: a faster bow, a shorter decay, vibrato, a brighter filter.
// Octave and Tune are always zeroed so a score's A4 sounds at A4.
//
// Drums use two kits. The Kit is the classic eight synth pads. Percussion is
// a second kit built from the 128-sound drum library (cymbals, shaker,
// wood block and friends), so crash, ride, shaker, tambourine, taiko and the
// rest are their own sounds instead of borrowing a clap or a hat. Timpani is
// pitched: the Resonator strikes the land like a skin, tuned to the note.

import { FACTORY_PATCHES } from '../presets/factory-patches.js';
import { KIT_BASE_NOTE } from '../dsp/drum-kit.js';
import { libraryList } from '../dsp/drum-library.js';

const SH = { sine: 0, tri: 1, saw: 2, square: 3, sh: 4, drift: 5 };
const lfo = (depth, rate, shape = SH.sine) => ({ lfoDepth: depth, lfoRate: rate, lfoShape: shape });
const amp = (attack, decay, sustain, release) => ({ attack, decay, sustain, release });
const POLY = 0, LEGATO = 2;
const F = { low: 1, band: 2, high: 3, comb: 5, vowel: 6, warm: 7 };

/**
 * Pitched voices. family: the synthesis family (docs/SYNTH-FAMILIES.md).
 * base: the factory patch it starts from. params / mods: changes on top.
 * mix: level, pan and sends for that seat in the orchestra.
 * range: the comfortable written range [low, high] in MIDI (a warning, not an error).
 * section: where the voice sits, for oro.schema() and the docs.
 */
export const PITCHED = Object.freeze({
  // ---------------------------------------------------------------- strings
  violin: { family: 'terrain', section: 'strings', base: 'Tidal Flats', range: [55, 103],
    params: { ...amp(0.07, 0.6, 0.86, 0.45), cutoff: 5600, unison: 3, detune: 8, spread: 0.6, filterEnv: 0.08 },
    mods: { fine: lfo(0.018, 5.6) }, mix: { pan: -0.42, reverbSend: 0.34, delaySend: 0.04 } },
  viola: { family: 'terrain', section: 'strings', base: 'Tidal Flats', range: [48, 91],
    params: { ...amp(0.08, 0.6, 0.86, 0.5), cutoff: 4200, unison: 3, detune: 8, spread: 0.5 },
    mods: { fine: lfo(0.016, 5.3) }, mix: { pan: -0.12, reverbSend: 0.32, delaySend: 0.03 } },
  cello: { family: 'terrain', section: 'strings', base: 'Tidal Flats', range: [36, 76],
    params: { ...amp(0.09, 0.7, 0.88, 0.55), cutoff: 3000, unison: 3, detune: 7, spread: 0.45, sub: 0.15 },
    mods: { fine: lfo(0.014, 5.0) }, mix: { pan: 0.22, reverbSend: 0.3, delaySend: 0.02 } },
  contrabass: { family: 'terrain', section: 'strings', base: 'Tidal Flats', range: [28, 60],
    params: { ...amp(0.1, 0.7, 0.9, 0.5), cutoff: 1600, unison: 2, detune: 6, spread: 0.3, sub: 0.35 },
    mods: { fine: lfo(0.01, 4.6) }, mix: { pan: 0.36, reverbSend: 0.26, delaySend: 0 } },
  strings: { family: 'terrain', section: 'strings', base: 'Tidal Flats', range: [36, 100],
    params: { ...amp(0.12, 0.8, 0.88, 0.7), cutoff: 4600, unison: 5, detune: 13, spread: 1 },
    mods: { fine: lfo(0.015, 5.2) }, mix: { pan: 0, reverbSend: 0.4, delaySend: 0.05 } },
  spiccato: { family: 'terrain', section: 'strings', base: 'Tidal Flats', range: [36, 100],
    params: { ...amp(0.003, 0.16, 0, 0.12), cutoff: 5200, unison: 4, detune: 10, spread: 0.9, filterEnv: 0.3 },
    mods: {}, mix: { pan: -0.2, reverbSend: 0.3, delaySend: 0.04 } },
  tremolo: { family: 'terrain', section: 'strings', base: 'Tidal Flats', range: [36, 100],
    params: { ...amp(0.15, 0.8, 0.85, 0.7), cutoff: 4400, unison: 5, detune: 12, spread: 1 },
    mods: { cutoff: lfo(0.16, 13, SH.tri), size: lfo(0.05, 13, SH.tri) }, mix: { pan: 0.1, reverbSend: 0.42, delaySend: 0.04 } },
  pizz: { family: 'physical', section: 'strings', base: 'Kelp Pizzicato', range: [36, 96],
    params: {}, mods: {}, mix: { pan: 0.15, reverbSend: 0.3, delaySend: 0.06 } },
  harp: { family: 'physical', section: 'strings', base: 'Harbour Harp', range: [24, 103],
    params: {}, mods: {}, mix: { pan: 0.3, reverbSend: 0.38, delaySend: 0.08 } },
  // -------------------------------------------------------------- woodwinds
  piccolo: { family: 'terrain', section: 'winds', base: 'Glacier Whistle', range: [74, 108],
    params: { cutoff: 8500, ...amp(0.03, 0.3, 0.9, 0.25) }, mods: {}, mix: { pan: -0.15, reverbSend: 0.36, delaySend: 0.05 } },
  flute: { family: 'terrain', section: 'winds', base: 'Glacier Whistle', range: [60, 96],
    params: { ...amp(0.05, 0.3, 0.9, 0.3) }, mods: {}, mix: { pan: -0.2, reverbSend: 0.36, delaySend: 0.08 } },
  oboe: { family: 'subtractive', section: 'winds', base: 'Contour Lead', range: [58, 91],
    params: { polyMode: POLY, glide: 0, ...amp(0.04, 0.4, 0.88, 0.25), cutoff: 3000, unison: 1 },
    mods: { fine: lfo(0.014, 5.4) }, mix: { pan: -0.05, reverbSend: 0.32, delaySend: 0.04 } },
  cor: { family: 'subtractive', section: 'winds', base: 'Contour Lead', range: [52, 84],
    params: { polyMode: POLY, glide: 0, ...amp(0.05, 0.4, 0.88, 0.3), cutoff: 2000, unison: 1 },
    mods: { fine: lfo(0.012, 5.0) }, mix: { pan: 0.05, reverbSend: 0.32, delaySend: 0.03 } },
  clarinet: { family: 'terrain', section: 'winds', base: 'Glacier Whistle', range: [50, 94],
    params: { ...amp(0.04, 0.4, 0.88, 0.25), cutoff: 2600, resonance: 0.18, size: 0.16 },
    mods: {}, mix: { pan: 0.12, reverbSend: 0.32, delaySend: 0.04 } },
  bassoon: { family: 'subtractive', section: 'winds', base: 'Contour Lead', range: [34, 75],
    params: { polyMode: POLY, glide: 0, ...amp(0.05, 0.4, 0.88, 0.25), cutoff: 1300, unison: 1 },
    mods: {}, mix: { pan: 0.2, reverbSend: 0.28, delaySend: 0.02 } },
  // ------------------------------------------------------------------ brass
  horn: { family: 'subtractive', section: 'brass', base: 'Summit Saw', range: [41, 77],
    params: { polyMode: POLY, glide: 0, ...amp(0.07, 0.6, 0.85, 0.45), cutoff: 1700, filterEnv: 0.32, unison: 2, detune: 7, spread: 0.4 },
    mods: {}, mix: { pan: -0.3, reverbSend: 0.38, delaySend: 0.02 } },
  trumpet: { family: 'subtractive', section: 'brass', base: 'Summit Saw', range: [54, 84],
    params: { polyMode: POLY, glide: 0, ...amp(0.025, 0.45, 0.8, 0.3), cutoff: 3600, filterEnv: 0.45, unison: 2, detune: 6, spread: 0.3 },
    mods: {}, mix: { pan: 0.18, reverbSend: 0.3, delaySend: 0.04 } },
  trombone: { family: 'subtractive', section: 'brass', base: 'Summit Saw', range: [40, 72],
    params: { polyMode: POLY, glide: 0, ...amp(0.05, 0.5, 0.82, 0.35), cutoff: 2200, filterEnv: 0.38, unison: 2, detune: 6, spread: 0.3 },
    mods: {}, mix: { pan: 0.32, reverbSend: 0.32, delaySend: 0.02 } },
  tuba: { family: 'subtractive', section: 'brass', base: 'Summit Saw', range: [26, 60],
    params: { polyMode: POLY, glide: 0, ...amp(0.06, 0.5, 0.85, 0.35), cutoff: 900, filterEnv: 0.25, unison: 1, sub: 0.3 },
    mods: {}, mix: { pan: 0.25, reverbSend: 0.26, delaySend: 0 } },
  brass: { family: 'subtractive', section: 'brass', base: 'Summit Saw', range: [36, 84],
    params: { polyMode: POLY, glide: 0, ...amp(0.04, 0.5, 0.82, 0.4), cutoff: 2800, filterEnv: 0.4, unison: 3, detune: 9, spread: 0.7 },
    mods: {}, mix: { pan: 0, reverbSend: 0.34, delaySend: 0.03 } },
  // ----------------------------------------------------------------- voices
  choir: { family: 'terrain', section: 'choir', base: 'Fjord Choir', range: [48, 84],
    params: { ...amp(0.3, 1.2, 0.9, 1.4) }, mods: {}, mix: { pan: 0, reverbSend: 0.5, delaySend: 0.04 } },
  ooh: { family: 'terrain', section: 'choir', base: 'Tundra Voice', range: [48, 84],
    params: { ...amp(0.35, 1.2, 0.9, 1.5) }, mods: {}, mix: { pan: 0.05, reverbSend: 0.5, delaySend: 0.04 } },
  // ---------------------------------------------------- keys and mallets
  piano: { family: 'physical', section: 'keys', base: 'Sandstone Keys', range: [21, 108],
    params: {}, mods: {}, mix: { pan: 0.08, reverbSend: 0.24, delaySend: 0.04 } },
  celesta: { family: 'fm', section: 'keys', base: 'Iceshelf Chime', range: [60, 108],
    params: { ...amp(0.002, 1.1, 0, 0.7) }, mods: {}, mix: { pan: 0.25, reverbSend: 0.4, delaySend: 0.1 } },
  glock: { family: 'fm', section: 'mallets', base: 'Iceshelf Chime', range: [79, 108],
    params: { ...amp(0.001, 1.6, 0, 1.2), cutoff: 9000 }, mods: {}, mix: { pan: -0.25, reverbSend: 0.42, delaySend: 0.08 } },
  xylo: { family: 'physical', section: 'mallets', base: 'Scree Pluck', range: [65, 108],
    params: { ...amp(0.001, 0.22, 0, 0.12), fold: 0.04 }, mods: {}, mix: { pan: -0.18, reverbSend: 0.3, delaySend: 0.04 } },
  marimba: { family: 'physical', section: 'mallets', base: 'Pebble Pluck', range: [45, 96],
    params: {}, mods: {}, mix: { pan: -0.1, reverbSend: 0.3, delaySend: 0.04 } },
  vibes: { family: 'fm', section: 'mallets', base: 'Lagoon EP', range: [53, 89],
    params: {}, mods: {}, mix: { pan: 0.2, reverbSend: 0.36, delaySend: 0.08 } },
  chimes: { family: 'fm', section: 'mallets', base: 'Meridian Bell', range: [60, 84],
    params: { polyMode: POLY }, mods: {}, mix: { pan: 0.3, reverbSend: 0.45, delaySend: 0.06 } },
  bell: { family: 'fm', section: 'mallets', base: 'Cirque Bell', range: [60, 108],
    params: {}, mods: {}, mix: { pan: 0.28, reverbSend: 0.45, delaySend: 0.1 } },
  // ---------------------------------------------------- tuned percussion
  timpani: { family: 'resonator', section: 'percussion', base: 'Basalt Bass', range: [38, 57],
    params: { polyMode: POLY, glide: 0, ...amp(0.002, 2.2, 0, 1.6), cutoff: 1400, filterEnv: 0.2, sub: 0.2,
      resoOn: 1, resoMix: 0.85, resoDecay: 2.4, resoTone: 0.32, resoSize: 1, resoListen: 0.2 },
    mods: {}, mix: { pan: -0.05, reverbSend: 0.36, delaySend: 0 } },
  gong: { family: 'fm', section: 'percussion', base: 'Caldera Gong', range: [24, 60],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.5, delaySend: 0.05 } },
  // ------------------------------------------------------ band and synths
  guitar: { family: 'physical', section: 'band', base: 'Gully Comb', range: [40, 88],
    params: {}, mods: {}, mix: { pan: -0.35, reverbSend: 0.2, delaySend: 0.06 } },
  bass: { family: 'terrain', section: 'band', base: 'Basalt Bass', range: [28, 60],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.04, delaySend: 0 } },
  rhodes: { family: 'fm', section: 'band', base: 'Lagoon EP', range: [36, 96],
    params: {}, mods: {}, mix: { pan: 0.12, reverbSend: 0.26, delaySend: 0.08 } },
  organ: { family: 'additive', section: 'band', base: 'Mesa Organ', range: [36, 96],
    params: {}, mods: {}, mix: { pan: -0.08, reverbSend: 0.24, delaySend: 0.03 } },
  clav: { family: 'subtractive', section: 'band', base: 'Atoll Clav', range: [36, 96],
    params: {}, mods: {}, mix: { pan: 0.22, reverbSend: 0.16, delaySend: 0.06 } },
  lead: { family: 'subtractive', section: 'synth', base: 'Ridgeline Lead', range: [55, 96],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.24, delaySend: 0.2 } },
  saw: { family: 'wavetable', section: 'synth', base: 'Summit Saw', range: [36, 96],
    params: { polyMode: POLY, glide: 0 }, mods: {}, mix: { pan: 0, reverbSend: 0.26, delaySend: 0.14 } },
  arp: { family: 'wavetable', section: 'synth', base: 'Survey Arp', range: [48, 96],
    params: {}, mods: {}, mix: { pan: -0.15, reverbSend: 0.22, delaySend: 0.18 } },
  sub: { family: 'wavetable', section: 'synth', base: 'Tar Pit Sub', range: [24, 55],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0, delaySend: 0 } },
  pad: { family: 'vector', section: 'synth', base: 'Aurora Plateau', range: [36, 96],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.5, delaySend: 0.1 } },
  cloud: { family: 'granular', section: 'synth', base: 'Monsoon Haze', range: [36, 96],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.5, delaySend: 0.12 } },
  // --------------------------------------------------------------- ambience
  // Air is the noise layer that follows the amp envelope. Size 0 stills the
  // orbit, so a texture voice is only its noise (rain, ocean, vinyl, city);
  // the note still sets the filter where Key Trk is on (wind whistles).
  rain: { family: 'noise', section: 'ambience', base: 'Rain Shadow', range: [36, 96],
    params: { air: 0.85, airType: 2, airTone: 0.35, size: 0.04, filterType: F.low, cutoff: 7500, resonance: 0.05, keyTrack: 0, ...amp(1.5, 1, 0.9, 3) },
    mods: {}, mix: { pan: 0, reverbSend: 0.35, delaySend: 0 } },
  wind: { family: 'noise', section: 'ambience', base: 'Wind Gap', range: [36, 96],
    params: { air: 0.5, airType: 2, airTone: -0.2 }, mods: {}, mix: { pan: 0, reverbSend: 0.55, delaySend: 0.05 } },
  ocean: { family: 'noise', section: 'ambience', base: 'Lowland Mist', range: [36, 96],
    params: { size: 0, air: 1, airType: 6, airTone: -0.1, filterType: F.low, cutoff: 3200, resonance: 0.05, keyTrack: 0, unison: 1, level: 1, ...amp(2, 1, 1, 4) },
    mods: {}, mix: { pan: 0, reverbSend: 0.3, delaySend: 0 } },
  vinyl: { family: 'noise', section: 'ambience', base: 'Lowland Mist', range: [36, 96],
    params: { size: 0, air: 1, airType: 5, airTone: 0, filterType: F.low, cutoff: 9000, resonance: 0, keyTrack: 0, unison: 1, level: 1, ...amp(0.05, 1, 1, 0.5) },
    mods: {}, mix: { pan: 0, reverbSend: 0, delaySend: 0 } },
  city: { family: 'noise', section: 'ambience', base: 'Lowland Mist', range: [36, 96],
    params: { size: 0, air: 1, airType: 7, airTone: 0, filterType: F.low, cutoff: 6000, resonance: 0, keyTrack: 0, unison: 1, level: 1, ...amp(1, 1, 1, 3) },
    mods: {}, mix: { pan: 0, reverbSend: 0.2, delaySend: 0 } },
  fire: { family: 'noise', section: 'ambience', base: 'Rain Shadow', range: [36, 96],
    params: { air: 0.6, airType: 4, airTone: -0.3, size: 0.06, filterType: F.low, cutoff: 2600, keyTrack: 0, ...amp(1, 1, 0.9, 2) },
    mods: { warp: lfo(0.35, 11, SH.sh) }, mix: { pan: 0, reverbSend: 0.2, delaySend: 0 } },
  thunder: { family: 'noise', section: 'ambience', base: 'Landslide', range: [24, 60],
    params: { air: 1, airType: 4, airTone: -0.6, filterType: F.low, cutoff: 800, keyTrack: 0, ...amp(0.05, 5, 0, 4) },
    mods: {}, mix: { pan: 0, reverbSend: 0.6, delaySend: 0 } },
  drone: { family: 'terrain', section: 'ambience', base: 'Bedrock Drone', range: [24, 72],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.5, delaySend: 0.05 } },
  night: { family: 'vector', section: 'ambience', base: 'Polar Night', range: [36, 84],
    params: { level: 0.8 }, mods: {}, mix: { pan: 0, reverbSend: 0.7, delaySend: 0.15 } },
  shimmer: { family: 'terrain', section: 'ambience', base: 'Salt Flat Shimmer', range: [60, 108],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.65, delaySend: 0.3 } },
  swirl: { family: 'granular', section: 'ambience', base: 'Dust Devil', range: [36, 96],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.45, delaySend: 0.25 } },
  chirp: { family: 'fm', section: 'ambience', base: 'Satellite Ping', range: [72, 108],
    params: { ...amp(0.002, 0.12, 0, 0.1), glide: 0.04 }, mods: {}, mix: { pan: 0.3, reverbSend: 0.4, delaySend: 0.2 } },
  // --------------------------------------------------------- cinematic FX
  riser: { family: 'granular', section: 'fx', base: 'Jetstream', range: [36, 84],
    params: { ...amp(1.8, 0.5, 1, 0.6) }, mods: {}, mix: { pan: 0, reverbSend: 0.45, delaySend: 0.15 } },
  impact: { family: 'physical', section: 'fx', base: 'Landslide', range: [24, 60],
    params: {}, mods: {}, mix: { pan: 0, reverbSend: 0.5, delaySend: 0.08 } },
});

/** The classic kit: pad index on the Kit track (MIDI 36 + pad), the default drum kit. */
export const KIT_PADS = Object.freeze({ kick: 0, snare: 1, hat: 2, openhat: 3, clap: 4, tom: 5, hitom: 6, rim: 7 });
export const KIT_VOICES = Object.freeze(Object.keys(KIT_PADS));

/**
 * More drum pieces (family 'perc'). Each is a sound from the 128-sound drum
 * library: kind and n pick the n-th library sound of that kind
 * (src/dsp/drum-library.js), then pitch (semitones), decay, level and pan
 * shape it. A score that uses them gets extra kit tracks, eight pieces to a
 * kit, built from the pieces it uses. fallback: the classic pad it borrows
 * when there is no room for another kit track. made: what it really is.
 */
export const PERC = Object.freeze({
  // cymbals
  crash: { kind: 'cymbal', n: 1, pitch: -2, decay: 1, level: 0.72, pan: 0.3, fallback: 4, made: 'a library cymbal, long' },
  crash2: { kind: 'cymbal', n: 4, pitch: 0, decay: 0.9, level: 0.7, pan: -0.32, fallback: 4, made: 'a second library cymbal' },
  splash: { kind: 'cymbal', n: 2, pitch: 7, decay: 0.35, level: 0.62, pan: -0.2, fallback: 4, made: 'a library cymbal, short and high' },
  china: { kind: 'cymbal', n: 3, pitch: -5, decay: 0.7, level: 0.72, pan: 0.4, fallback: 4, made: 'a library cymbal, low and trashy' },
  ride: { kind: 'cymbal', n: 2, pitch: 3, decay: 0.45, level: 0.6, pan: -0.3, fallback: 3, made: 'a library cymbal, short and higher' },
  ridebell: { kind: 'cymbal', n: 4, pitch: 10, decay: 0.3, level: 0.55, pan: -0.3, fallback: 3, made: 'a library cymbal, very short and high' },
  // kicks, snares and toms beyond the classic kit
  kick2: { kind: 'kick', n: 2, pitch: 0, decay: 0.7, level: 0.9, pan: 0, fallback: 0, made: 'a punchier library kick' },
  subkick: { kind: 'kick', n: 6, pitch: -7, decay: 1, level: 0.9, pan: 0, fallback: 0, made: 'a library kick tuned low with a long tail (808 style)' },
  snare2: { kind: 'snare', n: 3, pitch: 0, decay: 0.8, level: 0.8, pan: 0, fallback: 1, made: 'a tighter library snare' },
  rimshot: { kind: 'snare', n: 6, pitch: 2, decay: 0.6, level: 0.85, pan: 0, fallback: 1, made: 'a bright, cracking library snare' },
  snap: { kind: 'clap', n: 2, pitch: 5, decay: 0.4, level: 0.6, pan: 0.15, fallback: 4, made: 'a short library clap, pitched up' },
  pedalhat: { kind: 'hat', n: 2, pitch: 0, decay: 0.3, level: 0.45, pan: 0.25, fallback: 2, made: 'a soft, short library hat' },
  floortom: { kind: 'tom', n: 2, pitch: -5, decay: 1, level: 0.85, pan: 0.3, fallback: 5, made: 'a library tom tuned low' },
  midtom: { kind: 'tom', n: 4, pitch: 0, decay: 0.9, level: 0.82, pan: -0.05, fallback: 6, made: 'a library tom' },
  // hand percussion
  shaker: { kind: 'shaker', n: 1, pitch: 0, decay: 0.6, level: 0.6, pan: 0.4, fallback: 2, made: 'a library shaker' },
  tambourine: { kind: 'shaker', n: 2, pitch: 5, decay: 0.8, level: 0.62, pan: -0.4, fallback: 2, made: 'a bright library shaker' },
  cowbell: { kind: 'cowbell', n: 1, pitch: 0, decay: 0.7, level: 0.55, pan: 0.2, fallback: 7, made: 'a library cowbell' },
  agogo: { kind: 'cowbell', n: 3, pitch: 7, decay: 0.6, level: 0.5, pan: -0.25, fallback: 7, made: 'a library cowbell, higher' },
  conga: { kind: 'conga', n: 1, pitch: 0, decay: 0.8, level: 0.72, pan: 0.3, fallback: 6, made: 'a library conga' },
  tumba: { kind: 'conga', n: 2, pitch: -4, decay: 0.9, level: 0.72, pan: 0.38, fallback: 5, made: 'a library conga tuned low' },
  bongo: { kind: 'conga', n: 3, pitch: 7, decay: 0.5, level: 0.66, pan: -0.3, fallback: 6, made: 'a library conga tuned high and short' },
  timbale: { kind: 'tom', n: 6, pitch: 7, decay: 0.55, level: 0.7, pan: -0.35, fallback: 6, made: 'a library tom tuned high and short' },
  claves: { kind: 'block', n: 2, pitch: 7, decay: 0.4, level: 0.55, pan: 0.35, fallback: 7, made: 'a library wood block, higher' },
  block: { kind: 'block', n: 1, pitch: 0, decay: 0.6, level: 0.6, pan: 0.2, fallback: 7, made: 'a library wood block' },
  triangle: { kind: 'cymbal', n: 3, pitch: 12, decay: 0.7, level: 0.42, pan: 0.45, fallback: 7, made: 'a library cymbal an octave up. There is no triangle sample' },
  // orchestral and big drums
  taiko: { kind: 'kick', n: 4, pitch: -5, decay: 1, level: 0.5, pan: 0, fallback: 5, made: 'a library kick, tuned down and long' },
  bassdrum: { kind: 'kick', n: 9, pitch: -9, decay: 1, level: 0.85, pan: 0, fallback: 0, made: 'a library kick, tuned low for a concert bass drum' },
  // electronic
  zap: { kind: 'zap', n: 1, pitch: 0, decay: 0.6, level: 0.5, pan: 0, fallback: 7, made: 'a library laser zap' },
  burst: { kind: 'noise', n: 1, pitch: 0, decay: 0.6, level: 0.5, pan: 0, fallback: 4, made: 'a library noise burst' },
});
export const PERC_VOICES = Object.freeze(Object.keys(PERC));

/** The classic pad a drum piece borrows when there is no kit track for it. */
export const PERC_FALLBACK = Object.freeze(Object.fromEntries(Object.entries(PERC).map(([k, p]) => [k, p.fallback])));

let _library = null;
function libraryIndex(kind, n) {
  if (!_library) _library = libraryList();
  let seen = 0;
  for (const e of _library) {
    if (e.kind !== kind) continue;
    seen += 1;
    if (seen === n) return e.index;
  }
  return 0;
}

const padOf = (voice) => {
  const p = PERC[voice];
  return {
    name: voice[0].toUpperCase() + voice.slice(1),
    synth: libraryIndex(p.kind, p.n), sample: null,
    pitch: p.pitch, decay: p.decay, level: p.level, pan: p.pan, choke: 0,
  };
};

/**
 * Kits for the drum pieces a score uses (beyond the classic kit), eight to a
 * kit in the order of PERC. Returns { kits: [drum state], where: { voice: { kit, note } } }
 * with kit 1, 2, ... (kit 0 is the classic kit).
 */
export function percussionKits(voices) {
  const used = PERC_VOICES.filter((v) => voices.includes(v));
  const kits = [];
  const where = {};
  used.forEach((v, i) => {
    const k = Math.floor(i / 8), pad = i % 8;
    if (!kits[k]) kits[k] = { on: 1, pads: [] };
    kits[k].pads[pad] = padOf(v);
    where[v] = { kit: k + 1, note: KIT_BASE_NOTE + pad };
  });
  // fill unused pads with silent copies of the first, so a kit is always eight pads
  for (const kit of kits) for (let i = 0; i < 8; i++) if (!kit.pads[i]) kit.pads[i] = { ...kit.pads[0], name: '-', level: 0 };
  return { kits, where };
}

/** The Percussion kit with the first eight pieces (for a quick look in the app). */
export function percussionKit() {
  return percussionKits(PERC_VOICES.slice(0, 8)).kits[0];
}

const FACTORY = new Map(FACTORY_PATCHES.map((p) => [p.name, p]));

/**
 * A patch object for `voice` that partWithPatch() and the offline renderer
 * understand: { name, params, mods, links, dot }. null for an unknown voice.
 */
export function voicePatch(voice) {
  const v = PITCHED[voice];
  if (!v) return null;
  const base = FACTORY.get(v.base);
  if (!base) throw new Error(`orchestra: factory patch ${v.base} is missing`);
  const params = { ...(base.params || {}), ...v.params, octave: 0, tune: 0 };
  for (const [k, x] of Object.entries(v.mix || {})) params[k] = x;
  const mods = { ...(base.mods || {}) };
  for (const [k, m] of Object.entries(v.mods || {})) mods[k] = { ...(mods[k] || {}), ...m };
  return {
    name: `${voice[0].toUpperCase()}${voice.slice(1)} (score)`,
    category: 'Score',
    params,
    mods,
    links: base.links ? base.links.map((l) => ({ ...l })) : undefined,
    // A score voice keeps its dot where it is put: no drifting between takes.
    dot: { mode: 0 },
  };
}

/** For oro.schema(): every voice with its family, section and range. */
export function orchestraTable() {
  const out = {};
  for (const [name, v] of Object.entries(PITCHED)) {
    out[name] = { family: v.family, section: v.section, from: v.base, range: v.range };
  }
  for (const name of KIT_VOICES) out[name] = { family: 'drum', section: 'kit', from: `Kit pad ${KIT_PADS[name] + 1}`, range: null };
  for (const [name, p] of Object.entries(PERC)) out[name] = { family: 'perc', section: 'drums', from: p.made, range: null };
  return out;
}
