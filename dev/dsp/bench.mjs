// DSP benchmark in plain Node (no test-runner module transform):
//   node dev/dsp/bench.mjs [seconds]  ->  prints one JSON line
// rt.*: CPU seconds per second of audio for 16 voices (2 parts x 8) with
// unison 2 at 48 kHz, best of three runs. gen.*: CPU ms to generate each
// 512 x 512 terrain at detail 1, best of three. CPU time (process.cpuUsage)
// rather than wall time, so a busy machine does not inflate the numbers.
import { OroDSP } from '../../src/dsp/dsp-core.js';
import { generateTerrain, buildMipChain } from '../../src/dsp/terrains.js';
import { TERRAINS } from '../../src/dsp/catalog.js';

const SR = 48000;
const seconds = Number(process.argv[2]) || 2;
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const massif = buildMipChain(generateTerrain(5, { size: 512 }), 512);
const swell = buildMipChain(generateTerrain(0, { size: 512 }), 512);

function rtFactor(params, quality = 'standard', extra = null) {
  const dsp = new OroDSP(SR);
  dsp.handleMessage({ t: 'quality', mode: quality });
  for (let p = 0; p < 2; p++) {
    if (extra) for (const m of extra) dsp.handleMessage({ ...m, part: p });
    dsp.handleMessage({ t: 'terrain', part: p, slot: 0, levels: massif });
    dsp.handleMessage({ t: 'terrain', part: p, slot: 1, levels: swell });
    dsp.handleMessage({ t: 'params', part: p, p: { unison: 2, sustain: 1, ...params } });
    for (let i = 0; i < 8; i++) dsp.handleMessage({ t: 'noteOn', part: p, note: 40 + i * 5 + p, vel: 0.8, time: 0 });
  }
  const N = 128;
  const b = Array.from({ length: 6 }, () => new Float32Array(N));
  let t = 0;
  for (let i = 0; i < 400; i++) { dsp.process(b[0], b[1], b[2], b[3], b[4], b[5], N, t); t += N / SR; }
  let best = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    const blocks = Math.round(seconds * SR / N);
    const t0 = cpuMs();
    for (let i = 0; i < blocks; i++) { dsp.process(b[0], b[1], b[2], b[3], b[4], b[5], N, t); t += N / SR; }
    best = Math.min(best, (cpuMs() - t0) / 1000 / seconds);
  }
  const voices = dsp.parts[0].activeCount() + dsp.parts[1].activeCount();
  if (voices !== 16) throw new Error(`expected 16 voices, got ${voices}`);
  return Number(best.toFixed(4));
}

const rt = {
  default: rtFactor({}),
  spirograph: rtFactor({ pathShape: 7, pathOrder: 4 }),
  scribble: rtFactor({ pathShape: 11, pathOrder: 3 }),
  heavy: rtFactor({ morph: 0.5, warp: 0.3, fold: 0.4, drive: 0.3 }),
  // hard sync with polyBLEP, phase distortion with per-sample mips, sub sine
  features: rtFactor({ laps: 1.5, pace: 0.6, sub: 0.5 }),
  featuresSkew: rtFactor({ laps: 1.5, pace: 0.6, paceShape: 1, sub: 0.5 }),
  // Round D voice features (standard quality)
  travel: rtFactor({ traverse: 1, direction: 1 }),
  air: rtFactor({ air: 0.5, airTone: 0.3 }),
  comb: rtFactor({ filterType: 5, cutoff: 220, resonance: 0.6 }),
  vowel: rtFactor({ filterType: 6, cutoff: 1000, resonance: 0.5 }),
  // five per-voice Links (every voice evaluates every slot they touch)
  links: rtFactor({}, 'standard', [{ t: 'links', links: [
    { src: 0, dst: 'cutoff', amt: 0.3, curve: 0 }, { src: 3, dst: 'size', amt: -0.2, curve: 1 },
    { src: 12, dst: 'morph', amt: 0.5, curve: 0 }, { src: 13, dst: 'pan', amt: 0.4, curve: 0 },
    { src: 14, dst: 'fold', amt: 0.3, curve: 2 },
  ] }]),
  // quality modes with the default patch
  eco: rtFactor({}, 'eco'),
  high: rtFactor({}, 'high'),
  pristine: rtFactor({}, 'pristine'),
  // a slowly drifting dot: every voice rebuilds its table about every 256 samples
  pristineMoving: rtFactor({}, 'pristine', [{ t: 'mods', m: { centerX: { lfoDepth: 0.1, lfoRate: 0.3 }, rotate: { lfoDepth: 0.1, lfoRate: 0.2 } } }]),
  raw: rtFactor({}, 'raw'),
};

const gen = {};
TERRAINS.forEach((t, i) => {
  if (t.id === 'user') return;
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = cpuMs();
    generateTerrain(i, { size: 512, seed: 3 + r, detail: 1 });
    best = Math.min(best, cpuMs() - t0);
  }
  gen[t.id] = Number(best.toFixed(1));
});

console.log(JSON.stringify({ rt, gen }));
