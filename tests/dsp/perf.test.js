import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs dev/dsp/bench.mjs in its own plain Node process: the test runner's
// module transform turns every imported call into a namespace property load
// (slower inner loops than the bundled AudioWorklet), and the child measures
// its own CPU time, so other test files running in parallel do not skew it.
let result = null;

describe('performance', () => {
  beforeAll(() => {
    const script = fileURLToPath(new URL('../../dev/dsp/bench.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [script, '2'], { encoding: 'utf8', timeout: 180000 });
    result = JSON.parse(out.trim().split('\n').pop());
  }, 180000);

  it('16 voices x unison 2 render in under 35% of one core (48 kHz)', () => {
    const r = result.rt;
    console.log(`[perf] CPU per audio second, 16 voices x unison 2 @ 48 kHz: default ${(r.default * 100).toFixed(1)}% | spirograph ${(r.spirograph * 100).toFixed(1)}% | scribble ${(r.scribble * 100).toFixed(1)}% | morph+warp+fold+drive ${(r.heavy * 100).toFixed(1)}%`);
    expect(r.default).toBeLessThan(0.35);
    expect(r.spirograph).toBeLessThan(0.35);
  });

  it('16 voices x unison 2 with Laps 1.5, Pace 0.6 and Sub 0.5 stay under 35% of one core', () => {
    const r = result.rt;
    console.log(`[perf] CPU per audio second, 16 voices x unison 2, Laps 1.5 + Pace 0.6 + Sub 0.5: Bend ${(r.features * 100).toFixed(1)}% | Skew ${(r.featuresSkew * 100).toFixed(1)}%`);
    expect(r.features).toBeLessThan(0.35);
  });

  it('generates every 512 x 512 terrain in under 120 ms', () => {
    console.log('[perf] 512² terrain generation, CPU ms, best of 3, detail 1: ' + Object.entries(result.gen).map(([n, t]) => `${n} ${t}`).join(', '));
    for (const t of Object.values(result.gen)) expect(t).toBeLessThan(120);
  });
});
