// Sound bug hunt: renders every factory patch and scene through the DSP and
// reports what an ear would complain about, plus what happens when the
// patch changes under a held chord (as the app does when you browse patches
// while playing):
//   node dev/dsp/bughunt.mjs [--quality standard] [--wav outDir]
// Columns: peak (dBFS), DC (mean as a fraction of RMS), click (worst burst of
// the second difference against its local level, x), denormal float32
// samples, NaN. A patch-change row compares the switch with steady playing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { OroDSP } from '../../src/dsp/dsp-core.js';
import { FACTORY_PATCHES } from '../../src/presets/factory-patches.js';
import { FACTORY_SCENES } from '../../src/presets/factory-scenes.js';
import { patchParams, patchMods } from '../../src/presets/apply.js';
import { defaultLinks } from '../../src/core/params.js';
import { loadPart, terrainLevels, render, renderScene, SR } from '../../tests/presets/render.js';
import { NOTES } from '../../tests/presets/levels-setup.js';
import { wavBytes } from '../../tests/dsp/helpers.js';

const args = process.argv.slice(2);
const quality = args.includes('--quality') ? args[args.indexOf('--quality') + 1] : 'standard';
const wavDir = args.includes('--wav') ? args[args.indexOf('--wav') + 1] : null;
if (wavDir) mkdirSync(wavDir, { recursive: true });
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));

/** Worst click: |second difference| against the RMS of its surroundings (10 ms each side, the burst itself excluded). */
function clickScore(x, from = 0, to = x.length) {
  const n = x.length;
  const d = new Float64Array(n);
  for (let i = 2; i < n; i++) d[i] = x[i] - 2 * x[i - 1] + x[i - 2];
  const W = 480, G = 24;
  // prefix sums of d^2 for fast window RMS
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + d[i] * d[i];
  let worst = 0, at = -1;
  for (let i = Math.max(2 + W, from); i < Math.min(n - W, to); i++) {
    const a = Math.abs(d[i]);
    if (a < 2e-3) continue;
    const e = (ps[i - G] - ps[i - W]) + (ps[i + W] - ps[i + G]);
    const rms = Math.sqrt(e / (2 * (W - G))) + 1e-9;
    const r = a / rms;
    if (r > worst) { worst = r; at = i; }
  }
  return { worst, at };
}

function stats(L, R) {
  let s = 0, s2 = 0, pk = 0, den = 0, nan = 0;
  for (const a of [L, R]) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!Number.isFinite(v)) { nan++; continue; }
      s += v; s2 += v * v;
      const av = Math.abs(v);
      if (av > pk) pk = av;
      if (av > 0 && av < 1.1754943508222875e-38) den++;
    }
  }
  const N = L.length + R.length;
  const rms = Math.sqrt(s2 / N);
  return { peak: pk, dc: rms > 0 ? Math.abs(s / N) / rms : 0, rms, den, nan };
}

function fresh() {
  const dsp = new OroDSP(SR);
  dsp.handleMessage({ t: 'quality', mode: quality });
  dsp.handleMessage({ t: 'global', p: { tempo: 120 } });
  return dsp;
}

function loadPatchAll(dsp, part, patch, { terrains = true } = {}) {
  const params = patchParams(patch);
  dsp.handleMessage({ t: 'params', part, p: params });
  dsp.handleMessage({ t: 'mods', part, m: patchMods(patch) });
  dsp.handleMessage({ t: 'links', part, links: patch.links || defaultLinks() });
  if (terrains) sendTerrains(dsp, part, params);
}
function sendTerrains(dsp, part, params) {
  const a = terrainLevels(params.terrainA, params.seed, params.detail);
  const b = terrainLevels(params.terrainB, params.seed, params.detail);
  if (a) dsp.handleMessage({ t: 'terrain', part, slot: 0, levels: a });
  if (b) dsp.handleMessage({ t: 'terrain', part, slot: 1, levels: b });
}

const rows = [];
const flag = (r) => r.nan > 0 || r.peak > 1 || r.dc > 0.05 || r.den > 0 || r.click > 12;

console.log(`quality: ${quality}`);
console.log('--- factory patches (audition phrase)');
for (const patch of FACTORY_PATCHES) {
  const dsp = fresh();
  loadPatchAll(dsp, 0, patch);
  const { events, length } = NOTES(patch);
  for (const e of events) dsp.handleMessage(e);
  const out = render(dsp, length);
  const st = stats(out.L, out.R);
  const c = clickScore(out.L);
  const r = { name: patch.name, ...st, click: c.worst, clickAt: c.at };
  rows.push(r);
  console.log(`${flag(r) ? '!!' : '  '} ${patch.name.padEnd(22)} peak ${db(st.peak).toFixed(1).padStart(6)}  dc ${st.dc.toFixed(3)}  click ${c.worst.toFixed(1).padStart(5)} @${(c.at / SR).toFixed(3)}s  den ${st.den}  nan ${st.nan}`);
  if (wavDir) writeFileSync(`${wavDir}/patch-${patch.name.toLowerCase().replace(/\W+/g, '-')}.wav`, wavBytes(out.L, out.R, SR));
}

console.log('--- patch change under a held chord (A -> B): switch vs steady');
const chord = [52, 59, 64];
const changeRows = [];
for (let i = 0; i < FACTORY_PATCHES.length; i++) {
  const A = FACTORY_PATCHES[i], B = FACTORY_PATCHES[(i + 1) % FACTORY_PATCHES.length];
  const dsp = fresh();
  loadPatchAll(dsp, 0, A);
  for (const n of chord) dsp.handleMessage({ t: 'noteOn', part: 0, note: n, vel: 0.8, time: 0 });
  const a = render(dsp, 0.6);
  // the store sync posts params/mods/links at once; terrains follow ~50 ms later
  loadPatchAll(dsp, 0, B, { terrains: false });
  const b1 = render(dsp, 0.05);
  sendTerrains(dsp, 0, patchParams(B));
  const b2 = render(dsp, 0.55);
  const L = new Float32Array(a.L.length + b1.L.length + b2.L.length);
  L.set(a.L); L.set(b1.L, a.L.length); L.set(b2.L, a.L.length + b1.L.length);
  const sw = a.L.length;
  const steady = Math.max(clickScore(L, Math.round(0.3 * SR), sw - 480).worst, clickScore(L, sw + Math.round(0.25 * SR), L.length).worst);
  const at = clickScore(L, sw - 240, sw + Math.round(0.12 * SR));
  const before = Math.sqrt(a.L.slice(Math.round(0.4 * SR)).reduce((s, v) => s + v * v, 0) / (a.L.length - Math.round(0.4 * SR)));
  const after = Math.sqrt(b2.L.slice(Math.round(0.3 * SR)).reduce((s, v) => s + v * v, 0) / (b2.L.length - Math.round(0.3 * SR)));
  const r = { name: `${A.name} -> ${B.name}`, click: at.worst, steady, jump: db(after) - db(before), at: (at.at - sw) / SR };
  changeRows.push(r);
  const bad = r.click > Math.max(12, 1.5 * steady);
  console.log(`${bad ? '!!' : '  '} ${r.name.padEnd(42)} switch ${r.click.toFixed(1).padStart(5)} @${(1000 * r.at).toFixed(1)}ms  steady ${steady.toFixed(1).padStart(5)}  level ${r.jump >= 0 ? '+' : ''}${r.jump.toFixed(1)} dB`);
}

console.log('--- factory scenes (4 bars)');
for (const scene of FACTORY_SCENES) {
  const { out } = renderScene(scene, 4);
  const st = stats(out.L, out.R);
  const c = clickScore(out.L);
  const r = { name: scene.name, ...st, click: c.worst };
  console.log(`${flag(r) ? '!!' : '  '} ${scene.name.padEnd(22)} peak ${db(st.peak).toFixed(1).padStart(6)}  dc ${st.dc.toFixed(3)}  click ${c.worst.toFixed(1).padStart(5)} @${(c.at / SR).toFixed(3)}s  den ${st.den}  nan ${st.nan}`);
  if (wavDir) writeFileSync(`${wavDir}/scene-${scene.name.toLowerCase().replace(/\W+/g, '-')}.wav`, wavBytes(out.L, out.R, SR));
}
