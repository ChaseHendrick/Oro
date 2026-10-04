// 2.12 3D sound: the head model, Follow dot, surround panning and the engine wiring.
import { describe, it, expect } from 'vitest';
import {
  Binaural, itdSeconds, shadowDb, spaceTargets, distanceGain, airDb, panSpeakers, SURROUND_LAYOUTS, ITD_MAX,
  dotToSpace, radiusToDistance, wrapAz, DIST_GAIN_MAX,
} from '../../src/dsp/spatial.js';
import { makeDSP, render, allFinite, rms, SR } from './helpers.js';

/** Render a 1 kHz tone (or noise) through a fresh Binaural at a fixed position. */
function through(az, el = 0, dist = 1, { seconds = 0.25, kind = 'tone', air = true } = {}) {
  const b = new Binaural(SR);
  b.target(az, el, dist, air, true);
  b.reset();
  b.wT = 1; b.w = 1;
  const n = Math.round(seconds * SR);
  const L = new Float64Array(n), R = new Float64Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    let x;
    if (kind === 'tone') x = Math.sin(2 * Math.PI * 1000 * i / SR);
    else if (kind === 'click') x = i === 64 ? 1 : 0;
    else { seed = (seed * 1664525 + 1013904223) >>> 0; x = seed / 2 ** 31 - 1; }
    L[i] = x; R[i] = x;
  }
  for (let p = 0; p < n; p += 128) { b.target(az, el, dist, air, false); b.process(L, R, p, Math.min(128, n - p)); }
  return { L, R, n };
}
const firstAbove = (a, thr) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > thr) return i; return -1; };

describe('head model', () => {
  it('ITD: 0 in front, right source makes the left ear late, bounded by the spherical head', () => {
    expect(itdSeconds(0, 0)).toBe(0);
    expect(itdSeconds(90, 0)).toBeGreaterThan(0.0006);
    expect(itdSeconds(90, 0)).toBeLessThanOrEqual(ITD_MAX + 1e-12);
    expect(itdSeconds(-90, 0)).toBeCloseTo(-itdSeconds(90, 0), 12);
    // front-back: the mirror image behind has the same time difference
    for (const a of [10, 30, 60, 80]) expect(itdSeconds(180 - a, 0)).toBeCloseTo(itdSeconds(a, 0), 12);
    // overhead there is no time difference
    expect(Math.abs(itdSeconds(90, 90))).toBeLessThan(1e-12);
  });

  it('head shadow: near ear brighter, far ear darker, 0 dB straight ahead', () => {
    expect(shadowDb(Math.PI / 2)).toBeCloseTo(0, 9);
    expect(shadowDb(0)).toBeGreaterThan(3);
    expect(shadowDb(5 * Math.PI / 6)).toBeLessThan(-15);
    expect(shadowDb(Math.PI)).toBeGreaterThan(shadowDb(5 * Math.PI / 6));
  });

  it('front at 1 m and no height is exactly the plain centred track', () => {
    const { L, R } = through(0, 0, 1, { kind: 'noise' });
    let seed = 12345;
    for (let i = 0; i < L.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = seed / 2 ** 31 - 1;
      expect(L[i]).toBe(R[i]);
      expect(Math.abs(L[i] - x)).toBeLessThan(1e-9);
    }
  });

  it('a source on the right is louder and earlier on the right, and the mirror on the left', () => {
    const r = through(90, 0, 1, { kind: 'click' });
    expect(firstAbove(r.R, 1e-3)).toBeLessThan(firstAbove(r.L, 1e-3));
    expect(firstAbove(r.L, 1e-3) - firstAbove(r.R, 1e-3)).toBeGreaterThanOrEqual(Math.floor(0.0005 * SR));
    const nR = through(90, 0, 1, { kind: 'noise' }), nL = through(-90, 0, 1, { kind: 'noise' });
    expect(rms(nR.R) / rms(nR.L)).toBeGreaterThan(1.5);
    // left/right mirror: the same numbers with the ears swapped
    for (let i = 0; i < nR.n; i++) { expect(nL.L[i]).toBeCloseTo(nR.R[i], 9); expect(nL.R[i]).toBeCloseTo(nR.L[i], 9); }
  });

  it('front and back mirror images keep left/right cues; behind is a little duller, never louder', () => {
    const f = spaceTargets(30, 0, 1), b = spaceTargets(150, 0, 1);
    expect(b.delayL).toBeCloseTo(f.delayL, 12);
    expect(b.shadowL).toBeCloseTo(f.shadowL, 12);
    expect(b.shadowR).toBeCloseTo(f.shadowR, 12);
    expect(f.back).toBe(1);
    expect(b.back).toBeLessThan(1);
    const nf = through(30, 0, 1, { kind: 'noise' }), nb = through(150, 0, 1, { kind: 'noise' });
    expect(rms(nb.L) + rms(nb.R)).toBeLessThan(rms(nf.L) + rms(nf.R));
  });

  it('distance: 1/d with a bounded close-up gain, air only past 1 m', () => {
    expect(distanceGain(1)).toBe(1);
    expect(distanceGain(4)).toBeCloseTo(0.25, 12);
    expect(distanceGain(0.01)).toBe(DIST_GAIN_MAX);
    expect(airDb(1)).toBe(0);
    expect(airDb(10)).toBeLessThan(0);
    expect(airDb(10, false)).toBe(0);
  });

  it('no NaN and bounded output for every position, even with junk input', () => {
    for (const az of [-180, -135, -90, -45, 0, 45, 90, 135, 179.9, NaN]) {
      for (const el of [-40, 0, 45, 80, NaN]) {
        for (const d of [0.5, 1, 5, 20, NaN]) {
          const { L, R } = through(az, el, d, { kind: 'noise', seconds: 0.02 });
          let peak = 0;
          for (let i = 0; i < L.length; i++) { expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
          expect(peak).toBeLessThan(DIST_GAIN_MAX * 4);
        }
      }
    }
  });

  it('a moving source glides without jumps', () => {
    const b = new Binaural(SR);
    b.target(-90, 0, 1, true, true); b.reset(); b.wT = 1; b.w = 1;
    const n = SR / 2, L = new Float64Array(n), R = new Float64Array(n);
    for (let i = 0; i < n; i++) { L[i] = R[i] = Math.sin(2 * Math.PI * 200 * i / SR) * 0.5; }
    for (let p = 0; p < n; p += 128) { b.target(-90 + 180 * p / n, 0, 1, true, false); b.process(L, R, p, 128); }
    let jump = 0;
    for (let i = 1; i < n; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
    expect(jump).toBeLessThan(0.1);
  });
});

describe('Follow dot', () => {
  it('maps the dot around the middle of the map to directions, wrapping', () => {
    expect(dotToSpace(0.5, 0.2).az).toBeCloseTo(0, 9);          // up the map: in front
    expect(dotToSpace(0.8, 0.5).az).toBeCloseTo(90, 9);         // right
    expect(dotToSpace(0.2, 0.5).az).toBeCloseTo(-90, 9);        // left
    expect(Math.abs(dotToSpace(0.5, 0.8).az)).toBeCloseTo(180, 9); // behind
    expect(dotToSpace(0.5, 0.5).r).toBe(0);
    expect(dotToSpace(1.3, 0.5).az).toBeCloseTo(-90, 9);        // 1.3 wraps to 0.3
    expect(radiusToDistance(0)).toBeCloseTo(0.5, 12);
    expect(radiusToDistance(1)).toBeCloseTo(8, 9);
  });
});

describe('surround panning', () => {
  const L51 = SURROUND_LAYOUTS['5.1'], L71 = SURROUND_LAYOUTS['7.1'];
  it('puts a source on the speaker at its angle', () => {
    const at = (az, L) => Array.from(panSpeakers(az, L));
    const only = (g, ch) => g.forEach((v, c) => expect(v).toBeCloseTo(c === ch ? 1 : 0, 9));
    only(at(0, L51), 2);
    only(at(-30, L51), 0);
    only(at(30, L51), 1);
    only(at(-110, L51), 4);
    only(at(110, L51), 5);
    only(at(90, L71), 7);
    only(at(-150, L71), 4);
  });

  it('keeps constant power everywhere and never feeds the LFE', () => {
    for (const L of [L51, L71]) {
      for (let az = -180; az <= 180; az += 2.5) {
        const g = panSpeakers(az, L);
        let p = 0;
        for (let c = 0; c < L.channels; c++) { expect(g[c]).toBeGreaterThanOrEqual(-1e-12); p += g[c] * g[c]; }
        expect(p).toBeCloseTo(1, 9);
        expect(g[L.lfe]).toBe(0);
      }
    }
  });

  it('between front left and centre only those two play', () => {
    const g = panSpeakers(-15, L51);
    expect(g[0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(g[2]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(g[1] + g[4] + g[5]).toBe(0);
    expect(wrapAz(190)).toBeCloseTo(-170, 9);
  });
});

describe('3D in the engine', () => {
  const note = () => ({ t: 'noteOn', part: 0, note: 57, vel: 100 });
  const script = (d, t, k) => { if (k === 1) d.handleMessage(note()); if (k === 150) d.handleMessage({ t: 'noteOff', part: 0, note: 57 }); };

  it('Off is bit-identical whatever the other 3D settings, and builds nothing', () => {
    const a = render(makeDSP({ terrainA: 0 }), 0.5, script);
    const other = makeDSP({ terrainA: 0, params: { spaceAz: 77, spaceEl: 40, spaceDist: 6, spaceAir: 0 } });
    const b = render(other, 0.5, script);
    for (const k of ['L', 'R', 'DL', 'DR', 'VL', 'VR']) expect(b[k]).toEqual(a[k]);
    expect(other.parts[0].space).toBe(null);
  }, 60000);

  it('Manual at 90 degrees moves the track to the right; switching off fades back to the plain track', () => {
    const plain = render(makeDSP({ terrainA: 0, params: { spread: 0, detune: 0 } }), 0.5, script);
    const right = render(makeDSP({ terrainA: 0, params: { spread: 0, detune: 0, space: 1, spaceAz: 90 } }), 0.5, script);
    expect(allFinite(right.L) && allFinite(right.R)).toBe(true);
    expect(rms(right.R) / rms(right.L)).toBeGreaterThan(1.3);
    expect(Math.abs(rms(plain.R) / rms(plain.L) - 1)).toBeLessThan(0.05);
    const d = makeDSP({ terrainA: 0, params: { space: 1, spaceAz: 90 } });
    render(d, 0.2, script);
    d.handleMessage({ t: 'params', part: 0, p: { space: 0 } });
    render(d, 0.3, null);
    expect(d.parts[0].space.w).toBe(0);
  }, 60000);

  it('Follow dot reads the dot: dot on the left of the map, sound on the left', () => {
    const left = render(makeDSP({ terrainA: 0, params: { spread: 0, space: 2, centerX: 0.2, centerY: 0.5 } }), 0.5, script);
    expect(rms(left.L) / rms(left.R)).toBeGreaterThan(1.3);
  }, 60000);

  it('surround: a 3D track at 110 degrees goes to the right surround, a plain track to front left/right', () => {
    const d = makeDSP({ terrainA: 0, params: { spread: 0, space: 1, spaceAz: 110 } });
    d.handleMessage({ t: 'surround', layout: '5.1' });
    const n = Math.round(0.4 * SR), B = 128;
    const ch = Array.from({ length: 6 }, () => new Float32Array(B));
    const acc = Array.from({ length: 6 }, () => 0);
    const dl = new Float32Array(B), dr = new Float32Array(B), rl = new Float32Array(B), rr = new Float32Array(B);
    let t = 0;
    for (let i = 0, k = 0; i < n; i += B, k++) {
      if (k === 1) d.handleMessage(note());
      d.process(ch[0], ch[1], dl, dr, rl, rr, B, t, null, null, ch);
      for (let c = 0; c < 6; c++) for (let j = 0; j < B; j++) acc[c] += ch[c][j] * ch[c][j];
      t += B / SR;
    }
    expect(acc[5]).toBeGreaterThan(0);
    expect(acc[5]).toBeGreaterThan(100 * (acc[0] + acc[1] + acc[2] + acc[4]));
    expect(acc[3]).toBe(0);
  }, 60000);
});
