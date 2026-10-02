import { describe, it, expect, vi } from 'vitest';
import { PATHS } from '../../src/dsp/catalog.js';
import { pathPoint, pathBlock, pathLength, samplePath, PATH_COUNT } from '../../src/dsp/paths.js';

// Offline renders are heavy and the suite may share a busy machine: measure
// quality here, not wall-clock speed (dev/dsp/bench.mjs measures CPU time).
vi.setConfig({ testTimeout: 120000 });

const SCAN = PATHS.findIndex(p => p.id === 'scan');
const PARAMS = [0, 0.25, 0.5, 0.75, 1];
const pt = { x: 0, y: 0 };

function trace(shape, order, param, n) {
  const xs = new Float64Array(n + 1), ys = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    pathPoint(shape, i / n, order, param, pt);
    xs[i] = pt.x; ys[i] = pt.y;
  }
  return { xs, ys };
}

describe('paths', () => {
  it('covers every catalog entry', () => {
    expect(PATH_COUNT).toBe(PATHS.length);
  });

  it('stays inside [-1, 1], is closed and continuous for every shape/order/param', () => {
    const N = 4096;
    let worst = { step: 0 };
    const failures = [];
    for (let s = 0; s < PATH_COUNT; s++) {
      for (let o = 1; o <= 8; o++) {
        for (const p of PARAMS) {
          const { xs, ys } = trace(s, o, p, N);
          let maxR = 0, maxStep = 0, finite = true;
          for (let i = 0; i <= N; i++) {
            if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) finite = false;
            maxR = Math.max(maxR, Math.abs(xs[i]), Math.abs(ys[i]));
            if (i > 0 && !(s === SCAN && i === N)) {
              maxStep = Math.max(maxStep, Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
            }
          }
          const tag = `${PATHS[s].id} o${o} p${p}`;
          if (!finite) failures.push(`${tag}: non-finite`);
          if (maxR > 1 + 1e-9) failures.push(`${tag}: out of bounds ${maxR}`);
          // roughly normalised footprint: the outermost point sits near the unit square edge
          if (maxR < 0.5) failures.push(`${tag}: footprint too small ${maxR}`);
          if (maxStep >= 0.12) failures.push(`${tag}: step ${maxStep}`);
          if (s === SCAN) {
            // open sawtooth sweep: x jumps by exactly 2 (one terrain period at Size 0.5)
            pathPoint(s, 1 - 1e-12, o, p, pt);
            if (Math.abs(xs[0] + 1) > 1e-12 || Math.abs(pt.x - 1) > 1e-6) failures.push(`${tag}: scan ends`);
          } else {
            if (Math.hypot(xs[N] - xs[0], ys[N] - ys[0]) > 1e-9) failures.push(`${tag}: not closed`);
            // the wrap-around step is no bigger than an ordinary one
            const wrapStep = Math.hypot(xs[1] - xs[N], ys[1] - ys[N]);
            if (wrapStep > maxStep * 1.01 + 1e-12) failures.push(`${tag}: wrap step ${wrapStep} > ${maxStep}`);
          }
          if (maxStep > worst.step) worst = { step: maxStep, s, o, p };
        }
      }
    }
    expect(failures).toEqual([]);
    console.log(`[paths] largest step between consecutive samples at N=${N}: ${worst.step.toFixed(4)} (${PATHS[worst.s].id}, order ${worst.o}, param ${worst.p})`);
  });

  it('is continuous in param (no jumps when the Shape knob moves)', () => {
    for (let s = 0; s < PATH_COUNT; s++) {
      for (const o of [1, 3, 8]) {
        let maxDiff = 0;
        for (let i = 0; i < 64; i++) {
          const t = i / 64;
          for (let k = 0; k < 200; k++) {
            const a = pathPoint(s, t, o, k / 200, { x: 0, y: 0 });
            const b = pathPoint(s, t, o, (k + 1) / 200, { x: 0, y: 0 });
            maxDiff = Math.max(maxDiff, Math.hypot(a.x - b.x, a.y - b.y));
          }
        }
        expect(maxDiff).toBeLessThan(0.08);
      }
    }
  });

  it('clamps order to an integer 1..8 and param to 0..1', () => {
    const a = pathPoint(2, 0.3, 0, 0.5, { x: 0, y: 0 });
    const b = pathPoint(2, 0.3, 1, 0.5, { x: 0, y: 0 });
    expect(a).toEqual(b);
    const c = pathPoint(2, 0.3, 12, 0.5, { x: 0, y: 0 });
    const d = pathPoint(2, 0.3, 8, 0.5, { x: 0, y: 0 });
    expect(c).toEqual(d);
    const e = pathPoint(2, 0.3, 3, -2, { x: 0, y: 0 });
    const f = pathPoint(2, 0.3, 3, 0, { x: 0, y: 0 });
    expect(e).toEqual(f);
  });

  it('lissajous uses ratio n:(n+1)', () => {
    // x completes `order` cycles and y order+1 cycles: count sign changes
    for (const o of [1, 2, 5]) {
      const { xs, ys } = trace(1, o, 0, 8192);
      let cx = 0, cy = 0;
      for (let i = 1; i <= 8192; i++) {
        if (Math.sign(xs[i]) !== Math.sign(xs[i - 1]) && xs[i] !== 0) cx++;
        if (Math.sign(ys[i]) !== Math.sign(ys[i - 1]) && ys[i] !== 0) cy++;
      }
      expect(Math.round(cx / 2)).toBe(o);
      expect(Math.round(cy / 2)).toBe(o + 1);
    }
  });

  it('scan order 1 is a straight sawtooth sweep', () => {
    for (let i = 0; i < 100; i++) {
      pathPoint(SCAN, i / 100, 1, 0.5, pt);
      expect(pt.x).toBeCloseTo(2 * i / 100 - 1, 12);
      expect(pt.y).toBeCloseTo(0, 12);
    }
  });

  it('pathBlock matches pathPoint sample for sample', () => {
    const n = 64;
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let s = 0; s < PATH_COUNT; s++) {
      const st = new Float64Array([0.9, 0.013, 1e-5, 0.2, 0.004]);
      pathBlock(s, 3, n, st, X, Y);
      let ph = 0.9, inc = 0.013, p = 0.2;
      for (let j = 0; j < n; j++) {
        ph += inc; if (ph >= 1) ph -= 1; inc += 1e-5; p += 0.004;
        pathPoint(s, ph, 3, p, pt);
        expect(X[j]).toBe(pt.x);
        expect(Y[j]).toBe(pt.y);
      }
      expect(st[0]).toBeCloseTo(ph, 12);
      expect(st[3]).toBeCloseTo(p, 12);
    }
  });

  it('pathLength approximates the perimeter and is cached', () => {
    expect(pathLength(0, 1, 0.5)).toBeCloseTo(2 * Math.PI, 2);
    expect(pathLength(SCAN, 1, 0.5)).toBeCloseTo(2, 3);
    for (let s = 0; s < PATH_COUNT; s++) {
      for (const o of [1, 4, 8]) {
        const L = pathLength(s, o, 0.37);
        expect(L).toBeGreaterThan(1);
        expect(L).toBeLessThan(80);
        expect(pathLength(s, o, 0.37)).toBe(L);
      }
    }
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 100000; i++) acc += pathLength(i % 12, 1 + (i % 8), (i % 97) / 97);
    expect(acc).toBeGreaterThan(0);
    // ~100 ns per call on an idle machine; generous so a loaded CI box does not flake
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('samplePath fills an interleaved Float32Array', () => {
    const out = new Float32Array(2 * 100);
    const r = samplePath(5, 3, 0.4, 100, out);
    expect(r).toBe(out);
    pathPoint(5, 0.37, 3, 0.4, pt);
    expect(out[74]).toBeCloseTo(pt.x, 6);
    expect(out[75]).toBeCloseTo(pt.y, 6);
    expect(samplePath(0, 1, 0.5, 10).length).toBe(20);
  });
});
