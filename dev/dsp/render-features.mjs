// Renders Laps / Pace / Sub examples to WAV for listening:
//   node dev/dsp/render-features.mjs [outDir]   (default /tmp/orograph-shots/dsp)
// Files are named features-*.wav, normalised to -1 dBFS peak.
import { writeFileSync, mkdirSync } from 'node:fs';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { makeDSP, render, wavBytes, rms, peak } from '../../tests/dsp/helpers.js';

const outDir = process.argv[2] || '/tmp/orograph-shots/dsp';
mkdirSync(outDir, { recursive: true });
const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
const SR = 48000;

/** events: [timeSeconds, message]; script(dsp, time) runs before every block. */
function scene(name, { terrainA, terrainB = null, params, mods = null, events, seconds, script = null }) {
  const dsp = makeDSP({ terrainA, terrainB, params, mods });
  for (const [time, m] of events) dsp.handleMessage({ ...m, time: time + 1e-6 });
  const r = render(dsp, seconds, script);
  const pk = Math.max(peak(r.L), peak(r.R), 1e-9);
  const g = 0.89 / pk;
  const L = r.L.map(x => x * g), R = r.R.map(x => x * g);
  const file = `${outDir}/features-${name}.wav`;
  writeFileSync(file, wavBytes(L, R, SR));
  console.log(`features-${name.padEnd(22)} peak ${(20 * Math.log10(pk)).toFixed(1)} dBFS  rms ${(20 * Math.log10(rms(r.L))).toFixed(1)} dBFS`);
}

const note = (n, t0, t1, vel = 0.85) => [[t0, { t: 'noteOn', part: 0, note: n, vel }], [t1, { t: 'noteOff', part: 0, note: n }]];
const seq = (notes, step, gate, vel = 0.85) => notes.flatMap((n, i) => n == null ? [] : note(n, i * step, i * step + gate, vel));
/** Plain-value parameter changes at given times (a block-rate script). */
const at = (changes) => {
  let i = 0;
  return (dsp, time) => {
    while (i < changes.length && changes[i][0] <= time) dsp.handleMessage({ t: 'params', part: 0, p: changes[i++][1] });
  };
};

// Classic sync sweep: a triangle LFO takes Laps from 1 to about 5 and back.
scene('laps-sync-sweep', {
  terrainA: T.massif, params: { pathShape: P.ellipse, pathOrder: 1, size: 0.3, laps: 3, polyMode: 1, glide: 0.04, cutoff: 7000, resonance: 0.2, release: 0.4 },
  mods: { laps: { lfoDepth: 0.28, lfoRate: 0.35, lfoShape: 1 } },
  events: seq([45, 45, 52, 45, 48, 45, 55, 52], 0.5, 0.45), seconds: 4.4,
});

// Envelope 2 drives Laps: the bright "zap" at the start of each note.
scene('laps-env-zap', {
  terrainA: T.swell, terrainB: T.ridge, params: { pathShape: P.ellipse, pathOrder: 1, size: 0.28, morph: 0.25, laps: 1, decay: 0.3, sustain: 0.4, release: 0.25, env2Attack: 0.001, env2Decay: 0.18, env2Sustain: 0, filterEnv: 0.25, cutoff: 3000 },
  mods: { laps: { envDepth: 0.55 } },
  events: seq([57, 60, 64, 69, 67, 64, 60, 55], 0.25, 0.2), seconds: 2.4,
});

// The same held note through each Pace curve, Pace swept by a slow sine LFO.
scene('pace-curves', {
  terrainA: T.dunes, params: { pathShape: P.rose, pathOrder: 3, size: 0.25, pace: 0, paceShape: 0, attack: 0.05, release: 0.5, cutoff: 9000 },
  mods: { pace: { lfoDepth: 0.45, lfoRate: 0.5 } },
  events: note(50, 0, 5.8), seconds: 6.4,
  script: at([[2, { paceShape: 1 }], [4, { paceShape: 2 }]]),
});

// Sub under a legato bass line: the sine an octave down glides with the voice.
scene('sub-bass', {
  terrainA: T.terrace, params: { pathShape: P.polygon, pathOrder: 4, pathParam: 0.3, size: 0.18, sub: 0.75, polyMode: 2, glide: 0.06, cutoff: 900, resonance: 0.35, filterEnv: 0.35, env2Decay: 0.25, release: 0.2 },
  events: [
    [0.0, { t: 'noteOn', part: 0, note: 36, vel: 0.9 }], [0.45, { t: 'noteOn', part: 0, note: 43, vel: 0.9 }], [0.5, { t: 'noteOff', part: 0, note: 36 }],
    [0.9, { t: 'noteOn', part: 0, note: 39, vel: 0.9 }], [0.95, { t: 'noteOff', part: 0, note: 43 }], [1.35, { t: 'noteOff', part: 0, note: 39 }],
    [1.5, { t: 'noteOn', part: 0, note: 41, vel: 0.9 }], [1.95, { t: 'noteOn', part: 0, note: 36, vel: 0.9 }], [2.0, { t: 'noteOff', part: 0, note: 41 }], [2.8, { t: 'noteOff', part: 0, note: 36 }],
  ], seconds: 3.3,
});

// Everything at once (the perf-test patch): Laps 1.5, Pace 0.6, Sub 0.5, unison 2.
scene('all-chord', {
  terrainA: T.massif, terrainB: T.swell, params: { laps: 1.5, pace: 0.6, sub: 0.5, unison: 2, detune: 12, attack: 0.02, release: 1.2 },
  mods: { pace: { lfoDepth: 0.2, lfoRate: 0.25 } },
  events: [...note(45, 0, 3), ...note(52, 0.05, 3), ...note(57, 0.1, 3), ...note(60, 0.15, 3), ...note(64, 0.2, 3)], seconds: 4.4,
});
console.log('wrote WAVs to', outDir);
