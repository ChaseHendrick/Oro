// Dev harness for the music module: loads factory scene 0, runs the real
// transport against the real audio engine when it is available (otherwise a
// logging engine on a real AudioContext), and measures timing. Driven by
// tests/e2e/music.cjs through window.harness.

import workletCode from 'virtual:worklet:src/dsp/worklet.js';
import { createStore } from '/src/core/store.js';
import { defaultState, DEFAULT_PARTS, GLOBAL_PARAMS, activeSeq } from '/src/core/params.js';
import { generateTerrain, buildMipChain } from '/src/dsp/terrains.js';
import { createMusic } from '/src/music/music.js';
import { createPresets } from '/src/presets/presets.js';
import { createMidi } from '/src/midi/midi.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['var(--p0)', 'var(--p1)', 'var(--p2)', 'var(--p3)'];

async function makeEngine(store) {
  try {
    // A computed specifier, so Vite does not insist the file exists before the audio module lands.
    const url = ['/src', 'audio', 'engine.js'].join('/');
    const mod = await import(/* @vite-ignore */ url);
    const engine = await mod.createEngine({ store });
    return { engine: await withTap(engine, store), kind: 'real' };
  } catch (err) {
    console.info('[harness] real engine unavailable, hosting the DSP worklet directly:', err && err.message);
  }
  try {
    return { engine: await makeDspEngine(store), kind: 'dsp' };
  } catch (err) {
    console.info('[harness] DSP worklet unavailable, using a logging engine:', err && err.message);
  }
  const context = new AudioContext();
  // A silent source keeps the context clock running like a real graph would.
  const gain = context.createGain();
  gain.gain.value = 0;
  const osc = context.createOscillator();
  osc.connect(gain).connect(context.destination);
  osc.start();
  const log = [];
  const engine = {
    context,
    log,
    start: () => context.resume(),
    noteOn(part, note, vel, time) { log.push({ on: true, part, note, vel, time, at: context.currentTime }); },
    noteOff(part, note, time) { log.push({ on: false, part, note, time, at: context.currentTime }); },
    allNotesOff() {}, panic() {}, bend() {}, wheel() {},
  };
  return { engine, kind: 'logging' };
}

// A tap that hands the dry output back to the page with exact context times,
// so the e2e test can find note onsets in the real audio.
const TAP_CODE = `
class OgTap extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = !!e.data; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) this.port.postMessage({ t: currentTime, d: ch.slice() });
    return true;
  }
}
registerProcessor('og-tap', OgTap);`;

/**
 * The real engine records WAV files, but the onset check in
 * tests/e2e/music.cjs needs raw samples with their context times, like the
 * stand-in below provides. Tap the engine's analyser (the master output) and
 * answer startRecording / stopRecording with sample blocks. While recording,
 * every part's delay and reverb sends are muted so effect tails cannot hide
 * the next onset; they are restored afterwards. Everything else goes straight
 * to the real engine.
 */
async function withTap(engine, store) {
  const ctx = engine.context;
  if (!ctx || !ctx.audioWorklet || !engine.analyser) return engine;
  let tap;
  try {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP_CODE], { type: 'application/javascript' })));
    tap = new AudioWorkletNode(ctx, 'og-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    engine.analyser.connect(tap);
  } catch (err) {
    console.info('[harness] no sample tap on the real engine:', err && err.message);
    return engine;
  }
  let recording = null;
  let savedSends = null;
  tap.port.onmessage = (e) => { if (recording) recording.push(e.data); };
  const sendPath = (p, id) => `parts.${p}.params.${id}`;
  function startRecording() {
    savedSends = [];
    store.batch(() => {
      for (let p = 0; p < DEFAULT_PARTS; p++) {
        for (const id of ['delaySend', 'reverbSend']) {
          savedSends.push([sendPath(p, id), store.get(sendPath(p, id))]);
          store.set(sendPath(p, id), 0, { source: 'harness' });
        }
      }
    });
    recording = [];
    tap.port.postMessage(true);
  }
  function stopRecording() {
    tap.port.postMessage(false);
    const r = recording || [];
    recording = null;
    if (savedSends) store.batch(() => { for (const [path, v] of savedSends) store.set(path, v, { source: 'harness' }); });
    savedSends = null;
    return r;
  }
  return new Proxy(engine, {
    get(target, key) {
      if (key === 'startRecording') return startRecording;
      if (key === 'stopRecording') return stopRecording;
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * Minimal stand-in for the audio host (src/audio/engine.js) for this harness
 * only: the real DSP worklet, parameters and terrains forwarded from the
 * store, plus an analyser and an output tap.
 */
async function makeDspEngine(store) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  await context.audioWorklet.addModule(blobUrl(workletCode));
  await context.audioWorklet.addModule(blobUrl(TAP_CODE));
  const node = new AudioWorkletNode(context, 'orograph', {
    numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2],
    processorOptions: { sampleRate: context.sampleRate },
  });
  const out = context.createGain();
  out.gain.value = 0.8;
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  const tap = new AudioWorkletNode(context, 'og-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
  node.connect(out, 0);
  out.connect(context.destination);
  out.connect(analyser);
  node.connect(tap, 0);
  const post = (m) => node.port.postMessage(m);

  const terrainKeys = Array.from({ length: DEFAULT_PARTS }, () => ['', '']);
  function syncPart(p) {
    const part = store.get(`parts.${p}`);
    post({ t: 'params', part: p, p: part.params });
    post({ t: 'mods', part: p, m: part.mods });
    ['terrainA', 'terrainB'].forEach((id, slot) => {
      const key = `${part.params[id]}|${part.params.seed}|${part.params.detail}`;
      if (terrainKeys[p][slot] === key) return;
      terrainKeys[p][slot] = key;
      const data = generateTerrain(part.params[id], { size: 512, seed: part.params.seed, detail: part.params.detail });
      if (!data) return;
      const levels = buildMipChain(data, 512);
      node.port.postMessage({ t: 'terrain', part: p, slot, levels }, levels.map(l => l.data.buffer).filter((b, i, a) => a.indexOf(b) === i));
    });
  }
  function syncAll() {
    for (let p = 0; p < DEFAULT_PARTS; p++) syncPart(p);
    post({ t: 'global', p: Object.fromEntries(GLOBAL_PARAMS.map(d => [d.id, store.get(`global.${d.id}`)])) });
  }
  let pending = 0;
  store.subscribe('', (path) => {
    if (path.startsWith('ui')) return;
    clearTimeout(pending);
    pending = setTimeout(syncAll, 15);
  });
  syncAll();

  const buf = new Float32Array(analyser.fftSize);
  let recording = null;
  tap.port.onmessage = (e) => { if (recording) recording.push(e.data); };
  return {
    context,
    analyser,
    start: () => context.resume(),
    noteOn: (part, note, vel = 0.8, time = 0) => post({ t: 'noteOn', part, note, vel, time }),
    noteOff: (part, note, time = 0) => post({ t: 'noteOff', part, note, time }),
    allNotesOff: (part) => post(part == null ? { t: 'allOff' } : { t: 'allOff', part }),
    panic: () => post({ t: 'panic' }),
    bend: (part, v) => post({ t: 'bend', part, v }),
    wheel: (part, v) => post({ t: 'wheel', part, v }),
    level() {
      analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.sqrt(s / buf.length);
    },
    startRecording() { recording = []; tap.port.postMessage(true); },
    stopRecording() { tap.port.postMessage(false); const r = recording || []; recording = null; return r; },
  };
}

async function boot() {
  const store = createStore(defaultState());
  const presets = createPresets({ store, storage: null });
  presets.loadScene(0);
  const { engine, kind } = await makeEngine(store);
  try { await engine.start(); } catch { /* resumes on the first click instead */ }
  const music = createMusic({ store, engine, presets });
  const midi = await createMidi({ store, router: music.router, engine, transport: music.transport, presets, storage: null });

  $('engine').textContent = kind;
  $('scene').textContent = presets.scenes()[0].name;

  // ---- part rows
  const rows = [];
  const partsEl = $('parts');
  for (let p = 0; p < DEFAULT_PARTS; p++) {
    const row = document.createElement('div');
    row.className = 'part';
    row.style.setProperty('--c', COLORS[p]);
    row.innerHTML = `<div class="name"></div><div class="led"></div><div class="steps"></div>`;
    const steps = [];
    for (let i = 0; i < 16; i++) { const s = document.createElement('div'); s.className = 'step'; row.querySelector('.steps').appendChild(s); steps.push(s); }
    partsEl.appendChild(row);
    rows.push({ row, steps, led: row.querySelector('.led'), name: row.querySelector('.name'), head: -1, ledTimer: 0 });
  }
  function drawPatterns() {
    for (let p = 0; p < DEFAULT_PARTS; p++) {
      const part = store.get(`parts.${p}`);
      rows[p].name.innerHTML = `${part.name}<small>${part.patchName}</small>`;
      const seq = activeSeq(part);
      seq.steps.forEach((st, i) => {
        rows[p].steps[i].classList.toggle('on', !!st.on);
        rows[p].steps[i].classList.toggle('off-len', i >= seq.length);
      });
    }
    $('tempo').textContent = store.get('global.tempo') + ' bpm';
  }
  drawPatterns();
  store.subscribe('parts', drawPatterns);
  store.subscribe('global.tempo', drawPatterns);

  // ---- measurements
  const stats = { steps: [], sched: [], notes: [], lateness: [] };
  const timebase = music.timebase;
  music.transport.on('step', (e) => {
    const firedAt = performance.now();
    const heardAt = timebase.audioToPerf(e.time);
    stats.steps.push({ ...e, firedAt, heardAt });
    stats.lateness.push(firedAt - heardAt);
    const r = rows[e.part];
    if (r.head >= 0) r.steps[r.head].classList.remove('head');
    r.head = e.step;
    r.steps[e.step].classList.add('head');
  });
  music.router.on('sched', (e) => {
    const ctxNow = engine.context.currentTime;
    stats.sched.push({ ...e, lead: e.time > 0 ? e.time - ctxNow : null });
  });
  music.router.on('note', (e) => {
    stats.notes.push({ ...e, at: performance.now() });
    if (!e.on) return;
    const r = rows[e.part];
    r.led.classList.add('on');
    clearTimeout(r.ledTimer);
    r.ledTimer = setTimeout(() => r.led.classList.remove('on'), 90);
  });

  function summary() {
    const late = stats.lateness;
    // Note-ons only: note-offs sent at stop time are meant to land "now".
    const leads = stats.sched.filter(s => s.on && s.lead != null).map(s => s.lead);
    const mean = late.length ? late.reduce((a, b) => a + b, 0) / late.length : 0;
    return {
      steps: stats.steps.length,
      notesScheduled: stats.sched.filter(s => s.on).length,
      minLeadMs: leads.length ? Math.min(...leads) * 1000 : null,
      meanLatenessMs: mean,
      maxLatenessMs: late.length ? Math.max(...late) : 0,
    };
  }
  function drawStats() {
    const s = summary();
    $('s-steps').textContent = s.steps;
    $('s-notes').textContent = s.notesScheduled;
    $('s-lead').textContent = s.minLeadMs == null ? '-' : s.minLeadMs.toFixed(1) + ' ms';
    $('s-mean').textContent = s.steps ? s.meanLatenessMs.toFixed(2) + ' ms' : '-';
    $('s-max').textContent = s.steps ? s.maxLatenessMs.toFixed(2) + ' ms' : '-';
    const pos = music.transport.position();
    $('pos').textContent = `${pos.bar + 1}.${pos.beat + 1}.${(pos.step % 4) + 1}`;
    requestAnimationFrame(drawStats);
  }
  requestAnimationFrame(drawStats);

  const playBtn = $('play');
  playBtn.addEventListener('click', async () => {
    try { await engine.start(); } catch { /* ignore */ }
    music.transport.toggle();
  });
  music.transport.on('state', (s) => {
    playBtn.textContent = s.playing ? 'Stop' : 'Play';
    if (!s.playing) for (const r of rows) { if (r.head >= 0) r.steps[r.head].classList.remove('head'); r.head = -1; }
  });

  // Round D: preview, Explore notes and offline event rendering.
  $('preview').addEventListener('click', async () => {
    try { await engine.start(); } catch { /* ignore */ }
    const info = music.preview('sel');
    $('r-preview').textContent = info ? `${info.category}: ${info.phrase}` : 'nothing to play';
  });
  music.on('preview', (e) => { if (!e.playing) $('r-preview').textContent += ` (${e.reason})`; });
  $('explore').addEventListener('click', async () => {
    try { await engine.start(); } catch { /* ignore */ }
    const p = store.get('ui.selectedPart') || 0;
    // Switch the part to Explore mode for the demo, as the dot settings would.
    if (store.get(`parts.${p}.dot.mode`) !== 3) store.set(`parts.${p}.dot.mode`, 3);
    const height = Math.random() * 2 - 1;
    const n = music.exploreNote({ part: p, kind: height > 0 ? 'peak' : 'valley', height, x: Math.random(), y: Math.random() });
    $('r-explore').textContent = n ? `note ${n.note}, vel ${n.vel.toFixed(2)}` : 'held back by the rate limit';
  });
  $('render').addEventListener('click', () => {
    const t0 = performance.now();
    const ev = music.renderEvents(4);
    const ons = ev.filter(e => e.msg.t === 'noteOn').length;
    const locks = ev.filter(e => e.msg.t === 'params').length;
    $('r-render').textContent = `${ons} notes, ${locks} locks, ${(performance.now() - t0).toFixed(0)} ms`;
    window.lastRender = ev;
  });

  function setChecks(list) {
    const ul = $('checks');
    ul.innerHTML = '';
    for (const c of list) {
      const li = document.createElement('li');
      li.className = c.pass ? 'pass' : 'fail';
      li.textContent = c.text;
      ul.appendChild(li);
    }
  }

  window.harness = {
    store, music, presets, midi, engine, kind, stats, summary, setChecks,
    reset() { stats.steps.length = 0; stats.sched.length = 0; stats.notes.length = 0; stats.lateness.length = 0; },
    ready: true,
  };
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#ff6b6b">${String(err && err.stack || err)}</pre>`);
  window.harness = { error: String(err && err.stack || err) };
});
