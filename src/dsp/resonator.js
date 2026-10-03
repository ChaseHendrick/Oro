// Resonator (2.10): the track's own terrain as a vibrating membrane.
//
// A square membrane with fixed edges covers one tile of the map. Its local
// stiffness follows the land (s = 2^(CONTRAST * height), normalised so the
// stiffest point is 1): peaks are stiff and carry waves fast, valleys are
// slack and slow, so craters and ridges move the modes. The wave equation
//
//   u_tt = c0^2 s(x) Lap u - 2 sigma0 u_t + 2 sigma1 s(x) Lap u_t
//
// runs as an explicit leapfrog finite-difference scheme on an n x n grid of
// interior nodes (n by quality, see RESO_GRID) at an internal rate of about
// 24 kHz (the host rate divided by a whole number), with `sub` sub-steps per
// internal sample for high notes. With A = -S Lap (eigenvalues g >= 0, at most
// 8 since s <= 1) every mode obeys
//
//   (1 + a) z^2 - (2 - (lam2 + mu) g) z + (1 - a - mu g) = 0,
//   a = sigma0 k, lam2 = (c0 k / h)^2, mu = 2 sigma1 k / h^2,
//
// whose roots stay inside the unit circle whenever lam2 + 2 mu <= 1/2 and
// a, mu >= 0 (Schur-Cohn). Every coefficient is clamped to that region with a
// margin (COURANT), so the scheme is stable for any setting: without input its
// energy can only fall.
//
// Pitch: the lowest eigenvalue g1 of A is found once per terrain (or grid)
// change with a short Lanczos run started from the flat membrane's
// fundamental, and lam2 is solved from the mode equation above so the lowest
// mode rings at the note (times 1 / Size). Notes above what the grid can carry
// (lam2 > 0.45 even with the most sub-steps) ring whole octaves lower.
//
// Excitation: Strike adds a raised-cosine pulse (about 1 ms, a raised-cosine
// bump about 1.6 cells wide) at the dot for every note; Resonate feeds the
// track's own output into the membrane at the dot all the time. Two pickups
// (left and right, one cell apart) read the displacement at the listening
// point, which sits opposite the dot through the centre of the map and swings
// round the centre with Listen. Output is interpolated (4-point Hermite) back
// to the host rate, DC-blocked, softly limited and mixed with the dry track.
//
// Pure computation: every buffer is allocated in the constructor; process()
// and everything it calls never allocate.

export const RESO_MODES = Object.freeze(['Off', 'Strike', 'Resonate']);
/** Grid (interior nodes per side) and the most sub-steps per internal sample, by quality. */
export const RESO_GRID = Object.freeze({
  eco: { n: 24, sub: 1 },
  standard: { n: 32, sub: 2 },
  high: { n: 36, sub: 2 },
  pristine: { n: 36, sub: 2 },
  raw: { n: 32, sub: 2 },
});
export const RESO_NMAX = 36;
export const RESO_RATE = 24000;          // target internal rate (Hz)
const CONTRAST = 1.2;                    // log2 stiffness per unit of terrain height
const COURANT = 0.49;                    // lam2 + 2 mu stays below this (stability bound 0.5)
const LAM2_MAX = 0.45;                   // pitch ceiling per sub-step (leaves room for Tone)
const LANCZOS = 48;                      // Lanczos steps for the lowest mode
const BUMP_R = 1.6;                      // strike / drive bump radius (cells)
const BUMP_W = 5;                        // cells per side of the bump stencil
const MAX_STRIKES = 4;
const PULSE_SEC = 0.001;
const STRIKE_GAIN = 0.3;                 // lowest mode at the pickup ~ this for a full strike at the centre
const DRIVE_GAIN = 1.4;
const DRIVE_REF = 6.9078 / 0.4;          // decay rate where Resonate's gain at resonance is DRIVE_GAIN
const QUIET = 3e-6;                      // below this (output units) for IDLE_SEC the membrane rests
const IDLE_SEC = 0.05;
const TRACK_SEC = 0.01;                  // pitch tracking (glide, bend) smoothing
// Resonate level match: the membrane's level follows the track's own (RMS
// over AGC_RMS_SEC; the gain rises slowly and falls quickly, and holds while
// the input is silent),
// so the shape of the land and Decay change the colour more than the level.
const AGC_RMS_SEC = 0.2, AGC_UP_SEC = 1, AGC_DOWN_SEC = 0.15, AGC_MIN = 0.25, AGC_MAX = 16;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const fin = (x, d) => (Number.isFinite(x) ? x : d);

function bil(d, s, m, u, v) {
  const x = u * s, y = v * s;
  const xf = Math.floor(x), yf = Math.floor(y);
  const fx = x - xf, fy = y - yf;
  const x0 = xf & m, y0 = yf & m, x1 = (x0 + 1) & m;
  const r0 = y0 * s, r1 = ((y0 + 1) & m) * s;
  const a = d[r0 + x0], b = d[r1 + x0];
  const top = a + fx * (d[r0 + x1] - a);
  const bot = b + fx * (d[r1 + x1] - b);
  return top + fy * (bot - top);
}

/** Map level whose size is the smallest power of two at least `want` (the full level if none). */
function levelFor(chain, want) {
  if (!chain || !chain.length) return null;
  let best = chain[0];
  for (const L of chain) if (L.size >= want) best = L;
  return best;
}

/** Smallest eigenvalue of the symmetric tridiagonal (a[0..m-1], b[1..m-1]) by Sturm bisection. */
function smallestEig(a, b, m, hi) {
  let lo = 0;
  hi = Math.max(hi, 1e-12);
  for (let it = 0; it < 64; it++) {
    const x = 0.5 * (lo + hi);
    // number of eigenvalues below x
    let count = 0, d = a[0] - x;
    if (d < 0) count++;
    for (let i = 1; i < m; i++) {
      d = a[i] - x - (b[i] * b[i]) / (d === 0 ? 1e-300 : d);
      if (d < 0) count++;
    }
    if (count >= 1) hi = x; else lo = x;
  }
  return 0.5 * (lo + hi);
}

export class Resonator {
  constructor(sr, quality = 'standard') {
    this.sr = sr;
    this.D = Math.max(1, Math.round(sr / RESO_RATE));
    this.fs = sr / this.D;
    const W = RESO_NMAX + 2, cells = W * W;
    this.u = new Float64Array(cells);
    this.up = new Float64Array(cells);
    this.lp = new Float64Array(cells);      // Lap of `up` (the previous step), for the Tone loss term
    this.s = new Float64Array(cells);       // stiffness, 0 outside the interior
    this.rs = new Float64Array(cells);      // sqrt(s), for the symmetric Lanczos operator
    this.q0 = new Float64Array(cells); this.q1 = new Float64Array(cells); this.wv = new Float64Array(cells); this.ly = new Float64Array(cells);
    this.la = new Float64Array(LANCZOS); this.lb = new Float64Array(LANCZOS + 1);
    // strike pulses: per slot its stencil (cell index + weight), level and progress
    this.pIdx = new Int32Array(MAX_STRIKES * BUMP_W * BUMP_W); this.pW = new Float64Array(MAX_STRIKES * BUMP_W * BUMP_W);
    this.pCnt = new Int32Array(MAX_STRIKES); this.pAmp = new Float64Array(MAX_STRIKES); this.pT = new Int32Array(MAX_STRIKES);
    this.pNext = 0;
    this.pulse = new Float64Array(Math.max(2, Math.round(PULSE_SEC * this.fs)));
    let ps = 0;
    for (let i = 0; i < this.pulse.length; i++) { this.pulse[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / this.pulse.length); ps += this.pulse[i]; }
    for (let i = 0; i < this.pulse.length; i++) this.pulse[i] /= ps;   // unit total impulse
    // Resonate drive stencil and pickups (bilinear, left and right)
    this.dIdx = new Int32Array(BUMP_W * BUMP_W); this.dW = new Float64Array(BUMP_W * BUMP_W); this.dCnt = 0;
    this.kIdx = new Int32Array(8); this.kW = new Float64Array(8);
    this.dotX = 0.5; this.dotY = 0.5; this.dotKey = NaN;
    // output history at the internal rate (y0 oldest .. y3 newest)
    this.hl = new Float64Array(4); this.hr = new Float64Array(4);
    this.ph = 0; this.inAcc = 0;
    this.agc = 1; this.inMs = 0; this.wetMs = 0;
    this.dcL = 0; this.dcR = 0; this.dcXL = 0; this.dcXR = 0;
    this.dcA = 1 - 2 * Math.PI * 8 / sr;
    // settings
    this.mode = 0; this.mix = 0.5; this.decay = 1.5; this.tone = 0.5; this.size = 1; this.listen = 0;
    this.mixCur = 0.5;
    this.fTarget = 220; this.fCur = 220;
    this.trackK = 1 - Math.exp(-1 / (TRACK_SEC * sr));
    this.g1 = 0; this.dirty = true;
    this.busy = false; this.quietN = 0;
    // per-sub-step coefficients (set by coefficients())
    this.S = 1; this.A1 = 1; this.inv = 1; this.al = 0; this.mu = 0; this.gStrike = 0; this.gDrive = 0;
    this.fPlayed = 0; this.coefKey = NaN;
    this.setQuality(quality);
  }

  /** Grid size and sub-step ceiling for a quality mode; restarts the membrane at rest. */
  setQuality(quality) {
    const q = RESO_GRID[quality] || RESO_GRID.standard;
    this.n = q.n; this.smax = q.sub; this.W = q.n + 2;
    this.reset();
    this.s.fill(0);
    this.g1 = 0;
    this.dirty = true;
    this.dotKey = NaN; this.coefKey = NaN;
  }

  reset() {
    this.u.fill(0); this.up.fill(0); this.lp.fill(0);
    this.hl.fill(0); this.hr.fill(0);
    this.pAmp.fill(0); this.pT.fill(0);
    this.inAcc = 0; this.ph = 0;
    this.dcL = this.dcR = this.dcXL = this.dcXR = 0;
    this.busy = false; this.quietN = 0;
  }

  /**
   * Stiffness from the terrain: A and B blended by `morph`, sampled at the
   * grid nodes from the mip level about twice as fine as the grid. Then the
   * lowest eigenvalue g1 of -S Lap by Lanczos (flat land: exactly
   * 8 sin^2(pi / (2 (n + 1)))). Message-time work, never in process().
   */
  derive(chainA, chainB, morph = 0) {
    const n = this.n, W = this.W, s = this.s, rs = this.rs;
    const A = levelFor(chainA, 2 * (n + 1));
    const B = morph > 1e-4 ? levelFor(chainB, 2 * (n + 1)) : null;
    let sum = 0;
    s.fill(0);
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const u = i / (n + 1), w = j / (n + 1);
      let h = A ? bil(A.data, A.size, A.size - 1, u, w) : 0;
      if (B) h += morph * (bil(B.data, B.size, B.size - 1, u, w) - h);
      s[j * W + i] = fin(h, 0);
      sum += s[j * W + i];
    }
    const mean = sum / (n * n);
    let smax = 0;
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const k = j * W + i;
      const v = Math.pow(2, CONTRAST * clamp(s[k] - mean, -1.5, 1.5));
      s[k] = v; if (v > smax) smax = v;
    }
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const k = j * W + i;
      s[k] /= smax; rs[k] = Math.sqrt(s[k]);
    }
    this.g1 = this.lowestMode();
    this.dirty = false;
    this.coefKey = NaN;
  }

  /** y = S^1/2 (-Lap) S^1/2 x on the interior (x, y: grid arrays with zero borders). */
  applyB(x, y) {
    const n = this.n, W = this.W, rs = this.rs, t = this.wv;
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = j * W + i; t[k] = rs[k] * x[k]; }
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const k = j * W + i;
      y[k] = rs[k] * (4 * t[k] - t[k - 1] - t[k + 1] - t[k - W] - t[k + W]);
    }
  }

  lowestMode() {
    const n = this.n, W = this.W, rs = this.rs;
    const q0 = this.q0, q1 = this.q1, a = this.la, b = this.lb;
    const y = this.ly;
    q0.fill(0); q1.fill(0); y.fill(0); this.wv.fill(0);
    let nrm = 0;
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const k = j * W + i;
      const v = Math.sin(Math.PI * i / (n + 1)) * Math.sin(Math.PI * j / (n + 1)) / rs[k];
      q1[k] = v; nrm += v * v;
    }
    nrm = 1 / Math.sqrt(nrm);
    for (let k = 0; k < q1.length; k++) q1[k] *= nrm;
    let m = 0, beta = 0;
    for (; m < LANCZOS; m++) {
      this.applyB(q1, y);
      let al = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = j * W + i; y[k] -= beta * q0[k]; al += y[k] * q1[k]; }
      a[m] = al;
      let bb = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = j * W + i; y[k] -= al * q1[k]; bb += y[k] * y[k]; }
      beta = Math.sqrt(bb);
      b[m + 1] = beta;
      if (beta < 1e-10 * Math.max(1e-30, Math.abs(al))) { m++; break; }
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const k = j * W + i;
        q0[k] = q1[k]; q1[k] = y[k] / beta;
      }
    }
    const g = smallestEig(a, b, m, a[0]);
    return g > 1e-9 ? g : 8 * Math.pow(Math.sin(Math.PI / (2 * (n + 1))), 2);
  }

  /** Settings from the part's parameters (values as stored). */
  configure(mode, mix, decay, tone, size, listen) {
    const m = Math.max(0, Math.min(2, Math.round(fin(mode, 0))));
    if (m !== this.mode) {
      if (m === 0 || this.mode === 0) { this.reset(); this.mixCur = clamp(fin(mix, 0.5), 0, 1); }
      this.agc = 1; this.inMs = 0; this.wetMs = 0;
      this.mode = m;
    }
    this.mix = clamp(fin(mix, 0.5), 0, 1);
    this.decay = clamp(fin(decay, 1.5), 0.02, 60);
    this.tone = clamp(fin(tone, 0.5), 0, 1);
    this.size = clamp(fin(size, 1), 0.05, 20);
    const l = clamp(fin(listen, 0), -1, 1);
    if (l !== this.listen) { this.listen = l; this.dotKey = NaN; }
    this.coefKey = NaN;
  }

  /** The fundamental the membrane aims for (Hz): the note over Size. */
  setNote(hz, snap) {
    if (!(hz > 0)) return;
    this.fTarget = clamp(hz / this.size, 5, 20000);
    if (snap) this.fCur = this.fTarget;
  }

  /** Where the dot is (map units, any real: the tile wraps). Moves the drive point and the pickups. */
  setDot(x, y) {
    x = fin(x, 0.5); y = fin(y, 0.5);
    x -= Math.floor(x); y -= Math.floor(y);
    this.dotX = x; this.dotY = y;
    const key = Math.round(x * 4096) * 8192 + Math.round(y * 4096);
    if (key === this.dotKey) return;
    this.dotKey = key;
    this.dCnt = this.stencil(x, y, this.dIdx, this.dW, 0);
    // listening point: the dot mirrored through the centre, swung round it by Listen
    const th = Math.PI * (1 + this.listen), c = Math.cos(th), s = Math.sin(th);
    const dx = x - 0.5, dy = y - 0.5;
    const px = 0.5 + c * dx - s * dy, py = 0.5 + s * dx + c * dy;
    const off = 1 / (this.n + 1);
    this.pickup(px - off, py, 0);
    this.pickup(px + off, py, 4);
  }

  pickup(x, y, at) {
    const n = this.n, W = this.W;
    const gx = clamp(x * (n + 1), 0, n + 1 - 1e-9), gy = clamp(y * (n + 1), 0, n + 1 - 1e-9);
    const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const k = iy * W + ix;
    this.kIdx[at] = k; this.kW[at] = (1 - fx) * (1 - fy);
    this.kIdx[at + 1] = k + 1; this.kW[at + 1] = fx * (1 - fy);
    this.kIdx[at + 2] = k + W; this.kW[at + 2] = (1 - fx) * fy;
    this.kIdx[at + 3] = k + W + 1; this.kW[at + 3] = fx * fy;
  }

  /** Raised-cosine bump at map point (x, y) into idx/w from `at`; returns the cell count (weights sum to 1). */
  stencil(x, y, idx, w, at) {
    const n = this.n, W = this.W;
    const gx = x * (n + 1), gy = y * (n + 1);
    const cx = Math.round(gx), cy = Math.round(gy);
    let cnt = 0, sum = 0;
    for (let j = cy - 2; j <= cy + 2; j++) for (let i = cx - 2; i <= cx + 2; i++) {
      if (i < 1 || j < 1 || i > n || j > n) continue;
      const d = Math.hypot(i - gx, j - gy);
      if (d >= BUMP_R) continue;
      const v = 0.5 + 0.5 * Math.cos(Math.PI * d / BUMP_R);
      idx[at + cnt] = j * W + i; w[at + cnt] = v; sum += v; cnt++;
    }
    if (cnt === 0) {
      // the dot is on the fixed edge: strike the nearest interior node
      idx[at] = clamp(cy, 1, n) * W + clamp(cx, 1, n); w[at] = 1; return 1;
    }
    for (let q = 0; q < cnt; q++) w[at + q] /= sum;
    return cnt;
  }

  /** A note strikes the membrane at map point (x, y) with strength 0..1. */
  strike(x, y, amp) {
    if (this.mode !== 1 || !(amp > 0)) return;
    x = fin(x, 0.5); y = fin(y, 0.5);
    x -= Math.floor(x); y -= Math.floor(y);
    const slot = this.pNext; this.pNext = (slot + 1) % MAX_STRIKES;
    const base = slot * BUMP_W * BUMP_W;
    this.pCnt[slot] = this.stencil(x, y, this.pIdx, this.pW, base);
    this.pAmp[slot] = clamp(amp, 0, 1);
    this.pT[slot] = 0;
    this.busy = true; this.quietN = 0;
  }

  /**
   * Sub-steps and per-sub-step coefficients for the current pitch, Decay and
   * Tone. Fundamental decay rate = 6.91 / Decay; a mode r times higher decays
   * (1 + Q r^2) / (1 + Q) times faster, Q from Tone (bright 1/128 .. dark 8).
   */
  coefficients() {
    const g1 = this.g1;
    let f = this.fCur;
    const fs = this.fs;
    // most sub-steps allowed; fold whole octaves down above the ceiling
    const thMax = 2 * Math.asin(Math.min(1, Math.sqrt(LAM2_MAX * g1) / 2));
    while (f > 5 && 2 * Math.PI * f / (this.smax * fs) > thMax) f *= 0.5;
    let S = 1;
    while (S < this.smax && 2 * Math.PI * f / (S * fs) > thMax) S++;
    if (S !== this.S) this.resubstep(S);
    const k = 1 / (S * fs);
    const th = 2 * Math.PI * f * k;
    const Q = 0.25 * Math.pow(2, 10 * (0.5 - this.tone));
    const sig = 6.9078 / this.decay;           // fundamental's decay rate (1/s)
    const s0 = sig / (1 + Q);                  // frequency-independent part
    const a = s0 * k;
    let mu = 2 * a * Q / g1;
    // lam2 that puts the lowest mode exactly at th (with the losses' small pull)
    const solve = (m) => (2 - 2 * Math.cos(th) * Math.sqrt((1 + a) * Math.max(1e-12, 1 - a - m * g1))) / g1 - m;
    let lam2 = solve(mu);
    if (lam2 + 2 * mu > COURANT) { mu = Math.max(0, (COURANT - lam2) / 2); lam2 = solve(mu); }
    lam2 = clamp(lam2, 0, COURANT - 2 * mu);
    this.A1 = 1 - a; this.inv = 1 / (1 + a);
    this.al = lam2 + mu; this.mu = mu;
    this.fPlayed = f;
    // gains: a unit impulse adds 1/sin(th) to the lowest mode; scale out pitch and grid size
    const n1 = this.n + 1;
    this.gStrike = STRIKE_GAIN * Math.sin(th) * n1 * n1 / 4;
    const dRef = DRIVE_REF * k, dNow = sig * k;
    this.gDrive = DRIVE_GAIN * Math.sin(th) * n1 * n1 / 4 * Math.sqrt(dRef * dNow);
  }

  /** Change the sub-step count keeping the membrane's velocity (up and its Laplacian follow). */
  resubstep(S) {
    const r = this.S / S;
    const n = this.n, W = this.W, u = this.u, up = this.up, lp = this.lp;
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = j * W + i; up[k] = u[k] - (u[k] - up[k]) * r; }
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const k = j * W + i;
      lp[k] = up[k - 1] + up[k + 1] + up[k - W] + up[k + W] - 4 * up[k];
    }
    this.S = S;
  }

  /**
   * Wave speed at the stiffest point (grid cells per second) and the side
   * length between the fixed edges (cells): a flat membrane's continuous
   * fundamental is speed * sqrt(2) / (2 * side).
   */
  waveSpeed() { return Math.sqrt(Math.max(0, this.al - this.mu)) * this.S * this.fs; }
  get side() { return this.n + 1; }

  /** True once the membrane has its stiffness and lowest mode (after the first derive). */
  get ready() { return this.g1 > 0; }

  /** Control rate: pitch tracking and coefficients. `n` host samples have passed. */
  control(n) {
    if (!(this.g1 > 0)) return;
    const kk = 1 - Math.pow(1 - this.trackK, n);
    const f = this.fCur + (this.fTarget - this.fCur) * kk;
    this.fCur = Math.abs(f - this.fTarget) < 1e-6 * this.fTarget ? this.fTarget : f;
    const key = this.fCur * 1e3 + this.S;
    if (key !== this.coefKey) { this.coefficients(); this.coefKey = this.fCur * 1e3 + this.S; }
  }

  /** One internal sample: `S` sub-steps, strike pulses, drive `x`, then the pickups. */
  step(x) {
    const n = this.n, W = this.W, s = this.s, lp = this.lp;
    const A1 = this.A1, inv = this.inv, al = this.al, mu = this.mu;
    const drive = this.mode === 2 && x !== 0 ? x * this.gDrive : 0;
    for (let sub = 0; sub < this.S; sub++) {
      const u = this.u, up = this.up;
      for (let j = 1; j <= n; j++) {
        let k = j * W + 1;
        const end = k + n;
        for (; k < end; k++) {
          const c = u[k];
          const lap = u[k - 1] + u[k + 1] + u[k - W] + u[k + W] - 4 * c;
          up[k] = (2 * c - A1 * up[k] + s[k] * (al * lap - mu * lp[k])) * inv;
          lp[k] = lap;
        }
      }
      // `up` now holds the new displacement
      this.u = up; this.up = u;
      const nu = up;
      if (sub === 0) {
        for (let p = 0; p < MAX_STRIKES; p++) {
          const amp = this.pAmp[p];
          if (amp === 0) continue;
          const t = this.pT[p];
          const g = amp * this.pulse[t] * this.gStrike;
          const base = p * BUMP_W * BUMP_W, cnt = this.pCnt[p];
          for (let q = 0; q < cnt; q++) nu[this.pIdx[base + q]] += g * this.pW[base + q];
          if (t + 1 >= this.pulse.length) this.pAmp[p] = 0; else this.pT[p] = t + 1;
        }
      }
      if (drive !== 0) for (let q = 0; q < this.dCnt; q++) nu[this.dIdx[q]] += drive * this.dW[q];
    }
    const u = this.u, kI = this.kIdx, kW = this.kW;
    const yl = u[kI[0]] * kW[0] + u[kI[1]] * kW[1] + u[kI[2]] * kW[2] + u[kI[3]] * kW[3];
    const yr = u[kI[4]] * kW[4] + u[kI[5]] * kW[5] + u[kI[6]] * kW[6] + u[kI[7]] * kW[7];
    const hl = this.hl, hr = this.hr;
    hl[0] = hl[1]; hl[1] = hl[2]; hl[2] = hl[3]; hl[3] = yl;
    hr[0] = hr[1]; hr[1] = hr[2]; hr[2] = hr[3]; hr[3] = yr;
  }

  /** Largest displacement on the membrane (rest detection). */
  peakDisplacement() {
    const u = this.u, n = this.n, W = this.W;
    let m = 0;
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const a = Math.abs(u[j * W + i]); if (a > m) m = a; }
    return m;
  }

  /**
   * Mix the membrane into the track's host-rate output oL/oR[pos .. pos+seg)
   * in place: dry (1 - Mix) + membrane Mix. Resonate hears the dry signal first.
   */
  process(oL, oR, pos, seg) {
    if (this.mode === 0) return;
    const end = pos + seg;
    const mix0 = this.mixCur, dm = (this.mix - mix0) / seg;
    let mixv = mix0;
    if (this.mode === 2 && !this.busy) {
      for (let n = pos; n < end; n++) if (oL[n] !== 0 || oR[n] !== 0) { this.busy = true; this.quietN = 0; break; }
    }
    // nothing to hear from the membrane (resting, not built yet, or Mix held at 0): dry only
    if (!this.busy || !(this.g1 > 0) || (this.mix === 0 && mix0 === 0)) {
      for (let n = pos; n < end; n++) { mixv += dm; const d = 1 - mixv; oL[n] *= d; oR[n] *= d; }
      this.mixCur = this.mix;
      return;
    }
    const D = this.D, invD = 1 / D, hl = this.hl, hr = this.hr, dcA = this.dcA;
    let ph = this.ph, acc = this.inAcc, peak = 0, inPeak = 0, sIn = 0, sWet = 0;
    let dcL = this.dcL, dcR = this.dcR, xl = this.dcXL, xr = this.dcXR;
    const res = this.mode === 2, g = res ? this.agc : 1;
    for (let n = pos; n < end; n++) {
      const dl = oL[n], dr = oR[n];
      if (res) { const x = 0.5 * (dl + dr); acc += x; sIn += x * x; if (x > inPeak) inPeak = x; else if (-x > inPeak) inPeak = -x; }
      if (++ph >= D) { ph = 0; this.step(acc * invD); acc = 0; }
      // 4-point Hermite between y1 and y2
      const t = ph * invD;
      let wl = hermite(hl[0], hl[1], hl[2], hl[3], t), wr = hermite(hr[0], hr[1], hr[2], hr[3], t);
      // DC blocker, then a soft limit
      const yl = wl - xl + dcA * dcL; xl = wl; dcL = yl;
      const yr = wr - xr + dcA * dcR; xr = wr; dcR = yr;
      if (res) { const m = 0.5 * (yl + yr); sWet += m * m; }
      wl = soft(g * yl); wr = soft(g * yr);
      const a = wl < 0 ? -wl : wl, b = wr < 0 ? -wr : wr;
      if (a > peak) peak = a; if (b > peak) peak = b;
      mixv += dm;
      oL[n] = dl * (1 - mixv) + wl * mixv;
      oR[n] = dr * (1 - mixv) + wr * mixv;
    }
    this.ph = ph; this.inAcc = acc; this.mixCur = this.mix;
    this.dcL = dcL; this.dcR = dcR; this.dcXL = xl; this.dcXR = xr;
    if (res) {
      const aR = 1 - Math.exp(-seg / (AGC_RMS_SEC * this.sr));
      this.inMs += aR * (sIn / seg - this.inMs);
      this.wetMs += aR * (sWet / seg - this.wetMs);
      if (inPeak > QUIET && this.inMs > 1e-10 && this.wetMs > 1e-16) {
        const target = clamp(Math.sqrt(this.inMs / this.wetMs), AGC_MIN, AGC_MAX);
        this.agc += (1 - Math.exp(-seg / ((target > this.agc ? AGC_UP_SEC : AGC_DOWN_SEC) * this.sr))) * (target - this.agc);
      }
    }
    // rest: quiet output, no pulse pending, no input, and (checked rarely) a quiet membrane
    let pending = false;
    for (let p = 0; p < MAX_STRIKES; p++) if (this.pAmp[p] !== 0) pending = true;
    if (!pending && peak < QUIET && inPeak < QUIET) {
      this.quietN += seg;
      if (this.quietN >= IDLE_SEC * this.sr) {
        this.quietN = 0;
        if (this.peakDisplacement() < QUIET) { this.reset(); }
      }
    } else this.quietN = 0;
  }
}

function hermite(y0, y1, y2, y3, t) {
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + y1;
}

// identity inside +-1, then a knee that never exceeds +-2
function soft(x) {
  if (x > 1) { const e = x - 1; return 1 + e / (1 + e); }
  if (x < -1) { const e = -x - 1; return -1 - e / (1 + e); }
  return x;
}
