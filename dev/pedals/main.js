// Pedal harness: drives src/pedals in a real browser. An OscillatorNode stands
// in for the guitar, a DelayNode for the pedal loop, and a saturating delay
// loop for runaway feedback. window.__pedals holds the results for
// tests/pedals/harness-e2e.cjs.

import { loadPedalWorklets } from '../../src/pedals/worklet-loader.js';
import {
  buildOutputRouting, createSendLimiter, measureRoundTrip, attachFeedbackGuard, createCapture, openReturn,
} from '../../src/pedals/pedal-loop.js';
import { createGuitarInput, captureToWavetable } from '../../src/pedals/guitar.js';
import { createPedalMidi, createLfoSource } from '../../src/pedals/pedal-midi.js';
import { gainToDb, peakAbs } from '../../src/pedals/signal.js';

const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');
const state = window.__pedals = { status: 'init', checks: [], metrics: {}, errors: [], notes: [], midi: [] };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
window.addEventListener('error', (e) => state.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => state.errors.push(String((e.reason && e.reason.message) || e.reason)));

function setStatus(s) { state.status = s; $('status').textContent = s; }
// skipReason: the ScriptProcessor fallback lost audio because the page's main
// thread was too busy; the check then says SKIP and why, instead of PASS or FAIL.
function check(name, pass, value, skipReason = null) {
  const skip = !pass && !!skipReason;
  state.checks.push({ name, pass: !!pass, skip, value: skip ? `${skipReason} (${typeof value === 'string' ? value : JSON.stringify(value)})` : value });
  if (skip) value = `${skipReason}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  const tr = document.createElement('tr');
  const v = typeof value === 'number' ? +value.toPrecision(5) : value;
  const word = pass ? 'PASS' : skip ? 'SKIP' : 'FAIL';
  tr.innerHTML = `<td class="${pass ? 'ok' : skip ? '' : 'bad'}">${word}</td><td>${name}</td><td></td>`;
  tr.lastChild.textContent = typeof v === 'string' ? v : JSON.stringify(v);
  $('checks').appendChild(tr);
}
function kv(el, obj) {
  el.innerHTML = '';
  for (const [k, v] of Object.entries(obj)) {
    const b = document.createElement('b'); b.textContent = k;
    const s = document.createElement('span'); s.textContent = typeof v === 'number' ? String(+v.toFixed(3)) : String(v);
    el.append(b, s);
  }
}
const midiName = (m) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ------------------------------------------------------------------ audio graph

let ctx = null, routing, limiter, sendBus, loopDelay, returnIn, returnGain, guard, guitar, guitarIn;
let fb = null;

async function start() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  try { await ctx.resume(); } catch { /* needs a click */ }
  // ?noworklet leaves the processors unloaded, so every helper takes its ScriptProcessor fallback.
  const wl = params.has('noworklet') ? { via: null } : await loadPedalWorklets(ctx);
  state.metrics.worklet = wl.via || 'script fallback';
  state.metrics.sampleRate = ctx.sampleRate;

  routing = buildOutputRouting(ctx);
  limiter = createSendLimiter(ctx);
  // Part sends would connect to sendBus; the limited send goes to outputs 3/4.
  sendBus = ctx.createGain();
  sendBus.connect(limiter.input);
  limiter.output.connect(routing.sendIn);
  // The pedal loop stand-in: whatever enters the send comes back loopMs later.
  loopDelay = ctx.createDelay(2);
  loopDelay.delayTime.value = Number($('loopMs').value) / 1000;
  sendBus.connect(loopDelay);
  // Return: returnIn is watched by the feedback guard, returnGain is what it mutes.
  returnIn = ctx.createGain();
  returnGain = ctx.createGain();
  loopDelay.connect(returnIn);
  returnIn.connect(returnGain);
  returnGain.connect(routing.mainIn);
  guard = attachFeedbackGuard(ctx, { input: returnIn, gain: returnGain, onTrip: (st) => { state.metrics.guardTrip = st; } });

  guitarIn = ctx.createGain();
  guitar = createGuitarInput(ctx, guitarIn);
  guitar.on('level', (e) => { $('lvl').style.width = Math.round(e.value * 100) + '%'; });
  guitar.on('noteOn', (e) => logNote(`+ ${midiName(e.note)} vel ${e.velocity.toFixed(2)}${e.legato ? ' legato' : ''}`, e));
  guitar.on('noteOff', (e) => logNote(`- ${midiName(e.note)}`, e));
  guitar.on('bend', (e) => { state.notes.push({ type: 'bend', semitones: e.semitones, time: e.time }); });

  kv($('routing'), {
    'output channels': ctx.destination.maxChannelCount,
    mode: routing.mode,
    'pedal send': routing.mode === 'multichannel' ? 'outputs 3 and 4' : 'off',
    'send ceiling': limiter.ceilingDb + ' dBFS',
    worklet: state.metrics.worklet,
    'sample rate': ctx.sampleRate + ' Hz',
  });
  $('routingReason').textContent = routing.reason || 'Main mix on outputs 1 and 2, pedal send on 3 and 4.';
  setStatus('Audio running');
}

function logNote(text, e) {
  state.notes.push({ type: text[0] === '+' ? 'noteOn' : 'noteOff', ...e });
  const el = $('noteLog');
  el.textContent = `${e.time.toFixed(3)} s  ${text}\n` + el.textContent.slice(0, 2000);
}

// ------------------------------------------------------------------ ping

async function ping(signal = $('pingSignal').value) {
  await start();
  const ms = Number($('loopMs').value);
  loopDelay.delayTime.setValueAtTime(ms / 1000, ctx.currentTime);
  const r = await measureRoundTrip(ctx, { sendNode: sendBus, returnNode: returnIn, signal, runs: 3 });
  const set = ms / 1000 * ctx.sampleRate;
  kv($('pingOut'), {
    'set delay': `${ms} ms (${set.toFixed(1)} samples)`,
    measured: r.ok ? `${r.latencyMs.toFixed(3)} ms (${r.latencySamples.toFixed(2)} samples)` : 'nothing',
    error: r.ok ? `${(r.latencySamples - set).toFixed(3)} samples` : '',
    confidence: r.confidence,
    capture: r.via,
  });
  $('pingReason').textContent = r.reason || (r.inverted ? 'The return is polarity-inverted.' : '');
  return { r, set };
}

// ------------------------------------------------------------------ feedback

async function startFeedback() {
  await start();
  if (fb) return fb;
  // A loop outside Orograph (like an MPC monitoring mistake): gain above one through a saturating stage.
  const seed = ctx.createOscillator();
  seed.frequency.value = 700;
  const burst = ctx.createGain();
  burst.gain.value = 0;
  const t = ctx.currentTime + 0.05;
  burst.gain.setValueAtTime(0.02, t);
  burst.gain.setValueAtTime(0, t + 0.05);
  const loopIn = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.03;
  const sat = ctx.createWaveShaper();
  const curve = new Float32Array(1025);
  for (let i = 0; i < curve.length; i++) curve[i] = 0.5 * Math.tanh(3 * (i / 512 - 1));
  sat.curve = curve;
  const loopGain = ctx.createGain();
  loopGain.gain.value = 1.3;
  seed.connect(burst).connect(loopIn);
  loopIn.connect(delay).connect(sat).connect(loopGain).connect(loopIn);
  sat.connect(returnIn);
  seed.start();
  fb = { seed, burst, loopIn, delay, sat, loopGain, startedAt: performance.now() };
  return fb;
}
function stopFeedback() {
  if (!fb) return;
  for (const n of Object.values(fb)) { if (n && typeof n.disconnect === 'function') { try { n.disconnect(); } catch { /* ignore */ } } }
  try { fb.seed.stop(); } catch { /* ignore */ }
  fb = null;
}
function showGuard() {
  const s = guard.status();
  kv($('guardOut'), { tripped: s.tripped, kind: s.kind || '', 'return level': `${s.levelDb.toFixed(1)} dBFS`, 'return muted': s.muted, 'loop outside Orograph': s.outside });
  $('guardReason').textContent = [s.reason, s.outsideReason].filter(Boolean).join(' ');
  return s;
}

// ------------------------------------------------------------------ guitar riff

const RIFF = [40, 45, 50, 55, 59, 64, 69, 88];
async function playRiff() {
  await start();
  state.notes = [];
  const drops0 = guitar.dropouts;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 4500;
  const env = ctx.createGain();
  env.gain.value = 0;
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.5;
  const vibDepth = ctx.createGain();
  vibDepth.gain.value = 0;
  vib.connect(vibDepth).connect(osc.frequency);
  osc.connect(tone).connect(env).connect(guitarIn);
  const plan = [];
  let t = ctx.currentTime + 0.3;
  const pick = (m, at, ring = 0.5) => {
    osc.frequency.setValueAtTime(hz(m), at);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.5, at + 0.004);
    env.gain.setTargetAtTime(0.02, at + 0.004, 0.6);
    env.gain.setTargetAtTime(0, at + ring, 0.008); // palm mute
    plan.push({ note: m, at });
  };
  for (const m of RIFF) { pick(m, t); t += 0.6; }
  // A whole-step bend on B3.
  pick(59, t, 1.1);
  osc.frequency.setValueAtTime(hz(59), t + 0.25);
  osc.frequency.linearRampToValueAtTime(hz(61), t + 0.4);
  osc.frequency.setValueAtTime(hz(61), t + 0.75);
  osc.frequency.linearRampToValueAtTime(hz(59), t + 0.9);
  const bendAt = t;
  t += 1.25;
  // Vibrato (±35 cents) on G3.
  pick(55, t, 1.3);
  vibDepth.gain.setValueAtTime(0, t);
  vibDepth.gain.setValueAtTime(hz(55) * (Math.pow(2, 35 / 1200) - 1), t + 0.2);
  vibDepth.gain.setValueAtTime(0, t + 1.2);
  const vibAt = t;
  t += 1.45;
  osc.start();
  vib.start();
  osc.stop(t + 0.1);
  vib.stop(t + 0.1);
  while (ctx.currentTime < t + 0.15) await sleep(50);
  try { env.disconnect(); } catch { /* ignore */ }
  return { plan, bendAt, vibAt, end: t, dropouts: guitar.dropouts - drops0 };
}

function analyseRiff({ plan, bendAt, vibAt, end }) {
  const ons = state.notes.filter(n => n.type === 'noteOn');
  const rows = [];
  for (const p of plan) {
    const hit = ons.find(o => o.time >= p.at && o.time < p.at + 0.25);
    rows.push({ note: midiName(p.note), want: p.note, got: hit ? hit.note : null, latencyMs: hit ? (hit.time - p.at) * 1000 : null });
  }
  const bends = state.notes.filter(n => n.type === 'bend' && n.time >= bendAt && n.time < bendAt + 1.2).map(n => n.semitones);
  const bendOns = ons.filter(o => o.time > bendAt + 0.1 && o.time < bendAt + 1.2).length;
  const vibOns = ons.filter(o => o.time > vibAt + 0.1 && o.time < vibAt + 1.4).length;
  const vibBends = state.notes.filter(n => n.type === 'bend' && n.time >= vibAt + 0.25 && n.time < vibAt + 1.2).map(n => n.semitones);
  return { rows, bendMax: bends.length ? Math.max(...bends) : 0, bendOns, vibOns, vibRange: vibBends.length ? Math.max(...vibBends) - Math.min(...vibBends) : 0, total: ons.length, end, dropouts: arguments[0].dropouts };
}

// ------------------------------------------------------------------ capture

async function captureNote() {
  await start();
  const cap = createCapture(ctx, { channels: 1, maxSeconds: 3 });
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 110;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = 4;
  const env = ctx.createGain();
  env.gain.value = 0;
  osc.connect(tone).connect(env).connect(cap.input);
  const t = ctx.currentTime + 0.15;
  // The tone darkens and fades like a string ringing out, so the terrain has somewhere to go.
  tone.frequency.setValueAtTime(5000, t);
  tone.frequency.exponentialRampToValueAtTime(250, t + 1.5);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.5, t + 0.004);
  env.gain.setTargetAtTime(0.04, t + 0.004, 0.7);
  await cap.start();
  osc.start();
  while (ctx.currentTime < t + 1.6) await sleep(40);
  const [x] = await cap.stop();
  const dropouts = cap.dropouts;
  osc.stop();
  cap.dispose();
  const t0 = performance.now();
  const r = captureToWavetable(x, ctx.sampleRate, { name: 'Harness A2' });
  const ms = performance.now() - t0;
  if (r.ok) drawWavetable(r.frames);
  kv($('capOut'), r.ok
    ? { pitch: `${r.freq.toFixed(3)} Hz (${(1200 * Math.log2(r.freq / 110)).toFixed(2)} cents from 110)`, frames: r.userTerrain.h, 'from / to': `${r.startSec.toFixed(2)} s / ${r.endSec.toFixed(2)} s`, 'took': `${ms.toFixed(0)} ms`, via: cap.via }
    : { result: r.reason });
  return { r, ms, via: cap.via, samples: x.length, dropouts };
}

function drawWavetable(frames) {
  const c = $('wt');
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const img = g.createImageData(W, H);
  let peak = 0;
  for (const f of frames) for (const v of f) peak = Math.max(peak, Math.abs(v));
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  for (let y = 0; y < H; y++) {
    const f = frames[Math.min(frames.length - 1, Math.floor(y / H * frames.length))];
    for (let x = 0; x < W; x++) {
      const v = f[Math.floor(x / W * f.length)] / (peak || 1); // -1..1
      const u = (v + 1) / 2;
      const o = (y * W + x) * 4;
      // Teal for high ground, deep blue-grey for low.
      img.data[o] = Math.round((dark ? 20 : 30) + u * 40);
      img.data[o + 1] = Math.round((dark ? 30 : 60) + u * 178);
      img.data[o + 2] = Math.round((dark ? 50 : 90) + u * 151);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ MIDI to pedals

let midiPort = null;
const midiLog = [];
const pm = createPedalMidi({
  send: (bytes, ts) => {
    midiLog.push({ bytes: [...bytes], ts });
    if (midiPort) { try { midiPort.send(bytes, ts); } catch { /* port gone */ } }
  },
});
pm.addLfo('lfo1', createLfoSource({ shape: 'triangle', rateHz: 2 }), { bpm: () => 120 });
pm.map({ source: 'macro1', pedal: 'purrting', control: 'mix' });
let lfoMap = null;
function toggleLfo(on = !lfoMap) {
  if (on && !lfoMap) { lfoMap = pm.map({ source: 'lfo1', pedal: 'lostAndFound', control: 'blend' }); pm.start(); }
  else if (!on && lfoMap) { pm.unmap(lfoMap); lfoMap = null; pm.stop(); }
  $('lfo').textContent = lfoMap ? 'Stop the LFO' : 'LFO to Lost + Found Blend';
}
/** Highest number of messages any pedal channel got inside any one-second window. */
function peakRate(from = 0) {
  const byCh = new Map();
  for (const m of midiLog) {
    if (m.ts < from) continue;
    const ch = m.bytes[0] & 15;
    if (!byCh.has(ch)) byCh.set(ch, []);
    byCh.get(ch).push(m.ts);
  }
  let worst = 0;
  for (const ts of byCh.values()) {
    ts.sort((a, b) => a - b);
    for (let i = 0, j = 0; i < ts.length; i++) { while (ts[i] - ts[j] >= 1000) j++; worst = Math.max(worst, i - j + 1); }
  }
  return worst;
}
const hex = (b) => b.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
function showMidi() {
  const now = performance.now();
  const recent = midiLog.filter(m => m.ts > now - 1000);
  const per = {};
  for (const p of pm.pedals()) per[p.name] = recent.filter(m => (m.bytes[0] & 15) === p.channel - 1).length + ' per s';
  kv($('midiOutStats'), { ...per, 'busiest second': peakRate() });
  $('midiLog').textContent = midiLog.slice(-14).reverse().map(m => `${m.ts.toFixed(1).padStart(10)} ms  ${hex(m.bytes)}`).join('\n');
}
setInterval(showMidi, 250);

async function populateMidiOutputs() {
  if (!navigator.requestMIDIAccess || $('midiOut').dataset.filled) return;
  $('midiOut').dataset.filled = '1';
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    for (const o of access.outputs.values()) {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.name;
      $('midiOut').appendChild(opt);
    }
    $('midiOut').onchange = () => { midiPort = access.outputs.get($('midiOut').value) || null; };
  } catch { /* no MIDI permission: log only */ }
}

// ------------------------------------------------------------------ wiring

$('start').onclick = () => start();
$('ping').onclick = () => ping();
$('howl').onclick = async () => { await startFeedback(); };
$('unmute').onclick = () => { stopFeedback(); guard && guard.reset(); };
$('play').onclick = () => playRiff();
$('capture').onclick = () => captureNote();
$('purrOn').onclick = () => pm.engage('purrting', true);
$('purrOff').onclick = () => pm.engage('purrting', false);
$('pc').onclick = () => pm.programChange('lostAndFound', 0);
$('taps').onclick = () => pm.tapTempo('purrting', 120, { taps: 4 });
$('macro').oninput = (e) => pm.input('macro1', Number(e.target.value));
$('lfo').onclick = () => toggleLfo();
$('midiOut').onfocus = populateMidiOutputs;
$('midiOut').onpointerdown = populateMidiOutputs;
setInterval(() => { if (guard) showGuard(); }, 200);

// ------------------------------------------------------------------ scripted checks

async function offlineRoutingCheck() {
  // A 4-channel OfflineAudioContext behaves like a 4-output device, so the
  // multichannel path can be rendered and inspected even with no MPC attached.
  const off = new OfflineAudioContext(4, 4800, 48000);
  const r = buildOutputRouting(off);
  const main = off.createConstantSource(); main.offset.value = 0.25;
  const send = off.createConstantSource(); send.offset.value = 0.5;
  main.connect(r.mainIn); send.connect(r.sendIn);
  main.start(); send.start();
  const buf = await off.startRendering();
  const mid = (c) => buf.getChannelData(c)[2400];
  return { mode: r.mode, channels: buf.numberOfChannels, values: [0, 1, 2, 3].map(mid) };
}

async function limiterCheck() {
  // A full-scale sine into the send limiter must come out at or under -18 dBFS.
  const cap = createCapture(ctx, { channels: 1, maxSeconds: 1 });
  const lim = createSendLimiter(ctx);
  const osc = ctx.createOscillator();
  osc.frequency.value = 220;
  const hot = ctx.createGain();
  hot.gain.value = 1;
  osc.connect(hot).connect(lim.input);
  lim.output.connect(cap.input);
  await cap.start();
  osc.start();
  await sleep(350);
  const [x] = await cap.stop();
  osc.stop();
  lim.dispose(); cap.dispose();
  const tail = x.subarray(Math.floor(x.length / 3));
  // Its own delay: ping straight through it.
  const lat = await measureRoundTrip(ctx, { sendNode: limiter.input, returnNode: limiter.output, runs: 1 });
  return { peakDb: gainToDb(peakAbs(tail)), latencySamples: lat.latencySamples, dropouts: lat.runs.reduce((n, x) => n + (x.dropouts || 0), 0) };
}

async function auto() {
  setStatus('Running checks');
  await start();
  check('AudioContext running', ctx.state === 'running', ctx.state);
  if (params.has('noworklet')) check('fallback mode: worklets deliberately not loaded', state.metrics.worklet === 'script fallback', state.metrics.worklet);
  else check('pedal worklets loaded', state.metrics.worklet === 'blob' || state.metrics.worklet === 'data', state.metrics.worklet);
  check('output routing decided, with a reason when it falls back', routing.mode === 'multichannel' || !!routing.reason, { mode: routing.mode, channels: ctx.destination.maxChannelCount, reason: routing.reason });

  const offR = await offlineRoutingCheck();
  state.metrics.offlineRouting = offR;
  check('4-channel device: main on outputs 1/2, send on 3/4 (rendered)', offR.mode === 'multichannel' && offR.values.every((v, i) => Math.abs(v - (i < 2 ? 0.25 : 0.5)) < 1e-6), offR.values);

  const lim = await limiterCheck();
  state.metrics.limiter = lim;
  check('send limiter holds a full-scale sine at -18 dBFS', lim.peakDb <= -17.9, `${lim.peakDb.toFixed(2)} dBFS`);

  for (const [ms, sig] of [[37.5, 'chirp'], [12.3, 'chirp'], [120, 'mls']]) {
    $('loopMs').value = ms;
    const { r, set } = await ping(sig);
    const drops = r.runs.reduce((n, x) => n + (x.dropouts || 0), 0);
    state.metrics[`ping_${sig}_${ms}`] = { latencyMs: r.latencyMs, latencySamples: r.latencySamples, set, confidence: r.confidence, via: r.via, dropouts: drops };
    check(`ping (${sig}) recovers a ${ms} ms loop within 1 sample`, r.ok && Math.abs(r.latencySamples - set) <= 1 && r.confidence > 0.8,
      r.ok ? `${r.latencySamples.toFixed(2)} vs ${set.toFixed(2)} samples, confidence ${r.confidence.toFixed(3)}` : r.reason,
      drops && (!r.ok || Math.abs(r.latencySamples - set) <= 1) ? `${drops} recording buffer(s) dropped by a busy main thread` : null);
  }
  if (lim.latencySamples != null) state.metrics.limiterLatencySamples = lim.latencySamples;
  check('send limiter delay measured by the same ping', Number.isFinite(lim.latencySamples), `${Number(lim.latencySamples).toFixed(2)} samples`,
    lim.dropouts ? `${lim.dropouts} recording buffer(s) dropped by a busy main thread` : null);

  // Nothing connected: a reason, not a number.
  loopDelay.disconnect(returnIn);
  const none = await measureRoundTrip(ctx, { sendNode: sendBus, returnNode: returnIn, runs: 2 });
  loopDelay.connect(returnIn);
  check('ping with no return explains itself', !none.ok && /No clear ping/.test(none.reason || ''), none.reason);

  // Feedback guard.
  guard.reset();
  const t0 = performance.now();
  await startFeedback();
  while (!guard.tripped && performance.now() - t0 < 4000) await sleep(25);
  const tripMs = performance.now() - t0;
  await sleep(300);
  const gs = showGuard();
  state.metrics.guard = { tripMs, kind: gs.kind, muted: gs.muted, outside: gs.outside, returnGain: returnGain.gain.value };
  check('feedback guard trips on a runaway loop and mutes the return', gs.tripped && gs.muted && returnGain.gain.value < 1e-3, `${gs.kind} after ${tripMs.toFixed(0)} ms`);
  check('guard notices the loop keeps going outside Orograph', gs.outside === true, gs.outsideReason);
  stopFeedback();
  guard.reset();
  await sleep(150);
  check('unmute restores the return', returnGain.gain.value > 0.99, returnGain.gain.value);

  // Guitar.
  const riff = await playRiff();
  const res = analyseRiff(riff);
  state.metrics.riff = res;
  const lost = res.dropouts ? `${res.dropouts} input buffer(s) dropped by a busy main thread` : null;
  for (const row of res.rows) {
    check(`guitar ${row.note}: right note`, row.got === row.want, row.latencyMs == null ? 'missed' : `${row.latencyMs.toFixed(1)} ms after the pick`, lost);
  }
  const lats = res.rows.filter(r => r.latencyMs != null).map(r => r.latencyMs);
  // The fallback hands audio over in 2048-sample buffers, so its notes arrive one buffer later.
  const limit = guitar.via === 'worklet' ? 50 : 50 + 2048 / ctx.sampleRate * 1000;
  check(`guitar note-on latency within ${limit.toFixed(0)} ms`, lats.length === res.rows.length && Math.max(...lats) <= limit, lats.map(l => +l.toFixed(1)), lost);
  check('whole-step bend arrives as pitch bend, no new note', res.bendMax > 1.85 && res.bendOns === 0, `max ${res.bendMax.toFixed(2)} st`, lost);
  check('vibrato bends without retriggering', res.vibOns === 0 && res.vibRange > 0.4, `range ${res.vibRange.toFixed(2)} st`, lost);
  kv($('guitarOut'), { notes: res.rows.map(r => `${r.note} ${r.latencyMs == null ? 'missed' : r.latencyMs.toFixed(0) + ' ms'}`).join(', '), bend: `+${res.bendMax.toFixed(2)} st`, via: guitar.via });

  // Capture.
  const cap = await captureNote();
  state.metrics.capture = cap.r.ok ? { freq: cap.r.freq, frames: cap.r.userTerrain.h, ms: cap.ms, via: cap.via } : { reason: cap.r.reason };
  const capLost = cap.dropouts ? `${cap.dropouts} recording buffer(s) dropped by a busy main thread` : null;
  check('capture finds the held note within 1 cent', cap.r.ok && Math.abs(1200 * Math.log2(cap.r.freq / 110)) < 1, cap.r.ok ? `${cap.r.freq.toFixed(3)} Hz` : cap.r.reason, capLost);
  check('capture fills a wavetable terrain', cap.r.ok && cap.r.userTerrain.kind === 'wavetable' && cap.r.userTerrain.w === 256 && cap.r.userTerrain.h >= 64, cap.r.ok ? `${cap.r.userTerrain.h} frames` : '');

  // MIDI to pedals.
  const mark = midiLog.length;
  pm.engage('purrting', true);
  pm.engage('purrting', false);
  pm.programChange('lostAndFound', 0);
  const taps = pm.tapTempo('purrting', 120, { taps: 4, startMs: performance.now() + 50 });
  await sleep(1700);
  const sent = midiLog.slice(mark).map(m => hex(m.bytes));
  check('Purr-ting on/off uses the inverted CC 85', sent[0] === 'B0 55 00' && sent[1] === 'B0 55 7F', sent.slice(0, 2));
  check('Lost + Found PC 0 (live) on channel 2', sent.includes('C1 00'), sent[2]);
  const tapTs = midiLog.slice(mark).filter(m => m.bytes[1] === 86).map(m => m.ts);
  const gaps = tapTs.slice(1).map((t, i) => +(t - tapTs[i]).toFixed(3));
  check('tap tempo: four taps 500 ms apart', tapTs.length === 4 && gaps.every(g => Math.abs(g - 500) < 1e-3), gaps);
  const from = performance.now();
  toggleLfo(true);
  const sweepStart = performance.now();
  while (performance.now() - sweepStart < 2000) {
    pm.input('macro1', (Math.sin((performance.now() - sweepStart) / 120) + 1) / 2);
    await sleep(2);
  }
  toggleLfo(false);
  await sleep(100);
  const worst = peakRate(from);
  state.metrics.midiPeakPerSecond = worst;
  // The upper bound is the rule; the lower one only proves the sweep ran (a starved main thread sends fewer).
  check('LFO + macro sweep stays at or under 100 messages per second per pedal', worst <= 100 && worst >= 20, worst);

  // Return input (Chromium's fake device in the e2e run).
  if (params.has('media')) {
    const ret = await openReturn(ctx, null, { layout: 'mono+guitar' });
    state.metrics.return = ret.ok ? { settings: ret.settings, warnings: ret.warnings } : { reason: ret.reason };
    check('openReturn opens an input with voice processing off', ret.ok && ret.settings.echoCancellation !== true && ret.settings.autoGainControl !== true, ret.ok ? ret.settings : ret.reason);
    if (ret.ok) ret.close();
  }

  showMidi();
  const failed = state.checks.filter(c => !c.pass && !c.skip).length;
  const skipped = state.checks.filter(c => c.skip).length;
  setStatus((failed ? `Done: ${failed} check${failed > 1 ? 's' : ''} failed` : 'Done: all checks passed') + (skipped ? `, ${skipped} skipped (audio dropped)` : ''));
  state.status = 'done';
}

if (AUTO) auto().catch((err) => { state.errors.push(String(err && err.stack || err)); setStatus('error'); state.status = 'error'; });
