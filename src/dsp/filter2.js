// Filter 2 (v2.2): a second per-voice filter after Filter 1, in series, in
// parallel or split across the stereo channels (see FILTER_ROUTES). Its own
// types complement Filter 1's: 12 and 24 dB slopes, a resonant peak, a
// phaser, positive and negative combs and a low-pass gate whose cutoff and
// level follow the amp envelope (a vactrol-like response).
//
// Pure computation, no allocation in process() (a comb's delay line is
// allocated the first time a comb type is chosen). Coefficients are set once
// per control block by setTargets() and ramped linearly across the block.

export const FILTER2_TYPES = ['Off', 'Low 12', 'Low 24', 'Band', 'High 12', 'High 24', 'Notch', 'Peak', 'Phaser', 'Comb +', 'Comb -', 'Low-pass gate'];
export const FILTER_ROUTES = ['Serial', 'Parallel', 'Split'];
export const F2 = Object.freeze({ OFF: 0, LP12: 1, LP24: 2, BAND: 3, HP12: 4, HP24: 5, NOTCH: 6, PEAK: 7, PHASER: 8, COMB_P: 9, COMB_N: 10, LPG: 11 });

const COMB_LEN = 16384;            // enough for 16 Hz at 4 x 48 kHz (plus interpolation)
const PHASER_STAGES = 6;

export class Filter2 {
  constructor() {
    this.type = 0;
    // two cascaded TPT state variable filters per channel (the second for 24 dB)
    this.a1L = 0; this.a2L = 0; this.b1L = 0; this.b2L = 0;
    this.a1R = 0; this.a2R = 0; this.b1R = 0; this.b2R = 0;
    this.g = 0.5; this.dg = 0; this.k = 1.4; this.dk = 0;
    this.peak = 1;                 // Peak gain (linear)
    // phaser: first-order allpass states and the feedback sample
    this.apL = new Float64Array(PHASER_STAGES); this.apR = new Float64Array(PHASER_STAGES);
    this.fbL = 0; this.fbR = 0; this.fb = 0;
    // comb
    this.cL = null; this.cR = null; this.cw = 0; this.cd = 100; this.dcd = 0; this.cfb = 0;
    // low-pass gate follower (0..1)
    this.vac = 0;
  }

  reset() {
    this.a1L = this.a2L = this.b1L = this.b2L = 0;
    this.a1R = this.a2R = this.b1R = this.b2R = 0;
    this.apL.fill(0); this.apR.fill(0); this.fbL = this.fbR = 0;
    if (this.cL) { this.cL.fill(0); this.cR.fill(0); }
    this.vac = 0;
  }

  /**
   * Targets for the next block of n samples at rate fs: cutoff fc (Hz),
   * resonance 0..1, the amp envelope level (for the gate). snap jumps.
   */
  setTargets(type, fc, res, fs, n, snap, envLevel = 1) {
    if (type !== this.type) { this.type = type; this.reset(); snap = true; }
    if (type === F2.LPG) {
      // vactrol-like follower: fast to open (about 2 ms), slow to close (about 60 ms), per block
      const dt = n / fs, tau = envLevel > this.vac ? 0.002 : 0.06;
      this.vac += (envLevel - this.vac) * (1 - Math.exp(-dt / tau));
      const v = this.vac;
      fc = 30 + (fc - 30) * v * v;
    }
    const fcMax = 0.45 * fs;
    if (!(fc > 16)) fc = 16; else if (fc > fcMax) fc = fcMax;
    const r = res < 0 ? 0 : res > 1 ? 1 : res;
    const g = Math.tan(Math.PI * fc / fs);
    const k = type === F2.PEAK ? 2 - 1.9 * r : type === F2.LP24 || type === F2.HP24 ? 2 - 1.6 * r : 2 - 1.97 * r;
    this.peak = Math.pow(10, (18 * r) / 20);
    this.fb = type === F2.PHASER ? 0.85 * r : 0;
    if (snap) { this.g = g; this.k = k; this.dg = this.dk = 0; }
    else { this.dg = (g - this.g) / n; this.dk = (k - this.k) / n; }
    if (type === F2.COMB_P || type === F2.COMB_N) {
      if (!this.cL) { this.cL = new Float32Array(COMB_LEN); this.cR = new Float32Array(COMB_LEN); }
      let d = fs / fc; if (d < 2) d = 2; else if (d > COMB_LEN - 4) d = COMB_LEN - 4;
      if (snap) { this.cd = d; this.dcd = 0; } else this.dcd = (d - this.cd) / n;
      this.cfb = (type === F2.COMB_P ? 1 : -1) * 0.95 * r;
    }
  }

  /** Filter XL/XR (n samples) in place. */
  process(XL, XR, n, stereo) {
    const t = this.type;
    if (t === F2.OFF) return;
    if (t === F2.PHASER) { this.phaser(XL, XR, n, stereo); return; }
    if (t === F2.COMB_P || t === F2.COMB_N) { this.comb(XL, XR, n, stereo); return; }
    let g = this.g, k = this.k;
    const dg = this.dg, dk = this.dk, two = t === F2.LP24 || t === F2.HP24, A = this.peak;
    let a1L = this.a1L, a2L = this.a2L, b1L = this.b1L, b2L = this.b2L;
    let a1R = this.a1R, a2R = this.a2R, b1R = this.b1R, b2R = this.b2R;
    for (let j = 0; j < n; j++) {
      g += dg; k += dk;
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      // left
      let x = XL[j];
      let v3 = x - a2L, v1 = a1 * a1L + a2 * v3, v2 = a2L + a2 * a1L + a3 * v3;
      a1L = 2 * v1 - a1L; a2L = 2 * v2 - a2L;
      let y = pick(t, x, v1, v2, k, A);
      if (two) {
        v3 = y - b2L; v1 = a1 * b1L + a2 * v3; v2 = b2L + a2 * b1L + a3 * v3;
        b1L = 2 * v1 - b1L; b2L = 2 * v2 - b2L;
        y = pick(t, y, v1, v2, k, A);
      }
      if (t === F2.LPG) y *= this.vac;
      XL[j] = y;
      if (!stereo) continue;
      x = XR[j];
      v3 = x - a2R; v1 = a1 * a1R + a2 * v3; v2 = a2R + a2 * a1R + a3 * v3;
      a1R = 2 * v1 - a1R; a2R = 2 * v2 - a2R;
      y = pick(t, x, v1, v2, k, A);
      if (two) {
        v3 = y - b2R; v1 = a1 * b1R + a2 * v3; v2 = b2R + a2 * b1R + a3 * v3;
        b1R = 2 * v1 - b1R; b2R = 2 * v2 - b2R;
        y = pick(t, y, v1, v2, k, A);
      }
      if (t === F2.LPG) y *= this.vac;
      XR[j] = y;
    }
    this.g = g; this.k = k;
    this.a1L = a1L; this.a2L = a2L; this.b1L = b1L; this.b2L = b2L;
    if (stereo) { this.a1R = a1R; this.a2R = a2R; this.b1R = b1R; this.b2R = b2R; }
    else { this.a1R = a1L; this.a2R = a2L; this.b1R = b1L; this.b2R = b2L; }
  }

  /** Six first-order allpasses at the cutoff with feedback, mixed 50/50 with the input: notches that sweep with Cutoff. */
  phaser(XL, XR, n, stereo) {
    let g = this.g; const dg = this.dg, fb = this.fb;
    const sL = this.apL, sR = this.apR;
    let fL = this.fbL, fR = this.fbR;
    for (let j = 0; j < n; j++) {
      g += dg;
      const a = g / (1 + g);
      let x = XL[j], y = x + fb * fL;
      for (let i = 0; i < PHASER_STAGES; i++) { const v = (y - sL[i]) * a, lp = v + sL[i]; sL[i] = lp + v; y = 2 * lp - y; }
      fL = y; XL[j] = 0.5 * (x + y);
      if (!stereo) continue;
      x = XR[j]; y = x + fb * fR;
      for (let i = 0; i < PHASER_STAGES; i++) { const v = (y - sR[i]) * a, lp = v + sR[i]; sR[i] = lp + v; y = 2 * lp - y; }
      fR = y; XR[j] = 0.5 * (x + y);
    }
    if (!stereo) { sR.set(sL); fR = fL; }
    this.g = g; this.fbL = fL; this.fbR = fR;
  }

  /** Feedback comb tuned to the cutoff: Comb + rings at every harmonic, Comb - at the odd ones (hollower). */
  comb(XL, XR, n, stereo) {
    const L = this.cL, R = this.cR, fb = this.cfb, M = COMB_LEN - 1;
    const norm = 1 - 0.55 * Math.abs(fb);
    let w = this.cw, d = this.cd; const dd = this.dcd;
    for (let j = 0; j < n; j++) {
      d += dd;
      let rp = w - d; if (rp < 0) rp += COMB_LEN;
      const i0 = rp | 0, fr = rp - i0, i1 = (i0 + 1) & M;
      const dl = L[i0] + (L[i1] - L[i0]) * fr;
      const yl = XL[j] + fb * dl;
      L[w] = yl; XL[j] = yl * norm;
      if (stereo) {
        const dr = R[i0] + (R[i1] - R[i0]) * fr;
        const yr = XR[j] + fb * dr;
        R[w] = yr; XR[j] = yr * norm;
      } else R[w] = yl;
      w = (w + 1) & M;
    }
    this.cw = w; this.cd = d;
  }
}

function pick(t, x, v1, v2, k, A) {
  switch (t) {
    case F2.LP12: case F2.LP24: case F2.LPG: return v2;
    case F2.BAND: return k * v1;
    case F2.HP12: case F2.HP24: return x - k * v1 - v2;
    case F2.NOTCH: return x - k * v1;
    case F2.PEAK: return x + (A - 1) * k * v1;
    default: return x;
  }
}
