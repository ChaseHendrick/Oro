// Science sources (v2.1): modulation generators built on the author's own
// dynamical-systems research (Chase Hendrick, preprints and programs on
// GitHub and Zenodo; see THIRD_PARTY_NOTICES.md and the user guide credits).
// Pure JavaScript, no Web Audio: the worklet steps one ScienceBank at control
// rate, and the tests drive the same classes in Node.
//
//   Neuron    the space-clamped Hodgkin-Huxley equations at the 1952 constants
//             (ChaseHendrick/hh-dynamics, hh_float.py; temperature factor from
//             ChaseHendrick/hh-pulse). Injected current J, a note-on kick,
//             temperature and a time scale.
//   Lorenz    the classical Lorenz system (sigma 10, rho 28, beta 8/3).
//   Pendulum  the equal-mass, equal-length double pendulum, g = 1
//             (ChaseHendrick/double-pendulum, code/dp.h), held on an energy shell.
//   Smooth    Matern-type random modulation: k cascaded one-pole filters of
//             white noise give the Matern spectrum with nu = k - 1/2
//             (smoothness idea from ChaseHendrick/rank-window).
//   Collapse  self-similar point-vortex collapse (ChaseHendrick/minimal-winding):
//             every vortex follows z(t) = lambda e^{i phi} z(0) with
//             phi = -P ln lambda^2, P the winding number.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const TAU = Math.PI * 2;

// ======================================================================= Neuron

export const HH = Object.freeze({
  GNA: 120, GK: 36, GL: 0.3, ENA: 115, EK: -12,
  EL: 10.613,          // Hodgkin and Huxley 1952, the printed value used by the proofs
  T0: 6.3,             // degrees C, the temperature of the 1952 constants
  DT: 0.025,           // model ms per step (exponential Euler / Rush-Larsen)
  SPIKE_MV: 50,        // upward crossing that counts as a spike
});

/** x / (e^x - 1) with the removable singularity at 0 filled in (hh_float.py psi). */
export function psi(x) {
  if (Math.abs(x) < 1e-6) return 1 - x / 2 + (x * x) / 12;
  return x / Math.expm1(x);
}

/** The six HH rate functions at depolarisation u (mV), per ms at 6.3 C. */
export function hhRates(u, out) {
  out.an = 0.1 * psi((10 - u) / 10);
  out.bn = 0.125 * Math.exp(-u / 80);
  out.am = psi((25 - u) / 10);
  out.bm = 4 * Math.exp(-u / 18);
  out.ah = 0.07 * Math.exp(-u / 20);
  out.bh = 1 / (Math.exp((30 - u) / 10) + 1);
  return out;
}

/**
 * One Hodgkin-Huxley membrane. Modern sign convention as in hh-dynamics:
 * u is the depolarisation from rest (mV), J the applied depolarising current
 * (uA/cm^2), time in ms. Integrated by exponential Euler: each gate relaxes
 * exactly towards its steady state for the step (Rush-Larsen), then u, which
 * is linear in itself for fixed gates, relaxes exactly towards its own.
 * Unconditionally stable, so the step only sets accuracy.
 */
export class HHNeuron {
  constructor() {
    this.u = 0; this.m = 0; this.n = 0; this.h = 0;
    this.kickLeft = 0;      // model ms of kick current still to apply
    this.kickJ = 0;
    this.spike = 0;         // 0..1, decays after each spike (real time)
    this.spikes = 0;        // count, for tests and telemetry
    this.lastSpikeT = NaN;  // model ms of the last spike
    this.t = 0;             // model ms
    this.r = { an: 0, bn: 0, am: 0, bm: 0, ah: 0, bh: 0 };
    this.rest(0);
  }

  /**
   * Rest state for current J: start at the J = 0 rest and ramp the current up
   * slowly (quasi-statically), so the membrane follows the rest branch instead
   * of being excited by a sudden step. In the bistable range (about 6.26 to
   * 9.78 uA/cm^2) it then rests until a kick starts a spike train.
   */
  rest(J = 0, tempC = HH.T0) {
    this.u = 0;
    const r = hhRates(0, this.r);
    this.m = r.am / (r.am + r.bm); this.n = r.an / (r.an + r.bn); this.h = r.ah / (r.ah + r.bh);
    this.kickLeft = 0;
    const ramp = 20000;                 // 500 model ms at DT
    for (let i = 0; i < ramp; i++) this.step(HH.DT, (J * (i + 1)) / ramp, tempC);
    for (let i = 0; i < 4000; i++) this.step(HH.DT, J, tempC);
    this.spike = 0; this.spikes = 0; this.lastSpikeT = NaN; this.t = 0;
  }

  /** A brief depolarising pulse: amplitude J (uA/cm^2) for ms model milliseconds. */
  kick(J = 40, ms = 1) { this.kickJ = J; this.kickLeft = ms; }

  /** One step of dt model ms at applied current J and temperature (C). */
  step(dt, J, tempC = HH.T0) {
    const phi = Math.pow(3, (tempC - HH.T0) / 10);
    const r = hhRates(this.u, this.r);
    let a = phi * r.am, b = phi * r.bm, s = a + b;
    this.m = a / s + (this.m - a / s) * Math.exp(-s * dt);
    a = phi * r.an; b = phi * r.bn; s = a + b;
    this.n = a / s + (this.n - a / s) * Math.exp(-s * dt);
    a = phi * r.ah; b = phi * r.bh; s = a + b;
    this.h = a / s + (this.h - a / s) * Math.exp(-s * dt);
    let I = J;
    if (this.kickLeft > 0) { I += this.kickJ * Math.min(1, this.kickLeft / dt); this.kickLeft -= dt; }
    const gna = HH.GNA * this.m * this.m * this.m * this.h, gk = HH.GK * this.n * this.n * this.n * this.n;
    const G = gna + gk + HH.GL;
    const uInf = (I + gna * HH.ENA + gk * HH.EK + HH.GL * HH.EL) / G;
    const prev = this.u;
    this.u = uInf + (this.u - uInf) * Math.exp(-G * dt);
    this.t += dt;
    if (prev < HH.SPIKE_MV && this.u >= HH.SPIKE_MV) { this.spikes++; this.lastSpikeT = this.t; return true; }
    return false;
  }

  /** Membrane potential as 0..1 (rest near 0.1, a spike's peak near 1). */
  get value() { return clamp((this.u + 12) / 117, 0, 1); }
}

// ======================================================================= Lorenz

export class Lorenz {
  constructor() { this.x = 1; this.y = 1; this.z = 20; this.k = new Float64Array(12); }
  /** Advance by dt model time units (RK4, h <= 0.004). */
  advance(dt) {
    const steps = Math.max(1, Math.min(2000, Math.ceil(dt / 0.004)));
    const h = dt / steps, k = this.k;
    for (let i = 0; i < steps; i++) {
      const f = (x, y, z, o) => { k[o] = 10 * (y - x); k[o + 1] = x * (28 - z) - y; k[o + 2] = x * y - (8 / 3) * z; };
      const { x, y, z } = this;
      f(x, y, z, 0);
      f(x + 0.5 * h * k[0], y + 0.5 * h * k[1], z + 0.5 * h * k[2], 3);
      f(x + 0.5 * h * k[3], y + 0.5 * h * k[4], z + 0.5 * h * k[5], 6);
      f(x + h * k[6], y + h * k[7], z + h * k[8], 9);
      this.x += (h / 6) * (k[0] + 2 * k[3] + 2 * k[6] + k[9]);
      this.y += (h / 6) * (k[1] + 2 * k[4] + 2 * k[7] + k[10]);
      this.z += (h / 6) * (k[2] + 2 * k[5] + 2 * k[8] + k[11]);
    }
  }
  /** -1..1 (x stays within about +-20 on the attractor). */
  get value() { return clamp(this.x / 20, -1, 1); }
}

// ===================================================================== Pendulum

/**
 * The classical double pendulum of ChaseHendrick/double-pendulum (code/dp.h):
 * m1 = m2 = 1, l1 = l2 = 1, g = 1, angles from the downward vertical,
 * H = (p1^2 + 2 p2^2 - 2 c p1 p2) / (2 D) - 2 cos t1 - cos t2,
 * c = cos(t1 - t2), D = 1 + sin^2(t1 - t2). Rest is E = -3; the lower arm can
 * turn over above E = -1 and the upper arm above E = 1.
 */
export const PENDULUM = Object.freeze({ E_MIN: -2.95, E_MAX: 4, H: 0.005 });

export function pendulumEnergy(t1, t2, p1, p2) {
  const c = Math.cos(t1 - t2), s = Math.sin(t1 - t2), D = 1 + s * s;
  return (p1 * p1 + 2 * p2 * p2 - 2 * c * p1 * p2) / (2 * D) - 2 * Math.cos(t1) - Math.cos(t2);
}

function pendulumField(t1, t2, p1, p2, out, o) {
  const c = Math.cos(t1 - t2), s = Math.sin(t1 - t2), D = 1 + s * s;
  const q = (p1 * p2 - c * (p1 * p1 + 2 * p2 * p2 - 2 * c * p1 * p2) / D) / D;
  out[o] = (p1 - c * p2) / D;
  out[o + 1] = (2 * p2 - c * p1) / D;
  out[o + 2] = -s * q - 2 * Math.sin(t1);
  out[o + 3] = s * q - Math.sin(t2);
}

export class DoublePendulum {
  constructor(E = 0, seed = 0) {
    this.k = new Float64Array(16);
    this.E = clamp(E, PENDULUM.E_MIN, PENDULUM.E_MAX);
    this.place(this.E, seed);
  }

  /**
   * Start on the Poincare section t1 = 0 (dp.h): t2 = 0, p2 chosen, p1 lifted
   * from the energy so dt1/dt > 0. `seed` nudges p2 (deterministically).
   */
  place(E, seed = 0) {
    this.E = clamp(E, PENDULUM.E_MIN, PENDULUM.E_MAX);
    const room = 2 * (this.E + 3);                                // 2(E + 2 + cos 0) at t2 = 0
    const p2 = -Math.sqrt(room) * (0.55 + 0.05 * Math.sin(seed * 12.9898));
    const D = 1;                                                  // 1 + sin^2(0)
    this.t1 = 0; this.t2 = 0; this.p2 = p2;
    this.p1 = 1 * p2 + Math.sqrt(Math.max(0, D * (room - p2 * p2)));
  }

  setEnergy(E) { this.E = clamp(E, PENDULUM.E_MIN, PENDULUM.E_MAX); }

  /** Rescale the momenta so the energy is this.E again (kinetic energy is quadratic in p). */
  project() {
    const c = Math.cos(this.t1 - this.t2);
    const V = -2 * Math.cos(this.t1) - Math.cos(this.t2);
    const T = pendulumEnergy(this.t1, this.t2, this.p1, this.p2) - V;
    const want = this.E - V;
    if (T > 1e-9 && want > 0) { const k = Math.sqrt(want / T); this.p1 *= k; this.p2 *= k; }
    else if (want <= 0) { this.p1 *= 0.98; this.p2 *= 0.98; }      // below the shell here: settle gently
    return c;
  }

  /** Advance by dt time units (sqrt(l/g)), RK4 at h <= 0.005, held on the energy shell. */
  advance(dt) {
    const steps = Math.max(1, Math.min(4000, Math.ceil(Math.abs(dt) / PENDULUM.H)));
    const h = dt / steps, k = this.k;
    for (let i = 0; i < steps; i++) {
      const { t1, t2, p1, p2 } = this;
      pendulumField(t1, t2, p1, p2, k, 0);
      pendulumField(t1 + 0.5 * h * k[0], t2 + 0.5 * h * k[1], p1 + 0.5 * h * k[2], p2 + 0.5 * h * k[3], k, 4);
      pendulumField(t1 + 0.5 * h * k[4], t2 + 0.5 * h * k[5], p1 + 0.5 * h * k[6], p2 + 0.5 * h * k[7], k, 8);
      pendulumField(t1 + h * k[8], t2 + h * k[9], p1 + h * k[10], p2 + h * k[11], k, 12);
      this.t1 += (h / 6) * (k[0] + 2 * k[4] + 2 * k[8] + k[12]);
      this.t2 += (h / 6) * (k[1] + 2 * k[5] + 2 * k[9] + k[13]);
      this.p1 += (h / 6) * (k[2] + 2 * k[6] + 2 * k[10] + k[14]);
      this.p2 += (h / 6) * (k[3] + 2 * k[7] + 2 * k[11] + k[15]);
      this.project();
    }
    // keep the angles small numbers (they wind when an arm turns over)
    if (Math.abs(this.t1) > 1e3) this.t1 -= TAU * Math.round(this.t1 / TAU);
    if (Math.abs(this.t2) > 1e3) this.t2 -= TAU * Math.round(this.t2 / TAU);
  }

  get energy() { return pendulumEnergy(this.t1, this.t2, this.p1, this.p2); }
  /** sin of each angle, -1..1. */
  get value1() { return Math.sin(this.t1); }
  get value2() { return Math.sin(this.t2); }
}

// ================================================================ Smooth random

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stationary variance of the last stage of a k-stage cascade y_i <- a y_i + (1 - a) y_{i-1}, y_0 white (var 1). */
export function cascadeVariance(k, a) {
  // covariance of the state vector, iterated to its fixed point (k <= 3, so tiny)
  const n = k;
  let S = new Float64Array(n * n);
  const b = 1 - a;
  for (let it = 0; it < 20000; it++) {
    // y' = A y + B w with A lower-bidiagonal (a on the diagonal, b below), B = (b, 0, ...)
    const N = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let v = a * a * S[i * n + j];
        if (i > 0) v += a * b * S[(i - 1) * n + j];
        if (j > 0) v += a * b * S[i * n + j - 1];
        if (i > 0 && j > 0) v += b * b * S[(i - 1) * n + j - 1];
        if (i === 0 && j === 0) v += b * b;
        N[i * n + j] = v;
      }
    }
    let diff = 0;
    for (let i = 0; i < n * n; i++) diff = Math.max(diff, Math.abs(N[i] - S[i]));
    S = N;
    if (diff < 1e-12 * Math.max(1e-300, S[n * n - 1])) break;
  }
  return S[n * n - 1];
}

/**
 * Smooth random modulation with Matern-type smoothness: k cascaded one-pole
 * low-passes of white noise have the spectrum (lambda^2 + w^2)^-k, the Matern
 * family with nu = k - 1/2 (k = 1 is the rough Ornstein-Uhlenbeck process).
 * lambda = sqrt(2 nu) / ell sets the correlation time ell (seconds).
 */
export class SmoothRandom {
  constructor(seed = 1) {
    this.rand = mulberry32(seed);
    this.y = new Float64Array(3);
    this.k = 2; this.ell = 1;
    this.cacheKey = ''; this.sd = 1;
    this.spare = NaN;
  }
  gauss() {
    if (Number.isFinite(this.spare)) { const s = this.spare; this.spare = NaN; return s; }
    let u = 0, v = 0;
    while (u <= 1e-12) u = this.rand();
    v = this.rand();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(TAU * v);
    return r * Math.cos(TAU * v);
  }
  /** Advance by dt seconds with smoothness k (1..3) and correlation time ell (s). */
  advance(dt, k = this.k, ell = this.ell) {
    this.k = clamp(Math.round(k), 1, 3); this.ell = Math.max(1e-3, ell);
    const lambda = Math.sqrt(2 * this.k - 1) / this.ell;
    const a = Math.exp(-lambda * Math.max(1e-6, dt));
    const key = `${this.k}|${a.toFixed(9)}`;
    if (key !== this.cacheKey) { this.cacheKey = key; this.sd = Math.sqrt(cascadeVariance(this.k, a)); }
    let prev = this.gauss();
    for (let i = 0; i < this.k; i++) { this.y[i] = a * this.y[i] + (1 - a) * prev; prev = this.y[i]; }
    this.z = prev / this.sd;
  }
  /** -1..1: tanh of half the unit-variance value (about +-0.76 at two standard deviations). */
  get value() { return Math.tanh(0.5 * (this.z || 0)); }
}

// ===================================================================== Collapse

/**
 * Three-vortex collapse of minimal-winding Sec. 3: circulations (1, mu, -mu/(1+mu)),
 * positions eq:pos and winding P(theta) eq:Ptheta on the collapsing arcs
 * A+ = (0, theta0) and A- = (pi, 2 pi - theta0), cos theta0 = (mu - 1) / (2 sqrt R).
 */
export function threeVortex(mu, theta) {
  const R = 1 + mu + mu * mu, sR = Math.sqrt(R), k = (1 + mu) * (1 + mu);
  const ex = Math.cos(theta), ey = -Math.sin(theta);             // e^{-i theta}
  const z1 = [mu * (1 + sR * ex) / k, mu * sR * ey / k];
  const z2 = [(mu - sR * ex) / k, -sR * ey / k];
  const z3 = [1, 0];
  return [z1, z2, z3];
}

export function threeVortexP(mu, theta) {
  const R = 1 + mu + mu * mu, sR = Math.sqrt(R), C = sR * Math.cos(theta);
  const N = 2 * (1 + mu * mu) * R + (1 - mu) * (2 + mu + 2 * mu * mu) * C - 2 * mu * C * C;
  const M = 1 - mu + 2 * C;
  return N / (2 * mu * sR * M * Math.sin(theta));
}

/** Least P on one collapsing arc, by golden-section search on a bracketed minimum. */
export function threeVortexMinimum(mu, arc = '+') {
  const R = 1 + mu + mu * mu;
  const th0 = Math.acos((mu - 1) / (2 * Math.sqrt(R)));
  const [lo, hi] = arc === '+' ? [0, th0] : [Math.PI, 2 * Math.PI - th0];
  // coarse scan, then golden section around the best sample
  const f = (t) => threeVortexP(mu, t);
  let best = lo, bv = Infinity;
  const n = 4000;
  for (let i = 1; i < n; i++) { const t = lo + ((hi - lo) * i) / n; const v = f(t); if (v > 0 && v < bv) { bv = v; best = t; } }
  let a = best - (hi - lo) / n, b = best + (hi - lo) / n;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 200; i++) {
    const c = b - g * (b - a), d = a + g * (b - a);
    if (f(c) < f(d)) b = d; else a = c;
  }
  const theta = 0.5 * (a + b);
  return { theta, P: f(theta) };
}

function normalise(points) {
  let r = 0;
  for (const [x, y] of points) r = Math.max(r, Math.hypot(x, y));
  return points.map(([x, y]) => [x / r, y / r]);
}

function buildPresets() {
  const list = [];
  const add = (name, mu, arc) => {
    const { theta, P } = threeVortexMinimum(mu, arc);
    list.push(Object.freeze({ name, P, points: Object.freeze(normalise(threeVortex(mu, theta))) }));
  };
  add('Three vortices (1, 1, -1/2)', 1, '+');
  // mu = 1/2: the two arcs have different least windings (minimal-winding Prop. half)
  const plus = threeVortexMinimum(0.5, '+'), minus = threeVortexMinimum(0.5, '-');
  const tight = plus.P < minus.P ? '+' : '-', wide = tight === '+' ? '-' : '+';
  add('Three vortices, tight', 0.5, tight);
  add('Three vortices, wide', 0.5, wide);
  // Theorem four (b): the four-vortex minimiser, kappa = -1 + i b, b = 2 P4, z_c = 0
  list.push(Object.freeze({
    name: 'Four vortices (least winding)',
    P: 0.79789678387986348076760587182,
    points: Object.freeze(normalise([
      [0.0166495669172, 0],
      [-0.2191226402232, -0.3290676220068],
      [-0.1579874300122, -0.2864759934272],
      [-0.1605333843048, -0.3736601672808],
    ])),
  }));
  return Object.freeze(list);
}

export const COLLAPSE_PRESETS = buildPresets();
export const COLLAPSE_NAMES = COLLAPSE_PRESETS.map(p => p.name);
export const COLLAPSE_BARS = [0.5, 1, 2, 4, 8, 16];
export const COLLAPSE_MIN_SIZE = 0.03;
// Turing step lengths in beats, in the order of params SYNC_DIVS (4 bars .. 1/16)
export const TURING_DIVS = [16, 8, 4, 2, 1.5, 1, 0.75, 2 / 3, 0.5, 0.375, 1 / 3, 0.25];      // lambda at the end of a collapse (total turn P ln(1/lambda^2))

/**
 * Where the configuration is at cycle phase tau (0..1): lambda^2 falls
 * linearly in time (as in the real collapse, lambda^2 = 1 + 2 Re(kappa) t) down
 * to COLLAPSE_MIN_SIZE^2, and the shape turns by phi = -P ln lambda^2.
 * `expand` runs it backwards.
 */
export function collapseState(tau, P, expand = false, out = { lambda: 1, phi: 0 }) {
  let t = tau - Math.floor(tau);
  if (expand) t = 1 - t;
  const l2 = 1 - t * (1 - COLLAPSE_MIN_SIZE * COLLAPSE_MIN_SIZE);
  out.lambda = Math.sqrt(l2);
  out.phi = -P * Math.log(l2);
  return out;
}

// ================================================================ Science bank

/** Indices into ScienceBank.out (the order of the Links sources). */
export const SCI = Object.freeze({ NEURON: 0, SPIKE: 1, LORENZ: 2, PEND1: 3, PEND2: 4, SMOOTH: 5, COLLAPSE: 6, TURING: 7 });
export const SCIENCE_OUTPUTS = 8;

/**
 * Turing (v2.4): a looping random sequence, as on a shift-register "Turing
 * machine". Each step rotates a 16-bit register by one; the bit coming round
 * flips with probability Chance (0 = a locked loop of Length steps, 1 = always
 * new). The output is the low Length bits as a number, 0..1.
 */
export class Turing {
  constructor(seed = 7) { this.rand = mulberry32(seed * 7919 + 1); this.reg = (this.rand() * 65536) | 0; this.step = -1; this.value = (this.reg & 255) / 255; }
  advance(step, chance, length) {
    if (step === this.step) return;
    const L = Math.max(2, Math.min(16, Math.round(length)));
    const n = this.step < 0 || step < this.step || step - this.step > 64 ? 1 : step - this.step;
    for (let i = 0; i < n; i++) {
      let bit = (this.reg >>> (L - 1)) & 1;
      if (this.rand() < chance) bit ^= 1;
      this.reg = ((this.reg << 1) | bit) & 0xffff;
    }
    this.step = step;
    this.value = (this.reg & ((1 << L) - 1)) / ((1 << L) - 1);
  }
}

/**
 * Every science generator for the whole synth, stepped once per control
 * block. configure() takes the global parameters (see GLOBAL_PARAMS group
 * 'science' in src/core/params.js).
 */
export class ScienceBank {
  constructor(seed = 1) {
    this.neuron = new HHNeuron();
    this.lorenz = new Lorenz();
    this.pendulum = new DoublePendulum(0, seed);
    this.smooth = new SmoothRandom(seed);
    this.out = new Float64Array(SCIENCE_OUTPUTS);
    this.cfg = {
      neuronCurrent: 8, neuronKick: 0.5, neuronTemp: HH.T0, neuronRate: 0.05,
      lorenzRate: 0.5, pendEnergy: 0, pendRate: 1, smoothTime: 1, smoothness: 1,
      collapseShape: 0, collapseBars: 3, collapseDir: 0,
      turingChance: 0.1, turingLength: 8, turingDiv: 11,
    };
    this.turing = new Turing(seed);
    this.cs = { lambda: 1, phi: 0 };
    this.freeBeats = 0;
    this.spikeDecay = 0.04;      // seconds
  }

  configure(p) {
    if (!p) return;
    for (const k of Object.keys(this.cfg)) if (Number.isFinite(p[k])) this.cfg[k] = p[k];
    this.pendulum.setEnergy(this.cfg.pendEnergy);
  }

  /** A note started: kick the neuron (strength 0..1 of a 1 ms, 60 uA/cm^2 pulse). */
  noteOn() { if (this.cfg.neuronKick > 0) this.neuron.kick(60 * this.cfg.neuronKick, 1); }

  /**
   * Advance by dt seconds. beats: the transport position in beats when it is
   * playing (null when stopped: the collapse then runs on its own clock at
   * spb seconds per beat).
   */
  step(dt, beats = null, spb = 0.5) {
    const c = this.cfg, o = this.out;
    // Neuron: rate is model time per real time (1 = real time, so ~62 Hz spike trains at J = 8)
    const modelMs = Math.max(0, c.neuronRate) * dt * 1000;
    const n = Math.min(4000, Math.ceil(modelMs / HH.DT));
    let spiked = false;
    if (n > 0) { const h = modelMs / n; for (let i = 0; i < n; i++) spiked = this.neuron.step(h, c.neuronCurrent, c.neuronTemp) || spiked; }
    this.neuron.spike = spiked ? 1 : this.neuron.spike * Math.exp(-dt / this.spikeDecay);
    o[SCI.NEURON] = this.neuron.value;
    o[SCI.SPIKE] = this.neuron.spike;
    this.lorenz.advance(Math.max(0, c.lorenzRate) * dt);
    o[SCI.LORENZ] = this.lorenz.value;
    this.pendulum.advance(Math.max(0, c.pendRate) * dt);
    o[SCI.PEND1] = this.pendulum.value1;
    o[SCI.PEND2] = this.pendulum.value2;
    this.smooth.advance(dt, 1 + Math.round(c.smoothness), c.smoothTime);
    o[SCI.SMOOTH] = this.smooth.value;
    // Collapse: one cycle every COLLAPSE_BARS[i] bars of 4 beats
    const bars = COLLAPSE_BARS[clamp(Math.round(c.collapseBars), 0, COLLAPSE_BARS.length - 1)];
    if (beats === null || !Number.isFinite(beats)) { this.freeBeats += dt / Math.max(0.05, spb); beats = this.freeBeats; }
    else this.freeBeats = beats;
    const preset = COLLAPSE_PRESETS[clamp(Math.round(c.collapseShape), 0, COLLAPSE_PRESETS.length - 1)];
    collapseState(beats / (bars * 4), preset.P, Math.round(c.collapseDir) === 1, this.cs);
    o[SCI.COLLAPSE] = 1 - this.cs.lambda;
    // Turing: one step per tempo division (TURING_DIVS beats), on the same beat clock
    const div = TURING_DIVS[clamp(Math.round(c.turingDiv), 0, TURING_DIVS.length - 1)];
    this.turing.advance(Math.floor(beats / div), clamp(c.turingChance, 0, 1), c.turingLength);
    o[SCI.TURING] = this.turing.value;
  }

  /** Swirl X and Y (-1..1) of voice slot v: vortex v mod N of the chosen shape, as it turns and shrinks. */
  swirl(v, out) {
    const preset = COLLAPSE_PRESETS[clamp(Math.round(this.cfg.collapseShape), 0, COLLAPSE_PRESETS.length - 1)];
    const [x, y] = preset.points[((v % preset.points.length) + preset.points.length) % preset.points.length];
    const { lambda, phi } = this.cs, c = Math.cos(phi), s = Math.sin(phi);
    out.x = lambda * (c * x - s * y);
    out.y = lambda * (s * x + c * y);
    return out;
  }
}
