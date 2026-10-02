// Offline rendering of patches and scenes through the real DSP engine, for
// level checks and reference WAVs. Terrain tables are generated exactly as the
// audio host does (512 x 512 plus mip chain) and cached per (terrain, seed, detail).

import { mkdirSync, writeFileSync } from 'node:fs';
import { OrographDSP } from '../../src/dsp/dsp-core.js';
import { generateTerrain, buildMipChain } from '../../src/dsp/terrains.js';
import { NUM_PARTS } from '../../src/core/params.js';
import { createStore } from '../../src/core/store.js';
import { migrateState } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { patchParams, patchMods, patchLinks } from '../../src/presets/apply.js';
import { createFakeClock } from '../music/fakes.js';

export const SR = 48000;
export const BLOCK = 128;
const chains = new Map();

export function terrainLevels(index, seed, detail, size = 512) {
  const key = `${index}|${seed}|${detail}|${size}`;
  if (!chains.has(key)) {
    const data = generateTerrain(index, { size, seed, detail });
    chains.set(key, data ? buildMipChain(data, size) : null);
  }
  const chain = chains.get(key);
  // The engine may take ownership of the buffers, so hand it copies.
  return chain ? chain.map(l => ({ size: l.size, data: new Float32Array(l.data) })) : null;
}

/** Send a full part (params, mods, links, terrains) to the engine, as the audio host does. */
export function loadPart(dsp, part, params, mods, links) {
  dsp.handleMessage({ t: 'params', part, p: params });
  dsp.handleMessage({ t: 'mods', part, m: mods });
  if (Array.isArray(links)) dsp.handleMessage({ t: 'links', part, links });
  const a = terrainLevels(params.terrainA, params.seed, params.detail);
  const b = terrainLevels(params.terrainB, params.seed, params.detail);
  if (a) dsp.handleMessage({ t: 'terrain', part, slot: 0, levels: a });
  if (b) dsp.handleMessage({ t: 'terrain', part, slot: 1, levels: b });
}

export function loadPatch(dsp, part, patch) {
  loadPart(dsp, part, patchParams(patch), patchMods(patch), patchLinks(patch));
}

/**
 * Render `seconds` in 128-frame blocks; `before(time)` runs before each block.
 * Returns the dry stereo mix plus the send buses.
 */
export function render(dsp, seconds, before = null) {
  const total = Math.round(seconds * SR);
  const L = new Float32Array(total), R = new Float32Array(total);
  const D = new Float32Array(total), V = new Float32Array(total);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  const dl = new Float32Array(BLOCK), dr = new Float32Array(BLOCK);
  const rl = new Float32Array(BLOCK), rr = new Float32Array(BLOCK);
  let i = 0;
  let t = dsp.lastTime || 0;
  while (i < total) {
    const n = Math.min(BLOCK, total - i);
    if (before) before(t);
    dsp.process(bl, br, dl, dr, rl, rr, n, t);
    for (let k = 0; k < n; k++) {
      L[i + k] = bl[k]; R[i + k] = br[k];
      D[i + k] = 0.5 * (dl[k] + dr[k]); V[i + k] = 0.5 * (rl[k] + rr[k]);
    }
    i += n;
    t += n / SR;
  }
  return { L, R, D, V };
}

export function stats(L, R) {
  let peak = 0, finite = true;
  for (let i = 0; i < L.length; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) { finite = false; continue; }
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  // Loudness: the loudest 400 ms window of mid-channel RMS (catches plucks and slow pads alike).
  const win = Math.round(0.4 * SR), hop = Math.round(0.05 * SR);
  let best = 0, total = 0;
  for (let s = 0; s + win <= L.length; s += hop) {
    let acc = 0;
    for (let i = s; i < s + win; i++) { const m = 0.5 * (L[i] + R[i]); acc += m * m; }
    best = Math.max(best, Math.sqrt(acc / win));
  }
  for (let i = 0; i < L.length; i++) { const m = 0.5 * (L[i] + R[i]); total += m * m; }
  return { peak, rms: best, meanRms: Math.sqrt(total / L.length), finite };
}

export const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

/** 16-bit stereo WAV with a simple peak normaliser (renders are for listening, not measuring). */
export function writeWav(path, L, R, { normalise = 0.89 } = {}) {
  let peak = 1e-9;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = normalise ? Math.min(4, normalise / peak) : 1;
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
  }
  // Reference renders are a convenience: never fail a test run over them.
  try {
    mkdirSync(path.replace(/\/[^/]*$/, ''), { recursive: true });
    writeFileSync(path, buf);
  } catch { /* read-only or unusual filesystem */ }
}

/** A small stereo feedback delay + diffuse tail, only so WAV renders sound like the app. */
export function roughMix({ L, R, D, V }, { tempo = 120, delayBeats = 0.75, feedback = 0.4, delayLevel = 0.6, reverbLevel = 0.6 } = {}) {
  const n = L.length;
  const oL = new Float32Array(n), oR = new Float32Array(n);
  const dLen = Math.max(1, Math.round(delayBeats * 60 / tempo * SR));
  const bufL = new Float32Array(dLen), bufR = new Float32Array(dLen);
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map(d => ({ d, buf: new Float32Array(d), i: 0, lp: 0 }));
  let di = 0;
  for (let i = 0; i < n; i++) {
    const yl = bufL[di], yr = bufR[di];
    bufL[di] = D[i] + yr * feedback;
    bufR[di] = yl * feedback;
    di = (di + 1) % dLen;
    let rev = 0;
    for (const c of combs) {
      const out = c.buf[c.i];
      c.lp = out * 0.6 + c.lp * 0.4;
      c.buf[c.i] = V[i] + c.lp * 0.82;
      c.i = (c.i + 1) % c.d;
      rev += out;
    }
    rev *= 0.12 * reverbLevel;
    oL[i] = L[i] + yl * delayLevel + rev;
    oR[i] = R[i] + yr * delayLevel + rev * 0.97;
  }
  return { L: oL, R: oR };
}

/**
 * Play a scene through the real transport (fake clock) into the DSP engine,
 * rendering in lockstep, for `bars` bars. Dot locks move the dot in the store
 * and the change is forwarded to the engine, so renders include that motion.
 */
export function renderScene(scene, bars = 4) {
  const state = migrateState(scene);
  const clock = createFakeClock({ startSec: 0 });
  const dsp = new OrographDSP(SR);
  dsp.handleMessage({ t: 'global', p: { tempo: state.global.tempo } });
  for (let p = 0; p < NUM_PARTS; p++) loadPart(dsp, p, state.parts[p].params, state.parts[p].mods, state.parts[p].links);
  const notes = Array(NUM_PARTS).fill(0);
  const engine = {
    context: clock.ctx,
    noteOn(part, note, vel, time) { notes[part]++; dsp.handleMessage({ t: 'noteOn', part, note, vel, time }); },
    noteOff(part, note, time) { dsp.handleMessage({ t: 'noteOff', part, note, time }); },
    allNotesOff(part) { dsp.handleMessage({ t: 'allOff', part }); },
  };
  const store = createStore(state);
  // Forward parameter changes made while playing (dot locks) to the engine, as the audio host does.
  store.subscribe('parts', (path, value) => {
    const m = /^parts\.(\d+)\.params\.(\w+)$/.exec(path);
    if (m) dsp.handleMessage({ t: 'params', part: Number(m[1]), p: { [m[2]]: value } });
  });
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  music.transport.play();
  const seconds = bars * 4 * 60 / state.global.tempo + 0.3;
  const out = render(dsp, seconds, () => clock.advance(BLOCK / SR, BLOCK / SR));
  music.dispose();
  return { out, notes, state };
}

