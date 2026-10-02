// Dot behaviours: Pin (still), Roll (a marble on the displayed terrain) and
// Drift (a slow, smooth wander).
//
// Roll uses Rapier (lazy-loaded the first time any part rolls) with a ball on a
// heightfield collider sampled from the part's blended terrain over all 3 x 3
// tiles. While Rapier loads, or if it cannot load at all (e.g. a strict CSP
// blocks WebAssembly), a small built-in integrator rolls the ball on the
// analytic height gradient instead, tuned to feel the same. Because the
// terrain tiles, a ball leaving the centre tile is simply shifted by one tile.
//
// Positions are world units (see heightfield.js); the centre tile is
// x, z in [-W/2, W/2).

import { W, xToU, uToX, wrapWorld, wrap01, wrapDelta } from './heightfield.js';
import { mulberry32, TAU } from '../dsp/terrain-math.js';

export const BALL_RADIUS = 0.21;
export const MODE_PIN = 0, MODE_ROLL = 1, MODE_DRIFT = 2;

// A solid sphere rolling without slipping accelerates at 5/7 of a sliding one.
const ROLL_FACTOR = 5 / 7;
const MAX_SPEED = 30;            // world units / s
const FIXED_DT = 1 / 120;
const SUBSTEP = 1 / 240;
const HF_PER_TILE = 64;
const REBUILD_INTERVAL = 0.125;  // s, at most ~8 Hz

/** dot.gravity 0..1 -> world units / s^2. */
export function gravityFromParam(g) {
  const v = Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 0.6;
  return 1.5 + 20 * v;
}

/** dot.friction 0..1 -> velocity decay rate (1 / s). */
export function dampingFromParam(f) {
  const v = Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0.25;
  return 0.12 + 3.2 * v * v;
}

/** dot.driftSpeed 0..1 -> wander speed in tiles / s. */
export function driftRate(s) {
  const v = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.3;
  return 0.11 * Math.pow(v, 1.2);
}

const _g = { x: 0, z: 0 };

/**
 * Built-in rolling ball: semi-implicit Euler on the surface gradient. For a
 * heightfield y = f(x, z) the horizontal acceleration of a ball held to the
 * surface is -g ∇f / (1 + |∇f|²); the 5/7 accounts for rolling inertia.
 */
export class FallbackBall {
  constructor() {
    this.x = 0; this.z = 0; this.vx = 0; this.vz = 0;
  }

  place(x, z) {
    this.x = wrapWorld(x); this.z = wrapWorld(z);
    this.vx = 0; this.vz = 0;
  }

  setVelocity(vx, vz) { this.vx = vx; this.vz = vz; }

  step(hf, dt, gravity, damping) {
    if (!(dt > 0)) return;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    const decay = Math.exp(-damping * h);
    for (let i = 0; i < n; i++) {
      hf.gradient(this.x, this.z, _g);
      const denom = 1 + _g.x * _g.x + _g.z * _g.z;
      this.vx = (this.vx - ROLL_FACTOR * gravity * (_g.x / denom) * h) * decay;
      this.vz = (this.vz - ROLL_FACTOR * gravity * (_g.z / denom) * h) * decay;
      const sp = Math.sqrt(this.vx * this.vx + this.vz * this.vz);
      if (sp > MAX_SPEED) { this.vx *= MAX_SPEED / sp; this.vz *= MAX_SPEED / sp; }
      this.x += this.vx * h;
      this.z += this.vz * h;
    }
    this.x = wrapWorld(this.x);
    this.z = wrapWorld(this.z);
  }

  get speed() { return Math.sqrt(this.vx * this.vx + this.vz * this.vz); }
}

/**
 * Smooth wander on the torus. The heading is a sum of three slow sines with
 * seeded, incommensurate rates, so the path curls gently and never repeats.
 */
export class Drifter {
  constructor(seed = 1) {
    const rng = mulberry32(0x0d71f7 + seed * 977);
    this.t = rng() * 100;
    this.heading = rng();
    this.f = [0.071 + 0.02 * rng(), 0.113 + 0.03 * rng(), 0.197 + 0.04 * rng(), 0.053 + 0.02 * rng()];
    this.p = [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
    this.u = 0.5; this.v = 0.5;
    this.vu = 0; this.vv = 0;
  }

  place(u, v) { this.u = wrap01(u); this.v = wrap01(v); }

  step(dt, speedParam) {
    const rate = driftRate(speedParam);
    if (!(dt > 0) || rate <= 0) { this.vu = 0; this.vv = 0; return; }
    this.t += dt * (0.35 + 1.4 * speedParam);
    const f = this.f, p = this.p, t = this.t;
    const ang = TAU * (this.heading + 0.37 * Math.sin(f[0] * t + p[0]) + 0.23 * Math.sin(f[1] * t + p[1]) + 0.13 * Math.sin(f[2] * t + p[2]));
    const sp = rate * (0.78 + 0.22 * Math.sin(f[3] * t + p[3]));
    this.vu = Math.cos(ang) * sp;
    this.vv = Math.sin(ang) * sp;
    this.u = wrap01(this.u + this.vu * dt);
    this.v = wrap01(this.v + this.vv * dt);
  }
}

// ---------------------------------------------------------------------------
// Rapier, loaded on first use.

let rapierPromise = null;
let rapierState = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'

/** Lazily import and initialise Rapier. Resolves to the module or null on failure. */
export function loadRapier(importer) {
  if (rapierPromise) return rapierPromise;
  rapierState = 'loading';
  const load = importer || (() => import('@dimforge/rapier3d-compat'));
  rapierPromise = Promise.resolve()
    .then(load)
    .then(async (mod) => {
      const R = mod && (mod.default || mod);
      if (!R || typeof R.init !== 'function') throw new Error('Rapier module has no init()');
      await R.init();
      rapierState = 'ready';
      return R;
    })
    .catch((err) => {
      rapierState = 'failed';
      console.warn('[visuals] Rapier unavailable, using the built-in marble physics:', err && err.message ? err.message : err);
      return null;
    });
  return rapierPromise;
}

export function rapierStatus() { return rapierState; }

/** One Rapier world per rolling part: a ball on a 3 x 3 tile heightfield. */
export class RapierBall {
  constructor(R) {
    this.R = R;
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this.body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, 2, 0).setCcdEnabled(true).setCanSleep(false));
    this.ball = this.world.createCollider(
      R.ColliderDesc.ball(BALL_RADIUS).setRestitution(0.3).setFriction(0.7).setDensity(1.2), this.body);
    this.ground = null;
    this.subdiv = HF_PER_TILE * 3;
    this.heights = new Float32Array((this.subdiv + 1) * (this.subdiv + 1));
    this.builtVersion = -1;
    this.lastBuild = -Infinity;
    this.acc = 0;
    this.gravity = -1;
    this.damping = -1;
    this.x = 0; this.y = 0; this.z = 0; this.vx = 0; this.vz = 0;
  }

  /** Re-sample the heightfield collider from the field (column-major, rows along z). */
  rebuild(hf) {
    const R = this.R, n = this.subdiv, ext = 1.5 * W, step = (2 * ext) / n, hts = this.heights;
    for (let c = 0; c <= n; c++) {
      const x = -ext + c * step;
      const base = c * (n + 1);
      for (let r = 0; r <= n; r++) hts[base + r] = hf.yAt(x, -ext + r * step);
    }
    if (this.ground) this.world.removeCollider(this.ground, false);
    this.ground = this.world.createCollider(
      R.ColliderDesc.heightfield(n, n, hts, { x: 2 * ext, y: 1, z: 2 * ext }).setFriction(0.7).setRestitution(0.3));
    this.builtVersion = hf.version;
  }

  maybeRebuild(hf, now) {
    if (hf.version === this.builtVersion) return;
    if (this.ground && now - this.lastBuild < REBUILD_INTERVAL) return;
    this.lastBuild = now;
    // The surface may have risen under the ball: keep it from ending up inside.
    const p = this.body.translation();
    this.rebuild(hf);
    const floor = hf.yAt(p.x, p.z) + BALL_RADIUS;
    if (p.y < floor) this.body.setTranslation({ x: p.x, y: floor + 0.01, z: p.z }, true);
  }

  setTuning(gravity, damping) {
    if (gravity !== this.gravity) {
      this.gravity = gravity;
      this.world.gravity = { x: 0, y: -gravity, z: 0 };
    }
    if (damping !== this.damping) {
      this.damping = damping;
      // Rapier damps both linear and angular motion; rolling couples them, so
      // split the decay between the two to land near the fallback's feel.
      this.body.setLinearDamping(damping * 0.55);
      this.body.setAngularDamping(damping * 0.55);
    }
  }

  place(hf, x, z, vx = 0, vz = 0) {
    const y = hf.yAt(x, z) + BALL_RADIUS + 0.005;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel({ x: vx, y: 0, z: vz }, true);
    this.body.setAngvel({ x: vz / BALL_RADIUS, y: 0, z: -vx / BALL_RADIUS }, true);
    this.x = x; this.y = y; this.z = z; this.vx = vx; this.vz = vz;
  }

  step(hf, dt) {
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= FIXED_DT) {
      this.world.step();
      this.acc -= FIXED_DT;
    }
    const p = this.body.translation();
    let x = p.x, y = p.y, z = p.z;
    const wx = wrapWorld(x), wz = wrapWorld(z);
    if (wx !== x || wz !== z) {
      this.body.setTranslation({ x: wx, y, z: wz }, true);
      x = wx; z = wz;
    }
    // A tunnelled or launched ball comes back to the surface.
    const floor = hf.yAt(x, z);
    if (!(y > floor - 0.5) || !(y < floor + 40) || !Number.isFinite(x + y + z)) {
      this.place(hf, Number.isFinite(x) ? x : 0, Number.isFinite(z) ? z : 0);
      y = floor + BALL_RADIUS;
    }
    const v = this.body.linvel();
    let vx = v.x, vz = v.z;
    const sp = Math.sqrt(vx * vx + vz * vz);
    if (sp > MAX_SPEED) {
      vx *= MAX_SPEED / sp; vz *= MAX_SPEED / sp;
      this.body.setLinvel({ x: vx, y: v.y, z: vz }, true);
    }
    this.x = x; this.y = y; this.z = z; this.vx = vx; this.vz = vz;
  }

  dispose() {
    try { this.world.free(); } catch { /* already freed */ }
  }
}

// ---------------------------------------------------------------------------
// Per-part manager.

/**
 * createPhysics({ fieldFor(part) -> HeightField, rapier: true|false, importer })
 * Positions are reported as wrapped terrain coordinates plus world position.
 */
export function createPhysics({ fieldFor, rapier = true, importer = null, parts = 4 } = {}) {
  const states = [];
  for (let i = 0; i < parts; i++) {
    states.push({
      mode: MODE_PIN,
      gravity: gravityFromParam(0.6),
      damping: dampingFromParam(0.25),
      drift: 0.3,
      fallback: new FallbackBall(),
      rapier: null,
      drifter: new Drifter(i + 1),
      held: false,
      u: 0.5, v: 0.5, x: 0, y: 0, z: 0, vx: 0, vz: 0,
    });
  }
  let R = null;
  let time = 0;
  let disposed = false;

  function want() {
    if (!rapier || R || rapierStatus() === 'failed') return;
    loadRapier(importer).then((mod) => {
      if (!mod || disposed) return;
      R = mod;
      // Hand every rolling part over to Rapier, keeping position and speed.
      for (let p = 0; p < states.length; p++) if (states[p].mode === MODE_ROLL) attachRapier(p);
    });
  }

  function attachRapier(p) {
    const s = states[p];
    if (!R || s.rapier) return;
    try {
      const hf = fieldFor(p);
      const rb = new RapierBall(R);
      rb.rebuild(hf);
      rb.setTuning(s.gravity, s.damping);
      rb.place(hf, s.fallback.x, s.fallback.z, s.fallback.vx, s.fallback.vz);
      rb.lastBuild = time;
      s.rapier = rb;
    } catch (err) {
      console.warn('[visuals] Rapier world failed, staying on the built-in marble:', err);
    }
  }

  function detachRapier(p) {
    const s = states[p];
    if (s.rapier) { s.rapier.dispose(); s.rapier = null; }
  }

  function sync(p) {
    const s = states[p];
    const hf = fieldFor(p);
    if (s.mode === MODE_ROLL) {
      const src = s.rapier || s.fallback;
      s.x = src.x; s.z = src.z; s.vx = src.vx; s.vz = src.vz;
      s.y = s.rapier ? Math.max(s.rapier.y, hf.yAt(s.x, s.z) + BALL_RADIUS) : hf.yAt(s.x, s.z) + BALL_RADIUS;
      s.u = wrap01(xToU(s.x)); s.v = wrap01(xToU(s.z));
    } else if (s.mode === MODE_DRIFT) {
      s.u = s.drifter.u; s.v = s.drifter.v;
      s.x = wrapWorld(uToX(s.u)); s.z = wrapWorld(uToX(s.v));
      s.vx = s.drifter.vu * W; s.vz = s.drifter.vv * W;
      s.y = hf.yAt(s.x, s.z) + BALL_RADIUS;
    }
  }

  function place(p, u, v, vx = 0, vz = 0) {
    const s = states[p];
    const x = wrapWorld(uToX(u)), z = wrapWorld(uToX(v));
    s.fallback.place(x, z);
    s.fallback.setVelocity(vx, vz);
    if (s.rapier) s.rapier.place(fieldFor(p), x, z, vx, vz);
    s.drifter.place(u, v);
    sync(p);
  }

  return {
    get rapierReady() { return !!R; },

    engineName(p) {
      const s = states[p];
      if (s.mode === MODE_ROLL) return s.rapier ? 'rapier' : 'fallback';
      if (s.mode === MODE_DRIFT) return 'drift';
      return 'pin';
    },

    mode(p) { return states[p].mode; },

    isActive(p) { return states[p].mode !== MODE_PIN; },

    anyActive() { return states.some(s => s.mode !== MODE_PIN); },

    setMode(p, mode, u, v) {
      const s = states[p];
      const m = mode === MODE_ROLL || mode === MODE_DRIFT ? mode : MODE_PIN;
      if (m === s.mode) return;
      s.mode = m;
      if (m !== MODE_ROLL) detachRapier(p);
      place(p, u, v);
      if (m === MODE_ROLL) {
        want();
        if (R) attachRapier(p);
      }
    },

    setParams(p, dot) {
      const s = states[p];
      s.gravity = gravityFromParam(dot && dot.gravity);
      s.damping = dampingFromParam(dot && dot.friction);
      s.drift = dot && Number.isFinite(dot.driftSpeed) ? dot.driftSpeed : 0.3;
      if (s.rapier) s.rapier.setTuning(s.gravity, s.damping);
    },

    /** The user (or another module) moved the dot: put the ball there at rest. */
    teleport(p, u, v) { place(p, u, v); },

    /** User is dragging the dot: it follows exactly, physics paused for it. */
    hold(p, u, v) {
      const s = states[p];
      s.held = true;
      place(p, u, v);
    },

    /** Let go; in Roll mode the ball keeps the throw velocity (world units / s). */
    release(p, vx = 0, vz = 0) {
      const s = states[p];
      s.held = false;
      if (s.mode !== MODE_ROLL) return;
      const sp = Math.sqrt(vx * vx + vz * vz);
      const k = sp > MAX_SPEED ? MAX_SPEED / sp : 1;
      s.fallback.setVelocity(vx * k, vz * k);
      if (s.rapier) s.rapier.place(fieldFor(p), s.fallback.x, s.fallback.z, vx * k, vz * k);
      sync(p);
    },

    step(dt) {
      if (!(dt > 0)) return;
      const h = Math.min(dt, 0.1);
      time += h;
      for (let p = 0; p < states.length; p++) {
        const s = states[p];
        if (s.mode === MODE_PIN || s.held) continue;
        const hf = fieldFor(p);
        if (!hf || !hf.ready) continue;
        if (s.mode === MODE_ROLL) {
          if (s.rapier) {
            s.rapier.setTuning(s.gravity, s.damping);
            s.rapier.maybeRebuild(hf, time);
            s.rapier.step(hf, h);
            // keep the fallback in step so a later handover is seamless
            s.fallback.x = s.rapier.x; s.fallback.z = s.rapier.z;
            s.fallback.vx = s.rapier.vx; s.fallback.vz = s.rapier.vz;
          } else {
            s.fallback.step(hf, h, s.gravity, s.damping);
          }
        } else {
          s.drifter.step(h, s.drift);
        }
        sync(p);
      }
    },

    /** Current state of a part: u, v (wrapped), x, y, z (world, centre tile), vx, vz. */
    state(p) { return states[p]; },

    dispose() {
      disposed = true;
      for (let p = 0; p < states.length; p++) detachRapier(p);
    },
  };
}

/** Distance between two torus positions, in tiles (for tests and change detection). */
export function torusDistance(u0, v0, u1, v1) {
  const du = wrapDelta(u1, u0), dv = wrapDelta(v1, v0);
  return Math.sqrt(du * du + dv * dv);
}

