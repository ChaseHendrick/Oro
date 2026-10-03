// v2.9 a spill on a badly dropped synth shorts it: a brief, quiet,
// deterministic crackle in the damage DSP (src/dsp/damage.js).
import { describe, it, expect } from 'vitest';
import { MasterOperator, OPERATOR_DEFAULTS, SHORT_CIRCUIT_DMG } from '../../src/dsp/damage.js';

const SR = 48000;
function spillAfterDrops(drops) {
  const op = new MasterOperator(SR);
  op.configure({ ...OPERATOR_DEFAULTS, drop: 1, dropSeverity: 1, water: 1, waterSeverity: 1 });
  for (let i = 0; i < drops; i++) op.action('drop', 1);
  const n = SR, L = new Float32Array(n), R = new Float32Array(n);
  op.action('spill', 1);
  for (let i = 0; i < n; i += 128) op.process(L.subarray(i, i + 128), R.subarray(i, i + 128), 128, 0);
  return { op, L };
}

describe('short circuit', () => {
  it('only when drop damage is high, the same every time', () => {
    const low = spillAfterDrops(1);
    expect(low.op.dmg).toBeLessThan(SHORT_CIRCUIT_DMG);
    expect(low.op.stats.arcs).toBe(0);
    const a = spillAfterDrops(2), b = spillAfterDrops(2);
    expect(a.op.dmg).toBeGreaterThanOrEqual(SHORT_CIRCUIT_DMG);
    expect(a.op.stats.arcs).toBe(1);
    expect(a.op.arcLeft).toBe(0);
    expect(Array.from(a.L)).toEqual(Array.from(b.L));
    expect(Math.max(...a.L.map(Math.abs))).toBeLessThan(1);
  });
});
