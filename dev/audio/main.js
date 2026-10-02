// Audio host harness: drives createEngine({ store }) in a real browser.
// window.__audio exposes the results for tests/e2e/audio-host.cjs.

import { createEngine } from '../../src/audio/engine.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, NUM_PARTS } from '../../src/core/params.js';
import { TERRAINS, TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { encodeWav24 } from '../../src/audio/wav.js';

const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');
const MODE = params.get('mode') || 'auto';
const INLINE = params.has('inline');
const ONLY = params.get('only');

const state = window.__audio = {
  status: 'init', errors: [], checks: [], metrics: {}, longTasks: [], terrainEvents: [], recording: [], stats: null,
};
const $ = (id) => document.getElementById(id);
const log = (s) => { $('log').textContent = s; };
window.addEventListener('error', (e) => state.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => state.errors.push(String(e.reason && e.reason.message || e.reason)));

// Long tasks are attributed to the phase that was running when they started
// (the observer itself reports late). Work the harness does for itself, such
// as encoding test images, is excluded from the budget checks.
const phases = [{ name: 'boot', at: 0 }];
const harnessWindows = [];
let phase = 'boot';
const setPhase = (name) => { phase = name; phases.push({ name, at: performance.now() }); };
const phaseAt = (t) => { let p = phases[0].name; for (const x of phases) if (x.at <= t) p = x.name; return p; };
const isHarness = (t) => harnessWindows.some(([a, b]) => t >= a - 5 && t <= b + 5);
async function harnessOnly(fn) {
  const a = performance.now();
  try { return await fn(); } finally { harnessWindows.push([a, performance.now()]); }
}
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) state.longTasks.push({ ms: Math.round(e.duration), at: Math.round(e.startTime) });
  }).observe({ type: 'longtask', buffered: true });
} catch { /* not supported */ }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function check(name, pass, value) {
  state.checks.push({ name, pass: !!pass, value });
  const tr = document.createElement('tr');
  tr.innerHTML = `<td class="${pass ? 'ok' : 'bad'}">${pass ? 'PASS' : 'FAIL'}</td><td>${name}</td><td>${typeof value === 'number' ? value.toPrecision(4) : JSON.stringify(value)}</td>`;
  $('checks').appendChild(tr);
}

// ---- terrain tiles ---------------------------------------------------------------
const tiles = new Map();
for (let p = 0; p < NUM_PARTS; p++) {
  for (const s of ['A', 'B']) {
    const d = document.createElement('div');
    d.className = 'tile';
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const label = document.createElement('span');
    label.textContent = `Part ${p + 1} ${s}`;
    d.append(c, label);
    $('tiles').appendChild(d);
    tiles.set(`${p}${s}`, { c, label });
  }
}
function drawTile(part, slot, size, data, name) {
  const t = tiles.get(`${part}${slot}`);
  if (!t) return;
  const g = t.c.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const v = data[Math.floor(y * size / 128) * size + Math.floor(x * size / 128)];
    const k = (y * 128 + x) * 4;
    const c = Math.round(127.5 + 127.5 * v);
    img.data[k] = c * 0.55; img.data[k + 1] = c * 0.95; img.data[k + 2] = c; img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  t.label.textContent = `Part ${part + 1} ${slot}: ${name} (${size})`;
}

// ---- analysis helpers --------------------------------------------------------------
let engine = null, store = null, buf = null;

function rmsNow() {
  engine.analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return s / buf.length;
}

async function meanRms(ms) {
  const t0 = performance.now();
  let acc = 0, n = 0;
  while (performance.now() - t0 < ms) {
    acc += rmsNow(); n++;
    await sleep(Math.max(10, Math.round(1000 * buf.length / engine.sampleRate / 2)));
  }
  return Math.sqrt(acc / Math.max(1, n));
}

function drawScope() {
  const c = $('scope'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
  if (engine && engine.analyser) {
    engine.analyser.getFloatTimeDomainData(buf);
    g.strokeStyle = '#3fd0c9'; g.lineWidth = 1.5; g.beginPath();
    for (let i = 0; i < buf.length; i++) {
      const x = i / (buf.length - 1) * W, y = H / 2 - buf[i] * H * 0.45;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    $('meter').firstElementChild.style.width = `${Math.round(engine.level() * 100)}%`;
  }
  requestAnimationFrame(drawScope);
}

/** Play one note on part 0 and measure RMS during it and in the tail after it. */
async function noteAndTail({ note = 57, hold = 500, tail = [350, 1350] } = {}) {
  engine.noteOn(0, note, 0.9);
  await sleep(150);
  const during = await meanRms(hold - 150);
  engine.noteOff(0, note);
  await sleep(tail[0]);
  const after = await meanRms(tail[1] - tail[0]);
  return { during, after };
}

async function settle() {
  engine.panic();
  await sleep(250);
}

function sendsTo(delay, reverb) {
  store.batch(() => {
    store.set('parts.0.params.delaySend', delay);
    store.set('parts.0.params.reverbSend', reverb);
  });
}

function makeImageFile() {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  // CPU-backed canvas: encoding a GPU canvas is very slow under SwiftShader
  const g = c.getContext('2d', { willReadFrequently: true });
  const grad = g.createRadialGradient(160, 100, 5, 160, 100, 100);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.5, '#4a8'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, 320, 200);
  g.fillStyle = '#f00'; g.fillRect(140, 20, 40, 40);
  return new Promise(r => c.toBlob(b => r(new File([b], 'radial.png', { type: 'image/png' })), 'image/png'));
}

/** A photo-sized JPEG (2400 x 1600), the realistic worst case for import time. */
async function makePhotoFile() {
  const c = new OffscreenCanvas(2400, 1600);
  const g = c.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `hsl(${i * 37 % 360} 60% ${20 + (i * 13) % 60}%)`;
    g.beginPath(); g.arc((i * 397) % 2400, (i * 211) % 1600, 60 + (i * 53) % 300, 0, Math.PI * 2); g.fill();
  }
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
}

/** A hand-built 24-bit BMP (vertical stripes), to cover a format without canvas encoding. */
function makeBmpFile(w = 96, h = 64) {
  const row = Math.ceil(w * 3 / 4) * 4;
  const size = 54 + row * h;
  const b = new DataView(new ArrayBuffer(size));
  b.setUint8(0, 0x42); b.setUint8(1, 0x4d); b.setUint32(2, size, true); b.setUint32(10, 54, true);
  b.setUint32(14, 40, true); b.setInt32(18, w, true); b.setInt32(22, h, true); b.setUint16(26, 1, true); b.setUint16(28, 24, true);
  b.setUint32(34, row * h, true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = (x >> 3) & 1 ? 230 : 20;
    const o = 54 + y * row + x * 3;
    b.setUint8(o, v); b.setUint8(o + 1, v); b.setUint8(o + 2, v);
  }
  return new File([b.buffer], 'stripes.bmp', { type: 'image/bmp' });
}

function makeSvgFile() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#000"/>'
    + '<circle cx="50" cy="50" r="30" fill="#fff"/><path d="M10 90 L50 10 L90 90 Z" fill="none" stroke="#888" stroke-width="6"/></svg>';
  return new File([svg], 'shape.svg', { type: 'image/svg+xml' });
}

function makeWavetableFile() {
  const frames = 8, n = 2048;
  const s = new Float32Array(frames * n);
  for (let f = 0; f < frames; f++) for (let i = 0; i < n; i++) {
    const t = i / n;
    s[f * n + i] = Math.sin(2 * Math.PI * t) * (1 - f / 8) + (f / 8) * (2 * t - 1);
  }
  return new File([encodeWav24([s], 44100)], 'saw-morph.wav', { type: 'audio/wav' });
}

async function parseWavBlob(blob) {
  const b = new DataView(await blob.arrayBuffer());
  const tag = (o) => String.fromCharCode(b.getUint8(o), b.getUint8(o + 1), b.getUint8(o + 2), b.getUint8(o + 3));
  const channels = b.getUint16(22, true), sampleRate = b.getUint32(24, true), bits = b.getUint16(34, true);
  const dataBytes = b.getUint32(40, true);
  const frames = dataBytes / (channels * bits / 8);
  let peak = 0;
  for (let p = 44; p + 2 < b.byteLength; p += 3) {
    let v = b.getUint8(p) | (b.getUint8(p + 1) << 8) | (b.getUint8(p + 2) << 16);
    if (v & 0x800000) v |= ~0xffffff;
    peak = Math.max(peak, Math.abs(v) / 8388608);
  }
  return { riff: tag(0), wave: tag(8), fmt: tag(12), data: tag(36), channels, sampleRate, bits, dataBytes, frames, size: blob.size, peak };
}

// ---- boot ------------------------------------------------------------------------------
async function boot() {
  store = createStore(defaultState());
  // A clear, sustained test voice: low sustain variance, quick release.
  store.batch(() => {
    for (let p = 0; p < NUM_PARTS; p++) store.set(`parts.${p}.params.terrainA`, [TERRAIN_INDEX.swell, TERRAIN_INDEX.ridge, TERRAIN_INDEX.crater, TERRAIN_INDEX.spectra][p]);
    store.set('parts.0.params.release', 0.2);
    store.set('parts.0.params.sustain', 0.9);
    store.set('parts.0.params.size', 0.3);
  });
  const sel = $('terrain');
  TERRAINS.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = t.name; sel.appendChild(o); });
  sel.value = store.get('parts.0.params.terrainA');

  const t0 = performance.now();
  setPhase('createEngine');
  engine = await createEngine({ store, mode: MODE, inlineTerrain: INLINE });
  state.metrics.createEngineMs = Math.round(performance.now() - t0);
  buf = engine.analyser ? new Float32Array(engine.analyser.fftSize) : null;
  window.engine = engine; window.store = store;
  engine.on('terrain', (e) => {
    state.terrainEvents.push({ part: e.part, slot: e.slot, size: e.size, t: Math.round(performance.now() - t0) });
    const idx = store.get(`parts.${e.part}.params.terrain${e.slot}`);
    const ut = store.get(`parts.${e.part}.userTerrain.${e.slot}`);
    drawTile(e.part, e.slot, e.size, e.data, idx === TERRAIN_INDEX.user ? (ut ? ut.name : 'empty') : TERRAINS[idx].name);
  });
  let teleCount = 0;
  engine.on('tele', () => { teleCount++; });
  engine.on('recording', (e) => state.recording.push({ state: e.state, duration: e.duration, reason: e.reason }));
  engine.on('state', (e) => { state.lastState = e; });

  // Tiles for tables that arrived before we subscribed.
  for (let p = 0; p < NUM_PARTS; p++) for (const s of ['A', 'B']) {
    const t = engine.getTerrain(p, s);
    if (t) drawTile(p, s, t.size, t.data, '');
  }

  $('start').onclick = () => engine.start();
  $('note').onclick = async () => { await engine.start(); engine.noteOn(0, 57, 0.8); setTimeout(() => engine.noteOff(0, 57), 600); };
  sel.onchange = () => store.set('parts.0.params.terrainA', +sel.value);
  $('dsend').oninput = (e) => store.set('parts.0.params.delaySend', +e.target.value);
  $('rsend').oninput = (e) => store.set('parts.0.params.reverbSend', +e.target.value);
  $('file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await engine.importTerrainFile(0, 'A', f); log(`imported ${f.name}`); } catch (err) { log(String(err.message || err)); }
  };
  $('panic').onclick = () => engine.panic();
  $('rec').onclick = async () => {
    if (!engine.recording) { await engine.start(); await engine.startRecording(); $('rec').textContent = 'Stop'; return; }
    const blob = await engine.stopRecording();
    $('rec').textContent = 'Record';
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'orograph-test.wav'; a.click();
  };
  log(`engine ready: mode ${engine.mode}, ${engine.sampleRate} Hz`);
  if (buf) drawScope();
  if (!AUTO) { state.status = 'ready'; return; }

  // ---- scripted checks ------------------------------------------------------------
  state.status = 'running';
  if (ONLY === 'reverb') {
    // Probe: swap the reverb between a small and the largest room a few times.
    await engine.start();
    await engine.whenTerrainsReady();
    for (let i = 0; i < 6; i++) {
      setPhase('reverb-' + i);
      store.set('global.reverbSize', i % 2 ? 0.3 : 1);
      await sleep(1500);
    }
    await sleep(300);
    for (const t of state.longTasks) t.phase = phaseAt(t.at);
    state.stats = engine.stats();
    state.status = 'done';
    return;
  }
  const st0 = engine.stats();
  state.metrics.workletVia = st0.workletVia;
  state.metrics.generator = st0.generator.mode + ':' + st0.generator.via;
  check('engine mode', MODE === 'script' ? engine.mode === 'script' : engine.mode === 'worklet', engine.mode);

  setPhase('terrains');
  const tReady = performance.now();
  await engine.whenTerrainsReady();
  state.metrics.firstTerrainsMs = Math.round(performance.now() - t0);
  state.metrics.terrainWaitMs = Math.round(performance.now() - tReady);
  const got = new Set(state.terrainEvents.map(e => `${e.part}${e.slot}`));
  let allTables = true;
  for (let p = 0; p < NUM_PARTS; p++) for (const s of ['A', 'B']) if (!engine.getTerrain(p, s)) allTables = false;
  check('terrain events for 4 parts x 2 slots', got.size === 8, [...got].sort().join(' '));
  check('getTerrain returns every table', allTables, engine.getTerrain(0, 'A') && engine.getTerrain(0, 'A').size);

  setPhase('start');
  const state1 = await engine.start();
  check('context running after start()', state1 === 'running', state1);
  await sleep(200);
  check('telemetry flowing', teleCount > 5, teleCount);

  setPhase('dry');
  sendsTo(0, 0);
  await settle();
  const silent = await meanRms(200);
  const dry = await noteAndTail();
  state.metrics.silenceRms = silent;
  state.metrics.dryDuringRms = dry.during;
  state.metrics.dryTailRms = dry.after;
  check('RMS > 0 at the analyser while a note plays', dry.during > 0.01, dry.during);
  check('silent before the note', silent < 1e-4, silent);
  const lvl = engine.level();

  setPhase('delay');
  sendsTo(1, 0);
  await settle();
  const del = await noteAndTail();
  state.metrics.delayTailRms = del.after;
  check('delay send audibly adds a tail', del.after > 10 * dry.after + 0.003, { dry: dry.after, delay: del.after });

  setPhase('reverb');
  sendsTo(0, 1);
  await settle();
  const rev = await noteAndTail();
  state.metrics.reverbTailRms = rev.after;
  check('reverb send audibly adds a tail', rev.after > 10 * dry.after + 0.003, { dry: dry.after, reverb: rev.after });

  setPhase('panic');
  sendsTo(1, 1);
  await settle();
  engine.noteOn(0, 60, 1);
  await sleep(400);
  engine.noteOff(0, 60);
  await sleep(60);
  const beforePanic = await meanRms(80);
  engine.panic();
  await sleep(150);
  const afterPanic = await meanRms(300);
  state.metrics.panic = { beforePanic, afterPanic };
  check('panic() hard-silences voices and effect tails', afterPanic < 1e-3 && beforePanic > 0.005, { beforePanic, afterPanic });
  sendsTo(0.12, 0.22);

  setPhase('level');
  engine.noteOn(0, 64, 0.9);
  await sleep(300);
  let lv = 0;
  for (let i = 0; i < 10; i++) { lv = Math.max(lv, engine.level()); await sleep(20); }
  engine.noteOff(0, 64);
  state.metrics.level = lv;
  check('level() reports output for visuals', lv > 0.02 && lv <= 1, lv);
  void lvl;

  setPhase('record');
  await settle();
  await engine.startRecording();
  const recT0 = performance.now();
  engine.noteOn(0, 57, 0.9);
  await sleep(500);
  engine.noteOff(0, 57);
  await sleep(1000 - (performance.now() - recT0));
  const blob = await engine.stopRecording();
  const recWall = (performance.now() - recT0) / 1000;
  const wav = await parseWavBlob(blob);
  state.metrics.recording = { ...wav, wallSeconds: recWall, seconds: wav.frames / wav.sampleRate };
  check('recording is a valid 24-bit stereo WAV', wav.riff === 'RIFF' && wav.wave === 'WAVE' && wav.fmt === 'fmt ' && wav.data === 'data'
    && wav.channels === 2 && wav.bits === 24 && wav.sampleRate === engine.sampleRate && wav.size === 44 + wav.dataBytes, wav);
  check('recording has the right duration', Math.abs(wav.frames / wav.sampleRate - recWall) < 0.15, { seconds: wav.frames / wav.sampleRate, wall: recWall });
  check('recording contains the note', wav.peak > 0.01, wav.peak);
  check('recording events fired', state.recording.length >= 2 && state.recording[state.recording.length - 1].state === 'stopped', state.recording);

  setPhase('import');
  const evBefore = state.terrainEvents.length;
  const marks = state.metrics.importMarks = {};
  const mark = (k) => { marks[k] = Math.round(performance.now()); };
  mark('start');
  const imgFile = await harnessOnly(makeImageFile);
  mark('pngMade');
  const tImp = performance.now();
  await engine.importTerrainFile(1, 'A', imgFile);
  mark('imageImported');
  state.metrics.imageImportMs = Math.round(performance.now() - tImp);
  const wavFile = makeWavetableFile();
  mark('wavMade');
  const tImp2 = performance.now();
  const ut = await engine.importTerrainFile(1, 'B', wavFile);
  mark('wavImported');
  state.metrics.wavImportMs = Math.round(performance.now() - tImp2);
  await engine.whenTerrainsReady();
  mark('tablesReady');
  const photo = await harnessOnly(makePhotoFile);
  mark('photoMade');
  setPhase('import-photo');
  const tImp3 = performance.now();
  await engine.importTerrainFile(0, 'B', photo);
  state.metrics.photoImportMs = Math.round(performance.now() - tImp3);
  await engine.whenTerrainsReady();
  mark('photoReady');
  setPhase('import');
  const newEv = state.terrainEvents.slice(evBefore).map(e => `${e.part}${e.slot}`);
  check('image import -> userTerrain + terrain event', store.get('parts.1.params.terrainA') === TERRAIN_INDEX.user
    && store.get('parts.1.userTerrain.A').kind === 'image' && newEv.includes('1A'), newEv);
  check('WAV import -> wavetable with 8 frames + terrain event', ut.kind === 'wavetable' && ut.h === 8 && newEv.includes('1B'), { h: ut.h, events: newEv });
  check('photo import (2400x1600 JPEG) -> 256x256 image terrain', store.get('parts.0.userTerrain.B').w === 256 && newEv.includes('0B'), state.metrics.photoImportMs);
  let rejected = '';
  try { await engine.importTerrainFile(0, 'A', new File(['ID3...'], 'song.mp3', { type: 'audio/mpeg' })); } catch (err) { rejected = err.message; }
  check('unsupported files are rejected with a message', /not an image or a WAV/.test(rejected), rejected);

  setPhase('regen');
  const evB = state.terrainEvents.length;
  for (let s = 0; s < 12; s++) { store.set('parts.2.params.seed', s); await sleep(8); }
  store.set('parts.3.params.terrainB', TERRAIN_INDEX.canyon);
  store.set('parts.3.params.detail', 1);
  await sleep(100);
  await engine.whenTerrainsReady();
  const regenEv = state.terrainEvents.slice(evB).map(e => `${e.part}${e.slot}`);
  check('seed drag regenerates part 3 once per slot after the debounce', regenEv.filter(k => k[0] === '2').length === 2, regenEv);

  setPhase('import-formats');
  const fmtResults = {};
  const webp = await harnessOnly(async () => {
    const c = new OffscreenCanvas(200, 200);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, 200, 200);
    g.fillStyle = '#fff'; g.fillRect(50, 50, 100, 100);
    return new File([await c.convertToBlob({ type: 'image/webp' })], 'square.webp', { type: 'image/webp' });
  });
  for (const [name, file] of [['bmp', makeBmpFile()], ['svg', makeSvgFile()], ['webp', webp]]) {
    try {
      const u = await engine.importTerrainFile(3, 'A', file);
      await engine.whenTerrainsReady();
      const t = engine.getTerrain(3, 'A');
      let lo = Infinity, hi = -Infinity;
      for (const v of t.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
      fmtResults[name] = { kind: u.kind, w: u.w, h: u.h, range: Math.round((hi - lo) * 100) / 100 };
    } catch (err) {
      fmtResults[name] = String(err.message || err);
    }
  }
  check('BMP, SVG and WebP images import as non-flat terrains', ['bmp', 'svg', 'webp'].every(k => fmtResults[k] && fmtResults[k].w === 256 && fmtResults[k].range > 1), fmtResults);

  setPhase('reverb-size');
  const swaps0 = engine.stats().fx.irSwaps;
  store.set('global.reverbSize', 1);
  store.set('global.reverbDamp', 0.7);
  // debounce (250 ms) + worker job + install; allow for a busy machine
  for (let i = 0; i < 40 && engine.stats().fx.irSwaps === swaps0; i++) await sleep(100);
  const fx1 = engine.stats().fx;
  state.metrics.reverbRegen = { swaps: fx1.irSwaps - swaps0, irMs: Math.round(fx1.lastIrMs), convolverSetupMs: Math.round(fx1.lastBufferMs), irSeconds: fx1.lastIrLength / engine.sampleRate };
  check('reverb size change regenerates the IR (crossfaded swap)', fx1.irSwaps - swaps0 === 1 && fx1.lastIrLength > 6.9 * engine.sampleRate, state.metrics.reverbRegen);
  store.set('global.reverbSize', 0.62);
  store.set('global.reverbDamp', 0.45);
  await sleep(700);

  setPhase('devices');
  let devices = null, sinkResult = '';
  try { devices = await engine.listOutputDevices(); } catch (err) { devices = String(err); }
  try { await engine.setOutputDevice('default'); sinkResult = 'ok'; } catch (err) { sinkResult = err.message; }
  check('output device API answers without throwing', Array.isArray(devices) && (sinkResult === 'ok' || /cannot choose/.test(sinkResult)), { devices: Array.isArray(devices) ? devices.length : devices, sinkResult });

  setPhase('suspend');
  await engine.context.suspend();
  document.dispatchEvent(new Event('visibilitychange'));
  const resumed = await engine.start();
  check('start() resumes a suspended context', resumed === 'running', resumed);

  setPhase('restart');
  const modeBefore = engine.mode;
  store.set('parts.0.params.cutoff', 2500);
  await engine.restartDSP();
  sendsTo(0, 0);
  await sleep(100);
  const again = await noteAndTail({ tail: [300, 400] });
  check('restartDSP() rebuilds the DSP and it plays again with the same patch', engine.mode === modeBefore && again.during > 0.01, { mode: engine.mode, rms: again.during });

  setPhase('misc');
  engine.bend(0, 0.5); engine.wheel(0, 0.3); engine.bend(0, 0); engine.wheel(0, 0);
  engine.setTransport({ playing: true, beatTime: engine.context.currentTime, beat: 0, spb: 0.5 });
  engine.setTransport({ playing: false });
  engine.noteOn(9, 60); engine.noteOn(0, NaN); engine.noteOff(0, 'x');
  engine.allNotesOff(0); engine.allNotesOff();
  await sleep(100);

  setPhase('done');
  state.stats = engine.stats();
  state.metrics.latencyMs = Math.round(engine.latency * 1000 * 10) / 10;
  state.metrics.sampleRate = engine.sampleRate;
  await sleep(100);
  for (const t of state.longTasks) t.phase = isHarness(t.at) ? 'harness' : phaseAt(t.at);
  const longest = state.longTasks.filter(t => t.phase !== 'harness').reduce((m, t) => Math.max(m, t.ms), 0);
  state.metrics.longestTask = longest;
  const terrainPhases = ['terrains', 'import', 'import-photo', 'import-formats', 'regen', 'reverb-size'];
  const terrainLong = state.longTasks.filter(t => terrainPhases.includes(t.phase));
  state.metrics.longTasksDuringTerrainWork = terrainLong;
  // Main-thread cost of the audio host's own work, timed inside the engine:
  // applying a terrain (copy + post), the reverb's buffer copy / convolver set-up
  // and every synchronous import step. Long tasks seen by the browser are listed
  // too, but on a shared machine they also include time the tab was descheduled.
  const S = state.stats;
  const own = {
    terrainApplyMs: Math.round(S.terrain.maxApplyMs * 10) / 10,
    reverbSteps: S.fx.steps,
    importMaxBlockMs: Math.round(S.import.maxBlockMs * 10) / 10,
    inlineTerrainBlockMs: Math.round(S.generator.maxInlineBlockMs * 10) / 10,
  };
  state.metrics.ownMainThread = own;
  const worst = Math.max(own.terrainApplyMs, own.importMaxBlockMs, ...Object.values(own.reverbSteps));
  if (S.generator.mode === 'worker') {
    check('terrain, import and reverb work never block the main thread > 50 ms (instrumented)', worst < 50, own);
  }
  check('no page errors', state.errors.length === 0, state.errors);
  state.status = 'done';
  log(JSON.stringify({ metrics: state.metrics, stats: state.stats }, null, 2));
}

boot().catch((err) => {
  state.errors.push(String(err && err.stack || err));
  state.status = 'error';
  log(String(err && err.stack || err));
});
