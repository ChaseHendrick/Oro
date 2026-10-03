import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { OroDSP } from '../../src/dsp/dsp-core.js';
import { AIR_SCENARIOS, renderLegacyAir } from './fixtures/legacy-air-render.js';

// SHA-256 of all six Float32 output buses from the unoptimized 3ca6fa1 core.
// Confirmed identical on Node 22 and 24 before fixing the registry-load deopts.
const REFERENCE = [
  'ac4295425af385f0a1cf843e46b8d186afa4932f844eab9ffa616fa64951626a',
  'b8a7d6c0e993e22a445486d1d56482bc80bfd6a7f9bbc251c7501448e2d753f9',
  '7b12b82770ce15558c77a8a3916afebb09ccdcbea0eac6008ffac4d8f532f3e6',
  '9a828346de455987285238ec8f2e9ce84cba10ad9ad2d4031845242d2f6af895',
];

describe('legacy Air audio after control-loop optimization', () => {
  for (let index = 0; index < AIR_SCENARIOS.length; index++) {
    const scenario = AIR_SCENARIOS[index];
    it(`preserves every output bit at ${scenario.sr} Hz / ${scenario.quality} / Tone ${scenario.tone}`, () => {
      const output = renderLegacyAir(OroDSP, scenario);
      const hash = createHash('sha256');
      for (const bus of ['L', 'R', 'DL', 'DR', 'VL', 'VR']) hash.update(new Uint8Array(output[bus].buffer));
      expect(hash.digest('hex')).toBe(REFERENCE[index]);
    });
  }
});
