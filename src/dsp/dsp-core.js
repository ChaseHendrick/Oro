// Oro's audio engine: up to MAX_PARTS parts (tracks) x 8 voices of wave
// terrain synthesis. All MAX_PARTS parts exist from the start; the host says
// how many are in use ({t:'tracks', count, perm?, fresh?}, see setTracks) and
// the rest cost nothing: a part past the count that has finished fading out
// is skipped before any work is done on it.
//
// Pure computation, no Web Audio dependency: the same class runs inside the
// AudioWorklet (worklet.js), inside a ScriptProcessorNode fallback, and in
// Node tests. process() never allocates (telemetry objects excepted, ~60/s).
//
// Signal flow per voice (at the oversampled rate, 2x in the standard quality):
//   unison cycle phases -> Pace (phase distortion) -> Laps (path phase, hard
//   sync restart) -> Direction (ping-pong) -> Travel (even arc-length speed)
//   -> path (pathBlock / pathBlockAt) -> transform (size, stretch, rotate +
//   spin, centre) -> warp -> trilinear terrain lookup (mip level from
//   traversal speed), A/B morph -> Lift/Fold shaper -> polyBLEP at sync
//   restarts -> DC blocker -> + sub sine + Air noise -> drive -> filter (state
//   variable, comb or vowel) -> amp envelope -> pan
// In the Pristine quality a voice whose orbit is not being modulated fast
// instead plays a band-limited single cycle of exactly that signal (sampled,
// FFT brick-walled at Nyquist, refreshed every ~256 samples with a crossfade).
// Voices of a part are summed at the oversampled rate, then half-band FIR
// stages decimate the part to the host rate before level, mute/solo and sends.
//
// Control rate: every CTRL samples each part advances its LFOs, each voice its
// Envelope 2 / glide, re-evaluates modulation (LFO, Env 2, Links) in
// normalised space, smooths the targets with a one-pole and sets per-sample
// linear ramps for everything that could zipper. Events (notes and timed
// parameter changes) split the block at their exact sample.
//
// v2.8: the summed post-fader Send A / Send B of every part feed two shared
// return buses (send-fx.js) that run once per render call and add into the
// dry mix; they never run while every send is 0 and the buses are silent. A
// frozen part ({t:'freeze'}) plays a pre-rendered loop of its own output
// (after its track effects, before the fader) in step with the transport
// instead of running its voices; {t:'capture'} renders that output alone.
//
// With every Round D control at its default (Natural, Forward, no Air, no
// Key>Size, a state variable filter, the default Links, standard quality) the
// engine takes exactly the code paths it had before those controls existed and
// is bit-identical to it (tests/dsp/fixtures).

import {
  PART_PARAMS, PART_PARAM_INDEX, PART_PARAM_MAP, MOD_PARAM_IDS, MOD_DEFAULT,
  MAX_PARTS, DEFAULT_PARTS, VOICES_PER_PART, SYNC_DIVS, LFO_STEP_COUNT, DEFAULT_LFO_STEPS,
  LINK_SOURCES, LINK_CURVES, MAX_LINKS, defaultLinks, toNorm, fromNorm,
} from '../core/params.js';
import {
  pathBlock, pathBlockAt, pathPoint, pathLength, paceWarp, paceBlock,
  travelBlock, prepareEven, evenPhase, pingPong, shapePathPoint,
} from './paths.js';
import { fastSin, fastCos, mulberry32 } from './terrain-math.js';
const STREAM_SEEDS = { rng: 0x6f726f67, extensionRng: 0x82edfe, unisonRng: 0x5e1f22, linkRng: 0x11c5 };
import { generateTerrain, buildMipChain } from './terrains.js';
import { subWave, PROFILE_PARTIALS, profileRatio, ColourNoise, noiseTextures, fadeLoop, loopSample, KarplusStrong } from './oscillator-extras.js';
import { AnalogFilter } from './analog-filters.js';
import { SixStageEnvelope, skewLfoPhase, steppedLfo } from './modulation-extras.js';
import { TrackEffects } from './track-effects.js';
import { ScienceBank } from './science-sources.js';
import { WeatherBank } from './weather-sources.js';
import { PadBank } from './pad-sources.js';
import { Filter2 } from './filter2.js';
import { KitPlayer } from './drum-kit.js';
import { SamplerPlayer } from './sampler.js';
import { renderLibraryDrum } from './drum-library.js';
import { funcValue, sanitizeFuncPoints, FUNC_MAX_POINTS } from './function-gen.js';
import { UNISON_STACKS } from '../core/params.js';
import { MAX_NOISE_SECONDS } from './noise-recording.js';
import { SendReturns, SEND_GLOBAL_IDS } from './send-fx.js';
import { MasterOperator, OPERATOR_ACTIONS } from './damage.js';
import { Resonator } from './resonator.js';
import { ResoGpuLink } from './reso-feed.js';
import { Binaural, SURROUND_LAYOUTS, dotToSpace, radiusToDistance } from './spatial.js';

export const OVERSAMPLE = 2;            // oversampling of the standard quality
export const CTRL = 32;                 // control block, host-rate samples
const MAX_OS = 4;                       // the High quality renders voices at 4x
const MAX_UNISON = 16;
const VOICE_GAIN = 0.5;                 // headroom: a full-scale voice sits at -6 dBFS
const SMOOTH_TIME = 0.004;              // one-pole smoothing of control targets (s)
const TERRAIN_FADE_TIME = 0.03;         // crossfade when a new terrain table arrives (s)
const STEAL_FADE_TIME = 0.003;          // fade-out of a stolen voice (s)
const ATTACK_OVERSHOOT = 1.2;           // analog-style attack aims past 1 and stops at 1
const ENV_FLOOR = 0.001;                // -60 dB: where decay/release times are measured
const OUT_LIMIT = 4;
const SUB_GAIN = 0.8;                   // Sub at 1: a sine 2 dB under a full-scale voice
// Snap distance for the Laps / Pace / Sub one-poles, so they land exactly on
// their targets (and Laps 1 / Pace 0 get back onto the fast path).
const SNAP = 1e-5;
const QUALITY_FADE = 0.012;             // crossfade when the quality changes rate or mips (s)
const FILTER_FADE = 0.008;              // crossfade when the filter type changes (s)
const TRACK_FADE_TIME = 0.08;           // fade-out of a track removed from the list (s)
const FREEZE_FADE_TIME = 0.015;         // crossfade between a part's voices and its frozen loop (s)
const FREEZE_GATE_TIME = 0.03;          // frozen loop fade when the transport stops or starts (s)
const TRAVEL_FADE = 0.012;              // crossfade when Direction / Travel change (s)
const TABLE_FADE = 0.006;               // Pristine: table <-> direct rendering crossfade (s)
const TABLE_DRIFT = 0.01;               // Pristine: orbit travel (knob units) that earns a new table
// Pristine: table points built per control block at most, so a low chord
// starting at once spreads its builds over a few blocks instead of spiking
const TABLE_BUDGET = 4096;
const STEP_SLEW = 0.002;                // Steps LFO: glide between steps (s)
const PRESS_TIME = 0.008;               // smoothing of pressure / slide (MIDI steps) (s)
const MARBLE_TIME = 0.03;               // smoothing of the ~30 Hz marble physics (s)
const AIR_RMS = 0.3;                    // Air at 1: noise RMS in the audible band
const AIR_PIVOT = 1200;                 // Air Tone tilt pivot (Hz)
const COMB_FMIN = 30;                   // lowest comb frequency (Hz): sizes the delay lines
// Pedal latency compensation (v1.1): the longest dry delay a Send mode part
// can get, in seconds (src/pedals/latency-comp.js MAX_COMP_MS).
export const MAX_DRY_DELAY_SEC = 0.5;
const ECO_DELAY = 15;                   // Eco: host samples of delay = the half-band's latency

const IDLE = 0, ATTACK = 1, DECAY = 2, RELEASE = 3;

const NMOD = MOD_PARAM_IDS.length;
const MOD_DEFS = MOD_PARAM_IDS.map(id => PART_PARAM_MAP[id]);
const MOD_PARAM_OFFSETS=new Uint16Array(MOD_PARAM_IDS.map(id => PART_PARAM_INDEX[id]));
const MOD_SLOT = Object.fromEntries(MOD_PARAM_IDS.map((id, i) => [id, i]));
const MOD_WRAPS = new Uint8Array(MOD_PARAM_IDS.map(id => (id === 'rotate' || id === 'centerX' || id === 'centerY') ? 1 : 0));
const M_MORPH = MOD_SLOT.morph, M_WARP = MOD_SLOT.warp, M_LIFT = MOD_SLOT.lift, M_FOLD = MOD_SLOT.fold;
const M_PARAM = MOD_SLOT.pathParam, M_SIZE = MOD_SLOT.size, M_STRETCH = MOD_SLOT.stretch;
const M_SMP_SPEED = MOD_SLOT.smpSpeed, M_SMP_START = MOD_SLOT.smpStart, M_SMP_END = MOD_SLOT.smpEnd, M_SMP_POS = MOD_SLOT.smpPos;
const M_ROTATE = MOD_SLOT.rotate, M_CX = MOD_SLOT.centerX, M_CY = MOD_SLOT.centerY, M_FINE = MOD_SLOT.fine;
const M_CUTOFF = MOD_SLOT.cutoff, M_RES = MOD_SLOT.resonance, M_DRIVE = MOD_SLOT.drive, M_PAN = MOD_SLOT.pan;
const M_LAPS = MOD_SLOT.laps, M_PACE = MOD_SLOT.pace, M_FORMANT = MOD_SLOT.formant;
// Cache registry offsets outside the voice control loop. Node 22 repeatedly
// deoptimizes generic named loads on this registry inside the large hot method.
const M_GLIDE=MOD_SLOT.glide, M_SUB=MOD_SLOT.sub, M_AIR=MOD_SLOT.air;
const M_PHASE_MOD=MOD_SLOT.phaseMod, M_PHASE_RATIO=MOD_SLOT.phaseRatio;
const M_PATH_MANGLE=MOD_SLOT.pathMangle, M_PATH_WINDOW=MOD_SLOT.pathWindow;
const M_KEY_TRACK=MOD_SLOT.keyTrack, M_FILTER_ENV=MOD_SLOT.filterEnv;
const M_DETUNE=MOD_SLOT.detune, M_SPREAD=MOD_SLOT.spread, M_VEL_SENS=MOD_SLOT.velSens;
const M_F2CUT=MOD_SLOT.filter2Cutoff, M_F2RES=MOD_SLOT.filter2Reso, M_F2ENV=MOD_SLOT.filter2Env, M_F2MIX=MOD_SLOT.filter2Mix;
const M_UBLEND=MOD_SLOT.unisonBlend, M_UMAP=MOD_SLOT.unisonMap;
const MAP_SPREAD_TILES = 0.25;          // Map spread at 100%: copies sit this far (in tiles) from the dot
const SIZE_DEF = PART_PARAM_MAP.size;
const EXTRA_IDS = ['sub2','airTexture','inharmProfile','inharmAmount','phaseMod','phaseRatio','ringMod','ringRatio','pluck','pluckDecay','pluckTone','pluckDispersion','pathWindow','pathMangle','warpAmount'];
const EXTRA_SLOTS = EXTRA_IDS.map(id => MOD_SLOT[id]);
const EX = Object.fromEntries(EXTRA_IDS.map((id,i) => [id,i]));
const NEX = EXTRA_IDS.length;
const LEGACY_MOD_IDS = ['morph','warp','lift','fold','pathParam','size','stretch','rotate','centerX','centerY','fine','cutoff','resonance','drive','pan','laps','pace','formant'];
const LEGACY_MOD_MASK=new Uint8Array(MOD_PARAM_IDS.map(id => LEGACY_MOD_IDS.includes(id) ? 1 : 0));
const NEW_MOD_FIELDS = ['lfoSkew','lfoDelay','lfoAttack','lfoPhase','lfoCount','stepGlide','stepSmooth','envOwn'];
const ENV_IDS = ['envDelay','envAttack','envHold','envDecay','envSustain','envRelease','envMode'];
// Modulation slots that shape the orbit (Pristine falls back to direct
// rendering while any of them is pushed around by Env 2 or a per-voice Link).
const ORBIT_SLOTS = [M_MORPH, M_WARP, M_LIFT, M_FOLD, M_PARAM, M_SIZE, M_STRETCH, M_ROTATE, M_CX, M_CY, M_LAPS, M_PACE, MOD_SLOT.pathWindow, MOD_SLOT.pathMangle, MOD_SLOT.phaseMod];
// Slots whose per-voice modulation (Env 2, per-voice Links) moves the mean
// height of the cycle fast enough for the DC blocker to let a thump through:
// such voices track the mean and remove it (see orbitMeanEnd). Shape and
// Rotate are left out: they move the mean little and slowly.
const MEAN_SLOTS = [M_SIZE, M_STRETCH, M_CX, M_CY, M_MORPH, M_WARP, M_LIFT, M_FOLD, M_LAPS, M_PACE, MOD_SLOT.pathWindow, MOD_SLOT.pathMangle];

const PI = PART_PARAM_INDEX;
const NPARAMS = PART_PARAMS.length;
// Parameters that glide (timed ramps): continuous curves only; ints, enums
// and switches jump at the scheduled sample.
const RAMPABLE = new Uint8Array(PART_PARAMS.map(d => (d.curve === 'int' || d.curve === 'enum' || d.curve === 'bool') ? 0 : 1));
const WRAP_RANGE = new Float64Array(PART_PARAMS.map(d => (d.id === 'rotate' ? 360 : (d.id === 'centerX' || d.id === 'centerY') ? 1 : 0)));

// Link sources (indices into LINK_SOURCES) and which of them are one value
// for the whole part (folded into the part's shared modulation, so they also
// show in idle telemetry) rather than per voice.
const L_VEL = 0, L_WHEEL = 1, L_PRESS = 2, L_KEY = 3, L_SLIDE = 4, L_MACRO = 5,
  L_MSPEED = 9, L_MHEIGHT = 10, L_ENV1 = 11, L_ENV2 = 12, L_RAND = 13, L_TERRAIN = 14, L_GUITAR = 15, L_VOICE = 16, L_EXPRESSION = 17, L_SUSTAIN = 18, L_BREATH = 19,
  L_SCIENCE = 20, L_SCIENCE_END = 26, L_SWIRLX = 27, L_SWIRLY = 28,
  L_TURING = 29, L_FUNC = 30, L_WEATHER = 31, L_WEATHER_END = 34, L_PAD = 35, L_PAD_END = 36;   // v2.4: Turing (global, ScienceBank.out[7]) and the track's Function (per voice)   // v2.1: Neuron..Collapse (ScienceBank.out order), then per-voice Swirl
const NSRC = LINK_SOURCES.length;
const PART_SOURCE = new Uint8Array(NSRC);
for (const s of [L_WHEEL, L_MACRO, L_MACRO + 1, L_MACRO + 2, L_MACRO + 3, L_MSPEED, L_MHEIGHT, L_GUITAR, L_VOICE, L_EXPRESSION, L_SUSTAIN, L_BREATH]) if (s < NSRC) PART_SOURCE[s] = 1;
for (let s = L_SCIENCE; s <= L_SCIENCE_END && s < NSRC; s++) PART_SOURCE[s] = 1;
if (L_TURING < NSRC) PART_SOURCE[L_TURING] = 1;
for (let s = L_WEATHER; s <= L_WEATHER_END && s < NSRC; s++) PART_SOURCE[s] = 1;   // v2.10 live weather (global)
for (let s = L_PAD; s <= L_PAD_END && s < NSRC; s++) PART_SOURCE[s] = 1;   // v2.11 game controller right stick (global)
const SCI_TURING = 7;
const SCIENCE_KEYS = { sciNeuronCurrent: 'neuronCurrent', sciNeuronKick: 'neuronKick', sciNeuronTemp: 'neuronTemp', sciNeuronRate: 'neuronRate',
  sciLorenzRate: 'lorenzRate', sciPendEnergy: 'pendEnergy', sciPendRate: 'pendRate', sciSmoothTime: 'smoothTime', sciSmoothness: 'smoothness',
  sciCollapseShape: 'collapseShape', sciCollapseBars: 'collapseBars', sciCollapseDir: 'collapseDir',
  sciTuringChance: 'turingChance', sciTuringLength: 'turingLength', sciTuringDiv: 'turingDiv' };
const NCURVES = LINK_CURVES.length;
const DEFAULT_LINKS = defaultLinks();

// Quality modes (ui.audioQuality). os: oversampling factor; mipShift: octaves
// added to the mip level choice. Eco renders at the host rate, where the same
// mip formula already lands one octave higher (the contract's "mip bias +1");
// High renders at 4x and shifts back so it reads the same tables as Standard;
// Raw turns mips off. Pristine is Standard plus band-limited single cycles.
export const QUALITY_MODES = ['eco', 'standard', 'high', 'pristine', 'raw'];
const QUALITY = {
  eco: { os: 1, mipShift: 0, pristine: false },
  standard: { os: 2, mipShift: 0, pristine: false },
  high: { os: 4, mipShift: 1, pristine: false },
  pristine: { os: 2, mipShift: 0, pristine: true },
  raw: { os: 2, mipShift: -100, pristine: false },
};

// Hard-sync restarts recorded per segment: at most one per oscillator per
// sample (the increment is capped at 0.45) plus one look-ahead each.
const MAX_SYNC_EVENTS = MAX_UNISON * (MAX_OS * CTRL + 1);

// log2 of a Pace speed factor (0.1 .. 6.3) for the per-sample mip level: a
// table read instead of a Math.log2 call per oscillator sample. Linear
// interpolation is within 0.002 octave over that range, far below what a mip
// crossfade can resolve.
const LOG2_RES = 128, LOG2_TOP = 8 * LOG2_RES;
const LOG2_T = new Float64Array(LOG2_TOP + 2);
for (let i = 0; i < LOG2_T.length; i++) LOG2_T[i] = Math.log2(Math.max(i, 1) / LOG2_RES);
function speedLog2(x) {
  let f = x * LOG2_RES;
  if (f > LOG2_TOP) f = LOG2_TOP;
  const i = f | 0;
  return LOG2_T[i] + (f - i) * (LOG2_T[i + 1] - LOG2_T[i]);
}

// --- half-band decimators ----------------------------------------------------
// Kaiser windowed sinc at a quarter of the input rate: only odd offsets from
// the centre are non-zero, so the filter is a few symmetric pairs plus the
// centre.
function kaiserHalfband(N, beta) {
  const M = (N - 1) >> 1;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; };
  const h = new Float64Array(N);
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const k = n - M;
    const sinc = k === 0 ? 0.5 : Math.sin(Math.PI * k / 2) / (Math.PI * k);
    const r = k / M;
    h[n] = (k !== 0 && (k & 1) === 0) ? 0 : sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
    sum += h[n];
  }
  for (let n = 0; n < N; n++) h[n] /= sum;
  return h;
}
// 2x -> 1x: 63 taps, beta 7.4. Passband is flat to 0.2 fs2 (19.2 kHz at
// 48 kHz) and the stopband from 0.29 fs2 is below -70 dB, so nothing that
// would fold to below ~20 kHz survives the decimation.
const HB_N = 63;
const HB_M = (HB_N - 1) >> 1;
const HB_HIST = HB_N - 1;
export const HALFBAND = kaiserHalfband(HB_N, 7.4);
const HB_PAIRS = (HB_M + 1) >> 1;
const HB_C = new Float64Array(HB_PAIRS);   // coefficient for offsets ±1, ±3, ...
for (let i = 0; i < HB_PAIRS; i++) HB_C[i] = HALFBAND[HB_M + 2 * i + 1];
const HB_CENTER = HALFBAND[HB_M];
// 4x -> 2x (High quality): only what would fold into the final 0..0.58 fs
// band must go, so the transition band is wide (0.105 .. 0.355 of the 4x
// rate) and 27 taps reach -80 dB.
const HB1_N = 27;
const HB1_M = (HB1_N - 1) >> 1;
const HB1_HIST = HB1_N - 1;
export const HALFBAND_4X = kaiserHalfband(HB1_N, 8);
const HB1_PAIRS = (HB1_M + 1) >> 1;
const HB1_C = new Float64Array(HB1_PAIRS);
for (let i = 0; i < HB1_PAIRS; i++) HB1_C[i] = HALFBAND_4X[HB1_M + 2 * i + 1];
const HB1_CENTER = HALFBAND_4X[HB1_M];

// --- default terrain -------------------------------------------------------
// A built-in Swell so a part is never silent while its terrain message is in
// flight. Generated once per realm at 512, shared by every part.
let DEFAULT_CHAIN = null;
function defaultChain() {
  if (!DEFAULT_CHAIN) DEFAULT_CHAIN = buildMipChain(generateTerrain(0, { size: 512, seed: 7, detail: 0.5 }), 512, MIN_MIP);
  return DEFAULT_CHAIN;
}

// The host sends chains down to 32 x 32. A high note with a big orbit can
// still outrun a 32 table, so the engine extends every chain to 4 x 4 (a few
// hundred multiplies, done when the message arrives, never in process()).
const MIN_MIP = 4;
function extendChain(chain) {
  const last = chain[chain.length - 1];
  if (last.size <= MIN_MIP) return chain;
  const more = buildMipChain(last.data, last.size, MIN_MIP);
  for (let i = 1; i < more.length; i++) chain.push(more[i]);
  return chain;
}

function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

/** Bilinear wrap lookup on a power-of-two table (m = size - 1). Small enough for V8 to inline. */
function bil(d, s, m, u, v) {
  const x = u * s, y = v * s;
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  const x0 = xf & m, y0 = yf & m;
  const x1 = (x0 + 1) & m;
  const r0 = y0 * s, r1 = ((y0 + 1) & m) * s;
  const a = d[r0 + x0], b = d[r1 + x0];
  const top = a + fx * (d[r0 + x1] - a);
  const bot = b + fx * (d[r1 + x1] - b);
  return top + fy * (bot - top);
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clampPM1(x) { return x < -1 ? -1 : x > 1 ? 1 : x; }
function wrapHalf(d) { return d - Math.floor(d + 0.5); }

/** Link curves: 0 Linear y = x, 1 Soft sign(x) x^2, 2 Hard sign(x) |x|^0.5. */
function linkCurve(c, x) {
  if (c === 1) return x < 0 ? -x * x : x * x;
  if (c === 2) return x < 0 ? -Math.sqrt(-x) : Math.sqrt(x);
  return x;
}

// --- vowel formants ----------------------------------------------------------
// Oro's own vowel set, A E I O U at formant 0, 0.25, 0.5, 0.75, 1:
// three resonances each (Hz), their bandwidths (Hz) and levels (dB). Values
// were set by ear on terrain tones, starting from the broad ranges acoustic
// phonetics gives for an adult voice and leaning towards a clear, slightly
// bright singing vowel (F2/F3 a little higher, bandwidths a little narrower
// than speech) so the vowels stay distinct even on dark terrains.
// trim: per-vowel makeup (dB) measured on terrain tones (whose spectra fall
// with frequency, so a vowel with a high first formant catches less energy),
// which keeps a Vowel sweep at a steady loudness, near the Low filter's.
const VOWELS = [
  { f: [780, 1240, 2620], bw: [95, 115, 165], db: [0, -4, -15], trim: 8 },    // A  (father)
  { f: [470, 1960, 2700], bw: [75, 105, 170], db: [0, -8, -13], trim: 5.5 },  // E  (bed / say)
  { f: [300, 2280, 3080], bw: [55, 110, 175], db: [0, -13, -16], trim: 3.5 }, // I  (see)
  { f: [510, 860, 2540], bw: [80, 90, 160], db: [0, -5, -19], trim: 5 },      // O  (go)
  { f: [340, 760, 2380], bw: [65, 80, 150], db: [0, -10, -24], trim: 0 },     // U  (boot)
];
const VOWEL_LOGF = VOWELS.map(v => v.f.map(Math.log2));
const VOWEL_AMP = VOWELS.map(v => v.db.map(d => Math.pow(10, (d + v.trim) / 20)));
const VOWEL_GAIN = 2.0;                 // makeup: keeps Vowel near the level of the Low filter

// --- FFT (Pristine) ----------------------------------------------------------
// In-place iterative radix-2 complex FFT up to 4096 points, twiddles from one
// shared table (stride per size), bit-reversal permutations cached per size,
// and the real-signal pair (realForward / realInverse) that runs an N-point
// real transform as an N/2-point complex one. No allocation after the first
// use of each size.
const TAB_MAX = 4096;
class FFT {
  constructor(maxN) {
    this.maxN = maxN;
    this.cs = new Float64Array(maxN >> 1);
    this.sn = new Float64Array(maxN >> 1);
    for (let i = 0; i < maxN >> 1; i++) { this.cs[i] = Math.cos(2 * Math.PI * i / maxN); this.sn[i] = Math.sin(2 * Math.PI * i / maxN); }
    this.rev = new Map();
    for (let n = 2; n <= maxN; n <<= 1) {
      const r = new Uint16Array(n);
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        r[i] = j;
      }
      this.rev.set(n, r);
    }
  }

  run(re, im, n, inverse) {
    const rv = this.rev.get(n);
    for (let i = 1; i < n; i++) {
      const j = rv[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const cs = this.cs, sn = this.sn, sgn = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = this.maxN / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cs[k * step], wi = sgn * sn[k * step];
          const a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  /**
   * Spectrum of the real signal x[0..n) in bins 0..n/2 (re[k], im[k]),
   * through an n/2-point complex FFT of z[m] = x[2m] + i x[2m+1]. zr/zi:
   * n/2 scratch. x may alias re.
   */
  realForward(x, n, re, im, zr, zi) {
    const h = n >> 1;
    for (let m = 0; m < h; m++) { zr[m] = x[2 * m]; zi[m] = x[2 * m + 1]; }
    this.run(zr, zi, h, false);
    const step = this.maxN / n, cs = this.cs, sn = this.sn;
    for (let k = 0; k <= h; k++) {
      const a = k === h ? 0 : k, b = k === 0 ? 0 : h - k;
      // even part E = (Z[k] + conj Z[h-k]) / 2, odd part O = (Z[k] - conj Z[h-k]) / 2i
      const er = 0.5 * (zr[a] + zr[b]), ei = 0.5 * (zi[a] - zi[b]);
      const or = 0.5 * (zi[a] + zi[b]), oi = -0.5 * (zr[a] - zr[b]);
      // X[k] = E + W^k O, W = e^{-2 pi i / n}
      const c = k < n / 2 ? cs[k * step] : -1, s = k < n / 2 ? -sn[k * step] : 0;
      re[k] = er + (or * c - oi * s);
      im[k] = ei + (or * s + oi * c);
    }
  }

  /** Inverse of realForward: bins 0..n/2 (Hermitian spectrum) to the real x[0..n), unscaled (n x). */
  realInverse(re, im, n, x, zr, zi) {
    const h = n >> 1;
    const step = this.maxN / n, cs = this.cs, sn = this.sn;
    for (let k = 0; k < h; k++) {
      const b = h - k;
      // E = (X[k] + conj X[h-k]) / 2, O = (X[k] - conj X[h-k]) W^-k / 2, Z = E + i O
      const er = 0.5 * (re[k] + re[b]), ei = 0.5 * (im[k] - im[b]);
      const dr = 0.5 * (re[k] - re[b]), di = 0.5 * (im[k] + im[b]);
      const c = cs[k * step], s = sn[k * step];
      const or = dr * c - di * s, oi = dr * s + di * c;
      zr[k] = er - oi; zi[k] = ei + or;
    }
    this.run(zr, zi, h, true);
    for (let m = 0; m < h; m++) { x[2 * m] = 2 * zr[m]; x[2 * m + 1] = 2 * zi[m]; }
  }
}

// --- unison layout (v2.2) ---------------------------------------------------

/**
 * Detune ratio, stereo gains and map offsets of a part's U unison copies.
 * Spread modes move the detune positions (Linear as before, Super bunches
 * them at the centre, Exp pushes them out; Random keeps Linear gains and
 * takes per-note positions in the voice). Stack transposes copies, Blend
 * sets the outer copies' level against the centre one, and the gains keep
 * the total power. With the defaults (Linear, no stack, Blend 1) this is
 * exactly the layout before v2.2.
 */
function unisonLayout(P, U, detune, spread, blend) {
  const semisList = UNISON_STACKS[P.uniStack].semis, ns = semisList.length;
  let c0 = -1, c1 = -1;                   // centre copies (one for odd U, two for even)
  if (U > 1) { if (U & 1) c0 = (U - 1) >> 1; else { c0 = U / 2 - 1; c1 = U / 2; } }
  let sumW = 0;
  for (let q = 0; q < MAX_UNISON; q++) {
    let pos = U === 1 ? 0 : q / (U - 1) * 2 - 1;
    if (P.uniMode === 1) pos = pos < 0 ? -pos * pos : pos * pos;
    else if (P.uniMode === 2) pos = pos < 0 ? -Math.sqrt(-pos) : Math.sqrt(pos);
    const centre = U === 1 || q === c0 || q === c1;
    const semis = centre || ns === 1 ? 0 : semisList[q % ns];
    P.stackRatio[q] = semis === 0 ? 1 : Math.pow(2, semis / 12);
    P.detRatio[q] = Math.pow(2, pos * detune * 0.5 / 1200 + semis / 12);
    P.uPos[q] = pos;
    const w = centre ? 1 : blend;
    P.uW[q] = w;
    if (q < U) sumW += w * w;
    // Map spread: copies on a circle around the dot (golden-angle steps), the centre copy on the dot
    const ang = q * 2.399963229728653;
    P.uMapX[q] = centre && (U & 1) ? 0 : Math.cos(ang);
    P.uMapY[q] = centre && (U & 1) ? 0 : Math.sin(ang);
  }
  for (let q = 0; q < MAX_UNISON; q++) {
    if (U === 1) { P.gUL[q] = 1; P.gUR[q] = 1; continue; }
    const angle = (P.uPos[q] * spread + 1) * Math.PI / 4;
    const norm = Math.SQRT2 / Math.sqrt(sumW > 0 ? sumW : 1) * P.uW[q];
    P.gUL[q] = Math.cos(angle) * norm;
    P.gUR[q] = Math.sin(angle) * norm;
  }
}

// --- voice -----------------------------------------------------------------

class Voice {
  constructor(index, sr = 48000, os = OVERSAMPLE) {
    this.index = index;
    this.active = false;
    this.gate = false;
    this.hz = 0;                        // the note's frequency at the last control update (2.10 Resonator)
    this.note = 60;
    this.vel = 0.8;
    this.velGain = 1;
    this.order = 0;            // start counter, for stealing and telemetry
    this.pitch = 60;           // current (gliding) note, without fine/bend
    this.uniPrev = 0;

    this.phase = new Float64Array(MAX_UNISON);   // cycle phase φ per unison oscillator
    this.inc = new Float64Array(MAX_UNISON);
    this.dinc = new Float64Array(MAX_UNISON);
    // unison as this voice renders it: oscillators running (a removed one
    // keeps running while it fades out), their gains (ramped per sample while
    // Unison or Width change) and whether the voice is stereo (latched: once a
    // voice has a right channel it keeps it, so R never jumps back onto L)
    this.uRun = 1; this.stereo = false; this.gRamp = false;
    this.ugL = new Float64Array(MAX_UNISON); this.ugR = new Float64Array(MAX_UNISON);
    this.dugL = new Float64Array(MAX_UNISON); this.dugR = new Float64Array(MAX_UNISON);
    // mean height of the cycle, tracked and removed before the DC blocker
    // when the orbit is modulated per voice (ramped per sample)
    this.mTrack = false; this.mCur = 0; this.dMean = 0;

    this.envStage = IDLE; this.envLvl = 0;
    this.env2Stage = IDLE; this.env2Lvl = 0;
    this.ampExtra = new SixStageEnvelope(); this.env2Extra = new SixStageEnvelope();
    this.ampCustom = false; this.env2Custom = false;
    this.ownEnvs = Array.from({length:NMOD}, () => new SixStageEnvelope());
    this.ex = new Float64Array(NEX); this.exTarget = new Float64Array(NEX); this.dex = new Float64Array(NEX);
    this.partialPhase = new Float64Array(PROFILE_PARTIALS); this.partialInc = new Float64Array(PROFILE_PARTIALS); this.partialGain = new Float64Array(PROFILE_PARTIALS);
    this.ringPh = 0; this.ringInc = 0; this.pmPh = 0; this.pmInc = 0; this.sub2Ph = 0;
    this.texturePos = 0; this.extraAir = 0; this.dExtraAir = 0; this.airKind = 0; this.subKind = 0; this.sub2Kind = 0; this.pathMirror = 0;
    this.colourL = new ColourNoise(sr * os); this.colourR = new ColourNoise(sr * os, 7);
    this.string = new KarplusStrong(sr * os, 8, sr * MAX_OS); this.stringOn = false;
    this.analog = [new AnalogFilter(), new AnalogFilter()]; this.analogCurrent = 0;
    this.renderRate = sr * os;
    // v2.2: Filter 2 (with its mix ramp), Map spread (ramped) and Random unison positions
    this.f2 = new Filter2(); this.f2On = false; this.f2Mix = 1; this.df2Mix = 0;
    this.ms = 0; this.dms = 0;
    this.uPos = new Float64Array(MAX_UNISON);
    this.fnPh = 0;            // v2.4 Function phase

    // pending note when this voice is being stolen
    this.stealFade = 0; this.stealStep = 0; this.stealGain = 1;
    this.pending = false; this.pendNote = 60; this.pendVel = 0;

    // modulated values (normalised + plain)
    this.modNorm = new Float64Array(NMOD);
    this.modPlain = new Float64Array(NMOD);

    // Link sources that belong to the note: random per note, per-note
    // pressure and slide (targets and their smoothed values), and the terrain
    // height under this voice's modulated dot (from the previous block)
    this.rand = 0; this.press = 0; this.slide = 0; this.sPress = 0; this.sSlide = 0;
    this.terrH = 0;

    // one-pole smoothed control state
    this.sSize = 0.2; this.sStretch = 0; this.sRot = 0; this.sCx = 0.5; this.sCy = 0.5;
    this.sMorph = 0; this.sWarp = 0; this.sLift = 1; this.sFold = 0; this.sParam = 0.5;
    this.sCut = 13; this.sRes = 0.1; this.sDrive = 0; this.sPan = 0;
    this.sLvA = 0; this.sLvB = 0;
    this.uLvA = 0; this.uLvB = 0;           // unclamped mip levels (per-sample Pace mips add to these)
    this.sLaps = 1; this.sPace = 0; this.sSub = 0;
    this.sFormant = 0.5; this.sAir = 0; this.sTone = 0;

    // per-sample ramps (current value + increment per oversampled sample)
    this.tA = 0; this.dtA = 0; this.tB = 0; this.dtB = 0; this.tC = 0; this.dtC = 0; this.tD = 0; this.dtD = 0;
    this.cx = 0.5; this.dcx = 0; this.cy = 0.5; this.dcy = 0;
    this.morph = 0; this.dMorph = 0; this.warp = 0; this.dWarp = 0;
    this.lift = 1; this.dLift = 0; this.fold = 0; this.dFold = 0;
    this.param = 0.5; this.dParam = 0;
    this.g = 0.5; this.dg = 0; this.k = 1.4; this.dk = 0;
    this.drive = 0; this.dDrive = 0;
    this.gl = 1; this.dgl = 0; this.gr = 1; this.dgr = 0;
    this.lA = 0; this.wA = 0; this.dwA = 0;
    this.lB = 0; this.wB = 0; this.dwB = 0;
    this.cLvA = 0; this.dcLvA = 0; this.cLvB = 0; this.dcLvB = 0;
    this.laps = 1; this.dLaps = 0;
    this.pace = 0; this.dPace = 0;
    this.paceShape = 0;        // Pace curve in use (switches only while Pace is faded to 0)
    // end-of-block transform targets (Pristine samples its cycle with these)
    this.eA = 0; this.eB = 0; this.eC = 0; this.eD = 0; this.eSpeed = 0;

    // sub oscillator (one per voice, not per unison oscillator)
    this.subPh = 0; this.subInc = 0; this.dSubInc = 0;
    this.subLv = 0; this.dSubLv = 0;

    // Air: tilted noise. aH * noise + aD * lowpass(noise), both ramped; the
    // xorshift state and the tilt low-pass states
    this.aH = 0; this.daH = 0; this.aD = 0; this.daD = 0;
    this.nz = 1; this.tlL = 0; this.tlR = 0;

    // hard-sync polyBLEP carried across a segment boundary: the correction for
    // the first sample of the next segment, and whether its restart is done
    this.blepPend = new Float64Array(MAX_UNISON);
    this.blepSkip = new Uint8Array(MAX_UNISON);

    // filter + DC blocker state
    this.ic1L = 0; this.ic2L = 0; this.ic1R = 0; this.ic2R = 0;
    this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;
    this.dcInit = false; this.dcMeanL = 0; this.dcMeanR = 0;
    // second DC blocker after the filter, switched on (for good) once Drive
    // bends an asymmetric wave into DC and the filter would pass it
    this.pdOn = false; this.pdxL = 0; this.pdyL = 0; this.pdxR = 0; this.pdyR = 0;
    // filter type in use; on a change the old type keeps running and fades
    // out (weight ftW, falling by ftDW per sample)
    this.ft = -1; this.ftOld = 0; this.ftW = 0; this.ftDW = 0;
    // comb: delay lines (L then R, each combLen long), write index, ramps of
    // the delay (samples), loop gain g^2, feed-forward (2 formant - 1) g, makeup
    this.comb = null; this.combLen = 0; this.cw = 0;
    this.cD = 100; this.dcD = 0; this.cFb = 0; this.dcFb = 0; this.cFf = 0; this.dcFf = 0; this.cMk = 1; this.dcMk = 0;
    // vowel: per formant g, k, amplitude (current + per-sample delta) and
    // the SVF states (ic1, ic2 for L then R)
    this.vf = new Float64Array(9); this.dvf = new Float64Array(9); this.vs = new Float64Array(12);
    // path in use (shape, order, travel bits: 1 ping-pong, 2 even) and the
    // previous one, which keeps rendering and fades out (weight travW) after
    // a change, so switching Path, Order, Direction or Travel never clicks
    this.pShape = 0; this.pOrder = 1; this.trav = 0;
    this.shOld = 0; this.orOld = 1; this.travOld = 0; this.travW = 0; this.travDW = 0;

    // Pristine: band-limited single cycles. tabA = playing, tabB = arriving
    // (crossfade tabX 0 -> 1); tw = weight of the table against direct
    // rendering. Allocated when Pristine is first selected.
    this.tabA = null; this.tabB = null; this.tabNA = 0; this.tabNB = 0;
    this.tabX = 1; this.dTabX = 0; this.tw = 0; this.dtw = 0;
    this.tabValid = false; this.tabCount = 0; this.calm = 0; this.drift = 0; this.tabAge = 0;
    this.orb = new Float64Array(12);
    this.tabKey = new Float64Array(23);    // what the arriving table was built from
  }

  resetState() {
    this.ic1L = this.ic2L = this.ic1R = this.ic2R = 0;
    this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0;
    this.envLvl = 0; this.env2Lvl = 0;
    this.envStage = IDLE; this.env2Stage = IDLE;
    this.stealFade = 0; this.stealGain = 1; this.pending = false;
    this.subPh = 0; this.sub2Ph = this.ringPh = this.pmPh = this.texturePos = 0;
    this.partialPhase.fill(0); if (this.stringOn) this.string.reset(); this.stringOn = false;
    this.ampExtra.reset(); this.env2Extra.reset();
    for (const env of this.ownEnvs) env.reset();
    this.analog[0].reset(); this.analog[1].reset();
    this.blepPend.fill(0); this.blepSkip.fill(0);
    this.tlL = 0; this.tlR = 0;
    this.vs.fill(0);
    this.ftW = 0; this.travW = 0;
    this.tabValid = false; this.tw = 0; this.dtw = 0;
    this.pdOn = false; this.pdxL = this.pdyL = this.pdxR = this.pdyR = 0;
    this.gRamp = false; this.dugL.fill(0); this.dugR.fill(0);
    this.dMean = 0;
  }

  /** The voice gains a right channel mid-note: R starts from L's state, so it continues seamlessly. */
  goStereo() {
    this.ic1R = this.ic1L; this.ic2R = this.ic2L;
    this.dcxR = this.dcxL; this.dcyR = this.dcyL;
    this.tlR = this.tlL;
    this.pdxR = this.pdxL; this.pdyR = this.pdyL;
    for (let i = 0; i < 6; i++) this.vs[6 + i] = this.vs[i];
    if (this.comb) this.comb.copyWithin(this.combLen, 0, this.combLen);
    for (const filter of this.analog) filter.state.copyWithin(4, 0, 4);
    this.stereo = true;
  }

  /** Copy every scalar and small array of another voice (big buffers are the caller's business). */
  copyFrom(o) {
    for (const key of Object.keys(o)) {
      if (key === 'comb' || key === 'tabA' || key === 'tabB') continue;
      const a = o[key];
      if (ArrayBuffer.isView(a)) this[key].set(a);
      else if (a === null || typeof a !== 'object') this[key] = a;
    }
    this.ampExtra.copyFrom(o.ampExtra); this.env2Extra.copyFrom(o.env2Extra);
    for (let m=0;m<NMOD;m++) this.ownEnvs[m].copyFrom(o.ownEnvs[m]);
    this.string.sampleRate = o.string.sampleRate; this.string.copyFrom(o.string);
    for (let i=0;i<2;i++) this.analog[i].copyFrom(o.analog[i]);
    for (const name of ['colourL','colourR']) {
      const a=this[name], b=o[name]; a.seed=b.seed; a.previous=b.previous; a.brown=b.brown;
      a.pink.set(b.pink); a.blue.set(b.blue); a.blueIndex=b.blueIndex; a.alpha.set(b.alpha); a.scale.set(b.scale); a.brownAlpha=b.brownAlpha; a.brownScale=b.brownScale;
    }
  }
}

// --- part ------------------------------------------------------------------

class Part {
  constructor(index, sr, os) {
    this.index = index;
    this.params = new Float64Array(NPARAMS);
    for (let i = 0; i < NPARAMS; i++) this.params[i] = PART_PARAMS[i].default;

    this.baseNorm = new Float64Array(NMOD);
    for (let m = 0; m < NMOD; m++) this.baseNorm[m] = toNorm(MOD_DEFS[m], MOD_DEFS[m].default);

    this.lfoShape = new Int32Array(NMOD).fill(MOD_DEFAULT.lfoShape);
    this.lfoRate = new Float64Array(NMOD).fill(MOD_DEFAULT.lfoRate);
    this.lfoSync = new Uint8Array(NMOD).fill(MOD_DEFAULT.lfoSync);
    this.lfoDiv = new Int32Array(NMOD).fill(MOD_DEFAULT.lfoDiv);
    this.lfoDepth = new Float64Array(NMOD).fill(MOD_DEFAULT.lfoDepth);
    this.envDepth = new Float64Array(NMOD).fill(MOD_DEFAULT.envDepth);
    this.retrig = new Uint8Array(NMOD).fill(MOD_DEFAULT.retrig);
    this.lfoSteps = new Float64Array(NMOD * LFO_STEP_COUNT);
    for (let m = 0; m < NMOD; m++) for (let s = 0; s < LFO_STEP_COUNT; s++) this.lfoSteps[m * LFO_STEP_COUNT + s] = DEFAULT_LFO_STEPS[s];

    for (const field of NEW_MOD_FIELDS) this[field === 'lfoPhase' ? 'lfoStart' : field] = new Float64Array(NMOD).fill(MOD_DEFAULT[field]);
    this.lfoValueOffset = new Float64Array(NMOD);
    this.lfoAge = new Float64Array(NMOD); this.lfoCycles = new Int32Array(NMOD);
    this.ctrlSrc = new Int32Array(NMOD * 4); this.ctrlDepth = new Float64Array(NMOD * 4); this.ctrlCurve = new Int32Array(NMOD * 4);
    this.envConfig = Array.from({length:NMOD}, () => new Float64Array(ENV_IDS.map(id => MOD_DEFAULT[id])));
    this.ampConfig = new Float64Array(7); this.env2Config = new Float64Array(7);
    this.lfoPhase = new Float64Array(NMOD);
    this.lfoOffset = new Float64Array(NMOD);   // phase offset for transport-anchored, retriggered LFOs
    this.lfoVal = new Float64Array(NMOD);
    this.lfoR0 = new Float64Array(NMOD);
    this.lfoR1 = new Float64Array(NMOD);
    this.rng = mulberry32(0x0b0e + index * 977);
    this.extraRng = mulberry32(0xe71a + index * 977);
    for (const id of LEGACY_MOD_IDS) { const m=MOD_SLOT[id]; this.lfoR0[m]=this.rng()*2-1; this.lfoR1[m]=this.rng()*2-1; }
    for (let m=0;m<NMOD;m++) if (!LEGACY_MOD_IDS.includes(MOD_PARAM_IDS[m])) { this.lfoR0[m]=this.extraRng()*2-1; this.lfoR1[m]=this.extraRng()*2-1; }

    this.partNorm = new Float64Array(NMOD);
    this.partPlain = new Float64Array(NMOD);

    // Links: up to MAX_LINKS routes. partLink = the summed contribution of the
    // part-wide sources per slot; vLinked = slots with a per-voice source.
    this.nLinks = 0;
    this.lkSrc = new Int32Array(MAX_LINKS); this.lkDst = new Int32Array(MAX_LINKS);
    this.lkAmt = new Float64Array(MAX_LINKS); this.lkCurve = new Int32Array(MAX_LINKS);
    this.lkVia = new Int32Array(MAX_LINKS).fill(-1);   // v2.4: a second source scaling the link, -1 = none
    this.lkPart = new Uint8Array(MAX_LINKS);           // 1 = the link (source and Via) is the same for every voice
    // v2.4 Function: its points (x rising 0..1, y -1..1) and settings
    this.fnXs = new Float64Array(FUNC_MAX_POINTS); this.fnYs = new Float64Array(FUNC_MAX_POINTS); this.fnN = 0;
    this.fnMode = 0; this.fnRate = 1; this.fnSync = 0; this.fnDiv = 2; this.fnSmooth = 0;
    this.setFunc(sanitizeFuncPoints(null));
    this.partLink = new Float64Array(NMOD);
    this.vLinked = new Uint8Array(NMOD);
    this.voiceModSlots=new Uint16Array(NMOD); this.voiceModCount=0;
    this.voiceLinks = false; this.needTerrH = false; this.orbitVoiceMod = false; this.trackMean = false;
    this.wheel = 0; this.expression = 0; this.sustainLevel = 0; this.breath = 0;
    this.pressure = 0; this.slide = 0;
    // until the host sends the part's Links, the default set (Mod Wheel ->
    // Morph, what used to be hard-wired) applies
    for (const l of DEFAULT_LINKS) {
      const m = MOD_SLOT[l.dst];
      if (m === undefined || this.nLinks >= MAX_LINKS) continue;
      this.lkSrc[this.nLinks] = l.src; this.lkDst[this.nLinks] = m;
      this.lkAmt[this.nLinks] = l.amt; this.lkCurve[this.nLinks] = l.curve;
      this.lkVia[this.nLinks] = -1; this.lkPart[this.nLinks] = PART_SOURCE[l.src] ? 1 : 0;
      this.nLinks++;
    }
    this.marbleSpeed = 0; this.marbleHeight = 0; this.sMarbleSpeed = 0; this.sMarbleHeight = 0;

    // timed parameter ramps, one slot per parameter (no allocation in process())
    this.rampOn = new Uint8Array(NPARAMS);
    this.rampStart = new Float64Array(NPARAMS); this.rampDelta = new Float64Array(NPARAMS);
    this.rampT0 = new Float64Array(NPARAMS); this.rampDur = new Float64Array(NPARAMS);
    this.nRamps = 0;

    this.voices = [];
    for (let i = 0; i < VOICES_PER_PART; i++) this.voices.push(new Voice(i, sr, os));

    this.terrA = defaultChain();
    this.terrB = defaultChain();
    this.terrGen = 0;                   // bumped whenever a terrain table arrives (Pristine rebuilds)
    this.oldA = null; this.fadeA = 0;   // terrain crossfade (1 -> 0)
    this.oldB = null; this.fadeB = 0;
    this.fadeACur = 0; this.dFadeA = 0; this.fadeBCur = 0; this.dFadeB = 0;

    this.bend = 0;
    this.spinPhase = 0;
    this.stack = new Float64Array(32);  // held notes in mono/legato, last = newest
    this.stackLen = 0;
    this.lastPitch = -1;                // last note played, where glides start from

    // unison layout
    this.uni = 1;
    this.uniMode = 0; this.uniStack = 0; this.f2Type = 0; this.f2Route = 0; this.warpMode = 0;
    this.kit = null; this.kitOn = false;   // v2.7 drum kit: notes play pads instead of synth voices
    this.smp = null; this.smpOn = false;   // 2.13 sampler: notes play a sample instead of synth voices
    this.stackRatio = new Float64Array(MAX_UNISON).fill(1);
    this.uPos = new Float64Array(MAX_UNISON); this.uW = new Float64Array(MAX_UNISON).fill(1);
    this.uMapX = new Float64Array(MAX_UNISON); this.uMapY = new Float64Array(MAX_UNISON);
    this.detRatio = new Float64Array(MAX_UNISON).fill(1);
    this.gUL = new Float64Array(MAX_UNISON).fill(1);
    this.gUR = new Float64Array(MAX_UNISON).fill(1);

    // envelope coefficients (per oversampled sample for Env 1, per control block for Env 2)
    this.attC = 0; this.decC = 0; this.relC = 0; this.sus = 0.75;
    this.att2C = 0; this.dec2C = 0; this.rel2C = 0; this.sus2 = 0.25;

    // mixer
    this.vectorGain=1; this.vectorSmooth=1; this.dVector=0;
    this.gain = 0; this.dGain = 0; this.dly = 0; this.dDly = 0; this.rev = 0; this.dRev = 0;
    this.ped = 0; this.dPed = 0;   // pedal send (v1.1), the fourth bus
    this.exit = 1;                 // 1 while in the track list, fades to 0 after leaving it
    // Dry delay of a Send mode part (pedal latency compensation): a ring
    // buffer at the host rate, allocated the first time it is needed.
    this.ddL = null; this.ddR = null; this.ddW = 0; this.ddN = 0;
    this.tail = 0;
    this.effects = new TrackEffects(sr); this.sidechainIndex = -1; this.rawPeak = 0; this.previousRawPeak = 0;
    this.prevL = new Float64Array(256); this.prevR = new Float64Array(256); this.fxMod = new Float64Array(8);
    this.recording = null; this.textures = noiseTextures(sr);

    // voice bus at the oversampled rate with the decimator history in front
    // (hist samples); the 4x mode decimates through a 2x bus (mid)
    this.os = os;
    this.hist = os === 4 ? HB1_HIST : HB_HIST;
    this.busL = new Float64Array(HB_HIST + MAX_OS * 256);
    this.busR = new Float64Array(HB_HIST + MAX_OS * 256);
    this.midL = new Float64Array(HB_HIST + 2 * 256);
    this.midR = new Float64Array(HB_HIST + 2 * 256);
    this.outL = new Float64Array(256);
    this.outR = new Float64Array(256);
    // render context: everything rate-dependent that renderVoice reads, so a
    // ghost (the outgoing quality during a crossfade) can bring its own
    this.rc = { os, dcR: 0, attC: 0, decC: 0, relC: 0, sus: 0.75, tiltA: 0, airNorm: null, busL: this.busL, busR: this.busR, hist: this.hist };
    this.ghost = null;

    this.layoutDirty=false;
    this.sr = sr;
    this.shapeI = 0; this.orderI = 1; this.ftype = 1; this.mode = 0;
    this.paceShapeI = 0; this.subT = 0;
    this.airT = 0; this.airTone = 0; this.noteSize = 0; this.travBits = 0;
    this.gainS = 0; this.dlyS = 0; this.revS = 0; this.pedS = 0;
    // v2.8 Send A / Send B (post-fader, to the shared return buses)
    this.sA = 0; this.dSA = 0; this.sAS = 0; this.sB = 0; this.dSB = 0; this.sBS = 0;
    // v2.8 freeze: { L, R, len (frames, fractional), beats } or null; fzX is
    // the frozen loop's share (0 voices .. 1 loop), fzTarget where it heads,
    // fzGate the transport fade (0 stopped .. 1 playing)
    this.frozen = null; this.fzX = 0; this.fzTarget = 0; this.fzGate = 0;
    // 2.10 Resonator (src/dsp/resonator.js): built the first time it is
    // switched on; while resoMode is 0 nothing about it runs
    this.reso = null; this.resoMode = 0; this.resoMorph = 0; this.resoAt = 0;
    // 2.12 3D sound (src/dsp/spatial.js): built the first time 3D is switched
    // on; while spaceMode is 0 and its fade has ended nothing about it runs
    this.space = null; this.spaceMode = 0; this.spaceAz = 0;
    this.updateDerived();
  }

  activeCount() {
    let n = 0;
    for (let i = 0; i < this.voices.length; i++) if (this.voices[i].active) n++;
    return n;
  }

  updateDerived() {
    const sr = this.sr;
    const P = this.params;
    this.shapeI = Math.max(0, Math.min(PART_PARAM_MAP.pathShape.max, Math.round(P[PI.pathShape]) || 0));
    this.orderI = Math.max(1, Math.min(8, Math.round(P[PI.pathOrder]) || 1));
    this.ftype = Math.max(0, Math.min(11, Math.round(P[PI.filterType]) || 0));
    this.mode = Math.max(0, Math.min(2, Math.round(P[PI.polyMode]) || 0));
    this.paceShapeI = Math.max(0, Math.min(2, Math.round(P[PI.paceShape]) || 0));
    // Sub level on a squared (audio taper) curve: half way is about -12 dB
    const sub = clamp01(P[PI.sub]);
    this.subT = SUB_GAIN * sub * sub;
    // Air on the same taper
    const air = clamp01(P[PI.air]);
    this.airT = AIR_RMS * air * air;
    this.airTone = clampPM1(P[PI.airTone]);
    this.noteSize = clampPM1(P[PI.noteSize]);
    this.travBits = (Math.round(P[PI.direction]) === 1 ? 1 : 0) | (Math.round(P[PI.traverse]) === 1 ? 2 : 0);
    // unison
    const U = Math.max(1, Math.min(MAX_UNISON, Math.round(P[PI.unison])));
    this.uni = U;
    this.uniMode = Math.max(0, Math.min(3, Math.round(P[PI.unisonMode]) || 0));
    this.uniStack = Math.max(0, Math.min(UNISON_STACKS.length - 1, Math.round(P[PI.unisonStack]) || 0));
    this.f2Type = Math.max(0, Math.min(11, Math.round(P[PI.filter2Type]) || 0));
    this.warpMode = Math.max(0, Math.min(4, Math.round(P[PI.warpMode]) || 0));
    this.fnMode = Math.round(P[PI.funcMode]) === 1 ? 1 : 0;
    this.fnRate = Math.max(0.01, P[PI.funcRate] || 1);
    this.fnSync = P[PI.funcSync] >= 0.5 ? 1 : 0;
    this.fnDiv = Math.max(0, Math.min(SYNC_DIVS.length - 1, Math.round(P[PI.funcDiv]) || 0));
    this.fnSmooth = clamp01(P[PI.funcSmooth]);
    this.f2Route = Math.max(0, Math.min(2, Math.round(P[PI.filterRoute]) || 0));
    unisonLayout(this, U, P[PI.detune], clamp01(P[PI.spread]), clamp01(P[PI.unisonBlend]));
    // Env 1 at the oversampled rate
    const fs2 = sr * this.os;
    this.attC = Math.exp(Math.log((ATTACK_OVERSHOOT - 1) / ATTACK_OVERSHOOT) / Math.max(1, P[PI.attack] * fs2));
    this.decC = Math.exp(Math.log(ENV_FLOOR) / Math.max(1, P[PI.decay] * fs2));
    this.relC = Math.exp(Math.log(ENV_FLOOR) / Math.max(1, P[PI.release] * fs2));
    this.sus = clamp01(P[PI.sustain]);
    // Env 2 per control block
    const blocks = (t) => Math.max(1e-3, t * sr / CTRL);
    this.att2C = Math.exp(Math.log((ATTACK_OVERSHOOT - 1) / ATTACK_OVERSHOOT) / blocks(P[PI.env2Attack]));
    this.dec2C = Math.exp(Math.log(ENV_FLOOR) / blocks(P[PI.env2Decay]));
    this.rel2C = Math.exp(Math.log(ENV_FLOOR) / blocks(P[PI.env2Release]));
    this.sus2 = clamp01(P[PI.env2Sustain]);
    const rc = this.rc;
    const ac=this.ampConfig, ec=this.env2Config;
    ac[0]=P[PI.ampDelay]; ac[1]=P[PI.attack]; ac[2]=P[PI.ampHold]; ac[3]=P[PI.decay]; ac[4]=P[PI.sustain]; ac[5]=P[PI.release]; ac[6]=P[PI.ampMode];
    ec[0]=P[PI.env2Delay]; ec[1]=P[PI.env2Attack]; ec[2]=P[PI.env2Hold]; ec[3]=P[PI.env2Decay]; ec[4]=P[PI.env2Sustain]; ec[5]=P[PI.env2Release]; ec[6]=P[PI.env2Mode];
    this.ampCustom = P[PI.ampDelay] !== 0 || P[PI.ampHold] !== 0 || P[PI.ampMode] !== 0;
    this.env2Custom = P[PI.env2Delay] !== 0 || P[PI.env2Hold] !== 0 || P[PI.env2Mode] !== 0;
    rc.os = this.os; rc.attC = this.attC; rc.decC = this.decC; rc.relC = this.relC; rc.sus = this.sus;
  }

  ensureBus(frames) {
    if (this.outL.length >= frames) return;
    const n = 1 << Math.ceil(Math.log2(frames));
    const grow = (a, len, keep) => { const b = new Float64Array(len); b.set(a.subarray(0, keep)); return b; };
    this.busL = grow(this.busL, HB_HIST + MAX_OS * n, HB_HIST);
    this.busR = grow(this.busR, HB_HIST + MAX_OS * n, HB_HIST);
    this.midL = grow(this.midL, HB_HIST + 2 * n, HB_HIST);
    this.midR = grow(this.midR, HB_HIST + 2 * n, HB_HIST);
    this.outL = new Float64Array(n); this.outR = new Float64Array(n);
    this.rc.busL = this.busL; this.rc.busR = this.busR;
    const g = this.ghost;
    if (g) {
      g.busL = grow(g.busL, HB_HIST + MAX_OS * n, HB_HIST); g.busR = grow(g.busR, HB_HIST + MAX_OS * n, HB_HIST);
      g.midL = grow(g.midL, HB_HIST + 2 * n, HB_HIST); g.midR = grow(g.midR, HB_HIST + 2 * n, HB_HIST);
      g.outL = new Float64Array(n); g.outR = new Float64Array(n);
      g.rc.busL = g.busL; g.rc.busR = g.busR;
    }
  }

  /**
   * Delay the part's dry output (and its delay/reverb sends) by `n` host
   * samples, 0 = off. A change starts from silence rather than replaying
   * whatever an earlier setting left in the buffer.
   */
  setDryDelay(n) {
    if (n === this.ddN) return;
    if (n > 0) {
      let size = 64;
      while (size <= n) size <<= 1;
      if (!this.ddL || this.ddL.length < size) { this.ddL = new Float64Array(size); this.ddR = new Float64Array(size); }
      else { this.ddL.fill(0); this.ddR.fill(0); }
      this.ddW = 0;
    }
    this.ddN = n;
  }

  /** v2.4: load the Function's points (already sanitized). */
  setFunc(points) {
    const n = Math.min(FUNC_MAX_POINTS, points.length);
    for (let i = 0; i < n; i++) { this.fnXs[i] = points[i][0]; this.fnYs[i] = points[i][1]; }
    this.fnN = n;
  }

  /** Recompute the summed contribution of the part-wide Link sources. */
  updatePartLinks(macros, guitar = 0, voice = 0, science = null) {
    const pl = this.partLink;
    pl.fill(0);
    for (let i = 0; i < this.nLinks; i++) {
      if (!this.lkPart[i]) continue;
      const via = this.lkVia[i];
      const g = via >= 0 ? this.partSourceValue(via, macros, guitar, voice, science) : 1;
      pl[this.lkDst[i]] += this.lkAmt[i] * linkCurve(this.lkCurve[i], this.partSourceValue(this.lkSrc[i], macros, guitar, voice, science)) * g;
    }
  }

  /** Value of a part-wide Link source. */
  partSourceValue(s, macros, guitar, voice, science) {
    {
      let x;
      if (s === L_WHEEL) x = this.wheel;
      else if (s === L_MSPEED) x = this.sMarbleSpeed;
      else if (s === L_MHEIGHT) x = this.sMarbleHeight;
      else if (s === L_GUITAR) x = guitar;
      else if (s === L_VOICE) x = voice;
      else if (s === L_EXPRESSION) x=this.expression;
      else if (s === L_SUSTAIN) x=this.sustainLevel;
      else if (s === L_BREATH) x=this.breath;
      else if (s === L_TURING) x = science ? science[SCI_TURING] : 0;
      else if (s >= L_WEATHER && s <= L_WEATHER_END) x = this.weather ? this.weather[s - L_WEATHER] : 0;
      else if (s >= L_PAD && s <= L_PAD_END) x = this.pad ? this.pad[s - L_PAD] : 0;
      else if (s >= L_SCIENCE && s <= L_SCIENCE_END) x = science ? science[s - L_SCIENCE] : 0;
      else if (s >= L_MACRO && s < L_MACRO + 4) x = macros[s - L_MACRO];
      else x = 0;
      return x;
    }
  }
}

function lfoValue(shape, ph, r0, r1) {
  switch (shape) {
    case 0: return fastSin(ph);
    case 1: return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case 2: return 2 * ph - 1;
    case 3: return ph < 0.5 ? 1 : -1;
    case 4: return r1;
    default: { const s = ph * ph * (3 - 2 * ph); return r0 + (r1 - r0) * s; }
  }
}

/**
 * Steps LFO: the value of step floor(16 ph), reached by a STEP_SLEW linear
 * glide from the previous step. Stateless (a function of the phase and the
 * step length), so it follows transport anchoring and retriggers exactly.
 */
function stepsValue(steps, base, ph, stepDur) {
  const x = ph * LFO_STEP_COUNT;
  let i = x | 0;
  if (i >= LFO_STEP_COUNT) i = LFO_STEP_COUNT - 1;
  const cur = steps[base + i];
  const tIn = (x - i) * stepDur;
  if (tIn >= STEP_SLEW) return cur;
  const prev = steps[base + (i === 0 ? LFO_STEP_COUNT - 1 : i - 1)];
  return prev + (cur - prev) * (tIn / STEP_SLEW);
}

function finiteOr(v, d) { const n = +v; return Number.isFinite(n) ? n : d; }
function sameNote(a, b) { return Math.abs(a - b) < 1e-6; }
function mipZone(f) { const w = (f - 0.5) * 2; return w < 0 ? 0 : w > 1 ? 1 : w; }

function softLimit(x) {
  // identity inside ±2, then a knee that never exceeds ±3
  if (x > 2) { const e = x - 2; return 2 + e / (1 + e); }
  if (x < -2) { const e = -x - 2; return -2 - e / (1 + e); }
  return x;
}

/**
 * Height of one mip chain at (u, v) for one sample, as the terrain passes
 * compute it: either the block's integer level `l` blended by `wt` towards
 * l + 1 (wt <= 0: no blend), with the outgoing terrain crossfaded in by `f`.
 */
function chainHeight(chain, l, wt, old, f, u, v) {
  const t0 = chain[l];
  let h = bil(t0.data, t0.size, t0.size - 1, u, v);
  if (wt > 0 && l + 1 < chain.length) { const t1 = chain[l + 1]; h += wt * (bil(t1.data, t1.size, t1.size - 1, u, v) - h); }
  if (old !== null && f > 0) { const o = old[l < old.length ? l : old.length - 1]; h += f * (bil(o.data, o.size, o.size - 1, u, v) - h); }
  return h;
}

/** Air: in-band (0 .. sr/2) power of the tilted noise, per unit-variance input, for tone -1..1. */
function airNormTable(sr, fs) {
  const a = 1 - Math.exp(-2 * Math.PI * AIR_PIVOT / fs);
  const tab = new Float64Array(65);
  const K = 512;
  for (let t = 0; t <= 64; t++) {
    const tone = t / 32 - 1;
    const gL = Math.pow(2, -4 * Math.max(0, tone)), gH = Math.pow(2, 4 * Math.min(0, tone));
    let p = 0;
    for (let k = 0; k < K; k++) {
      const w = 2 * Math.PI * ((k + 0.5) / K) * (0.5 * sr) / fs;
      // lp = a / (1 - (1 - a) e^-jw); y = gH + (gL - gH) lp
      const dr = 1 - (1 - a) * Math.cos(w), di = (1 - a) * Math.sin(w);
      const den = dr * dr + di * di;
      const lr = a * dr / den, li = -a * di / den;
      const yr = gH + (gL - gH) * lr, yi = (gL - gH) * li;
      p += yr * yr + yi * yi;
    }
    // white noise of variance s2 at rate fs puts s2 * (sr / fs) of its power below sr / 2
    p = p / K * (sr / fs);
    // uniform [-1, 1) noise has variance 1/3
    tab[t] = 1 / Math.sqrt(p / 3);
  }
  return { a, tab };
}

// ---------------------------------------------------------------------------

export class OroDSP {
  constructor(sampleRate) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
    this.quality = 'standard';
    this.os = OVERSAMPLE;
    this.fs2 = this.sr * this.os;
    this.mipShift = 0;
    this.pristine = false;
    this.pendingQuality = null;
    /** Telemetry hook; the worklet points this at port.postMessage. */
    this.postMessage = () => {};
    this.parts = [];
    this.weather = new WeatherBank();   // v2.10 live weather Link sources (global), read by every part
    this.pad = new PadBank();           // v2.11 game controller right stick Link sources (global)
    for (let i = 0; i < MAX_PARTS; i++) { const P = new Part(i, this.sr, this.os); P.weather = this.weather.out; P.pad = this.pad.out; this.parts.push(P); }
    // Parts (tracks) in use: 0..count-1. The rest only render while they fade
    // out after being removed (see setTracks and dormant()).
    this.count = DEFAULT_PARTS;
    this.liveN = DEFAULT_PARTS;   // parts 0..liveN-1 may need work this call (see process)

    this.tempo = 112;
    this.macros = new Float64Array(4);
    this.science = new ScienceBank(1);   // v2.1 science Link sources, stepped once per control block
    this.swirlOut = { x: 0, y: 0 };
    this.vectorMix=0; this.vectorX=this.vectorY=0.5; this.vectorBank=0; this.vectorWeights=new Float64Array(4).fill(1);
    // v1.1 pedal loop: the host says when the pedal send really leaves the
    // computer (outputs 3/4); until then the send bus stays silent and Insert
    // is ignored, so a part can never go quiet with nowhere to go.
    this.pedalOn = false;
    // v2.9 microtuning: per key, the tuned pitch as a fractional 12-TET note
    // number (69 = 440 Hz). null = the default tuning, played by the original code.
    this.tuneSemis = null;
    // Pedal latency compensation: dry delay (host samples) for parts in Send
    // mode (pedal send above 0, Insert off) while the pedal loop runs.
    this.dryDelayN = 0;
    this.guitar = 0; this.sGuitar = 0;  // Guitar Level link source (0..1), smoothed like the marble
    this.voice = 0; this.sVoice = 0;    // Voice Level link source (0..1, v1.4 microphone envelope), smoothed the same way
    this.micRing = new Float32Array(Math.max(2048, this.sr | 0)); this.micW = 0; this.micR = 0;
    this.transport = { playing: false, beatTime: 0, beat: 0 };
    // v2.8 send buses: built the first time a part sends to them
    this.sendFx = null;
    this.sendCfg = { tempo: 112 };
    this.sendBufs = null;          // [aL, aR, bL, bR] summed sends of one render call
    this.sendFedA = false; this.sendFedB = false; this.sendDirty = false;
    // v2.8 freeze
    // v2.9 Operator panel (damage, quirks, vintage, test tones) on the mix; null until a session turns one on
    this.op = null;
    this.capture = -1;             // part whose pre-fader output alone is rendered (offline freeze), -1 = off
    this.resoGpu = null;           // 2.12 GPU Resonator link (reso-feed.js), made on the first resoGpu message
    this.dryOut = 1;               // v2.11 stems export: 0 renders only the sends (a send-return stem)
    // 2.12 surround: null (stereo, the default) or a layout from SURROUND_LAYOUTS.
    // Tracks in 3D then go to the speakers (front left/right through the
    // normal outputs, the rest into surOut) instead of the head model.
    this.surLayout = null; this.surSpread = 0; this.surOut = null;
    this.partStreams = false;      // v2.11 stems export: per-part random streams (streamOf)
    this.segTime = 0;              // context time of the segment being rendered
    this.kFreeze = CTRL / (this.sr * FREEZE_FADE_TIME);
    this.kGate = 1 / (this.sr * FREEZE_GATE_TIME);
    this.watch = 0;
    this.voiceCounter = 0;

    this.events = [];           // scheduled note / parameter events, sorted by time
    this.lastTime = 0;          // currentTime of the latest process() call
    this.nextTime = 0;          // time of the first sample of the next process() call
    this.blockTime = 0;         // time of the current control block

    this.ctrlRemain = 0;
    this.sinceCtrl = CTRL;      // samples since the last control update
    this.kSmooth = 1 - Math.exp(-CTRL / (this.sr * SMOOTH_TIME));
    this.kPress = 1 - Math.exp(-CTRL / (this.sr * PRESS_TIME));
    this.kMarble = 1 - Math.exp(-CTRL / (this.sr * MARBLE_TIME));
    this.fadeStep = CTRL / (this.sr * TERRAIN_FADE_TIME);
    this.exitStep = CTRL / (this.sr * TRACK_FADE_TIME);
    /** Octaves added to the mip level choice (see mipRaw); -99 disables mip mapping (tests). */
    this.mipBias = 1;
    /** false: hard-sync restarts are left naive (no polyBLEP), for A/B tests. */
    this.blep = true;
    this.airTabs = {};
    this.setRateConstants();

    this.teleInterval = Math.max(64, Math.round(this.sr / 60));
    this.teleCount = 0;
    this.peakL = 0; this.peakR = 0;

    // scratch for renderVoice (a segment never spans more than one control block)
    const n2max = MAX_OS * CTRL;
    this.xs = []; this.ys = []; this.lvs = [];
    for (let q = 0; q < MAX_UNISON; q++) {
      this.xs.push(new Float64Array(n2max)); this.ys.push(new Float64Array(n2max));
      this.lvs.push(new Float64Array(n2max));   // per-sample mip level offset (Pace)
    }
    this.ts = new Float64Array(n2max);           // path phases (Laps / Pace)
    this.phs = new Float64Array(n2max);          // cycle phases (Laps / Pace)
    this.sumL = new Float64Array(n2max);
    this.sumR = new Float64Array(n2max);
    this.f2L = new Float64Array(n2max);          // v2.2 Filter 2 input (parallel / split) or work buffer
    this.f2R = new Float64Array(n2max);
    this.tmpL = new Float64Array(n2max);         // second render for crossfades
    this.tmpR = new Float64Array(n2max);
    this.sav = new Float64Array(8 * MAX_UNISON); // oscillator state saved around a second render
    this.pst = new Float64Array(5);
    this.pt = { x: 0, y: 0 };
    this.rng = mulberry32(0x6f726f67); this.extensionRng = mulberry32(0x82edfe); this.unisonRng = mulberry32(0x5e1f22);
    this.linkRng = mulberry32(0x11c5);           // Random link source (own stream: unison phases stay as they were)
    this.noiseSeed = 0x2545f491;
    // hard-sync restarts of the current segment: oscillator, sample (n2 = look-ahead), fraction, laps
    this.evQ = new Int32Array(MAX_SYNC_EVENTS);
    this.evJ = new Int32Array(MAX_SYNC_EVENTS);
    this.evD = new Float64Array(MAX_SYNC_EVENTS);
    this.evL = new Float64Array(MAX_SYNC_EVENTS);
    // Pristine scratch (allocated on first use of the mode)
    this.fft = null;
    this.keyScratch = new Float64Array(23);
    this.tabBudget = TABLE_BUDGET;
  }

  /** Everything that follows the oversampled rate. */
  setRateConstants() {
    this.fs2 = this.sr * this.os;
    this.stealSamples = Math.max(8, Math.round(STEAL_FADE_TIME * this.fs2));
    this.dcR = 1 - 2 * Math.PI * 8 / this.fs2;
    const key = String(this.os);
    if (!this.airTabs[key]) this.airTabs[key] = airNormTable(this.sr, this.fs2);
    const air = this.airTabs[key];
    for (const P of this.parts) {
      const rc = P.rc;
      rc.dcR = this.dcR; rc.tiltA = air.a; rc.airNorm = air.tab;
    }
  }

  // ---- message protocol ---------------------------------------------------

  /**
   * v2.9 microtuning: `hz` is the frequency of every key 0..127 (any array
   * of 128 numbers), or null for the default 12-TET at A4 = 440 Hz.
   */
  setTuning(hz) {
    if (!hz || typeof hz.length !== 'number' || hz.length < 128) { this.tuneSemis = null; return; }
    const t = new Float64Array(128);
    for (let i = 0; i < 128; i++) {
      const f = Number(hz[i]);
      t[i] = f >= 1 && f <= 24000 ? 69 + 12 * Math.log2(f / 440) : f > 24000 ? 69 + 12 * Math.log2(24000 / 440) : i;
    }
    this.tuneSemis = t;
  }

  /**
   * A fractional key (gliding, bent or transposed by whole keys) -> its tuned
   * pitch as a 12-TET note number, interpolated in log frequency between
   * adjacent keys; beyond 0..127 the end step is extrapolated.
   */
  tunedPitch(p) {
    const t = this.tuneSemis;
    if (!(p > 0)) return t[0] + (p || 0) * (t[1] - t[0]);
    if (p >= 127) return t[127] + (p - 127) * (t[127] - t[126]);
    const i = Math.floor(p), fr = p - i;
    return fr === 0 ? t[i] : t[i] + (t[i + 1] - t[i]) * fr;
  }

  /** One microphone sample for the vocoder, or 0 when the ring is empty. A long backlog is skipped so the modulator stays near the present. */
  readMic() {
    const ring = this.micRing;
    if (!ring) return 0;
    const size = ring.length;
    let avail = this.micW - this.micR;
    if (avail < 0) avail += size;
    if (!avail) return 0;
    if (avail > 1024) {
      this.micR = this.micW - 256;
      if (this.micR < 0) this.micR += size;
    }
    const s = ring[this.micR];
    if (++this.micR === size) this.micR = 0;
    return s;
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'params':
        if (msg.time !== undefined || msg.ramp !== undefined) this.scheduleParams(msg);
        else this.setParams(msg.part, msg.p);
        break;
      case 'mods': this.setMods(msg.part, msg.m); break;
      case 'global': this.setGlobal(msg.p); break;
      case 'noiseRecording': this.setNoiseRecording(msg.part, msg.data); break;
      case 'weather': this.weather.set(msg.v, !!msg.snap); break;
      case 'pad': this.pad.set(msg.v, !!msg.snap); break;
      case 'expression': case 'sustainLevel': case 'breath': {
        const P=this.partAt(msg.part); if (P) P[msg.t]=clamp01(finiteOr(msg.v,0)); break;
      }
      case 'trackFx': {
        const P=this.partAt(msg.part); if (!P) break;
        P.effects.configure(msg.fx);
        P.sidechainIndex=Math.max(-2,Math.min(MAX_PARTS-1,Math.round(finiteOr(msg.sidechainIndex,-1))));
        break;
      }
      case 'terrain': this.setTerrain(msg.part, msg.slot, msg.levels); break;
      case 'noteOn': this.schedule(1, msg); break;
      case 'noteOff': this.schedule(0, msg); break;
      case 'allOff': this.allOff(msg.part); break;
      case 'panic': this.panic(); break;
      case 'cancelNotes': this.cancelNotes(msg.after, msg.tag); break;
      case 'bend': { const P = this.partAt(msg.part); if (P) P.bend = Math.max(-1, Math.min(1, finiteOr(msg.v, 0))); break; }
      case 'wheel': { const P = this.partAt(msg.part); if (P) P.wheel = clamp01(finiteOr(msg.v, 0)); break; }
      case 'pressure': this.setTouch(msg, 'press'); break;
      case 'slide': this.setTouch(msg, 'slide'); break;
      case 'marble': {
        const P = this.partAt(msg.part);
        if (!P) break;
        P.marbleSpeed = clamp01(finiteOr(msg.speed, 0));
        P.marbleHeight = clampPM1(finiteOr(msg.height, 0));
        break;
      }
      case 'links': this.setLinks(msg.part, msg.links); break;
      case 'kit': this.setKit(msg.part, msg); break;
      case 'kitPreview': this.previewKit(msg.part, msg); break;
      case 'sampler': this.setSampler(msg.part, msg); break;
      case 'func': { const P = this.partAt(msg.part); if (P) { P.setFunc(sanitizeFuncPoints(msg.points)); } break; }
      case 'pedal': this.pedalOn = !!msg.active; break;
      case 'tuning': this.setTuning(msg.hz); break;
      case 'operator':
        if (msg.cfg && typeof msg.cfg === 'object') { if (this.op === null) this.op = new MasterOperator(this.sr); this.op.configure(msg.cfg); }
        else if (this.op !== null) this.op.configure(null);
        break;
      case 'opAction':
        if (!OPERATOR_ACTIONS.includes(msg.a)) break;
        if (this.op === null) this.op = new MasterOperator(this.sr);
        this.op.action(msg.a, msg.v);
        break;
      case 'opState':
        if (this.op === null) this.op = new MasterOperator(this.sr);
        this.op.setState(msg);
        break;
      case 'freeze': this.setFrozen(msg); break;
      case 'capture': { const i = Math.round(finiteOr(msg.part, -1)); this.capture = i >= 0 && i < MAX_PARTS ? i : -1; break; }
      case 'dryDelay': this.dryDelayN = Math.round(Math.max(0, Math.min(finiteOr(msg.samples, 0), MAX_DRY_DELAY_SEC * this.sr))); break;
      case 'guitar': this.guitar = clamp01(finiteOr(msg.v, 0)); break;
      case 'voiceLevel': this.voice = clamp01(finiteOr(msg.v, 0)); break;
      case 'voicePcm': {
        const pcm = msg.pcm;
        if (!pcm || typeof pcm.length !== 'number') break;
        const ring = this.micRing, size = ring.length;
        for (let i = 0; i < pcm.length; i++) {
          ring[this.micW] = finiteOr(pcm[i], 0);
          if (++this.micW === size) this.micW = 0;
        }
        break;
      }
      case 'quality': this.setQuality(msg.mode); break;
      case 'surround': {
        const L = msg.layout ? SURROUND_LAYOUTS[msg.layout] || null : null;
        this.surLayout = L;
        this.surSpread = L ? Math.max(0, Math.min(1, +msg.spread || 0)) : 0;
        for (const P of this.parts) if (P.space !== null) P.space.sgFresh = true;
        break;
      }
      case 'stemTap': if (msg.dry !== undefined) this.dryOut = msg.dry === 0 ? 0 : 1; if (msg.streams !== undefined) this.partStreams = !!msg.streams; break;
      case 'resoGpu': (this.resoGpu || (this.resoGpu = new ResoGpuLink(this))).message(msg); break;
      case 'tracks': this.setTracks(msg); break;
      case 'watch': {
        // part -1 (or any negative) turns telemetry off, e.g. for offline bounces
        const i = Math.round(finiteOr(msg.part, 0));
        if (i < 0) { this.watch = -1; this.teleCount = 0; } else if (i < MAX_PARTS) this.watch = i;
        break;
      }
      case 'transport':
        this.transport.playing = !!msg.playing;
        if (Number.isFinite(+msg.beatTime)) this.transport.beatTime = +msg.beatTime;
        if (Number.isFinite(+msg.beat)) this.transport.beat = +msg.beat;
        break;
      default: break;
    }
  }

  partAt(i) {
    const n = Math.round(finiteOr(i, -1));
    return n >= 0 && n < MAX_PARTS ? this.parts[n] : null;
  }

  /**
   * {t:'tracks', count, perm?, fresh?}: the host's track list changed.
   *   count  tracks in use (parts 0..count-1), 1..MAX_PARTS
   *   perm   optional, MAX_PARTS long: new part i is the old part perm[i]
   *          (a reorder moves the Part objects, so voices, envelopes, LFO
   *          phases and terrain tables carry on without a glitch)
   *   fresh  optional: indices of new tracks; their part starts clean
   * A part that drops out of the list releases its notes and fades out over
   * a few milliseconds (controlUpdate), then stops costing anything.
   */
  setTracks(msg) {
    const prevCount = this.count;
    const count = Math.max(1, Math.min(MAX_PARTS, Math.round(finiteOr(msg.count, prevCount))));
    const wasIn = new Set(this.parts.slice(0, prevCount));
    const perm = msg.perm;
    if (Array.isArray(perm) && perm.length === MAX_PARTS) {
      const seen = new Uint8Array(MAX_PARTS);
      let ok = true;
      for (const j of perm) {
        if (!Number.isInteger(j) || j < 0 || j >= MAX_PARTS || seen[j]) { ok = false; break; }
        seen[j] = 1;
      }
      if (ok) {
        const old = this.parts;
        const inv = new Int32Array(MAX_PARTS);
        this.parts = perm.map((j, i) => { inv[j] = i; return old[j]; });
        this.parts.forEach((P, i) => { P.index = i; if (P.sidechainIndex >= 0) P.sidechainIndex=inv[P.sidechainIndex]; });
        for (const e of this.events) e.part = inv[e.part];
        if (this.watch >= 0) this.watch = inv[this.watch];
      }
    }
    this.count = count;
    if (Array.isArray(msg.fresh)) {
      for (const f of msg.fresh) {
        const i = Math.round(finiteOr(f, -1));
        if (i >= 0 && i < count) this.resetPart(i);
      }
    }
    for (let i = count; i < MAX_PARTS; i++) {
      const P = this.parts[i];
      if (wasIn.has(P)) { this.releasePart(P); if (P.frozen !== null) P.fzTarget = 0; }
    }
    // queued notes and parameter changes of parts that left the list go with them
    if (this.events.some(e => e.part >= count)) this.events = this.events.filter(e => e.part < count);
  }

  /**
   * A brand-new part in slot `i` (a new track): default sound, silent, no
   * history. A slot still sounding (only when every other slot is taken, e.g.
   * a scene of 16 tracks replacing 16) is not cut off: its notes are released
   * and the new track's settings arrive on top, as before tracks existed.
   */
  resetPart(i) {
    const old = this.parts[i];
    if (old && (old.activeCount() > 0 || old.tail > 0 || (old.ghost !== null && old.ghost.left > 0) || (old.frozen !== null && old.fzGate > 0))) {
      this.releasePart(old);
      if (old.frozen !== null) old.fzTarget = 0;
      old.exit = 1;
      return;
    }
    const P = new Part(i, this.sr, this.os);
    P.weather = this.weather.out;
    P.pad = this.pad.out;
    P.rc.dcR = this.dcR;
    const air = this.airTabs[String(this.os)];
    if (air) { P.rc.tiltA = air.a; P.rc.airNorm = air.tab; }
    this.parts[i] = P;
    this.events = this.events.filter(e => e.part !== i);
    if (this.pristine) this.ensurePristine();
  }

  /** A part past the track count that has gone quiet: nothing to do for it. */
  dormant(P) {
    return P.index >= this.count && P.tail <= 0 && (P.ghost === null || P.ghost.left <= 0) && P.frozen === null && P.activeCount() === 0;
  }

  setParams(part, p) {
    const P = this.partAt(part);
    if (!P || !p || typeof p !== 'object') return;
    const oldMode = P.mode;
    for (const id in p) {
      const idx = PI[id];
      if (idx === undefined) continue;
      const val = +p[id];
      if (!Number.isFinite(val)) continue;
      this.writeParam(P, idx, val);
      if (P.rampOn[idx]) { P.rampOn[idx] = 0; P.nRamps--; }
    }
    P.updateDerived();
    this.prepareFeatures(P);
    this.resoParams(P);
    this.spaceParams(P);
    if (P.mode !== oldMode) this.releasePart(P);
  }

  /**
   * 2.10 Resonator settings from the part's parameters. The membrane is only
   * built (message time, not in process()) once Resonator is first switched on.
   */
  resoParams(P) {
    const prm = P.params;
    const mode = Math.round(prm[PI.resoOn]) || 0;
    if (P.reso === null) {
      if (mode === 0) return;
      P.reso = new Resonator(this.sr, this.quality);
      P.resoMorph = prm[PI.morph];
    }
    P.reso.configure(mode, prm[PI.resoMix], prm[PI.resoDecay], prm[PI.resoTone], prm[PI.resoSize], prm[PI.resoListen]);
    P.resoMode = P.reso.mode;
    if (Math.abs(prm[PI.morph] - P.resoMorph) > 0.01) { P.resoMorph = prm[PI.morph]; P.reso.dirty = true; }
    if (this.resoGpu) this.resoGpu.ensure(P);   // 2.12 GPU Resonator
  }

  /**
   * 2.12 3D sound on or off from the part's parameters. The head model is
   * only built (message time, not in process()) once 3D is first switched on;
   * switching it off fades back to the plain track and then stops running.
   */
  spaceParams(P) {
    const mode = Math.round(P.params[PI.space]) || 0;
    if (P.space === null) {
      if (mode === 0) return;
      P.space = new Binaural(this.sr);
    }
    const S = P.space;
    if (mode !== 0 && P.spaceMode === 0 && S.w <= 0) {
      // starting from the plain track: jump to the position, fade the 3D in
      this.spaceTarget(P, P.activeCount() > 0);
      S.reset();
      S.sgFresh = true;
    }
    P.spaceMode = mode;
    S.wT = mode !== 0 ? 1 : 0;
  }

  /** Where the part's 3D source is now (Follow dot reads the dot) and the head model's targets. */
  spaceTarget(P, modded) {
    const prm = P.params;
    let az = prm[PI.spaceAz], dist = prm[PI.spaceDist];
    if (P.spaceMode >= 2) {
      const cx = modded ? P.partPlain[M_CX] : prm[PI.centerX];
      const cy = modded ? P.partPlain[M_CY] : prm[PI.centerY];
      const d = dotToSpace(cx, cy);
      // right on the middle the direction is undefined: keep the last one
      az = d.r > 0.02 ? d.az : P.spaceAz;
      if (P.spaceMode === 3) dist = radiusToDistance(d.r);
    }
    P.spaceAz = az;
    P.space.target(az, prm[PI.spaceEl], dist, prm[PI.spaceAir] >= 0.5, false);
    if (this.surLayout !== null && P.spaceMode !== 0) P.space.surroundTarget(az, this.surLayout, CTRL);
  }

  /** Stiffness and lowest mode of the part's membrane from its terrains (about 1 ms at the standard grid). */
  resoDerive(P) {
    P.resoMorph = P.params[PI.morph];
    P.reso.derive(P.terrA, P.terrB, clamp01(P.resoMorph));
    P.resoAt = this.blockTime + 0.05;
    if (P.reso.feed) P.reso.feed.terrain();
  }

  /** Note pitch (Hz) as the voice computes it, without modulation. */
  resoNoteHz(P, pitch) {
    const prm = P.params;
    const semis = this.tuneSemis === null
      ? pitch + prm[PI.octave] * 12 + prm[PI.tune] + prm[PI.fine] / 100 + P.bend * prm[PI.bendRange]
      : this.tunedPitch(pitch + prm[PI.tune] + P.bend * prm[PI.bendRange]) + prm[PI.octave] * 12 + prm[PI.fine] / 100;
    return 440 * Math.exp((semis - 69) * (Math.LN2 / 12));
  }

  /** Strike mode: a note (re)starting on voice v hits the membrane at the dot. */
  resoStrike(P, v) {
    const R = P.reso;
    if (R === null || P.resoMode !== 1) return;
    if (!R.ready) this.resoDerive(P);
    R.setNote(this.resoNoteHz(P, v.pitch), true);
    R.setDot(v.sCx, v.sCy);
    R.strike(v.sCx, v.sCy, v.velGain);
  }

  /** The membrane for one host-rate segment of the part's output (in place). */
  resoBlock(P, oL, oR, pos, seg) {
    const R = P.reso;
    if (!R.ready || (R.dirty && this.blockTime >= P.resoAt)) this.resoDerive(P);
    let nv = null;
    for (const v of P.voices) if (v.active && v.gate && (nv === null || v.order > nv.order)) nv = v;
    if (nv !== null) { R.setNote(nv.hz, false); R.setDot(nv.cx, nv.cy); }
    R.control(seg);
    R.process(oL, oR, pos, seg);
  }

  writeParam(P, idx, val) {
    P.params[idx] = val;
    const m = MOD_SLOT[PART_PARAMS[idx].id];
    if (m !== undefined) P.baseNorm[m] = toNorm(MOD_DEFS[m], val);
  }

  /**
   * Allocation the audio callback must not do: Even tables around the current
   * Shape, comb delay lines when a part selects the Comb filter.
   */
  prepareFeatures(P) {
    if (P.travBits & 2) prepareEven(P.shapeI, P.orderI, P.params[PI.pathParam]);
    if (P.ftype === 5) this.ensureComb(P);
  }

  ensureComb(P) {
    const len = 1 << Math.ceil(Math.log2(2 * Math.ceil(this.fs2 / COMB_FMIN) + 8));
    for (const v of P.voices) {
      if (v.comb && v.combLen === len) continue;
      v.comb = new Float32Array(2 * len);
      v.combLen = len; v.cw = 0;
    }
  }

  setMods(part, mods) {
    const P = this.partAt(part);
    if (!P || !mods || typeof mods !== 'object') return;
    for (const id in mods) {
      const m = MOD_SLOT[id];
      const o = mods[id];
      if (m === undefined || !o || typeof o !== 'object') continue;
      if (o.lfoShape !== undefined) P.lfoShape[m] = Math.max(0, Math.min(6, Math.round(finiteOr(o.lfoShape, 0))));
      if (o.lfoRate !== undefined) P.lfoRate[m] = Math.max(0.01, Math.min(30, finiteOr(o.lfoRate, 0.5)));
      if (o.lfoSync !== undefined) P.lfoSync[m] = finiteOr(o.lfoSync, 0) ? 1 : 0;
      if (o.lfoDiv !== undefined) P.lfoDiv[m] = Math.max(0, Math.min(SYNC_DIVS.length - 1, Math.round(finiteOr(o.lfoDiv, 5))));
      if (o.lfoDepth !== undefined) P.lfoDepth[m] = Math.max(-1, Math.min(1, finiteOr(o.lfoDepth, 0)));
      if (o.envDepth !== undefined) P.envDepth[m] = Math.max(-1, Math.min(1, finiteOr(o.envDepth, 0)));
      if (o.retrig !== undefined) P.retrig[m] = finiteOr(o.retrig, 0) ? 1 : 0;
      for (const field of NEW_MOD_FIELDS) {
        if (o[field] === undefined) continue;
        let x=finiteOr(o[field],MOD_DEFAULT[field]);
        if (field === 'lfoPhase' || field === 'stepGlide' || field === 'stepSmooth' || field === 'envOwn') x=clamp01(x);
        else if (field === 'lfoSkew') x=clampPM1(x);
        else if (field === 'lfoCount') x=Math.max(0,Math.min(32,Math.round(x)));
        else x=Math.max(0,Math.min(8,x));
        const target=field === 'lfoPhase' ? P.lfoStart : P[field];
        if ((field === 'lfoDelay' || field === 'lfoCount') && target[m] !== x) { P.lfoAge[m]=0; P.lfoCycles[m]=0; }
        target[m]=x;
      }
      if (o.lfoOffset !== undefined) P.lfoValueOffset[m]=clampPM1(finiteOr(o.lfoOffset,0));
      for (let i=0;i<ENV_IDS.length;i++) if (o[ENV_IDS[i]] !== undefined) {
        const value=finiteOr(o[ENV_IDS[i]],MOD_DEFAULT[ENV_IDS[i]]);
        P.envConfig[m][i]=i === 4 ? clamp01(value) : i === 6 ? Math.max(0,Math.min(5,Math.round(value))) : Math.max(0,Math.min(i === 5 ? 10 : 8,value));
      }
      for (let i=0;i<4;i++) {
        const n=m*4+i,prefix='ctrl'+(i+1);
        if (o[prefix+'Source'] !== undefined) P.ctrlSrc[n]=Math.max(0,Math.min(NSRC-1,Math.round(finiteOr(o[prefix+'Source'],0))));
        if (o[prefix+'Depth'] !== undefined) P.ctrlDepth[n]=clampPM1(finiteOr(o[prefix+'Depth'],0));
        if (o[prefix+'Curve'] !== undefined) P.ctrlCurve[n]=Math.max(0,Math.min(NCURVES-1,Math.round(finiteOr(o[prefix+'Curve'],0))));
      }
      if (o.steps !== undefined && o.steps !== null && typeof o.steps.length === 'number') {
        const base = m * LFO_STEP_COUNT;
        for (let s = 0; s < LFO_STEP_COUNT; s++) {
          const x = s < o.steps.length ? finiteOr(o.steps[s], DEFAULT_LFO_STEPS[s]) : DEFAULT_LFO_STEPS[s];
          P.lfoSteps[base + s] = clampPM1(x);
        }
      }
    }
    this.updateLinkFlags(P);
  }

  /** A custom, host-rate recording. Sanitization and seam fading happen on message receipt. */
  setNoiseRecording(part, source) {
    const P=this.partAt(part); if (!P) return;
    if (!source || typeof source.length !== 'number' || source.length < 2) { P.recording=null; return; }
    const length=Math.min(Math.floor(source.length),Math.round(this.sr*MAX_NOISE_SECONDS));
    const data=new Float32Array(length);
    let mean=0;
    for (let i=0;i<length;i++) { const x=Math.max(-1,Math.min(1,finiteOr(source[i],0))); data[i]=x; mean+=x; }
    mean/=length;
    for (let i=0;i<length;i++) data[i]-=mean;
    P.recording=fadeLoop(data,this.sr);
  }

  triggerExtraEnvelopes(P,v,keep) {
    v.ampExtra.configure(P.ampConfig,1/this.fs2); v.env2Extra.configure(P.env2Config,CTRL/this.sr);
    v.ampExtra.trigger(keep); v.env2Extra.trigger(keep);
    v.ampCustom=P.ampCustom; v.env2Custom=P.env2Custom;
    for (let m=0;m<NMOD;m++) if (P.envOwn[m]) { v.ownEnvs[m].configure(P.envConfig[m],CTRL/this.sr); v.ownEnvs[m].trigger(keep); }
  }

  partControllerSource(P,s) {
    if (s === L_WHEEL) return P.wheel;
    if (s >= L_MACRO && s < L_MACRO+4) return this.macros[s-L_MACRO];
    if (s === L_MSPEED) return P.sMarbleSpeed;
    if (s === L_MHEIGHT) return P.sMarbleHeight;
    if (s === L_GUITAR) return this.sGuitar;
    if (s === L_VOICE) return this.sVoice;
    if (s === L_EXPRESSION) return P.expression;
    if (s === L_SUSTAIN) return P.sustainLevel;
    if (s === L_BREATH) return P.breath;
    if (s >= L_SCIENCE && s <= L_SCIENCE_END) return this.science.out[s - L_SCIENCE];
    if (s === L_TURING) return this.science.out[SCI_TURING];
    if (s >= L_WEATHER && s <= L_WEATHER_END) return this.weather.out[s - L_WEATHER];
    if (s >= L_PAD && s <= L_PAD_END) return this.pad.out[s - L_PAD];
    return 0;
  }

  /** New controls use their own ramps. The zero default never touches the old oscillator path. */
  controlExtras(P,v,snap,f,k,inv) {
    const MP=v.modPlain, ex=v.ex, target=v.exTarget, delta=v.dex, fs=this.fs2;
    for (let i=0;i<NEX;i++) {
      const value=MP[EXTRA_SLOTS[i]];
      target[i]=snap || Math.abs(value-target[i]) < SNAP ? value : target[i]+(value-target[i])*k;
      if (snap) { ex[i]=target[i]; delta[i]=0; } else delta[i]=(target[i]-ex[i])*inv;
    }
    v.subKind=Math.max(0,Math.min(6,Math.round(P.params[PI.subWave])));
    v.sub2Kind=Math.max(0,Math.min(6,Math.round(P.params[PI.sub2Wave])));
    v.airKind=Math.max(0,Math.min(8,Math.round(P.params[PI.airType])));
    v.pathMirror=Math.max(0,Math.min(3,Math.round(P.params[PI.pathMirror])));
    v.ringInc=Math.min(0.45,f*target[EX.ringRatio]/fs);
    v.pmInc=Math.min(0.45,f*target[EX.phaseRatio]/fs);
    if (target[EX.inharmAmount] > 0 || ex[EX.inharmAmount] > 0) {
      let total=0;
      for (let i=0;i<PROFILE_PARTIALS;i++) {
        const frequency=f*profileRatio(target[EX.inharmProfile],i);
        const taper=frequency < this.sr*0.4 ? 1 : Math.max(0,(this.sr*0.49-frequency)/(this.sr*0.09));
        const gain=taper/Math.pow(i+1,1.2);
        v.partialInc[i]=Math.min(0.49,frequency/fs); v.partialGain[i]=gain; total+=gain;
      }
      if (total > 0) for (let i=0;i<PROFILE_PARTIALS;i++) v.partialGain[i]/=total;
    }
    const level=v.airKind ? AIR_RMS*MP[MOD_SLOT.air]*MP[MOD_SLOT.air] : 0;
    if (snap) { v.extraAir=level; v.dExtraAir=0; } else v.dExtraAir=(level-v.extraAir)*inv;
    if (target[EX.pluck] > 0 || ex[EX.pluck] > 0) {
      if (!v.stringOn) { v.string.trigger(f,target[EX.pluckDecay],target[EX.pluckTone],target[EX.pluckDispersion],v.nz); v.stringOn=true; }
      else v.string.tune(f,target[EX.pluckDecay],target[EX.pluckTone],target[EX.pluckDispersion]);
    }
    v.ampExtra.configure(P.ampConfig,1/fs); v.env2Extra.configure(P.env2Config,CTRL/this.sr);
    // Moving from the legacy ADSR adopts its current level without restarting the note.
    if (P.ampCustom && !v.ampCustom) { v.ampExtra.value=v.envLvl; v.ampExtra.stage=v.gate ? 4 : 6; v.ampExtra.elapsed=0; }
    if (P.env2Custom && !v.env2Custom) { v.env2Extra.value=v.env2Lvl; v.env2Extra.stage=v.gate ? 4 : 6; v.env2Extra.elapsed=0; }
    v.ampCustom=P.ampCustom; v.env2Custom=P.env2Custom;
  }

  /** Shaped paths and phase modulation trace arbitrary phases using the same scalar path contract. */
  extraPaths(P,v,n2,trav,shape,order) {
    const point=this.pt, ex=v.ex,dex=v.dex;
    for (let q=0;q<v.uRun;q++) {
      let phase=v.phase[q],inc=v.inc[q],pm=v.pmPh,param=v.param,pace=v.pace,laps=v.laps;
      let depth=ex[EX.phaseMod],window=ex[EX.pathWindow],mangle=ex[EX.pathMangle],wa=ex[EX.warpAmount];
      const X=this.xs[q],Y=this.ys[q],wm=P.warpMode;
      for (let j=0;j<n2;j++) {
        phase+=inc; phase-=Math.floor(phase); inc+=v.dinc[q]; pm+=v.pmInc; pm-=Math.floor(pm);
        param+=v.dParam; pace+=v.dPace; laps+=v.dLaps;
        depth+=dex[EX.phaseMod]; window+=dex[EX.pathWindow]; mangle+=dex[EX.pathMangle]; wa+=dex[EX.warpAmount];
        let t=phase+0.25*depth*fastSin(pm); t-=Math.floor(t);
        const tc=t;                      // cycle phase before warping (Flip and Spiral use it)
        if (wm === 1) { const w=1-0.95*(wa<0?0:wa>1?1:wa); t=t<w?t/w:1; }                       // PWM: trace, then wait at the end
        else if (wm === 2) { const s=Math.round(2+254*Math.pow(1-(wa<0?0:wa>1?1:wa),3)); t=Math.floor(t*s)/s; }   // Quantize
        t=laps*paceWarp(t,pace,v.paceShape); t-=Math.floor(t);
        if (trav) t=this.travelMap(shape,order,t,param,trav);
        pathPoint(shape,t,order,param,point);
        shapePathPoint(point.x,point.y,t,window,mangle,v.pathMirror,point);
        let px=point.x,py=point.y;
        if (wm === 3 && tc > 1-0.5*wa) { px=-px; py=-py; }                                        // Flip: the end of the cycle through the centre
        else if (wm === 4) { const k=1-wa*tc; px*=k; py*=k; }                                     // Spiral: shrink through the cycle
        X[j]=px; Y[j]=py;
      }
      v.phase[q]=phase; v.inc[q]=inc; v.blepPend[q]=0; v.blepSkip[q]=0;
    }
  }

  /** Additive bank, ring mod, string, second sub and alternate air before the voice chain. */
  renderExtras(P,v,n2,rc) {
    const ex=v.ex,dx=v.dex,SL=this.sumL,SR=this.sumR;
    const bank=ex[EX.inharmAmount] !== 0 || dx[EX.inharmAmount] !== 0;
    const ring=ex[EX.ringMod] !== 0 || dx[EX.ringMod] !== 0;
    const pluck=ex[EX.pluck] !== 0 || dx[EX.pluck] !== 0;
    const air=v.extraAir !== 0 || v.dExtraAir !== 0;
    let rm=v.ringPh,pm=v.pmPh,position=v.texturePos,level=v.extraAir;
    const data=v.airKind === 8 ? P.recording : (v.airKind >= 5 ? P.textures[v.airKind-5] : null);
    if (bank || ring || pluck || air) {
      for (let j=0;j<n2;j++) {
        for (let i=0;i<NEX;i++) ex[i]+=dx[i];
        let left=SL[j],right=v.stereo ? SR[j] : left;
        if (bank) {
          let value=0;
          for (let i=0;i<PROFILE_PARTIALS;i++) {
            let phase=v.partialPhase[i]+v.partialInc[i]; phase-=Math.floor(phase); v.partialPhase[i]=phase;
            value+=v.partialGain[i]*fastSin(phase);
          }
          left+=ex[EX.inharmAmount]*(value-left); right+=ex[EX.inharmAmount]*(value-right);
        }
        if (pluck) { const value=v.string.sample(); left+=ex[EX.pluck]*(value-left); right+=ex[EX.pluck]*(value-right); }
        if (ring) { rm+=v.ringInc; rm-=Math.floor(rm); const multiplier=1-ex[EX.ringMod]+ex[EX.ringMod]*fastSin(rm); left*=multiplier; right*=multiplier; }
        if (air) {
          level+=v.dExtraAir;
          if (data) { const value=level*loopSample(data,position+ex[EX.airTexture]*data.length); left+=value; right+=value; position+=1/rc.os; if (position >= data.length) position-=data.length; }
          else if (v.airKind < 5) { left+=level*v.colourL.sample(v.airKind); right+=level*v.colourR.sample(v.airKind); }
        }
        SL[j]=left; if (v.stereo) SR[j]=right;
      }
    } else for (let i=0;i<NEX;i++) ex[i]+=dx[i]*n2;
    pm+=v.pmInc*n2; pm-=Math.floor(pm);
    v.pmPh=pm; v.ringPh=rm; v.texturePos=position; v.extraAir=level;
  }

  analogBlock(v,L,R,n,stereo,current) {
    const filter=v.analog[current ? v.analogCurrent : 1-v.analogCurrent];
    const type=current ? v.ft : v.ftOld;
    // Coefficients are prepared once per segment; interpolation of the input/output
    // and the existing 8ms type crossfade handle control-rate changes.
    filter.configure(type,v.g+v.dg*n,Math.max(0,Math.min(1,(2-v.k-v.dk*n)/1.97)),v.sFormant);
    for (let j=0;j<n;j++) { L[j]=filter.sample(L[j],0); if (stereo) R[j]=filter.sample(R[j],1); }
  }

  setGlobal(p) {
    if (!p || typeof p !== 'object') return;
    let sci = null;
    for (const k in SCIENCE_KEYS) if (p[k] !== undefined && Number.isFinite(+p[k])) (sci || (sci = {}))[SCIENCE_KEYS[k]] = +p[k];
    if (sci) this.science.configure(sci);
    if (p.tempo !== undefined) this.tempo = Math.max(20, Math.min(400, finiteOr(p.tempo, this.tempo)));
    // v2.8 send buses: remember their settings; configure them if they exist
    let sendDirty = false;
    if (p.tempo !== undefined && this.sendCfg.tempo !== this.tempo) { this.sendCfg.tempo = this.tempo; sendDirty = true; }
    for (const id of SEND_GLOBAL_IDS) if (p[id] !== undefined && Number.isFinite(+p[id])) { this.sendCfg[id] = +p[id]; sendDirty = true; }
    if (sendDirty && this.sendFx !== null) this.sendFx.configure(this.sendCfg);
    for (const id of ['vectorMix','vectorX','vectorY']) if (p[id] !== undefined) this[id]=clamp01(finiteOr(p[id],this[id]));
    if (p.vectorBank !== undefined) this.vectorBank=Math.max(0,Math.min(3,Math.round(finiteOr(p.vectorBank,0))));
    const x=this.vectorX,y=this.vectorY,m=this.vectorMix;
    this.vectorWeights[0]=1-m+m*Math.sqrt((1-x)*(1-y)); this.vectorWeights[1]=1-m+m*Math.sqrt(x*(1-y));
    this.vectorWeights[2]=1-m+m*Math.sqrt((1-x)*y); this.vectorWeights[3]=1-m+m*Math.sqrt(x*y);
    for (const P of this.parts) if (P.activeCount() === 0 && P.tail <= 0) {
      const bank=P.index-this.vectorBank*4;
      P.vectorGain=P.vectorSmooth=bank >= 0 && bank < 4 ? this.vectorWeights[bank] : 1; P.dVector=0;
    }
    for (let i = 0; i < 4; i++) {
      const v = p['macro' + (i + 1)];
      if (v !== undefined) this.macros[i] = clamp01(finiteOr(v, this.macros[i]));
    }
  }

  /** {t:'pressure' | 'slide', part, v, note?}: channel-wide, or one note's (poly AT / MPE). */
  setTouch(msg, field) {
    const P = this.partAt(msg.part);
    if (!P) return;
    let v = finiteOr(msg.v, 0);
    if (v > 1) v /= 127;
    v = clamp01(v);
    const note = msg.note === undefined || msg.note === null ? NaN : +msg.note;
    if (Number.isFinite(note)) {
      for (const vc of P.voices) if (vc.active && sameNote(vc.note, note)) vc[field] = v;
    } else if (field === 'press') P.pressure = v;
    else P.slide = v;
  }

  setLinks(part, links) {
    const P = this.partAt(part);
    if (!P || !Array.isArray(links)) return;
    let n = 0;
    for (const l of links) {
      if (n >= MAX_LINKS) break;
      if (!l || typeof l !== 'object') continue;
      const m = MOD_SLOT[l.dst];
      if (m === undefined) continue;
      const src = Math.round(finiteOr(l.src, -1));
      if (src < 0 || src >= NSRC) continue;
      P.lkSrc[n] = src;
      P.lkDst[n] = m;
      P.lkAmt[n] = clampPM1(finiteOr(l.amt, 0));
      P.lkCurve[n] = Math.max(0, Math.min(NCURVES - 1, Math.round(finiteOr(l.curve, 0))));
      const via = Math.round(finiteOr(l.via, -1));
      P.lkVia[n] = via >= 0 && via < NSRC ? via : -1;
      P.lkPart[n] = PART_SOURCE[src] && (P.lkVia[n] < 0 || PART_SOURCE[P.lkVia[n]]) ? 1 : 0;
      n++;
    }
    P.nLinks = n;
    this.updateLinkFlags(P);
    P.updatePartLinks(this.macros, this.sGuitar, this.sVoice, this.science.out);
  }

  /** Which slots need per-voice evaluation, and whether the orbit is modulated per voice. */
  updateLinkFlags(P) {
    P.vLinked.fill(0);
    P.voiceLinks = false; P.needTerrH = false;
    for (let i = 0; i < P.nLinks; i++) {
      const s = P.lkSrc[i];
      if (s === L_TERRAIN || P.lkVia[i] === L_TERRAIN) P.needTerrH = true;
      if (P.lkPart[i]) continue;
      P.vLinked[P.lkDst[i]] = 1;
      P.voiceLinks = true;
    }
    for (let m=0;m<NMOD;m++) for (let i=0;i<4;i++) {
      const c=m*4+i; if (!P.ctrlDepth[c]) continue;
      P.vLinked[m]=1; P.voiceLinks=true;
      if (P.ctrlSrc[c] === L_TERRAIN) P.needTerrH=true;
    }
    P.voiceModCount=0;
    for (let m=0;m<NMOD;m++) if (P.vLinked[m] || P.envDepth[m] || P.envOwn[m]) P.voiceModSlots[P.voiceModCount++]=m;
    let orbit = false, mean = false;
    for (const m of ORBIT_SLOTS) if (P.vLinked[m] || P.envDepth[m] !== 0) orbit = true;
    for (const m of MEAN_SLOTS) if (P.vLinked[m] || P.envDepth[m] !== 0) mean = true;
    P.orbitVoiceMod = orbit;
    P.trackMean = mean;
  }

  setTerrain(part, slot, levels) {
    const P = this.partAt(part);
    if (!P || !Array.isArray(levels)) return;
    const chain = [];
    for (const L of levels) {
      if (!L) continue;
      const size = Math.round(finiteOr(L.size, 0));
      const d = L.data;
      if (!isPow2(size) || !d || typeof d.length !== 'number' || d.length < size * size) continue;
      if (chain.length && size >= chain[chain.length - 1].size) continue;
      chain.push({ size, data: d instanceof Float32Array ? d : Float32Array.from(d) });
    }
    if (!chain.length) return;
    extendChain(chain);
    P.terrGen++;
    if (P.reso !== null) P.reso.dirty = true;
    const isB = slot === 1 || slot === 'B' || slot === 'b';
    const live = P.activeCount() > 0 || (P.ghost !== null && P.ghost.left > 0);
    if (isB) {
      if (live) { P.oldB = P.terrB; P.fadeB = 1; P.fadeBCur = 1; P.dFadeB = 0; }
      P.terrB = chain;
    } else {
      if (live) { P.oldA = P.terrA; P.fadeA = 1; P.fadeACur = 1; P.dFadeA = 0; }
      P.terrA = chain;
    }
  }

  schedule(type, msg) {
    const P = this.partAt(msg.part);
    if (!P || (type === 1 && P.index >= this.count)) return;
    const note = +msg.note;
    if (!Number.isFinite(note)) return;
    const time = finiteOr(msg.time, 0);
    const vel = finiteOr(msg.vel, 0.8);
    const tag = typeof msg.tag === 'string' ? msg.tag : null;
    const slice = Number.isInteger(msg.slice) && msg.slice >= 0 && msg.slice < 32 ? msg.slice : null;
    if (time <= 0 || time <= this.lastTime) {
      if (type === 1) this.noteOn(P, note, vel, tag, slice); else this.noteOff(P, note);
      return;
    }
    this.insertEvent({ type, part: P.index, note, vel, time, p: null, ramp: 0, tag, slice });
  }

  /**
   * {t:'cancelNotes', after, tag?}: drop queued note-ons later than `after`
   * (only those carrying `tag` when given) together with each one's own
   * note-off, so a stopped sequence does not keep playing what it had
   * scheduled ahead. Notes already sounding keep their scheduled note-off.
   */
  cancelNotes(after, tag) {
    const t = finiteOr(after, 0);
    const want = typeof tag === 'string' ? tag : null;
    const E = this.events;
    const drop = new Set();
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (e.type !== 1 || e.time <= t || (want !== null && e.tag !== want) || drop.has(e)) continue;
      drop.add(e);
      for (let j = i + 1; j < E.length; j++) {
        const o = E[j];
        if (o.type === 0 && o.part === e.part && o.note === e.note && o.tag === e.tag && !drop.has(o)) { drop.add(o); break; }
      }
    }
    if (drop.size) this.events = E.filter(e => !drop.has(e));
  }

  /** Sorted insert; at equal times parameter changes go before notes (a note sees its step's params). */
  insertEvent(ev) {
    const E = this.events;
    let i = E.length;
    while (i > 0 && (E[i - 1].time > ev.time || (ev.type === 2 && E[i - 1].type !== 2 && E[i - 1].time === ev.time))) i--;
    E.splice(i, 0, ev);
  }

  /** {t:'params', part, p, time?, ramp?}: sample-accurate and/or gliding parameter changes. */
  scheduleParams(msg) {
    const P = this.partAt(msg.part);
    const p = msg.p;
    if (!P || !p || typeof p !== 'object') return;
    const vals = {};
    let any = false;
    for (const id in p) {
      if (PI[id] === undefined) continue;
      const v = +p[id];
      if (!Number.isFinite(v)) continue;
      vals[id] = v; any = true;
    }
    if (!any) return;
    const ramp = Math.max(0, finiteOr(msg.ramp, 0));
    const time = finiteOr(msg.time, 0);
    if (vals.filterType !== undefined && Math.round(vals.filterType) === 5) this.ensureComb(P);
    if (vals.traverse !== undefined && Math.round(vals.traverse) === 1) {
      prepareEven(vals.pathShape ?? P.shapeI, vals.pathOrder ?? P.orderI, vals.pathParam ?? P.params[PI.pathParam]);
    }
    if (time > 0 && time > this.lastTime) {
      this.insertEvent({ type: 2, part: P.index, note: 0, vel: 0, time, p: vals, ramp });
    } else {
      // due now: starts with the next block (no forced control update, like any other message)
      this.applyParams(P, vals, ramp, this.nextTime > this.lastTime ? this.nextTime : this.lastTime, false);
    }
  }

  /**
   * Apply a parameter change at `time`: continuous params glide linearly over
   * `ramp` seconds (wrap-aware for rotate / centerX / centerY), the rest
   * jump. `force` starts a control block right here, so the change is heard
   * from this very sample rather than from the next control boundary.
   */
  applyParams(P, vals, ramp, time, force) {
    const oldMode = P.mode;
    for (const id in vals) {
      const idx = PI[id];
      const target = vals[id];
      if (ramp > 0 && RAMPABLE[idx]) {
        const start = P.params[idx];
        const range = WRAP_RANGE[idx];
        const delta = range > 0 ? wrapHalf((target - start) / range) * range : target - start;
        if (!P.rampOn[idx]) { P.rampOn[idx] = 1; P.nRamps++; }
        P.rampStart[idx] = start; P.rampDelta[idx] = delta; P.rampT0[idx] = time; P.rampDur[idx] = ramp;
      } else {
        if (P.rampOn[idx]) { P.rampOn[idx] = 0; P.nRamps--; }
        this.writeParam(P, idx, target);
      }
    }
    P.updateDerived();
    this.resoParams(P);
    this.spaceParams(P);
    if (P.mode !== oldMode) this.releasePart(P);
    if (force) this.ctrlRemain = 0;
  }

  /** Advance the part's timed ramps to the current control block. */
  advanceRamps(P) {
    const t = this.blockTime;
    let touched = false;
    for (let idx = 0; idx < NPARAMS; idx++) {
      if (!P.rampOn[idx]) continue;
      const dur = P.rampDur[idx];
      let x = dur > 0 ? (t - P.rampT0[idx]) / dur : 1;
      if (x < 0) continue;
      if (x >= 1) { x = 1; P.rampOn[idx] = 0; P.nRamps--; }
      let val = P.rampStart[idx] + P.rampDelta[idx] * x;
      const range = WRAP_RANGE[idx];
      if (range > 0) val -= Math.floor(val / range) * range;
      this.writeParam(P, idx, val);
      touched = true;
    }
    if (touched) { P.updateDerived(); this.resoParams(P); this.spaceParams(P); }
  }

  allOff(part) {
    const only = part === undefined || part === null ? null : this.partAt(part);
    if (part !== undefined && part !== null && !only) return;
    for (const P of this.parts) {
      if (only && P !== only) continue;
      this.releasePart(P);
    }
    // note events of the affected parts are dropped; scheduled parameter changes stay
    this.events = this.events.filter(e => e.type === 2 || (only && e.part !== only.index));
  }

  releasePart(P) {
    if (P.smp !== null) P.smp.allOff();
    for (const v of P.voices) {
      if (v.pending) v.pending = false;
      if (v.active) this.releaseVoice(v, true);
    }
    P.stackLen = 0;
  }

  panic() {
    this.events.length = 0;
    if (this.sendFx !== null) this.sendFx.reset();
    for (const P of this.parts) {
      for (const v of P.voices) { v.active = false; v.gate = false; v.resetState(); }
      P.stackLen = 0;
      P.busL.fill(0); P.busR.fill(0); P.midL.fill(0); P.midR.fill(0);
      P.tail = 0; P.effects.reset(); P.rawPeak=P.previousRawPeak=0;
      P.oldA = P.oldB = null; P.fadeA = P.fadeB = P.fadeACur = P.fadeBCur = 0;
      if (P.ghost) P.ghost.left = 0;
      if (P.smp !== null) P.smp.allOff(true);
    }
  }

  // ---- quality ----------------------------------------------------------------

  /** {t:'quality', mode}. Changing the rate or the mips crossfades from a frozen copy of the voices. */
  setQuality(mode) {
    const q = QUALITY[mode];
    if (!q) return;
    if (this.parts.some(P => P.ghost !== null && P.ghost.left > 0)) { this.pendingQuality = mode; return; }
    this.pendingQuality = null;
    if (mode === this.quality) return;
    const reshape = q.os !== this.os || q.mipShift !== this.mipShift;
    if (reshape) {
      for (const P of this.parts) if (P.activeCount() > 0 || P.tail > 0) this.startGhost(P);
    }
    const ratio = this.os / q.os;
    const osChanged = q.os !== this.os;
    this.quality = mode;
    this.os = q.os;
    this.mipShift = q.mipShift;
    this.pristine = q.pristine;
    this.setRateConstants();
    const fsOld = this.fs2 * ratio;
    for (const P of this.parts) {
      P.os = q.os;
      P.updateDerived();
      if (P.reso !== null) P.reso.setQuality(mode);
      if (osChanged) {
        P.hist = q.os === 4 ? HB1_HIST : HB_HIST;
        P.rc.hist = P.hist;
        P.busL.fill(0); P.busR.fill(0); P.midL.fill(0); P.midR.fill(0);
        if (P.ftype === 5 || P.voices.some(v => v.comb)) this.ensureComb(P);
        for (const v of P.voices) {
          // per-sample increments follow the rate; everything else is
          // re-ramped by the control update forced below
          for (let k = 0; k < MAX_UNISON; k++) { v.inc[k] *= ratio; v.dinc[k] = 0; }
          v.subInc *= ratio; v.dSubInc = 0;
          v.ringInc *= ratio; v.pmInc *= ratio; v.partialInc.forEach((inc,i) => { v.partialInc[i]=inc*ratio; });
          v.renderRate=this.fs2; v.colourL.setRate(this.fs2); v.colourR.setRate(this.fs2);
          // The outgoing ghost sustains the old string while a new-rate excitation crossfades in.
          v.string.sampleRate=this.fs2; v.stringOn=false;
          v.stealStep *= ratio;
          v.ftDW *= ratio; v.travDW *= ratio;
          // same cutoff at the new rate
          const fc = Math.atan(v.g) * fsOld / Math.PI;
          v.g = Math.tan(Math.PI * Math.min(fc, 0.45 * this.fs2) / this.fs2);
          v.cD /= ratio;
          for (let i = 0; i < 3; i++) {
            const fv = Math.atan(v.vf[i]) * fsOld / Math.PI;
            v.vf[i] = Math.tan(Math.PI * Math.min(fv, 0.45 * this.fs2) / this.fs2);
          }
          if (v.comb) v.comb.fill(0);
          v.cw = 0;
          v.tabValid = false; v.tw = 0; v.dtw = 0;
        }
      }
      if (!this.pristine) for (const v of P.voices) v.dtw = v.tw > 0 ? -1 / (TABLE_FADE * this.fs2) : 0;
    }
    if (this.pristine) this.ensurePristine();
    this.ctrlRemain = 0;
  }

  ensurePristine() {
    if (!this.fft) {
      this.fft = new FFT(TAB_MAX);
      this.fre = new Float64Array(TAB_MAX); this.fim = new Float64Array(TAB_MAX);
      this.tT = new Float64Array(TAB_MAX);
      this.tX = new Float64Array(TAB_MAX); this.tY = new Float64Array(TAB_MAX); this.tLv = new Float64Array(TAB_MAX);
    }
    // Only parts that can sound need the tables; a track added later gets
    // them from setTracks -> resetPart, or here on the next quality change.
    for (const P of this.parts) {
      if (P.index >= this.count && P.activeCount() === 0) continue;
      for (const v of P.voices) {
        if (!v.tabA) { v.tabA = new Float64Array(TAB_MAX + 3); v.tabB = new Float64Array(TAB_MAX + 3); }
      }
    }
  }

  /** Freeze a copy of the part's voices and decimator state in the outgoing quality. */
  startGhost(P) {
    let g = P.ghost;
    if (!g) {
      const n = P.outL.length;
      g = P.ghost = {
        voices: P.voices.map((_, i) => new Voice(i, this.sr, this.os)),
        busL: new Float64Array(P.busL.length), busR: new Float64Array(P.busR.length),
        midL: new Float64Array(P.midL.length), midR: new Float64Array(P.midR.length),
        outL: new Float64Array(n), outR: new Float64Array(n),
        left: 0, total: 0, rc: null,
      };
    }
    g.rc = { ...P.rc, busL: g.busL, busR: g.busR };
    g.busL.fill(0); g.busR.fill(0); g.midL.fill(0); g.midR.fill(0);
    g.busL.set(P.busL.subarray(0, P.hist)); g.busR.set(P.busR.subarray(0, P.hist));
    g.midL.set(P.midL.subarray(0, HB_HIST)); g.midR.set(P.midR.subarray(0, HB_HIST));
    for (let i = 0; i < P.voices.length; i++) {
      const v = P.voices[i], gv = g.voices[i];
      gv.copyFrom(v);
      gv.pending = false;
      if (v.comb) {
        if (!gv.comb || gv.comb.length !== v.comb.length) gv.comb = new Float32Array(v.comb.length);
        gv.comb.set(v.comb);
      }
      // frozen: every control ramp stops where it is for the ~12 ms fade
      gv.dtA = gv.dtB = gv.dtC = gv.dtD = gv.dcx = gv.dcy = 0;
      gv.dMorph = gv.dWarp = gv.dLift = gv.dFold = gv.dParam = 0;
      gv.dg = gv.dk = gv.dDrive = gv.dgl = gv.dgr = 0;
      gv.dwA = gv.dwB = gv.dcLvA = gv.dcLvB = gv.dLaps = gv.dPace = 0;
      gv.dSubInc = gv.dSubLv = gv.daH = gv.daD = 0; gv.dex.fill(0); gv.dExtraAir=0;
      gv.dcD = gv.dcFb = gv.dcFf = gv.dcMk = 0;
      gv.dvf.fill(0); gv.dinc.fill(0);
      gv.dugL.fill(0); gv.dugR.fill(0); gv.gRamp = false; gv.dMean = 0;
      gv.tw = 0; gv.dtw = 0; gv.travW = 0; gv.ftW = 0;
    }
    g.total = g.left = Math.max(CTRL, Math.round(QUALITY_FADE * this.sr));
  }

  // ---- notes ----------------------------------------------------------------

  heldCount(P) {
    if (P.mode !== 0) return P.stackLen;
    let n = 0;
    for (const v of P.voices) if ((v.active && v.gate) || v.pending) n++;
    return n;
  }

  retrigLfos(P) {
    for (let m = 0; m < NMOD; m++) {
      if (!P.retrig[m]) continue;
      if (P.lfoSync[m] && this.transport.playing) {
        const beats = this.currentBeats();
        const div = SYNC_DIVS[P.lfoDiv[m]].beats;
        const ph = beats / div;
        P.lfoOffset[m] = -(ph - Math.floor(ph));
      } else {
        P.lfoOffset[m] = 0;
      }
      P.lfoPhase[m] = 0; P.lfoAge[m]=0; P.lfoCycles[m]=0;
      const shape = P.lfoShape[m];
      if (shape === 4 || shape === 5) { P.lfoR0[m] = P.lfoR1[m]; P.lfoR1[m] = (LEGACY_MOD_MASK[m] ? P.rng() : P.extraRng()) * 2 - 1; }
      P.lfoVal[m] = shape === 6 ? P.lfoSteps[m * LFO_STEP_COUNT + LFO_STEP_COUNT - 1] : lfoValue(shape, 0, P.lfoR0[m], P.lfoR1[m]);
    }
    this.partMods(P);
  }

  /** v2.7: switch a track's drum kit on or off and load its pads ({synth: i} or {pcm, rate}). */
  /**
   * v2.8 {t:'freeze', part, L, R, frames, beats}: play the loop L/R (the
   * part's own output, `frames` long, fractional, covering `beats` beats at
   * the tempo it was rendered at) instead of the part's voices, in step with
   * the transport. Without L/R the part goes back to its voices. Both ways the
   * change is a short crossfade.
   */
  setFrozen(msg) {
    const P = this.partAt(msg.part);
    if (!P) return;
    const L = msg.L, R = msg.R, len = +msg.frames, beats = +msg.beats;
    if (L instanceof Float32Array && R instanceof Float32Array && len > 1 && beats > 0
      && L.length >= Math.ceil(len) && R.length >= Math.ceil(len)) {
      const was = P.frozen !== null && P.fzTarget >= 1;
      P.frozen = { L, R, len, beats };
      P.fzTarget = 1;
      if (!was) P.fzGate = this.transport.playing ? 1 : 0;
    } else if (P.frozen !== null) {
      P.fzTarget = 0;
      if (P.fzX <= 0) P.frozen = null;
    }
  }

  setKit(part, msg) {
    const P = this.partAt(part);
    if (!P) return;
    P.kitOn = !!msg.on;
    if (!P.kitOn) return;
    if (!P.kit) P.kit = new KitPlayer(this.sr);
    const pads = Array.isArray(msg.pads) ? msg.pads : [];
    pads.forEach((pd, i) => {
      if (!pd) return;
      const set = { gain: pd.gain, pitch: pd.pitch, decay: pd.decay, pan: pd.pan, choke: pd.choke };
      // keep: the pad's sound is unchanged, so only its settings move
      if (!pd.keep) {
        if (pd.pcm instanceof Float32Array) { set.data = pd.pcm; set.rate = pd.rate; }
        else if (Number.isInteger(pd.synth) && pd.synth >= 0) {
          set.data = this.drumSound(pd.synth); set.rate = this.sr;
        } else set.data = null;
      }
      P.kit.setPad(i, set);
    });
  }

  /**
   * 2.13 {t:'sampler', part, on, cfg, pcm?, rate?, keep?}: switch a track's
   * sampler on or off, set its playback settings and (unless `keep`) its
   * audio (Float32Array at `rate`, optional `pcmR` of the same length).
   */
  setSampler(part, msg) {
    const P = this.partAt(part);
    if (!P) return;
    P.smpOn = !!msg.on;
    if (!P.smpOn) { if (P.smp) P.smp.allOff(); return; }
    if (!P.smp) P.smp = new SamplerPlayer(this.sr);
    if (!msg.keep) {
      const pcm = msg.pcm instanceof Float32Array ? msg.pcm : null;
      const pcmR = pcm && msg.pcmR instanceof Float32Array && msg.pcmR.length === pcm.length ? msg.pcmR : null;
      P.smp.setData(pcm, finiteOr(msg.rate, this.sr), pcmR);
    }
    P.smp.configure(msg.cfg);
  }

  /** The key against the sampler's Root in semitones, in the session's tuning. */
  samplerSemis(P, note) {
    const root = P.smp.cfg.root;
    return this.tuneSemis === null ? note - root : this.tunedPitch(note) - this.tunedPitch(root);
  }

  /**
   * Drum library sound i (v2.8; 0..7 are the 2.7 synth drums), synthesized
   * once per engine and shared, never on every knob move. Past 64 sounds the
   * oldest leaves the cache (pads holding it keep playing).
   */
  drumSound(i) {
    if (!this.drumCache) this.drumCache = new Map();
    let d = this.drumCache.get(i);
    if (!d) {
      d = renderLibraryDrum(i, this.sr);
      if (!d) return null;
      if (this.drumCache.size >= 64) this.drumCache.delete(this.drumCache.keys().next().value);
      this.drumCache.set(i, d);
    }
    return d;
  }

  /** v2.8: audition a sound ({synth: i} or {pcm, rate}) on a track whose drum kit is on, without changing its pads. */
  previewKit(part, msg) {
    const P = this.partAt(part);
    if (!P || !P.kitOn || !P.kit || !msg) return;
    const data = msg.pcm instanceof Float32Array ? msg.pcm : Number.isInteger(msg.synth) && msg.synth >= 0 ? this.drumSound(msg.synth) : null;
    if (!data) return;
    P.kit.preview(data, msg.pcm ? finiteOr(msg.rate, this.sr) : this.sr, clamp01(finiteOr(msg.vel, 0.9)), clamp01(finiteOr(msg.gain, 0.8)), Math.max(-24, Math.min(24, finiteOr(msg.pitch, 0))));
  }

  noteOn(P, note, vel, tag = null, slice = null) {
    // v2.8 a frozen part's sequencer and arpeggiator are in its loop; other
    // notes (keys, MIDI) play live on top of it (v2.9)
    if (P.frozen !== null && P.fzTarget >= 1 && (tag === 'seq' || tag === 'arp')) return;
    if (vel > 1) vel /= 127;
    if (P.kitOn && P.kit) { if (vel > 0) { P.kit.trigger(note, vel); this.science.noteOn(); } return; }
    if (P.smpOn && P.smp !== null) {
      if (!(vel > 0)) { P.smp.noteOff(note); return; }
      this.science.noteOn();
      if (P.smp.heldCount() === 0) this.retrigLfos(P); else this.partMods(P);
      const pp = P.partPlain;
      P.smp.noteOn(note, this.samplerSemis(P, note), vel * this.velGain(P, vel), pp[M_SMP_START], pp[M_SMP_END], Number.isInteger(slice) ? slice : null);
      return;
    }
    if (!(vel > 0)) { this.noteOff(P, note); return; }
    this.science.noteOn();
    if (this.heldCount(P) === 0) this.retrigLfos(P);
    const glideOn = P.params[PI.glide] > 0.0005;
    if (P.mode === 0) {
      const V = P.voices;
      let v = null;
      for (const c of V) if (c.active && !c.pending && c.stealFade === 0 && sameNote(c.note, note)) { v = c; break; }
      if (v) {
        this.retrigger(P, v, note, vel);
      } else {
        for (const c of V) if (!c.active) { v = c; break; }
        if (v) {
          this.startVoice(P, v, note, vel, glideOn && P.lastPitch >= 0 ? P.lastPitch : -1);
        } else {
          // steal: a released voice (the quietest), else the oldest held one
          let best = null;
          for (const c of V) {
            if (c.pending || c.gate) continue;
            if (!best || c.envLvl < best.envLvl) best = c;
          }
          if (!best) for (const c of V) if (!c.pending && (!best || c.order < best.order)) best = c;
          if (!best) best = V[0];
          best.pending = true;
          best.pendNote = note;
          best.pendVel = vel;
          best.gate = false;
          if (best.stealFade === 0) { best.stealFade = 1; best.stealStep = 1 / this.stealSamples; best.stealGain = 1; }
        }
      }
      P.lastPitch = note;
      return;
    }
    // mono / legato: one voice, a note stack, last-note priority
    let s = 0;
    for (let i = 0; i < P.stackLen; i++) if (!sameNote(P.stack[i], note)) P.stack[s++] = P.stack[i];
    P.stackLen = s;
    const wasHeld = s > 0;
    if (P.stackLen < P.stack.length) P.stack[P.stackLen++] = note;
    const v = P.voices[0];
    for (let i = 1; i < P.voices.length; i++) if (P.voices[i].active && P.voices[i].gate) this.releaseVoice(P.voices[i]);
    if (!v.active || v.pending) {
      if (v.pending) { v.pending = false; v.stealFade = 0; v.stealGain = 1; }
      this.startVoice(P, v, note, vel, glideOn && P.lastPitch >= 0 && P.mode === 1 ? P.lastPitch : -1);
    } else {
      const legato = P.mode === 2 && wasHeld && v.gate;
      v.note = note;
      v.gate = true;
      v.order = ++this.voiceCounter;
      v.rand = this.streamOf(P, 'linkRng')() * 2 - 1;
      v.press = 0; v.slide = 0;
      if (!legato) {
        v.vel = vel;
        v.velGain = this.velGain(P, vel);
        v.envStage = ATTACK;
        v.env2Stage = ATTACK;
        this.triggerExtraEnvelopes(P,v,true);
        v.stringOn=false;
      }
      // Mono glides on every note, Legato only between overlapping notes.
      if (!glideOn || (P.mode === 2 && !legato)) v.pitch = note;
      if (!legato && P.resoMode === 1) this.resoStrike(P, v);
    }
    P.lastPitch = note;
  }

  noteOff(P, note) {
    if (P.smpOn && P.smp !== null && !P.kitOn) { P.smp.noteOff(note); return; }
    if (P.mode === 0) {
      for (const v of P.voices) {
        if (v.pending && sameNote(v.pendNote, note)) v.pending = false;
        else if (v.active && v.gate && sameNote(v.note, note)) this.releaseVoice(v);
      }
      return;
    }
    let s = 0;
    for (let i = 0; i < P.stackLen; i++) if (!sameNote(P.stack[i], note)) P.stack[s++] = P.stack[i];
    P.stackLen = s;
    const v = P.voices[0];
    if (!v.active || !v.gate || !sameNote(v.note, note)) return;
    if (s > 0) {
      // fall back to the most recent still-held note (glides if Glide is set)
      v.note = P.stack[s - 1];
      if (!(P.params[PI.glide] > 0.0005)) v.pitch = v.note;
      P.lastPitch = v.note;
    } else {
      this.releaseVoice(v);
    }
  }

  velGain(P, vel) {
    const sens = clamp01(P.params[PI.velSens]);
    return 1 - sens * (1 - Math.pow(clamp01(vel), 1.5));
  }

  releaseVoice(v, force = false) {
    v.gate = false;
    v.ampExtra.release(force); v.env2Extra.release(force);
    for (const env of v.ownEnvs) env.release(force);
    if (v.envStage !== IDLE) v.envStage = RELEASE;
    if (v.env2Stage !== IDLE) v.env2Stage = RELEASE;
  }

  retrigger(P, v, note, vel) {
    v.note = note;
    v.vel = vel;
    v.velGain = this.velGain(P, vel);
    v.gate = true;
    v.order = ++this.voiceCounter;
    v.envStage = ATTACK;
    v.env2Stage = ATTACK;
    v.rand = this.streamOf(P, 'linkRng')() * 2 - 1;
    this.triggerExtraEnvelopes(P,v,true);
    v.stringOn=false;
    if (P.resoMode === 1) this.resoStrike(P, v);
  }

  /**
   * The random stream a note of part P draws from: the shared one, or (v2.11
   * stems export, {t:'stemTap', streams: 1}) the part's own, so a track
   * sounds the same rendered alone as in the mix.
   */
  streamOf(P, name) {
    if (!this.partStreams) return this[name];
    const s = P.stemStreams || (P.stemStreams = {});
    return s[name] || (s[name] = mulberry32((STREAM_SEEDS[name] + Math.imul(P.index + 1, 0x9e3779b1)) >>> 0));
  }

  startVoice(P, v, note, vel, glideFrom) {
    v.resetState();
    v.active = true;
    v.gate = true;
    v.note = note;
    v.vel = vel;
    v.velGain = this.velGain(P, vel);
    v.order = ++this.voiceCounter;
    v.pitch = glideFrom >= 0 ? glideFrom : note;
    v.phase[0] = 0;
    const r0 = this.streamOf(P, 'rng'), r1 = this.streamOf(P, 'extensionRng'), r2 = this.streamOf(P, 'unisonRng');
    for (let k = 1; k < MAX_UNISON; k++) v.phase[k] = k < 4 ? r0() : k < 8 ? r1() : r2();
    if (P.uniMode === 3) for (let k = 0; k < MAX_UNISON; k++) v.uPos[k] = r2() * 2 - 1;
    v.fnPh = 0;
    v.uniPrev = 0;
    v.envStage = ATTACK;
    v.env2Stage = ATTACK;
    v.rand = this.streamOf(P, 'linkRng')() * 2 - 1;
    v.press = 0; v.slide = 0;
    v.sPress = P.pressure; v.sSlide = P.slide;
    // a fresh noise stream per note, so stacked voices never hiss in unison
    this.noiseSeed = (Math.imul(this.noiseSeed ^ (this.noiseSeed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    v.nz = this.noiseSeed || 1;
    v.colourL.reset(v.nz); v.colourR.reset(v.nz ^ 0x732ac);
    v.renderRate=this.fs2; v.string.sampleRate=this.fs2;
    this.triggerExtraEnvelopes(P,v,false);
    if (v.comb) { v.comb.fill(0); v.cw = 0; }
    v.ft = -1;
    v.trav = P.travBits; v.pShape = P.shapeI; v.pOrder = P.orderI;
    v.uRun = P.uni; v.stereo = P.uni > 1;
    for (let q = 0; q < MAX_UNISON; q++) { v.ugL[q] = q < P.uni ? P.gUL[q] : 0; v.ugR[q] = q < P.uni ? P.gUR[q] : 0; }
    v.mTrack = P.trackMean;
    // the part's shared modulation may be stale if it has been idle
    this.partMods(P);
    this.controlVoice(P, v, true);
    // Start the DC blocker as if it had always been running on this orbit, so
    // an orbit over high ground does not thump while the blocker settles.
    const mean = this.orbitMean(P, v);
    if (v.mTrack) {
      // the tracked mean is removed before the blocker, which then starts at rest
      v.mCur = mean;
      v.dcMeanL = 0; v.dcMeanR = 0;
    } else {
      let gl = 0, gr = 0;
      for (let q = 0; q < P.uni; q++) { gl += P.gUL[q]; gr += P.gUR[q]; }
      v.dcMeanL = mean * gl;
      v.dcMeanR = mean * gr;
    }
    v.dcInit = true;
    if (P.resoMode === 1) this.resoStrike(P, v);
  }

  /** Map a path phase through a travel setting (ping-pong, even). */
  travelMap(shape, order, t, param, trav) {
    if (trav & 1) t = pingPong(t);
    if (trav & 2) t = evenPhase(shape, order, param, t);
    return t;
  }

  /** Mean shaped terrain height over one cycle of the voice's current orbit (with Pace, Laps and travel). */
  orbitMean(P, v) {
    const pt = this.pt;
    const L = v.laps, pc = v.pace, shp = v.paceShape, trav = v.trav;
    const plain = L === 1 && pc === 0 && trav === 0;
    // more points when Laps/Pace crowd several traversals into one cycle
    const K = plain ? 48 : 192;
    const A = P.terrA[Math.min(v.lA, P.terrA.length - 1)], B = P.terrB[Math.min(v.lB, P.terrB.length - 1)];
    let sum = 0;
    for (let i = 0; i < K; i++) {
      let t = i / K;
      if (!plain) {
        t = L * paceWarp(t, pc, shp); t -= Math.floor(t);
        if (trav !== 0) t = this.travelMap(v.pShape, v.pOrder, t, v.param, trav);
      }
      pathPoint(v.pShape, t, v.pOrder, v.param, pt);
      if (v.ex[EX.pathWindow] || v.ex[EX.pathMangle] || v.pathMirror) shapePathPoint(pt.x,pt.y,t,v.ex[EX.pathWindow],v.ex[EX.pathMangle],v.pathMirror,pt);
      let u = v.cx + pt.x * v.tA - pt.y * v.tB;
      let w = v.cy + pt.x * v.tC + pt.y * v.tD;
      if (v.warp > 0) {
        const ww = v.warp * 0.06;
        const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
        w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
        u = u2;
      }
      let h = bil(A.data, A.size, A.size - 1, u, w);
      if (v.morph > 1e-4) h += v.morph * (bil(B.data, B.size, B.size - 1, u, w) - h);
      const y = h * v.lift, ay = y < 0 ? -y : y;
      let sh = y;
      if (ay > 1) { const e = 2 * (ay - 1); const kk = 1 + 0.5 * e / (1 + e); sh = y < 0 ? -kk : kk; }
      if (v.fold > 0) sh += v.fold * (fastSin(y * (1 + 4 * v.fold) * 0.25) - sh);
      sum += sh;
    }
    return sum / K;
  }

  /** Terrain height (warp + morph, before Lift/Fold) at (u, v) on the full-resolution tables. */
  terrainHeightAt(P, u, w, morph, warp) {
    if (warp > 0) {
      const ww = warp * 0.06;
      const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
      w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
      u = u2;
    }
    const A = P.terrA[0];
    let h = bil(A.data, A.size, A.size - 1, u, w);
    if (morph > 1e-4) { const B = P.terrB[0]; h += morph * (bil(B.data, B.size, B.size - 1, u, w) - h); }
    return h;
  }

  currentBeats() {
    const T = this.transport;
    return T.beat + (this.blockTime - T.beatTime) * this.tempo / 60;
  }

  // ---- control rate ---------------------------------------------------------

  advanceLfos(P, dt) {
    const anchored = this.transport.playing;
    const beats = anchored ? this.currentBeats() : 0;
    for (let m = 0; m < NMOD; m++) {
      const prev = P.lfoPhase[m];
      P.lfoAge[m]+=dt;
      let ph, period;
      if (P.lfoSync[m]) {
        const div = SYNC_DIVS[P.lfoDiv[m]].beats;
        period = div * 60 / this.tempo;
        if (anchored) {
          ph = beats / div + P.lfoOffset[m];
        } else {
          ph = prev + (this.tempo / 60 / div) * dt;
        }
      } else {
        period = 1 / P.lfoRate[m];
        ph = prev + P.lfoRate[m] * dt;
      }
      if (P.lfoAge[m] <= P.lfoDelay[m] && P.lfoDelay[m] > 0) ph=prev;
      ph -= Math.floor(ph);
      if (ph < prev) { P.lfoCycles[m]++; P.lfoR0[m] = P.lfoR1[m]; P.lfoR1[m] = (LEGACY_MOD_MASK[m] ? P.rng() : P.extraRng()) * 2 - 1; }
      P.lfoPhase[m] = ph;
      const shape = P.lfoShape[m];
      const extended=P.lfoStart[m] || P.lfoSkew[m] || P.lfoDelay[m] || P.lfoAttack[m] || P.lfoValueOffset[m] || P.lfoCount[m] || P.stepGlide[m] || P.stepSmooth[m];
      if (!extended) {
        P.lfoVal[m] = shape === 6
          ? stepsValue(P.lfoSteps, m * LFO_STEP_COUNT, ph, period / LFO_STEP_COUNT)
          : lfoValue(shape, ph, P.lfoR0[m], P.lfoR1[m]);
      } else {
        const age=P.lfoAge[m]-P.lfoDelay[m];
        let phase=ph+P.lfoStart[m]; phase-=Math.floor(phase); phase=skewLfoPhase(phase,P.lfoSkew[m]);
        const value=shape === 6 ? steppedLfo(P.lfoSteps,m*LFO_STEP_COUNT,phase,period/LFO_STEP_COUNT,P.stepGlide[m],P.stepSmooth[m],LFO_STEP_COUNT) : lfoValue(shape,phase,P.lfoR0[m],P.lfoR1[m]);
        const gain=age <= 0 ? 0 : P.lfoAttack[m] ? Math.min(1,age/P.lfoAttack[m]) : 1;
        const running=!P.lfoCount[m] || age < P.lfoCount[m]*period;
        P.lfoVal[m]=clampPM1(P.lfoValueOffset[m]+(running ? value*gain : 0));
      }
    }
  }

  partMods(P) {
    P.updatePartLinks(this.macros, this.sGuitar, this.sVoice, this.science.out);
    const PL = P.partLink;
    for (let m = 0; m < NMOD; m++) {
      let n = P.baseNorm[m] + P.lfoVal[m] * P.lfoDepth[m];
      n += PL[m];
      for (let i=0;i<4;i++) {
        const c=m*4+i,source=P.ctrlSrc[c];
        if (P.ctrlDepth[c] && PART_SOURCE[source]) n+=P.ctrlDepth[c]*linkCurve(P.ctrlCurve[c],this.partControllerSource(P,source));
      }
      n = MOD_WRAPS[m] ? n - Math.floor(n) : clamp01(n);
      P.partNorm[m] = n;
      P.partPlain[m] = !LEGACY_MOD_MASK[m] && !P.lfoDepth[m] && !PL[m] && !P.ctrlDepth[m*4] && !P.ctrlDepth[m*4+1] && !P.ctrlDepth[m*4+2] && !P.ctrlDepth[m*4+3]
        ? P.params[MOD_PARAM_OFFSETS[m]] : fromNorm(MOD_DEFS[m], n);
    }
  }

  advanceEnv2(P, v) {
    if (v.env2Custom) { v.env2Lvl=v.env2Extra.sample(CTRL/this.sr); v.env2Stage=v.env2Extra.stage ? ATTACK : IDLE; return; }
    switch (v.env2Stage) {
      case ATTACK:
        v.env2Lvl = ATTACK_OVERSHOOT + (v.env2Lvl - ATTACK_OVERSHOOT) * P.att2C;
        if (v.env2Lvl >= 1) { v.env2Lvl = 1; v.env2Stage = DECAY; }
        break;
      case DECAY:
        v.env2Lvl = P.sus2 + (v.env2Lvl - P.sus2) * P.dec2C;
        break;
      case RELEASE:
        v.env2Lvl = -ENV_FLOOR + (v.env2Lvl + ENV_FLOOR) * P.rel2C;
        if (v.env2Lvl <= 0) { v.env2Lvl = 0; v.env2Stage = IDLE; }
        break;
      default: break;
    }
  }

  /** Value of a per-voice Link source. */
  voiceSource(P, v, s) {
    switch (s) {
      case L_VEL: return clamp01(v.vel);
      case L_PRESS: return v.sPress;
      case L_KEY: return clampPM1((v.pitch - 60) / 48);
      case L_SLIDE: return v.sSlide;
      case L_ENV1: return v.envLvl;
      case L_ENV2: return v.env2Lvl;
      case L_RAND: return v.rand;
      case L_TERRAIN: return clampPM1(v.terrH);
      case L_SWIRLX: return this.science.swirl(v.index, this.swirlOut).x;
      case L_SWIRLY: return this.science.swirl(v.index, this.swirlOut).y;
      case L_FUNC: return funcValue(P.fnXs, P.fnYs, P.fnN, v.fnPh, P.fnSmooth);
      default: return 0;
    }
  }

  /**
   * Re-evaluate one voice's modulation and set its per-sample ramps for the
   * next control block. snap = true (note start) jumps straight to the targets.
   */
  controlVoice(P, v, snap) {
    const sr = this.sr, fs2 = this.fs2;
    const k = snap ? 1 : this.kSmooth;
    const prm = P.params;
    if (!snap) this.advanceEnv2(P, v);
    // A held note whose envelope has decayed to nothing (sustain 0) is finished:
    // free the voice instead of computing silence (and creeping into denormals).
    if (v.ampCustom && v.ampExtra.stage === 5 && v.ampExtra.config[4] === 0 && (v.ampExtra.config[6] === 0 || v.ampExtra.config[6] === 4)) {
      v.ampExtra.reset(); v.envStage=IDLE; v.envLvl=0;
    }
    if (!v.ampCustom && v.envStage === DECAY) {
      if (P.sus <= 0 && v.envLvl < 1e-5) { v.envStage = IDLE; v.envLvl = 0; }
      else if (Math.abs(v.envLvl - P.sus) < 1e-9) v.envLvl = P.sus;
    }
    if (v.env2Stage === DECAY && Math.abs(v.env2Lvl - P.sus2) < 1e-9) v.env2Lvl = P.sus2;

    const glideSlot=M_GLIDE;
    const glide=P.lfoDepth[glideSlot] || P.envDepth[glideSlot] || P.vLinked[glideSlot] || P.partLink[glideSlot] ? (snap ? P.partPlain[glideSlot] : v.modPlain[glideSlot]) : prm[PI.glide];
    if (glide > 0.0005) {
      if (!snap) {
        const kg = 1 - Math.exp(-CTRL / (sr * glide / 3));
        v.pitch += (v.note - v.pitch) * kg;
        if (Math.abs(v.note - v.pitch) < 1e-4) v.pitch = v.note;
      }
    } else {
      v.pitch = v.note;
    }

    // v2.4 Function phase: loops, or runs once from the note start and holds
    {
      const rate = P.fnSync ? this.tempo / 60 / SYNC_DIVS[P.fnDiv].beats : P.fnRate;
      let ph = v.fnPh + rate * CTRL / sr;
      if (P.fnMode === 1) ph = ph > 1 ? 1 : ph; else ph -= Math.floor(ph);
      v.fnPh = ph;
    }

    // modulation in normalised space: base + LFO + Env 2 + Links
    const e2 = v.env2Lvl;
    const MN = v.modNorm, MP = v.modPlain;
    const VL = this.tmpL;      // per-voice link sums (scratch, free outside renderVoice)
    if (P.voiceLinks) {
      // pressure and slide: the note's own value or the channel's, smoothed (MIDI steps)
      const pt = v.press > P.pressure ? v.press : P.pressure, st = v.slide > P.slide ? v.slide : P.slide;
      if (snap) { v.sPress = pt; v.sSlide = st; } else {
        v.sPress = Math.abs(pt - v.sPress) < 1e-6 ? pt : v.sPress + (pt - v.sPress) * this.kPress;
        v.sSlide = Math.abs(st - v.sSlide) < 1e-6 ? st : v.sSlide + (st - v.sSlide) * this.kPress;
      }
      for (let m = 0; m < NMOD; m++) VL[m] = 0;
      for (let i = 0; i < P.nLinks; i++) {
        if (P.lkPart[i]) continue;
        const s = P.lkSrc[i], via = P.lkVia[i];
        const x = PART_SOURCE[s] ? this.partControllerSource(P, s) : this.voiceSource(P, v, s);
        const g = via < 0 ? 1 : PART_SOURCE[via] ? this.partControllerSource(P, via) : this.voiceSource(P, v, via);
        VL[P.lkDst[i]] += P.lkAmt[i] * linkCurve(P.lkCurve[i], x) * g;
      }
    }
    const PL = P.partLink;
    MN.set(P.partNorm); MP.set(P.partPlain);
    for (let j=0;j<P.voiceModCount;j++) {
      const m=P.voiceModSlots[j],ed=P.envDepth[m],vl=P.vLinked[m];
      let envelope=e2;
      if (P.envOwn[m]) {
        const env=v.ownEnvs[m]; env.configure(P.envConfig[m],CTRL/sr);
        if (!env.stage && v.gate && !env.gate) env.trigger();
        if (!snap) env.sample(CTRL/sr); envelope=env.value;
      }
      let n=P.baseNorm[m]+P.lfoVal[m]*P.lfoDepth[m]+envelope*ed+PL[m];
      if (vl) n+=VL[m];
      for (let i=0;i<4;i++) {
        const c=m*4+i,depth=P.ctrlDepth[c]; if (!depth) continue;
        const source=P.ctrlSrc[c];
        n+=depth*linkCurve(P.ctrlCurve[c],PART_SOURCE[source] ? this.partControllerSource(P,source) : this.voiceSource(P,v,source));
      }
      n=MOD_WRAPS[m] ? n-Math.floor(n) : clamp01(n);
      MN[m]=n; MP[m]=fromNorm(MOD_DEFS[m],n);
    }
    // Key>Size: higher notes shrink or grow the orbit, per voice
    if (P.noteSize !== 0) {
      let s = MP[M_SIZE] * Math.pow(2, P.noteSize * (v.pitch - 60) / 24);
      s = s < 0 ? 0 : s > 0.5 ? 0.5 : s;
      MP[M_SIZE] = s;
      MN[M_SIZE] = toNorm(SIZE_DEF, s);
    }

    // one-pole smoothing of the targets (wrap-aware for angles and the dot)
    if (snap) {
      v.sSize = MP[M_SIZE]; v.sStretch = MP[M_STRETCH]; v.sRot = MP[M_ROTATE];
      v.sCx = MP[M_CX]; v.sCy = MP[M_CY]; v.sMorph = MP[M_MORPH]; v.sWarp = MP[M_WARP];
      v.sLift = MP[M_LIFT]; v.sFold = MP[M_FOLD]; v.sParam = MP[M_PARAM];
      v.sCut = Math.log2(MP[M_CUTOFF]); v.sRes = MP[M_RES]; v.sDrive = MP[M_DRIVE]; v.sPan = MP[M_PAN];
      v.sFormant = MP[M_FORMANT];
    } else {
      v.sSize += (MP[M_SIZE] - v.sSize) * k;
      v.sStretch += (MP[M_STRETCH] - v.sStretch) * k;
      v.sRot += wrapHalf((MP[M_ROTATE] - v.sRot) / 360) * 360 * k;
      v.sCx += wrapHalf(MP[M_CX] - v.sCx) * k;
      v.sCy += wrapHalf(MP[M_CY] - v.sCy) * k;
      v.sMorph += (MP[M_MORPH] - v.sMorph) * k;
      v.sWarp += (MP[M_WARP] - v.sWarp) * k;
      v.sLift += (MP[M_LIFT] - v.sLift) * k;
      v.sFold += (MP[M_FOLD] - v.sFold) * k;
      v.sParam += (MP[M_PARAM] - v.sParam) * k;
      v.sCut += (Math.log2(MP[M_CUTOFF]) - v.sCut) * k;
      v.sRes += (MP[M_RES] - v.sRes) * k;
      v.sDrive += (MP[M_DRIVE] - v.sDrive) * k;
      v.sPan += (MP[M_PAN] - v.sPan) * k;
      v.sFormant += (MP[M_FORMANT] - v.sFormant) * k;
      v.sRot -= Math.floor(v.sRot / 360) * 360;
      v.sCx -= Math.floor(v.sCx);
      v.sCy -= Math.floor(v.sCy);
    }

    // Laps / Pace / Sub / Air. Each ramp first lands exactly on the previous
    // target when it is within rounding of it, so a voice whose Laps returns
    // to 1 and Pace to 0 drops back onto the fast path.
    if (Math.abs(v.laps - v.sLaps) < 1e-9) v.laps = v.sLaps;
    if (Math.abs(v.pace - v.sPace) < 1e-9) v.pace = v.sPace;
    if (Math.abs(v.subLv - v.sSub) < 1e-9) v.subLv = v.sSub;
    const subT=SUB_GAIN*MP[M_SUB]*MP[M_SUB];
    const airT=Math.round(prm[PI.airType]) === 0 ? AIR_RMS*MP[M_AIR]*MP[M_AIR] : 0;
    const lapsT = MP[M_LAPS];
    let paceT = MP[M_PACE];
    if (snap) {
      v.paceShape = P.paceShapeI;
    } else if (v.paceShape !== P.paceShapeI) {
      // Switching curves at full Pace would jump the waveform: fade Pace out,
      // switch while it is exactly 0, then fade back in (~40 ms in all).
      if (v.pace === 0 && v.sPace === 0) v.paceShape = P.paceShapeI;
      else paceT = 0;
    }
    if (snap) {
      v.sLaps = lapsT; v.sPace = paceT; v.sSub = subT; v.sAir = airT; v.sTone = P.airTone;
    } else {
      v.sLaps = Math.abs(lapsT - v.sLaps) < SNAP ? lapsT : v.sLaps + (lapsT - v.sLaps) * k;
      v.sPace = Math.abs(paceT - v.sPace) < SNAP ? paceT : v.sPace + (paceT - v.sPace) * k;
      v.sSub = Math.abs(subT - v.sSub) < SNAP ? subT : v.sSub + (subT - v.sSub) * k;
      v.sAir = Math.abs(airT - v.sAir) < SNAP ? airT : v.sAir + (airT - v.sAir) * k;
      v.sTone = Math.abs(P.airTone - v.sTone) < SNAP ? P.airTone : v.sTone + (P.airTone - v.sTone) * k;
    }

    // path and filter type changes crossfade from the old setting (a path
    // change waits for a running fade to finish rather than cut it short)
    if (v.trav !== P.travBits || v.pShape !== P.shapeI || v.pOrder !== P.orderI) {
      if (snap) { v.trav = P.travBits; v.pShape = P.shapeI; v.pOrder = P.orderI; v.travW = 0; }
      else if (v.travW === 0) {
        v.travOld = v.trav; v.shOld = v.pShape; v.orOld = v.pOrder;
        v.trav = P.travBits; v.pShape = P.shapeI; v.pOrder = P.orderI;
        v.travW = 1; v.travDW = 1 / (TRAVEL_FADE * fs2);
      }
    }
    if (v.ft !== P.ftype) this.switchFilter(P, v, snap);

    // transform coefficients at the end of the block
    const ax = Math.exp(v.sStretch * 1.5 * Math.LN2);
    const sx = ax * v.sSize, sy = v.sSize / ax;
    const th = v.sRot / 360 + P.spinPhase;
    const c = fastCos(th), s = fastSin(th);
    const tA = sx * c, tB = sy * s, tC = sx * s, tD = sy * c;
    v.eA = tA; v.eB = tB; v.eC = tC; v.eD = tD;

    // pitch
    // v2.9 microtuning: bend and Tune move through the tuning by keys; Fine
    // (cents) and Octave (2/1) stay equal-tempered. The default keeps the original sum.
    const semis = this.tuneSemis === null
      ? v.pitch + prm[PI.octave] * 12 + prm[PI.tune] + MP[M_FINE] / 100 + P.bend * prm[PI.bendRange]
      : this.tunedPitch(v.pitch + prm[PI.tune] + P.bend * prm[PI.bendRange]) + prm[PI.octave] * 12 + MP[M_FINE] / 100;
    let f = 440 * Math.exp((semis - 69) * (Math.LN2 / 12));
    if (!(f > 0)) f = 1;
    v.hz = f;

    // mip level from traversal speed (terrain units per second); Laps traces
    // the path `laps` times per cycle, so it scales the speed, and Ping-pong
    // runs it twice per lap. Pace speeds up and slows down within the cycle:
    // it is added per sample (see terrainPaced).
    let speed = f * pathLength(v.pShape, v.pOrder, v.sParam) * v.sSize * (ax > 1 ? ax : 1 / ax) * (1 + 1.3 * v.sWarp) * v.sLaps + 1e-9;
    if (v.trav & 1) speed *= 2;
    speed*=1+0.5*Math.PI*Math.abs(v.modPlain[M_PHASE_MOD]*v.modPlain[M_PHASE_RATIO])+3*Math.abs(v.modPlain[M_PATH_MANGLE])+v.modPlain[M_PATH_WINDOW];
    v.eSpeed = speed / f;
    const rawA = this.mipRaw(P.terrA, speed), rawB = this.mipRaw(P.terrB, speed);
    const topA = P.terrA.length - 1, topB = P.terrB.length - 1;
    const lvA = rawA < 0 ? 0 : rawA > topA ? topA : rawA;
    const lvB = rawB < 0 ? 0 : rawB > topB ? topB : rawB;
    if (snap) { v.sLvA = lvA; v.sLvB = lvB; } else { v.sLvA += (lvA - v.sLvA) * k; v.sLvB += (lvB - v.sLvB) * k; }
    // unclamped twins: a slow stretch of a paced cycle may need a level below
    // the block's, which clamping first would hide
    const uA = rawA < -16 ? -16 : rawA, uB = rawB < -16 ? -16 : rawB;
    if (snap) { v.uLvA = uA; v.uLvB = uB; } else { v.uLvA += (uA - v.uLvA) * k; v.uLvB += (uB - v.uLvB) * k; }

    // filter
    const fcRaw = Math.exp((v.sCut + MP[M_KEY_TRACK] * (semis - 60) / 12 + MP[M_FILTER_ENV] * 6 * e2) * Math.LN2);
    let fc = fcRaw;
    const fcMax = 0.45 * fs2;
    if (!(fc > 16)) fc = 16; else if (fc > fcMax) fc = fcMax;
    const g = Math.tan(Math.PI * fc / fs2);
    const kq = 2 - 1.97 * clamp01(v.sRes);

    // equal-power pan of the voice's stereo pair (unity at centre)
    const ang = (Math.max(-1, Math.min(1, v.sPan)) + 1) * Math.PI / 4;
    const gl = Math.cos(ang) * Math.SQRT2, gr = Math.sin(ang) * Math.SQRT2;

    const n2 = this.os * CTRL;
    const inv = 1 / n2;
    const U = P.uni;
    // v2.2 Filter 2: coefficients for this block, its mix ramped
    if (P.f2Type !== 0) {
      const fresh = snap || !v.f2On;
      const fc2 = Math.exp((Math.log2(MP[M_F2CUT] > 1 ? MP[M_F2CUT] : 1) + prm[PI.filter2Key] * (semis - 60) / 12 + MP[M_F2ENV] * 6 * e2) * Math.LN2);
      v.f2.setTargets(P.f2Type, fc2, MP[M_F2RES], fs2, n2, fresh, v.envLvl);
      const mx = clamp01(MP[M_F2MIX]);
      if (fresh) { v.f2Mix = mx; v.df2Mix = 0; } else v.df2Mix = (mx - v.f2Mix) * inv;
      v.f2On = true;
      if (P.f2Route === 2 && !v.stereo) v.goStereo();
    } else v.f2On = false;
    // v2.2 Map spread: unison copies read the land around the dot
    const msT = U > 1 ? clamp01(MP[M_UMAP]) * MAP_SPREAD_TILES : 0;
    if (snap) { v.ms = msT; v.dms = 0; } else v.dms = (msT - v.ms) * inv;
    if (snap) {
      v.tA = tA; v.tB = tB; v.tC = tC; v.tD = tD; v.dtA = v.dtB = v.dtC = v.dtD = 0;
      v.cx = v.sCx; v.cy = v.sCy; v.dcx = v.dcy = 0;
      v.morph = v.sMorph; v.warp = v.sWarp; v.lift = v.sLift; v.fold = v.sFold; v.param = v.sParam;
      v.dMorph = v.dWarp = v.dLift = v.dFold = v.dParam = 0;
      v.g = g; v.k = kq; v.dg = v.dk = 0;
      v.drive = v.sDrive; v.dDrive = 0;
      v.gl = gl; v.gr = gr; v.dgl = v.dgr = 0;
      v.laps = v.sLaps; v.pace = v.sPace; v.subLv = v.sSub; v.dLaps = v.dPace = v.dSubLv = 0;
      v.cLvA = v.uLvA; v.cLvB = v.uLvB; v.dcLvA = v.dcLvB = 0;
    } else {
      v.dtA = (tA - v.tA) * inv; v.dtB = (tB - v.tB) * inv; v.dtC = (tC - v.tC) * inv; v.dtD = (tD - v.tD) * inv;
      v.cx -= Math.floor(v.cx); v.cy -= Math.floor(v.cy);
      v.dcx = wrapHalf(v.sCx - v.cx) * inv; v.dcy = wrapHalf(v.sCy - v.cy) * inv;
      v.dMorph = (v.sMorph - v.morph) * inv; v.dWarp = (v.sWarp - v.warp) * inv;
      v.dLift = (v.sLift - v.lift) * inv; v.dFold = (v.sFold - v.fold) * inv;
      v.dParam = (v.sParam - v.param) * inv;
      v.dg = (g - v.g) * inv; v.dk = (kq - v.k) * inv;
      v.dDrive = (v.sDrive - v.drive) * inv;
      v.dgl = (gl - v.gl) * inv; v.dgr = (gr - v.gr) * inv;
      v.dLaps = (v.sLaps - v.laps) * inv; v.dPace = (v.sPace - v.pace) * inv; v.dSubLv = (v.sSub - v.subLv) * inv;
      v.dcLvA = (v.uLvA - v.cLvA) * inv; v.dcLvB = (v.uLvB - v.cLvB) * inv;
    }
    const detune=MP[M_DETUNE], spread=MP[M_SPREAD], blend=MP[M_UBLEND];
    const layoutChanged=detune !== prm[PI.detune] || spread !== prm[PI.spread] || blend !== prm[PI.unisonBlend];
    if (layoutChanged || P.layoutDirty) unisonLayout(P, U, detune, clamp01(spread), clamp01(blend));
    P.layoutDirty=layoutChanged;
    if (snap && layoutChanged) for (let q=0;q<U;q++) { v.ugL[q]=P.gUL[q]; v.ugR[q]=P.gUR[q]; }
    for (let q = 0; q < U; q++) {
      let incT = f * (P.uniMode === 3 ? P.stackRatio[q] * Math.pow(2, v.uPos[q] * detune * 0.5 / 1200) : P.detRatio[q]) / fs2;
      if (incT > 0.45) incT = 0.45;
      if (snap || q >= v.uniPrev) { v.inc[q] = incT; v.dinc[q] = 0; } else v.dinc[q] = (incT - v.inc[q]) * inv;
    }
    // unison changes: gains glide to the part's layout (Width), oscillators
    // that join fade in, ones that leave fade out at their last pitch
    if (!snap) this.unisonRamp(P, v, U, k, inv);
    // oscillators that are not running carry no sync correction into the future
    for (let q = v.uRun; q < MAX_UNISON; q++) { v.blepPend[q] = 0; v.blepSkip[q] = 0; }
    v.uniPrev = U;
    // sub: one octave below the voice's (glided, bent) pitch, no unison detune
    let subIncT = 0.5 * f / fs2;
    if (subIncT > 0.45) subIncT = 0.45;
    if (snap) { v.subInc = subIncT; v.dSubInc = 0; } else v.dSubInc = (subIncT - v.subInc) * inv;

    this.controlExtras(P,v,snap,f,k,inv);
    const velocitySensitivity=MP[M_VEL_SENS];
    v.velGain=1-velocitySensitivity*(1-Math.pow(clamp01(v.vel),1.5));
    this.setMipRamp(v, P.terrA.length, v.sLvA, snap, true, inv);
    this.setMipRamp(v, P.terrB.length, v.sLvB, snap, false, inv);
    // the cycle's mean height at the end of the block (startVoice seeds it)
    if (v.mTrack) v.dMean = snap ? 0 : (this.orbitMeanEnd(P, v) - v.mCur) * inv;

    // Air: level and tilt as two ramped coefficients (see voiceChain)
    if (v.sAir === 0 && Math.abs(v.aH) < 1e-12 && Math.abs(v.aD) < 1e-12) { v.aH = v.aD = 0; }
    if (v.sAir !== 0 || v.aH !== 0 || v.aD !== 0) {
      const tone = v.sTone;
      const gL = Math.pow(2, -4 * (tone > 0 ? tone : 0)), gH = Math.pow(2, 4 * (tone < 0 ? tone : 0));
      const ti = (tone + 1) * 32, t0 = ti < 0 ? 0 : ti > 63 ? 63 : ti | 0;
      const nt = P.rc.airNorm;
      const norm = nt[t0] + (ti - t0) * (nt[t0 + 1] - nt[t0]);
      const lv = v.sAir * norm;
      const aH = lv * gH, aD = lv * (gL - gH);
      if (snap) { v.aH = aH; v.aD = aD; v.daH = v.daD = 0; } else { v.daH = (aH - v.aH) * inv; v.daD = (aD - v.aD) * inv; }
    } else { v.daH = v.daD = 0; }

    // comb / vowel coefficients while either is in use (or fading out)
    const ft = v.ft, fo = v.ftW > 0 ? v.ftOld : -1;
    if (ft === 5 || fo === 5) this.combControl(v, fcRaw, snap, inv);
    if (ft === 6 || fo === 6) this.vowelControl(v, fcRaw, snap, inv);

    // safety: a voice that ever goes non-finite is reset rather than left screaming
    if (!(Math.abs(v.ic1L) + Math.abs(v.ic2L) + Math.abs(v.ic1R) + Math.abs(v.ic2R) + Math.abs(v.dcyL) + Math.abs(v.dcyR) < 1e6)) {
      v.ic1L = v.ic2L = v.ic1R = v.ic2R = 0;
      v.dcxL = v.dcyL = v.dcxR = v.dcyR = 0;
    } else {
      if (Math.abs(v.ic1L) < 1e-20) v.ic1L = 0;
      if (Math.abs(v.ic2L) < 1e-20) v.ic2L = 0;
      if (Math.abs(v.ic1R) < 1e-20) v.ic1R = 0;
      if (Math.abs(v.ic2R) < 1e-20) v.ic2R = 0;
      // a constant input (Size 0, a collapsed orbit) lets the blocker's output
      // decay into subnormal floats after ~15 s, which are slow to compute
      if (Math.abs(v.dcyL) < 1e-20) v.dcyL = 0;
      if (Math.abs(v.dcyR) < 1e-20) v.dcyR = 0;
      if (Math.abs(v.pdyL) < 1e-20) v.pdyL = 0;
      if (Math.abs(v.pdyR) < 1e-20) v.pdyR = 0;
    }
    if (ft >= 5 || fo >= 5 || v.sAir !== 0) this.extraSafety(v);
    // Drive bends an asymmetric wave into DC; behind a filter that passes DC
    // a second blocker takes it out (stays on for the rest of the note)
    if (!v.pdOn && v.sDrive > 1e-4 && (ft === 0 || ft === 1 || ft === 4 || ft === 5)) {
      v.pdOn = true; v.pdxL = v.pdyL = v.pdxR = v.pdyR = 0;
    }
    if (v.pdOn && !(Math.abs(v.pdyL) + Math.abs(v.pdyR) < 1e6)) { v.pdxL = v.pdyL = v.pdxR = v.pdyR = 0; }

    // Terrain Height link source for the next block: under this voice's modulated dot
    if (P.needTerrH) v.terrH = this.terrainHeightAt(P, v.sCx, v.sCy, v.sMorph, v.sWarp);

    // Pristine: band-limited single cycles when the orbit holds still enough
    if (this.pristine && v.tabA) this.pristineControl(P, v, snap, f);
    else if (v.tw > 0) v.dtw = -1 / (TABLE_FADE * fs2);
    else v.tabValid = false;
  }

  /**
   * Per-voice unison gains: one-pole glide (the 4 ms control smoothing) to
   * the part's layout, ramped per sample. A joining oscillator starts silent
   * (and a mono voice gains its right channel from the left's state); a
   * leaving one glides to 0 and is then dropped.
   */
  unisonRamp(P, v, U, k, inv) {
    if (U > v.uRun) {
      for (let q = v.uRun; q < U; q++) { v.ugL[q] = 0; v.ugR[q] = 0; }
      v.uRun = U;
    }
    if (U > 1 && !v.stereo) v.goStereo();
    let ramp = false;
    const n = v.uRun;
    for (let q = 0; q < n; q++) {
      if (q >= U) v.dinc[q] = 0;
      const tL = q < U ? P.gUL[q] : 0, tR = q < U ? P.gUR[q] : 0;
      const gL = v.ugL[q], gR = v.ugR[q];
      if (gL === tL && gR === tR) { v.dugL[q] = 0; v.dugR[q] = 0; continue; }
      let nL = gL + (tL - gL) * k, nR = gR + (tR - gR) * k;
      if (Math.abs(tL - nL) < 1e-6 && Math.abs(tR - nR) < 1e-6) { nL = tL; nR = tR; }
      v.dugL[q] = (nL - gL) * inv; v.dugR[q] = (nR - gR) * inv;
      ramp = true;
    }
    v.gRamp = ramp;
    if (!ramp) while (v.uRun > U && v.ugL[v.uRun - 1] === 0 && v.ugR[v.uRun - 1] === 0) v.uRun--;
  }

  /**
   * Mean shaped height over one cycle of the voice's orbit at the END of the
   * current control block (the smoothed targets), a cheaper twin of
   * orbitMean for tracking the DC of a per-voice modulated orbit.
   */
  orbitMeanEnd(P, v) {
    const pt = this.pt;
    const L = v.sLaps, pc = v.sPace, shp = v.paceShape, trav = v.trav;
    const plain = L === 1 && pc === 0 && trav === 0;
    const K = plain ? 24 : 48;
    const A = P.terrA[Math.min(v.lA, P.terrA.length - 1)], B = P.terrB[Math.min(v.lB, P.terrB.length - 1)];
    const tA = v.eA, tB = v.eB, tC = v.eC, tD = v.eD, cx = v.sCx, cy = v.sCy, param = v.sParam;
    const warp = v.sWarp, morph = v.sMorph, lift = v.sLift, fold = v.sFold;
    let sum = 0;
    for (let i = 0; i < K; i++) {
      let t = (i + 0.5) / K;
      if (!plain) {
        t = L * paceWarp(t, pc, shp); t -= Math.floor(t);
        if (trav !== 0) t = this.travelMap(v.pShape, v.pOrder, t, param, trav);
      }
      pathPoint(v.pShape, t, v.pOrder, param, pt);
      if (v.exTarget[EX.pathWindow] || v.exTarget[EX.pathMangle] || v.pathMirror) shapePathPoint(pt.x,pt.y,t,v.exTarget[EX.pathWindow],v.exTarget[EX.pathMangle],v.pathMirror,pt);
      let u = cx + pt.x * tA - pt.y * tB;
      let w = cy + pt.x * tC + pt.y * tD;
      if (warp > 0) {
        const ww = warp * 0.06;
        const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
        w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
        u = u2;
      }
      let h = bil(A.data, A.size, A.size - 1, u, w);
      if (morph > 1e-4) h += morph * (bil(B.data, B.size, B.size - 1, u, w) - h);
      const y = h * lift, ay = y < 0 ? -y : y;
      let sh = y;
      if (ay > 1) { const e = 2 * (ay - 1); const kk = 1 + 0.5 * e / (1 + e); sh = y < 0 ? -kk : kk; }
      if (fold > 0) sh += fold * (fastSin(y * (1 + 4 * fold) * 0.25) - sh);
      sum += sh;
    }
    return sum / K;
  }

  /** A changed filter type: the new one starts from rest, the old one fades out. */
  switchFilter(P, v, snap) {
    const nt = P.ftype;
    const svf = (t) => t >= 1 && t <= 4;
    if (snap || v.ft < 0) {
      v.ft = nt; v.ftW = 0;
    } else {
      v.ftOld = v.ft; v.ft = nt; v.ftW = 1; v.ftDW = 1 / (FILTER_FADE * this.fs2);
      // SVF to SVF keeps its state (only the output tap changes)
      if (svf(nt) && !svf(v.ftOld)) { v.ic1L = v.ic2L = v.ic1R = v.ic2R = 0; }
    }
    if (nt === 5) { if (v.comb) { v.comb.fill(0); v.cw = 0; } v.cD = -1; }
    if (nt === 6) { v.vs.fill(0); v.vf[0] = -1; }
    if (nt >= 7) { v.analogCurrent=1-v.analogCurrent; v.analog[v.analogCurrent].reset(); }
  }

  /**
   * Comb: two feedback combs of opposite sign (peaks at multiples of the
   * comb frequency, or at its odd half-multiples), blended by Vowel/formant.
   * The blend is one loop: w = x + g^2 w[n - 2D], y = w + (2 f - 1) g w[n - D]
   * (the sum f/(1 - g z^-D) + (1 - f)/(1 + g z^-D) over a common denominator),
   * so it costs one delay line per channel and is stable for every g < 1.
   */
  combControl(v, fcRaw, snap, inv) {
    if (!v.comb) { v.ftW = 0; if (v.ft === 5) v.ft = 0; return; }
    const fs = this.fs2;
    let fc = fcRaw;
    const lo = Math.max(COMB_FMIN, fs / (v.combLen / 2 - 4));
    if (!(fc > lo)) fc = lo; else if (fc > fs / 4) fc = fs / 4;
    const D = fs / fc;
    const res = clamp01(v.sRes);
    const gg = 0.35 + 0.62 * res;
    const fb = gg * gg;
    const ff = (2 * clamp01(v.sFormant) - 1) * gg;
    // part way to power-normalised, so the comb neither booms nor vanishes
    // as Reso sweeps (harmonics mostly miss the narrow high-Reso peaks)
    const mk = Math.pow(1 - fb, 0.4) * 1.25;
    if (snap || v.cD < 0) { v.cD = D; v.cFb = fb; v.cFf = ff; v.cMk = mk; v.dcD = v.dcFb = v.dcFf = v.dcMk = 0; }
    else { v.dcD = (D - v.cD) * inv; v.dcFb = (fb - v.cFb) * inv; v.dcFf = (ff - v.cFf) * inv; v.dcMk = (mk - v.cMk) * inv; }
  }

  /**
   * Vowel: three parallel band-passes at the formants of the vowel under
   * Vowel/formant (A E I O U, interpolated in log frequency, bandwidth and
   * dB), shifted +-1 octave by the cutoff around 1 kHz; Reso narrows them.
   */
  vowelControl(v, fcRaw, snap, inv) {
    const fs = this.fs2;
    const x = clamp01(v.sFormant) * 4;
    let i0 = x | 0;
    if (i0 > 3) i0 = 3;
    const fr = x - i0;
    const A = VOWELS[i0], B = VOWELS[i0 + 1];
    const LA = VOWEL_LOGF[i0], LB = VOWEL_LOGF[i0 + 1];
    const GA = VOWEL_AMP[i0], GB = VOWEL_AMP[i0 + 1];
    let oct = Math.log2(fcRaw / 1000);
    oct = oct < -1 ? -1 : oct > 1 ? 1 : (oct === oct ? oct : 0);
    const res = clamp01(v.sRes);
    const bwScale = 1.6 * Math.pow(2, -2.6 * res);
    // narrower bands pass less energy (and miss more harmonics): give it back
    const mk = VOWEL_GAIN * Math.pow(bwScale, -0.7);
    const vf = v.vf, dvf = v.dvf;
    const first = snap || vf[0] < 0;
    for (let j = 0; j < 3; j++) {
      let f = Math.pow(2, LA[j] + fr * (LB[j] - LA[j]) + oct);
      if (f > 0.45 * fs) f = 0.45 * fs;
      const bw = (A.bw[j] + fr * (B.bw[j] - A.bw[j])) * bwScale * Math.pow(2, oct * 0.5);
      const g = Math.tan(Math.PI * f / fs);
      const kk = Math.min(1.9, bw / f);
      const amp = (GA[j] + fr * (GB[j] - GA[j])) * kk * mk;
      if (first) { vf[j] = g; vf[3 + j] = kk; vf[6 + j] = amp; dvf[j] = dvf[3 + j] = dvf[6 + j] = 0; }
      else { dvf[j] = (g - vf[j]) * inv; dvf[3 + j] = (kk - vf[3 + j]) * inv; dvf[6 + j] = (amp - vf[6 + j]) * inv; }
    }
  }

  /** Flush denormals and reset non-finite state of the comb, vowel and Air filters. */
  extraSafety(v) {
    const vs = v.vs;
    let s = 0;
    for (let i = 0; i < 12; i++) { const a = vs[i]; s += a < 0 ? -a : a; if (a < 1e-20 && a > -1e-20) vs[i] = 0; }
    if (!(s < 1e6)) vs.fill(0);
    if (!(Math.abs(v.tlL) + Math.abs(v.tlR) < 1e6)) { v.tlL = v.tlR = 0; }
    if (Math.abs(v.tlL) < 1e-20) v.tlL = 0;
    if (Math.abs(v.tlR) < 1e-20) v.tlR = 0;
    if (v.comb && !(Math.abs(v.comb[(v.cw - 1) & (v.combLen - 1)]) < 1e6)) v.comb.fill(0);
  }

  /**
   * Unclamped mip level for a traversal speed (terrain units per second).
   * A table of side S holds up to S/2 cycles per unit; traversed at `speed`
   * units/s that is S/2 * speed Hz. Keeping it under the oversampled Nyquist
   * (fs2/2) avoids folding at 2x; the default bias of one more octave keeps
   * it under the host Nyquist instead, which loses nothing (the decimator
   * removes that band anyway) but also pushes the images that bilinear
   * interpolation makes of near-Nyquist detail into the decimator's stopband.
   * The quality mode adds its shift (Eco +1 by rendering at the host rate,
   * High back to Standard's tables at 4x, Raw mips off).
   */
  mipRaw(chain, speed) {
    return Math.log2(chain[0].size * speed / this.fs2) + this.mipBias + this.mipShift;
  }

  /** Mip level for a traversal speed, clamped to the chain (the block-rate choice). */
  mipLevel(chain, speed) {
    const lv = this.mipRaw(chain, speed);
    const top = chain.length - 1;
    return lv < 0 ? 0 : lv > top ? top : lv;
  }

  setMipRamp(v, nLevels, lv, snap, isA, inv) {
    let l = Math.floor(lv);
    if (l > nLevels - 1) l = nLevels - 1;
    if (l < 0) l = 0;
    const wEnd = l >= nLevels - 1 ? 0 : mipZone(lv - l);
    const prevL = isA ? v.lA : v.lB;
    const prevW = isA ? v.wA : v.wB;
    let wStart;
    if (snap) wStart = wEnd;
    else if (l === prevL) wStart = prevW;
    else if (l === prevL + 1) wStart = 0;
    else if (l === prevL - 1) wStart = 1;
    else wStart = wEnd;
    if (isA) { v.lA = l; v.wA = wStart; v.dwA = snap ? 0 : (wEnd - wStart) * inv; }
    else { v.lB = l; v.wB = wStart; v.dwB = snap ? 0 : (wEnd - wStart) * inv; }
  }

  controlUpdate(elapsed) {
    this.tabBudget = TABLE_BUDGET;
    this.science.step(elapsed / this.sr, this.transport.playing ? this.currentBeats() : null, 60 / this.tempo);
    this.weather.step(elapsed / this.sr);
    this.pad.step(elapsed / this.sr);
    let anySolo = false;
    const count = this.count;
    for (let i = 0; i < count; i++) if (this.parts[i].params[PI.solo] >= 0.5) anySolo = true;
    const k = this.kSmooth;
    const dt = elapsed / this.sr;
    const n2 = this.os * CTRL;
    const gtr = this.guitar;
    this.sGuitar = Math.abs(gtr - this.sGuitar) < 1e-6 ? gtr : this.sGuitar + (gtr - this.sGuitar) * this.kMarble;
    const vox = this.voice;
    this.sVoice = Math.abs(vox - this.sVoice) < 1e-6 ? vox : this.sVoice + (vox - this.sVoice) * this.kMarble;
    const pedalOn = this.pedalOn;
    const parts = this.parts, liveN = this.liveN;
    for (let i = 0; i < liveN; i++) {
      const P = parts[i];
      if (i >= count && this.dormant(P)) continue;
      if (P.nRamps > 0) this.advanceRamps(P);
      this.advanceLfos(P, dt);
      // the marble arrives at ~30 Hz: glide between its readings
      if (P.nLinks > 0) {
        const km = this.kMarble;
        P.sMarbleSpeed = Math.abs(P.marbleSpeed - P.sMarbleSpeed) < 1e-6 ? P.marbleSpeed : P.sMarbleSpeed + (P.marbleSpeed - P.sMarbleSpeed) * km;
        P.sMarbleHeight = Math.abs(P.marbleHeight - P.sMarbleHeight) < 1e-6 ? P.marbleHeight : P.sMarbleHeight + (P.marbleHeight - P.sMarbleHeight) * km;
      }
      P.spinPhase += P.params[PI.spin] * dt;
      P.spinPhase -= Math.floor(P.spinPhase);
      const active = P.activeCount();
      if (active > 0 || P.index === this.watch || (P.smp !== null && P.smp.active > 0)) this.partMods(P);
      if (P.space !== null && (P.spaceMode !== 0 || P.space.w > 0)) this.spaceTarget(P, active > 0 || P.index === this.watch);

      // mixer targets: perceptual (squared) level, post-fader sends. A part
      // that left the track list fades to silence over TRACK_FADE_TIME (its
      // notes release meanwhile) and then stops its voices.
      const inList = P.index < count;
      if (inList) P.exit = 1;
      else if (P.exit > 0) P.exit = Math.max(0, P.exit - this.exitStep);
      const audible = P.exit > 0 && P.params[PI.mute] < 0.5 && (!anySolo || P.params[PI.solo] >= 0.5);
      const lv = clamp01(P.params[PI.level]);
      const post = audible ? lv * lv * VOICE_GAIN * P.exit * P.exit : 0;
      // Pedal send: pre-fader follows mute/solo but not the level fader. Insert
      // mutes the dry sound and its delay/reverb sends (the pedal return comes
      // back into the master and the effects instead), only while the send runs.
      const pT = pedalOn ? (P.params[PI.pedalPre] >= 0.5 ? (audible ? VOICE_GAIN * P.exit * P.exit : 0) : post) * clamp01(P.params[PI.pedalSend]) : 0;
      const gT = pedalOn && P.params[PI.pedalInsert] >= 0.5 ? 0 : post;
      const dT = gT * clamp01(P.params[PI.delaySend]), rT = gT * clamp01(P.params[PI.reverbSend]);
      // one-pole towards the targets, snapping when close so muting reaches true zero
      P.gainS = Math.abs(gT - P.gainS) < 1e-4 ? gT : P.gainS + (gT - P.gainS) * k;
      P.dlyS = Math.abs(dT - P.dlyS) < 1e-4 ? dT : P.dlyS + (dT - P.dlyS) * k;
      P.revS = Math.abs(rT - P.revS) < 1e-4 ? rT : P.revS + (rT - P.revS) * k;
      P.pedS = Math.abs(pT - P.pedS) < 1e-4 ? pT : P.pedS + (pT - P.pedS) * k;
      // v2.8 Send A / Send B: post-fader like the delay and reverb sends
      const aT = gT * clamp01(P.params[PI.sendA]), bT = gT * clamp01(P.params[PI.sendB]);
      P.sAS = Math.abs(aT - P.sAS) < 1e-4 ? aT : P.sAS + (aT - P.sAS) * k;
      P.sBS = Math.abs(bT - P.sBS) < 1e-4 ? bT : P.sBS + (bT - P.sBS) * k;
      const bank=P.index-this.vectorBank*4;
      const vectorTarget=bank >= 0 && bank < 4 ? this.vectorWeights[bank] : 1;
      P.vectorSmooth=Math.abs(vectorTarget-P.vectorSmooth) < 1e-5 ? vectorTarget : P.vectorSmooth+(vectorTarget-P.vectorSmooth)*k;
      P.dVector=(P.vectorSmooth-P.vectorGain)/CTRL;
      P.dGain = (P.gainS - P.gain) / CTRL;
      P.dDly = (P.dlyS - P.dly) / CTRL;
      P.dRev = (P.revS - P.rev) / CTRL;
      if (P.pedS === 0 && Math.abs(P.ped) < 1e-9) P.ped = 0;  // exact zero, so the send loop is skipped
      P.dPed = (P.pedS - P.ped) / CTRL;
      if (P.sAS === 0 && Math.abs(P.sA) < 1e-9) P.sA = 0;  // exact zero, so the send loop is skipped
      if (P.sBS === 0 && Math.abs(P.sB) < 1e-9) P.sB = 0;
      P.dSA = (P.sAS - P.sA) / CTRL;
      P.dSB = (P.sBS - P.sB) / CTRL;
      // Send mode with compensation: the dry sound waits for the pedal return.
      P.setDryDelay(pedalOn && this.dryDelayN > 0 && P.params[PI.pedalInsert] < 0.5 && P.params[PI.pedalSend] > 0 ? this.dryDelayN : 0);
      if (!inList && P.gainS === 0 && P.dlyS === 0 && P.revS === 0 && P.pedS === 0 && P.sAS === 0 && P.sBS === 0 && Math.abs(P.gain) < 1e-9) {
        // faded out: the rest of its release would be inaudible, end it now
        for (const v of P.voices) if (v.active) { v.active = false; v.gate = false; v.pending = false; v.resetState(); }
      }

      // terrain crossfades
      if (P.oldA) {
        P.fadeA = Math.max(0, P.fadeA - this.fadeStep);
        P.dFadeA = (P.fadeA - P.fadeACur) / n2;
        if (P.fadeACur <= 0 && P.fadeA <= 0) { P.oldA = null; P.dFadeA = 0; P.fadeACur = 0; }
      }
      if (P.oldB) {
        P.fadeB = Math.max(0, P.fadeB - this.fadeStep);
        P.dFadeB = (P.fadeB - P.fadeBCur) / n2;
        if (P.fadeBCur <= 0 && P.fadeB <= 0) { P.oldB = null; P.dFadeB = 0; P.fadeBCur = 0; }
      }

      if (active === 0) continue;
      for (const v of P.voices) if (v.active) this.controlVoice(P, v, false);
    }
  }

  // ---- audio rate -------------------------------------------------------------

  /**
   * Render n2 oversampled samples of one voice into its bus (rc) at off2.
   * The oscillator (direct: paths then terrain, or Pristine's table, or a
   * crossfade of both) fills this.sumL/sumR; voiceChain then runs the
   * per-voice chain (DC block, sub, Air, drive, filter, envelope, pan).
   * Segments never span a control block, so n2 <= MAX_OS * CTRL and the
   * scratch fits.
   */
  renderVoice(P, v, off2, n2, rc) {
    const SL = this.sumL, SR = this.sumR, TL = this.tmpL, TR = this.tmpR;
    const stereo = v.stereo;
    const param0 = v.param;
    const tw0 = v.tw, dtw = v.dtw;
    let twEnd = tw0 + dtw * n2;
    twEnd = twEnd < 0 ? 0 : twEnd > 1 ? 1 : twEnd;
    // a voice keeps playing its table while it fades out, even after Pristine is switched off
    const tableOn = v.tabValid && v.tabA !== null && (tw0 > 0 || twEnd > 0);
    const directOn = !tableOn || tw0 < 1 || twEnd < 1;
    const sav = this.sav;
    if (tableOn && directOn) for (let q = 0; q < MAX_UNISON; q++) { sav[q] = v.phase[q]; sav[1 * MAX_UNISON + q] = v.inc[q]; }

    if (directOn) {
      if (v.travW > 0) {
        // the old travel setting renders first and fades out
        for (let q = 0; q < MAX_UNISON; q++) {
          sav[2 * MAX_UNISON + q] = v.phase[q]; sav[3 * MAX_UNISON + q] = v.inc[q]; sav[4 * MAX_UNISON + q] = v.blepPend[q]; sav[5 * MAX_UNISON + q] = v.blepSkip[q];
        }
        this.oscDirect(P, v, n2, v.travOld, param0, v.shOld, v.orOld);
        for (let j = 0; j < n2; j++) { TL[j] = SL[j]; TR[j] = SR[j]; }
        for (let q = 0; q < MAX_UNISON; q++) {
          v.phase[q] = sav[2 * MAX_UNISON + q]; v.inc[q] = sav[3 * MAX_UNISON + q]; v.blepPend[q] = sav[4 * MAX_UNISON + q]; v.blepSkip[q] = sav[5 * MAX_UNISON + q];
        }
        this.oscDirect(P, v, n2, v.trav, param0, v.pShape, v.pOrder);
        let w = v.travW;
        const dw = v.travDW;
        for (let j = 0; j < n2; j++) {
          w -= dw; if (w < 0) w = 0;
          SL[j] += w * (TL[j] - SL[j]);
          if (stereo) SR[j] += w * (TR[j] - SR[j]);
        }
        v.travW = w;
      } else {
        this.oscDirect(P, v, n2, v.trav, param0, v.pShape, v.pOrder);
      }
    }
    if (tableOn) {
      if (directOn) {
        this.tableOsc(P, v, n2, TL, TR, false);
        let w = tw0;
        for (let j = 0; j < n2; j++) {
          w += dtw; w = w < 0 ? 0 : w > 1 ? 1 : w;
          SL[j] += w * (TL[j] - SL[j]);
          if (stereo) SR[j] += w * (TR[j] - SR[j]);
        }
      } else {
        this.tableOsc(P, v, n2, SL, SR, true);
        v.blepPend.fill(0); v.blepSkip.fill(0);
      }
      let x = v.tabX + v.dTabX * n2;
      v.tabX = x > 1 ? 1 : x;
    }
    v.tw = twEnd;
    if (twEnd === 0 || twEnd === 1) v.dtw = 0;

    this.renderExtras(P,v,n2,rc);
    v.param += v.dParam * n2;
    v.tA += v.dtA * n2; v.tB += v.dtB * n2; v.tC += v.dtC * n2; v.tD += v.dtD * n2;
    v.cx += v.dcx * n2; v.cy += v.dcy * n2;
    v.ms += v.dms * n2;
    v.morph += v.dMorph * n2; v.warp += v.dWarp * n2; v.lift += v.dLift * n2; v.fold += v.dFold * n2;
    v.wA += v.dwA * n2; v.wB += v.dwB * n2;
    v.cLvA += v.dcLvA * n2; v.cLvB += v.dcLvB * n2;
    v.laps += v.dLaps * n2; v.pace += v.dPace * n2;
    if (v.gRamp) {
      for (let q = 0; q < v.uRun; q++) { v.ugL[q] += v.dugL[q] * n2; v.ugR[q] += v.dugR[q] * n2; }
    }

    this.voiceChain(P, v, rc.hist + off2, n2, rc);
  }

  /**
   * The direct oscillator for n2 samples into sumL/sumR: pass 1 traces each
   * unison oscillator's path for the whole segment, pass 2 maps it onto the
   * terrain and sums the oscillators, then any hard-sync restarts are
   * band-limited. Advances the oscillator phases (and the sync carry-over)
   * but none of the voice's control ramps (renderVoice does that once).
   */
  oscDirect(P, v, n2, trav, param0, shape, order) {
    const U = v.uRun, gUL = v.ugL, gUR = v.ugR;
    const stereo = v.stereo, gRamp = v.gRamp;
    const XS = this.xs, YS = this.ys, SL = this.sumL, SR = this.sumR;
    const pst = this.pst;

    // ---- pass 1: paths
    // Laps 1, Pace 0 and plain travel for the whole segment: the cycle phase
    // is the path phase, the original fast path. Otherwise the Laps/Pace/
    // travel oscillator.
    const sync = v.laps !== 1 || v.dLaps !== 0 || v.pace !== 0 || v.dPace !== 0 || trav !== 0;
    let paced = sync && (v.pace !== 0 || v.dPace !== 0);
    let nEv = 0;
    const customPath=v.ex[EX.phaseMod] !== 0 || v.dex[EX.phaseMod] !== 0 || v.ex[EX.pathWindow] !== 0 || v.dex[EX.pathWindow] !== 0 || v.ex[EX.pathMangle] !== 0 || v.dex[EX.pathMangle] !== 0 || v.pathMirror !== 0 || (P.warpMode !== 0 && (v.ex[EX.warpAmount] !== 0 || v.dex[EX.warpAmount] !== 0));
    if (customPath) {
      this.extraPaths(P,v,n2,trav,shape,order); paced=false;
    } else if (sync) {
      nEv = this.syncPaths(P, v, n2, paced, trav, shape, order);
    } else {
      for (let q = 0; q < U; q++) {
        pst[0] = v.phase[q]; pst[1] = v.inc[q]; pst[2] = v.dinc[q];
        pst[3] = v.param; pst[4] = v.dParam;
        pathBlock(shape, order, n2, pst, XS[q], YS[q]);
        v.phase[q] = pst[0]; v.inc[q] = pst[1];
        v.blepSkip[q] = 0;
      }
    }

    // ---- pass 2: terrain
    const chA = P.terrA, nA = chA.length;
    const la = v.lA < nA ? v.lA : nA - 1;
    const a0 = chA[la].data, sa0 = chA[la].size, ma0 = sa0 - 1;
    const hasA1 = la + 1 < nA;
    const a1 = hasA1 ? chA[la + 1].data : a0, sa1 = hasA1 ? chA[la + 1].size : sa0, ma1 = sa1 - 1;
    const wA0 = hasA1 ? v.wA : 0, dwA = hasA1 ? v.dwA : 0;
    const mipA = hasA1 && (wA0 > 0 || wA0 + dwA * n2 > 0);
    const fA0 = P.fadeACur, dfA = P.dFadeA, oldA = P.oldA;
    const fadeAOn = oldA !== null && (fA0 > 0 || fA0 + dfA * n2 > 0);
    const oAL = fadeAOn ? oldA[la < oldA.length ? la : oldA.length - 1] : chA[la];
    const oa = oAL.data, osa = oAL.size, oma = osa - 1;

    const chB = P.terrB, nB = chB.length;
    const lb = v.lB < nB ? v.lB : nB - 1;
    const b0 = chB[lb].data, sb0 = chB[lb].size, mb0 = sb0 - 1;
    const hasB1 = lb + 1 < nB;
    const b1 = hasB1 ? chB[lb + 1].data : b0, sb1 = hasB1 ? chB[lb + 1].size : sb0, mb1 = sb1 - 1;
    const wB0 = hasB1 ? v.wB : 0, dwB = hasB1 ? v.dwB : 0;
    const mipB = hasB1 && (wB0 > 0 || wB0 + dwB * n2 > 0);
    const fB0 = P.fadeBCur, dfB = P.dFadeB, oldB = P.oldB;
    const fadeBOn = oldB !== null && (fB0 > 0 || fB0 + dfB * n2 > 0);
    const oBL = fadeBOn ? oldB[lb < oldB.length ? lb : oldB.length - 1] : chB[lb];
    const ob = oBL.data, osb = oBL.size, omb = osb - 1;

    const m0 = v.morph, dMorph = v.dMorph, mEnd = m0 + dMorph * n2;
    const needA = m0 < 0.9999 || mEnd < 0.9999;
    const needB = m0 > 1e-4 || mEnd > 1e-4;
    const wp0 = v.warp, dWarp = v.dWarp;
    const warpOn = wp0 > 0 || wp0 + dWarp * n2 > 0;
    const lf0 = v.lift, dLift = v.dLift, fd0 = v.fold, dFold = v.dFold;
    const shapeOn = !(lf0 === 1 && dLift === 0 && fd0 <= 0 && fd0 + dFold * n2 <= 0);
    const tA0 = v.tA, tB0 = v.tB, tC0 = v.tC, tD0 = v.tD, cx0 = v.cx, cy0 = v.cy;
    const dtA = v.dtA, dtB = v.dtB, dtC = v.dtC, dtD = v.dtD, dcx = v.dcx, dcy = v.dcy;
    const msOn = v.ms !== 0 || v.dms !== 0;

    if (paced) {
      // the local traversal speed changes within the cycle: per-sample mips
      this.terrainPaced(P, v, n2);
    } else {
      for (let q = 0; q < U; q++) {
        const X = XS[q], Y = YS[q];
        let gl = gUL[q], gr = gUR[q];
        const dgl = gRamp ? v.dugL[q] : 0, dgr = gRamp ? v.dugR[q] : 0;
        let tA = tA0, tB = tB0, tC = tC0, tD = tD0, cx = cx0, cy = cy0, dcxq = dcx, dcyq = dcy;
        if (msOn) { cx += P.uMapX[q] * v.ms; cy += P.uMapY[q] * v.ms; dcxq += P.uMapX[q] * v.dms; dcyq += P.uMapY[q] * v.dms; }
        let morph = m0, warp = wp0, lift = lf0, fold = fd0, wA = wA0, wB = wB0, fA = fA0, fB = fB0;
        for (let j = 0; j < n2; j++) {
          tA += dtA; tB += dtB; tC += dtC; tD += dtD; cx += dcxq; cy += dcyq;
          if (gRamp) { gl += dgl; gr += dgr; }
          const px = X[j], py = Y[j];
          let u = cx + px * tA - py * tB;
          let w = cy + px * tC + py * tD;
          if (warpOn) {
            warp += dWarp;
            const ww = warp * 0.06;
            const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
            w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
            u = u2;
          }
          let h = 0;
          if (needA) {
            h = bil(a0, sa0, ma0, u, w);
            if (mipA) { wA += dwA; if (wA > 0) h += wA * (bil(a1, sa1, ma1, u, w) - h); }
            if (fadeAOn) { fA += dfA; if (fA > 0) h += fA * (bil(oa, osa, oma, u, w) - h); }
          }
          if (needB) {
            let hb = bil(b0, sb0, mb0, u, w);
            if (mipB) { wB += dwB; if (wB > 0) hb += wB * (bil(b1, sb1, mb1, u, w) - hb); }
            if (fadeBOn) { fB += dfB; if (fB > 0) hb += fB * (bil(ob, osb, omb, u, w) - hb); }
            morph += dMorph;
            h = needA ? h + morph * (hb - h) : hb;
          }
          if (shapeOn) {
            lift += dLift; fold += dFold;
            const y = h * lift;
            const ay = y < 0 ? -y : y;
            let sh = y;
            if (ay > 1) {
              const e = 2 * (ay - 1);
              const kk = 1 + 0.5 * e / (1 + e);
              sh = y < 0 ? -kk : kk;
            }
            if (fold > 0) sh += fold * (fastSin(y * (1 + 4 * fold) * 0.25) - sh);
            h = sh;
          }
          if (q === 0) { SL[j] = h * gl; if (stereo) SR[j] = h * gr; }
          else { SL[j] += h * gl; SR[j] += h * gr; }
        }
      }
    }

    // hard-sync band-limiting: the half correction a restart left for this
    // segment's first sample, then this segment's restarts
    for (let q = 0; q < U; q++) {
      const pd = v.blepPend[q];
      if (pd !== 0) { SL[0] += pd * gUL[q]; if (stereo) SR[0] += pd * gUR[q]; v.blepPend[q] = 0; }
    }
    if (nEv > 0) this.syncBlep(P, v, n2, nEv, param0, paced, trav, shape, order);
  }

  /**
   * Pristine playback: each unison oscillator reads the band-limited single
   * cycle at its own phase (Catmull-Rom, the table is at least 2x
   * oversampled), crossfading from the playing table to the arriving one.
   * The phases advance exactly as the direct oscillator's would; with
   * writeBack false (the direct oscillator ran too) they start from the
   * values saved before it and are not stored.
   */
  tableOsc(P, v, n2, OL, OR, writeBack) {
    const U = v.uRun, gUL = v.ugL, gUR = v.ugR, stereo = v.stereo, gRamp = v.gRamp;
    const A = v.tabA, B = v.tabB, na = v.tabNA, nb = v.tabNB;
    const x0 = v.tabX, dx = v.dTabX;
    const sav = this.sav;
    for (let q = 0; q < U; q++) {
      let ph = writeBack ? v.phase[q] : sav[q];
      let inc = writeBack ? v.inc[q] : sav[1 * MAX_UNISON + q];
      const dinc = v.dinc[q];
      let gl = gUL[q], gr = gUR[q];
      const dgl = gRamp ? v.dugL[q] : 0, dgr = gRamp ? v.dugR[q] : 0;
      let x = x0;
      for (let j = 0; j < n2; j++) {
        ph += inc;
        if (ph >= 1) ph -= 1;
        inc += dinc;
        gl += dgl; gr += dgr;
        let h;
        {
          const p = ph * nb, i = p | 0, f = p - i;
          const y0 = B[i], y1 = B[i + 1], y2 = B[i + 2], y3 = B[i + 3];
          h = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
        }
        if (x < 1) {
          x += dx; if (x > 1) x = 1;
          const p = ph * na, i = p | 0, f = p - i;
          const y0 = A[i], y1 = A[i + 1], y2 = A[i + 2], y3 = A[i + 3];
          const ha = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
          h = ha + x * (h - ha);
        }
        if (q === 0) { OL[j] = h * gl; if (stereo) OR[j] = h * gr; }
        else { OL[j] += h * gl; OR[j] += h * gr; }
      }
      if (writeBack) { v.phase[q] = ph; v.inc[q] = inc; v.blepSkip[q] = 0; }
    }
  }

  /**
   * voiceChain for filter types 0..4 without a crossfade: DC blocker, sub,
   * Air, drive, state variable filter, envelope and pan in one pass (the
   * same arithmetic as the split path, sample for sample).
   */
  voiceChainFused(P, v, base, n2, rc) {
    const SL = this.sumL, SR = this.sumR;
    const bL = rc.busL, bR = rc.busR;
    const stereo = v.stereo;
    if (v.mTrack) this.removeMean(v, n2, stereo);
    const pdOn = v.pdOn;
    let pxL = v.pdxL, pyL = v.pdyL, pxR = v.pdxR, pyR = v.pdyR;
    const ftype = v.ft;
    let g = v.g, kq = v.k, drive = v.drive;
    const dg = v.dg, dk = v.dk, dDrive = v.dDrive;
    const driveOn = drive > 1e-4 || drive + dDrive * n2 > 1e-4;
    let ic1L = v.ic1L, ic2L = v.ic2L, ic1R = v.ic1R, ic2R = v.ic2R;
    let dxL = v.dcxL, dyL = v.dcyL, dxR = v.dcxR, dyR = v.dcyR;
    const R = rc.dcR;
    let st = v.envStage, lvl = v.envLvl;
    const attC = rc.attC, decC = rc.decC, relC = rc.relC, sus = rc.sus;
    const vg = v.velGain;
    let gl = v.gl, gr = v.gr;
    const dgl = v.dgl, dgr = v.dgr;
    const stealing = v.stealFade > 0;
    let sg = v.stealGain;
    const ss = v.stealStep;
    const subOn = v.subLv !== 0 || v.dSubLv !== 0;
    let sPh = v.subPh, sInc = v.subInc, sLv = v.subLv;
    const dsInc = v.dSubInc, dsLv = v.dSubLv;
    const sub2On=v.ex[EX.sub2] !== 0 || v.dex[EX.sub2] !== 0;
    let s2Ph=v.sub2Ph,s2Inc=0.5*v.subInc,s2Lv=v.ex[EX.sub2]-v.dex[EX.sub2]*n2;
    const ds2Inc=0.5*v.dSubInc,ds2Lv=v.dex[EX.sub2];
    let aH = v.aH, aD = v.aD;
    const daH = v.daH, daD = v.daD;
    const airOn = aH !== 0 || aD !== 0 || daH !== 0 || daD !== 0;
    let nz = v.nz, tlL = v.tlL, tlR = v.tlR;
    const ta = rc.tiltA;

    if (v.dcInit) {
      // see startVoice(): y[-1] = x[0] - mean makes the first output x[0] - mean
      v.dcInit = false;
      dxL = SL[0]; dyL = SL[0] - v.dcMeanL;
      if (stereo) { dxR = SR[0]; dyR = SR[0] - v.dcMeanR; }
    }
    for (let j = 0; j < n2; j++) {
      g += dg; kq += dk; gl += dgl; gr += dgr;
      const sL = SL[j];
      let yL = sL - dxL + R * dyL;
      dxL = sL; dyL = yL;
      let yR = 0;
      if (stereo) { const sR = SR[j]; yR = sR - dxR + R * dyR; dxR = sR; dyR = yR; }
      if (subOn) {
        sPh += sInc;
        if (sPh >= 1) sPh -= 1;
        sInc += dsInc; sLv += dsLv;
        const sv = sLv * (v.subKind === 0 ? fastSin(sPh) : subWave(v.subKind, sPh, sInc));
        yL += sv; yR += sv;
      }
      if (sub2On) {
        s2Ph+=s2Inc; if (s2Ph >= 1) s2Ph-=1;
        s2Inc+=ds2Inc; s2Lv+=ds2Lv;
        const sv=SUB_GAIN*s2Lv*s2Lv*subWave(v.sub2Kind,s2Ph,s2Inc);
        yL+=sv; yR+=sv;
      }
      if (airOn) {
        aH += daH; aD += daD;
        nz ^= nz << 13; nz ^= nz >>> 17; nz ^= nz << 5;
        const xL = nz * 4.656612873077393e-10;
        tlL += ta * (xL - tlL);
        yL += aH * xL + aD * tlL;
        if (stereo) {
          nz ^= nz << 13; nz ^= nz >>> 17; nz ^= nz << 5;
          const xR = nz * 4.656612873077393e-10;
          tlR += ta * (xR - tlR);
          yR += aH * xR + aD * tlR;
        }
      }
      if (driveOn) {
        drive += dDrive;
        const dgain = 1 + 5 * drive, comp = 1 / (1 + drive);
        let x = yL * dgain;
        yL = (x > 3 ? 1 : x < -3 ? -1 : x * (27 + x * x) / (27 + 9 * x * x)) * comp;
        if (stereo) {
          x = yR * dgain;
          yR = (x > 3 ? 1 : x < -3 ? -1 : x * (27 + x * x) / (27 + 9 * x * x)) * comp;
        }
      }
      if (ftype !== 0) {
        const a1c = 1 / (1 + g * (g + kq)), a2c = g * a1c, a3c = g * a2c;
        let v3 = yL - ic2L;
        let v1 = a1c * ic1L + a2c * v3;
        let v2 = ic2L + a2c * ic1L + a3c * v3;
        ic1L = 2 * v1 - ic1L; ic2L = 2 * v2 - ic2L;
        yL = ftype === 1 ? v2 : ftype === 2 ? kq * v1 : ftype === 3 ? yL - kq * v1 - v2 : yL - kq * v1;
        if (stereo) {
          v3 = yR - ic2R;
          v1 = a1c * ic1R + a2c * v3;
          v2 = ic2R + a2c * ic1R + a3c * v3;
          ic1R = 2 * v1 - ic1R; ic2R = 2 * v2 - ic2R;
          yR = ftype === 1 ? v2 : ftype === 2 ? kq * v1 : ftype === 3 ? yR - kq * v1 - v2 : yR - kq * v1;
        }
      }
      if (pdOn) {
        const xL = yL;
        yL = xL - pxL + R * pyL; pxL = xL; pyL = yL;
        if (stereo) { const xR = yR; yR = xR - pxR + R * pyR; pxR = xR; pyR = yR; }
      }
      // amp envelope: exponential segments at the oversampled rate
      if (st === ATTACK) {
        lvl = ATTACK_OVERSHOOT + (lvl - ATTACK_OVERSHOOT) * attC;
        if (lvl >= 1) { lvl = 1; st = DECAY; }
      } else if (st === DECAY) {
        lvl = sus + (lvl - sus) * decC;
      } else if (st === RELEASE) {
        lvl = -ENV_FLOOR + (lvl + ENV_FLOOR) * relC;
        if (lvl <= 0) { lvl = 0; st = IDLE; }
      }
      let amp = lvl * vg;
      if (stealing) {
        sg -= ss;
        if (sg < 0) sg = 0;
        amp *= sg;
      }
      yL *= amp;
      if (yL > 2 || yL < -2) yL = softLimit(yL);
      if (stereo) {
        yR *= amp;
        if (yR > 2 || yR < -2) yR = softLimit(yR);
      } else {
        yR = yL;
      }
      bL[base + j] += yL * gl;
      bR[base + j] += yR * gr;
    }

    v.g = g; v.k = kq; v.drive = drive; v.gl = gl; v.gr = gr;
    v.ic1L = ic1L; v.ic2L = ic2L; v.ic1R = ic1R; v.ic2R = ic2R;
    v.dcxL = dxL; v.dcyL = dyL; v.dcxR = dxR; v.dcyR = dyR;
    v.envStage = st; v.envLvl = lvl;
    v.stealGain = sg;
    if (subOn) { v.subPh = sPh; v.subInc = sInc; v.subLv = sLv; } else v.subInc += dsInc * n2;
    if (sub2On) v.sub2Ph=s2Ph;
    if (airOn) { v.aH = aH; v.aD = aD; v.nz = nz; v.tlL = tlL; v.tlR = tlR; }
    if (pdOn) { v.pdxL = pxL; v.pdyL = pyL; v.pdxR = pxR; v.pdyR = pyR; }
    this.advanceComb(v, n2);
    this.advanceVowel(v, n2);
  }

  /** Subtract the tracked mean height of the cycle (ramped) from sumL/sumR, scaled by the unison gains. */
  removeMean(v, n2, stereo) {
    const SL = this.sumL, SR = this.sumR;
    let gsL = 0, gsR = 0;
    for (let q = 0; q < v.uRun; q++) { gsL += v.ugL[q]; gsR += v.ugR[q]; }
    let m = v.mCur;
    const dm = v.dMean;
    for (let j = 0; j < n2; j++) {
      m += dm;
      SL[j] -= m * gsL;
      if (stereo) SR[j] -= m * gsR;
    }
    v.mCur = m;
  }

  /**
   * The per-voice chain for n2 samples of sumL/sumR, accumulated into the
   * bus at `base`: DC blocker, sub sine, Air, drive (one pass), the filter
   * (in place, with a crossfade from the previous type), then the amp
   * envelope, steal fade, soft limit and pan.
   */
  voiceChain(P, v, base, n2, rc) {
    // the common case (a state variable filter or none, no filter change in
    // progress) runs as one fused loop: no intermediate buffers
    if (v.ft <= 4 && !(v.ftW > 0) && !v.ampCustom && !v.f2On) { this.voiceChainFused(P, v, base, n2, rc); return; }
    const SL = this.sumL, SR = this.sumR;
    const bL = rc.busL, bR = rc.busR;
    const stereo = v.stereo;
    if (v.mTrack) this.removeMean(v, n2, stereo);
    let drive = v.drive;
    const dDrive = v.dDrive;
    const driveOn = drive > 1e-4 || drive + dDrive * n2 > 1e-4;
    let dxL = v.dcxL, dyL = v.dcyL, dxR = v.dcxR, dyR = v.dcyR;
    const R = rc.dcR;
    // sub sine: after the DC blocker (it has no DC to remove and the blocker
    // would only shift its phase), before drive and filter so they shape it
    const subOn = v.subLv !== 0 || v.dSubLv !== 0;
    let sPh = v.subPh, sInc = v.subInc, sLv = v.subLv;
    const dsInc = v.dSubInc, dsLv = v.dSubLv;
    const sub2On=v.ex[EX.sub2] !== 0 || v.dex[EX.sub2] !== 0;
    let s2Ph=v.sub2Ph,s2Inc=0.5*v.subInc,s2Lv=v.ex[EX.sub2]-v.dex[EX.sub2]*n2;
    const ds2Inc=0.5*v.dSubInc,ds2Lv=v.dex[EX.sub2];
    // Air: white noise, tilted (aH * x + aD * lowpass(x)), also before the filter
    let aH = v.aH, aD = v.aD;
    const daH = v.daH, daD = v.daD;
    const airOn = aH !== 0 || aD !== 0 || daH !== 0 || daD !== 0;
    let nz = v.nz, tlL = v.tlL, tlR = v.tlR;
    const ta = rc.tiltA;

    if (v.dcInit) {
      // see startVoice(): y[-1] = x[0] - mean makes the first output x[0] - mean
      v.dcInit = false;
      dxL = SL[0]; dyL = SL[0] - v.dcMeanL;
      if (stereo) { dxR = SR[0]; dyR = SR[0] - v.dcMeanR; }
    }
    for (let j = 0; j < n2; j++) {
      const sL = SL[j];
      let yL = sL - dxL + R * dyL;
      dxL = sL; dyL = yL;
      let yR = 0;
      if (stereo) { const sR = SR[j]; yR = sR - dxR + R * dyR; dxR = sR; dyR = yR; }
      if (subOn) {
        sPh += sInc;
        if (sPh >= 1) sPh -= 1;
        sInc += dsInc; sLv += dsLv;
        const sv = sLv * (v.subKind === 0 ? fastSin(sPh) : subWave(v.subKind, sPh, sInc));
        yL += sv; yR += sv;
      }
      if (sub2On) {
        s2Ph+=s2Inc; if (s2Ph >= 1) s2Ph-=1;
        s2Inc+=ds2Inc; s2Lv+=ds2Lv;
        const sv=SUB_GAIN*s2Lv*s2Lv*subWave(v.sub2Kind,s2Ph,s2Inc);
        yL+=sv; yR+=sv;
      }
      if (airOn) {
        aH += daH; aD += daD;
        nz ^= nz << 13; nz ^= nz >>> 17; nz ^= nz << 5;
        const xL = nz * 4.656612873077393e-10;
        tlL += ta * (xL - tlL);
        yL += aH * xL + aD * tlL;
        if (stereo) {
          nz ^= nz << 13; nz ^= nz >>> 17; nz ^= nz << 5;
          const xR = nz * 4.656612873077393e-10;
          tlR += ta * (xR - tlR);
          yR += aH * xR + aD * tlR;
        }
      }
      if (driveOn) {
        drive += dDrive;
        const dgain = 1 + 5 * drive, comp = 1 / (1 + drive);
        let x = yL * dgain;
        yL = (x > 3 ? 1 : x < -3 ? -1 : x * (27 + x * x) / (27 + 9 * x * x)) * comp;
        if (stereo) {
          x = yR * dgain;
          yR = (x > 3 ? 1 : x < -3 ? -1 : x * (27 + x * x) / (27 + 9 * x * x)) * comp;
        }
      }
      SL[j] = yL; SR[j] = yR;
    }
    v.dcxL = dxL; v.dcyL = dyL; v.dcxR = dxR; v.dcyR = dyR;
    v.drive = drive;
    if (subOn) { v.subPh = sPh; v.subInc = sInc; v.subLv = sLv; } else v.subInc += dsInc * n2;
    if (sub2On) v.sub2Ph=s2Ph;
    if (airOn) { v.aH = aH; v.aD = aD; v.nz = nz; v.tlL = tlL; v.tlR = tlR; }

    const f2 = v.f2On, route = P.f2Route;
    if (f2 && route !== 0) { this.f2L.set(SL.subarray(0, n2)); this.f2R.set((stereo ? SR : SL).subarray(0, n2)); }
    this.filterStage(v, n2, stereo);
    if (f2) this.filter2Stage(v, n2, stereo, route);
    if (v.pdOn) {
      let pxL = v.pdxL, pyL = v.pdyL, pxR = v.pdxR, pyR = v.pdyR;
      for (let j = 0; j < n2; j++) {
        const xL = SL[j];
        const yL = xL - pxL + R * pyL; pxL = xL; pyL = yL; SL[j] = yL;
        if (stereo) { const xR = SR[j]; const yR = xR - pxR + R * pyR; pxR = xR; pyR = yR; SR[j] = yR; }
      }
      v.pdxL = pxL; v.pdyL = pyL; v.pdxR = pxR; v.pdyR = pyR;
    }

    // amp envelope: exponential segments at the oversampled rate
    let st = v.envStage, lvl = v.envLvl;
    const attC = rc.attC, decC = rc.decC, relC = rc.relC, sus = rc.sus;
    const vg = v.velGain;
    let gl = v.gl, gr = v.gr;
    const dgl = v.dgl, dgr = v.dgr;
    const stealing = v.stealFade > 0;
    let sg = v.stealGain;
    const ss = v.stealStep;
    for (let j = 0; j < n2; j++) {
      gl += dgl; gr += dgr;
      let yL = SL[j], yR = SR[j];
      if (v.ampCustom) {
        lvl=v.ampExtra.sample(1 / (this.sr * rc.os));
        st=v.ampExtra.stage === 0 ? IDLE : (v.ampExtra.stage === 6 ? RELEASE : ATTACK);
      } else if (st === ATTACK) {
        lvl = ATTACK_OVERSHOOT + (lvl - ATTACK_OVERSHOOT) * attC;
        if (lvl >= 1) { lvl = 1; st = DECAY; }
      } else if (st === DECAY) {
        lvl = sus + (lvl - sus) * decC;
      } else if (st === RELEASE) {
        lvl = -ENV_FLOOR + (lvl + ENV_FLOOR) * relC;
        if (lvl <= 0) { lvl = 0; st = IDLE; }
      }
      let amp = lvl * vg;
      if (stealing) {
        sg -= ss;
        if (sg < 0) sg = 0;
        amp *= sg;
      }
      yL *= amp;
      if (yL > 2 || yL < -2) yL = softLimit(yL);
      if (stereo) {
        yR *= amp;
        if (yR > 2 || yR < -2) yR = softLimit(yR);
      } else {
        yR = yL;
      }
      bL[base + j] += yL * gl;
      bR[base + j] += yR * gr;
    }
    v.gl = gl; v.gr = gr;
    v.envStage = st; v.envLvl = lvl;
    v.stealGain = sg;
  }

  /**
   * v2.2 Filter 2 on sumL/sumR (already through Filter 1). Serial filters
   * that signal; Parallel and Split filter the pre-Filter 1 copy in f2L/f2R.
   * Mix crossfades from Filter 1's output to Filter 2's (Split: right only).
   */
  filter2Stage(v, n2, stereo, route) {
    const SL = this.sumL, SR = this.sumR, XL = this.f2L, XR = this.f2R;
    if (route === 0) { XL.set(SL.subarray(0, n2)); if (stereo) XR.set(SR.subarray(0, n2)); }
    v.f2.process(XL, XR, n2, stereo);
    let m = v.f2Mix; const dm = v.df2Mix;
    for (let j = 0; j < n2; j++) {
      m += dm;
      if (route !== 2) SL[j] += m * (XL[j] - SL[j]);
      if (stereo) SR[j] += m * (XR[j] - SR[j]);
    }
    v.f2Mix = m;
  }

  /** Filter sumL/sumR in place with the voice's type, fading out the previous type after a change. */
  filterStage(v, n2, stereo) {
    const SL = this.sumL, SR = this.sumR, TL = this.tmpL, TR = this.tmpR;
    const ft = v.ft;
    const fading = v.ftW > 0;
    const fo = fading ? v.ftOld : ft;
    const svfNew = ft >= 1 && ft <= 4, svfOld = fo >= 1 && fo <= 4;
    if (!fading) {
      if (ft >= 7) this.analogBlock(v, SL, SR, n2, stereo, true);
      if (svfNew) this.svfBlock(v, n2, stereo, ft, ft, 0, 0);
      else this.advanceSvf(v, n2);
      if (ft === 5) this.combBlock(v, SL, SR, n2, stereo); else this.advanceComb(v, n2);
      if (ft === 6) this.vowelBlock(v, SL, SR, n2, stereo); else this.advanceVowel(v, n2);
      return;
    }
    let w = v.ftW;
    const dw = v.ftDW;
    if (svfNew && svfOld) {
      // one state variable filter, the output tap crossfades
      this.svfBlock(v, n2, stereo, ft, fo, w, dw);
      w -= dw * n2;
    } else {
      for (let j = 0; j < n2; j++) { TL[j] = SL[j]; TR[j] = SR[j]; }
      // New digital models own two filter states so old/new models can overlap.
      if (fo >= 7) this.analogBlock(v, TL, TR, n2, stereo, false);
      if (ft >= 7) this.analogBlock(v, SL, SR, n2, stereo, true);
      // old type on the copy, new type in place
      if (svfOld) { this.svfBlockOn(v, TL, TR, n2, stereo, fo); }
      else if (fo === 5) this.combBlock(v, TL, TR, n2, stereo);
      else if (fo === 6) this.vowelBlock(v, TL, TR, n2, stereo);
      if (svfNew) this.svfBlockOn(v, SL, SR, n2, stereo, ft);
      else if (ft === 5) this.combBlock(v, SL, SR, n2, stereo);
      else if (ft === 6) this.vowelBlock(v, SL, SR, n2, stereo);
      if (!svfOld && !svfNew) this.advanceSvf(v, n2);
      if (fo !== 5 && ft !== 5) this.advanceComb(v, n2);
      if (fo !== 6 && ft !== 6) this.advanceVowel(v, n2);
      for (let j = 0; j < n2; j++) {
        w -= dw; if (w < 0) w = 0;
        SL[j] += w * (TL[j] - SL[j]);
        if (stereo) SR[j] += w * (TR[j] - SR[j]);
      }
    }
    v.ftW = w > 0 ? w : 0;
  }

  advanceSvf(v, n2) { v.g += v.dg * n2; v.k += v.dk * n2; }
  advanceComb(v, n2) { v.cD += v.dcD * n2; v.cFb += v.dcFb * n2; v.cFf += v.dcFf * n2; v.cMk += v.dcMk * n2; }
  advanceVowel(v, n2) { const vf = v.vf, dvf = v.dvf; for (let i = 0; i < 9; i++) vf[i] += dvf[i] * n2; }

  /**
   * TPT state variable filter on sumL/sumR (types 1 Low, 2 Band, 3 High,
   * 4 Notch). With w > 0 the output is crossfaded from type `fo`'s tap
   * (weight w, falling by dw per sample) to type ft's.
   */
  svfBlock(v, n2, stereo, ft, fo, w, dw) {
    const SL = this.sumL, SR = this.sumR;
    let g = v.g, kq = v.k;
    const dg = v.dg, dk = v.dk;
    let ic1L = v.ic1L, ic2L = v.ic2L, ic1R = v.ic1R, ic2R = v.ic2R;
    const mix = w > 0;
    for (let j = 0; j < n2; j++) {
      g += dg; kq += dk;
      let yL = SL[j];
      const a1c = 1 / (1 + g * (g + kq)), a2c = g * a1c, a3c = g * a2c;
      let v3 = yL - ic2L;
      let v1 = a1c * ic1L + a2c * v3;
      let v2 = ic2L + a2c * ic1L + a3c * v3;
      ic1L = 2 * v1 - ic1L; ic2L = 2 * v2 - ic2L;
      let oL = ft === 1 ? v2 : ft === 2 ? kq * v1 : ft === 3 ? yL - kq * v1 - v2 : yL - kq * v1;
      if (mix) {
        w -= dw; if (w < 0) w = 0;
        const pL = fo === 1 ? v2 : fo === 2 ? kq * v1 : fo === 3 ? yL - kq * v1 - v2 : yL - kq * v1;
        oL += w * (pL - oL);
      }
      SL[j] = oL;
      if (stereo) {
        const yR = SR[j];
        v3 = yR - ic2R;
        v1 = a1c * ic1R + a2c * v3;
        v2 = ic2R + a2c * ic1R + a3c * v3;
        ic1R = 2 * v1 - ic1R; ic2R = 2 * v2 - ic2R;
        let oR = ft === 1 ? v2 : ft === 2 ? kq * v1 : ft === 3 ? yR - kq * v1 - v2 : yR - kq * v1;
        if (mix) {
          const pR = fo === 1 ? v2 : fo === 2 ? kq * v1 : fo === 3 ? yR - kq * v1 - v2 : yR - kq * v1;
          oR += w * (pR - oR);
        }
        SR[j] = oR;
      }
    }
    v.g = g; v.k = kq;
    v.ic1L = ic1L; v.ic2L = ic2L; v.ic1R = ic1R; v.ic2R = ic2R;
  }

  /** The state variable filter on arbitrary buffers (filter-type crossfades). */
  svfBlockOn(v, XL, XR, n2, stereo, ft) {
    let g = v.g, kq = v.k;
    const dg = v.dg, dk = v.dk;
    let ic1L = v.ic1L, ic2L = v.ic2L, ic1R = v.ic1R, ic2R = v.ic2R;
    for (let j = 0; j < n2; j++) {
      g += dg; kq += dk;
      const a1c = 1 / (1 + g * (g + kq)), a2c = g * a1c, a3c = g * a2c;
      const yL = XL[j];
      let v3 = yL - ic2L;
      let v1 = a1c * ic1L + a2c * v3;
      let v2 = ic2L + a2c * ic1L + a3c * v3;
      ic1L = 2 * v1 - ic1L; ic2L = 2 * v2 - ic2L;
      XL[j] = ft === 1 ? v2 : ft === 2 ? kq * v1 : ft === 3 ? yL - kq * v1 - v2 : yL - kq * v1;
      if (stereo) {
        const yR = XR[j];
        v3 = yR - ic2R;
        v1 = a1c * ic1R + a2c * v3;
        v2 = ic2R + a2c * ic1R + a3c * v3;
        ic1R = 2 * v1 - ic1R; ic2R = 2 * v2 - ic2R;
        XR[j] = ft === 1 ? v2 : ft === 2 ? kq * v1 : ft === 3 ? yR - kq * v1 - v2 : yR - kq * v1;
      }
    }
    v.g = g; v.k = kq;
    v.ic1L = ic1L; v.ic2L = ic2L; v.ic1R = ic1R; v.ic2R = ic2R;
  }

  /** Comb filter in place (see combControl). Linear-interpolated taps keep the loop passive, so it never blows up. */
  combBlock(v, XL, XR, n2, stereo) {
    const buf = v.comb;
    if (!buf) { this.advanceComb(v, n2); return; }
    const len = v.combLen, mask = len - 1;
    let D = v.cD, fb = v.cFb, ff = v.cFf, mk = v.cMk;
    const dD = v.dcD, dfb = v.dcFb, dff = v.dcFf, dmk = v.dcMk;
    let wi = v.cw;
    for (let j = 0; j < n2; j++) {
      D += dD; fb += dfb; ff += dff; mk += dmk;
      const p1 = wi - D, p2 = wi - 2 * D;
      const i1 = Math.floor(p1), f1 = p1 - i1, i2 = Math.floor(p2), f2 = p2 - i2;
      {
        const a1 = buf[i1 & mask], a2 = buf[i2 & mask];
        const d1 = a1 + f1 * (buf[(i1 + 1) & mask] - a1);
        const d2 = a2 + f2 * (buf[(i2 + 1) & mask] - a2);
        const w = XL[j] + fb * d2;
        buf[wi] = w;
        XL[j] = mk * (w + ff * d1);
      }
      if (stereo) {
        const o = len;
        const a1 = buf[o + (i1 & mask)], a2 = buf[o + (i2 & mask)];
        const d1 = a1 + f1 * (buf[o + ((i1 + 1) & mask)] - a1);
        const d2 = a2 + f2 * (buf[o + ((i2 + 1) & mask)] - a2);
        const w = XR[j] + fb * d2;
        buf[o + wi] = w;
        XR[j] = mk * (w + ff * d1);
      }
      wi = (wi + 1) & mask;
    }
    v.cw = wi;
    v.cD = D; v.cFb = fb; v.cFf = ff; v.cMk = mk;
  }

  /** Vowel filter in place: three TPT band-passes summed with their formant levels. */
  vowelBlock(v, XL, XR, n2, stereo) {
    const vf = v.vf, dvf = v.dvf, s = v.vs;
    let g1 = vf[0], g2 = vf[1], g3 = vf[2], k1 = vf[3], k2 = vf[4], k3 = vf[5], m1 = vf[6], m2 = vf[7], m3 = vf[8];
    const dg1 = dvf[0], dg2 = dvf[1], dg3 = dvf[2], dk1 = dvf[3], dk2 = dvf[4], dk3 = dvf[5], dm1 = dvf[6], dm2 = dvf[7], dm3 = dvf[8];
    let a1 = s[0], b1 = s[1], a2 = s[2], b2 = s[3], a3 = s[4], b3 = s[5];
    let c1 = s[6], e1 = s[7], c2 = s[8], e2 = s[9], c3 = s[10], e3 = s[11];
    for (let j = 0; j < n2; j++) {
      g1 += dg1; g2 += dg2; g3 += dg3; k1 += dk1; k2 += dk2; k3 += dk3; m1 += dm1; m2 += dm2; m3 += dm3;
      const h1 = 1 / (1 + g1 * (g1 + k1)), h2 = 1 / (1 + g2 * (g2 + k2)), h3 = 1 / (1 + g3 * (g3 + k3));
      const xL = XL[j];
      let t = xL - b1, p = h1 * (a1 + g1 * t);
      b1 += 2 * g1 * p; a1 = 2 * p - a1;
      let y = m1 * p;
      t = xL - b2; p = h2 * (a2 + g2 * t);
      b2 += 2 * g2 * p; a2 = 2 * p - a2;
      y += m2 * p;
      t = xL - b3; p = h3 * (a3 + g3 * t);
      b3 += 2 * g3 * p; a3 = 2 * p - a3;
      XL[j] = y + m3 * p;
      if (stereo) {
        const xR = XR[j];
        t = xR - e1; p = h1 * (c1 + g1 * t);
        e1 += 2 * g1 * p; c1 = 2 * p - c1;
        y = m1 * p;
        t = xR - e2; p = h2 * (c2 + g2 * t);
        e2 += 2 * g2 * p; c2 = 2 * p - c2;
        y += m2 * p;
        t = xR - e3; p = h3 * (c3 + g3 * t);
        e3 += 2 * g3 * p; c3 = 2 * p - c3;
        XR[j] = y + m3 * p;
      }
    }
    vf[0] = g1; vf[1] = g2; vf[2] = g3; vf[3] = k1; vf[4] = k2; vf[5] = k3; vf[6] = m1; vf[7] = m2; vf[8] = m3;
    s[0] = a1; s[1] = b1; s[2] = a2; s[3] = b2; s[4] = a3; s[5] = b3;
    s[6] = c1; s[7] = e1; s[8] = c2; s[9] = e2; s[10] = c3; s[11] = e3;
  }

  /**
   * Pass 1 of the Laps/Pace/travel oscillator. Per unison oscillator and
   * sample: the cycle phase φ advances at the note frequency; Pace warps it
   * to ψ, Laps gives the path phase t = frac(laps ψ), then ping-pong and
   * Even re-map t. Every wrap of φ is a hard-sync restart; it is recorded
   * (sample, sub-sample position, laps) for syncBlep(), including one
   * look-ahead restart that falls between this segment's last sample and the
   * next segment's first. With `paced` the log2 of the local Pace speed goes
   * into this.lvs[q] for the per-sample mip level. Returns the number of
   * recorded restarts.
   */
  syncPaths(P, v, n2, paced, trav, shape, order) {
    const U = v.uRun, T = this.ts, PH = this.phs;
    const L0 = v.laps, dL = v.dLaps;
    const evQ = this.evQ, evJ = this.evJ, evD = this.evD, evL = this.evL;
    let nEv = 0;
    for (let q = 0; q < U; q++) {
      const LV = this.lvs[q];
      let ph = v.phase[q], inc = v.inc[q];
      const dinc = v.dinc[q];
      // the previous segment already corrected a restart on our first sample
      const done = v.blepSkip[q] === 1;
      for (let j = 0; j < n2; j++) {
        const step = inc;
        ph += inc;
        inc += dinc;
        if (ph >= 1) {
          ph -= 1;
          if (j > 0 || !done) { evQ[nEv] = q; evJ[nEv] = j; evD[nEv] = ph / step; evL[nEv] = L0 + dL * (j + 1); nEv++; }
        }
        PH[j] = ph;
      }
      // look-ahead: the next segment's first sample computes exactly ph + inc
      v.blepSkip[q] = 0;
      if (ph + inc >= 1) {
        evQ[nEv] = q; evJ[nEv] = n2; evD[nEv] = (ph + inc - 1) / inc; evL[nEv] = L0 + dL * n2; nEv++;
        v.blepSkip[q] = 1;
      }
      let L = L0;
      if (paced) {
        // ψ, then the local speed as dψ/dφ over each sample step: what the
        // dot actually travelled, without a second curve evaluation
        let prev = paceWarp(v.phase[q], v.pace, v.paceShape);
        const invInc = 2 / (v.inc[q] + inc);
        paceBlock(v.paceShape, n2, PH, v.pace, v.dPace, T);
        for (let j = 0; j < n2; j++) {
          L += dL;
          const psi = T[j];
          let dpsi = psi - prev;
          if (dpsi < 0) dpsi += 1;
          prev = psi;
          LV[j] = speedLog2(dpsi * invInc);
          const t = L * psi;
          T[j] = t - Math.floor(t);
        }
      } else {
        for (let j = 0; j < n2; j++) {
          L += dL;
          const t = L * PH[j];
          T[j] = t - Math.floor(t);
        }
      }
      v.phase[q] = ph; v.inc[q] = inc;
      if (trav !== 0) travelBlock(shape, order, n2, T, v.param, v.dParam, trav & 1, trav & 2);
      pathBlockAt(shape, order, n2, T, v.param, v.dParam, this.xs[q], this.ys[q]);
    }
    return nEv;
  }

  /**
   * Pass 2 when Pace is active: as the block pass, but the mip level follows
   * the local traversal speed sample by sample (block level + log2 of the
   * Pace speed from syncPaths), so the rushed part of a cycle reads smoother
   * tables than the lingering part and neither aliases nor dulls.
   */
  terrainPaced(P, v, n2) {
    const U = v.uRun, gUL = v.ugL, gUR = v.ugR, stereo = v.stereo, gRamp = v.gRamp;
    const XS = this.xs, YS = this.ys, SL = this.sumL, SR = this.sumR;
    const chA = P.terrA, topA = chA.length - 1, chB = P.terrB, topB = chB.length - 1;
    const fA0 = P.fadeACur, dfA = P.dFadeA, oldA = P.oldA;
    const fadeAOn = oldA !== null && (fA0 > 0 || fA0 + dfA * n2 > 0);
    const fB0 = P.fadeBCur, dfB = P.dFadeB, oldB = P.oldB;
    const fadeBOn = oldB !== null && (fB0 > 0 || fB0 + dfB * n2 > 0);
    const m0 = v.morph, dMorph = v.dMorph, mEnd = m0 + dMorph * n2;
    const needA = m0 < 0.9999 || mEnd < 0.9999;
    const needB = m0 > 1e-4 || mEnd > 1e-4;
    const wp0 = v.warp, dWarp = v.dWarp;
    const warpOn = wp0 > 0 || wp0 + dWarp * n2 > 0;
    const lf0 = v.lift, dLift = v.dLift, fd0 = v.fold, dFold = v.dFold;
    const shapeOn = !(lf0 === 1 && dLift === 0 && fd0 <= 0 && fd0 + dFold * n2 <= 0);
    const tA0 = v.tA, tB0 = v.tB, tC0 = v.tC, tD0 = v.tD, cx0 = v.cx, cy0 = v.cy;
    const dtA = v.dtA, dtB = v.dtB, dtC = v.dtC, dtD = v.dtD, dcx = v.dcx, dcy = v.dcy;
    const lvA0 = v.cLvA, dlvA = v.dcLvA, lvB0 = v.cLvB, dlvB = v.dcLvB;

    // The level changes only a few times per cycle, so the tables of the
    // current level pair are cached and re-read only when it moves.
    const oA = oldA !== null ? oldA : chA, oB = oldB !== null ? oldB : chB;
    for (let q = 0; q < U; q++) {
      const X = XS[q], Y = YS[q], LV = this.lvs[q];
      let gl = gUL[q], gr = gUR[q];
      const dgl = gRamp ? v.dugL[q] : 0, dgr = gRamp ? v.dugR[q] : 0;
      let tA = tA0, tB = tB0, tC = tC0, tD = tD0, cx = cx0, cy = cy0, dcxq = dcx, dcyq = dcy;
      if (v.ms !== 0 || v.dms !== 0) { cx += P.uMapX[q] * v.ms; cy += P.uMapY[q] * v.ms; dcxq += P.uMapX[q] * v.dms; dcyq += P.uMapY[q] * v.dms; }
      let morph = m0, warp = wp0, lift = lf0, fold = fd0, fA = fA0, fB = fB0, lvA = lvA0, lvB = lvB0;
      let curA = -1, a0 = chA[0].data, sa0 = 1, ma0 = 0, a1 = a0, sa1 = 1, ma1 = 0, oa = a0, osa = 1, oma = 0;
      let curB = -1, b0 = chB[0].data, sb0 = 1, mb0 = 0, b1 = b0, sb1 = 1, mb1 = 0, ob = b0, osb = 1, omb = 0;
      for (let j = 0; j < n2; j++) {
        tA += dtA; tB += dtB; tC += dtC; tD += dtD; cx += dcxq; cy += dcyq;
        lvA += dlvA; lvB += dlvB;
        if (gRamp) { gl += dgl; gr += dgr; }
        const px = X[j], py = Y[j], off = LV[j];
        let u = cx + px * tA - py * tB;
        let w = cy + px * tC + py * tD;
        if (warpOn) {
          warp += dWarp;
          const ww = warp * 0.06;
          const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
          w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
          u = u2;
        }
        let h = 0;
        if (needA) {
          let lv = lvA + off;
          if (lv < 0) lv = 0; else if (lv > topA) lv = topA;
          const l = lv | 0;
          if (l !== curA) {
            curA = l;
            const t0 = chA[l], t1 = chA[l < topA ? l + 1 : l], to = oA[l < oA.length ? l : oA.length - 1];
            a0 = t0.data; sa0 = t0.size; ma0 = sa0 - 1;
            a1 = t1.data; sa1 = t1.size; ma1 = sa1 - 1;
            oa = to.data; osa = to.size; oma = osa - 1;
          }
          h = bil(a0, sa0, ma0, u, w);
          const z = (lv - l - 0.5) * 2;   // mipZone; 0 at the top level (t1 = t0 there)
          if (z > 0) h += (z > 1 ? 1 : z) * (bil(a1, sa1, ma1, u, w) - h);
          if (fadeAOn) { fA += dfA; if (fA > 0) h += fA * (bil(oa, osa, oma, u, w) - h); }
        }
        if (needB) {
          let lv = lvB + off;
          if (lv < 0) lv = 0; else if (lv > topB) lv = topB;
          const l = lv | 0;
          if (l !== curB) {
            curB = l;
            const t0 = chB[l], t1 = chB[l < topB ? l + 1 : l], to = oB[l < oB.length ? l : oB.length - 1];
            b0 = t0.data; sb0 = t0.size; mb0 = sb0 - 1;
            b1 = t1.data; sb1 = t1.size; mb1 = sb1 - 1;
            ob = to.data; osb = to.size; omb = osb - 1;
          }
          let hb = bil(b0, sb0, mb0, u, w);
          const z = (lv - l - 0.5) * 2;
          if (z > 0) hb += (z > 1 ? 1 : z) * (bil(b1, sb1, mb1, u, w) - hb);
          if (fadeBOn) { fB += dfB; if (fB > 0) hb += fB * (bil(ob, osb, omb, u, w) - hb); }
          morph += dMorph;
          h = needA ? h + morph * (hb - h) : hb;
        }
        if (shapeOn) {
          lift += dLift; fold += dFold;
          const y = h * lift;
          const ay = y < 0 ? -y : y;
          let sh = y;
          if (ay > 1) {
            const e = 2 * (ay - 1);
            const kk = 1 + 0.5 * e / (1 + e);
            sh = y < 0 ? -kk : kk;
          }
          if (fold > 0) sh += fold * (fastSin(y * (1 + 4 * fold) * 0.25) - sh);
          h = sh;
        }
        if (q === 0) { SL[j] = h * gl; if (stereo) SR[j] = h * gr; }
        else { SL[j] += h * gl; SR[j] += h * gr; }
      }
    }
  }

  /**
   * Shaped terrain height the oscillator q would read at sample j of this
   * segment for the unit path point in this.pt: the scalar twin of pass 2
   * (same ramps, mips, crossfades, morph, warp, Lift/Fold), used to measure
   * the jump at a hard-sync restart. Takes no fractional arguments, so the
   * call boxes nothing (it runs once per restart, thousands of times a second).
   */
  heightAt(P, v, n2, j, q, paced) {
    const s = j + 1, px = this.pt.x, py = this.pt.y;
    const tA = v.tA + v.dtA * s, tB = v.tB + v.dtB * s, tC = v.tC + v.dtC * s, tD = v.tD + v.dtD * s;
    const mo = v.ms + v.dms * s;
    let u = v.cx + v.dcx * s + px * tA - py * tB + (mo !== 0 ? P.uMapX[q] * mo : 0);
    let w = v.cy + v.dcy * s + px * tC + py * tD + (mo !== 0 ? P.uMapY[q] * mo : 0);
    if (v.warp > 0 || v.warp + v.dWarp * n2 > 0) {
      const ww = (v.warp + v.dWarp * s) * 0.06;
      const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
      w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
      u = u2;
    }
    const off = paced ? this.lvs[q][j] : 0;
    const m0 = v.morph, mEnd = m0 + v.dMorph * n2;
    const needA = m0 < 0.9999 || mEnd < 0.9999;
    const needB = m0 > 1e-4 || mEnd > 1e-4;
    let h = 0;
    if (needA) {
      const ch = P.terrA, n = ch.length;
      let l, wt;
      if (paced) {
        let lv = v.cLvA + v.dcLvA * s + off;
        lv = lv < 0 ? 0 : lv > n - 1 ? n - 1 : lv;
        l = lv | 0;
        wt = l < n - 1 ? mipZone(lv - l) : 0;
      } else {
        l = v.lA < n ? v.lA : n - 1;
        const ws = l + 1 < n ? v.wA : 0, dw = l + 1 < n ? v.dwA : 0;
        wt = ws > 0 || ws + dw * n2 > 0 ? ws + dw * s : 0;
      }
      const f0 = P.fadeACur, df = P.dFadeA;
      const fadeOn = P.oldA !== null && (f0 > 0 || f0 + df * n2 > 0);
      h = chainHeight(ch, l, wt, fadeOn ? P.oldA : null, f0 + df * s, u, w);
    }
    if (needB) {
      const ch = P.terrB, n = ch.length;
      let l, wt;
      if (paced) {
        let lv = v.cLvB + v.dcLvB * s + off;
        lv = lv < 0 ? 0 : lv > n - 1 ? n - 1 : lv;
        l = lv | 0;
        wt = l < n - 1 ? mipZone(lv - l) : 0;
      } else {
        l = v.lB < n ? v.lB : n - 1;
        const ws = l + 1 < n ? v.wB : 0, dw = l + 1 < n ? v.dwB : 0;
        wt = ws > 0 || ws + dw * n2 > 0 ? ws + dw * s : 0;
      }
      const f0 = P.fadeBCur, df = P.dFadeB;
      const fadeOn = P.oldB !== null && (f0 > 0 || f0 + df * n2 > 0);
      const hb = chainHeight(ch, l, wt, fadeOn ? P.oldB : null, f0 + df * s, u, w);
      h = needA ? h + (m0 + v.dMorph * s) * (hb - h) : hb;
    }
    const lf0 = v.lift, fd0 = v.fold;
    if (!(lf0 === 1 && v.dLift === 0 && fd0 <= 0 && fd0 + v.dFold * n2 <= 0)) {
      const lift = lf0 + v.dLift * s, fold = fd0 + v.dFold * s;
      const y = h * lift;
      const ay = y < 0 ? -y : y;
      let sh = y;
      if (ay > 1) { const e = 2 * (ay - 1); const kk = 1 + 0.5 * e / (1 + e); sh = y < 0 ? -kk : kk; }
      if (fold > 0) sh += fold * (fastSin(y * (1 + 4 * fold) * 0.25) - sh);
      h = sh;
    }
    return h;
  }

  /**
   * Band-limit this segment's hard-sync restarts with a polyBLEP residual.
   * A restart at a fraction d of a sample before sample j makes the output
   * jump by D = height(path start) - height(where the cut lap ended), both
   * measured through the full terrain chain at that moment (t = 0 versus
   * t = frac(laps), each through the voice's travel map; integer Laps
   * restart where they already are, D = 0). The two-sample polyBLEP residual
   * adds D d^2 / 2 to sample j - 1 and -D (1 - d)^2 / 2 to sample j. A
   * look-ahead restart (j = n2) puts its first half on our last sample and
   * leaves the second for the next segment.
   * (A polyBLAMP for the change of slope at the restart was tried: under
   * 1 dB less aliasing for twice the lookups, so it is left out.)
   */
  syncBlep(P, v, n2, nEv, param0, paced, trav, shape, order) {
    if (!this.blep) return;
    const SL = this.sumL, SR = this.sumR, stereo = v.stereo;
    const evQ = this.evQ, evJ = this.evJ, evD = this.evD, evL = this.evL;
    const pt = this.pt, dp = v.dParam;
    for (let e = 0; e < nEv; e++) {
      const L = evL[e];
      const tEnd = L - Math.floor(L);
      if (tEnd === 0) continue;
      const q = evQ[e], jj = evJ[e], d = evD[e];
      const j = jj < n2 ? jj : n2 - 1;
      let p = param0 + dp * (j + 1);
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      pathPoint(shape, trav !== 0 ? this.travelMap(shape, order, tEnd, p, trav) : tEnd, order, p, pt);
      const hEnd = this.heightAt(P, v, n2, j, q, paced);
      pathPoint(shape, 0, order, p, pt);
      const D = this.heightAt(P, v, n2, j, q, paced) - hEnd;
      if (D === 0) continue;
      const gl = v.ugL[q] + (v.gRamp ? v.dugL[q] * (j + 1) : 0), gr = v.ugR[q] + (v.gRamp ? v.dugR[q] * (j + 1) : 0);
      const pre = 0.5 * D * d * d, post = -0.5 * D * (1 - d) * (1 - d);
      if (jj < n2) {
        SL[jj] += post * gl; if (stereo) SR[jj] += post * gr;
        if (jj > 0) { SL[jj - 1] += pre * gl; if (stereo) SR[jj - 1] += pre * gr; }
      } else {
        SL[n2 - 1] += pre * gl; if (stereo) SR[n2 - 1] += pre * gr;
        v.blepPend[q] = post;
      }
    }
  }

  // ---- Pristine ------------------------------------------------------------

  /**
   * Per control block: decide between band-limited tables and direct
   * rendering (direct while the orbit moves fast: a 5 ms snapshot crossfade
   * would smear it), and refresh the table every ~256 samples (at least once
   * per cycle for low notes) with a crossfade into the new one.
   */
  pristineControl(P, v, snap, f) {
    const o = v.orb;
    // where the orbit is, in roughly knob-travel units
    const rot = v.sRot / 360 + P.spinPhase;
    const vals = this.sav;
    vals[0] = v.sSize * 2; vals[1] = v.sStretch * 0.5; vals[2] = rot; vals[3] = v.sCx * 4; vals[4] = v.sCy * 4;
    vals[5] = v.sMorph; vals[6] = v.sWarp; vals[7] = Math.log2(v.sLift) * 0.25; vals[8] = v.sFold; vals[9] = v.sParam;
    vals[10] = (v.sLaps - 1) / 7; vals[11] = v.sPace * 0.5;
    let motion = 0;
    if (!snap) {
      for (let i = 0; i < 12; i++) {
        let d = vals[i] - o[i];
        if (i >= 2 && i <= 4) { const r = i === 2 ? 1 : 4; d = wrapHalf(d / r) * r; }
        if (d < 0) d = -d;
        if (d > motion) motion = d;
      }
      motion *= this.sr / CTRL;      // per second
    }
    for (let i = 0; i < 12; i++) o[i] = vals[i];
    v.drift += motion * CTRL / this.sr;     // orbit travel since the last table, knob units
    const fs2 = this.fs2;
    if (snap) v.calm = P.orbitVoiceMod ? 0 : 1e9;
    else if (motion > 8) v.calm = 0;
    else if (motion < 4) v.calm += CTRL;
    const want = v.calm >= 0.064 * this.sr && v.exTarget[EX.phaseMod] === 0 && v.ms === 0 && v.dms === 0 && (P.warpMode === 0 || v.exTarget[EX.warpAmount] === 0);
    const cyc = this.sr / f;
    const R = CTRL * Math.ceil(Math.min(1024, Math.max(256, cyc)) / CTRL);
    if (want && !v.tabValid && this.tabBudget <= 0) {
      // over this block's build budget: play direct for now, build next block
      v.tabCount = 0;
      return this.pristineFade(v, false);
    }
    if (want) {
      v.tabCount -= CTRL;
      if (!v.tabValid) {
        this.tableKey(P, v, f, v.tabKey);
        v.drift = 0; v.tabAge = 0;
        this.buildTable(P, v, v.tabB);
        v.tabNA = v.tabNB = this.tabLen;
        v.tabA.set(v.tabB.subarray(0, this.tabLen + 3));
        v.tabX = 1; v.dTabX = 0; v.tabValid = true;
        // stagger the refreshes of voices started together
        v.tabCount = R - CTRL * ((v.index * 3) % (R / CTRL));
        if (snap) { v.tw = 1; v.dtw = 0; }
      } else if (v.tabCount <= 0 && this.tabBudget > 0) {
        v.tabCount = R;
        v.tabAge += R;
        // A held, unmodulated orbit keeps its table; one that drifts slowly
        // gets a new one once it has moved a little (or every 4 refreshes):
        // the crossfade between snapshots carries a slow change faithfully.
        if (v.tabX >= 1) {
          const same = this.sameTableKey(P, v, f);
          if (same === 0 || (same === 1 && v.drift < TABLE_DRIFT && v.tabAge < 4 * R)) return this.pristineFade(v, want);
        }
        const t = v.tabA; v.tabA = v.tabB; v.tabB = t; v.tabNA = v.tabNB;
        this.tableKey(P, v, f, v.tabKey);
        this.buildTable(P, v, v.tabB);
        v.tabNB = this.tabLen;
        v.tabX = 0; v.dTabX = 1 / (R * this.os);
        v.drift = 0; v.tabAge = 0;
      }
    }
    this.pristineFade(v, want);
  }

  /** Steer the table weight towards 1 (table) or 0 (direct rendering). */
  pristineFade(v, want) {
    const fs2 = this.fs2;
    if (want) {
      v.dtw = v.tw < 1 ? 1 / (TABLE_FADE * fs2) : 0;
    } else {
      v.dtw = v.tw > 0 ? -1 / (TABLE_FADE * fs2) : 0;
      if (v.tw <= 0) v.tabValid = false;
    }
  }

  /**
   * The inputs of a table build (orbit, travel, band limit, terrain), stored
   * in v.tabKey by buildTable; true when they are unchanged, so the table in
   * hand is still exact.
   */
  tableKey(P, v, f, out) {
    const o = v.orb;
    for (let i = 0; i < 12; i++) out[i] = o[i];
    out[12] = v.paceShape; out[13] = v.trav; out[14] = v.pShape * 16 + v.pOrder;
    out[15] = Math.floor(0.5 * this.sr / (f * P.detRatio[v.uRun - 1] + 1e-9));
    out[16] = P.terrGen; out[17] = (P.oldA !== null ? P.fadeACur : 0) + (P.oldB !== null ? P.fadeBCur : 0);
    out[18] = v.uRun; out[19] = this.mipBias;
    out[20]=v.exTarget[EX.pathWindow]; out[21]=v.exTarget[EX.pathMangle]; out[22]=v.pathMirror;
  }

  /** 0: the table in hand is exact; 1: only the orbit has drifted; 2: something else changed. */
  sameTableKey(P, v, f) {
    const k = this.keyScratch;
    this.tableKey(P, v, f, k);
    const old = v.tabKey;
    let res = 0;
    for (let i = 0; i < 23; i++) {
      const d = k[i] - old[i];
      if (d > 1e-9 || d < -1e-9) { if (i >= 12) return 2; res = 1; }
    }
    return res;
  }

  /**
   * Sample one cycle of the voice's current (end-of-block) orbit through the
   * terrain, brick-wall it at the host Nyquist for the fastest unison
   * oscillator and write it to dst with Catmull-Rom guard points
   * (dst[i + 1] = sample i; dst[0] = last; two wrapped samples at the end).
   * this.tabLen = table length.
   */
  buildTable(P, v, dst) {
    const U = v.uRun;
    let inc = 0;
    for (let q = 0; q < U; q++) if (v.inc[q] > inc) inc = v.inc[q];
    const fmax = inc * this.fs2 + 1e-9;
    let H = Math.floor(0.5 * this.sr / fmax);
    if (H < 1) H = 1; else if (H > 1023) H = 1023;
    let K = 16;
    while (K < H + 1) K <<= 1;
    const M = Math.min(TAB_MAX, 4 * K);
    const T = this.tT, X = this.tX, Y = this.tY, LV = this.tLv;
    for (let i = 0; i < M; i++) T[i] = i / M;
    const pace = v.sPace, laps = v.sLaps, trav = v.trav, param = v.sParam;
    const paced = pace !== 0;
    if (paced) {
      paceBlock(v.paceShape, M, T, pace, 0, T);
      let prev = T[M - 1] - 1;
      for (let i = 0; i < M; i++) {
        let d = T[i] - prev;
        if (d < 0) d += 1;
        prev = T[i];
        LV[i] = speedLog2(d * M);
      }
    }
    if (laps !== 1) for (let i = 0; i < M; i++) { const t = laps * T[i]; T[i] = t - Math.floor(t); }
    if (trav !== 0) travelBlock(v.pShape, v.pOrder, M, T, param, 0, trav & 1, trav & 2);
    pathBlockAt(v.pShape, v.pOrder, M, T, param, 0, X, Y);
    if (v.exTarget[EX.pathWindow] || v.exTarget[EX.pathMangle] || v.pathMirror) {
      const point=this.pt;
      for (let i=0;i<M;i++) { shapePathPoint(X[i],Y[i],T[i],v.exTarget[EX.pathWindow],v.exTarget[EX.pathMangle],v.pathMirror,point); X[i]=point.x; Y[i]=point.y; }
    }

    // mip: M points per cycle, content kept to M/4 harmonics (bias 1, as the oscillator)
    const cyc = v.eSpeed;      // terrain units per cycle
    const tA = v.eA, tB = v.eB, tC = v.eC, tD = v.eD, cx = v.sCx, cy = v.sCy;
    const warp = v.sWarp, morph = v.sMorph, lift = v.sLift, fold = v.sFold;
    const chA = P.terrA, chB = P.terrB, topA = chA.length - 1, topB = chB.length - 1;
    const baseA = Math.log2(chA[0].size * cyc / M) + this.mipBias, baseB = Math.log2(chB[0].size * cyc / M) + this.mipBias;
    const needA = morph < 0.9999, needB = morph > 1e-4;
    const fA = P.oldA !== null ? P.fadeACur : 0, fB = P.oldB !== null ? P.fadeBCur : 0;
    const shapeOn = !(lift === 1 && fold <= 0);
    const S = this.fre;
    if (!paced && fA === 0 && fB === 0) {
      // one mip level pair for the whole cycle: tables hoisted, lookups inline
      const lva = baseA < 0 ? 0 : baseA > topA ? topA : baseA, la = lva | 0, wa = la < topA ? mipZone(lva - la) : 0;
      const lvb = baseB < 0 ? 0 : baseB > topB ? topB : baseB, lb = lvb | 0, wb = lb < topB ? mipZone(lvb - lb) : 0;
      const A0 = chA[la], A1 = chA[la < topA ? la + 1 : la], B0 = chB[lb], B1 = chB[lb < topB ? lb + 1 : lb];
      const a0 = A0.data, sa0 = A0.size, a1 = A1.data, sa1 = A1.size, b0 = B0.data, sb0 = B0.size, b1 = B1.data, sb1 = B1.size;
      for (let i = 0; i < M; i++) {
        const px = X[i], py = Y[i];
        let u = cx + px * tA - py * tB;
        let w = cy + px * tC + py * tD;
        if (warp > 0) {
          const ww = warp * 0.06;
          const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
          w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
          u = u2;
        }
        let h = 0;
        if (needA) {
          h = bil(a0, sa0, sa0 - 1, u, w);
          if (wa > 0) h += wa * (bil(a1, sa1, sa1 - 1, u, w) - h);
        }
        if (needB) {
          let hb = bil(b0, sb0, sb0 - 1, u, w);
          if (wb > 0) hb += wb * (bil(b1, sb1, sb1 - 1, u, w) - hb);
          h = needA ? h + morph * (hb - h) : hb;
        }
        if (shapeOn) {
          const y = h * lift;
          const ay = y < 0 ? -y : y;
          let sh = y;
          if (ay > 1) { const e = 2 * (ay - 1); const kk = 1 + 0.5 * e / (1 + e); sh = y < 0 ? -kk : kk; }
          if (fold > 0) sh += fold * (fastSin(y * (1 + 4 * fold) * 0.25) - sh);
          h = sh;
        }
        S[i] = h;
      }
    } else {
      for (let i = 0; i < M; i++) {
        const px = X[i], py = Y[i];
        let u = cx + px * tA - py * tB;
        let w = cy + px * tC + py * tD;
        if (warp > 0) {
          const ww = warp * 0.06;
          const u2 = u + ww * (fastSin(2 * w) + 0.5 * fastSin(3 * w + 2 * u));
          w += ww * (fastSin(2 * u) + 0.5 * fastSin(3 * u - 2 * w));
          u = u2;
        }
        const off = paced ? LV[i] : 0;
        let h = 0;
        if (needA) {
          let lv = baseA + off;
          lv = lv < 0 ? 0 : lv > topA ? topA : lv;
          const l = lv | 0;
          h = chainHeight(chA, l, l < topA ? mipZone(lv - l) : 0, fA > 0 ? P.oldA : null, fA, u, w);
        }
        if (needB) {
          let lv = baseB + off;
          lv = lv < 0 ? 0 : lv > topB ? topB : lv;
          const l = lv | 0;
          const hb = chainHeight(chB, l, l < topB ? mipZone(lv - l) : 0, fB > 0 ? P.oldB : null, fB, u, w);
          h = needA ? h + morph * (hb - h) : hb;
        }
        if (shapeOn) {
          const y = h * lift;
          const ay = y < 0 ? -y : y;
          let sh = y;
          if (ay > 1) { const e = 2 * (ay - 1); const kk = 1 + 0.5 * e / (1 + e); sh = y < 0 ? -kk : kk; }
          if (fold > 0) sh += fold * (fastSin(y * (1 + 4 * fold) * 0.25) - sh);
          h = sh;
        }
        S[i] = h;
      }
    }
    // brick wall: keep DC and harmonics 1..H (a real FFT of M points as M/2 complex)
    const re = this.fre, im = this.fim, zr = this.tX, zi = this.tY;
    this.fft.realForward(S, M, re, im, zr, zi);
    for (let k = H + 1; k <= M >> 1; k++) { re[k] = 0; im[k] = 0; }
    this.fft.realInverse(re, im, M, LV, zr, zi);
    const sc = 1 / M;
    for (let i = 0; i < M; i++) dst[i + 1] = LV[i] * sc;
    dst[0] = dst[M]; dst[M + 1] = dst[1]; dst[M + 2] = dst[2];
    this.tabLen = M;
    this.tabBudget -= M;
  }

  // ---- decimation and mixing ---------------------------------------------------

  /** 2x -> host: the 63-tap half-band from bus (2x, HB_HIST history) to o*. */
  decimate2(bL, bR, oL, oR, pos, seg) {
    for (let n = pos; n < pos + seg; n++) {
      const c = HB_HIST + 2 * n + 1 - HB_M;
      let sL = HB_CENTER * bL[c], sR = HB_CENTER * bR[c];
      for (let i = 0; i < HB_PAIRS; i++) {
        const o = 2 * i + 1;
        const h = HB_C[i];
        sL += h * (bL[c - o] + bL[c + o]);
        sR += h * (bR[c - o] + bR[c + o]);
      }
      oL[n] = sL; oR[n] = sR;
    }
  }

  /** 4x -> 2x (High): the 27-tap half-band from bus (4x, HB1_HIST history) into mid (2x, HB_HIST history). */
  decimate4(bL, bR, mL, mR, pos, seg) {
    for (let m = 2 * pos; m < 2 * (pos + seg); m++) {
      const c = HB1_HIST + 2 * m + 1 - HB1_M;
      let sL = HB1_CENTER * bL[c], sR = HB1_CENTER * bR[c];
      for (let i = 0; i < HB1_PAIRS; i++) {
        const o = 2 * i + 1;
        const h = HB1_C[i];
        sL += h * (bL[c - o] + bL[c + o]);
        sR += h * (bR[c - o] + bR[c + o]);
      }
      mL[HB_HIST + m] = sL; mR[HB_HIST + m] = sR;
    }
  }

  /** The part's (or ghost's) bus down to the host rate for one segment. */
  decimateTo(os, busL, busR, midL, midR, oL, oR, pos, seg) {
    if (os === 2) this.decimate2(busL, busR, oL, oR, pos, seg);
    else if (os === 4) {
      this.decimate4(busL, busR, midL, midR, pos, seg);
      this.decimate2(midL, midR, oL, oR, pos, seg);
    } else {
      // Eco: no filter, a plain delay that matches the half-band's latency
      for (let n = pos; n < pos + seg; n++) { oL[n] = busL[HB_HIST + n - ECO_DELAY]; oR[n] = busR[HB_HIST + n - ECO_DELAY]; }
    }
  }

  renderSegment(pos, seg, outL, outR, dlyL, dlyR, revL, revR, pedL, pedR) {
    const count = this.count, parts = this.parts, liveN = this.liveN;
    const capture = this.capture;
    // song position at this segment's first sample, for tempo-synced track effects
    const T = this.transport, fxBeat = T.playing ? T.beat + (this.blockTime + this.sinceCtrl / this.sr - T.beatTime) * this.tempo / 60 : NaN;
    for (let i = 0; i < liveN; i++) {
      const P = parts[i];
      if (i >= count && this.dormant(P)) continue;
      const g = P.ghost;
      const ghostOn = g !== null && g.left > 0;
      const active = P.activeCount();
      const kitBusy = P.kitOn && P.kit !== null && P.kit.busy;
      const smpBusy = P.smp !== null && P.smp.active > 0;
      const fz = P.frozen;
      if (active === 0 && P.tail <= 0 && !ghostOn && !P.effects.active && !kitBusy && !smpBusy && fz === null && (P.resoMode === 0 || !P.reso.busy)) {
        P.gain += P.dGain * seg; P.dly += P.dDly * seg; P.rev += P.dRev * seg; P.ped += P.dPed * seg; P.vectorGain+=P.dVector*seg;
        P.sA += P.dSA * seg; P.sB += P.dSB * seg;
        continue;
      }
      // v2.8 a frozen part plays its loop instead of its voices (both while they crossfade)
      // v2.9 notes played live over a fully frozen part: its voices run (through
      // its rack) and the loop is added on top
      const over = fz !== null && P.fzX >= 1 && P.fzTarget >= 1 && (active > 0 || kitBusy || smpBusy || P.tail > 0);
      const live = fz === null || P.fzX < 1 || P.fzTarget < 1 || over;
      const oL = P.outL, oR = P.outR;
      if (live) {
        if (active > 0 || ghostOn || smpBusy) P.tail = HB_N + P.ddN + (P.space !== null ? P.space.tailN : 0);
        const rc = P.rc, os = rc.os;
        const n2 = os * seg, off2 = os * pos;
        for (const v of P.voices) {
          if (!v.active) continue;
          this.renderVoice(P, v, off2, n2, rc);
          if (v.stealFade > 0 && (v.stealGain <= 0 || v.envStage === IDLE)) {
            const pend = v.pending, note = v.pendNote, vel = v.pendVel;
            v.active = false;
            v.resetState();
            if (pend) this.startVoice(P, v, note, vel, P.params[PI.glide] > 0.0005 && P.lastPitch >= 0 ? P.lastPitch : -1);
          } else if (v.envStage === IDLE) {
            v.active = false;
            v.gate = false;
            v.resetState();
          }
        }
        this.decimateTo(os, P.busL, P.busR, P.midL, P.midR, oL, oR, pos, seg);
        if (kitBusy) P.kit.render(oL, oR, pos, seg);
        if (smpBusy) {
          const pp = P.partPlain, prm = P.params;
          const bend = P.bend !== 0 ? Math.pow(2, P.bend * prm[PI.bendRange] / 12) : 1;
          P.smp.render(oL, oR, pos, seg, pp[M_SMP_SPEED], pp[M_SMP_START], pp[M_SMP_END], pp[M_SMP_POS], bend);
        }
        if (ghostOn) {
          // the outgoing quality: frozen voices into their own buses, then a
          // raised-cosine crossfade (the new path's decimator has just started
          // from silence, so it comes in after a short hold)
          const grc = g.rc, gos = grc.os;
          for (const gv of g.voices) {
            if (!gv.active) continue;
            this.renderVoice(P, gv, gos * pos, gos * seg, grc);
            if (gv.envStage === IDLE || (gv.stealFade > 0 && gv.stealGain <= 0)) gv.active = false;
          }
          this.decimateTo(gos, g.busL, g.busR, g.midL, g.midR, g.outL, g.outR, pos, seg);
          const total = g.total, hold = Math.min(HB_N, total >> 2);
          let left = g.left;
          for (let n = pos; n < pos + seg; n++) {
            left--;
            const x = (total - left - hold) / (total - hold);
            const w = x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x);
            oL[n] = g.outL[n] + w * (oL[n] - g.outL[n]);
            oR[n] = g.outR[n] + w * (oR[n] - g.outR[n]);
          }
          g.left = left;
        }
      } else this.frozenFill(P, oL, oR, pos, seg);
      if (live && P.resoMode !== 0) this.resoBlock(P, oL, oR, pos, seg);
      if (P.oldA) { P.fadeACur += P.dFadeA * (P.rc.os * seg); if (P.fadeACur < 0) P.fadeACur = 0; }
      if (P.oldB) { P.fadeBCur += P.dFadeB * (P.rc.os * seg); if (P.fadeBCur < 0) P.fadeBCur = 0; }
      let rawPeak=0;
      for (let n=pos;n<pos+seg;n++) rawPeak=Math.max(rawPeak,Math.abs(oL[n]),Math.abs(oR[n]));
      P.rawPeak=Math.max(P.rawPeak,rawPeak);
      if (live && P.effects.active) {
        P.effects.setTransport(this.tempo, fxBeat);
        const src=P.sidechainIndex;
        let level=0;
        if (src >= 0) level=parts[src].previousRawPeak;
        else if (src === -2) { for (let j=0;j<count;j++) if (j !== i) level+=parts[j].previousRawPeak; }
        const wantMod = P.effects.wantsMod;
        const mod = wantMod ? P.fxMod : null;
        for (let n=pos;n<pos+seg;n++) {
          if (wantMod) {
            let micHeld = 0, micHave = false;
            const slots = P.effects.slots;
            for (let s = 0; s < 4; s++) {
              let ml = 0, mr = 0;
              if (slots[s].type === 31) {
                const idx = slots[s].modIndex;
                if (idx >= 0 && idx < parts.length && idx !== i) {
                  const Q = parts[idx];
                  if (n < Q.prevL.length) { ml = Q.prevL[n]; mr = Q.prevR[n]; }
                } else if (idx === -3) {
                  if (!micHave) { micHeld = this.readMic(); micHave = true; }
                  ml = micHeld; mr = micHeld;
                }
              }
              mod[s * 2] = ml; mod[s * 2 + 1] = mr;
            }
          }
          const side=src === -1 ? Math.max(Math.abs(oL[n]),Math.abs(oR[n])) : level;
          const fx=P.effects.processSample(oL[n],oR[n],side,mod); oL[n]=fx.L; oR[n]=fx.R;
        }
      }
      if (over) this.frozenAdd(P, oL, oR, pos, seg);
      else if (fz !== null && live) this.frozenBlend(P, oL, oR, pos, seg);
      if (capture >= 0) {
        // offline freeze: only the captured part's own output, before the fader and the sends
        if (i === capture) for (let n = pos; n < pos + seg; n++) { outL[n] += oL[n]; outR[n] += oR[n]; }
        if (live && active === 0 && !ghostOn) {
          P.tail -= seg;
          if (P.tail <= 0) { P.busL.fill(0); P.busR.fill(0); P.midL.fill(0); P.midR.fill(0); }
        }
        continue;
      }
      // 2.12 3D: the head model (or, in surround, the mono source for the
      // speakers) in place on the track's output, before the pedal send, the
      // fader and the sends, so they all hear the track where it is
      const S = P.space;
      const spaceOn = S !== null && (P.spaceMode !== 0 || S.w > 0);
      const surSrc = spaceOn && this.surLayout !== null && P.spaceMode !== 0;
      if (spaceOn) { if (surSrc) S.processMono(oL, oR, pos, seg); else S.process(oL, oR, pos, seg); }
      // pedal send (skipped while it is and stays silent, the usual case),
      // taken before the dry delay: the pedals get the part on time
      if (P.ped !== 0 || P.dPed !== 0) {
        let pd = P.ped;
        const dpd = P.dPed;
        if (pedL) for (let n = pos; n < pos + seg; n++) { pd += dpd; pedL[n] += oL[n] * pd; pedR[n] += oR[n] * pd; }
        else pd += dpd * seg;
        P.ped = pd;
      }
      if (P.ddN > 0) {
        // Send mode compensation: the dry sound and its delay/reverb sends
        // come out ddN samples late, in step with the pedal return.
        const bl = P.ddL, br = P.ddR, mask = bl.length - 1, N = P.ddN;
        let w = P.ddW;
        for (let n = pos; n < pos + seg; n++) {
          bl[w] = oL[n]; br[w] = oR[n];
          const r = (w - N) & mask;
          oL[n] = bl[r]; oR[n] = br[r];
          w = (w + 1) & mask;
        }
        P.ddW = w;
      }
      let gn = P.gain, dl = P.dly, rv = P.rev;
      const dgn = P.dGain, ddl = P.dDly, drv = P.dRev;
      const dm = this.dryOut;
      let vectorGain=P.vectorGain; const dv=P.dVector;
      const vg0 = vectorGain;
      if (this.surLayout === null) {
        for (let n = pos; n < pos + seg; n++) {
          gn += dgn; dl += ddl; rv += drv;
          vectorGain+=dv;
          const l = oL[n]*vectorGain, r = oR[n]*vectorGain;
          outL[n] += l * gn * dm; outR[n] += r * gn * dm;
          if (dlyL) { dlyL[n] += l * dl; dlyR[n] += r * dl; }
          if (revL) { revL[n] += l * rv; revR[n] += r * rv; }
        }
      } else {
        // 2.12 surround: 3D tracks to their speakers, the others to front
        // left and right (a little into the rear pair with Spread)
        const SO = this.surOut, Lay = this.surLayout;
        const sg = surSrc ? S.sg : null, dsg = surSrc ? S.dsg : null, nch = Lay.channels;
        const sp = this.surSpread, fs = Math.sqrt(1 - sp), rs = Math.sqrt(sp);
        const rL = SO && sp > 0 ? SO[Lay.rear[0]] : null, rR = SO && sp > 0 ? SO[Lay.rear[1]] : null;
        for (let n = pos; n < pos + seg; n++) {
          gn += dgn; dl += ddl; rv += drv;
          vectorGain+=dv;
          const l = oL[n]*vectorGain, r = oR[n]*vectorGain;
          if (sg !== null) {
            const m = l * gn * dm;
            for (let c = 0; c < nch; c++) sg[c] += dsg[c];
            outL[n] += m * sg[0]; outR[n] += m * sg[1];
            if (SO) for (let c = 2; c < nch; c++) if (sg[c] !== 0) SO[c][n] += m * sg[c];
          } else if (rL !== null) {
            outL[n] += l * gn * dm * fs; outR[n] += r * gn * dm * fs;
            rL[n] += l * gn * dm * rs; rR[n] += r * gn * dm * rs;
          } else { outL[n] += l * gn * dm; outR[n] += r * gn * dm; }
          if (dlyL) { dlyL[n] += l * dl; dlyR[n] += r * dl; }
          if (revL) { revL[n] += l * rv; revR[n] += r * rv; }
        }
        if (sg !== null) for (let c = 0; c < nch; c++) if (Math.abs(sg[c] - S.sgT[c]) < 1e-9) { sg[c] = S.sgT[c]; }
      }
      P.gain = gn; P.dly = dl; P.rev = rv; P.vectorGain=vectorGain;
      // v2.8 Send A / Send B (skipped while both are and stay at 0, the default)
      if (P.sA !== 0 || P.dSA !== 0 || P.sB !== 0 || P.dSB !== 0) this.feedSends(P, oL, oR, pos, seg, vg0, dv);
      if (live && active === 0 && !ghostOn) {
        P.tail -= seg;
        if (P.tail <= 0) { P.busL.fill(0); P.busR.fill(0); P.midL.fill(0); P.midR.fill(0); }
      }
    }
  }

  /** v2.8: add one part's post-fader Send A / Send B to the bus inputs. */
  feedSends(P, oL, oR, pos, seg, vectorGain, dv) {
    const B = this.sendBufs;
    const aL = B[0], aR = B[1], bL = B[2], bR = B[3];
    let a = P.sA, b = P.sB;
    const da = P.dSA, db = P.dSB;
    if (a !== 0 || da !== 0) this.sendFedA = true;
    if (b !== 0 || db !== 0) this.sendFedB = true;
    for (let n = pos; n < pos + seg; n++) {
      a += da; b += db;
      vectorGain += dv;
      const l = oL[n] * vectorGain, r = oR[n] * vectorGain;
      aL[n] += l * a; aR[n] += r * a;
      bL[n] += l * b; bR[n] += r * b;
    }
    P.sA = a; P.sB = b;
    this.sendDirty = true;
  }

  /**
   * v2.8: the frozen loop for one segment into dstL/dstR at [pos, pos+seg),
   * in step with the transport (beat 0 of the loop on a multiple of its
   * length in beats), faded in and out as the transport starts and stops.
   * The part's dry delay (pedal compensation) is read ahead, so after it the
   * loop is heard on the beat.
   */
  frozenFill(P, dstL, dstR, pos, seg) {
    const F = P.frozen, T = this.transport, sr = this.sr, len = F.len, FL = F.L, FR = F.R;
    const target = T.playing ? 1 : 0;
    let gate = P.fzGate;
    if (gate === 0 && target === 0) {
      for (let n = pos; n < pos + seg; n++) { dstL[n] = 0; dstR[n] = 0; }
      return;
    }
    const kg = this.kGate;
    // rounded like note events are (dsp.process), so a loop rendered from the
    // same events lines up with them to the sample
    let f = Math.round(T.beat * (len / F.beats) + (this.segTime + P.ddN / sr - T.beatTime) * sr);
    if (f >= 0) f -= Math.floor(f / len) * len;
    for (let n = pos; n < pos + seg; n++) {
      if (gate !== target) gate = target > gate ? (gate + kg >= 1 ? 1 : gate + kg) : (gate - kg <= 0 ? 0 : gate - kg);
      if (f >= 0) {
        const k = f | 0;
        dstL[n] = FL[k] * gate; dstR[n] = FR[k] * gate;
      } else { dstL[n] = 0; dstR[n] = 0; }
      f += 1;
      if (f >= len) f -= len;
    }
    P.fzGate = gate;
  }

  /** v2.9: add the frozen loop under notes played live on a frozen part. */
  frozenAdd(P, oL, oR, pos, seg) {
    const zL = this.fzL, zR = this.fzR;
    this.frozenFill(P, zL, zR, pos, seg);
    for (let n = pos; n < pos + seg; n++) { oL[n] += zL[n]; oR[n] += zR[n]; }
  }

  /** v2.8: crossfade the part's live output with its frozen loop (freezing or unfreezing). */
  frozenBlend(P, oL, oR, pos, seg) {
    const zL = this.fzL, zR = this.fzR;
    this.frozenFill(P, zL, zR, pos, seg);
    const tgt = P.fzTarget, step = this.kFreeze / CTRL;
    let x = P.fzX;
    for (let n = pos; n < pos + seg; n++) {
      if (x !== tgt) x = tgt > x ? (x + step >= 1 ? 1 : x + step) : (x - step <= 0 ? 0 : x - step);
      oL[n] += (zL[n] - oL[n]) * x;
      oR[n] += (zR[n] - oR[n]) * x;
    }
    P.fzX = x;
    if (x >= 1 && tgt >= 1) {
      // fully frozen: the voices, the kit and the rack stop here (the loop has them)
      for (const v of P.voices) { v.active = false; v.gate = false; v.pending = false; v.resetState(); }
      if (P.kit) for (const kv of P.kit.voices) kv.on = false;
      if (P.smp !== null) P.smp.allOff(true);
      if (P.ghost) P.ghost.left = 0;
      P.stackLen = 0;
      P.effects.reset();
      P.busL.fill(0); P.busR.fill(0); P.midL.fill(0); P.midR.fill(0);
      P.tail = 0;
    } else if (x <= 0 && tgt <= 0) P.frozen = null;
  }

  /**
   * Render `frames` samples. outL/outR: dry mix; dlyL/dlyR and revL/revR:
   * delay and reverb send buses (any of the send arrays may be null).
   * currentTime is the AudioContext time of the first sample. pedL/pedR
   * (optional, v1.1): the pedal send bus, silent unless the host sent
   * {t:'pedal', active: true}.
   */
  process(outL, outR, dlyL, dlyR, revL, revR, frames, currentTime, pedL = null, pedR = null, sur = null) {
    const sr = this.sr;
    const n = frames | 0;
    // 2.12 surround outputs (channels 2 and up; 0 and 1 are outL / outR)
    this.surOut = sur && this.surLayout !== null && sur.length >= this.surLayout.channels ? sur : null;
    if (sur) for (let c = 2; c < sur.length; c++) sur[c].fill(0, 0, n);
    const now = Number.isFinite(currentTime) ? currentTime : this.lastTime + n / sr;
    this.lastTime = now;
    if (this.pendingQuality !== null && !this.parts.some(P => P.ghost !== null && P.ghost.left > 0)) this.setQuality(this.pendingQuality);
    outL.fill(0, 0, n); outR.fill(0, 0, n);
    if (dlyL) { dlyL.fill(0, 0, n); dlyR.fill(0, 0, n); }
    if (revL) { revL.fill(0, 0, n); revR.fill(0, 0, n); }
    if (pedL) { pedL.fill(0, 0, n); pedR.fill(0, 0, n); }
    // v2.8 send bus inputs: sized for this call, cleared only after use
    if (this.sendBufs === null || this.sendBufs[0].length < n) {
      this.sendBufs = [0, 1, 2, 3].map(() => new Float64Array(Math.max(256, n)));
      this.fzL = new Float64Array(Math.max(256, n)); this.fzR = new Float64Array(Math.max(256, n));
      this.sendDirty = false;
    } else if (this.sendDirty) {
      for (const b of this.sendBufs) b.fill(0);
      this.sendDirty = false;
    }
    this.sendFedA = false; this.sendFedB = false;
    // Parts past the last one that can sound are never touched in this call
    // (a part past the count cannot start a note, so it cannot wake up).
    let liveN = this.count;
    for (let i = MAX_PARTS - 1; i >= this.count; i--) if (!this.dormant(this.parts[i])) { liveN = i + 1; break; }
    this.liveN = liveN;
    for (let i = 0; i < liveN; i++) {
      const P = this.parts[i];
      if (i >= this.count && this.dormant(P)) continue;
      P.previousRawPeak=P.rawPeak; P.rawPeak=0;
      const pn = Math.min(n, P.outL.length);
      if (P.prevL.length < pn) { P.prevL = new Float64Array(P.outL.length); P.prevR = new Float64Array(P.outR.length); }
      P.prevL.set(P.outL.subarray(0, pn));
      P.prevR.set(P.outR.subarray(0, pn));
      P.ensureBus(n);
      P.busL.fill(0, P.hist, P.hist + P.os * n);
      P.busR.fill(0, P.hist, P.hist + P.os * n);
      const g = P.ghost;
      if (g !== null && g.left > 0) {
        const gh = g.rc.hist, gos = g.rc.os;
        g.busL.fill(0, gh, gh + gos * n);
        g.busR.fill(0, gh, gh + gos * n);
      }
    }

    let pos = 0;
    while (pos < n) {
      const E = this.events;
      while (E.length) {
        const ev = E[0];
        const off = Math.round((ev.time - now) * sr);
        if (off > pos) break;
        E.shift();
        const P = this.parts[ev.part];
        if (!P || ev.part >= this.count) continue;
        if (ev.type === 2) this.applyParams(P, ev.p, ev.ramp, ev.time, true);
        else if (ev.type === 1) this.noteOn(P, ev.note, ev.vel, ev.tag, ev.slice);
        else this.noteOff(P, ev.note);
      }
      if (this.ctrlRemain <= 0) {
        this.blockTime = now + pos / sr;
        this.controlUpdate(this.sinceCtrl);
        this.sinceCtrl = 0;
        this.ctrlRemain = CTRL;
      }
      let seg = n - pos;
      if (seg > this.ctrlRemain) seg = this.ctrlRemain;
      if (E.length) {
        const off = Math.round((E[0].time - now) * sr);
        if (off > pos && off - pos < seg) seg = off - pos;
      }
      this.segTime = now + pos / sr;
      this.renderSegment(pos, seg, outL, outR, dlyL, dlyR, revL, revR, pedL, pedR);
      pos += seg;
      this.ctrlRemain -= seg;
      this.sinceCtrl += seg;
    }
    this.nextTime = now + n / sr;
    // v2.8 the shared send buses (only while something is sent to them or still rings)
    if (this.sendFedA || this.sendFedB || (this.sendFx !== null && this.sendFx.active)) {
      if (this.sendFx === null) { this.sendFx = new SendReturns(sr); this.sendFx.configure(this.sendCfg); }
      const B = this.sendBufs;
      this.sendFx.process(B[0], B[1], B[2], B[3], outL, outR, n, this.sendFedA, this.sendFedB);
    }

    for (let i = 0; i < liveN; i++) {
      const P = this.parts[i];
      if (i >= this.count && this.dormant(P)) continue;
      const H = P.os * n;
      P.busL.copyWithin(0, H, H + P.hist);
      P.busR.copyWithin(0, H, H + P.hist);
      if (P.os === 4) {
        P.midL.copyWithin(0, 2 * n, 2 * n + HB_HIST);
        P.midR.copyWithin(0, 2 * n, 2 * n + HB_HIST);
      }
      const g = P.ghost;
      if (g !== null && g.left > 0) {
        const gos = g.rc.os, gh = g.rc.hist, GH = gos * n;
        g.busL.copyWithin(0, GH, GH + gh);
        g.busR.copyWithin(0, GH, GH + gh);
        if (gos === 4) { g.midL.copyWithin(0, 2 * n, 2 * n + HB_HIST); g.midR.copyWithin(0, 2 * n, 2 * n + HB_HIST); }
      }
    }

    // v2.9 Operator panel on the mix (not while a frozen loop is captured)
    if (this.op !== null && this.capture < 0) {
      let voices = 0;
      if (this.op.cfg.slowdown === 1) for (let i = 0; i < liveN; i++) voices += this.parts[i].activeCount();
      this.op.process(outL, outR, n, voices, dlyL, dlyR, revL, revR, pedL, pedR);
    }

    // last line of defence before the host's limiter: no NaN, never beyond ±4
    let pl = this.peakL, pr = this.peakR;
    for (let i = 0; i < n; i++) {
      let l = outL[i], r = outR[i];
      if (!(l <= OUT_LIMIT && l >= -OUT_LIMIT)) { l = l > OUT_LIMIT ? OUT_LIMIT : l < -OUT_LIMIT ? -OUT_LIMIT : 0; outL[i] = l; }
      if (!(r <= OUT_LIMIT && r >= -OUT_LIMIT)) { r = r > OUT_LIMIT ? OUT_LIMIT : r < -OUT_LIMIT ? -OUT_LIMIT : 0; outR[i] = r; }
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    if (dlyL) this.sanitize(dlyL, dlyR, n);
    if (revL) this.sanitize(revL, revR, n);
    if (pedL) this.sanitize(pedL, pedR, n);
    this.peakL = pl; this.peakR = pr;

    if (this.watch >= 0) this.teleCount += n;
    if (this.teleCount >= this.teleInterval) {
      this.teleCount %= this.teleInterval;
      this.sendTelemetry();
    }
  }

  sanitize(a, b, n) {
    for (let i = 0; i < n; i++) {
      const x = a[i], y = b[i];
      if (!(x <= OUT_LIMIT && x >= -OUT_LIMIT)) a[i] = x > OUT_LIMIT ? OUT_LIMIT : x < -OUT_LIMIT ? -OUT_LIMIT : 0;
      if (!(y <= OUT_LIMIT && y >= -OUT_LIMIT)) b[i] = y > OUT_LIMIT ? OUT_LIMIT : y < -OUT_LIMIT ? -OUT_LIMIT : 0;
    }
  }

  // ---- telemetry --------------------------------------------------------------

  sendTelemetry() {
    const P = this.parts[this.watch];
    if (!P) return; // watch = -1: telemetry off
    let best = null;
    for (const v of P.voices) if (v.active && (!best || v.order > best.order)) best = v;
    const src = best ? best.modNorm : P.partNorm;
    const nobj = {};
    for (let m = 0; m < NMOD; m++) nobj[MOD_PARAM_IDS[m]] = src[m];
    const voices = [];
    for (const v of P.voices) {
      if (!v.active) continue;
      voices.push({ id: v.index, note: v.pending ? v.pendNote : v.note, amp: v.envLvl * v.velGain * v.stealGain });
    }
    // one entry per track in use
    const activeVoices = this.parts.slice(0, this.count).map(p => p.activeCount());
    // height under the modulated dot: the newest voice's smoothed dot, else the part's
    const PP = P.partPlain;
    const terrainHeight = best
      ? this.terrainHeightAt(P, best.sCx, best.sCy, best.sMorph, best.sWarp)
      : this.terrainHeightAt(P, PP[M_CX], PP[M_CY], PP[M_MORPH], PP[M_WARP]);
    const msg = {
      t: 'tele', part: this.watch, n: nobj, spinPhase: P.spinPhase, voices, peak: [this.peakL, this.peakR], activeVoices, count: this.count,
      terrainHeight, quality: this.quality,
    };
    if (this.op !== null) msg.op = this.op.telemetry();
    this.peakL = 0; this.peakR = 0;
    this.postMessage(msg);
  }
}
