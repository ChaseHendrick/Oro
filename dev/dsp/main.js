// DSP harness: proves the bundled worklet loads and sounds in a real browser.
// window.__dsp exposes results for tests/e2e/dsp-worklet.cjs.
import workletCode from 'virtual:worklet:src/dsp/worklet.js';
import { generateTerrain, buildMipChain } from '../../src/dsp/terrains.js';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';

const state = window.__dsp = { status: 'init', errors: [], tele: 0, lastTele: null, liveRms: [], offline: null };
const $ = (id) => document.getElementById(id);
const log = (s) => { $('log').textContent = s; };
window.addEventListener('error', (e) => state.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => state.errors.push(String(e.reason)));

const workletURL = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));

async function makeNode(ctx, init = undefined) {
  await ctx.audioWorklet.addModule(workletURL);
  return new AudioWorkletNode(ctx, 'orograph', {
    numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2],
    processorOptions: { sampleRate: ctx.sampleRate, init },
  });
}

function terrainMessage(part, slot, index) {
  return { t: 'terrain', part, slot, levels: buildMipChain(generateTerrain(index, { size: 512 }), 512) };
}

function sendTerrain(node, part, slot, index) {
  const levels = buildMipChain(generateTerrain(index, { size: 512 }), 512);
  node.port.postMessage({ t: 'terrain', part, slot, levels }, levels.map(l => l.data.buffer));
}

function rmsOf(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Deterministic check: render 1.5 s offline through the same worklet. */
async function offlineCheck() {
  const sr = 48000;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(1.5 * sr), sampleRate: sr });
  // An offline context only delivers port messages after rendering, so the
  // whole script goes in through processorOptions.init.
  const node = await makeNode(ctx, [
    terrainMessage(0, 0, TERRAINS.findIndex(t => t.id === 'massif')),
    { t: 'params', part: 0, p: { release: 0.2 } },
    { t: 'noteOn', part: 0, note: 57, vel: 0.9, time: 0.1 },
    { t: 'noteOn', part: 0, note: 64, vel: 0.9, time: 0.1 },
    { t: 'noteOff', part: 0, note: 57, time: 0.9 },
    { t: 'noteOff', part: 0, note: 64, time: 0.9 },
  ]);
  node.connect(ctx.destination, 0);
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0);
  let finite = true;
  for (let i = 0; i < L.length; i++) if (!Number.isFinite(L[i])) { finite = false; break; }
  return {
    before: rmsOf(L, 0, Math.round(0.09 * sr)),
    during: rmsOf(L, Math.round(0.3 * sr), Math.round(0.85 * sr)),
    after: rmsOf(L, Math.round(1.3 * sr)),
    finite,
  };
}

let ctx = null, node = null, analyser = null;

async function startLive() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  node = await makeNode(ctx);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  node.connect(analyser, 0);
  analyser.connect(ctx.destination);
  node.port.onmessage = (e) => { if (e.data && e.data.t === 'tele') { state.tele++; state.lastTele = e.data; } };
  sendTerrain(node, 0, 0, +$('terrain').value);
  sendTerrain(node, 0, 1, TERRAINS.findIndex(t => t.id === 'massif'));
  node.port.postMessage({ t: 'params', part: 0, p: { pathShape: +$('path').value, pathOrder: +$('order').value } });
  node.port.postMessage({ t: 'watch', part: 0 });
  if (ctx.state !== 'running') await ctx.resume();
  drawScope();
}

function measure() {
  const a = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(a);
  return rmsOf(a);
}

function drawScope() {
  const cv = $('scope'), g = cv.getContext('2d');
  const a = new Float32Array(analyser.fftSize);
  const loop = () => {
    analyser.getFloatTimeDomainData(a);
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#ff7a45'; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < a.length; i++) {
      const x = i / (a.length - 1) * cv.width, y = cv.height / 2 - a[i] * cv.height * 0.9;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const t = state.lastTele;
    log(`state ${ctx.state} | sr ${ctx.sampleRate} | telemetry ${state.tele}` + (t ? ` | voices ${t.activeVoices.join(',')} | peak ${t.peak.map(v => v.toFixed(3)).join('/')}` : ''));
    requestAnimationFrame(loop);
  };
  loop();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Scripted run used by the e2e test (?auto). */
async function autoRun() {
  try {
    state.status = 'offline';
    state.offline = await offlineCheck();
    state.status = 'live';
    await startLive();
    const t0 = ctx.currentTime + 0.05;
    for (const n of [57, 61, 64]) node.port.postMessage({ t: 'noteOn', part: 0, note: n, vel: 0.9, time: t0 });
    await sleep(300);
    state.status = 'playing';
    for (let i = 0; i < 8; i++) { state.liveRms.push(measure()); await sleep(60); }
    state.status = 'releasing';
    for (const n of [57, 61, 64]) node.port.postMessage({ t: 'noteOff', part: 0, note: n, time: 0 });
    await sleep(1200);
    state.afterRms = measure();
    state.contextTime = ctx.currentTime;
    state.status = 'done';
  } catch (err) {
    state.errors.push(String(err && err.stack || err));
    state.status = 'error';
  }
}

// --- manual UI ---
TERRAINS.forEach((t, i) => { if (t.id !== 'user') $('terrain').add(new Option(t.name, i)); });
PATHS.forEach((p, i) => $('path').add(new Option(p.name, i)));
for (let o = 1; o <= 8; o++) $('order').add(new Option(String(o), o));
$('order').value = '1';
$('terrain').onchange = () => node && sendTerrain(node, 0, 0, +$('terrain').value);
$('path').onchange = $('order').onchange = () => node && node.port.postMessage({ t: 'params', part: 0, p: { pathShape: +$('path').value, pathOrder: +$('order').value } });
$('start').onclick = async () => { if (!ctx) await startLive(); else await ctx.resume(); };
const NOTES = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'];
[48, 50, 52, 53, 55, 57, 59, 60].forEach((n, i) => {
  const b = document.createElement('button');
  b.textContent = NOTES[i] + (n >= 60 ? '4' : '3');
  const down = async () => { if (!ctx) await startLive(); node.port.postMessage({ t: 'noteOn', part: 0, note: n, vel: 0.8, time: 0 }); };
  const up = () => node && node.port.postMessage({ t: 'noteOff', part: 0, note: n, time: 0 });
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(); });
  b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') up(); });
  $('keys').appendChild(b);
});

if (new URLSearchParams(location.search).has('auto')) autoRun();
else state.status = 'ready';
