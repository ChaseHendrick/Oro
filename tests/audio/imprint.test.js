// 2.10 Imprint: a sound written into the land along the orbit (src/audio/imprint.js).
import { describe, it, expect } from 'vitest';
import {
  analyseImprint, imprintTerrain, orbitPoints, normaliseCycle, timeRingSize, MAX_RINGS, IMPRINT_SIZE,
} from '../../src/audio/imprint.js';
import { decodeImportedTerrain } from '../../src/audio/terrain-jobs.js';
import { sanitizeUserTerrain } from '../../src/dsp/user-terrain.js';
import { sanitizePart } from '../../src/core/migrate.js';
import { buildMipChain, generateTerrain } from '../../src/dsp/terrains.js';
import { OroDSP } from '../../src/dsp/dsp-core.js';
import { render } from '../dsp/helpers.js';

const SR = 48000;
const H = [1, 0.5, 0.33, 0.25, 0.4, 0.1, 0.2, 0.05];
const PH = [0, 1, 2, 0.5, 1.5, 3, 0.2, 2.2];

/** A steady note made of the harmonics H (phases PH), with `amp(h, t)` shaping them over time. */
function tone(f0, seconds, amp = () => 1) {
  const n = Math.round(seconds * SR), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 0; h < H.length; h++) v += H[h] * amp(h, i / n) * Math.sin(2 * Math.PI * f0 * (h + 1) * i / SR + PH[h]);
    x[i] = 0.3 * v;
  }
  return x;
}

/** Magnitudes of harmonics 1..count (relative to the first) of a periodic signal over [start, start + n); no window for exactly one period. */
function harmonics(x, f0, start, n, count = 8, sr = SR, hann = true) {
  const out = [];
  for (let h = 1; h <= count; h++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const w = hann ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n) : 1, a = 2 * Math.PI * f0 * h * i / sr;
      re += w * x[start + i] * Math.cos(a); im += w * x[start + i] * Math.sin(a);
    }
    out.push(Math.hypot(re, im));
  }
  return out.map(m => m / out[0]);
}

/** Bilinear read of a square periodic table (the DSP's lookup). */
function bil(d, s, u, v) {
  const x = u * s, y = v * s, xf = Math.floor(x), yf = Math.floor(y), fx = x - xf, fy = y - yf, m = s - 1;
  const x0 = xf & m, y0 = yf & m, x1 = (x0 + 1) & m, r0 = y0 * s, r1 = ((y0 + 1) & m) * s;
  const top = d[r0 + x0] + fx * (d[r0 + x1] - d[r0 + x0]), bot = d[r1 + x0] + fx * (d[r1 + x1] - d[r1 + x0]);
  return top + fy * (bot - top);
}

const PATH = { pathShape: 0, pathOrder: 2, pathParam: 0.5, size: 0.22, centerX: 0.5, centerY: 0.5 };

describe('Imprint', () => {
  it('finds the pitch and cuts single cycles', () => {
    const a = analyseImprint(tone(220, 1), SR);
    expect(a.ok).toBe(true);
    expect(Math.abs(a.freq / 220 - 1)).toBeLessThan(0.002);
    expect(a.frames.length).toBeGreaterThan(8);
    expect(a.frames[0].length).toBe(512);
    expect(analyseImprint(new Float32Array(SR), SR).ok).toBe(false);
  });

  it('the track plays the source cycle back along its orbit (harmonics within tolerance)', () => {
    const a = analyseImprint(tone(220, 1), SR);
    const base = { size: 512, data: generateTerrain(0, { size: 512, seed: 7, detail: 0.5 }) };
    for (const strength of [0, 0.6, 1]) {
      const ut = imprintTerrain({ frames: a.frames, mode: 'single', params: PATH, base, strength, name: 'Imprint test' });
      const dsp = new OroDSP(SR);
      dsp.handleMessage({ t: 'terrain', part: 0, slot: 0, levels: buildMipChain(decodeImportedTerrain(ut, 512), 512) });
      dsp.handleMessage({ t: 'params', part: 0, p: { filterType: 0, ...PATH } });
      const out = render(dsp, 0.8, (d, t, k) => { if (k === 1) d.handleMessage({ t: 'noteOn', part: 0, note: 45, vel: 100 }); });
      const got = harmonics(out.L, 110, Math.round(0.3 * SR), Math.round(0.5 * SR));
      for (let h = 0; h < H.length; h++) expect(Math.abs(got[h] - H[h] / H[0])).toBeLessThan(0.01);
    }
  }, 120000);

  it('Time mode puts later cycles on bigger rings, so Size scans through the sound', () => {
    // the second harmonic grows from nothing to full over the recording
    const x = tone(196, 2, (h, t) => (h === 1 ? t : 1));
    const a = analyseImprint(x, SR, { frames: MAX_RINGS });
    expect(a.ok).toBe(true);
    const ut = imprintTerrain({ frames: a.frames, mode: 'time', params: PATH, base: null, strength: 1, name: 'Time test' });
    const tab = decodeImportedTerrain(ut, 512);
    const count = Math.min(MAX_RINGS, a.frames.length);
    const ratios = [];
    for (let k = 0; k < count; k += 3) {
      const pts = orbitPoints(PATH, 1024, 1, timeRingSize(k, count));
      const cyc = new Float64Array(1024);
      for (let i = 0; i < 1024; i++) cyc[i] = bil(tab, 512, pts[2 * i], pts[2 * i + 1]);
      const r = harmonics(cyc, 1, 0, 1024, 2, 1024, false);
      ratios.push(r[1]);
    }
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    expect(ratios[0]).toBeLessThan(0.15);
    expect(ratios[ratios.length - 1]).toBeGreaterThan(0.35);
  }, 60000);

  it('orbitPoints follows the DSP orbit: within Size of the dot, Stretch squashes it by 2^(1.5 Stretch) each way', () => {
    const extents = (p) => {
      const pts = orbitPoints(p, 256);
      let mx = 0, my = 0, rmax = 0;
      for (let i = 0; i < 256; i++) {
        const dx = pts[2 * i] - p.centerX, dy = pts[2 * i + 1] - p.centerY;
        mx = Math.max(mx, Math.abs(dx)); my = Math.max(my, Math.abs(dy)); rmax = Math.max(rmax, Math.hypot(dx, dy));
      }
      return { mx, my, rmax };
    };
    const plain = extents(PATH);
    expect(plain.rmax).toBeGreaterThan(0.215); expect(plain.rmax).toBeLessThan(0.2205);
    const moved = extents({ ...PATH, centerX: 0.25, stretch: 1 });
    expect((moved.mx / moved.my) / (plain.mx / plain.my)).toBeCloseTo(8, 1);
  });

  it('saves like any user terrain and survives sanitize and a session round trip', () => {
    const a = analyseImprint(tone(220, 0.6), SR);
    const ut = imprintTerrain({ frames: a.frames, mode: 'single', params: PATH, base: null, strength: 0.5, name: 'Imprint of "note.wav"' });
    expect(ut).toMatchObject({ kind: 'image', w: IMPRINT_SIZE, h: IMPRINT_SIZE, mirror: 0 });
    const clean = sanitizeUserTerrain(ut);
    expect(clean).toEqual(ut);
    const part = sanitizePart(JSON.parse(JSON.stringify({ userTerrain: { A: ut, B: null } })), 0);
    expect(part.userTerrain.A).toEqual(ut);
    expect(part.userTerrain.B).toBe(null);
  }, 60000);

  it('normaliseCycle removes the mean and scales to peak 1', () => {
    const c = normaliseCycle(Float64Array.from({ length: 64 }, (_, i) => 3 + 2 * Math.sin(2 * Math.PI * i / 64)));
    expect(Math.max(...c.map(Math.abs))).toBeCloseTo(1, 9);
    expect(c.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 9);
  });
});
