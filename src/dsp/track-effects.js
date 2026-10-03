import { FX_TYPE_MAP, FX_ROUTINGS, FILTER_SEQ_PATTERNS, defaultTrackFx, freqShiftHz } from './track-fx-config.js';
export { FX_TYPES, FX_ROUTINGS, defaultTrackFx, defaultFxSlot, sanitizeTrackFx } from './track-fx-config.js';

const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = (x) => Number.isFinite(x) ? x : 0;
const safe = (x) => clamp(finite(x), -8, 8);
const db = (x) => Math.pow(10, x / 20);
const pole = (hz, sr) => 1 - Math.exp(-TAU * Math.min(hz, sr * .45) / sr);
const timePole = (seconds, sr) => 1 - Math.exp(-1 / Math.max(1, seconds * sr));
const wrap = (x) => x - Math.floor(x);
// Frequency shifter Hilbert pair: two chains of four second-order all-pass
// sections, y[n] = c (x[n] + y[n-2]) - x[n-2], whose outputs stay close to
// 90 degrees apart across the audio band (c is the square of a published,
// widely used 8th-order coefficient set). The first chain is delayed by one
// sample so the two chains line up.
const HILBERT_A = Float64Array.from([.6923878, .9360654322959, .9882295226860, .9987488452737], c => c * c);
const HILBERT_B = Float64Array.from([.4021921162426, .8561710882420, .9722909545651, .9952884791278], c => c * c);
const HILBERT_STRIDE = 34;
// Hyper dimension voices: base delay (s), LFO rate multiplier, pan.
const HYPER_BASE = Float64Array.from([.0071, .0113, .0149, .0193, .0237, .0281]);
const HYPER_RATE = Float64Array.from([1, 1.18, .83, 1.37, .71, 1.52]);
const HYPER_PAN = Float64Array.from([-1, 1, -.6, .6, -.25, .25]);
const SEQ_STEPS = Float64Array.from(FILTER_SEQ_PATTERNS.flatMap(pattern => pattern.steps));
const SEQ_LOW = Math.log(.005);
const rounded = (x) => { x = clamp(x, -3, 3); return x * (27 + x * x) / (27 + 9 * x * x); };

// RBJ biquads in transposed direct form II. Coefficients and both channel
// histories belong to the slot and are updated without temporary objects.
function coefficients(c, at, kind, hz, q, gain, sr) {
  const w = TAU * clamp(hz, 10, sr * .45) / sr, cs = Math.cos(w), sn = Math.sin(w);
  const a = sn / (2 * Math.max(.1, q)), A = db(gain / 2);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'low') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + a; a1 = -2 * cs; a2 = 1 - a; }
  else if (kind === 'high') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + a; a1 = -2 * cs; a2 = 1 - a; }
  else if (kind === 'band') { b0 = a; b1 = 0; b2 = -a; a0 = 1 + a; a1 = -2 * cs; a2 = 1 - a; }
  else if (kind === 'peak') { b0 = 1 + a * A; b1 = -2 * cs; b2 = 1 - a * A; a0 = 1 + a / A; a1 = b1; a2 = 1 - a / A; }
  else {
    const t = 2 * Math.sqrt(A) * sn / Math.sqrt(2);
    if (kind === 'shelfLow') {
      b0 = A * ((A + 1) - (A - 1) * cs + t); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - t);
      a0 = (A + 1) + (A - 1) * cs + t; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - t;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cs + t); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - t);
      a0 = (A + 1) - (A - 1) * cs + t; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - t;
    }
  }
  c[at] = b0 / a0; c[at + 1] = b1 / a0; c[at + 2] = b2 / a0; c[at + 3] = a1 / a0; c[at + 4] = a2 / a0;
}

class EffectSlot {
  constructor(sr, index) {
    this.sr = sr;
    this.size = Math.ceil(sr * 2.05) + 8;
    this.bufL = new Float32Array(this.size); this.bufR = new Float32Array(this.size);
    this.fdnSize = Math.ceil(sr * .17) + 8;
    this.fdn = Array.from({ length: 8 }, () => new Float32Array(this.fdnSize));
    this.fdnDelay = new Float64Array(8); this.fdnValue = new Float64Array(8); this.fdnDamp = new Float64Array(8);
    this.c = new Float64Array(20); this.zL = new Float64Array(8); this.zR = new Float64Array(8);
    this.apL = new Float64Array(8); this.apR = new Float64Array(8);
    this.envBands = new Float64Array(3); this.bandGain = new Float64Array(3);
    this.p = new Float64Array(4); this.target = new Float64Array(4);
    this.index = index; this.type = 0; this.mixTarget = 0; this.mix = 0;
    this.smooth = timePole(.012, sr); this.transitionPole = timePole(.004, sr);
    this.bodyPole = pole(180, sr); this.lowPole = pole(160, sr); this.highPole = pole(2400, sr); this.modPole = timePole(.002, sr);
    // Every effect shares the same object shape. Adding properties inside an
    // effect branch makes this hot processor megamorphic in JS engines.
    this.tone = 0; this.delay = 0; this.fb = 0; this.rate = 0; this.base = 0; this.depth = 0; this.drive = 1;
    this.steps = 1; this.holdSamples = 0; this.ratio = 1; this.grainSize = 1; this.attack = 1; this.release = 1;
    this.threshold = 1; this.duckScale = 0; this.ratioPower = 0; this.makeup = 1; this.downPower = 0; this.upPower = 0;
    this.floor = 0; this.noise = 0; this.fdnGain = 0; this.fdnTone = 0; this.grainL = 0; this.grainR = 0; this.wetL = 0; this.wetR = 0;
    this.apCoefficient = 0;
    // frequency shifter (Hilbert states per channel), Hyper voice LFOs and the
    // tempo clock of the filter sequencer
    this.hilbert = new Float64Array(HILBERT_STRIDE * 2); this.voicePhase = new Float64Array(HYPER_BASE.length);
    this.hI = 0; this.hQ = 0; this.direction = 0; this.pattern = 0;
    this.tempo = 120; this.stepRate = 120 / 15 / sr; this.seqPos = 0;
    this.L = 0; this.R = 0; this.tailL = 0; this.tailR = 0;
    this.reset();
  }
  configure(value) {
    const def = FX_TYPE_MAP[value?.type] || FX_TYPE_MAP.bypass;
    const next = def.index;
    if (next !== this.type) {
      const oldL = this.deltaL || 0, oldR = this.deltaR || 0;
      this.reset(); this.type = next; this.tailL = oldL; this.tailR = oldR;
      for (let i = 0; i < 4; i++) this.p[i] = clamp(Number.isFinite(value?.['p' + (i + 1)]) ? value['p' + (i + 1)] : def.defaults[i], 0, 1);
      this.mix = 0;
    }
    for (let i = 0; i < 4; i++) this.target[i] = clamp(Number.isFinite(value?.['p' + (i + 1)]) ? value['p' + (i + 1)] : def.defaults[i], 0, 1);
    this.mixTarget = next ? clamp(Number.isFinite(value?.mix) ? value.mix : .5, 0, 1) : 0;
    this.control = 0;
  }
  reset() {
    this.bufL.fill(0); this.bufR.fill(0); for (let i = 0; i < 8; i++) this.fdn[i].fill(0);
    this.fdnValue.fill(0); this.fdnDamp.fill(0); this.zL.fill(0); this.zR.fill(0); this.apL.fill(0); this.apR.fill(0); this.envBands.fill(0); this.bandGain.fill(1);
    this.pos = 0; this.fdnPos = 0; this.phase = 0; this.grainPhase = 0; this.scatter = 0;
    this.lpL = 0; this.lpR = 0; this.bodyL = 0; this.bodyR = 0;
    this.lowL = 0; this.lowR = 0; this.highL = 0; this.highR = 0;
    this.feedbackL = 0; this.feedbackR = 0; this.env = 0; this.gain = 1;
    this.heldL = 0; this.heldR = 0; this.hold = 0; this.gateHold = 0;
    this.seed = (0x6d2b79f5 + this.index * 9871) | 0; this.control = 0;
    this.tailL = 0; this.tailR = 0; this.deltaL = 0; this.deltaR = 0; this.reduction = 1;
    this.hilbert.fill(0); this.hI = 0; this.hQ = 0; this.seqPos = 0;
    for (let i = 0; i < this.voicePhase.length; i++) this.voicePhase[i] = i / this.voicePhase.length;
  }
  /** One Hilbert step: hI and hQ receive the in-phase and quadrature parts. */
  hilbertStep(x, base) {
    const h = this.hilbert;
    let a = x, b = x;
    for (let i = 0; i < 4; i++) {
      const o = base + i * 4, q = o + 16;
      const ya = HILBERT_A[i] * (a + h[o + 3]) - h[o + 1];
      h[o + 1] = h[o]; h[o] = a; h[o + 3] = h[o + 2]; h[o + 2] = ya; a = ya;
      const yb = HILBERT_B[i] * (b + h[q + 3]) - h[q + 1];
      h[q + 1] = h[q]; h[q] = b; h[q + 3] = h[q + 2]; h[q + 2] = yb; b = yb;
    }
    this.hI = h[base + 32]; h[base + 32] = a; this.hQ = b;
  }
  random() { let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x; return (x >>> 0) / 4294967296 * 2 - 1; }
  read(buffer, delay) {
    let p = this.pos - delay;
    if (p < 0) p += this.size;
    const at = p | 0, f = p - at, next = at + 1 === this.size ? 0 : at + 1;
    return buffer[at] + (buffer[next] - buffer[at]) * f;
  }
  write(L, R) { this.bufL[this.pos] = safe(L); this.bufR[this.pos] = safe(R); }
  biquad(x, stage, right = false) {
    const c = this.c, z = right ? this.zR : this.zL, at = stage * 5, zi = stage * 2;
    const y = c[at] * x + z[zi];
    z[zi] = c[at + 1] * x - c[at + 3] * y + z[zi + 1]; z[zi + 1] = c[at + 2] * x - c[at + 4] * y;
    return safe(y);
  }
  updateControl() {
    const p = this.p, sr = this.sr;
    const type = this.type;
    if (type === 1 || type === 2) { this.delay = sr * .02 * Math.pow(100, p[0]); this.fb = p[1] * .94; this.tone = pole(300 * Math.pow(50, p[2]), sr); }
    else if (type === 5 || type === 6 || type === 7) {
      this.rate = .05 * Math.pow(100, p[0]) / sr;
      this.base = sr * (type === 5 ? .018 : .0003 + .008 * p[3]); this.depth = sr * (type === 5 ? .012 * p[1] : .0002 + .004 * p[1]);
      this.fb = type === 5 ? p[2] * .6 : (p[2] * 2 - 1) * .9;
      if (type === 7) {
        const hz = 200 * Math.pow(15, .5 + Math.sin(TAU * this.phase) * p[1] * .5), t = Math.tan(Math.PI * Math.min(hz, sr * .4) / sr);
        this.apCoefficient = (1 - t) / (1 + t);
      }
    } else if (type === 8 || type === 9 || type === 25) {
      this.drive = 1 + p[0] * (type === 9 ? 79 : type === 25 ? 8 : 29);
      this.tone = pole(300 * Math.pow(50, type === 8 ? p[1] : type === 9 ? p[3] : p[2]), sr);
    } else if (type === 10) { this.steps = Math.pow(2, Math.round(3 + 13 * p[0]) - 1); this.holdSamples = Math.round(1 + p[1] * 63) - 1; }
    else if (type === 11) { this.ratio = Math.pow(2, (48 * p[0] - 24) / 12); this.grainSize = sr * (.04 + .08 * p[1]); }
    else if (type === 13 || type === 15 || type === 16) {
      const attack = type === 13 ? .001 + p[2] * .079 : type === 15 ? .002 + p[2] * .098 : 0;
      const release = type === 13 ? .03 + p[3] * .97 : type === 15 ? .03 + p[3] * .67 : .01 + p[1] * .99;
      this.attack = attack ? timePole(attack, sr) : 1; this.release = timePole(release, sr);
      this.threshold = db(type === 13 ? -48 + 42 * p[1] : type === 15 ? -48 + 45 * p[0] : -12 + p[0] * 12);
      this.duckScale = -36 * p[0] * Math.LN10 / 20; this.ratioPower = 1 / (1 + 19 * p[1]) - 1;
      this.delay = p[2] * sr * .005;
    } else if (type === 14) {
      const t = .003 + p[1] * .097; this.attack = timePole(t, sr); this.release = timePole(t * 5, sr); this.makeup = db((p[2] - .5) * 24);
      this.downPower = -.75 * p[0]; this.upPower = p[0] * p[3] * .75;
    } else if (type === 17 || type === 18) this.rate = .1 * Math.pow(200, p[0]) / sr;
    else if (type === 19) this.rate = 20 * Math.pow(100, p[0]) / sr;
    else if (type === 20) { this.attack = timePole(.003, sr); this.release = timePole(.08, sr); }
    else if (type === 21 || type === 22) this.drive = 1 + p[2] * 12;
    else if (type === 23) { this.delay = sr / (40 * Math.pow(50, p[0])); this.fb = (p[1] * 2 - 1) * .95; this.tone = pole(300 * Math.pow(50, p[2]), sr); this.drive = 1 + p[3] * 6; }
    else if (type === 26) { this.threshold = db(-70 + 55 * p[0]); this.holdSamples = Math.round(p[1] * sr * .2); this.floor = db(-80 + p[3] * 60); this.attack = timePole(.001, sr); this.release = timePole(.005 + p[2] * .595, sr); }
    else if (type === 27) { this.rate = (.1 + p[1] * 1.9) / sr; this.drive = 1 + p[0] * 7; this.noise = db(-90 + p[3] * 50); this.tone = pole(1200 * Math.pow(10, p[2]), sr); }
    else if (type === 28) {
      // switches follow the target directly: a gliding direction would click through every state
      this.rate = freqShiftHz(p[0]) / sr; this.fb = p[1] * .9; this.direction = Math.round(this.target[2] * 2); this.delay = sr * .001 * Math.pow(500, p[3]);
    } else if (type === 29) {
      // Detune sets the peak pitch deviation (0 to 25 cents): delay depth = deviation / (2 pi rate)
      const hz = .05 * Math.pow(100, p[0]);
      this.rate = hz / sr; this.depth = sr * Math.min(.012, (Math.pow(2, 25 * p[1] / 1200) - 1) / (TAU * hz));
    }
    else if (type === 30) {
      this.pattern = Math.round(this.target[0] * (FILTER_SEQ_PATTERNS.length - 1)) * 8;
      this.attack = timePole(.001 + p[1] * 15 / this.tempo, sr); this.fb = 2 - 1.85 * p[2];
    }
    if (this.type === 12) {
      coefficients(this.c, 0, 'shelfLow', 100, .707, 24 * p[0] - 12, sr);
      coefficients(this.c, 5, 'peak', 500, .7, 24 * p[1] - 12, sr);
      coefficients(this.c, 10, 'peak', 3000, .8, 24 * p[2] - 12, sr);
      coefficients(this.c, 15, 'shelfHigh', 10000, .707, 24 * p[3] - 12, sr);
    } else if (this.type === 20) {
      const hz = 120 * Math.pow(30, clamp(p[3] * .6 + this.env * (1 + 12 * p[0]) * p[2], 0, 1));
      coefficients(this.c, 0, 'band', hz, .5 + 9 * p[1], 0, sr);
    } else if (this.type === 21 || this.type === 22) {
      coefficients(this.c, 0, this.type === 21 ? 'low' : 'high', 20 * Math.pow(900, p[0]), .5 + 10 * p[1], 0, sr);
      coefficients(this.c, 5, this.type === 21 ? 'low' : 'high', 20 * Math.pow(900, p[0]), .707, 0, sr);
    } else if (this.type === 3 || this.type === 4) {
      for (let i = 0; i < 8; i++) this.fdnDelay[i] = Math.round(sr * (.025 + i * .00713 + (i % 3) * .0017) * (.45 + p[0] * 1.45));
      const mean = sr * .051 * (.45 + p[0] * 1.45);
      this.fdnGain = clamp(Math.pow(10, -3 * mean / (sr * (.2 + p[1] * 11.8))), 0, .996);
      this.fdnTone = pole(12000 * Math.pow(.035, p[2]), sr);
    }
  }
  grain(L, R, ratio, grainSize, feedback, scatter) {
    const phase = this.grainPhase, p2 = wrap(phase + .5), base = 4 + this.scatter;
    const w = .5 - .5 * Math.cos(TAU * phase);
    const aL = this.read(this.bufL, base + phase * grainSize), bL = this.read(this.bufL, base + p2 * grainSize);
    const aR = this.read(this.bufR, base + phase * grainSize), bR = this.read(this.bufR, base + p2 * grainSize);
    this.grainL = aL * w + bL * (1 - w); this.grainR = aR * w + bR * (1 - w);
    this.write(L + this.grainL * feedback, R + this.grainR * feedback);
    const next = phase + (1 - ratio) / grainSize;
    if (next < 0 || next >= 1) this.scatter = scatter * grainSize * .25 * (this.random() + 1);
    this.grainPhase = wrap(next);
  }
  reverb(L, R, shimmer) {
    const vals = this.fdnValue, p = this.p;
    let wetL = 0, wetR = 0;
    for (let i = 0; i < 8; i++) {
      let read = this.fdnPos - this.fdnDelay[i]; if (read < 0) read += this.fdnSize;
      const raw = this.fdn[i][read]; this.fdnDamp[i] += this.fdnTone * (raw - this.fdnDamp[i]); vals[i] = this.fdnDamp[i];
      wetL += raw * (i % 2 ? -.25 : .25); wetR += raw * (i % 3 ? .25 : -.25);
    }
    // Normalized Hadamard scattering preserves feedback energy.
    for (let stride = 1; stride < 8; stride *= 2) for (let start = 0; start < 8; start += stride * 2) for (let j = 0; j < stride; j++) {
      const a = vals[start + j], b = vals[start + j + stride]; vals[start + j] = a + b; vals[start + j + stride] = a - b;
    }
    let shiftL = 0, shiftR = 0;
    if (shimmer) { this.grain(wetL, wetR, 2, this.sr * .065, 0, 0); shiftL = this.grainL * p[3] * .7; shiftR = this.grainR * p[3] * .7; }
    const diffuse = shimmer ? .8 : p[3], gain = this.fdnGain * (shimmer ? 1 - p[3] * .4 : 1);
    for (let i = 0; i < 8; i++) {
      const scattered = vals[i] * .3535533905932738;
      const feedback = (this.fdnDamp[i] * (1 - diffuse) + scattered * diffuse) * gain;
      this.fdn[i][this.fdnPos] = safe(feedback + (i % 2 ? R + shiftR : L + shiftL) * .25);
    }
    if (++this.fdnPos === this.fdnSize) this.fdnPos = 0;
    this.wetL = wetL; this.wetR = wetR;
  }
  process(L, R, sidechain) {
    const type = this.type;
    if (!type && Math.abs(this.tailL) + Math.abs(this.tailR) < 1e-12) { this.L = L; this.R = R; this.reduction = 1; return; }
    this.mix += this.smooth * (this.mixTarget - this.mix);
    for (let i = 0; i < 4; i++) this.p[i] += this.smooth * (this.target[i] - this.p[i]);
    if (!this.control--) { this.updateControl(); this.control = 31; }
    const p = this.p, sr = this.sr, peak = Math.max(Math.abs(L), Math.abs(R));
    let l = L, r = R; this.reduction = 1;
    if (type === 1 || type === 2) {
      const delay = this.delay, fb = this.fb, tone = this.tone;
      const dl = this.read(this.bufL, delay), dr = this.read(this.bufR, delay);
      this.lpL += tone * (dl - this.lpL); this.lpR += tone * (dr - this.lpR);
      if (type === 2) {
        const mono = (L + R) * .5;
        this.write(L * (1 - p[3]) + mono * p[3] + this.lpR * fb, R * (1 - p[3]) + this.lpL * fb);
      } else this.write(L + fb * (this.lpL * (1 - p[3]) + this.lpR * p[3]), R + fb * (this.lpR * (1 - p[3]) + this.lpL * p[3]));
      l = dl; r = dr;
    } else if (type === 3 || type === 4) { this.reverb(L, R, type === 4); l = this.wetL; r = this.wetR; }
    else if (type === 5 || type === 6) {
      this.phase = wrap(this.phase + this.rate);
      const rateL = Math.sin(TAU * this.phase), rateR = Math.sin(TAU * (this.phase + (type === 5 ? p[3] * .5 : .13)));
      const dl = this.read(this.bufL, Math.max(sr * .0001, this.base + this.depth * rateL)), dr = this.read(this.bufR, Math.max(sr * .0001, this.base + this.depth * rateR));
      const fb = this.fb;
      this.write(L + dl * fb, R + dr * fb); l = dl; r = dr;
    } else if (type === 7) {
      this.phase = wrap(this.phase + this.rate);
      const a = this.apCoefficient;
      l = L + this.feedbackL * (p[2] * 2 - 1) * .8; r = R + this.feedbackR * (p[2] * 2 - 1) * .8;
      let fourL = 0, fourR = 0;
      for (let i = 0; i < 8; i++) { const yl = -a * l + this.apL[i], yr = -a * r + this.apR[i]; this.apL[i] = l + a * yl; this.apR[i] = r + a * yr; l = yl; r = yr; if (i === 3) { fourL = l; fourR = r; } }
      l = fourL + (l - fourL) * p[3]; r = fourR + (r - fourR) * p[3]; this.feedbackL = safe(l); this.feedbackR = safe(r);
    } else if (type === 8 || type === 9 || type === 25) {
      const drive = this.drive, bias = (p[2] - .5) * .7;
      if (type === 8) { l = (Math.tanh(L * drive + bias) - Math.tanh(bias)) * (.25 + p[3] * 1.5); r = (Math.tanh(R * drive + bias) - Math.tanh(bias)) * (.25 + p[3] * 1.5); }
      else if (type === 9) {
        const ceiling = .1 + p[1] * .9, xL = L * drive, xR = R * drive;
        const foldL = 1 - 4 * Math.abs(wrap(xL / 4 + .25) - .5), foldR = 1 - 4 * Math.abs(wrap(xR / 4 + .25) - .5);
        l = clamp(xL, -ceiling, ceiling) * (1 - p[2]) + foldL * ceiling * p[2]; r = clamp(xR, -ceiling, ceiling) * (1 - p[2]) + foldR * ceiling * p[2];
      } else {
        const b = (p[3] - .5) * .4; this.bodyL += this.bodyPole * (L - this.bodyL); this.bodyR += this.bodyPole * (R - this.bodyR);
        l = rounded((L + this.bodyL * (p[1] * 2 - 1)) * drive + b) - rounded(b); r = rounded((R + this.bodyR * (p[1] * 2 - 1)) * drive + b) - rounded(b);
      }
      const tone = this.tone;
      this.lpL += tone * (l - this.lpL); this.lpR += tone * (r - this.lpR); l = this.lpL; r = this.lpR;
    } else if (type === 10) {
      if (this.hold-- <= 0) { const steps = this.steps, dither = (this.random() + this.random()) * p[2] / steps;
        this.heldL = Math.round((L + dither) * steps) / steps; this.heldR = Math.round((R - dither) * steps) / steps; this.hold = this.holdSamples; }
      const tone = 1 - p[3] * .97; this.lpL += tone * (this.heldL - this.lpL); this.lpR += tone * (this.heldR - this.lpR); l = this.lpL; r = this.lpR;
    } else if (type === 11) { this.grain(L, R, this.ratio, this.grainSize, p[2] * .85, p[3]); l = this.grainL; r = this.grainR; }
    else if (type === 12) { for (let i = 0; i < 4; i++) { l = this.biquad(l, i); r = this.biquad(r, i, true); } }
    else if (type === 13 || type === 15 || type === 16) {
      const detector = type === 13 ? Math.abs(sidechain) : peak;
      this.env += (detector > this.env ? this.attack : this.release) * (detector - this.env);
      let desired = 1;
      if (type === 13) { const threshold = this.threshold; desired = Math.exp(this.duckScale * clamp((this.env - threshold) / Math.max(threshold, .02), 0, 1)); }
      else if (type === 15) { const threshold = this.threshold; if (this.env > threshold) desired = Math.pow(this.env / threshold, this.ratioPower); }
      else {
        const ceiling = this.threshold, soft = ceiling * (1 - p[3] * .3);
        desired = this.env > soft ? Math.min(1, ceiling / Math.max(ceiling, this.env)) : 1;
        this.write(L, R); l = this.read(this.bufL, this.delay); r = this.read(this.bufR, this.delay);
      }
      this.gain += (desired < this.gain ? this.attack : this.release) * (desired - this.gain);
      l *= this.gain; r *= this.gain;
      if (type === 16) { const ceiling = this.threshold; l = clamp(l, -ceiling, ceiling); r = clamp(r, -ceiling, ceiling); }
      this.reduction = this.gain;
    } else if (type === 14) {
      const a = this.lowPole, b = this.highPole;
      this.lowL += a * (L - this.lowL); this.lowR += a * (R - this.lowR); this.highL += b * (L - this.highL); this.highR += b * (R - this.highR);
      l = 0; r = 0;
      for (let i = 0; i < 3; i++) {
        const bl = i === 0 ? this.lowL : i === 1 ? this.highL - this.lowL : L - this.highL, br = i === 0 ? this.lowR : i === 1 ? this.highR - this.lowR : R - this.highR;
        const e = Math.max(Math.abs(bl), Math.abs(br));
        this.envBands[i] += (e > this.envBands[i] ? this.attack : this.release) * (e - this.envBands[i]);
        const level = Math.max(1e-5, this.envBands[i]); let gain = 1;
        if (level > .25) gain = Math.pow(level / .25, this.downPower);
        else if (level < .063 && level > 1e-5) gain = Math.min(8, Math.pow(.063 / level, this.upPower));
        this.bandGain[i] += this.smooth * (gain - this.bandGain[i]); l += bl * this.bandGain[i]; r += br * this.bandGain[i];
        this.reduction = Math.min(this.reduction, this.bandGain[i]);
      }
      l *= this.makeup; r *= this.makeup;
    } else if (type === 17 || type === 18) {
      this.phase = wrap(this.phase + this.rate);
      const sl = Math.sin(TAU * this.phase), rs = Math.sin(TAU * (this.phase + (type === 18 ? .5 + (p[3] - .5) * .5 : p[3] * .5)));
      const ml = sl * (1 - p[2]) + (sl >= 0 ? 1 : -1) * p[2], mr = rs * (1 - p[2]) + (rs >= 0 ? 1 : -1) * p[2];
      this.lpL += this.modPole * ((1 - p[1] * .5 + ml * p[1] * .5) - this.lpL); this.lpR += this.modPole * ((1 - p[1] * .5 + mr * p[1] * .5) - this.lpR);
      l *= this.lpL; r *= this.lpR;
    } else if (type === 19) {
      this.phase = wrap(this.phase + this.rate);
      l *= 1 - p[1] + p[1] * Math.sin(TAU * (this.phase + p[2])); r *= 1 - p[1] + p[1] * Math.sin(TAU * (this.phase + p[2] + p[3] * .5));
    } else if (type === 20) { this.env += (peak > this.env ? this.attack : this.release) * (peak - this.env); l = this.biquad(L, 0); r = this.biquad(R, 0, true); }
    else if (type === 21 || type === 22) {
      const drive = this.drive; const firstL = this.biquad(Math.tanh(L * drive) / drive, 0), firstR = this.biquad(Math.tanh(R * drive) / drive, 0, true);
      l = firstL + (this.biquad(firstL, 1) - firstL) * p[3]; r = firstR + (this.biquad(firstR, 1, true) - firstR) * p[3];
    } else if (type === 23) {
      const delay = this.delay, fb = this.fb;
      const dl = this.read(this.bufL, delay), dr = this.read(this.bufR, delay);
      this.lpL += this.tone * (dl - this.lpL); this.lpR += this.tone * (dr - this.lpR);
      this.write(Math.tanh(L * this.drive) / this.drive + this.lpL * fb, Math.tanh(R * this.drive) / this.drive + this.lpR * fb);
      l = L + dl * .7; r = R + dr * .7;
    } else if (type === 24) {
      const mid = (L + R) * .5, side = (L - R) * p[0], wl = mid + side, wr = mid - side;
      this.write(wl, wr); const delayed = this.read(this.bufR, sr * .03 * p[2]);
      l = (wl * (1 - p[3] * .5) + delayed * p[3] * .5) * Math.min(1, 2 * (1 - p[1])); r = (delayed * (1 - p[3] * .5) + wl * p[3] * .5) * Math.min(1, 2 * p[1]);
    } else if (type === 26) {
      const threshold = this.threshold;
      if (peak > threshold) this.gateHold = this.holdSamples; else if (this.gateHold > 0) this.gateHold--;
      const desired = peak > threshold || this.gateHold > 0 ? 1 : this.floor;
      this.gain += (desired > this.gain ? this.attack : this.release) * (desired - this.gain); l *= this.gain; r *= this.gain; this.reduction = this.gain;
    } else if (type === 27) {
      this.phase = wrap(this.phase + this.rate);
      const d = sr * (.004 + .003 * p[1] * Math.sin(TAU * this.phase) + .0002 * p[1] * Math.sin(TAU * this.phase * 7.17));
      const drive = this.drive, noise = this.random() * this.noise;
      this.write(rounded(L * drive) / Math.sqrt(drive) + noise, rounded(R * drive) / Math.sqrt(drive) - noise);
      const dl = this.read(this.bufL, d), dr = this.read(this.bufR, d), tone = this.tone;
      this.lpL += tone * (dl - this.lpL); this.lpR += tone * (dr - this.lpR); l = this.lpL; r = this.lpR;
    } else if (type === 28) {
      // single-sideband shift: (I cos + Q sin) moves partials up, (I cos - Q sin) down
      this.phase = wrap(this.phase + this.rate);
      const c = Math.cos(TAU * this.phase), sn = Math.sin(TAU * this.phase), fb = this.fb;
      const dir = this.direction, upL = dir !== 1 ? 1 : -1, upR = dir === 0 ? 1 : -1;
      this.hilbertStep(L + fb * this.read(this.bufL, this.delay), 0); l = this.hI * c + upL * this.hQ * sn;
      this.hilbertStep(R + fb * this.read(this.bufR, this.delay), HILBERT_STRIDE); r = this.hI * c + upR * this.hQ * sn;
      this.write(l, r);
    } else if (type === 29) {
      this.write(L, R);
      const n = HYPER_BASE.length, width = p[2], vp = this.voicePhase;
      let wl = 0, wr = 0;
      for (let i = 0; i < n; i++) {
        const ph = vp[i] = wrap(vp[i] + this.rate * HYPER_RATE[i]);
        const pan = HYPER_PAN[i], x = this.read(pan < 0 ? this.bufL : this.bufR, sr * HYPER_BASE[i] + this.depth * (1 + Math.sin(TAU * ph)));
        wl += x * (1 - pan * width); wr += x * (1 + pan * width);
      }
      // Dimension: short cross-channel reflections of opposite polarity
      const dim = p[3] * .5;
      const xl = this.read(this.bufR, sr * .0043) * .7 - this.read(this.bufR, sr * .0127) * .45;
      const xr = this.read(this.bufL, sr * .0061) * .7 - this.read(this.bufL, sr * .0167) * .45;
      // the voices are mostly decorrelated, so they sum near unity power
      l = (wl * .35 + dim * xl) / (1 + dim * .4); r = (wr * .35 + dim * xr) / (1 + dim * .4);
    } else if (type === 30) {
      let pos = this.seqPos + this.stepRate; if (pos >= 8) pos -= 8; this.seqPos = pos;
      this.env += this.attack * (SEQ_STEPS[this.pattern + (pos | 0)] - this.env);
      const hz = 18000 * Math.exp(SEQ_LOW * p[3] * (1 - this.env)), g = Math.tan(Math.PI * Math.min(hz, sr * .45) / sr);
      // trapezoidal state-variable low-pass; k = 1 / Q
      const k = this.fb, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2, zl = this.zL, zr = this.zR;
      let v3 = L - zl[1], v1 = a1 * zl[0] + a2 * v3, v2 = zl[1] + a2 * zl[0] + a3 * v3;
      zl[0] = 2 * v1 - zl[0]; zl[1] = 2 * v2 - zl[1]; l = v2;
      v3 = R - zr[1]; v1 = a1 * zr[0] + a2 * v3; v2 = zr[1] + a2 * zr[0] + a3 * v3;
      zr[0] = 2 * v1 - zr[0]; zr[1] = 2 * v2 - zr[1]; r = v2;
    }
    this.tailL *= 1 - this.transitionPole; this.tailR *= 1 - this.transitionPole;
    this.L = safe(L + (safe(l) - L) * this.mix + this.tailL); this.R = safe(R + (safe(r) - R) * this.mix + this.tailR);
    this.deltaL = this.L - L; this.deltaR = this.R - R;
    if (++this.pos === this.size) this.pos = 0;
  }
}

/** Four preallocated stereo processors. Sidechain is a linear peak/RMS level
 * supplied by the host. processSample and meter return owned, reused objects. */
export class TrackEffects {
  constructor(sampleRate = 48000) {
    this.sampleRate = clamp(Number.isFinite(sampleRate) ? sampleRate : 48000, 8000, 192000);
    this.slots = Array.from({ length: 4 }, (_, i) => new EffectSlot(this.sampleRate, i));
    this.out = { L: 0, R: 0 };
    this.meters = { peak: 0, rms: 0, sidechain: 0, reduction: 1 };
    this.routing = 0; this.active = false; this.allDry = true; this.splitL = 0; this.splitR = 0; this.energy = 0;
    this.routeFade = 0; this.routeTailL = 0; this.routeTailR = 0; this.inputL = 0; this.inputR = 0;
    this.splitPole = pole(800, this.sampleRate); this.meterPole = timePole(.1, this.sampleRate);
    this.configure(defaultTrackFx());
  }
  configure(fx) {
    const next = clamp(Number.isFinite(fx?.routing) ? Math.round(fx.routing) : 0, 0, FX_ROUTINGS.length - 1);
    if (next !== this.routing) { this.splitL = 0; this.splitR = 0; this.routeFade = 1; this.routeTailL = this.out.L - this.inputL; this.routeTailR = this.out.R - this.inputR; }
    this.routing = next; this.active = false; this.allDry = true;
    for (let i = 0; i < 4; i++) { this.slots[i].configure(fx?.slots?.[i]); this.active ||= this.slots[i].type !== 0 || Math.abs(this.slots[i].tailL) + Math.abs(this.slots[i].tailR) > 1e-12; this.allDry &&= this.slots[i].mixTarget === 0; }
  }
  reset() {
    for (let i = 0; i < 4; i++) this.slots[i].reset();
    this.splitL = 0; this.splitR = 0; this.energy = 0;
    this.meters.peak = 0; this.meters.rms = 0; this.meters.sidechain = 0; this.meters.reduction = 1;
    this.out.L = 0; this.out.R = 0;
    this.routeFade = 0; this.routeTailL = 0; this.routeTailR = 0; this.inputL = 0; this.inputR = 0;
  }
  meter() { return this.meters; }
  /** Host tempo (BPM) and, while the transport plays, the beat position at
   * the next sample (otherwise NaN): tempo-synced effects follow the song
   * grid when it runs and keep free-running time at the tempo when it stops. */
  setTransport(bpm, beat = NaN) {
    const tempo = clamp(Number.isFinite(bpm) ? bpm : 120, 20, 400);
    for (let i = 0; i < 4; i++) {
      const slot = this.slots[i];
      if (slot.tempo !== tempo) { slot.tempo = tempo; slot.stepRate = tempo / 15 / this.sampleRate; slot.control = 0; }
      if (Number.isFinite(beat)) { const sixteenths = beat * 4; slot.seqPos = sixteenths - Math.floor(sixteenths / 8) * 8; }
    }
  }
  processSample(left, right, sidechain = 0) {
    const L = finite(left), R = finite(right), sc = Math.max(0, finite(sidechain)), s = this.slots;
    let l = L, r = R, aL, aR, bL, bR;
    const dry = this.allDry && s[0].mix < 1e-12 && s[1].mix < 1e-12 && s[2].mix < 1e-12 && s[3].mix < 1e-12 && Math.abs(s[0].tailL) + Math.abs(s[0].tailR) + Math.abs(s[1].tailL) + Math.abs(s[1].tailR) + Math.abs(s[2].tailL) + Math.abs(s[2].tailR) + Math.abs(s[3].tailL) + Math.abs(s[3].tailR) < 1e-12;
    if (this.active && !dry) {
      switch (this.routing) {
        case 1:
          l = 0; r = 0; for (let i = 0; i < 4; i++) { s[i].process(L, R, sc); l += s[i].L * .25; r += s[i].R * .25; } break;
        case 2:
          s[0].process(L, R, sc); s[1].process(s[0].L, s[0].R, sc); aL = s[1].L; aR = s[1].R;
          s[2].process(L, R, sc); s[3].process(s[2].L, s[2].R, sc); l = (aL + s[3].L) * .5; r = (aR + s[3].R) * .5; break;
        case 3:
          s[0].process(L, R, sc); aL = s[0].L; aR = s[0].R; s[1].process(aL, aR, sc); s[2].process(aL, aR, sc);
          s[3].process((s[1].L + s[2].L) * .5, (s[1].R + s[2].R) * .5, sc); l = s[3].L; r = s[3].R; break;
        case 4:
          s[0].process(L, R, sc); s[1].process(L, R, sc); s[2].process((s[0].L + s[1].L) * .5, (s[0].R + s[1].R) * .5, sc);
          s[3].process(s[2].L, s[2].R, sc); l = s[3].L; r = s[3].R; break;
        case 5:
          s[0].process(L, R, sc); aL = s[0].L; aR = s[0].R; l = 0; r = 0;
          for (let i = 1; i < 4; i++) { s[i].process(aL, aR, sc); l += s[i].L / 3; r += s[i].R / 3; } break;
        case 6:
          aL = 0; aR = 0; for (let i = 0; i < 3; i++) { s[i].process(L, R, sc); aL += s[i].L / 3; aR += s[i].R / 3; }
          s[3].process(aL, aR, sc); l = s[3].L; r = s[3].R; break;
        case 7:
          aL = (L + R) * .5; bL = (L - R) * .5; s[0].process(aL, aL, sc); s[1].process(s[0].L, s[0].R, sc);
          s[2].process(bL, bL, sc); s[3].process(s[2].L, s[2].R, sc); aL = (s[1].L + s[1].R) * .5; bL = (s[3].L + s[3].R) * .5; l = aL + bL; r = aL - bL; break;
        case 8:
          this.splitL += this.splitPole * (L - this.splitL); this.splitR += this.splitPole * (R - this.splitR);
          s[0].process(this.splitL, this.splitR, sc); s[1].process(s[0].L, s[0].R, sc); aL = s[1].L; aR = s[1].R;
          s[2].process(L - this.splitL, R - this.splitR, sc); s[3].process(s[2].L, s[2].R, sc); l = aL + s[3].L; r = aR + s[3].R; break;
        case 9:
          s[0].process(L, L, sc); s[1].process(s[0].L, s[0].R, sc); aL = (s[1].L + s[1].R) * .5;
          s[2].process(R, R, sc); s[3].process(s[2].L, s[2].R, sc); l = aL; r = (s[3].L + s[3].R) * .5; break;
        default:
          for (let i = 0; i < 4; i++) { s[i].process(l, r, sc); l = s[i].L; r = s[i].R; }
      }
      l = safe(l); r = safe(r);
    }
    if (this.routeFade > 1e-12 && !dry) {
      l = L + (l - L) * (1 - this.routeFade) + this.routeTailL * this.routeFade; r = R + (r - R) * (1 - this.routeFade) + this.routeTailR * this.routeFade;
      this.routeFade *= 1 - s[0].transitionPole;
    }
    this.inputL = L; this.inputR = R;
    this.out.L = l; this.out.R = r;
    const peak = Math.max(Math.abs(l), Math.abs(r)); this.meters.peak = Math.max(peak, this.meters.peak * .9995);
    this.energy += this.meterPole * ((l * l + r * r) * .5 - this.energy); this.meters.rms = Math.sqrt(Math.max(0, this.energy));
    this.meters.sidechain += this.meterPole * (sc - this.meters.sidechain);
    this.meters.reduction = dry ? 1 : Math.min(s[0].reduction, s[1].reduction, s[2].reduction, s[3].reduction);
    return this.out;
  }
}
