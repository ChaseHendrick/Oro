// v2.8 send effects: two shared return buses that run once for the whole mix.
//
//   Send A: a reverb (pre-delay line, then the eight-line feedback delay
//           network of the track rack's Reverb) with Size, Decay, Damping,
//           Pre-delay and a Return level.
//   Send B: a delay (the track rack's Ping-pong delay, or its Stereo delay
//           when Ping-pong is off) with a time synced to a note value at the
//           tempo or set in milliseconds, Feedback, Tone and a Return level.
//
// Every track has a post-fader Send A and Send B amount (parts.N.params.sendA
// / sendB, default 0). OroDSP sums the sends into two stereo bus inputs and
// calls process() once per render call; the returns are added to the dry mix,
// so they go through the master chain and into recordings and bounces like
// any track. A bus that nobody sends to and that has fallen silent goes back
// to sleep (and its lines are cleared), so with every send at 0 none of this
// runs at all and the output is bit-identical to a session without sends.

import { EffectSlot } from './track-effects.js';
import { DELAY_DIVS } from '../core/params.js';

/** Silence, in and out, before a bus stops running (longer than the longest delay and pre-delay). */
export const SEND_IDLE_SECONDS = 2.5;
/** Output below this (about -120 dBFS) counts as silent. */
export const SEND_SILENT = 1e-6;
export const SEND_MAX_PREDELAY_MS = 250;
/** The delay range of the rack delay this bus reuses. */
export const SEND_DELAY_MIN = 0.02;
export const SEND_DELAY_MAX = 2;
const RETURN_TIME = 0.01;      // one-pole time constant of the return levels (s)
const PREDELAY_TIME = 0.05;    // pre-delay glides over about this long (s), like tape
// Full diffusion keeps the network's scattering energy-preserving, so Decay
// is the real time to fall by 60 dB (before damping takes the highs away).
const REVERB_DIFFUSION = 1;
// The network returns about 13 dB less energy than it is fed; this brings a
// full send and return to roughly 7 dB under the dry sound.
const REVERB_GAIN = 2;

/** The global parameters the buses read (plus tempo). */
export const SEND_GLOBAL_IDS = Object.freeze([
  'sendASize', 'sendADecay', 'sendADamp', 'sendAPredelay', 'sendAReturn',
  'sendBSync', 'sendBDiv', 'sendBTime', 'sendBFeedback', 'sendBTone', 'sendBPingPong', 'sendBReturn',
]);

export const SEND_DEFAULTS = Object.freeze({
  tempo: 112,
  sendASize: 0.55, sendADecay: 2.5, sendADamp: 0.45, sendAPredelay: 20, sendAReturn: 0.8,
  sendBSync: 1, sendBDiv: 3, sendBTime: 375, sendBFeedback: 0.4, sendBTone: 0.6, sendBPingPong: 1, sendBReturn: 0.8,
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Send B delay time in seconds: a note value at the tempo (Sync on) or milliseconds. */
export function sendDelaySeconds(g = {}) {
  const sync = num(g.sendBSync, SEND_DEFAULTS.sendBSync) >= 0.5;
  let s;
  if (sync) {
    const tempo = clamp(num(g.tempo, SEND_DEFAULTS.tempo), 20, 400);
    const div = DELAY_DIVS[clamp(Math.round(num(g.sendBDiv, SEND_DEFAULTS.sendBDiv)), 0, DELAY_DIVS.length - 1)];
    s = div.beats * 60 / tempo;
  } else s = num(g.sendBTime, SEND_DEFAULTS.sendBTime) / 1000;
  return clamp(s, SEND_DELAY_MIN, SEND_DELAY_MAX);
}

/** Rack controls (0..1) for a delay time: the rack maps p to 0.02 * 100^p seconds. */
export function delayTimeControl(seconds) {
  return clamp(Math.log(clamp(seconds, SEND_DELAY_MIN, SEND_DELAY_MAX) / SEND_DELAY_MIN) / Math.log(100), 0, 1);
}

/** Rack Decay control for a decay time: the rack maps p to 0.2 + 11.8 p seconds. */
export function reverbDecayControl(seconds) {
  return clamp((num(seconds, 2.5) - 0.2) / 11.8, 0, 1);
}

export class SendReturns {
  constructor(sampleRate = 48000) {
    const sr = this.sr = sampleRate > 0 ? sampleRate : 48000;
    this.reverb = new EffectSlot(sr, 101);
    this.delay = new EffectSlot(sr, 102);
    this.preSize = Math.ceil(sr * SEND_MAX_PREDELAY_MS / 1000) + 4;
    this.preL = new Float32Array(this.preSize);
    this.preR = new Float32Array(this.preSize);
    this.prePos = 0;
    this.preCur = 0; this.preTarget = 0;
    this.kPre = 1 - Math.exp(-1 / (sr * PREDELAY_TIME));
    this.kRet = 1 - Math.exp(-1 / (sr * RETURN_TIME));
    this.g = { ...SEND_DEFAULTS };
    this.retA = 0; this.retB = 0;       // current return gains
    this.tA = 0; this.tB = 0;           // their targets
    this.activeA = false; this.activeB = false;
    this.quietA = 0; this.quietB = 0;
    this.idleSamples = Math.round(sr * SEND_IDLE_SECONDS);
    this.delaySeconds = sendDelaySeconds(this.g);
    this.configure({});
  }

  /** True while either bus is running (fed or still ringing). */
  get active() { return this.activeA || this.activeB; }

  /** Apply any subset of the send settings (and tempo). */
  configure(p = {}) {
    const g = this.g;
    for (const k in g) if (p[k] !== undefined && Number.isFinite(+p[k])) g[k] = +p[k];
    const pre = clamp(g.sendAPredelay, 0, SEND_MAX_PREDELAY_MS) / 1000 * this.sr;
    this.preTarget = pre;
    if (!this.activeA) this.preCur = pre;
    this.reverb.configure({ type: 'reverb', mix: 1, p1: clamp(g.sendASize, 0, 1), p2: reverbDecayControl(g.sendADecay), p3: clamp(g.sendADamp, 0, 1), p4: REVERB_DIFFUSION });
    this.reverb.mix = 1;
    this.delaySeconds = sendDelaySeconds(g);
    const ping = g.sendBPingPong >= 0.5;
    this.delay.configure({
      type: ping ? 'pingpong' : 'delay', mix: 1,
      p1: delayTimeControl(this.delaySeconds), p2: clamp(clamp(g.sendBFeedback, 0, 0.9) / 0.94, 0, 1), p3: clamp(g.sendBTone, 0, 1), p4: ping ? 1 : 0,
    });
    this.delay.mix = 1;
    this.tA = clamp(g.sendAReturn, 0, 1);
    this.tB = clamp(g.sendBReturn, 0, 1);
    if (!this.activeA) this.retA = this.tA;
    if (!this.activeB) this.retB = this.tB;
  }

  /** Silence both buses at once (Panic). */
  reset() {
    this.reverb.reset(); this.delay.reset();
    this.reverb.mix = 1; this.delay.mix = 1;
    this.preL.fill(0); this.preR.fill(0); this.prePos = 0; this.preCur = this.preTarget;
    this.activeA = this.activeB = false;
    this.quietA = this.quietB = 0;
    this.retA = this.tA; this.retB = this.tB;
  }

  /**
   * Run the buses over n samples. aL/aR and bL/bR are the summed sends (any
   * length >= n); fedA / fedB say whether anything was sent this call. The
   * returns are added to outL/outR.
   */
  process(aL, aR, bL, bR, outL, outR, n, fedA, fedB) {
    if (fedA) { this.activeA = true; this.quietA = 0; }
    if (fedB) { this.activeB = true; this.quietB = 0; }
    if (this.activeA) {
      const rv = this.reverb, pL = this.preL, pR = this.preR, size = this.preSize, kP = this.kPre, kR = this.kRet, tA = this.tA;
      let pos = this.prePos, cur = this.preCur, ret = this.retA, peak = 0;
      const target = this.preTarget;
      for (let i = 0; i < n; i++) {
        pL[pos] = aL[i]; pR[pos] = aR[i];
        cur += (target - cur) * kP;
        let xl, xr;
        if (cur < 0.5) { xl = aL[i]; xr = aR[i]; }
        else {
          let rp = pos - cur;
          if (rp < 0) rp += size;
          const k = rp | 0, f = rp - k, k1 = k + 1 === size ? 0 : k + 1;
          xl = pL[k] + (pL[k1] - pL[k]) * f; xr = pR[k] + (pR[k1] - pR[k]) * f;
        }
        if (++pos === size) pos = 0;
        rv.process(xl, xr, 0);
        const l = rv.L * REVERB_GAIN, r = rv.R * REVERB_GAIN;
        ret += (tA - ret) * kR;
        outL[i] += l * ret; outR[i] += r * ret;
        const a = (l < 0 ? -l : l) + (r < 0 ? -r : r);
        if (a > peak) peak = a;
      }
      this.prePos = pos; this.preCur = cur; this.retA = ret;
      if (!fedA && peak < SEND_SILENT) {
        this.quietA += n;
        if (this.quietA >= this.idleSamples) this.sleepA();
      } else if (!fedA) this.quietA = 0;
    }
    if (this.activeB) {
      const dl = this.delay, kR = this.kRet, tB = this.tB;
      let ret = this.retB, peak = 0;
      for (let i = 0; i < n; i++) {
        dl.process(bL[i], bR[i], 0);
        const l = dl.L, r = dl.R;
        ret += (tB - ret) * kR;
        outL[i] += l * ret; outR[i] += r * ret;
        const a = (l < 0 ? -l : l) + (r < 0 ? -r : r);
        if (a > peak) peak = a;
      }
      this.retB = ret;
      if (!fedB && peak < SEND_SILENT) {
        this.quietB += n;
        if (this.quietB >= this.idleSamples) this.sleepB();
      } else if (!fedB) this.quietB = 0;
    }
  }

  sleepA() {
    this.activeA = false; this.quietA = 0;
    this.reverb.reset(); this.reverb.mix = 1;
    this.preL.fill(0); this.preR.fill(0); this.prePos = 0; this.preCur = this.preTarget;
    this.retA = this.tA;
  }

  sleepB() {
    this.activeB = false; this.quietB = 0;
    this.delay.reset(); this.delay.mix = 1;
    this.retB = this.tB;
  }
}
