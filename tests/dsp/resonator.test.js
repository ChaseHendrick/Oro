// 2.10 Resonator: the terrain as a ringing membrane (src/dsp/resonator.js).
import { describe, it, expect } from 'vitest';
import { Resonator, RESO_GRID } from '../../src/dsp/resonator.js';
import { buildMipChain } from '../../src/dsp/terrains.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { PART_PARAMS, PART_PARAM_MAP } from '../../src/core/params.js';
import { sanitizePart, migrateState } from '../../src/core/migrate.js';
import { makeDSP, render, terrainChain, allFinite, SR } from './helpers.js';

const FLAT = [{ size: 64, data: new Float32Array(64 * 64) }];

/** Hann-windowed magnitude at frequency f (Goertzel). */
function mag(x, start, n, f, sr = SR) {
  const c = 2 * Math.cos(2 * Math.PI * f / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)) + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}
/** Strongest frequency in [lo, hi]: 0.5% steps, then 0.02% around the best. */
function peakFreq(x, start, n, lo, hi) {
  let best = 0, bf = lo;
  for (let f = lo; f <= hi; f *= 1.005) { const m = mag(x, start, n, f); if (m > best) { best = m; bf = f; } }
  const c = bf;
  for (let f = c / 1.006; f <= c * 1.006; f *= 1.0002) { const m = mag(x, start, n, f); if (m > best) { best = m; bf = f; } }
  return bf;
}

function ring(res, seconds, block = 32) {
  const n = Math.round(seconds * res.sr);
  const L = new Float64Array(n), R = new Float64Array(n);
  for (let p = 0; p < n; p += block) { const m = Math.min(block, n - p); res.control(m); res.process(L, R, p, m); }
  return { L, R };
}

/**
 * The scheme's stored energy between the last two steps: kinetic part
 * weighted by 1/s (slack places move more for the same energy) plus the
 * mixed potential lam2 <u, -Lap up>.
 */
function energy(res) {
  const { u, up, s, n, W } = res;
  const lam2 = res.al - res.mu;
  let e = 0;
  for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
    const k = j * W + i, d = u[k] - up[k];
    e += d * d / s[k] + lam2 * u[k] * (4 * up[k] - up[k - 1] - up[k + 1] - up[k - W] - up[k + W]);
  }
  return e;
}

describe('Resonator membrane', () => {
  it('stays stable for extreme settings: no NaN, and energy never grows without input', () => {
    const settings = [
      [0.05, 0, 0.25, 20], [20, 1, 0.25, 4000], [20, 0, 4, 30], [0.05, 1, 4, 9000], [8, 0.5, 1, 700], [20, 1, 1, 15000],
    ];
    for (const q of ['eco', 'standard', 'high']) {
      for (const [decay, tone, size, hz] of settings) {
        const r = new Resonator(SR, q);
        r.configure(1, 1, decay, tone, size, 0.7);
        r.derive(terrainChain(TERRAIN_INDEX.crater), FLAT, 0);
        r.setNote(hz, true); r.setDot(0.31, 0.62); r.control(32);
        // a random state excites every mode, the highest ones included (where an unstable scheme blows up first)
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
        for (let j = 1; j <= r.n; j++) for (let i = 1; i <= r.n; i++) { const k = j * r.W + i; r.u[k] = rnd(); r.up[k] = rnd(); }
        r.lp.fill(0); r.busy = true;
        let prev = Infinity;
        for (let w = 0; w < 12; w++) {
          let e = 0;
          for (let b = 0; b < 30; b++) { const out = ring(r, 0.002); expect(allFinite(out.L) && allFinite(out.R)).toBe(true); e += energy(r); }
          expect(Number.isFinite(e)).toBe(true);
          // averaged over 60 ms the stored energy only falls (a little slack for beating between modes)
          expect(e).toBeLessThanOrEqual(prev * 1.02 + 1e-30);
          prev = e;
        }
      }
    }
  }, 120000);

  it('a strike on flat land rings at the note, matching the square membrane fundamental', () => {
    for (const q of ['eco', 'standard', 'high']) {
      for (const hz of [98, 196, 330]) {
        const r = new Resonator(SR, q);
        r.configure(1, 1, 4, 0.8, 1, 0);
        r.derive(FLAT, FLAT, 0);
        r.setNote(hz, true); r.setDot(0.37, 0.43); r.control(32);
        r.strike(0.37, 0.43, 1);
        const { L } = ring(r, 0.6);
        const f = peakFreq(L, 2400, 16384, hz * 0.6, hz * 1.4);
        expect(Math.abs(f / hz - 1)).toBeLessThan(0.01);
        // continuous membrane with the same wave speed and side: f11 = c sqrt(2) / (2 L)
        const analytic = r.waveSpeed() * Math.SQRT2 / (2 * r.side);
        expect(Math.abs(f / analytic - 1)).toBeLessThan(0.02);
      }
    }
  }, 120000);

  it('Size moves the ring by octaves and notes above the grid ceiling fold down', () => {
    const r = new Resonator(SR, 'standard');
    r.configure(1, 1, 3, 0.8, 2, 0);
    r.derive(FLAT, FLAT, 0);
    r.setNote(220, true); r.control(32);
    expect(r.fPlayed).toBeCloseTo(110, 6);
    const e = new Resonator(SR, 'eco');
    e.configure(1, 1, 3, 0.8, 1, 0);
    e.derive(FLAT, FLAT, 0);
    e.setNote(3520, true); e.control(32);
    const oct = Math.log2(3520 / e.fPlayed);
    expect(Math.abs(oct - Math.round(oct))).toBeLessThan(1e-9);
    expect(e.S).toBe(RESO_GRID.eco.sub);
  });

  it('the shape of the land moves the overtones while the lowest mode stays on the note', () => {
    const spectrumOf = (chain) => {
      const r = new Resonator(SR, 'standard');
      r.configure(1, 1, 4, 0.9, 1, 0.3);
      r.derive(chain, FLAT, 0);
      r.setNote(110, true); r.setDot(0.29, 0.36); r.control(32);
      r.strike(0.29, 0.36, 1);
      const { L } = ring(r, 0.5);
      const bins = [];
      for (let f = 130; f < 1200; f *= 1.01) bins.push(Math.log(1e-9 + mag(L, 1200, 16384, f)));
      return { f1: peakFreq(L, 1200, 16384, 70, 150), bins };
    };
    const flat = spectrumOf(FLAT);
    const craters = spectrumOf(terrainChain(TERRAIN_INDEX.crater));
    const ridge = spectrumOf(terrainChain(TERRAIN_INDEX.ridge));
    for (const s of [flat, craters, ridge]) expect(Math.abs(s.f1 / 110 - 1)).toBeLessThan(0.01);
    const corr = (a, b) => {
      const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
      return ab / Math.sqrt(aa * bb);
    };
    expect(corr(flat.bins, craters.bins)).toBeLessThan(0.9);
    expect(corr(flat.bins, ridge.bins)).toBeLessThan(0.9);
    expect(corr(craters.bins, ridge.bins)).toBeLessThan(0.95);
  }, 120000);
});

describe('Resonator in the engine', () => {
  const note = (vel = 100) => ({ t: 'noteOn', part: 0, note: 57, vel });
  const script = (d, t, k) => { if (k === 1) d.handleMessage(note()); if (k === 120) d.handleMessage({ t: 'noteOff', part: 0, note: 57 }); };

  it('Off is bit-identical whatever its other settings, and builds nothing', () => {
    const ref = makeDSP({ terrainA: 0, terrainB: 5 });
    const a = render(ref, 0.6, script);
    const other = makeDSP({ terrainA: 0, terrainB: 5, params: { resoMix: 1, resoDecay: 9, resoTone: 0.1, resoSize: 3, resoListen: -0.5 } });
    const b = render(other, 0.6, script);
    for (const k of ['L', 'R', 'DL', 'DR', 'VL', 'VR']) expect(b[k]).toEqual(a[k]);
    expect(other.parts[0].reso).toBe(null);
    // switched on and back off before playing: the same samples again
    const back = makeDSP({ terrainA: 0, terrainB: 5, params: { resoOn: 1 } });
    back.handleMessage({ t: 'params', part: 0, p: { resoOn: 0 } });
    const c = render(back, 0.6, script);
    for (const k of ['L', 'R']) expect(c[k]).toEqual(a[k]);
  }, 120000);

  it('Strike rings on after the note, at the note, for every quality', () => {
    for (const mode of ['eco', 'standard', 'high', 'pristine']) {
      const dsp = makeDSP({ params: { resoOn: 1, resoMix: 1, resoDecay: 3, resoTone: 0.8, filterType: 0 } });
      dsp.handleMessage({ t: 'terrain', part: 0, slot: 0, levels: FLAT });
      dsp.handleMessage({ t: 'quality', mode });
      const out = render(dsp, 1.2, script);
      expect(allFinite(out.L) && allFinite(out.R)).toBe(true);
      const hz = 440 * Math.pow(2, (57 - 69) / 12);
      // after the note's release the voice is gone: what is left is the membrane
      const f = peakFreq(out.L, Math.round(0.6 * SR), 16384, hz * 0.7, hz * 1.3);
      expect(Math.abs(f / hz - 1)).toBeLessThan(0.01);
      let tail = 0;
      for (let i = Math.round(0.9 * SR); i < out.L.length; i++) tail = Math.max(tail, Math.abs(out.L[i]));
      expect(tail).toBeGreaterThan(1e-3);
    }
  }, 120000);

  it('Resonate makes the track ring through the membrane and goes quiet without input', () => {
    const peakIn = (a, from, to) => { let m = 0; for (let i = Math.round(from * SR); i < Math.min(a.length, Math.round(to * SR)); i++) m = Math.max(m, Math.abs(a[i])); return m; };
    const dry = render(makeDSP({ terrainA: TERRAIN_INDEX.crater }), 2, script);
    const dsp = makeDSP({ terrainA: TERRAIN_INDEX.crater, params: { resoOn: 2, resoMix: 1, resoDecay: 0.3 } });
    const out = render(dsp, 2, script);
    expect(allFinite(out.L)).toBe(true);
    // only the membrane is heard (Mix 1), at a level comparable with the dry track
    expect(peakIn(out.L, 0.1, 0.3)).toBeGreaterThan(0.1 * peakIn(dry.L, 0.1, 0.3));
    expect(peakIn(out.L, 1.8, 2)).toBeLessThan(1e-5);
    expect(dsp.parts[0].reso.busy).toBe(false);
  }, 120000);

  it('extreme settings in the engine stay finite and bounded', () => {
    for (const p of [{ resoDecay: 20, resoTone: 1, resoSize: 0.25 }, { resoDecay: 0.05, resoTone: 0, resoSize: 4 }, { resoDecay: 20, resoTone: 0, resoSize: 1, resoListen: 1 }]) {
      for (const resoOn of [1, 2]) {
        const dsp = makeDSP({ terrainA: TERRAIN_INDEX.ridge, params: { resoOn, resoMix: 1, ...p } });
        const out = render(dsp, 0.8, (d, t, k) => { if (k % 40 === 1) d.handleMessage({ t: 'noteOn', part: 0, note: 30 + (k % 70), vel: 127 }); });
        expect(allFinite(out.L) && allFinite(out.R)).toBe(true);
        let pk = 0;
        for (const v of out.L) pk = Math.max(pk, Math.abs(v));
        expect(pk).toBeLessThan(4);
      }
    }
  }, 120000);
});

describe('Resonator parameters', () => {
  it('are appended to the part parameters, defaulting to Off', () => {
    const ids = PART_PARAMS.map(p => p.id);
    const at = ids.indexOf('resoOn');
    expect(ids.slice(at, at + 6)).toEqual(['resoOn', 'resoMix', 'resoDecay', 'resoTone', 'resoSize', 'resoListen']);
    // 2.12 the 3D parameters come straight after them; 2.13 sampler params after those (append-only)
    expect(ids.slice(at + 6, at + 11)).toEqual(['space', 'spaceAz', 'spaceEl', 'spaceDist', 'spaceAir']);
    expect(ids.slice(at + 11, at + 15)).toEqual(['smpSpeed', 'smpStart', 'smpEnd', 'smpPos']);
    expect(ids.indexOf('resoOn')).toBe(ids.indexOf('sendB') + 1);
    expect(PART_PARAM_MAP.resoOn.default).toBe(0);
    expect(PART_PARAM_MAP.resoOn.options).toEqual(['Off', 'Strike', 'Resonate']);
  });

  it('survive sanitize and migration, out-of-range values clamped, old sessions Off', () => {
    const part = sanitizePart({ params: { resoOn: 2, resoMix: 0.3, resoDecay: 7, resoTone: 0.2, resoSize: 2, resoListen: -0.4 } }, 0);
    expect(part.params).toMatchObject({ resoOn: 2, resoMix: 0.3, resoDecay: 7, resoTone: 0.2, resoSize: 2, resoListen: -0.4 });
    const again = sanitizePart(JSON.parse(JSON.stringify(part)), 0);
    expect(again.params).toEqual(part.params);
    const wild = sanitizePart({ params: { resoOn: 9.4, resoMix: -1, resoDecay: 1e9, resoSize: 0, resoListen: 'x' } }, 0);
    expect(wild.params).toMatchObject({ resoOn: 2, resoMix: 0, resoDecay: 20, resoSize: 0.25, resoListen: 0 });
    const old = migrateState({ version: 3, parts: [{ params: { cutoff: 1200 } }] });
    for (const p of old.parts) expect(p.params).toMatchObject({ resoOn: 0, resoMix: 0.5, resoDecay: 1.5, resoTone: 0.5, resoSize: 1, resoListen: 0 });
  });
});
