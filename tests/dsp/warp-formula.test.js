// v2.3: warp modes on the path read and formula terrains.
import { describe, it, expect, vi } from 'vitest';
import { compileFormula, formulaHeights, FORMULA_EXAMPLES } from '../../src/dsp/formula.js';
import { sanitizeUserTerrain } from '../../src/dsp/user-terrain.js';
import { formulaTerrain } from '../../src/ui/formula-terrain.js';
import { makeDSP, render, rms, allFinite } from './helpers.js';

vi.setConfig({ testTimeout: 120000 });

describe('formula parser', () => {
  it('evaluates maths with the usual precedence', () => {
    const f = (s, x = 0.5, y = -0.25) => compileFormula(s)(x, y, Math.hypot(x, y), Math.atan2(y, x), 0);
    expect(f('1 + 2 * 3')).toBe(7);
    expect(f('2 ^ 3 ^ 2')).toBe(512);
    expect(f('-x^2')).toBe(-0.25);
    expect(f('max(x, y) + clamp(5, 0, 1)')).toBe(1.5);
    expect(f('x > y')).toBe(1);
    expect(f('7 % 3')).toBe(1);
    expect(f('sin(pi/2)')).toBeCloseTo(1, 12);
  });
  it('rejects anything that is not maths, with a readable message', () => {
    for (const bad of ['', 'alert(1)', 'x +', 'sin(1, 2)', 'constructor', 'toString(x)', '__proto__', 'x; y', '(x', 'window.x']) {
      expect(() => compileFormula(bad)).toThrow();
    }
    expect(() => compileFormula('foo(x)')).toThrow(/Unknown function/);
  });
  it('builds every example, and flat formulas are refused', () => {
    for (const ex of FORMULA_EXAMPLES) expect(formulaHeights(ex.src, 32).flat).toBe(false);
    expect(() => formulaTerrain('3')).toThrow(/flat/);
  });
  it('a formula terrain survives a save and remembers its formula', () => {
    const ut = sanitizeUserTerrain(formulaTerrain('sin(6*x) * cos(6*y)'));
    expect(ut.kind).toBe('formula'); expect(ut.formula).toBe('sin(6*x) * cos(6*y)'); expect(ut.w).toBe(512);
  });
});

describe('warp modes', () => {
  const base = { terrainA: 0, size: 0.3, attack: 0.001, sustain: 1, filterType: 0 };
  const play = (p) => render(makeDSP({ params: { ...base, ...p } }), 0.4, (d, t, k) => { if (k === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 48, vel: 1, time: 0 }); });
  it('each mode changes the sound and stays finite; amount 0 is the plain sound', () => {
    const plain = play({});
    const zero = play({ warpMode: 1, warpAmount: 0 });
    let same = 0; for (let i = 0; i < plain.L.length; i++) same = Math.max(same, Math.abs(plain.L[i] - zero.L[i]));
    expect(same).toBe(0);
    for (const mode of [1, 2, 3, 4]) {
      const out = play({ warpMode: mode, warpAmount: 0.7 });
      expect(allFinite(out.L)).toBe(true);
      let d = 0; for (let i = 0; i < plain.L.length; i++) d += (plain.L[i] - out.L[i]) ** 2;
      expect(Math.sqrt(d / plain.L.length)).toBeGreaterThan(0.02 * rms(plain.L));
    }
  });
});
