// Operator panel DSP (v2.9): drop and water damage, the Glitch and Slowdown
// quirks, the Vintage sampler stage and the Service test tones, applied to
// the synth's master mix inside the DSP (so bounces include it).
//
// Nothing here runs unless a switch is on or a test tone plays: OroDSP only
// creates a MasterOperator once a session turns something on, and process()
// returns at once while every effect has settled, so the output is
// bit-identical to a build without it. Randomness comes from a seeded
// xorshift generator, so the same actions on the same input always give the
// same output. process() never allocates.
//
// Drop damage: `dmg` (0..1) builds up with every drop and stays until Repair;
// `shock` is the extra rattle right after a hit and settles in a few seconds.
// Water damage: `wet` (0..1) builds up with every spill and dries out over a
// few minutes unless Stays wet is on.

export const SERVICE_TONES = ['off', 'sine', 'pink', 'left', 'right', 'polarity'];
export const OPERATOR_ACTIONS = ['drop', 'spill', 'repair', 'tone'];

export const OPERATOR_DEFAULTS = Object.freeze({
  drop: 0, dropSeverity: 0.5, realDrops: 0,
  water: 0, waterSeverity: 0.5, staysWet: 0, hum: 50,
  glitch: 0, glitchAmount: 0.5,
  slowdown: 0, slowAmount: 0.5,
  vintage: 0, visual: 1,
  // v2.9 coin slot and kill screen (src/ui/coin-slot.js, src/music/kill-screen.js):
  // note-path switches, the DSP ignores them
  freePlay: 1, killScreen: 0,
});
const BOOLS = ['drop', 'realDrops', 'water', 'staysWet', 'glitch', 'slowdown', 'vintage', 'visual', 'freePlay', 'killScreen'];
/** Drop damage at or above this makes a spill short the circuits (a brief crackle). */
export const SHORT_CIRCUIT_DMG = 0.6;
const AMOUNTS = ['dropSeverity', 'waterSeverity', 'glitchAmount', 'slowAmount'];
/** The switches that change the sound (Real drops and the screen hint do not). */
export const OPERATOR_SWITCHES = ['drop', 'water', 'glitch', 'slowdown', 'vintage'];

/**
 * A saved `operator` object -> its clean form, or null when every setting is
 * at its default (the session then saves without the key).
 */
export function sanitizeOperator(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  let custom = false;
  for (const k of BOOLS) {
    const v = src[k];
    const b = typeof v === 'number' ? (v ? 1 : 0) : typeof v === 'boolean' ? (v ? 1 : 0) : OPERATOR_DEFAULTS[k];
    out[k] = b;
    if (b !== OPERATOR_DEFAULTS[k]) custom = true;
  }
  for (const k of AMOUNTS) {
    const v = src[k];
    const a = typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : OPERATOR_DEFAULTS[k];
    out[k] = a;
    if (a !== OPERATOR_DEFAULTS[k]) custom = true;
  }
  out.hum = src.hum === 60 ? 60 : 50;
  if (out.hum !== OPERATOR_DEFAULTS.hum) custom = true;
  return custom ? out : null;
}

/** True when a (sanitized or raw) operator object changes the sound. */
export function operatorSounds(cfg) {
  return !!cfg && OPERATOR_SWITCHES.some(k => cfg[k] === 1 || cfg[k] === true);
}

const TAU = Math.PI * 2;
const CTL = 32;                 // control step (samples)
const DETUNE_CENTS = 45;        // pitch offset at full drop damage
const WOBBLE_CENTS = 10;        // slow wobble depth at full drop damage
const SLOW_CENTS = 70;          // Slowdown sag at full load and amount
const HUM_LEVEL = 0.012;        // hum peak at full wetness (about -38 dBFS)
const DRY_TAU = 70;             // seconds: drying, exponential part
const DRY_FLOOR = 600;          // seconds: drying, linear part (so it reaches zero)
const TONE_SINE = 0.12589;      // -18 dBFS peak
const TONE_PINK = 0.1;          // pink noise scale (about -20 dBFS RMS)
const PULSE_PEAK = 0.25;        // polarity pulse peak (-12 dBFS), positive going
const VINTAGE_RATE = 26040;     // Hz, sample and hold rate of the Vintage stage
const VINTAGE_LEVELS = 2048;    // 12-bit signed
const ARC_SEC = 0.25;           // short circuit crackle length
const ARC_LEVEL = 0.06;         // its loudest spark (about -24 dBFS)

const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
const onePole = (fc, sr) => 1 - Math.exp(-TAU * Math.min(fc, sr * 0.45) / sr);
const smooth = (sec, sr) => 1 - Math.exp(-1 / (sec * sr));
const decay = (sec, sr) => Math.exp(-1 / (sec * sr));
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);

export class MasterOperator {
  constructor(sr = 48000) {
    const s = this.sr = sr > 0 ? sr : 48000;
    this.cfg = { ...OPERATOR_DEFAULTS };
    this.seed = 0x6d2b79f5;
    this.idle = true;
    this.fresh = 0;               // samples processed since the last wake-up
    this.ctl = 0;
    this.voices = 0;
    this.stats = { drops: 0, spills: 0, clicks: 0, cutouts: 0, dropouts: 0, scratches: 0, shorts: 0, bitErrors: 0, stutters: 0, arcs: 0 };

    // constants
    this.kGain = smooth(0.0015, s); this.kMix = smooth(0.03, s); this.kTone = smooth(0.01, s); this.kHum = smooth(0.2, s);
    this.thudK = decay(0.12, s); this.rattleK = decay(0.22, s); this.clickK = decay(0.0005, s); this.splashK = decay(0.6, s);
    this.shockK = Math.exp(-CTL / (3 * s));
    this.thudGlide = decay(0.05, s);

    // drop damage
    this.dmg = 0; this.shock = 0; this.dir = 1; this.drops = 0;
    this.thud = 0; this.thudPh = 0; this.thudHz = 0; this.rattle = 0;
    this.clickL = 0; this.clickR = 0;
    this.cutLeft = 0; this.dropLeft = 0; this.dropSide = 0;
    this.potLeft = 0; this.potT = 0; this.potMix = 0; this.potA = 1; this.potGain = 1; this.potL = 0; this.potR = 0;
    // water damage
    this.wet = 0; this.splash = 0; this.splashPrev = 0;
    this.mixT = 0; this.mix = 0; this.mA = 1; this.m1L = 0; this.m2L = 0; this.m1R = 0; this.m2R = 0;
    this.fizz = 0; this.fizzWalk = 0.5;
    this.humT = 0; this.humAmp = 0; this.humPh = 0;
    this.shortLeft = 0;
    this.arcLeft = 0; this.arcLen = Math.round(ARC_SEC * s); this.arcAmp = 0; this.arcK = decay(0.002, s);
    this.biteLeft = 0; this.biteHold = 4; this.biteCnt = 0; this.biteLev = 16; this.bhL = 0; this.bhR = 0;
    // channel gains (cutouts, dropouts, short-outs)
    this.gL = 1; this.gR = 1; this.tgL = 1; this.tgR = 1;
    // pitch shifter (drop detune, Slowdown)
    this.shN = pow2(Math.ceil(s * 0.1));
    this.shBufL = new Float32Array(this.shN); this.shBufR = new Float32Array(this.shN);
    this.shW = Math.round(s * 0.04);
    this.shPos = 0; this.shPh = 0; this.shDp = 0; this.shT = 0; this.shMix = 0;
    this.cents = 0; this.wobPh = 0; this.sag = 0;
    // glitch
    this.gN = pow2(Math.ceil(s * 0.3));
    this.gBufL = new Float32Array(this.gN); this.gBufR = new Float32Array(this.gN);
    this.gPos = 0; this.stLeft = 0; this.stLen = 1; this.stIdx = 0; this.stDone = 0; this.stStart = 0;
    // vintage
    this.vInc = Math.min(1, VINTAGE_RATE / s); this.vPh = 0;
    this.vA1 = onePole(9500, s); this.vA2 = onePole(11000, s);
    this.v1L = 0; this.v2L = 0; this.v1R = 0; this.v2R = 0; this.vhL = 0; this.vhR = 0;
    this.o1L = 0; this.o2L = 0; this.o1R = 0; this.o2R = 0;
    // service tones
    this.toneMode = 0; this.toneT = 0; this.toneGain = 0; this.tonePh = 0; this.toneInc = TAU * 1000 / s;
    this.pk0 = 0; this.pk1 = 0; this.pk2 = 0;
    this.pulseN = Math.round(s * 0.5); this.pulseLen = Math.max(4, Math.round(s * 0.001)); this.pulseCnt = 0;
  }

  /** xorshift32 in [0, 1). */
  rnd() {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  configure(cfg) {
    this.cfg = { ...(sanitizeOperator(cfg) || OPERATOR_DEFAULTS) };
  }

  /** 'drop' | 'spill' (v = strength 0..1), 'repair' (v = 'drop' | 'water' | 'all'), 'tone' (v = a SERVICE_TONES name). */
  action(a, v) {
    const c = this.cfg, sr = this.sr;
    if (a === 'drop') {
      if (c.drop !== 1) return false;
      const s = clamp01(typeof v === 'number' && Number.isFinite(v) ? v : 1) * c.dropSeverity;
      if (s <= 0) return false;
      if (this.drops === 0 && this.dmg === 0) this.dir = this.rnd() < 0.5 ? -1 : 1;
      this.drops++;
      this.stats.drops++;
      this.dmg = Math.min(1, this.dmg + 0.5 * s);
      this.shock = Math.min(1, this.shock + s);
      this.thud = Math.min(0.6, this.thud + 0.6 * Math.sqrt(s));
      this.thudHz = 95; this.thudPh = 0;
      this.rattle = Math.min(0.4, this.rattle + 0.3 * s);
      this.cutLeft = Math.max(this.cutLeft, Math.round((0.02 + 0.06 * s) * sr));
      return true;
    }
    if (a === 'spill') {
      if (c.water !== 1) return false;
      const s = clamp01(typeof v === 'number' && Number.isFinite(v) ? v : 1) * c.waterSeverity;
      if (s <= 0) return false;
      this.stats.spills++;
      this.wet = Math.min(1, this.wet + 0.6 * s);
      this.splash = Math.min(0.3, this.splash + 0.15 * s);
      this.shortLeft = Math.max(this.shortLeft, Math.round(0.03 * sr));
      // Water on a badly dropped synth: a brief electrical short crackle
      if (c.drop === 1 && this.dmg >= SHORT_CIRCUIT_DMG) { this.arcLeft = this.arcLen; this.stats.arcs++; }
      return true;
    }
    if (a === 'repair') {
      if (v !== 'water') {
        this.dmg = 0; this.shock = 0; this.drops = 0; this.rattle = 0;
        this.cutLeft = 0; this.dropLeft = 0; this.potLeft = 0;
      }
      if (v !== 'drop') {
        this.wet = 0; this.splash = 0; this.shortLeft = 0; this.biteLeft = 0; this.arcLeft = 0; this.arcAmp = 0;
      }
      return true;
    }
    if (a === 'tone') {
      const i = SERVICE_TONES.indexOf(v);
      if (i < 0) return false;
      this.toneT = i > 0 ? 1 : 0;
      if (i > 0) { if (this.toneGain === 0) { this.tonePh = 0; this.pulseCnt = 0; } this.toneMode = i; }
      return true;
    }
    return false;
  }

  /** Restores the amounts a rebuilt DSP or a bounce starts from. */
  setState(st) {
    if (!st || typeof st !== 'object') return;
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : 0);
    this.dmg = n(st.dmg); this.wet = n(st.wet); this.shock = n(st.shock);
    if (st.dir === -1 || st.dir === 1) this.dir = st.dir;
    if (this.dmg > 0) this.drops = Math.max(1, this.drops);
  }

  telemetry() {
    return { dmg: this.dmg, wet: this.wet, shock: this.shock, cents: this.cents, dir: this.dir, tone: this.toneT ? SERVICE_TONES[this.toneMode] : 'off' };
  }

  /** Whether process() has anything to do (false: the output passes untouched). */
  needs() {
    const c = this.cfg;
    return this.toneT !== 0 || this.toneGain !== 0 || c.vintage === 1 || c.glitch === 1 || c.slowdown === 1
      || (c.drop === 1 && (this.dmg > 0 || this.shock > 0))
      || (c.water === 1 && (this.wet > 0 || this.splash > 0))
      || this.thud !== 0 || this.rattle !== 0 || this.clickL !== 0 || this.clickR !== 0
      || this.gL !== 1 || this.gR !== 1 || this.cutLeft > 0 || this.shortLeft > 0 || this.arcLeft > 0
      || this.potMix !== 0 || this.mix !== 0 || this.shMix !== 0 || this.humAmp !== 0 || this.stLeft > 0 || this.splash !== 0;
  }

  /** Coming back from bypass: forget stale filter state. */
  wake() {
    this.fresh = 0; this.ctl = 0;
    this.potL = this.potR = 0;
    this.m1L = this.m2L = this.m1R = this.m2R = 0;
    this.v1L = this.v2L = this.v1R = this.v2R = this.vhL = this.vhR = 0;
    this.o1L = this.o2L = this.o1R = this.o2R = 0;
    this.stLeft = 0;
  }

  /** Once per CTL samples: amounts, random events and smoothing targets. */
  control() {
    const c = this.cfg, sr = this.sr, dt = CTL / sr;
    const dropOn = c.drop === 1, waterOn = c.water === 1;
    if (this.shock > 0) { this.shock *= this.shockK; if (this.shock < 1e-4) this.shock = 0; }
    const e = dropOn ? Math.min(1, this.dmg + 0.6 * this.shock) : 0;
    if (e > 0) {
      // loose connection: crackle
      if (this.rnd() < e * e * 25 * dt) {
        const a = (0.03 + 0.25 * this.rnd()) * e * (this.rnd() < 0.5 ? -1 : 1);
        const side = this.rnd();
        this.clickL += side < 0.7 ? a : a * 0.2; this.clickR += side > 0.3 ? a : a * 0.2;
        this.stats.clicks++;
      }
      // brief cutouts
      if (this.cutLeft <= 0 && this.rnd() < e * 0.5 * dt) {
        const r = this.rnd();
        this.cutLeft = Math.round((0.015 + 0.135 * r * r) * sr);
        this.stats.cutouts++;
      }
      // one side cuts in and out
      if (this.dropLeft <= 0 && this.dmg > 0.1 && this.rnd() < this.dmg * 0.15 * dt) {
        this.dropLeft = Math.round((0.2 + 1.6 * this.rnd()) * sr);
        this.dropSide = this.rnd() < 0.5 ? 0 : 1;
        this.stats.dropouts++;
      }
      // scratchy pot
      if (this.potLeft <= 0 && this.rnd() < e * 0.35 * dt) {
        this.potLeft = Math.round((0.08 + 0.3 * this.rnd()) * sr);
        this.stats.scratches++;
      }
    }
    if (this.potLeft > 0) {
      this.potLeft -= CTL;
      this.potT = 1;
      if (this.rnd() < 0.25) { this.potA = onePole(1200 + 6000 * this.rnd(), sr); this.potGain = 0.75 + 0.25 * this.rnd(); }
    } else { this.potT = 0; this.potGain = 1; }
    if (this.cutLeft > 0) this.cutLeft -= CTL;
    if (this.dropLeft > 0) this.dropLeft -= CTL;

    // water
    if (waterOn && this.wet > 0 && c.staysWet !== 1) {
      this.wet -= dt * (this.wet / DRY_TAU + 1 / DRY_FLOOR);
      if (this.wet < 1e-4) this.wet = 0;
    }
    const w = waterOn ? this.wet : 0;
    this.mixT = w > 0 ? Math.min(1, w * 6) : 0;
    this.mA = onePole(18000 * Math.pow(0.04, w), sr);
    this.fizzWalk = clamp01(this.fizzWalk + (this.rnd() - 0.5) * 0.15);
    this.fizz = w * 0.004 * (0.3 + 0.7 * this.fizzWalk);
    this.humT = w * HUM_LEVEL;
    if (w > 0) {
      // corroded contacts: small pops
      if (this.rnd() < w * 12 * dt) {
        const a = (0.01 + 0.05 * this.rnd()) * w * (this.rnd() < 0.5 ? -1 : 1);
        this.clickL += a; this.clickR += a * (0.5 + 0.5 * this.rnd());
        this.stats.clicks++;
      }
      // short-outs
      if (this.shortLeft <= 0 && this.rnd() < w * 0.45 * dt) {
        this.shortLeft = Math.round((0.005 + 0.035 * this.rnd()) * sr);
        this.clickL += 0.08 * w; this.clickR += 0.08 * w;
        this.stats.shorts++;
      }
      // rare bit errors
      if (this.biteLeft <= 0 && this.rnd() < w * w * 0.2 * dt) {
        this.biteLeft = Math.round((0.03 + 0.12 * this.rnd()) * sr);
        this.biteHold = 2 + Math.floor(this.rnd() * 10);
        this.biteLev = 1 << (3 + Math.floor(this.rnd() * 3));
        this.biteCnt = 0;
        this.stats.bitErrors++;
      }
    }
    if (this.shortLeft > 0) this.shortLeft -= CTL;
    if (this.biteLeft > 0) this.biteLeft -= CTL;

    // channel gain targets
    const all = this.cutLeft > 0 || this.shortLeft > 0;
    this.tgL = all || (this.dropLeft > 0 && this.dropSide === 0) ? 0 : 1;
    this.tgR = all || (this.dropLeft > 0 && this.dropSide === 1) ? 0 : 1;

    // pitch: detune and wobble from drops, sag from Slowdown
    let cents = 0;
    if (dropOn && this.dmg > 0) {
      this.wobPh += TAU * 0.31 * dt;
      if (this.wobPh > TAU * 100) this.wobPh -= TAU * 100;
      cents = this.dmg * (DETUNE_CENTS * this.dir + WOBBLE_CENTS * (0.7 * Math.sin(this.wobPh) + 0.3 * Math.sin(2.71 * this.wobPh)));
    }
    if (c.slowdown === 1) {
      const target = clamp01((this.voices - 3) / 9) * c.slowAmount;
      this.sag += (target - this.sag) * (1 - Math.exp(-dt / (target > this.sag ? 0.5 : 1.5)));
    } else this.sag *= Math.exp(-dt / 0.3);
    if (this.sag < 1e-4) this.sag = 0;
    cents -= this.sag * SLOW_CENTS;
    this.cents = cents;
    this.shT = (cents > 0.02 || cents < -0.02) && this.fresh >= this.shN ? 1 : 0;
    this.shDp = (1 - Math.pow(2, cents / 1200)) / this.shW;

    // glitch: start a stutter now and then
    if (c.glitch === 1 && this.stLeft <= 0 && this.fresh >= this.gN && this.rnd() < (0.04 + 0.3 * c.glitchAmount) * dt) {
      this.stLen = Math.round((0.025 + 0.1 * this.rnd()) * sr);
      const reps = 2 + Math.floor(this.rnd() * (2 + 5 * c.glitchAmount));
      this.stLeft = this.stLen * reps; this.stIdx = 0; this.stDone = 0;
      this.stStart = (this.gPos - this.stLen) & (this.gN - 1);
      this.stats.stutters++;
    }
  }

  /**
   * Processes the master mix in place. `voices`: sounding voices (Slowdown);
   * the optional send buses get the same cutouts as the mix.
   */
  process(L, R, n, voices = 0, s1L = null, s1R = null, s2L = null, s2R = null, s3L = null, s3R = null) {
    if (!this.needs()) { this.idle = true; return false; }
    if (this.idle) { this.idle = false; this.wake(); }
    this.voices = voices;
    const c = this.cfg;
    const waterOn = c.water === 1, glitchOn = c.glitch === 1, vintageOn = c.vintage === 1;
    const shN = this.shN, shMask = shN - 1, shW = this.shW, shBL = this.shBufL, shBR = this.shBufR;
    const gMask = this.gN - 1, gBL = this.gBufL, gBR = this.gBufR;
    for (let i = 0; i < n; i++) {
      if (--this.ctl < 0) { this.ctl = CTL - 1; this.control(); }
      let x = L[i], y = R[i];

      // 1. pitch shifter (two crossfaded taps of a moving delay)
      const sp = this.shPos;
      shBL[sp] = x; shBR[sp] = y;
      if (this.shT !== 0 || this.shMix !== 0) {
        let m = this.shMix + (this.shT - this.shMix) * this.kMix;
        if (m < 1e-6 && this.shT === 0) m = 0; else if (m > 1 - 1e-9) m = 1;
        this.shMix = m;
        let p = this.shPh + this.shDp;
        if (p >= 1) p -= 1; else if (p < 0) p += 1;
        this.shPh = p;
        let p2 = p + 0.5; if (p2 >= 1) p2 -= 1;
        const g1 = 1 - Math.abs(2 * p - 1), g2 = 1 - Math.abs(2 * p2 - 1);
        const r1 = sp - 4 - p * shW, r2 = sp - 4 - p2 * shW;
        const i1 = Math.floor(r1), f1 = r1 - i1, i2 = Math.floor(r2), f2 = r2 - i2;
        const a1 = i1 & shMask, b1 = (i1 + 1) & shMask, a2 = i2 & shMask, b2 = (i2 + 1) & shMask;
        const sx = g1 * (shBL[a1] + (shBL[b1] - shBL[a1]) * f1) + g2 * (shBL[a2] + (shBL[b2] - shBL[a2]) * f2);
        const sy = g1 * (shBR[a1] + (shBR[b1] - shBR[a1]) * f1) + g2 * (shBR[a2] + (shBR[b2] - shBR[a2]) * f2);
        x += m * (sx - x); y += m * (sy - y);
      }
      this.shPos = (sp + 1) & shMask;

      // 2. service tones (after the shifter: a test tone stays in tune)
      if (this.toneT !== 0 || this.toneGain !== 0) {
        let g = this.toneGain + (this.toneT - this.toneGain) * this.kTone;
        if (this.toneT === 0 && g < 1e-6) g = 0; else if (g > 1 - 1e-9) g = 1;
        this.toneGain = g;
        const mode = this.toneMode;
        let tl = 0, tr = 0;
        if (mode === 1) {
          tl = tr = TONE_SINE * Math.sin(this.tonePh);
          this.tonePh += this.toneInc; if (this.tonePh > TAU) this.tonePh -= TAU;
        } else if (mode === 5) {
          const k = this.pulseCnt;
          if (k < this.pulseLen) tl = tr = PULSE_PEAK * Math.sin(Math.PI * (k + 0.5) / this.pulseLen);
          this.pulseCnt = k + 1 >= this.pulseN ? 0 : k + 1;
        } else if (mode >= 2) {
          const wn = this.rnd() * 2 - 1;
          this.pk0 = 0.99765 * this.pk0 + wn * 0.099046;
          this.pk1 = 0.963 * this.pk1 + wn * 0.2965164;
          this.pk2 = 0.57 * this.pk2 + wn * 1.0526913;
          const pk = TONE_PINK * (this.pk0 + this.pk1 + this.pk2 + wn * 0.1848) * 0.61;
          if (mode !== 4) tl = pk;
          if (mode !== 3) tr = pk;
        }
        x += g * tl; y += g * tr;
      }

      // 3. scratchy pot: a lowpass whose cutoff jumps while it scratches
      if (this.potT !== 0 || this.potMix !== 0) {
        let m = this.potMix + (this.potT - this.potMix) * this.kMix;
        if (this.potT === 0 && m < 1e-6) m = 0;
        this.potMix = m;
        this.potL += this.potA * (x - this.potL); this.potR += this.potA * (y - this.potR);
        const pg = 1 + (this.potGain - 1) * m;
        x = (x + m * (this.potL - x)) * pg; y = (y + m * (this.potR - y)) * pg;
      }

      // 4. water: muffled tone, then bit errors
      if (this.mixT !== 0 || this.mix !== 0) {
        let m = this.mix + (this.mixT - this.mix) * this.kMix;
        if (this.mixT === 0 && m < 1e-6) m = 0;
        this.mix = m;
        const a = this.mA;
        this.m1L += a * (x - this.m1L); this.m2L += a * (this.m1L - this.m2L);
        this.m1R += a * (y - this.m1R); this.m2R += a * (this.m1R - this.m2R);
        x += m * (this.m2L - x); y += m * (this.m2R - y);
      }
      if (this.biteLeft > 0) {
        if (--this.biteCnt <= 0) {
          this.biteCnt = this.biteHold;
          this.bhL = Math.round(x * this.biteLev) / this.biteLev; this.bhR = Math.round(y * this.biteLev) / this.biteLev;
        }
        x = this.bhL; y = this.bhR;
      }

      // 5. cutouts, one-sided dropouts and short-outs (the sends follow)
      if (this.gL !== 1 || this.gR !== 1 || this.tgL !== 1 || this.tgR !== 1) {
        let gl = this.gL + (this.tgL - this.gL) * this.kGain, gr = this.gR + (this.tgR - this.gR) * this.kGain;
        if (gl > 1 - 1e-6 && this.tgL === 1) gl = 1; else if (gl < 1e-9 && this.tgL === 0) gl = 0;
        if (gr > 1 - 1e-6 && this.tgR === 1) gr = 1; else if (gr < 1e-9 && this.tgR === 0) gr = 0;
        this.gL = gl; this.gR = gr;
        x *= gl; y *= gr;
        if (s1L !== null) { s1L[i] *= gl; s1R[i] *= gr; }
        if (s2L !== null) { s2L[i] *= gl; s2R[i] *= gr; }
        if (s3L !== null) { s3L[i] *= gl; s3R[i] *= gr; }
      }

      // 6. added noises: crackle, the thud and rattle of a drop, fizz, splash, hum
      if (this.clickL !== 0 || this.clickR !== 0) {
        x += this.clickL; y += this.clickR;
        this.clickL *= this.clickK; this.clickR *= this.clickK;
        if (this.clickL < 1e-6 && this.clickL > -1e-6) this.clickL = 0;
        if (this.clickR < 1e-6 && this.clickR > -1e-6) this.clickR = 0;
      }
      if (this.thud !== 0) {
        this.thudHz = 45 + (this.thudHz - 45) * this.thudGlide;
        this.thudPh += TAU * this.thudHz / this.sr;
        const t = this.thud * Math.sin(this.thudPh);
        x += t; y += t;
        this.thud *= this.thudK;
        if (this.thud < 1e-5) this.thud = 0;
      }
      if (this.rattle !== 0) {
        const r = this.rnd();
        const k = r < 0.06 ? (r * 33 - 1) : 0;
        x += this.rattle * k; y += this.rattle * k * 0.8;
        this.rattle *= this.rattleK;
        if (this.rattle < 1e-5) this.rattle = 0;
      }
      if (this.arcLeft > 0) {
        // sparse sparks that fade over the short circuit
        if (this.rnd() < 0.015) this.arcAmp = ARC_LEVEL * (0.4 + 0.6 * this.rnd()) * (0.25 + 0.75 * this.arcLeft / this.arcLen);
        const k = this.arcAmp * (this.rnd() * 2 - 1);
        x += k; y += k * 0.7;
        this.arcAmp *= this.arcK;
        if (--this.arcLeft === 0) this.arcAmp = 0;
      }
      if (waterOn && this.fizz > 0) {
        x += this.fizz * (this.rnd() * 2 - 1); y += this.fizz * (this.rnd() * 2 - 1);
      }
      if (this.splash !== 0) {
        const wn = this.rnd() * 2 - 1;
        const hp = (wn - this.splashPrev) * this.splash * 0.5;
        this.splashPrev = wn;
        x += hp; y += hp;
        this.splash *= this.splashK;
        if (this.splash < 1e-5) this.splash = 0;
      }
      if (this.humT !== 0 || this.humAmp !== 0) {
        let h = this.humAmp + (this.humT - this.humAmp) * this.kHum;
        if (this.humT === 0 && h < 1e-6) h = 0;
        this.humAmp = h;
        this.humPh += TAU * c.hum / this.sr;
        if (this.humPh > TAU) this.humPh -= TAU;
        const s = Math.sin(this.humPh), co = Math.cos(this.humPh);
        const s2 = 2 * s * co, c2 = 1 - 2 * s * s;
        const s3 = s * c2 + co * s2, c3 = co * c2 - s * s2;
        const s5 = s3 * c2 + c3 * s2;
        const hum = h * (s + 0.5 * s2 + 0.35 * s3 + 0.12 * s5);
        x += hum; y += hum;
      }

      // 7. glitch: repeat a short slice of what just played
      if (glitchOn || this.stLeft > 0) {
        if (this.stLeft > 0) {
          const j = (this.stStart + this.stIdx) & gMask;
          const k = this.stIdx;
          const w = Math.min(1, k / 64, (this.stLen - k) / 64);
          const E = Math.min(1, this.stDone / 64, this.stLeft / 64);
          x = x * (1 - E) + gBL[j] * w * E; y = y * (1 - E) + gBR[j] * w * E;
          this.stIdx = k + 1 >= this.stLen ? 0 : k + 1;
          this.stLeft--; this.stDone++;
        } else {
          gBL[this.gPos] = x; gBR[this.gPos] = y;
          this.gPos = (this.gPos + 1) & gMask;
        }
      }

      // 8. vintage: about 26 kHz sample and hold, 12 bits, gentle filters each side
      if (vintageOn) {
        const a1 = this.vA1, a2 = this.vA2;
        this.v1L += a1 * (x - this.v1L); this.v2L += a1 * (this.v1L - this.v2L);
        this.v1R += a1 * (y - this.v1R); this.v2R += a1 * (this.v1R - this.v2R);
        this.vPh += this.vInc;
        if (this.vPh >= 1) {
          this.vPh -= 1;
          this.vhL = Math.round(this.v2L * VINTAGE_LEVELS) / VINTAGE_LEVELS;
          this.vhR = Math.round(this.v2R * VINTAGE_LEVELS) / VINTAGE_LEVELS;
        }
        this.o1L += a2 * (this.vhL - this.o1L); this.o2L += a2 * (this.o1L - this.o2L);
        this.o1R += a2 * (this.vhR - this.o1R); this.o2R += a2 * (this.o1R - this.o2R);
        x = this.o2L; y = this.o2R;
      }

      L[i] = x; R[i] = y;
    }
    if (this.fresh < 1e9) this.fresh += n;
    return true;
  }
}
