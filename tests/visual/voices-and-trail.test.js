import { describe, it, expect } from 'vitest';
import { noteSizeFactor, keyLinkDelta, voiceLive, orbitDifference, ORBIT_IDS } from '../../src/visual/modstate.js';
import { pingPong, buildArcTable, evenPhase } from '../../src/visual/orbit-layer.js';
import { pathPoint } from '../../src/dsp/paths.js';
import { PART_PARAM_MAP, toNorm } from '../../src/core/params.js';

const L = { stretch: 0.2, size: 0.2, rotate: 350, centerX: 0.98, centerY: 0.5, pathParam: 0.5, pathWindow: 0, pathMangle: 0, pathMirror: 0 };

describe('per-voice orbits', () => {
  it('Key>Size scales the orbit by 2^(noteSize (note - 60) / 24), clamped to 0..0.5', () => {
    expect(noteSizeFactor(0, 84)).toBe(1);
    expect(noteSizeFactor(1, 84)).toBeCloseTo(2, 12);
    expect(noteSizeFactor(-1, 84)).toBeCloseTo(0.5, 12);
    expect(noteSizeFactor(0.5, 60)).toBe(1);
    const out = {};
    voiceLive(L, 84, 60, null, 1, out);
    expect(out.size).toBeCloseTo(0.4, 12);
    voiceLive({ ...L, size: 0.4 }, 96, 60, null, 1, out);
    expect(out.size).toBe(0.5);
    for (const id of ORBIT_IDS) if (id !== 'size') expect(out[id]).toBe(id === 'size' ? 0 : { ...L, size: 0.4 }[id]);
  });

  it('Key links move a voice relative to the voice telemetry describes', () => {
    const links = [{ src: 3, dst: 'rotate', amt: 0.5, curve: 0 }, { src: 0, dst: 'size', amt: 1, curve: 0 }];
    expect(keyLinkDelta(links, 'rotate', 60)).toBe(0);
    expect(keyLinkDelta(links, 'rotate', 108)).toBeCloseTo(0.5, 12);
    expect(keyLinkDelta(links, 'size', 108)).toBe(0);           // Velocity links are not note-dependent
    const out = {};
    // the reference voice itself is unchanged
    voiceLive(L, 72, 72, links, 0, out);
    for (const id of ORBIT_IDS) expect(out[id]).toBeCloseTo(L[id], 9);
    // an octave above the reference: +0.5 * 12/48 of the knob = +45 degrees, wrapping past 360
    voiceLive(L, 84, 72, links, 0, out);
    expect(out.rotate).toBeCloseTo((350 + 45) % 360, 6);
    // centres wrap instead of clamping
    voiceLive(L, 84, 60, [{ src: 3, dst: 'centerX', amt: 1, curve: 0 }], 0, out);
    expect(out.centerX).toBeCloseTo((0.98 + 0.5) % 1, 9);
    // a clamped parameter stays in range
    voiceLive(L, 108, 0, [{ src: 3, dst: 'stretch', amt: 1, curve: 2 }], 0, out);
    expect(out.stretch).toBeLessThanOrEqual(PART_PARAM_MAP.stretch.max);
    expect(toNorm(PART_PARAM_MAP.stretch, out.stretch)).toBeLessThanOrEqual(1);
  });

  it('measures how different two orbits look', () => {
    const b = { ...L };
    expect(orbitDifference(L, b)).toBe(0);
    expect(orbitDifference(L, { ...L, size: 0.2 * 1.03 })).toBeLessThan(1);
    expect(orbitDifference(L, { ...L, size: 0.2 * 1.1 })).toBeGreaterThan(1);
    expect(orbitDifference(L, { ...L, rotate: 352 })).toBeLessThan(1);
    expect(orbitDifference(L, { ...L, rotate: 0 })).toBeGreaterThan(1);           // 10 degrees, the short way round
    expect(orbitDifference(L, { ...L, centerX: 0.01 })).toBeGreaterThan(1);       // 0.03 across the seam
    expect(orbitDifference(L, { ...L, centerX: 0.982 })).toBeLessThan(1);
    // rotating a dot-sized orbit does not count
    expect(orbitDifference({ ...L, size: 0.002 }, { ...L, size: 0.002, rotate: 20 })).toBeLessThan(1);
  });
});

describe('comet trail travel', () => {
  it('Ping-pong runs the path out and back once per cycle', () => {
    expect(pingPong(0)).toBe(0);
    expect(pingPong(0.25)).toBe(0.5);
    expect(pingPong(0.5)).toBe(1);
    expect(pingPong(0.75)).toBe(0.5);
    expect(pingPong(0.999)).toBeCloseTo(0.002, 9);
  });

  it('Even travel covers equal path lengths in equal times', () => {
    const table = new Float64Array(129);
    const tmp = { x: 0, y: 0 };
    // A squashed Ellipse and a Spiro: the raw parameter crawls round the ends and races along the sides
    expect(buildArcTable(0, 3, 0.8, table, tmp)).toBe(true);
    for (let i = 1; i < table.length; i++) expect(table[i]).toBeGreaterThanOrEqual(table[i - 1]);
    expect(table[128]).toBeCloseTo(1, 12);
    const p = { x: 0, y: 0 }, q = { x: 0, y: 0 };
    // spread of the step lengths (chords) for 64 equal time steps
    const spread = (phase, shape = 0) => {
      const steps = [];
      for (let k = 0; k < 64; k++) {
        pathPoint(shape, phase(k / 64), 3, 0.8, p);
        pathPoint(shape, phase(((k + 1) / 64) % 1), 3, 0.8, q);
        steps.push(Math.hypot(q.x - p.x, q.y - p.y));
      }
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      const dev = steps.map(s => Math.abs(s - mean) / mean).sort((a, b) => a - b);
      return { median: dev[32], max: dev[63] };
    };
    const raw = spread(t => t), even = spread(t => evenPhase(table, t));
    expect(raw.median).toBeGreaterThan(0.2);
    expect(even.median).toBeLessThan(0.01);
    expect(even.max).toBeLessThan(0.05);
    const spiro = new Float64Array(129);
    buildArcTable(7, 3, 0.8, spiro, tmp);
    const rs = spread(t => t, 7), es = spread(t => evenPhase(spiro, t), 7);
    expect(es.median).toBeLessThan(rs.median / 10);
    // a degenerate (zero-length) path is reported, not divided by zero
    expect(buildArcTable(0, 1, 0, new Float64Array(129), { x: 0, y: 0 })).toBe(true);
  });
});
