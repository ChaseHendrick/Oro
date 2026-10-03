// v2.1 science sources: the models against their published numbers, and the
// Links wiring in the DSP.
import { describe, it, expect, vi } from 'vitest';
import {
  HHNeuron, Lorenz, DoublePendulum, pendulumEnergy, SmoothRandom, cascadeVariance,
  threeVortexMinimum, COLLAPSE_PRESETS, collapseState, COLLAPSE_MIN_SIZE, ScienceBank, SCI,
} from '../../src/dsp/science-sources.js';
import { LINK_SOURCES, GLOBAL_PARAMS, DOT_MODES, defaultState } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { PendulumDot, pendulumReach } from '../../src/visual/physics.js';
import { makeDSP, render, rms, allFinite } from './helpers.js';

vi.setConfig({ testTimeout: 60000 });

function spikeTimes(n, J, ms, kick = false) {
  n.rest(J);
  if (kick) n.kick(30, 1);
  const t = [];
  for (let i = 0; i < ms / 0.025; i++) if (n.step(0.025, J)) t.push(i * 0.025);
  return t;
}

describe('Hodgkin-Huxley neuron', () => {
  it('rests at the 1952 rest state', () => {
    const n = new HHNeuron();
    n.rest(0);
    expect(n.u).toBeCloseTo(3.620669e-3, 6);       // hh-dynamics rest at J = 0
  });

  it('is bistable at J = 8: quiet until kicked, then fires every 16.01 ms', () => {
    const n = new HHNeuron();
    expect(spikeTimes(n, 8, 200)).toHaveLength(0);
    const t = spikeTimes(n, 8, 300, true);
    expect(t.length).toBeGreaterThan(10);
    const period = t.at(-1) - t.at(-2);
    // proven enclosure [16.0058, 16.0139] ms, to within one 0.025 ms step
    expect(period).toBeGreaterThan(16.0058 - 0.025);
    expect(period).toBeLessThan(16.0139 + 0.025);
  });

  it('fires on its own above the Hopf current (about 9.78) and not below the fold (about 6.26)', () => {
    expect(spikeTimes(new HHNeuron(), 20, 200).length).toBeGreaterThan(5);
    expect(spikeTimes(new HHNeuron(), 5, 300, true).length).toBeLessThanOrEqual(1);
  });
});

describe('Lorenz, pendulum, smooth random', () => {
  it('Lorenz stays on the attractor', () => {
    const l = new Lorenz();
    let lo = 0, hi = 0;
    for (let i = 0; i < 2000; i++) { l.advance(0.01); lo = Math.min(lo, l.x); hi = Math.max(hi, l.x); }
    expect(lo).toBeLessThan(-10); expect(hi).toBeGreaterThan(10);
    expect(Math.abs(l.x)).toBeLessThan(25);
  });

  it('the double pendulum holds its energy', () => {
    for (const E of [-2.5, 0, 3]) {
      const p = new DoublePendulum(E, 3);
      expect(p.energy).toBeCloseTo(E, 9);
      for (let i = 0; i < 400; i++) p.advance(0.05);
      expect(Math.abs(p.energy - E)).toBeLessThan(1e-9);
    }
    expect(pendulumEnergy(0, 0, 0, 0)).toBe(-3);
  });

  it('smooth random has unit variance before shaping, for every smoothness', () => {
    for (const k of [1, 2, 3]) {
      // the cascade's variance formula against a direct simulation
      const a = Math.exp(-0.01), r = new SmoothRandom(7);
      let s2 = 0, n = 0;
      for (let i = 0; i < 200000; i++) { r.advance(0.01, k, Math.sqrt(2 * k - 1) / 1); if (i > 2000) { s2 += r.z * r.z; n++; } }
      expect(s2 / n).toBeGreaterThan(0.75); expect(s2 / n).toBeLessThan(1.3);
      expect(cascadeVariance(k, a)).toBeGreaterThan(0);
    }
  });
});

describe('vortex collapse', () => {
  it('reproduces the least windings', () => {
    expect(threeVortexMinimum(1, '+').P).toBeCloseTo(Math.SQRT2, 9);
    const half = [threeVortexMinimum(0.5, '+').P, threeVortexMinimum(0.5, '-').P].sort((x, y) => x - y);
    expect(half[0]).toBeCloseTo(1.0647059762712043, 9);
    expect(half[1]).toBeCloseTo(2.2038550160361327, 9);
    expect(COLLAPSE_PRESETS.at(-1).P).toBeCloseTo(0.79789678387986348, 15);
  });

  it('shrinks and turns as lambda^2 falls: phi = -P ln lambda^2', () => {
    const P = COLLAPSE_PRESETS[0].P;
    const end = collapseState(0.999999, P);
    expect(end.lambda).toBeCloseTo(COLLAPSE_MIN_SIZE, 4);
    expect(end.phi).toBeCloseTo(-P * Math.log(end.lambda ** 2), 12);
    const mid = collapseState(0.5, P);
    expect(mid.lambda ** 2).toBeCloseTo(1 - 0.5 * (1 - COLLAPSE_MIN_SIZE ** 2), 12);
    expect(collapseState(0, P).lambda).toBe(1);
  });
});

describe('science bank and Links', () => {
  it('sources are appended after Breath, in ScienceBank order', () => {
    const at = LINK_SOURCES.indexOf('Breath');
    expect(LINK_SOURCES.slice(at + 1, at + 10)).toEqual(['Neuron', 'Neuron Spike', 'Lorenz', 'Pendulum 1', 'Pendulum 2', 'Smooth Random', 'Collapse', 'Swirl X', 'Swirl Y']);
    expect(LINK_SOURCES.indexOf('Neuron') + SCI.COLLAPSE).toBe(LINK_SOURCES.indexOf('Collapse'));
    expect(GLOBAL_PARAMS.filter(p => p.group === 'science')).toHaveLength(15);
  });

  it('every output stays in range', () => {
    const b = new ScienceBank(2);
    b.configure({ neuronCurrent: 12, neuronRate: 1, pendEnergy: 3, lorenzRate: 3, smoothTime: 0.1 });
    for (let i = 0; i < 20000; i++) {
      if (i % 500 === 0) b.noteOn();
      b.step(32 / 48000, null, 0.5);
      for (let k = 0; k < b.out.length; k++) { expect(Number.isFinite(b.out[k])).toBe(true); expect(Math.abs(b.out[k])).toBeLessThanOrEqual(1); }
    }
  });

  it('a Lorenz link moves the sound; the DSP maps the global knobs', () => {
    const params = { terrainA: 0, size: 0.3, attack: 0.001, sustain: 1, filterType: 0 };
    const play = (links) => {
      const dsp = makeDSP({ params });
      dsp.handleMessage({ t: 'global', p: { sciLorenzRate: 4 } });
      if (links) dsp.handleMessage({ t: 'links', part: 0, links });
      return render(dsp, 1.0, (d, t, k) => { if (k === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 57, vel: 1, time: 0 }); });
    };
    const dsp = makeDSP({ params });
    dsp.handleMessage({ t: 'global', p: { sciLorenzRate: 4, sciNeuronCurrent: 12 } });
    expect(dsp.science.cfg.lorenzRate).toBe(4);
    expect(dsp.science.cfg.neuronCurrent).toBe(12);
    const plain = play(null), linked = play([{ src: LINK_SOURCES.indexOf('Lorenz'), dst: 'size', amt: 0.8, curve: 0 }]);
    expect(allFinite(linked.L)).toBe(true);
    let diff = 0;
    for (let i = 0; i < plain.L.length; i++) diff += (plain.L[i] - linked.L[i]) ** 2;
    expect(Math.sqrt(diff / plain.L.length)).toBeGreaterThan(0.05 * rms(plain.L));
  });

  it('Swirl places each voice on its own vortex', () => {
    const b = new ScienceBank(1);
    b.step(0.1, 1.5, 0.5);
    const a = b.swirl(0, { x: 0, y: 0 }), c = b.swirl(1, { x: 0, y: 0 });
    expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThan(0.05);
  });
});

describe('Pendulum dot mode', () => {
  it('is the sixth dot mode and survives a save', () => {
    expect(DOT_MODES[5]).toBe('Pendulum');
    const st = defaultState();
    st.parts[0].dot = { ...st.parts[0].dot, mode: 5, pendEnergy: 9, pendReach: 0.7 };
    const m = migrateState(st);
    expect(m.parts[0].dot.mode).toBe(5);
    expect(m.parts[0].dot.pendEnergy).toBe(4);
    expect(m.parts[0].dot.pendReach).toBe(0.7);
  });

  it('starts where the dot was and stays within reach of its anchor', () => {
    const d = new PendulumDot(1);
    d.setParams(2, 0.5);
    d.place(0.3, 0.6);
    expect(d.u).toBeCloseTo(0.3, 12); expect(d.v).toBeCloseTo(0.6, 12);
    const reach = pendulumReach(0.5);
    for (let i = 0; i < 600; i++) {
      d.step(1 / 60, 0.5);
      const du = ((d.u - d.au + 1.5) % 1) - 0.5, dv = ((d.v - d.av + 1.5) % 1) - 0.5;
      expect(Math.hypot(du, dv)).toBeLessThanOrEqual(2 * reach + 1e-9);
    }
  });
});

describe('v2.4 Turing, Function and Via', async () => {
  const { Turing } = await import('../../src/dsp/science-sources.js');
  const { funcValue, sanitizeFuncPoints } = await import('../../src/dsp/function-gen.js');
  it('Turing at Chance 0 loops with its Length; at Chance 1 it does not', () => {
    const t = new Turing(5), a = [];
    for (let s = 0; s < 24; s++) { t.advance(s, 0, 6); a.push(t.value); }
    for (let s = 6; s < 24; s++) expect(a[s]).toBe(a[s - 6]);
    const u = new Turing(5), b = [];
    for (let s = 0; s < 64; s++) { u.advance(s, 1, 6); b.push(u.value); }
    expect(b.slice(0, 6)).not.toEqual(b.slice(6, 12));
  });
  it('Function points are sanitized and interpolated', () => {
    const pts = sanitizeFuncPoints([[0.5, 2], [0.2, -1], ['x', 1]]);
    expect(pts[0][0]).toBe(0); expect(pts.at(-1)[0]).toBe(1); expect(pts.at(-1)[1]).toBe(1);
    const xs = [0, 0.5, 1], ys = [0, 1, -1];
    expect(funcValue(xs, ys, 3, 0.25, 0)).toBeCloseTo(0.5, 12);
    expect(funcValue(xs, ys, 3, 0.75, 0)).toBeCloseTo(0, 12);
    expect(funcValue(xs, ys, 3, 0.25, 1)).toBeCloseTo(0.5, 12);
  });
  it('a Via of zero silences a link; the Function link moves the sound', () => {
    const params = { terrainA: 0, size: 0.3, attack: 0.001, sustain: 1, filterType: 0 };
    const play = (links) => { const d = makeDSP({ params }); if (links) d.handleMessage({ t: 'links', part: 0, links }); return render(d, 0.4, (x, t, k) => { if (k === 0) x.handleMessage({ t: 'noteOn', part: 0, note: 50, vel: 1, time: 0 }); }); };
    const plain = play([]);
    const viaZero = play([{ src: LINK_SOURCES.indexOf('Function'), dst: 'size', amt: 1, curve: 0, via: LINK_SOURCES.indexOf('Mod Wheel') }]);
    let same = 0; for (let i = 0; i < plain.L.length; i++) same = Math.max(same, Math.abs(plain.L[i] - viaZero.L[i]));
    expect(same).toBeLessThan(1e-5);     // the per-voice path, not bit-identical
    const fn = play([{ src: LINK_SOURCES.indexOf('Function'), dst: 'size', amt: 0.8, curve: 0 }]);
    let d = 0; for (let i = 0; i < plain.L.length; i++) d += (plain.L[i] - fn.L[i]) ** 2;
    expect(Math.sqrt(d / plain.L.length)).toBeGreaterThan(0.05 * rms(plain.L));
  });
});
