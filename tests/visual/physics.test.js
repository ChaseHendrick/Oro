import { describe, it, expect } from 'vitest';
import { HeightField, W } from '../../src/visual/heightfield.js';
import {
  FallbackBall, Drifter, createPhysics, gravityFromParam, dampingFromParam, driftRate,
  torusDistance, MODE_ROLL, MODE_DRIFT, MODE_PIN, MODE_EXPLORE, MODE_TOUR, RapierBall, BALL_RADIUS,
  G, MIN_GRAVITY, tiltAccel, flickScale, bounceFromParam,
} from '../../src/visual/physics.js';

// One smooth basin per tile with its lowest point at (u, v) = (0.5, 0.5).
function basinField(lift = 1) {
  const size = 128;
  const d = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      d[j * size + i] = 0.5 * (Math.cos(2 * Math.PI * u) + Math.cos(2 * Math.PI * v));
    }
  }
  const hf = new HeightField();
  hf.setTable('A', d, size);
  hf.setShape(0, 0, lift);
  return hf;
}

describe('fallback rolling ball', () => {
  it('settles at the bottom of a basin and loses energy over time', () => {
    const hf = basinField();
    const ball = new FallbackBall();
    ball.place(-2.6, 1.9); // up the side of the basin centred at the origin
    const g = gravityFromParam(0.6), damp = dampingFromParam(0.25);
    // potential (with the rolling factor) plus horizontal kinetic energy; the
    // integrator ignores vertical motion, so this is near- not exactly conserved
    const energy = () => g * (5 / 7) * hf.yAt(ball.x, ball.z) + 0.5 * (ball.vx * ball.vx + ball.vz * ball.vz);
    const e0 = energy();
    const drop = e0 - g * (5 / 7) * hf.yAt(0, 0);
    let maxE = e0;
    const perSecond = [];
    for (let i = 0; i < 60 * 40; i++) {
      ball.step(hf, 1 / 60, g, damp);
      maxE = Math.max(maxE, energy());
      if (i % 60 === 59) perSecond.push(energy());
    }
    expect(maxE - e0).toBeLessThan(0.03 * drop);
    for (let i = 1; i < perSecond.length; i++) expect(perSecond[i]).toBeLessThanOrEqual(perSecond[i - 1] + 1e-3 * drop);
    expect(Math.hypot(ball.x, ball.z)).toBeLessThan(0.15);
    expect(ball.speed).toBeLessThan(0.05);
  });

  it('wraps into the centre tile and keeps rolling seamlessly', () => {
    const hf = basinField();
    const ball = new FallbackBall();
    ball.place(4.9, 0);
    ball.setVelocity(6, 0);
    for (let i = 0; i < 30; i++) {
      ball.step(hf, 1 / 60, gravityFromParam(0.6), dampingFromParam(0.25));
      expect(ball.x).toBeGreaterThanOrEqual(-W / 2);
      expect(ball.x).toBeLessThan(W / 2);
    }
  });

  it('maps the dot knobs to sane physical ranges', () => {
    expect(gravityFromParam(0)).toBeGreaterThan(0);
    expect(gravityFromParam(1)).toBeGreaterThan(gravityFromParam(0.5));
    expect(dampingFromParam(1)).toBeGreaterThan(dampingFromParam(0));
    expect(driftRate(0)).toBe(0);
    expect(driftRate(1)).toBeGreaterThan(driftRate(0.3));
    expect(gravityFromParam(NaN)).toBe(gravityFromParam(0.5));
  });

  it('maps gravity 0..1 to 0..2 g (with a small floor), tilt to a lean, flick to a throw scale', () => {
    expect(gravityFromParam(0.5)).toBeCloseTo(G, 12);
    expect(gravityFromParam(1)).toBeCloseTo(2 * G, 12);
    expect(gravityFromParam(0)).toBe(MIN_GRAVITY);
    expect(gravityFromParam(7)).toBeCloseTo(2 * G, 12);
    expect(tiltAccel(0, G)).toBe(0);
    expect(tiltAccel(1, G)).toBeGreaterThan(0);
    expect(tiltAccel(-1, G)).toBeCloseTo(-tiltAccel(1, G), 12);
    expect(tiltAccel(1, G)).toBeLessThan(0.35 * G);
    expect(flickScale(0.5)).toBe(1);
    expect(flickScale(0)).toBe(0);
    expect(flickScale(1)).toBe(2);
    expect(bounceFromParam(2)).toBe(0.95);
  });

  it('rolls downhill across a tilted, perfectly flat world', () => {
    const size = 64;
    const hf = new HeightField();
    hf.setTable('A', new Float32Array(size * size), size);
    const ball = new FallbackBall();
    ball.place(0, 0);
    for (let i = 0; i < 60; i++) ball.step(hf, 1 / 60, G, dampingFromParam(0), tiltAccel(1, G), tiltAccel(-0.5, G));
    expect(ball.vx).toBeGreaterThan(0.5);
    expect(ball.vz).toBeLessThan(-0.2);
    expect(ball.vx).toBeGreaterThan(-ball.vz * 1.5);
  });
});

describe('drift', () => {
  it('wanders smoothly at about the requested speed and stays on the torus', () => {
    const d = new Drifter(3);
    d.place(0.2, 0.9);
    let pu = d.u, pv = d.v, travelled = 0, maxStep = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 20; i++) {
      d.step(dt, 0.5);
      const s = torusDistance(pu, pv, d.u, d.v);
      travelled += s;
      maxStep = Math.max(maxStep, s);
      expect(d.u).toBeGreaterThanOrEqual(0); expect(d.u).toBeLessThan(1);
      expect(d.v).toBeGreaterThanOrEqual(0); expect(d.v).toBeLessThan(1);
      pu = d.u; pv = d.v;
    }
    const rate = driftRate(0.5);
    expect(travelled / 20).toBeGreaterThan(rate * 0.5);
    expect(travelled / 20).toBeLessThan(rate * 1.1);
    expect(maxStep).toBeLessThan(rate * dt * 1.2);
  });

  it('stands still at speed 0', () => {
    const d = new Drifter(1);
    d.place(0.3, 0.3);
    for (let i = 0; i < 100; i++) d.step(1 / 60, 0);
    expect(d.u).toBeCloseTo(0.3, 12);
    expect(d.v).toBeCloseTo(0.3, 12);
  });
});

describe('physics manager (built-in integrator)', () => {
  it('rolls a part downhill, holds it while dragged and throws it on release', () => {
    const fields = [basinField(), basinField(), basinField(), basinField()];
    const ph = createPhysics({ fieldFor: p => fields[p], rapier: false });
    ph.setParams(0, { gravity: 0.6, friction: 0.25 });
    ph.setMode(0, MODE_ROLL, 0.3, 0.3);
    expect(ph.engineName(0)).toBe('fallback');
    for (let i = 0; i < 90; i++) ph.step(1 / 60);
    const s = ph.state(0);
    // moved towards the basin bottom at (0.5, 0.5)
    expect(torusDistance(s.u, s.v, 0.5, 0.5)).toBeLessThan(torusDistance(0.3, 0.3, 0.5, 0.5));

    ph.hold(0, 0.1, 0.8);
    for (let i = 0; i < 10; i++) ph.step(1 / 60);
    expect(ph.state(0).u).toBeCloseTo(0.1, 9);
    expect(ph.state(0).v).toBeCloseTo(0.8, 9);

    ph.release(0, 8, 0);
    ph.step(1 / 60);
    expect(ph.state(0).vx).toBeGreaterThan(5);

    // Flick 0: letting go just drops the marble; flick 1 throws twice as hard.
    ph.setParams(0, { gravity: 0.6, friction: 0.25, flick: 0 });
    ph.hold(0, 0.1, 0.8);
    ph.release(0, 8, 0);
    expect(ph.state(0).vx).toBe(0);
    ph.setParams(0, { gravity: 0.6, friction: 0.25, flick: 1 });
    ph.hold(0, 0.1, 0.8);
    ph.release(0, 4, 0);
    expect(ph.state(0).vx).toBeCloseTo(8, 9);

    // Explore is a marble too; Tour is not simulated here.
    ph.setMode(3, MODE_EXPLORE, 0.2, 0.2);
    expect(ph.isMarble(3)).toBe(true);
    ph.setWind(3, 3, 0);
    for (let i = 0; i < 30; i++) ph.step(1 / 60);
    expect(ph.state(3).vx).toBeGreaterThan(0);
    ph.setMode(3, MODE_TOUR, 0.2, 0.2);
    expect(ph.isActive(3)).toBe(false);
    expect(ph.isMarble(3)).toBe(false);

    // Pin parts never move; Drift parts do.
    ph.setMode(1, MODE_PIN, 0.4, 0.4);
    ph.setMode(2, MODE_DRIFT, 0.4, 0.4);
    ph.setParams(2, { driftSpeed: 1 });
    for (let i = 0; i < 120; i++) ph.step(1 / 60);
    expect(ph.isActive(1)).toBe(false);
    expect(torusDistance(ph.state(2).u, ph.state(2).v, 0.4, 0.4)).toBeGreaterThan(0.05);
    ph.dispose();
  });
});

// Rapier steps real physics: generous timeouts, the CI box may be busy.
describe('Rapier marble', { timeout: 60000 }, () => {
  it('rolls on the heightfield collider like the built-in one (lazy init in Node)', async () => {
    const mod = await import('@dimforge/rapier3d-compat');
    const R = mod.default || mod;
    await R.init();
    const hf = basinField();
    const rb = new RapierBall(R);
    rb.rebuild(hf);
    rb.setTuning(gravityFromParam(0.6), dampingFromParam(0.25));
    rb.place(hf, -2.6, 1.9);
    for (let i = 0; i < 60 * 25; i++) rb.step(hf, 1 / 60);
    expect(Math.hypot(rb.x, rb.z)).toBeLessThan(0.4);
    expect(rb.y).toBeGreaterThan(hf.yAt(rb.x, rb.z) + BALL_RADIUS * 0.5);
    expect(rb.y).toBeLessThan(hf.yAt(rb.x, rb.z) + BALL_RADIUS * 1.6);
    rb.dispose();
  });

  it('bounces higher with more Bounce and leans with the world tilt', async () => {
    const mod = await import('@dimforge/rapier3d-compat');
    const R = mod.default || mod;
    await R.init();
    const size = 64;
    const hf = new HeightField();
    hf.setTable('A', new Float32Array(size * size), size);
    const rebound = (bounce) => {
      const rb = new RapierBall(R);
      rb.setTuning(G, dampingFromParam(0), bounce);
      rb.rebuild(hf);
      rb.body.setTranslation({ x: 0, y: 3, z: 0 }, true);
      let landed = false, best = 0, prev = 3;
      for (let i = 0; i < 240; i++) {
        rb.step(hf, 1 / 120);
        if (!landed && rb.y > prev) landed = true;      // first contact turns it round
        if (landed) best = Math.max(best, rb.y);
        prev = rb.y;
      }
      rb.dispose();
      return best;
    };
    expect(rebound(0.9)).toBeGreaterThan(rebound(0) + 0.5);
    const rb = new RapierBall(R);
    rb.setTuning(G, dampingFromParam(0), 0);
    rb.rebuild(hf);
    rb.place(hf, 0, 0);
    rb.setPush(tiltAccel(1, G), 0);
    for (let i = 0; i < 120; i++) rb.step(hf, 1 / 60);
    expect(rb.vx).toBeGreaterThan(1);
    rb.dispose();
  });

  it('falls back to the built-in integrator when Rapier cannot load', async () => {
    const fields = [basinField(), basinField(), basinField(), basinField()];
    // a fresh module copy so the cached loader state does not leak between tests
    const fresh = await import('../../src/visual/physics.js?failing');
    const ph = fresh.createPhysics({ fieldFor: p => fields[p], importer: () => Promise.reject(new Error('blocked by CSP')) });
    ph.setMode(0, fresh.MODE_ROLL, 0.3, 0.3);
    await new Promise(r => setTimeout(r, 20));
    for (let i = 0; i < 30; i++) ph.step(1 / 60);
    expect(ph.engineName(0)).toBe('fallback');
    expect(fresh.rapierStatus()).toBe('failed');
    expect(torusDistance(ph.state(0).u, ph.state(0).v, 0.3, 0.3)).toBeGreaterThan(0.001);
  });
});
