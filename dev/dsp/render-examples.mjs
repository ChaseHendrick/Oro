// Renders a few terrain/path combinations to WAV for listening:
//   node dev/dsp/render-examples.mjs [outDir]   (default /tmp/orograph-shots/dsp)
import { writeFileSync, mkdirSync } from 'node:fs';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { makeDSP, render, wavBytes, rms, peak } from '../../tests/dsp/helpers.js';

const outDir = process.argv[2] || '/tmp/orograph-shots/dsp';
mkdirSync(outDir, { recursive: true });
const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
const SR = 48000;

/** events: [timeSeconds, message] */
function scene(name, { terrainA, terrainB = null, params, mods = null, events, seconds }) {
  const dsp = makeDSP({ terrainA, terrainB, params, mods });
  for (const [time, m] of events) dsp.handleMessage({ ...m, time: time + 1e-6 });
  const r = render(dsp, seconds);
  // normalise the file to -1 dBFS peak so the examples are comparable
  const pk = Math.max(peak(r.L), peak(r.R), 1e-9);
  const g = 0.89 / pk;
  const L = r.L.map(x => x * g), R = r.R.map(x => x * g);
  writeFileSync(`${outDir}/${name}.wav`, wavBytes(L, R, SR));
  console.log(`${name.padEnd(26)} peak ${(20 * Math.log10(pk)).toFixed(1)} dBFS  rms ${(20 * Math.log10(rms(r.L))).toFixed(1)} dBFS`);
}

const chord = (notes, t0, t1, vel = 0.8) => notes.flatMap(n => [[t0, { t: 'noteOn', part: 0, note: n, vel }], [t1, { t: 'noteOff', part: 0, note: n }]]);
const seq = (notes, step, gate, vel = 0.8) => notes.flatMap((n, i) => n == null ? [] : [[i * step, { t: 'noteOn', part: 0, note: n, vel }], [i * step + gate, { t: 'noteOff', part: 0, note: n }]]);

scene('01-swell-ellipse-chord', {
  terrainA: T.swell, params: { pathShape: P.ellipse, pathOrder: 1, size: 0.25, attack: 0.08, release: 1.2, unison: 2, detune: 10 },
  mods: { size: { lfoDepth: 0.15, lfoRate: 0.3 } },
  events: chord([57, 60, 64, 67], 0.05, 3.0), seconds: 4.5,
});
scene('02-bessel-spiro-bells', {
  terrainA: T.fm, params: { pathShape: P.spiro, pathOrder: 3, pathParam: 0.4, size: 0.3, attack: 0.002, decay: 1.2, sustain: 0, release: 1.2, filterEnv: 0.3 },
  events: seq([72, 79, 76, 84, 74, 81, 77, 86], 0.35, 0.3), seconds: 4.5,
});
scene('03-massif-scan-rowsweep', {
  terrainA: T.massif, params: { pathShape: P.scan, pathOrder: 1, size: 0.5, cutoff: 6000, attack: 0.01, release: 0.6 },
  mods: { centerY: { lfoDepth: 0.5, lfoRate: 0.25, lfoShape: 1 } },
  events: chord([45, 52], 0.05, 4.0), seconds: 4.8,
});
scene('04-spectra-wavetable', {
  terrainA: T.spectra, params: { pathShape: P.scan, pathOrder: 1, size: 0.5, filterType: 0, centerY: 0, release: 0.5 },
  mods: { centerY: { lfoDepth: 0.5, lfoRate: 0.2, lfoShape: 1 } },
  events: chord([48], 0.05, 5.0), seconds: 5.5,
});
scene('05-ridge-rose-legato-bass', {
  terrainA: T.ridge, params: { pathShape: P.rose, pathOrder: 3, size: 0.2, polyMode: 2, glide: 0.08, fold: 0.35, cutoff: 1800, resonance: 0.45, filterEnv: 0.4, env2Decay: 0.25 },
  events: [
    [0.0, { t: 'noteOn', part: 0, note: 36, vel: 0.9 }], [0.4, { t: 'noteOn', part: 0, note: 43, vel: 0.9 }], [0.45, { t: 'noteOff', part: 0, note: 36 }],
    [0.8, { t: 'noteOn', part: 0, note: 39, vel: 0.9 }], [0.85, { t: 'noteOff', part: 0, note: 43 }], [1.2, { t: 'noteOff', part: 0, note: 39 }],
    [1.4, { t: 'noteOn', part: 0, note: 41, vel: 0.9 }], [1.8, { t: 'noteOn', part: 0, note: 36, vel: 0.9 }], [1.85, { t: 'noteOff', part: 0, note: 41 }], [2.6, { t: 'noteOff', part: 0, note: 36 }],
  ], seconds: 3.4,
});
scene('06-lattice-superformula-pluck', {
  terrainA: T.lattice, terrainB: T.cells, params: { pathShape: P.super, pathOrder: 5, pathParam: 0.3, size: 0.18, morph: 0.3, attack: 0.001, decay: 0.25, sustain: 0.1, release: 0.3, cutoff: 900, filterEnv: 0.55, env2Decay: 0.18, env2Sustain: 0, resonance: 0.35 },
  events: seq([60, 63, 67, 70, 72, 70, 67, 63, 60, 55, 58, 62], 0.18, 0.12), seconds: 2.8,
});
scene('07-vortex-spiral-spin', {
  terrainA: T.vortex, params: { pathShape: P.spiral, pathOrder: 2, size: 0.27, spin: 0.35, warp: 0.4, unison: 3, detune: 14, spread: 0.9, attack: 0.3, release: 1.5 },
  events: chord([50, 57, 62], 0.05, 3.5), seconds: 5,
});
scene('08-crater-cusp-morph', {
  terrainA: T.crater, terrainB: T.dunes, params: { pathShape: P.cusp, pathOrder: 4, size: 0.3, release: 1 },
  mods: { morph: { lfoDepth: 0.5, lfoRate: 0.4 }, centerX: { lfoDepth: 0.2, lfoRate: 0.11, lfoShape: 5 } },
  events: chord([43, 50], 0.05, 4.0), seconds: 5,
});
console.log('wrote WAVs to', outDir);
