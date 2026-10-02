import { describe, it, expect } from 'vitest';
import { HeightField, intersectRay, intersectSphere, W, H, EXTENT, displayLift, wrapWorld, uToX, xToU } from '../../src/visual/heightfield.js';
import { terrainHeight, sampleBilinear } from '../../src/dsp/terrain-math.js';
import { generateTerrain } from '../../src/dsp/terrains.js';

// A table built from an analytic periodic surface: the bilinear table follows
// it to within O(texel^2), which the ray test checks against.
function analyticTable(size, f) {
  const d = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) d[j * size + i] = f(i / size, j / size);
  return d;
}
const bumps = (u, v) => 0.6 * Math.sin(2 * Math.PI * u) * Math.cos(2 * Math.PI * v) + 0.3 * Math.sin(2 * Math.PI * (2 * u + v));

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('HeightField sampler', () => {
  const A = generateTerrain(5, { size: 256, seed: 3, detail: 0.6 });
  const B = generateTerrain(2, { size: 128, seed: 9, detail: 0.4 });

  it('equals the DSP lookup (terrainHeight) for any morph and warp', () => {
    const hf = new HeightField();
    hf.setTable('A', A, 256);
    hf.setTable('B', B, 128);
    const r = rng(1);
    let worst = 0;
    for (const morph of [0, 0.37, 1]) {
      for (const warp of [0, 0.5, 1]) {
        hf.setShape(morph, warp, 1);
        for (let k = 0; k < 400; k++) {
          const u = r() * 3 - 1, v = r() * 3 - 1;
          const a = hf.norm(u, v);
          const b = terrainHeight(A, 256, B, 128, morph, warp, u, v);
          worst = Math.max(worst, Math.abs(a - b));
        }
      }
    }
    expect(worst).toBe(0);
  });

  it('scales world height by H * min(lift, 2.5)', () => {
    const hf = new HeightField();
    hf.setTable('A', A, 256);
    for (const lift of [0.25, 1, 2.5, 4]) {
      hf.setShape(0, 0, lift);
      const n = hf.norm(0.31, 0.77);
      expect(hf.y(0.31, 0.77)).toBeCloseTo(n * H * Math.min(lift, 2.5), 12);
      expect(hf.bound()).toBeCloseTo(H * Math.min(lift, 2.5), 12);
    }
    expect(displayLift(9)).toBe(2.5);
    expect(displayLift(NaN)).toBe(1);
  });

  it('wraps: every tile of the 3 x 3 plane shows the same land', () => {
    const hf = new HeightField();
    hf.setTable('A', A, 256);
    hf.setShape(0, 0.7, 1.3);
    for (let k = 0; k < 50; k++) {
      const x = (k / 50 - 0.5) * W, z = ((k * 7) % 50 / 50 - 0.5) * W;
      const y0 = hf.yAt(x, z);
      for (const dx of [-W, 0, W]) for (const dz of [-W, 0, W]) expect(hf.yAt(x + dx, z + dz)).toBeCloseTo(y0, 9);
    }
    expect(wrapWorld(7)).toBeCloseTo(-3, 12);
    expect(wrapWorld(-5.5)).toBeCloseTo(4.5, 12);
    expect(wrapWorld(4.99)).toBeCloseTo(4.99, 12);
    expect(xToU(uToX(0.37))).toBeCloseTo(0.37, 12);
  });

  it('crossfades between the previous and the new table', () => {
    const hf = new HeightField();
    hf.setTable('A', A, 256);
    const C = generateTerrain(0, { size: 256, seed: 1 });
    hf.setTable('A', C, 256, true);
    expect(hf.A.fade).toBe(0);
    const u = 0.23, v = 0.61;
    expect(hf.norm(u, v)).toBeCloseTo(sampleBilinear(A, 256, u, v), 12);
    hf.setFade('A', 0.5);
    expect(hf.norm(u, v)).toBeCloseTo(0.5 * (sampleBilinear(A, 256, u, v) + sampleBilinear(C, 256, u, v)), 12);
    hf.setFade('A', 1);
    expect(hf.A.prev).toBe(null);
    expect(hf.norm(u, v)).toBeCloseTo(sampleBilinear(C, 256, u, v), 12);
  });

  it('bumps its version only on real changes', () => {
    const hf = new HeightField();
    const v0 = hf.version;
    hf.setShape(0, 0, 1);
    expect(hf.version).toBe(v0);
    hf.setShape(0.1, 0, 1);
    expect(hf.version).toBe(v0 + 1);
    hf.setShape(0.1, 0, 3);
    hf.setShape(0.1, 0, 3.5); // both display as 2.5
    expect(hf.version).toBe(v0 + 2);
  });
});

describe('ray / heightfield intersection', () => {
  const size = 256;
  const table = analyticTable(size, bumps);
  const hf = new HeightField();
  hf.setTable('A', table, size);
  hf.setShape(0, 0, 1.5);

  it('hits the displayed surface exactly and never skips an earlier crossing', () => {
    const r = rng(7);
    const out = {};
    let hits = 0, worstY = 0, worstAnalytic = 0;
    for (let k = 0; k < 300; k++) {
      // cameras above the land looking down at all sorts of angles
      const ox = (r() - 0.5) * 30, oz = (r() - 0.5) * 30, oy = 3 + r() * 20;
      const tx = (r() - 0.5) * 2 * EXTENT, tz = (r() - 0.5) * 2 * EXTENT;
      const dx = tx - ox, dy = -oy - 0.5, dz = tz - oz;
      if (!intersectRay(hf, ox, oy, oz, dx, dy, dz, out)) continue;
      hits++;
      worstY = Math.max(worstY, Math.abs(out.y - hf.yAt(out.x, out.z)));
      // the analytic surface agrees to within the table's interpolation error
      const ya = bumps(out.u, out.v) * H * 1.5;
      worstAnalytic = Math.max(worstAnalytic, Math.abs(out.y - ya));
      // brute force: nothing above the hit point along the ray dips below the land first
      const len = Math.hypot(dx, dy, dz);
      for (let s = 0; s < out.t; s += 0.004) {
        const x = ox + dx / len * s, y = oy + dy / len * s, z = oz + dz / len * s;
        if (Math.abs(x) <= EXTENT && Math.abs(z) <= EXTENT && y < hf.yAt(x, z) - 1e-6) {
          throw new Error(`missed an earlier crossing at t=${s} (hit at ${out.t})`);
        }
      }
    }
    expect(hits).toBeGreaterThan(200);
    expect(worstY).toBeLessThan(1e-6);
    expect(worstAnalytic).toBeLessThan(2e-3);
  });

  it('works straight down (top view) and at grazing angles (low view)', () => {
    const out = {};
    expect(intersectRay(hf, 1.23, 30, -2.5, 0, -1, 0, out)).toBe(true);
    expect(out.x).toBeCloseTo(1.23, 9);
    expect(out.z).toBeCloseTo(-2.5, 9);
    expect(out.y).toBeCloseTo(hf.yAt(1.23, -2.5), 6);
    // grazing ray from far away across all three tiles
    expect(intersectRay(hf, -14.9, 2.6, -14.9, 1, -0.05, 0.9, out)).toBe(true);
    expect(Math.abs(out.y - hf.yAt(out.x, out.z))).toBeLessThan(1e-6);
  });

  it('misses when the ray never reaches the land or leaves the 3 x 3 plane', () => {
    const out = {};
    expect(intersectRay(hf, 0, 10, 0, 0, 1, 0, out)).toBe(false);       // looking up
    expect(intersectRay(hf, 0, 10, 0, 1, 0, 0, out)).toBe(false);       // horizontal above the slab
    expect(intersectRay(hf, 40, 5, 0, 1, -0.1, 0, out)).toBe(false);    // outside, pointing away
  });

  it('ray / sphere picks the marble', () => {
    expect(intersectSphere(0, 0, 10, 0, 0, -1, 0, 0, 0, 1)).toBeCloseTo(9, 12);
    expect(intersectSphere(0, 2, 10, 0, 0, -1, 0, 0, 0, 1)).toBe(-1);
  });
});
