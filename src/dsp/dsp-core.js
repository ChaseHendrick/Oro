// Orograph's audio engine: 4 parts x 8 voices of wave terrain synthesis.
//
// Pure computation, no Web Audio dependency: the same class runs inside the
// AudioWorklet (worklet.js), inside a ScriptProcessorNode fallback, and in
// Node tests. process() never allocates (telemetry objects excepted, ~60/s).
//
// Signal flow per voice (at 2x the host rate):
//   unison phases -> path (pathBlock) -> transform (size, stretch, rotate +
//   spin, centre) -> warp -> trilinear terrain lookup (mip level from traversal
//   speed), A/B morph -> Lift/Fold shaper -> DC blocker -> drive -> TPT state
//   variable filter -> amp envelope -> pan
// Voices of a part are summed at 2x, then a 63-tap half-band FIR decimates the
// part to the host rate before level, mute/solo and send gains.
//
// Control rate: every CTRL samples each part advances its LFOs, each voice its
// Envelope 2 / glide, re-evaluates modulation in normalised space, smooths the
// targets with a one-pole and sets per-sample linear ramps for everything that
// could zipper. Events (notes) split the block at their exact sample.

import {
  PART_PARAMS, PART_PARAM_INDEX, PART_PARAM_MAP, MOD_PARAM_IDS, MOD_DEFAULT,
  NUM_PARTS, VOICES_PER_PART, SYNC_DIVS, toNorm, fromNorm,
} from '../core/params.js';
import { pathBlock, pathPoint, pathLength } from './paths.js';
import { fastSin, fastCos, mulberry32 } from './terrain-math.js';
import { generateTerrain, buildMipChain } from './terrains.js';

export const OVERSAMPLE = 2;
export const CTRL = 32;                 // control block, host-rate samples
const MAX_UNISON = 4;
const VOICE_GAIN = 0.5;                 // headroom: a full-scale voice sits at -6 dBFS
const SMOOTH_TIME = 0.004;              // one-pole smoothing of control targets (s)
const TERRAIN_FADE_TIME = 0.03;         // crossfade when a new terrain table arrives (s)
const STEAL_FADE_TIME = 0.003;          // fade-out of a stolen voice (s)
const ATTACK_OVERSHOOT = 1.2;           // analog-style attack aims past 1 and stops at 1
const ENV_FLOOR = 0.001;                // -60 dB: where decay/release times are measured
const OUT_LIMIT = 4;

const IDLE = 0, ATTACK = 1, DECAY = 2, RELEASE = 3;

const NMOD = MOD_PARAM_IDS.length;
const MOD_DEFS = MOD_PARAM_IDS.map(id => PART_PARAM_MAP[id]);
const MOD_SLOT = Object.fromEntries(MOD_PARAM_IDS.map((id, i) => [id, i]));
const MOD_WRAPS = new Uint8Array(MOD_PARAM_IDS.map(id => (id === 'rotate' || id === 'centerX' || id === 'centerY') ? 1 : 0));
const M_MORPH = MOD_SLOT.morph, M_WARP = MOD_SLOT.warp, M_LIFT = MOD_SLOT.lift, M_FOLD = MOD_SLOT.fold;
const M_PARAM = MOD_SLOT.pathParam, M_SIZE = MOD_SLOT.size, M_STRETCH = MOD_SLOT.stretch;
const M_ROTATE = MOD_SLOT.rotate, M_CX = MOD_SLOT.centerX, M_CY = MOD_SLOT.centerY, M_FINE = MOD_SLOT.fine;
const M_CUTOFF = MOD_SLOT.cutoff, M_RES = MOD_SLOT.resonance, M_DRIVE = MOD_SLOT.drive, M_PAN = MOD_SLOT.pan;

const PI = PART_PARAM_INDEX;
const NPARAMS = PART_PARAMS.length;

// --- half-band decimator ---------------------------------------------------
// 63-tap Kaiser (β = 7.4) windowed sinc at a quarter of the oversampled rate.
// Only odd offsets from the centre are non-zero, so 16 symmetric coefficients
// plus the centre do the work. Passband is flat to 0.2 fs2 (19.2 kHz at 48 kHz)
// and the stopband from 0.29 fs2 is below -70 dB, so nothing that would fold
// to below ~20 kHz survives the 2:1 decimation.
const HB_N = 63;
const HB_M = (HB_N - 1) >> 1;
const HB_HIST = HB_N - 1;
export const HALFBAND = (() => {
  const beta = 7.4;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; };
  const h = new Float64Array(HB_N);
  let sum = 0;
  for (let n = 0; n < HB_N; n++) {
    const k = n - HB_M;
    const sinc = k === 0 ? 0.5 : Math.sin(Math.PI * k / 2) / (Math.PI * k);
    const r = k / HB_M;
    h[n] = (k !== 0 && (k & 1) === 0) ? 0 : sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
    sum += h[n];
  }
  for (let n = 0; n < HB_N; n++) h[n] /= sum;
  return h;
})();
const HB_PAIRS = (HB_M + 1) >> 1;
const HB_C = new Float64Array(HB_PAIRS);   // coefficient for offsets ±1, ±3, ...
for (let i = 0; i < HB_PAIRS; i++) HB_C[i] = HALFBAND[HB_M + 2 * i + 1];
const HB_CENTER = HALFBAND[HB_M];

// --- default terrain -------------------------------------------------------
// A built-in Swell so a part is never silent while its terrain message is in
// flight. Generated once per realm at 256 (a few ms), shared by every part.
let DEFAULT_CHAIN = null;
function defaultChain() {
  if (!DEFAULT_CHAIN) DEFAULT_CHAIN = buildMipChain(generateTerrain(0, { size: 256, seed: 7, detail: 0.5 }), 256, MIN_MIP);
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
function wrapHalf(d) { return d - Math.floor(d + 0.5); }

// --- voice -----------------------------------------------------------------

class Voice {
  constructor(index) {
    this.index = index;
    this.active = false;
    this.gate = false;
    this.note = 60;
    this.vel = 0.8;
    this.velGain = 1;
    this.order = 0;            // start counter, for stealing and telemetry
    this.pitch = 60;           // current (gliding) note, without fine/bend
    this.uniPrev = 0;

    this.phase = new Float64Array(MAX_UNISON);
    this.inc = new Float64Array(MAX_UNISON);
    this.dinc = new Float64Array(MAX_UNISON);

    this.envStage = IDLE; this.envLvl = 0;
    this.env2Stage = IDLE; this.env2Lvl = 0;

    // pending note when this voice is being stolen
    this.stealFade = 0; this.stealStep = 0; this.stealGain = 1;
    this.pending = false; this.pendNote = 60; this.pendVel = 0;

    // modulated values (normalised + plain)
    this.modNorm = new Float64Array(NMOD);
    this.modPlain = new Float64Array(NMOD);

    // one-pole smoothed control state
    this.sSize = 0.2; this.sStretch = 0; this.sRot = 0; this.sCx = 0.5; this.sCy = 0.5;
    this.sMorph = 0; this.sWarp = 0; this.sLift = 1; this.sFold = 0; this.sParam = 0.5;
    this.sCut = 13; this.sRes = 0.1; this.sDrive = 0; this.sPan = 0;
    this.sLvA = 0; this.sLvB = 0;

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

    // filter + DC blocker state
    this.ic1L = 0; this.ic2L = 0; this.ic1R = 0; this.ic2R = 0;
    this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;
    this.dcInit = false; this.dcMeanL = 0; this.dcMeanR = 0;
  }

  resetState() {
    this.ic1L = this.ic2L = this.ic1R = this.ic2R = 0;
    this.dcxL = this.dcyL = this.dcxR = this.dcyR = 0;
    this.envLvl = 0; this.env2Lvl = 0;
    this.envStage = IDLE; this.env2Stage = IDLE;
    this.stealFade = 0; this.stealGain = 1; this.pending = false;
  }
}

// --- part ------------------------------------------------------------------

class Part {
  constructor(index, sr) {
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

    this.lfoPhase = new Float64Array(NMOD);
    this.lfoOffset = new Float64Array(NMOD);   // phase offset for transport-anchored, retriggered LFOs
    this.lfoVal = new Float64Array(NMOD);
    this.lfoR0 = new Float64Array(NMOD);
    this.lfoR1 = new Float64Array(NMOD);
    this.rng = mulberry32(0x0b0e + index * 977);
    for (let m = 0; m < NMOD; m++) { this.lfoR0[m] = this.rng() * 2 - 1; this.lfoR1[m] = this.rng() * 2 - 1; }

    this.partNorm = new Float64Array(NMOD);
    this.partPlain = new Float64Array(NMOD);

    this.voices = [];
    for (let i = 0; i < VOICES_PER_PART; i++) this.voices.push(new Voice(i));

    this.terrA = defaultChain();
    this.terrB = defaultChain();
    this.oldA = null; this.fadeA = 0;   // terrain crossfade (1 -> 0)
    this.oldB = null; this.fadeB = 0;
    this.fadeACur = 0; this.dFadeA = 0; this.fadeBCur = 0; this.dFadeB = 0;

    this.bend = 0;
    this.wheel = 0;
    this.spinPhase = 0;
    this.stack = new Float64Array(32);  // held notes in mono/legato, last = newest
    this.stackLen = 0;
    this.lastPitch = -1;                // last note played, where glides start from

    // unison layout
    this.uni = 1;
    this.detRatio = new Float64Array(MAX_UNISON).fill(1);
    this.gUL = new Float64Array(MAX_UNISON).fill(1);
    this.gUR = new Float64Array(MAX_UNISON).fill(1);

    // envelope coefficients (per oversampled sample for Env 1, per control block for Env 2)
    this.attC = 0; this.decC = 0; this.relC = 0; this.sus = 0.75;
    this.att2C = 0; this.dec2C = 0; this.rel2C = 0; this.sus2 = 0.25;

    // mixer
    this.gain = 0; this.dGain = 0; this.dly = 0; this.dDly = 0; this.rev = 0; this.dRev = 0;
    this.tail = 0;

    // oversampled part bus with decimator history in front
    this.busL = new Float64Array(HB_HIST + 2 * 256);
    this.busR = new Float64Array(HB_HIST + 2 * 256);
    this.outL = new Float64Array(256);
    this.outR = new Float64Array(256);

    this.sr = sr;
    this.shapeI = 0; this.orderI = 1; this.ftype = 1; this.mode = 0;
    this.gainS = 0; this.dlyS = 0; this.revS = 0;
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
    this.shapeI = Math.max(0, Math.min(11, Math.round(P[PI.pathShape]) || 0));
    this.orderI = Math.max(1, Math.min(8, Math.round(P[PI.pathOrder]) || 1));
    this.ftype = Math.max(0, Math.min(4, Math.round(P[PI.filterType]) || 0));
    this.mode = Math.max(0, Math.min(2, Math.round(P[PI.polyMode]) || 0));
    // unison
    const U = Math.max(1, Math.min(MAX_UNISON, Math.round(P[PI.unison])));
    const det = P[PI.detune];
    const spread = clamp01(P[PI.spread]);
    this.uni = U;
    for (let k = 0; k < MAX_UNISON; k++) {
      const pos = U === 1 ? 0 : (k / (U - 1)) * 2 - 1;
      this.detRatio[k] = Math.pow(2, (pos * det * 0.5) / 1200);
      if (U === 1) { this.gUL[k] = 1; this.gUR[k] = 1; continue; }
      const ang = (pos * spread + 1) * Math.PI / 4;
      const norm = Math.SQRT2 / Math.sqrt(U);
      this.gUL[k] = Math.cos(ang) * norm;
      this.gUR[k] = Math.sin(ang) * norm;
    }
    // Env 1 at the oversampled rate
    const fs2 = sr * OVERSAMPLE;
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
  }

  ensureBus(frames) {
    if (this.outL.length >= frames) return;
    const n = 1 << Math.ceil(Math.log2(frames));
    const keepL = this.busL.subarray(0, HB_HIST), keepR = this.busR.subarray(0, HB_HIST);
    const bl = new Float64Array(HB_HIST + 2 * n), br = new Float64Array(HB_HIST + 2 * n);
    bl.set(keepL); br.set(keepR);
    this.busL = bl; this.busR = br;
    this.outL = new Float64Array(n); this.outR = new Float64Array(n);
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

function finiteOr(v, d) { const n = +v; return Number.isFinite(n) ? n : d; }
function sameNote(a, b) { return Math.abs(a - b) < 1e-6; }
function mipZone(f) { const w = (f - 0.5) * 2; return w < 0 ? 0 : w > 1 ? 1 : w; }

function softLimit(x) {
  // identity inside ±2, then a knee that never exceeds ±3
  if (x > 2) { const e = x - 2; return 2 + e / (1 + e); }
  if (x < -2) { const e = -x - 2; return -2 - e / (1 + e); }
  return x;
}

// ---------------------------------------------------------------------------

export class OrographDSP {
  constructor(sampleRate) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
    this.fs2 = this.sr * OVERSAMPLE;
    /** Telemetry hook; the worklet points this at port.postMessage. */
    this.postMessage = () => {};
    this.parts = [];
    for (let i = 0; i < NUM_PARTS; i++) this.parts.push(new Part(i, this.sr));

    this.tempo = 112;
    this.transport = { playing: false, beatTime: 0, beat: 0 };
    this.watch = 0;
    this.voiceCounter = 0;

    this.events = [];           // scheduled note events, sorted by time
    this.lastTime = 0;          // currentTime of the latest process() call
    this.blockTime = 0;         // time of the current control block

    this.ctrlRemain = 0;
    this.kSmooth = 1 - Math.exp(-CTRL / (this.sr * SMOOTH_TIME));
    this.fadeStep = CTRL / (this.sr * TERRAIN_FADE_TIME);
    this.stealSamples = Math.max(8, Math.round(STEAL_FADE_TIME * this.fs2));
    this.dcR = 1 - 2 * Math.PI * 8 / this.fs2;
    /** Octaves added to the mip level choice (see mipLevel); -99 disables mip mapping (tests). */
    this.mipBias = 1;

    this.teleInterval = Math.max(64, Math.round(this.sr / 60));
    this.teleCount = 0;
    this.peakL = 0; this.peakR = 0;

    // scratch for renderVoice (a segment never spans more than one control block)
    const n2max = OVERSAMPLE * CTRL;
    this.xs = []; this.ys = [];
    for (let q = 0; q < MAX_UNISON; q++) { this.xs.push(new Float64Array(n2max)); this.ys.push(new Float64Array(n2max)); }
    this.sumL = new Float64Array(n2max);
    this.sumR = new Float64Array(n2max);
    this.pst = new Float64Array(5);
    this.pt = { x: 0, y: 0 };
    this.rng = mulberry32(0x6f726f67);
  }

  // ---- message protocol ---------------------------------------------------

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'params': this.setParams(msg.part, msg.p); break;
      case 'mods': this.setMods(msg.part, msg.m); break;
      case 'global': this.setGlobal(msg.p); break;
      case 'terrain': this.setTerrain(msg.part, msg.slot, msg.levels); break;
      case 'noteOn': this.schedule(1, msg); break;
      case 'noteOff': this.schedule(0, msg); break;
      case 'allOff': this.allOff(msg.part); break;
      case 'panic': this.panic(); break;
      case 'bend': { const P = this.partAt(msg.part); if (P) P.bend = Math.max(-1, Math.min(1, finiteOr(msg.v, 0))); break; }
      case 'wheel': { const P = this.partAt(msg.part); if (P) P.wheel = clamp01(finiteOr(msg.v, 0)); break; }
      case 'watch': { const i = Math.round(finiteOr(msg.part, 0)); if (i >= 0 && i < NUM_PARTS) this.watch = i; break; }
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
    return n >= 0 && n < NUM_PARTS ? this.parts[n] : null;
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
      P.params[idx] = val;
      const m = MOD_SLOT[id];
      if (m !== undefined) P.baseNorm[m] = toNorm(MOD_DEFS[m], val);
    }
    P.updateDerived();
    if (P.mode !== oldMode) this.releasePart(P);
  }

  setMods(part, mods) {
    const P = this.partAt(part);
    if (!P || !mods || typeof mods !== 'object') return;
    for (const id in mods) {
      const m = MOD_SLOT[id];
      const o = mods[id];
      if (m === undefined || !o || typeof o !== 'object') continue;
      if (o.lfoShape !== undefined) P.lfoShape[m] = Math.max(0, Math.min(5, Math.round(finiteOr(o.lfoShape, 0))));
      if (o.lfoRate !== undefined) P.lfoRate[m] = Math.max(0.01, Math.min(30, finiteOr(o.lfoRate, 0.5)));
      if (o.lfoSync !== undefined) P.lfoSync[m] = finiteOr(o.lfoSync, 0) ? 1 : 0;
      if (o.lfoDiv !== undefined) P.lfoDiv[m] = Math.max(0, Math.min(SYNC_DIVS.length - 1, Math.round(finiteOr(o.lfoDiv, 5))));
      if (o.lfoDepth !== undefined) P.lfoDepth[m] = Math.max(-1, Math.min(1, finiteOr(o.lfoDepth, 0)));
      if (o.envDepth !== undefined) P.envDepth[m] = Math.max(-1, Math.min(1, finiteOr(o.envDepth, 0)));
      if (o.retrig !== undefined) P.retrig[m] = finiteOr(o.retrig, 0) ? 1 : 0;
    }
  }

  setGlobal(p) {
    if (!p || typeof p !== 'object') return;
    if (p.tempo !== undefined) this.tempo = Math.max(20, Math.min(400, finiteOr(p.tempo, this.tempo)));
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
    const isB = slot === 1 || slot === 'B' || slot === 'b';
    const live = P.activeCount() > 0;
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
    if (!P) return;
    const note = +msg.note;
    if (!Number.isFinite(note)) return;
    const time = finiteOr(msg.time, 0);
    const vel = finiteOr(msg.vel, 0.8);
    if (time <= 0 || time <= this.lastTime) {
      if (type === 1) this.noteOn(P, note, vel); else this.noteOff(P, note);
      return;
    }
    const ev = { type, part: P.index, note, vel, time };
    const E = this.events;
    let i = E.length;
    while (i > 0 && E[i - 1].time > time) i--;
    E.splice(i, 0, ev);
  }

  allOff(part) {
    const only = part === undefined || part === null ? null : this.partAt(part);
    if (part !== undefined && part !== null && !only) return;
    for (const P of this.parts) {
      if (only && P !== only) continue;
      this.releasePart(P);
    }
    this.events = this.events.filter(e => only && e.part !== only.index);
  }

  releasePart(P) {
    for (const v of P.voices) {
      if (v.pending) v.pending = false;
      if (v.active && v.gate) this.releaseVoice(v);
    }
    P.stackLen = 0;
  }

  panic() {
    this.events.length = 0;
    for (const P of this.parts) {
      for (const v of P.voices) { v.active = false; v.gate = false; v.resetState(); }
      P.stackLen = 0;
      P.busL.fill(0); P.busR.fill(0);
      P.tail = 0;
      P.oldA = P.oldB = null; P.fadeA = P.fadeB = P.fadeACur = P.fadeBCur = 0;
    }
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
      P.lfoPhase[m] = 0;
      if (P.lfoShape[m] >= 4) { P.lfoR0[m] = P.lfoR1[m]; P.lfoR1[m] = P.rng() * 2 - 1; }
      P.lfoVal[m] = lfoValue(P.lfoShape[m], 0, P.lfoR0[m], P.lfoR1[m]);
    }
    this.partMods(P);
  }

  noteOn(P, note, vel) {
    if (vel > 1) vel /= 127;
    if (!(vel > 0)) { this.noteOff(P, note); return; }
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
      if (!legato) {
        v.vel = vel;
        v.velGain = this.velGain(P, vel);
        v.envStage = ATTACK;
        v.env2Stage = ATTACK;
      }
      // Mono glides on every note, Legato only between overlapping notes.
      if (!glideOn || (P.mode === 2 && !legato)) v.pitch = note;
    }
    P.lastPitch = note;
  }

  noteOff(P, note) {
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

  releaseVoice(v) {
    v.gate = false;
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
    for (let k = 1; k < MAX_UNISON; k++) v.phase[k] = this.rng();
    v.uniPrev = 0;
    v.envStage = ATTACK;
    v.env2Stage = ATTACK;
    // the part's shared modulation may be stale if it has been idle
    this.partMods(P);
    this.controlVoice(P, v, true);
    // Start the DC blocker as if it had always been running on this orbit, so
    // an orbit over high ground does not thump while the blocker settles.
    const mean = this.orbitMean(P, v);
    let gl = 0, gr = 0;
    for (let q = 0; q < P.uni; q++) { gl += P.gUL[q]; gr += P.gUR[q]; }
    v.dcMeanL = mean * gl;
    v.dcMeanR = mean * gr;
    v.dcInit = true;
  }

  /** Mean shaped terrain height over one cycle of the voice's current orbit. */
  orbitMean(P, v) {
    const pt = this.pt;
    const K = 48;
    const A = P.terrA[Math.min(v.lA, P.terrA.length - 1)], B = P.terrB[Math.min(v.lB, P.terrB.length - 1)];
    let sum = 0;
    for (let i = 0; i < K; i++) {
      pathPoint(P.shapeI, i / K, P.orderI, v.param, pt);
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

  currentBeats() {
    const T = this.transport;
    return T.beat + (this.blockTime - T.beatTime) * this.tempo / 60;
  }

  // ---- control rate ---------------------------------------------------------

  advanceLfos(P) {
    const dt = CTRL / this.sr;
    const anchored = this.transport.playing;
    const beats = anchored ? this.currentBeats() : 0;
    for (let m = 0; m < NMOD; m++) {
      const prev = P.lfoPhase[m];
      let ph;
      if (P.lfoSync[m]) {
        const div = SYNC_DIVS[P.lfoDiv[m]].beats;
        if (anchored) {
          ph = beats / div + P.lfoOffset[m];
        } else {
          ph = prev + (this.tempo / 60 / div) * dt;
        }
      } else {
        ph = prev + P.lfoRate[m] * dt;
      }
      ph -= Math.floor(ph);
      if (ph < prev) { P.lfoR0[m] = P.lfoR1[m]; P.lfoR1[m] = P.rng() * 2 - 1; }
      P.lfoPhase[m] = ph;
      P.lfoVal[m] = lfoValue(P.lfoShape[m], ph, P.lfoR0[m], P.lfoR1[m]);
    }
  }

  partMods(P) {
    for (let m = 0; m < NMOD; m++) {
      let n = P.baseNorm[m] + P.lfoVal[m] * P.lfoDepth[m];
      if (m === M_MORPH) n += P.wheel;
      n = MOD_WRAPS[m] ? n - Math.floor(n) : clamp01(n);
      P.partNorm[m] = n;
      P.partPlain[m] = fromNorm(MOD_DEFS[m], n);
    }
  }

  advanceEnv2(P, v) {
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
    if (v.envStage === DECAY) {
      if (P.sus <= 0 && v.envLvl < 1e-5) { v.envStage = IDLE; v.envLvl = 0; }
      else if (Math.abs(v.envLvl - P.sus) < 1e-9) v.envLvl = P.sus;
    }
    if (v.env2Stage === DECAY && Math.abs(v.env2Lvl - P.sus2) < 1e-9) v.env2Lvl = P.sus2;

    const glide = prm[PI.glide];
    if (glide > 0.0005) {
      if (!snap) {
        const kg = 1 - Math.exp(-CTRL / (sr * glide / 3));
        v.pitch += (v.note - v.pitch) * kg;
        if (Math.abs(v.note - v.pitch) < 1e-4) v.pitch = v.note;
      }
    } else {
      v.pitch = v.note;
    }

    // modulation in normalised space
    const e2 = v.env2Lvl;
    const MN = v.modNorm, MP = v.modPlain;
    for (let m = 0; m < NMOD; m++) {
      const ed = P.envDepth[m];
      if (ed === 0) { MN[m] = P.partNorm[m]; MP[m] = P.partPlain[m]; continue; }
      let n = P.baseNorm[m] + P.lfoVal[m] * P.lfoDepth[m] + e2 * ed;
      if (m === M_MORPH) n += P.wheel;
      n = MOD_WRAPS[m] ? n - Math.floor(n) : clamp01(n);
      MN[m] = n;
      MP[m] = fromNorm(MOD_DEFS[m], n);
    }

    // one-pole smoothing of the targets (wrap-aware for angles and the dot)
    if (snap) {
      v.sSize = MP[M_SIZE]; v.sStretch = MP[M_STRETCH]; v.sRot = MP[M_ROTATE];
      v.sCx = MP[M_CX]; v.sCy = MP[M_CY]; v.sMorph = MP[M_MORPH]; v.sWarp = MP[M_WARP];
      v.sLift = MP[M_LIFT]; v.sFold = MP[M_FOLD]; v.sParam = MP[M_PARAM];
      v.sCut = Math.log2(MP[M_CUTOFF]); v.sRes = MP[M_RES]; v.sDrive = MP[M_DRIVE]; v.sPan = MP[M_PAN];
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
      v.sRot -= Math.floor(v.sRot / 360) * 360;
      v.sCx -= Math.floor(v.sCx);
      v.sCy -= Math.floor(v.sCy);
    }

    // transform coefficients at the end of the block
    const ax = Math.exp(v.sStretch * 1.5 * Math.LN2);
    const sx = ax * v.sSize, sy = v.sSize / ax;
    const th = v.sRot / 360 + P.spinPhase;
    const c = fastCos(th), s = fastSin(th);
    const tA = sx * c, tB = sy * s, tC = sx * s, tD = sy * c;

    // pitch
    const semis = v.pitch + prm[PI.octave] * 12 + prm[PI.tune] + MP[M_FINE] / 100 + P.bend * prm[PI.bendRange];
    let f = 440 * Math.exp((semis - 69) * (Math.LN2 / 12));
    if (!(f > 0)) f = 1;

    // mip level from traversal speed (terrain units per second)
    const speed = f * pathLength(P.shapeI, P.orderI, v.sParam) * v.sSize * (ax > 1 ? ax : 1 / ax) * (1 + 1.3 * v.sWarp) + 1e-9;
    const lvA = this.mipLevel(P.terrA, speed);
    const lvB = this.mipLevel(P.terrB, speed);
    if (snap) { v.sLvA = lvA; v.sLvB = lvB; } else { v.sLvA += (lvA - v.sLvA) * k; v.sLvB += (lvB - v.sLvB) * k; }

    // filter
    let fc = Math.exp((v.sCut + prm[PI.keyTrack] * (semis - 60) / 12 + prm[PI.filterEnv] * 6 * e2) * Math.LN2);
    const fcMax = 0.45 * fs2;
    if (!(fc > 16)) fc = 16; else if (fc > fcMax) fc = fcMax;
    const g = Math.tan(Math.PI * fc / fs2);
    const kq = 2 - 1.97 * clamp01(v.sRes);

    // equal-power pan of the voice's stereo pair (unity at centre)
    const ang = (Math.max(-1, Math.min(1, v.sPan)) + 1) * Math.PI / 4;
    const gl = Math.cos(ang) * Math.SQRT2, gr = Math.sin(ang) * Math.SQRT2;

    const n2 = OVERSAMPLE * CTRL;
    const inv = 1 / n2;
    const U = P.uni;
    if (snap) {
      v.tA = tA; v.tB = tB; v.tC = tC; v.tD = tD; v.dtA = v.dtB = v.dtC = v.dtD = 0;
      v.cx = v.sCx; v.cy = v.sCy; v.dcx = v.dcy = 0;
      v.morph = v.sMorph; v.warp = v.sWarp; v.lift = v.sLift; v.fold = v.sFold; v.param = v.sParam;
      v.dMorph = v.dWarp = v.dLift = v.dFold = v.dParam = 0;
      v.g = g; v.k = kq; v.dg = v.dk = 0;
      v.drive = v.sDrive; v.dDrive = 0;
      v.gl = gl; v.gr = gr; v.dgl = v.dgr = 0;
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
    }
    for (let q = 0; q < U; q++) {
      let incT = f * P.detRatio[q] / fs2;
      if (incT > 0.45) incT = 0.45;
      if (snap || q >= v.uniPrev) { v.inc[q] = incT; v.dinc[q] = 0; } else v.dinc[q] = (incT - v.inc[q]) * inv;
    }
    v.uniPrev = U;

    this.setMipRamp(v, P.terrA.length, v.sLvA, snap, true, inv);
    this.setMipRamp(v, P.terrB.length, v.sLvB, snap, false, inv);

    // safety: a voice that ever goes non-finite is reset rather than left screaming
    if (!(Math.abs(v.ic1L) + Math.abs(v.ic2L) + Math.abs(v.ic1R) + Math.abs(v.ic2R) + Math.abs(v.dcyL) + Math.abs(v.dcyR) < 1e6)) {
      v.ic1L = v.ic2L = v.ic1R = v.ic2R = 0;
      v.dcxL = v.dcyL = v.dcxR = v.dcyR = 0;
    } else {
      if (Math.abs(v.ic1L) < 1e-20) v.ic1L = 0;
      if (Math.abs(v.ic2L) < 1e-20) v.ic2L = 0;
      if (Math.abs(v.ic1R) < 1e-20) v.ic1R = 0;
      if (Math.abs(v.ic2R) < 1e-20) v.ic2R = 0;
    }
  }

  mipLevel(chain, speed) {
    // A table of side S holds up to S/2 cycles per unit; traversed at `speed`
    // units/s that is S/2 * speed Hz. Keeping it under the oversampled Nyquist
    // (fs2/2) avoids folding at 2x; the default bias of one more octave keeps
    // it under the host Nyquist instead, which loses nothing (the decimator
    // removes that band anyway) but also pushes the images that bilinear
    // interpolation makes of near-Nyquist detail into the decimator's stopband.
    const lv = Math.log2(chain[0].size * speed / this.fs2) + this.mipBias;
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

  controlUpdate() {
    let anySolo = false;
    for (const P of this.parts) if (P.params[PI.solo] >= 0.5) anySolo = true;
    const k = this.kSmooth;
    const dt = CTRL / this.sr;
    const n2 = OVERSAMPLE * CTRL;
    for (const P of this.parts) {
      this.advanceLfos(P);
      P.spinPhase += P.params[PI.spin] * dt;
      P.spinPhase -= Math.floor(P.spinPhase);
      const active = P.activeCount();
      if (active > 0 || P.index === this.watch) this.partMods(P);

      // mixer targets: perceptual (squared) level, post-fader sends
      const audible = P.params[PI.mute] < 0.5 && (!anySolo || P.params[PI.solo] >= 0.5);
      const lv = clamp01(P.params[PI.level]);
      const gT = audible ? lv * lv * VOICE_GAIN : 0;
      const dT = gT * clamp01(P.params[PI.delaySend]), rT = gT * clamp01(P.params[PI.reverbSend]);
      // one-pole towards the targets, snapping when close so muting reaches true zero
      P.gainS = Math.abs(gT - P.gainS) < 1e-4 ? gT : P.gainS + (gT - P.gainS) * k;
      P.dlyS = Math.abs(dT - P.dlyS) < 1e-4 ? dT : P.dlyS + (dT - P.dlyS) * k;
      P.revS = Math.abs(rT - P.revS) < 1e-4 ? rT : P.revS + (rT - P.revS) * k;
      P.dGain = (P.gainS - P.gain) / CTRL;
      P.dDly = (P.dlyS - P.dly) / CTRL;
      P.dRev = (P.revS - P.rev) / CTRL;

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
   * Render n2 oversampled samples of one voice into its part bus at off2.
   * Pass 1 traces each unison oscillator's path for the whole segment, pass 2
   * maps it onto the terrain and sums the oscillators, pass 3 runs the per-
   * voice chain (DC block, drive, filter, envelope, pan). Segments never span
   * a control block, so n2 <= OVERSAMPLE * CTRL and the scratch fits.
   */
  renderVoice(P, v, off2, n2) {
    const bL = P.busL, bR = P.busR;
    const base = HB_HIST + off2;
    const U = P.uni, gUL = P.gUL, gUR = P.gUR;
    const stereo = U > 1;
    const XS = this.xs, YS = this.ys, SL = this.sumL, SR = this.sumR;
    const pst = this.pst;

    // ---- pass 1: paths
    for (let q = 0; q < U; q++) {
      pst[0] = v.phase[q]; pst[1] = v.inc[q]; pst[2] = v.dinc[q];
      pst[3] = v.param; pst[4] = v.dParam;
      pathBlock(P.shapeI, P.orderI, n2, pst, XS[q], YS[q]);
      v.phase[q] = pst[0]; v.inc[q] = pst[1];
    }
    v.param += v.dParam * n2;

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

    for (let q = 0; q < U; q++) {
      const X = XS[q], Y = YS[q];
      const gl = gUL[q], gr = gUR[q];
      let tA = tA0, tB = tB0, tC = tC0, tD = tD0, cx = cx0, cy = cy0;
      let morph = m0, warp = wp0, lift = lf0, fold = fd0, wA = wA0, wB = wB0, fA = fA0, fB = fB0;
      for (let j = 0; j < n2; j++) {
        tA += dtA; tB += dtB; tC += dtC; tD += dtD; cx += dcx; cy += dcy;
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
    v.tA = tA0 + dtA * n2; v.tB = tB0 + dtB * n2; v.tC = tC0 + dtC * n2; v.tD = tD0 + dtD * n2;
    v.cx = cx0 + dcx * n2; v.cy = cy0 + dcy * n2;
    v.morph = mEnd; v.warp = wp0 + dWarp * n2; v.lift = lf0 + dLift * n2; v.fold = fd0 + dFold * n2;
    v.wA = wA0 + dwA * n2; v.wB = wB0 + dwB * n2;

    // ---- pass 3: voice chain
    const ftype = P.ftype;
    let g = v.g, kq = v.k, drive = v.drive;
    const dg = v.dg, dk = v.dk, dDrive = v.dDrive;
    const driveOn = drive > 1e-4 || drive + dDrive * n2 > 1e-4;
    let ic1L = v.ic1L, ic2L = v.ic2L, ic1R = v.ic1R, ic2R = v.ic2R;
    let dxL = v.dcxL, dyL = v.dcyL, dxR = v.dcxR, dyR = v.dcyR;
    const R = this.dcR;
    let st = v.envStage, lvl = v.envLvl;
    const attC = P.attC, decC = P.decC, relC = P.relC, sus = P.sus;
    const vg = v.velGain;
    let gl = v.gl, gr = v.gr;
    const dgl = v.dgl, dgr = v.dgr;
    const stealing = v.stealFade > 0;
    let sg = v.stealGain;
    const ss = v.stealStep;

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
  }

  decimate(P, pos, seg) {
    const bL = P.busL, bR = P.busR, oL = P.outL, oR = P.outR;
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

  renderSegment(pos, seg, outL, outR, dlyL, dlyR, revL, revR) {
    const n2 = OVERSAMPLE * seg;
    const off2 = OVERSAMPLE * pos;
    for (const P of this.parts) {
      const active = P.activeCount();
      if (active === 0 && P.tail <= 0) {
        P.gain += P.dGain * seg; P.dly += P.dDly * seg; P.rev += P.dRev * seg;
        continue;
      }
      if (active > 0) P.tail = HB_N;
      for (const v of P.voices) {
        if (!v.active) continue;
        this.renderVoice(P, v, off2, n2);
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
      if (P.oldA) { P.fadeACur += P.dFadeA * n2; if (P.fadeACur < 0) P.fadeACur = 0; }
      if (P.oldB) { P.fadeBCur += P.dFadeB * n2; if (P.fadeBCur < 0) P.fadeBCur = 0; }
      this.decimate(P, pos, seg);
      const oL = P.outL, oR = P.outR;
      let gn = P.gain, dl = P.dly, rv = P.rev;
      const dgn = P.dGain, ddl = P.dDly, drv = P.dRev;
      for (let n = pos; n < pos + seg; n++) {
        gn += dgn; dl += ddl; rv += drv;
        const l = oL[n], r = oR[n];
        outL[n] += l * gn; outR[n] += r * gn;
        if (dlyL) { dlyL[n] += l * dl; dlyR[n] += r * dl; }
        if (revL) { revL[n] += l * rv; revR[n] += r * rv; }
      }
      P.gain = gn; P.dly = dl; P.rev = rv;
      if (active === 0) {
        P.tail -= seg;
        if (P.tail <= 0) { P.busL.fill(0); P.busR.fill(0); }
      }
    }
  }

  /**
   * Render `frames` samples. outL/outR: dry mix; dlyL/dlyR and revL/revR:
   * delay and reverb send buses (any of the send arrays may be null).
   * currentTime is the AudioContext time of the first sample.
   */
  process(outL, outR, dlyL, dlyR, revL, revR, frames, currentTime) {
    const sr = this.sr;
    const n = frames | 0;
    const now = Number.isFinite(currentTime) ? currentTime : this.lastTime + n / sr;
    this.lastTime = now;
    outL.fill(0, 0, n); outR.fill(0, 0, n);
    if (dlyL) { dlyL.fill(0, 0, n); dlyR.fill(0, 0, n); }
    if (revL) { revL.fill(0, 0, n); revR.fill(0, 0, n); }
    for (const P of this.parts) {
      P.ensureBus(n);
      P.busL.fill(0, HB_HIST, HB_HIST + OVERSAMPLE * n);
      P.busR.fill(0, HB_HIST, HB_HIST + OVERSAMPLE * n);
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
        if (ev.type === 1) this.noteOn(P, ev.note, ev.vel); else this.noteOff(P, ev.note);
      }
      if (this.ctrlRemain <= 0) {
        this.blockTime = now + pos / sr;
        this.controlUpdate();
        this.ctrlRemain = CTRL;
      }
      let seg = n - pos;
      if (seg > this.ctrlRemain) seg = this.ctrlRemain;
      if (E.length) {
        const off = Math.round((E[0].time - now) * sr);
        if (off > pos && off - pos < seg) seg = off - pos;
      }
      this.renderSegment(pos, seg, outL, outR, dlyL, dlyR, revL, revR);
      pos += seg;
      this.ctrlRemain -= seg;
    }

    const H2 = OVERSAMPLE * n;
    for (const P of this.parts) {
      P.busL.copyWithin(0, H2, H2 + HB_HIST);
      P.busR.copyWithin(0, H2, H2 + HB_HIST);
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
    this.peakL = pl; this.peakR = pr;

    this.teleCount += n;
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
    const activeVoices = this.parts.map(p => p.activeCount());
    const msg = { t: 'tele', part: this.watch, n: nobj, spinPhase: P.spinPhase, voices, peak: [this.peakL, this.peakR], activeVoices };
    this.peakL = 0; this.peakR = 0;
    this.postMessage(msg);
  }
}
