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
    const run = () => JSON.parse(execFileSync(process.execPath, [script, '1'], { encoding: 'utf8', timeout: 400000 }).trim().split('\n').pop());
    result = run();
    // A shared CI runner can stall one case for seconds (2.12 CI: Bend 47% next
    // to Skew 29% in the same run, while both measure the same here). If any
    // gated case is over its limit, measure everything once more and keep the
    // faster reading per case: a real slowdown is slow in both runs.
    const over = ['default', 'spirograph', 'features', 'travel', 'air', 'comb', 'vowel', 'eco', 'pristine', 'raw'].some(k => result.rt[k] >= 0.35)
      || Object.values(result.gen || {}).some(t => t >= 120);
    if (over) {
      const again = run();
      for (const k of Object.keys(result.rt)) result.rt[k] = Math.min(result.rt[k], again.rt[k] ?? Infinity);
      for (const k of Object.keys(result.gen || {})) result.gen[k] = Math.min(result.gen[k], again.gen?.[k] ?? Infinity);
    }
  }, 800000);

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

  it('Round D voice features and the quality modes (16 voices x unison 2)', () => {
    const r = result.rt;
    const pc = (x) => `${(x * 100).toFixed(1)}%`;
    console.log(`[perf] Round D, standard quality: Even + Ping-pong ${pc(r.travel)} | Air ${pc(r.air)} | Comb ${pc(r.comb)} | Vowel ${pc(r.vowel)} | 5 per-voice Links (morph + fold) ${pc(r.links)}`);
    console.log(`[perf] quality modes, default patch: eco ${pc(r.eco)} | standard ${pc(r.default)} | high ${pc(r.high)} | pristine ${pc(r.pristine)} | raw ${pc(r.raw)}`);
    for (const k of ['travel', 'air', 'comb', 'vowel', 'eco', 'pristine', 'raw']) expect(r[k], k).toBeLessThan(0.35);
    // Eco renders at the host rate: clearly cheaper than Standard
    expect(r.eco).toBeLessThan(0.85 * r.default);
    // High renders at 4x: about twice Standard, never more than three times
    expect(r.high).toBeLessThan(3 * r.default);
  });

  it('generates every 512 x 512 terrain in under 120 ms', () => {
    console.log('[perf] 512² terrain generation, CPU ms, best of 3, detail 1: ' + Object.entries(result.gen).map(([n, t]) => `${n} ${t}`).join(', '));
    for (const t of Object.values(result.gen)) expect(t).toBeLessThan(120);
  });
});
