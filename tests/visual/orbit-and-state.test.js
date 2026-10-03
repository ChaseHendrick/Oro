import { describe, it, expect } from 'vitest';
import { computeOrbit, LIFT_ABOVE, beadRate, flowRate } from '../../src/visual/orbit-layer.js';
import { HeightField, W } from '../../src/visual/heightfield.js';
import { pathPoint } from '../../src/dsp/paths.js';
import { pathTransform, terrainHeight } from '../../src/dsp/terrain-math.js';
import { generateTerrain } from '../../src/dsp/terrains.js';
import { PART_PARAM_MAP, toNorm, defaultPart } from '../../src/core/params.js';
import { LiveParams, targetValue, isModulated, periodicDelta, VIS_IDS } from '../../src/visual/modstate.js';
import { PALETTES, THEMES, blendAtmosphere, makeAtmosphere, blendRamp, sampleRamp, hexToLinear, linearToSrgb, srgbToLinear, sceneColor } from '../../src/visual/palettes.js';
import { mipChain, buildTerrainGeometry, MESH_RES } from '../../src/visual/terrain-layer.js';
import { frameDistance } from '../../src/visual/camera-rig.js';

describe('orbit polyline', () => {
  const A = generateTerrain(0, { size: 256, seed: 7 });
  const B = generateTerrain(5, { size: 256, seed: 7 });
  const hf = new HeightField();
  hf.setTable('A', A, 256);
  hf.setTable('B', B, 256);

  it('uses exactly the audio transform and terrain lookup', () => {
    const live = { stretch: 0.4, size: 0.31, rotate: 37, centerX: 0.93, centerY: 0.05 };
    const morph = 0.4, warp = 0.6, lift = 1.7, spin = 0.21;
    hf.setShape(morph, warp, lift);
    const n = 128;
    const pts = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    for (const shape of [0, 2, 6, 10, 11]) {
      computeOrbit(hf, shape, 3, 0.35, live, spin, n, pts, uv, {}, {});
      const p = { x: 0, y: 0 }, o = { u: 0, v: 0 };
      for (let i = 0; i < n; i += 7) {
        pathPoint(shape, i / n, 3, 0.35, p);
        pathTransform(p.x, p.y, live.stretch, live.size, live.rotate, spin, live.centerX, live.centerY, o);
        expect(uv[2 * i]).toBeCloseTo(o.u, 5);
        expect(uv[2 * i + 1]).toBeCloseTo(o.v, 5);
        expect(pts[3 * i]).toBeCloseTo((o.u - 0.5) * W, 4);
        expect(pts[3 * i + 2]).toBeCloseTo((o.v - 0.5) * W, 4);
        const h = terrainHeight(A, 256, B, 256, morph, warp, o.u, o.v);
        expect(pts[3 * i + 1]).toBeCloseTo(h * 1.6 * 1.7 + LIFT_ABOVE, 4);
      }
    }
  });

  it('is unwrapped around the dot (it may reach into neighbour tiles)', () => {
    const live = { stretch: 0, size: 0.4, rotate: 0, centerX: 0.95, centerY: 0.5 };
    hf.setShape(0, 0, 1);
    const n = 64;
    const pts = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    computeOrbit(hf, 0, 1, 0.5, live, 0, n, pts, uv, {}, {});
    let maxU = -Infinity;
    for (let i = 0; i < n; i++) maxU = Math.max(maxU, uv[2 * i]);
    expect(maxU).toBeGreaterThan(1.2);           // crosses the right-hand seam
    for (let i = 1; i < n; i++) expect(Math.abs(uv[2 * i] - uv[2 * i - 2])).toBeLessThan(0.1); // no wrap jumps
  });

  it('beads and the flow pulse are slow, pitch-related and bounded', () => {
    expect(beadRate(72)).toBeGreaterThan(beadRate(60));
    expect(beadRate(127)).toBeLessThanOrEqual(1.6);
    expect(beadRate(0)).toBeGreaterThanOrEqual(0.05);
    expect(flowRate(NaN)).toBeGreaterThan(0);
    expect(flowRate(96)).toBeLessThanOrEqual(1.2);
  });
});

describe('live parameters from telemetry', () => {
  const part = defaultPart(0);

  it('reads unmodulated values straight from the store, modulated ones from telemetry', () => {
    const params = { ...part.params, size: 0.3, centerX: 0.2 };
    const mods = JSON.parse(JSON.stringify(part.mods));
    const tele = { n: { size: toNorm(PART_PARAM_MAP.size, 0.1), centerX: 0.9, morph: 0.5 } };
    expect(targetValue('size', params, mods, tele)).toBeCloseTo(0.3, 12);
    mods.size.lfoDepth = 0.2;
    expect(isModulated(mods, 'size')).toBe(true);
    expect(targetValue('size', params, mods, tele)).toBeCloseTo(0.1, 9);
    // morph always follows telemetry (the mod wheel adds to it)
    expect(targetValue('morph', params, mods, tele)).toBeCloseTo(0.5, 12);
    expect(targetValue('centerX', params, mods, tele)).toBeCloseTo(0.2, 12);
    expect(targetValue('centerX', params, mods, null)).toBeCloseTo(0.2, 12);
  });

  it('smooths the shortest way round for the dot and rotation', () => {
    const live = new LiveParams();
    const params = { ...part.params, centerX: 0.98, rotate: 350 };
    live.setTargets(params, part.mods, null);
    expect(live.cur.centerX).toBeCloseTo(0.98, 12);
    params.centerX = 0.02;
    params.rotate = 10;
    live.setTargets(params, part.mods, null);
    live.step(1 / 60, 0.03);
    // moved forward across the seam, not backwards across the map
    expect(periodicDelta(0.98, live.cur.centerX, 1)).toBeGreaterThan(0);
    expect(periodicDelta(0.98, live.cur.centerX, 1)).toBeLessThan(0.04);
    expect(periodicDelta(350, live.cur.rotate, 360)).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) live.step(1 / 60, 0.03);
    expect(live.cur.centerX).toBeCloseTo(0.02, 6);
    expect(live.cur.rotate).toBeCloseTo(10, 4);
    for (const id of VIS_IDS) expect(Number.isFinite(live.cur[id])).toBe(true);
  });
});

describe('palettes and atmosphere', () => {
  it('has six valid linear stops per theme for every palette', () => {
    for (const p of PALETTES) {
      for (const theme of ['dark', 'light']) {
        expect(p[theme]).toHaveLength(6);
        for (const c of p[theme]) for (const ch of c) { expect(ch).toBeGreaterThanOrEqual(0); expect(ch).toBeLessThanOrEqual(1); }
        // ramps climb from valley to peak
        const lum = p[theme].map(c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
        for (let i = 1; i < 6; i++) expect(lum[i]).toBeGreaterThan(lum[i - 1]);
      }
    }
  });

  it('blends the atmospheres and ramps without allocating new shapes', () => {
    const atm = makeAtmosphere();
    blendAtmosphere(0, atm);
    expect(atm.fog).toEqual(THEMES.dark.fog);
    blendAtmosphere(1, atm);
    expect(atm.stars).toBe(0);
    expect(atm.fog[0]).toBeCloseTo(THEMES.light.fog[0], 12);
    const ramp = Array.from({ length: 6 }, () => [0, 0, 0]);
    blendRamp(1, 0.5, ramp);
    expect(ramp[0][1]).toBeCloseTo((PALETTES[1].dark[0][1] + PALETTES[1].light[0][1]) / 2, 12);
    const out = [0, 0, 0];
    sampleRamp(ramp, 0, out);
    expect(out).toEqual(ramp[0]);
    sampleRamp(ramp, 1, out);
    expect(out[2]).toBeCloseTo(ramp[5][2], 12);
  });

  it('converts colours both ways and keeps part colours readable on the light theme', () => {
    expect(linearToSrgb(srgbToLinear(0.42))).toBeCloseTo(0.42, 9);
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    const dark = sceneColor('#ffd23f', 0, [0, 0, 0]);
    const light = sceneColor('#ffd23f', 1, [0, 0, 0]);
    const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    expect(lum(light)).toBeLessThan(lum(dark) * 0.6);
  });
});

describe('terrain mesh and textures', () => {
  it('builds a box-filtered mip chain down to 1 x 1 that preserves the mean', () => {
    const t = generateTerrain(4, { size: 64, seed: 2 });
    const levels = mipChain(t, 64);
    expect(levels.map(l => l.width)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    const mean = (d) => d.reduce((a, b) => a + b, 0) / d.length;
    for (const l of levels) expect(mean(l.data)).toBeCloseTo(mean(t), 4);
  });

  it('builds an 11 x 11 tile grid, dense in the centre tile and coarser ring by ring', () => {
    for (const q of ['high', 'medium', 'low']) {
      const g = buildTerrainGeometry(q);
      const [c, ...rings] = MESH_RES[q];
      const n = c + 2 * rings.reduce((a, b) => a + b, 0) + 1;
      expect(rings.length).toBe(5);
      expect(g.attributes.position.count).toBe(n * n);
      const xs = g.attributes.position.array;
      expect(xs[0]).toBeCloseTo(-55, 9);
      expect(xs[(n - 1) * 3]).toBeCloseTo(55, 9);
      // outermost ring spacing is coarser than the centre's
      expect(xs[3] - xs[0]).toBeGreaterThan(10 / c);
      g.dispose();
    }
  });

  it('frames wider for narrow (portrait) viewports', () => {
    expect(frameDistance('orbit', 0.46)).toBeGreaterThan(frameDistance('orbit', 1.6));
    expect(frameDistance('top', 0.46)).toBeGreaterThan(frameDistance('top', 1.6));
    expect(frameDistance('low', 1.6)).toBeLessThan(frameDistance('orbit', 1.6));
  });
});
