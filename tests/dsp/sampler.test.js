// Sampler (2.13): pitch and rate maths, direction, region and loop
// crossfade, modes, voice stealing, envelope, granular grains, saved data,
// undo snapshots, sync and the engine.
import { describe, it, expect } from 'vitest';
import {
  SamplerPlayer, sanitizeSampler, defaultSampler, samplerConfig, GRAIN_WINDOW, MAX_VOICES, SAMPLER_MAX_B64,
} from '../../src/dsp/sampler.js';
import { pcmToBase64 } from '../../src/dsp/drum-kit.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { snapshotState, describeEdit } from '../../src/core/history.js';
import { freezeSignature } from '../../src/audio/freeze.js';
import { makeDSP, render, SR } from './helpers.js';

const sine = (f, sr, secs, amp = 0.8) => Float32Array.from({ length: Math.round(sr * secs) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i / (n - 1));

/** Frequency from upward zero crossings (linear interpolation) between from and to. */
function freqOf(a, sr, from = 0, to = a.length) {
  const xs = [];
  for (let i = Math.max(1, from); i < to; i++) if (a[i - 1] < 0 && a[i] >= 0) xs.push(i - 1 + a[i - 1] / (a[i - 1] - a[i]));
  if (xs.length < 3) return 0;
  return (xs.length - 1) / ((xs[xs.length - 1] - xs[0]) / sr);
}

function player(sr, data, rate, cfg = {}) {
  const p = new SamplerPlayer(sr);
  p.setData(data, rate);
  p.configure({ ...defaultSampler(), ...cfg });
  return p;
}

function run(p, frames, opts = {}, events = []) {
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const B = 128;
  for (let o = 0; o < frames; o += B) {
    for (const e of events) if (e.at >= o && e.at < o + B) e.fn(p);
    p.render(L, R, o, Math.min(B, frames - o), opts.speed ?? 1, opts.start ?? 0, opts.end ?? 1, opts.pos ?? 0.5, opts.bend ?? 1);
  }
  return L;
}

describe('pitch and rate', () => {
  for (const [srcRate, hostRate] of [[44100, 48000], [48000, 44100], [48000, 96000], [96000, 48000]]) {
    it(`key, Root and Speed set the pitch with a ${srcRate} Hz sample at ${hostRate} Hz`, () => {
      const f0 = 220;
      const data = sine(f0, srcRate, 2);
      const cases = [[0, 1, f0], [12, 1, 2 * f0], [-12, 1, f0 / 2], [7, 1, f0 * 2 ** (7 / 12)], [0, 2, 2 * f0], [0, 0.5, f0 / 2], [12, 0.5, f0]];
      for (const [semis, speed, want] of cases) {
        const p = player(hostRate, data, srcRate, { sustain: 1 });
        p.noteOn(60 + semis, semis, 1);
        const out = run(p, Math.round(hostRate * 0.5), { speed });
        expect(freqOf(out, hostRate, Math.round(hostRate * 0.05)) / want).toBeCloseTo(1, 3);
      }
    });
  }

  it('Fine tune moves the pitch in cents and pitch bend multiplies it', () => {
    const data = sine(440, 48000, 1);
    const p = player(48000, data, 48000, { fine: 50 });
    p.noteOn(60, 0, 1);
    expect(freqOf(run(p, 24000), 48000, 2400) / (440 * 2 ** (50 / 1200))).toBeCloseTo(1, 3);
    const q = player(48000, data, 48000);
    q.noteOn(60, 0, 1);
    expect(freqOf(run(q, 24000, { bend: 2 ** (2 / 12) }), 48000, 2400) / (440 * 2 ** (2 / 12))).toBeCloseTo(1, 3);
  });

  it('Hermite reads a band-limited sine cleanly at odd rates', () => {
    const data = sine(1000, 44100, 1);
    const p = player(48000, data, 44100);
    p.noteOn(63, 3, 1);
    const out = run(p, 24000);
    // compare with the ideal sine at the expected frequency, fitted by least squares
    const f = 1000 * 2 ** (3 / 12);
    let sc = 0, cc = 0, ss = 0, cs = 0;
    for (let i = 2000; i < 20000; i++) { const s = Math.sin(2 * Math.PI * f * i / 48000), c = Math.cos(2 * Math.PI * f * i / 48000); sc += out[i] * s; cc += out[i] * c; ss += s * s; cs += c * c; }
    let err = 0, sig = 0;
    for (let i = 2000; i < 20000; i++) { const y = (sc / ss) * Math.sin(2 * Math.PI * f * i / 48000) + (cc / cs) * Math.cos(2 * Math.PI * f * i / 48000); err += (out[i] - y) ** 2; sig += y * y; }
    expect(10 * Math.log10(err / sig)).toBeLessThan(-50);
  });
});

describe('direction, region and loop', () => {
  it('reverse plays the region from its end to its start', () => {
    const p = player(48000, ramp(4800), 48000, { dir: 1, attack: 0.0005 });
    p.noteOn(60, 0, 1);
    const out = run(p, 6000);
    // ramps down from near 1 and stops at the start
    expect(out[200]).toBeGreaterThan(out[2000]);
    expect(out[2000]).toBeGreaterThan(out[4000]);
    expect(out[5000]).toBe(0);
    expect(p.busy).toBe(false);
  });

  it('start and end limit the region (forward and reverse)', () => {
    const p = player(48000, ramp(48000), 48000, { attack: 0.0005 });
    p.noteOn(60, 0, 1, 0.25, 0.5);
    const out = run(p, 20000, { start: 0.25, end: 0.5 });
    // default level is 0.8; the ramp value is the position in the sample
    const lv = 0.8;
    expect(out[100]).toBeCloseTo(lv * (0.25 + 100 / 48000), 2);
    expect(out[11000]).toBeCloseTo(lv * (0.25 + 11000 / 48000), 2);
    expect(out[12500]).toBe(0);
    const r = player(48000, ramp(48000), 48000, { attack: 0.0005, dir: 1 });
    r.noteOn(60, 0, 1, 0.25, 0.5);
    const ro = run(r, 20000, { start: 0.25, end: 0.5 });
    expect(ro[100]).toBeCloseTo(lv * (0.5 - 100 / 48000), 2);
  });

  it('ping-pong turns round at both ends while looping', () => {
    const p = player(48000, ramp(4800), 48000, { dir: 2, loop: 1, attack: 0.0005 });
    p.noteOn(60, 0, 1);
    const out = run(p, 4800 * 3);
    // default level is 0.8, so the ramp never reaches 1
    expect(out[4700]).toBeGreaterThan(0.95 * 0.8);   // up to the end
    expect(out[9400]).toBeLessThan(0.05);            // back down to the start
    expect(out[14000]).toBeGreaterThan(0.9 * 0.8);   // up again
    let jump = 0; for (let i = 200; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    expect(jump).toBeLessThan(2 / 4800 + 1e-3);
  });

  for (const dir of [0, 1]) {
    it(`a loop that does not fall on zero crossings has no click (${dir ? 'reverse' : 'forward'})`, () => {
      // 437.3 Hz in a region that is not a whole number of cycles
      const data = sine(437.3, 48000, 1);
      const p = player(48000, data, 48000, { loop: 1, dir, attack: 0.0005 });
      p.noteOn(60, 0, 1, 0.1, 0.33);
      const out = run(p, 48000 * 2, { start: 0.1, end: 0.33 });
      const slope = 0.8 * 2 * Math.PI * 437.3 / 48000;
      let worst = 0;
      for (let i = 100; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
      expect(worst).toBeLessThan(slope * 1.6);
      expect(p.busy).toBe(true);
      // without the crossfade the seam would jump by much more
      const seam = Math.abs(data[Math.ceil(0.33 * 48000) - 1] - data[Math.floor(0.1 * 48000)]);
      expect(seam).toBeGreaterThan(slope * 3);
    });
  }
});

describe('modes and envelope', () => {
  const data = sine(220, 48000, 1);
  const level = (a, from, to) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i])); return m; };

  it('One-shot ignores the note-off and plays the region through', () => {
    const p = player(48000, data, 48000, { mode: 1, loop: 1 });
    p.noteOn(60, 0, 1);
    const out = run(p, 60000, {}, [{ at: 4800, fn: (q) => q.noteOff(60) }]);
    expect(level(out, 40000, 46000)).toBeGreaterThan(0.5);
    expect(level(out, 48500, 60000)).toBe(0);
  });

  it('Held stops soon after the note-off; Chromatic fades over Decay', () => {
    const held = player(48000, data, 48000, { mode: 2, loop: 1 });
    held.noteOn(60, 0, 1);
    const ho = run(held, 24000, {}, [{ at: 4800, fn: (q) => q.noteOff(60) }]);
    expect(level(ho, 3000, 4800)).toBeGreaterThan(0.5);
    expect(level(ho, 4800 + 2400, 24000)).toBeLessThan(0.01);
    expect(held.busy).toBe(false);
    const chrom = player(48000, data, 48000, { mode: 0, loop: 1, decay: 1 });
    chrom.noteOn(60, 0, 1);
    const co = run(chrom, 48000, {}, [{ at: 4800, fn: (q) => q.noteOff(60) }]);
    const a = level(co, 4800 + 4800, 4800 + 6000), b = level(co, 4800 + 24000, 4800 + 25200);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0.005);
  });

  it('Attack ramps in over its time; Decay without Sustain falls by 60 dB over its time', () => {
    const p = player(48000, data, 48000, { attack: 0.1, sustain: 0, decay: 0.5, loop: 1 });
    p.noteOn(60, 0, 1);
    const out = run(p, 48000);
    // sine amplitude 0.8 times the default level 0.8; the first 10 ms of a 100 ms attack stays quiet
    expect(level(out, 0, 480)).toBeLessThan(0.1);
    expect(level(out, 4300, 4800)).toBeGreaterThan(0.5);
    expect(level(out, 4800 + 24000 - 500, 4800 + 24000)).toBeLessThan(0.8 * 0.002);
    expect(p.busy).toBe(false);
  });

  it('Slices map keys from Root to the slices in turn at the sample pitch', () => {
    const d = new Float32Array(48000);
    d.fill(0.25, 0, 12000); d.fill(0.5, 12000, 24000); d.fill(0.75, 24000, 48000);
    const p = player(48000, d, 48000, { mode: 3, slices: [0, 12000, 24000], attack: 0.0005 });
    for (const [note, want] of [[60, 0.25], [61, 0.5], [62, 0.75], [63, 0.25], [59, 0.75]]) {
      p.allOff(true);
      p.noteOn(note, note - 60, 1);
      const out = run(p, 2000);
      expect(out[1000]).toBeCloseTo(want * 0.8, 3);
    }
  });

  it('Slices with no marks are sixteen even pieces, and a named slice overrides the key', () => {
    const d = new Float32Array(48000);
    for (let i = 0; i < 16; i++) d.fill((i + 1) / 16, i * 3000, (i + 1) * 3000);
    const p = player(48000, d, 48000, { mode: 3, attack: 0.0005 });
    p.noteOn(60, 0, 1);
    expect(run(p, 400)[200]).toBeCloseTo((1 / 16) * 0.8, 2);
    p.allOff(true);
    p.noteOn(61, 1, 1);
    expect(run(p, 400)[200]).toBeCloseTo((2 / 16) * 0.8, 2);
    p.allOff(true);
    p.noteOn(60, 0, 1, 0, 1, 4);
    expect(run(p, 400)[200]).toBeCloseTo((5 / 16) * 0.8, 2);
  });

  it('a stereo take plays each channel, and a mismatched right channel is dropped', () => {
    const left = new Float32Array(4800).fill(0.5);
    const right = new Float32Array(4800).fill(-0.25);
    const p = new SamplerPlayer(48000);
    p.setData(left, 48000, right);
    p.configure({ ...defaultSampler(), attack: 0.0005, loop: 1 });
    p.noteOn(60, 0, 1);
    const L = new Float32Array(400), R = new Float32Array(400);
    p.render(L, R, 0, 400);
    expect(L[200]).toBeCloseTo(0.5 * 0.8, 3);
    expect(R[200]).toBeCloseTo(-0.25 * 0.8, 3);
    const data = pcmToBase64(new Float32Array(8).fill(0.2));
    const other = pcmToBase64(new Float32Array(8).fill(-0.2));
    expect(sanitizeSampler({ on: 1, sample: { rate: 48000, data, right: other } }).sample.right).toBe(other);
    expect(sanitizeSampler({ on: 1, sample: { rate: 48000, data, right: 'QQ' } }).sample.right).toBeUndefined();
  });

  it('at most eight notes sound; the ninth steals with a short fade', () => {
    const p = player(48000, data, 48000, { loop: 1 });
    for (let k = 0; k < MAX_VOICES + 1; k++) p.noteOn(60 + k, k, 1);
    const out = run(p, 4800);
    const sounding = p.voices.filter(v => v.on && !v.steal).length;
    expect(sounding).toBe(MAX_VOICES);
    expect(p.voices.some(v => v.on && v.note === 60)).toBe(false);   // the oldest went
    expect(p.voices.some(v => v.on && v.note === 68)).toBe(true);
    expect(out.every(Number.isFinite)).toBe(true);
    // many fast notes never allocate more voices
    for (let k = 0; k < 100; k++) p.noteOn(40 + (k % 40), 0, 1);
    expect(p.voices.length).toBeLessThanOrEqual(MAX_VOICES + 4);
    expect(p.voices.filter(v => v.on && !v.steal).length).toBeLessThanOrEqual(MAX_VOICES);
  });
});

describe('granular', () => {
  const data = sine(330, 48000, 2);
  const gcfg = (g) => ({ mode: 4, grain: { size: 0.05, density: 40, spread: 0.3, jitter: 2, rev: 0.3, ...g } });

  it('the window is a periodic Hann: halves overlapped by 50% sum to one', () => {
    const N = GRAIN_WINDOW.length - 1;
    for (let i = 0; i < N / 2; i++) expect(GRAIN_WINDOW[i] + GRAIN_WINDOW[i + N / 2]).toBeCloseTo(1, 6);
    expect(GRAIN_WINDOW[0]).toBe(0);
  });

  it('starts grains at the Density rate', () => {
    for (const density of [5, 20, 80]) {
      const p = player(48000, data, 48000, gcfg({ density }));
      p.noteOn(60, 0, 1);
      run(p, 48000);
      expect(Math.abs(p.grainsStarted - density)).toBeLessThanOrEqual(1);
    }
  });

  it('a full grain pool skips grains instead of allocating', () => {
    const p = player(48000, data, 48000, gcfg({ density: 100, size: 0.5 }));
    p.noteOn(60, 0, 1);
    const out = run(p, 48000);
    expect(p.voices[0].gOn.length).toBe(24);
    expect(p.grainsStarted).toBeLessThan(100);
    expect(out.every(Number.isFinite)).toBe(true);
  });

  it('is deterministic: the same notes render the same samples, and no NaN', () => {
    const go = () => {
      const p = player(48000, data, 48000, gcfg({}));
      return run(p, 48000, { pos: 0.3 }, [{ at: 0, fn: (q) => q.noteOn(60, 0, 0.9) }, { at: 9000, fn: (q) => q.noteOn(67, 7, 0.7) }, { at: 30000, fn: (q) => q.noteOff(60) }]);
    };
    const a = go(), b = go();
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(Math.max(...a.map(Math.abs))).toBeGreaterThan(0.05);
    expect(Math.max(...a.map(Math.abs))).toBeLessThan(2);
  });

  it('key pitch transposes the grains', () => {
    const p = player(48000, data, 48000, gcfg({ jitter: 0, rev: 0, spread: 0, size: 0.2, density: 10 }));
    p.noteOn(72, 12, 1);
    const out = run(p, 24000);
    expect(freqOf(out, 48000, 2000, 9000) / 660).toBeCloseTo(1, 1);
  });
});

describe('saved data', () => {
  it('a default session has no sampler field and stays the same', () => {
    const st = migrateState(defaultState());
    expect(st.parts.every(p => !('sampler' in p))).toBe(true);
    expect(JSON.stringify(migrateState(JSON.parse(JSON.stringify(st))))).toBe(JSON.stringify(st));
    expect(sanitizeSampler(undefined)).toBe(null);
    expect(sanitizeSampler('x')).toBe(null);
  });

  it('a sampler session round-trips and bad values are clamped', () => {
    const st = JSON.parse(JSON.stringify(defaultState()));
    const data = pcmToBase64(sine(220, 48000, 0.1));
    st.parts[1].sampler = { on: 1, name: 'Voice', sample: { rate: 44100, data }, mode: 4, root: 57, fine: -20, loop: 1, dir: 2, attack: 0.01, decay: 3, sustain: 0, level: 0.6, slices: [0, 100, 50, 200], grain: { size: 2, density: 0, spread: 0.5, jitter: 3, rev: 0.2 } };
    const a = migrateState(st);
    expect(a.parts[1].sampler.sample.data).toBe(data);
    expect(a.parts[1].sampler.slices).toEqual([0, 100, 200]);
    expect(a.parts[1].sampler.grain.size).toBe(0.5);
    expect(a.parts[1].sampler.grain.density).toBe(1);
    expect(migrateState(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(a.parts[0].sampler).toBeUndefined();
    // audio past the cap is dropped, the settings stay
    const big = sanitizeSampler({ on: 1, sample: { rate: 48000, data: 'A'.repeat(SAMPLER_MAX_B64 + 4) } });
    expect(big.sample).toBe(null);
  });

  it('undo snapshots share the audio string and label sampler edits', () => {
    const store = createStore(defaultState());
    store.set('parts.0.sampler', { ...defaultSampler(), on: 1, sample: { rate: 48000, data: 'AAAA' } });
    const snap = snapshotState(store);
    store.set('parts.0.sampler.attack', 0.5);
    expect(snap.parts[0].sampler.attack).toBe(0.002);
    expect(snap.parts[0].sampler.sample).toEqual({ rate: 48000, data: 'AAAA' });
    expect(describeEdit('parts.0.sampler.attack')).toBe('Sampler attack, track 1');
    expect(describeEdit('parts.1.params.smpSpeed')).toBe('Sample speed, track 2');
  });

  it('the freeze signature changes with the sampler and is unchanged without one', () => {
    const st = migrateState(defaultState());
    const before = freezeSignature(st.parts[0]);
    // json plus terrain A, terrain B, noise, and one slot per drum pad (the default kit)
    const pads = (st.parts[0].drum && st.parts[0].drum.pads) || [];
    expect(before.length).toBe(1 + 3 + pads.length);
    const withS = { ...st.parts[0], sampler: sanitizeSampler({ on: 1, sample: { rate: 48000, data: 'AAAA' } }) };
    const s1 = freezeSignature(withS);
    const s2 = freezeSignature({ ...withS, sampler: { ...withS.sampler, decay: 5 } });
    expect(s1[0]).not.toBe(before[0]);
    expect(s2[0]).not.toBe(s1[0]);
    expect(s1.at(-1)).toBe('AAAA');
  });
});

describe('sync', () => {
  function setup() {
    const store = createStore(defaultState());
    const batches = [];
    let pending = null;
    const sync = createStoreSync({ store, post: (m) => batches.push(m), onGlobal: () => {}, defer: (fn) => { pending = fn; } });
    const flush = () => { const f = pending; pending = null; if (f) f(); };
    return { store, sync, batches, flush };
  }

  it('a default session sends no sampler messages', () => {
    const { sync } = setup();
    expect(sync.snapshot().some(m => m.t === 'sampler')).toBe(false);
  });

  it('sends the audio once, then only settings while a knob moves', () => {
    const { store, batches, flush, sync } = setup();
    const data = pcmToBase64(new Float32Array(512).fill(0.2));
    store.set('parts.0.sampler', { ...defaultSampler(), on: 1, sample: { rate: 44100, data } });
    flush();
    let m = batches.at(-1).find(x => x.t === 'sampler');
    expect(m.pcm).toBeInstanceOf(Float32Array);
    expect(m.rate).toBe(44100);
    store.set('parts.0.sampler.decay', 4);
    flush();
    m = batches.at(-1).find(x => x.t === 'sampler');
    expect(m.keep).toBe(1);
    expect(m.pcm).toBeUndefined();
    expect(m.cfg.decay).toBe(4);
    // a snapshot for another DSP carries the audio but does not change what the live one has
    expect(sync.snapshot().find(x => x.t === 'sampler').pcm).toBeInstanceOf(Float32Array);
    store.set('parts.0.sampler.level', 0.5);
    flush();
    expect(batches.at(-1).find(x => x.t === 'sampler').keep).toBe(1);
    // new audio is sent again; switching off says so once
    store.set('parts.0.sampler.sample', { rate: 48000, data: pcmToBase64(new Float32Array(512).fill(0.1)) });
    flush();
    expect(batches.at(-1).find(x => x.t === 'sampler').pcm).toBeInstanceOf(Float32Array);
    store.set('parts.0.sampler.on', 0);
    flush();
    expect(batches.at(-1).find(x => x.t === 'sampler')).toEqual({ t: 'sampler', part: 0, on: 0 });
  });
});

describe('engine', () => {
  function samplerDSP(cfg = {}) {
    const dsp = makeDSP({ terrainA: 0 });
    dsp.handleMessage({ t: 'sampler', part: 0, on: 1, cfg: samplerConfig({ ...defaultSampler(), loop: 1, ...cfg }), pcm: sine(220, 44100, 1), rate: 44100 });
    return dsp;
  }

  it('a sampler track plays the sample at the key pitch; off, it is a synth again', () => {
    const dsp = samplerDSP();
    const out = render(dsp, 0.5, (d, t, b) => { if (b === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 72, vel: 1 }); });
    expect(freqOf(out.L, SR, Math.round(SR * 0.1)) / 440).toBeCloseTo(1, 2);
    expect(out.L.every(Number.isFinite)).toBe(true);
    dsp.handleMessage({ t: 'sampler', part: 0, on: 0 });
    expect(dsp.partAt(0).smpOn).toBe(false);
  });

  it('a settings-only update keeps the audio; Speed comes from the track parameter', () => {
    const dsp = samplerDSP();
    const before = dsp.partAt(0).smp.data;
    dsp.handleMessage({ t: 'sampler', part: 0, on: 1, keep: 1, cfg: samplerConfig({ ...defaultSampler(), decay: 7 }) });
    expect(dsp.partAt(0).smp.data).toBe(before);
    expect(dsp.partAt(0).smp.cfg.decay).toBe(7);
    dsp.handleMessage({ t: 'params', part: 0, p: { smpSpeed: 2 } });
    const out = render(dsp, 0.5, (d, t, b) => { if (b === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 60, vel: 1 }); });
    expect(freqOf(out.L, SR, Math.round(SR * 0.1)) / 440).toBeCloseTo(1, 2);
  });

  it('the same notes render identically twice (bounce matches live)', () => {
    const go = () => {
      const dsp = samplerDSP({ mode: 4 });
      return render(dsp, 0.5, (d, t, b) => { if (b === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 64, vel: 0.8 }); if (b === 100) d.handleMessage({ t: 'noteOff', part: 0, note: 64 }); }).L;
    };
    const a = go(), b = go();
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });
});
