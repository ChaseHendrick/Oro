// Laps (hard sync), Pace (phase distortion) and Sub.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import {
  paceWarp, paceSpeed, paceMaxSpeed, paceBlock, syncPhase, cyclePhase, pathPoint, pathBlockAt,
  PACE_SHAPES, PATH_COUNT,
} from '../../src/dsp/paths.js';
import { PART_PARAM_MAP } from '../../src/core/params.js';
import { SR, makeDSP, render, allFinite, spectrum, peak } from './helpers.js';
import { REF_SCENES, REF_FRAMES, renderScene } from './fixtures/reference-scenes.js';

// Offline renders are heavy and the suite may share a busy machine: measure
// quality here, not wall-clock speed (dev/dsp/bench.mjs measures CPU time).
vi.setConfig({ testTimeout: 120000 });

const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const db = (x) => 20 * Math.log10(x + 1e-30);
const on = (note, vel = 1, time = 0) => ({ t: 'noteOn', part: 0, note, vel, time });
const off = (note, time = 0) => ({ t: 'noteOff', part: 0, note, time });

// A clean measuring patch: no filter, no velocity scaling, held at full level.
const PLAIN = { filterType: 0, pathShape: P.ellipse, pathOrder: 1, size: 0.3, attack: 0.001, sustain: 1, velSens: 0 };

function tone(note, params = {}, { seconds = 0.6, terrain = T.swell, mods = null, mipBias = null, blep = true } = {}) {
  const dsp = makeDSP({ terrainA: terrain, params: { ...PLAIN, ...params }, mods });
  if (mipBias !== null) dsp.mipBias = mipBias;
  dsp.blep = blep;
  dsp.handleMessage(on(note));
  return render(dsp, seconds);
}

/** Amplitude of the sinusoid at exactly f Hz (Hann-windowed single-bin DFT). */
function toneAmp(x, f, start = 8000, N = 16384) {
  let re = 0, im = 0, ws = 0;
  for (let n = 0; n < N; n++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N);
    const a = 2 * Math.PI * f * n / SR;
    ws += w; re += x[start + n] * w * Math.cos(a); im -= x[start + n] * w * Math.sin(a);
  }
  return 2 * Math.hypot(re, im) / ws;
}

const harmonics = (x, f, K = 12) => Array.from({ length: K }, (_, k) => toneAmp(x, (k + 1) * f));

/** Power (dB) that is NOT on the harmonic grid of f0: aliasing / inharmonic energy of a periodic tone. */
function inharmonicDb(x, f0, start = 8000, N = 16384) {
  const mag = spectrum(x, start, N);
  const bin = SR / N;
  const mask = new Uint8Array(N / 2);
  for (let h = 1; h * f0 < SR / 2 + 10 * bin; h++) {
    const c = Math.round(h * f0 / bin);
    for (let k = c - 6; k <= c + 6; k++) if (k >= 0 && k < N / 2) mask[k] = 1;
  }
  let tot = 0, inh = 0;
  for (let k = 3; k < N / 2; k++) { const p = mag[k] * mag[k]; tot += p; if (!mask[k]) inh += p; }
  return 10 * Math.log10(inh / tot);
}

function maxDelta(a, from, to) {
  let m = 0;
  for (let i = Math.max(1, Math.round(from)); i < Math.round(to); i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}

/** Hold a note, change params mid-note, release: max |Δsample| of each phase. */
function changeRun(params, change, { terrain = T.swell } = {}) {
  const dsp = makeDSP({ terrainA: terrain, params: { filterType: 0, pathOrder: 1, sustain: 1, ...params } });
  dsp.handleMessage(on(57));
  const a = render(dsp, 0.5);
  dsp.handleMessage({ t: 'params', part: 0, p: change });
  const b = render(dsp, 0.5);
  dsp.handleMessage(off(57));
  const c = render(dsp, 0.8);
  return {
    attack: maxDelta(a.L, 0, 0.02 * SR), steadyA: maxDelta(a.L, 0.3 * SR, 0.5 * SR),
    change: maxDelta(b.L, 0, 0.1 * SR), steadyB: maxDelta(b.L, 0.3 * SR, 0.5 * SR),
    release: maxDelta(c.L, 0, 0.05 * SR),
  };
}

describe('defaults are transparent', () => {
  it('Laps 1, Pace 0, Sub 0 render bit-identically to the engine before these controls', () => {
    const file = fileURLToPath(new URL('./fixtures/reference-v1.f32', import.meta.url));
    const buf = readFileSync(file);
    const ref = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(ref.length).toBe(REF_SCENES.length * 2 * REF_FRAMES);
    let worst = 0;
    for (const paceShape of [0, 1, 2]) {
      REF_SCENES.forEach((scene, i) => {
        const r = renderScene(scene, { makeDSP, render }, { laps: 1, pace: 0, sub: 0, paceShape });
        for (let k = 0; k < REF_FRAMES; k++) {
          worst = Math.max(worst, Math.abs(r.L[k] - ref[2 * i * REF_FRAMES + k]), Math.abs(r.R[k] - ref[(2 * i + 1) * REF_FRAMES + k]));
        }
      });
    }
    console.log(`[features] reference scenes x 3 Pace curves: max |difference| to the pre-feature engine = ${worst}`);
    expect(worst).toBeLessThanOrEqual(1e-9);
  });
});

describe('Laps (hard sync)', () => {
  it('Laps 2 on an ellipse (order 1) doubles the dominant frequency', () => {
    const f = mtof(45);
    // mips off so both runs read the very same table
    const one = harmonics(tone(45, { laps: 1 }, { mipBias: -99 }).L, f);
    const two = harmonics(tone(45, { laps: 2 }, { mipBias: -99 }).L, f);
    const argmax = (h) => h.indexOf(Math.max(...h)) + 1;
    console.log(`[features] harmonics 1-12 (dB), Laps 1: ${one.map(a => db(a).toFixed(0)).join(' ')}\n[features] harmonics 1-12 (dB), Laps 2: ${two.map(a => db(a).toFixed(0)).join(' ')}`);
    expect(argmax(two)).toBe(2 * argmax(one));
    const top = Math.max(...two);
    for (let k = 1; k <= 6; k++) {
      // harmonic k of Laps 1 moves to harmonic 2k, the odd ones vanish
      expect(Math.abs(db(two[2 * k - 1]) - db(one[k - 1]))).toBeLessThan(0.5);
      expect(db(two[2 * k - 2] / top)).toBeLessThan(-80);
    }
  });

  it('Laps 1.5 keeps the fundamental on the note and adds sync harmonics', () => {
    const f = mtof(45);
    const hfShare = (x) => {
      const h = harmonics(x, f, 40);
      const all = h.reduce((s, a) => s + a * a, 0), hi = h.slice(8).reduce((s, a) => s + a * a, 0);
      return 10 * Math.log10(hi / all);
    };
    const one = tone(45, { laps: 1 }), sync = tone(45, { laps: 1.5 });
    const h = harmonics(sync.L, f);
    const top = Math.max(...h);
    const inh = inharmonicDb(sync.L, f);
    const half = toneAmp(sync.L, f / 2), third = toneAmp(sync.L, f / 3);
    const gain = hfShare(sync.L) - hfShare(one.L);
    console.log(`[features] Laps 1.5 @ ${f.toFixed(1)} Hz: fundamental ${db(h[0] / top).toFixed(1)} dB re strongest, off-grid ${inh.toFixed(1)} dB, f/2 ${db(half / top).toFixed(0)} dB; share above harmonic 8 +${gain.toFixed(1)} dB vs Laps 1`);
    expect(db(h[0] / top)).toBeGreaterThan(-12);       // the note's own frequency is there
    expect(inh).toBeLessThan(-50);                      // everything sits on its harmonics
    expect(db(half / top)).toBeLessThan(-80);           // no subharmonics: the period is one cycle
    expect(db(third / top)).toBeLessThan(-80);
    expect(gain).toBeGreaterThan(10);                   // the restart's edge brightens it
  });

  it('polyBLEP at the restart measurably reduces aliasing at high notes', { timeout: 60000 }, () => {
    const rows = [];
    for (const [name, terrain] of [['swell', T.swell], ['massif', T.massif]]) {
      for (const note of [84, 96]) {
        const f = mtof(note);
        const bl = inharmonicDb(tone(note, { laps: 1.5 }, { terrain, seconds: 1 }).L, f, 8000, 32768);
        const naive = inharmonicDb(tone(note, { laps: 1.5 }, { terrain, seconds: 1, blep: false }).L, f, 8000, 32768);
        rows.push({ name, note, bl, naive });
      }
    }
    console.log('[features] aliased (off-harmonic) energy, Laps 1.5, size 0.3: ' + rows.map(r => `${r.name} MIDI ${r.note}: ${r.bl.toFixed(1)} dB (naive reset ${r.naive.toFixed(1)}, ${(r.naive - r.bl).toFixed(1)} dB better)`).join(' | '));
    for (const r of rows) expect(r.bl).toBeLessThan(r.naive - 6);
    expect(rows[0].bl).toBeLessThan(-40);
  });

  it('includes Laps in the mip-level speed estimate', () => {
    const level = (laps) => {
      const dsp = makeDSP({ terrainA: T.massif, params: { ...PLAIN, laps } });
      dsp.handleMessage(on(72));
      render(dsp, 0.05);
      return dsp.parts[0].voices[0].sLvA;
    };
    const l1 = level(1), l4 = level(4);
    expect(l1).toBeGreaterThan(0.5);
    expect(l4 - l1).toBeCloseTo(2, 3);                  // 4 laps = 4x the speed = 2 octaves
  });

  it('a Laps jump sounds like a quick sync sweep, never sharper than a held sync tone', () => {
    const jump = changeRun({ laps: 1 }, { laps: 2 });
    let held = 0;
    for (let L = 1.125; L < 2; L += 0.125) held = Math.max(held, changeRun({ laps: L }, { laps: L }).steadyB);
    console.log(`[features] Laps 1 -> 2 jump: max |Δsample| ${jump.change.toFixed(4)} (held fractional Laps up to ${held.toFixed(4)}, held Laps 1 ${jump.steadyA.toFixed(4)}, Laps 2 ${jump.steadyB.toFixed(4)})`);
    expect(jump.change).toBeLessThan(1.3 * held);
  });

  it('LFO sweeps of Laps are smooth and stay within the sync tone they pass through', () => {
    const mods = { laps: { lfoDepth: 0.25, lfoRate: 1.5, lfoShape: 1 } };
    const dsp = makeDSP({ terrainA: T.swell, params: { filterType: 0, pathOrder: 1, sustain: 1, laps: 3 }, mods });
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    dsp.handleMessage(on(57));
    const r = render(dsp, 1);
    expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
    const lapsN = tele.map(m => m.n.laps);
    expect(Math.max(...lapsN) - Math.min(...lapsN)).toBeGreaterThan(0.4);
    // the depth spans Laps 1.25 .. 4.75: compare with held values across it
    let held = 0;
    for (let L = 1.25; L <= 4.75; L += 0.125) held = Math.max(held, changeRun({ laps: L }, { laps: L }).steadyB);
    const sweep = maxDelta(r.L, 0.05 * SR, r.L.length);
    console.log(`[features] Laps LFO sweep 1.25..4.75: max |Δsample| ${sweep.toFixed(4)} (held Laps over that range up to ${held.toFixed(4)})`);
    expect(sweep).toBeLessThan(1.3 * held);
  });

  it('the sync correction does not depend on how blocks split the signal', () => {
    const run = (block, params, mods = null) => {
      const dsp = makeDSP({ terrainA: T.massif, params: { filterType: 0, size: 0.35, unison: 2, sub: 0.3, ...params }, mods });
      dsp.handleMessage(on(79));
      dsp.handleMessage(on(55, 1, 0.0123));
      return render(dsp, 0.3, null, block);
    };
    const diff = (a, b) => { let d = 0; for (let i = 0; i < a.L.length; i++) d = Math.max(d, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i])); return d; };
    const held = { laps: 1.37 };
    expect(diff(run(128, held), run(37, held))).toBeLessThan(1e-6);
    expect(diff(run(128, held), run(5, held))).toBeLessThan(1e-6);
    const moving = { laps: 1.37, pace: 0.5, paceShape: 1 };
    const lfo = { laps: { lfoDepth: 0.2, lfoRate: 3 } };
    expect(diff(run(128, moving, lfo), run(37, moving, lfo))).toBeLessThan(2e-3);
  });
});

describe('Pace (phase distortion) helpers', () => {
  it('paceWarp is monotonic with fixed endpoints and a positive speed for every curve and pace', () => {
    expect(PACE_SHAPES).toEqual(PART_PARAM_MAP.paceShape.options);
    const N = 4000;
    let minStep = Infinity, minSpeed = Infinity, maxDerivErr = 0, worstEnd = 0;
    for (let shape = 0; shape < 3; shape++) {
      for (let k = -20; k <= 20; k++) {
        const pace = k / 20;
        expect(paceWarp(0, pace, shape)).toBe(0);
        worstEnd = Math.max(worstEnd, Math.abs(paceWarp(1, pace, shape) - 1));
        let prev = 0, top = 0;
        for (let i = 1; i <= N; i++) {
          const phi = i / N;
          const g = paceWarp(phi, pace, shape);
          minStep = Math.min(minStep, g - prev);
          const sp = paceSpeed(phi, pace, shape);
          minSpeed = Math.min(minSpeed, sp);
          top = Math.max(top, sp);
          maxDerivErr = Math.max(maxDerivErr, Math.abs((g - prev) * N - paceSpeed(phi - 0.5 / N, pace, shape)));
          prev = g;
        }
        expect(top).toBeLessThanOrEqual(paceMaxSpeed(pace, shape) + 1e-9);
        expect(top).toBeGreaterThan(paceMaxSpeed(pace, shape) - 0.01);
      }
    }
    console.log(`[features] paceWarp over 3 curves x 41 paces x ${N} points: smallest step ${minStep.toExponential(2)}, slowest speed ${minSpeed.toFixed(3)}, |dψ/dφ - paceSpeed| <= ${maxDerivErr.toExponential(1)}, |ψ(1) - 1| <= ${worstEnd.toExponential(1)}`);
    expect(minStep).toBeGreaterThan(0);
    expect(minSpeed).toBeGreaterThanOrEqual(0.0999);
    expect(maxDerivErr).toBeLessThan(2e-3);
    expect(worstEnd).toBeLessThan(1e-12);
  });

  it('Pace 0 is exactly the identity and out-of-range pace is clamped', () => {
    for (let shape = 0; shape < 3; shape++) {
      for (let i = 0; i < 100; i++) {
        const phi = i / 100 + 0.001;
        expect(paceWarp(phi, 0, shape)).toBe(phi);
        expect(paceSpeed(phi, 0, shape)).toBe(1);
        expect(paceWarp(phi, 3, shape)).toBe(paceWarp(phi, 1, shape));
        expect(paceWarp(phi, -3, shape)).toBe(paceWarp(phi, -1, shape));
      }
    }
  });

  it('syncPhase, cyclePhase, paceBlock and pathBlockAt agree with the scalar functions', () => {
    for (let i = 0; i < 200; i++) {
      const psi = i / 200;
      expect(syncPhase(psi, 1)).toBe(psi);
      const t = syncPhase(psi, 2.7);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
      expect(t).toBeCloseTo((2.7 * psi) % 1, 12);
      expect(cyclePhase(psi, 2.7, 0.4, 1)).toBe(syncPhase(paceWarp(psi, 0.4, 1), 2.7));
    }
    const n = 64, PH = new Float64Array(n), PSI = new Float64Array(n), X = new Float64Array(n), Y = new Float64Array(n);
    for (let j = 0; j < n; j++) PH[j] = (j * 0.137) % 1;
    for (let shape = 0; shape < 3; shape++) {
      for (const [p0, dp] of [[0.7, 0], [-0.3, 0.01], [0, 0]]) {
        paceBlock(shape, n, PH, p0, dp, PSI);
        for (let j = 0; j < n; j++) expect(PSI[j]).toBeCloseTo(paceWarp(PH[j], p0 + dp * (j + 1), shape), 12);
      }
    }
    const pt = { x: 0, y: 0 };
    for (let s = 0; s < PATH_COUNT; s++) {
      pathBlockAt(s, 3, n, PH, 0.2, 0.01, X, Y);
      for (let j = 0; j < n; j++) {
        pathPoint(s, PH[j], 3, 0.2 + 0.01 * (j + 1), pt);
        expect(X[j]).toBeCloseTo(pt.x, 12);
        expect(Y[j]).toBeCloseTo(pt.y, 12);
      }
    }
  });
});

describe('Pace in the engine', () => {
  it('changes the timbre but never the pitch', () => {
    const f = mtof(45);
    const flat = harmonics(tone(45, { pace: 0 }).L, f);
    const rows = [];
    for (let shape = 0; shape < 3; shape++) {
      for (const pace of [-0.9, 0.5, 0.9]) {
        const x = tone(45, { pace, paceShape: shape }).L;
        const h = harmonics(x, f);
        const top = Math.max(...h);
        const inh = inharmonicDb(x, f);
        const sub = Math.max(toneAmp(x, f / 2), toneAmp(x, 1.5 * f));
        const change = Math.max(...h.map((a, k) => Math.abs(db(a) - db(flat[k]))));
        rows.push(`${PACE_SHAPES[shape]} ${pace}: off-grid ${inh.toFixed(0)} dB, f/2 ${db(sub / top).toFixed(0)} dB, timbre moved ${change.toFixed(1)} dB`);
        expect(inh).toBeLessThan(-50);
        expect(db(sub / top)).toBeLessThan(-80);
        expect(db(h[0] / top)).toBeGreaterThan(-20);
        expect(change).toBeGreaterThan(3);
      }
    }
    console.log('[features] Pace at 110 Hz: ' + rows.join(' | '));
  });

  it('follows the local speed with per-sample mips, so a fast Pace stays clean at high notes', { timeout: 60000 }, () => {
    const rows = [];
    for (let shape = 0; shape < 3; shape++) {
      const f = mtof(96);
      const withMips = inharmonicDb(tone(96, { pace: 0.9, paceShape: shape, size: 0.4 }, { terrain: T.massif, seconds: 1 }).L, f, 8000, 32768);
      const noMips = inharmonicDb(tone(96, { pace: 0.9, paceShape: shape, size: 0.4 }, { terrain: T.massif, seconds: 1, mipBias: -99 }).L, f, 8000, 32768);
      rows.push(`${PACE_SHAPES[shape]} ${withMips.toFixed(1)} dB (no mips ${noMips.toFixed(1)})`);
      expect(withMips).toBeLessThan(noMips - 10);
      expect(withMips).toBeLessThan(-30);
    }
    console.log('[features] aliased energy, Pace 0.9 at MIDI 96, massif, size 0.4: ' + rows.join(' | '));
  });

  it('switches curves and jumps Pace without clicks', () => {
    const rows = [];
    for (const [from, to] of [[{ pace: 0 }, { pace: 0.9 }], [{ pace: 0.9, paceShape: 0 }, { paceShape: 1 }], [{ pace: 0.9, paceShape: 1 }, { paceShape: 2 }], [{ pace: -0.9, paceShape: 2 }, { paceShape: 0 }]]) {
      const r = changeRun(from, to);
      rows.push(`${JSON.stringify(from)} -> ${JSON.stringify(to)}: ${r.change.toFixed(4)} (steady ${r.steadyA.toFixed(4)} / ${r.steadyB.toFixed(4)})`);
      expect(r.change).toBeLessThan(1.3 * Math.max(r.steadyA, r.steadyB));
    }
    console.log('[features] max |Δsample| at Pace changes: ' + rows.join(' | '));
  });
});

describe('Sub', () => {
  // Output gain of a centred voice at full velocity: part level 0.75² x 0.5 headroom.
  const PART_GAIN = 0.75 * 0.75 * 0.5;

  it('adds a sine one octave down whose level follows the knob (squared taper)', () => {
    const f = mtof(57);
    const amp = (sub, extra = {}) => {
      const r = tone(57, { sub, ...extra });
      return { L: toneAmp(r.L, f / 2), R: toneAmp(r.R, f / 2) };
    };
    const a0 = amp(0), a5 = amp(0.5), a1 = amp(1), uni = amp(1, { unison: 3, detune: 20, spread: 1 });
    console.log(`[features] sub at ${(f / 2).toFixed(1)} Hz: off ${a0.L.toExponential(1)}, 0.5 -> ${a5.L.toFixed(4)}, 1 -> ${a1.L.toFixed(4)} (expected ${(0.8 * PART_GAIN).toFixed(4)}), unison 3 L/R ${uni.L.toFixed(4)} / ${uni.R.toFixed(4)}`);
    expect(a0.L).toBeLessThan(1e-5);
    expect(a1.L).toBeCloseTo(0.8 * PART_GAIN, 3);
    expect(a5.L / a1.L).toBeCloseTo(0.25, 2);
    // one sub per voice, not per unison oscillator, and centred
    expect(uni.L).toBeCloseTo(a1.L, 3);
    expect(uni.R).toBeCloseTo(uni.L, 4);
  });

  it('follows the voice pitch (bend and glide) and goes through the filter', () => {
    const f = mtof(57);
    const dsp = makeDSP({ terrainA: T.swell, params: { ...PLAIN, sub: 1, bendRange: 12 } });
    dsp.handleMessage(on(57));
    dsp.handleMessage({ t: 'bend', part: 0, v: 1 });
    const r = render(dsp, 0.6);
    expect(toneAmp(r.L, f)).toBeCloseTo(0.8 * PART_GAIN, 3);      // an octave up = the note itself
    // a high-pass well above the sub removes it: the sub is before the filter
    const hp = tone(57, { sub: 1, filterType: 3, cutoff: 2000, resonance: 0, keyTrack: 0, filterEnv: 0 });
    expect(toneAmp(hp.L, f / 2)).toBeLessThan(0.02 * 0.8 * PART_GAIN);
    // glide: the sub slides with the voice
    const g = makeDSP({ terrainA: T.swell, params: { ...PLAIN, sub: 1, polyMode: 1, glide: 0.05 } });
    g.handleMessage(on(45));
    render(g, 0.2);
    g.handleMessage(on(57));
    const s = render(g, 0.6);
    expect(toneAmp(s.L, f / 2)).toBeCloseTo(0.8 * PART_GAIN, 2);
  });

  it('is click-free on note on and off and when its level jumps', () => {
    const steady = changeRun({ sub: 1 }, { sub: 1 });
    const up = changeRun({ sub: 0 }, { sub: 1 });
    const down = changeRun({ sub: 1 }, { sub: 0 });
    console.log(`[features] sub max |Δsample|: steady ${steady.steadyA.toFixed(4)}, attack ${steady.attack.toFixed(4)}, release ${steady.release.toFixed(4)}, 0 -> 1 ${up.change.toFixed(4)}, 1 -> 0 ${down.change.toFixed(4)}`);
    expect(steady.attack).toBeLessThan(1.3 * steady.steadyA);
    expect(steady.release).toBeLessThan(1.3 * steady.steadyA);
    expect(up.change).toBeLessThan(1.3 * Math.max(up.steadyA, up.steadyB));
    expect(down.change).toBeLessThan(1.3 * Math.max(down.steadyA, down.steadyB));
  });
});

describe('all together', () => {
  it('telemetry reports the modulated Laps and Pace', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { laps: 2, pace: 0.2 }, mods: { laps: { lfoDepth: 0.2, lfoRate: 4 }, pace: { envDepth: 0.3 } } });
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    dsp.handleMessage(on(60));
    render(dsp, 0.5);
    const last = tele[tele.length - 1];
    expect(last.n).toHaveProperty('laps');
    expect(last.n).toHaveProperty('pace');
    const laps = tele.map(m => m.n.laps), pace = tele.map(m => m.n.pace);
    expect(Math.max(...laps) - Math.min(...laps)).toBeGreaterThan(0.3);
    expect(Math.max(...pace)).toBeGreaterThan(0.6 + 0.25);   // base 0.6 normalised + Envelope 2
  });

  it('stays finite and bounded at the extremes, with the attack and release as clean as the held tone', () => {
    for (let shape = 0; shape < PATH_COUNT; shape += 3) {
      for (let curve = 0; curve < 3; curve++) {
        const dsp = makeDSP({ terrainA: T.ridge, terrainB: T.cells, params: { pathShape: shape, laps: 8, pace: curve === 1 ? -1 : 1, paceShape: curve, sub: 1, unison: 4, morph: 0.5, warp: 1, fold: 1, lift: 4, resonance: 1 } });
        for (const n of [24, 60, 108]) dsp.handleMessage(on(n));
        const r = render(dsp, 0.2);
        expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
        expect(peak(r.L)).toBeLessThanOrEqual(4);
      }
    }
    const r = changeRun({ laps: 1.5, pace: 0.6, sub: 0.5 }, { laps: 1.5 });
    console.log(`[features] Laps 1.5 + Pace 0.6 + Sub 0.5 max |Δsample|: attack ${r.attack.toFixed(4)}, held ${r.steadyA.toFixed(4)}, release ${r.release.toFixed(4)}`);
    expect(r.attack).toBeLessThan(1.3 * r.steadyA);
    expect(r.release).toBeLessThan(1.3 * r.steadyA);
  });
});
