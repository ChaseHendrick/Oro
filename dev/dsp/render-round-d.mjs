// Renders Round D examples to WAV for listening:
//   node dev/dsp/render-round-d.mjs [outDir]   (default /tmp/orograph-shots/dsp)
// Files are named round-d-*.wav, normalised to -1 dBFS peak. Each one isolates
// one feature: Vowel and Comb filters, Air, Even / Ping-pong travel, Key>Size,
// the Steps LFO, Links, and a Standard vs Pristine pair on a bright lead.
import { writeFileSync, mkdirSync } from 'node:fs';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { makeDSP, render, wavBytes, rms, peak } from '../../tests/dsp/helpers.js';

const outDir = process.argv[2] || '/tmp/orograph-shots/dsp';
mkdirSync(outDir, { recursive: true });
const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
const SR = 48000;

/** events: [timeSeconds, message]; pre: messages applied before the first block. */
function scene(name, { terrainA, terrainB = null, params, mods = null, pre = [], events, seconds }) {
  const dsp = makeDSP({ terrainA, terrainB, params, mods });
  for (const m of pre) dsp.handleMessage(m);
  for (const [time, m] of events) dsp.handleMessage({ ...m, time: time + 1e-6 });
  const r = render(dsp, seconds);
  const pk = Math.max(peak(r.L), peak(r.R), 1e-9);
  const g = 0.89 / pk;
  writeFileSync(`${outDir}/round-d-${name}.wav`, wavBytes(r.L.map(x => x * g), r.R.map(x => x * g), SR));
  console.log(`round-d-${name.padEnd(22)} peak ${(20 * Math.log10(pk)).toFixed(1)} dBFS  rms ${(20 * Math.log10(rms(r.L))).toFixed(1)} dBFS`);
}
const note = (n, t0, t1, vel = 0.85) => [[t0, { t: 'noteOn', part: 0, note: n, vel }], [t1, { t: 'noteOff', part: 0, note: n }]];
const chord = (ns, t0, t1, vel = 0.8) => ns.flatMap(n => note(n, t0, t1, vel));
const seq = (ns, step, gate, vel = 0.85) => ns.flatMap((n, i) => (n == null ? [] : note(n, i * step, i * step + gate, vel)));

// A slow triangle walks the Vowel filter A E I O U and back over a held note.
scene('vowel-sweep', {
  terrainA: T.massif, params: { filterType: 6, cutoff: 900, keyTrack: 0.3, filterEnv: 0, resonance: 0.6, size: 0.3, sustain: 1, release: 0.5, unison: 2, detune: 8 },
  mods: { formant: { lfoDepth: 0.5, lfoRate: 0.2, lfoShape: 1 } },
  events: [...note(45, 0, 5.5)], seconds: 6.2,
});
// Comb: the comb frequency sweeps while Vowel/formant flips the comb from negative to positive.
scene('comb-sweep', {
  terrainA: T.ridge, params: { filterType: 5, cutoff: 300, keyTrack: 0, filterEnv: 0, resonance: 0.8, formant: 1, size: 0.25, sustain: 1, release: 0.6 },
  mods: { cutoff: { lfoDepth: 0.25, lfoRate: 0.25, lfoShape: 0 }, formant: { lfoDepth: 0.5, lfoRate: 0.1, lfoShape: 1 } },
  events: [...chord([40, 47], 0, 7)], seconds: 7.8,
});
// Air: a breathy pad, dark then bright.
scene('air-breath', {
  terrainA: T.swell, terrainB: T.dunes, params: { morph: 0.3, size: 0.15, air: 0.6, airTone: -0.6, attack: 0.4, release: 1.2, filterType: 1, cutoff: 3000, unison: 2, detune: 10 },
  events: [...chord([57, 60, 64], 0, 2.6), ...chord([55, 59, 62], 2.8, 5.4)].map(([t, m]) => [t, m]),
  pre: [], seconds: 6.6,
});
scene('air-bright', {
  terrainA: T.swell, terrainB: T.dunes, params: { morph: 0.3, size: 0.15, air: 0.6, airTone: 0.8, attack: 0.4, release: 1.2, filterType: 1, cutoff: 9000, unison: 2, detune: 10 },
  events: chord([57, 60, 64], 0, 2.6), seconds: 3.8,
});
// Natural then Even on a spirograph (two notes each): same pitch, steadier timbre.
for (const [name, traverse] of [['travel-natural', 0], ['travel-even', 1]]) {
  scene(name, {
    terrainA: T.cells, params: { pathShape: P.spiro, pathOrder: 4, pathParam: 0.7, size: 0.3, traverse, sustain: 0.8, release: 0.3, cutoff: 8000 },
    events: seq([45, 52, 57, 52], 0.6, 0.5), seconds: 2.8,
  });
}
// Forward then Ping-pong on Scan: the sawtooth jump turns into a smooth turn-around.
for (const [name, direction] of [['scan-forward', 0], ['scan-pingpong', 1]]) {
  scene(name, {
    terrainA: T.spectra, params: { pathShape: P.scan, pathOrder: 2, size: 0.35, centerY: 0.3, direction, sustain: 0.9, release: 0.3, filterType: 0 },
    events: seq([48, 55, 60, 67], 0.5, 0.45), seconds: 2.4,
  });
}
// Key>Size -1: high notes stay round instead of turning harsh.
scene('keysize', {
  terrainA: T.massif, params: { size: 0.35, noteSize: -1, sustain: 0.8, release: 0.25, filterType: 0 },
  events: seq([36, 48, 60, 72, 84, 96], 0.4, 0.35), seconds: 2.8,
});
// Steps LFO on Laps and cutoff: a rhythmic sync sequence from one held note.
scene('steps-lfo', {
  terrainA: T.ripple, params: { laps: 2, size: 0.25, cutoff: 3000, resonance: 0.3, sustain: 1, release: 0.4 },
  mods: {
    laps: { lfoShape: 6, lfoSync: 1, lfoDiv: 2, lfoDepth: 0.4, steps: [0, 0.5, 0.2, 0.9, -0.3, 0.6, 0.1, 1, 0, 0.4, -0.5, 0.8, 0.3, 0.7, -0.2, 0.5] },
    cutoff: { lfoShape: 6, lfoSync: 1, lfoDiv: 2, lfoDepth: 0.2 },
  },
  pre: [{ t: 'global', p: { tempo: 110 } }],
  events: note(48, 0, 4.2), seconds: 4.8,
});
// Links: velocity opens the orbit, the key tilts the pan, a random value per note bends the shape.
scene('links-velocity', {
  terrainA: T.swell, terrainB: T.fm, params: { morph: 0.2, size: 0.05, sustain: 0, decay: 0.6, release: 0.3, cutoff: 7000 },
  pre: [{ t: 'links', part: 0, links: [{ src: 0, dst: 'size', amt: 0.5, curve: 1 }, { src: 3, dst: 'pan', amt: 0.6, curve: 0 }, { src: 13, dst: 'pathParam', amt: 0.4, curve: 0 }] }],
  events: [0.25, 0.4, 0.55, 0.7, 0.85, 1].flatMap((vel, i) => note(52 + 3 * i, i * 0.35, i * 0.35 + 0.3, vel)), seconds: 2.6,
});
// The same bright folded lead in Standard and in Pristine quality.
for (const mode of ['standard', 'pristine']) {
  scene(`lead-${mode}`, {
    terrainA: T.massif, params: { size: 0.4, lift: 2, fold: 0.6, laps: 1.5, sustain: 0.9, release: 0.3, filterType: 0, glide: 0.05, polyMode: 1 },
    pre: [{ t: 'quality', mode }],
    events: seq([72, 76, 79, 84, 88, 84], 0.3, 0.28), seconds: 2.2,
  });
}
