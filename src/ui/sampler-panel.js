// Sampler card: one sample per track, played across the keyboard.
// At rest the card is a name, a Mono or Stereo chip, the waveform, one Take
// (Mic, File, Loop or Output) and one action. Slice marks are edited on the
// wave, and only in Slices. Grain controls show only in Granular.
// Drum kit and sampler stay mutually exclusive: the kit wins in the engine
// if both are on, and each toggle turns the other off.

import { h, createScope, setText, watchSize, pixelRatioOf } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createSegmented, createToggle, createStepper } from './controls.js';
import { recordMic } from './drum-panel.js';
import {
  SAMPLER_MODES, SAMPLER_DIRS, SAMPLER_RATE, MAX_SLICES, defaultSampler, sanitizeSampler,
} from '../dsp/sampler.js';
import { pcmToBase64, base64ToPcm, sliceTransients } from '../dsp/drum-kit.js';
import {
  midiNoteName, fitSample, fitStereo, loopToSample, waveformPeaks, pickRegionHandle, moveRegionHandle,
  cleanSampleName, mixToMono, pickSliceMark, moveSliceMark, addSliceMark, deleteSliceMark,
  evenSliceMarks, nearestZeroCross, SLICE_HIT_PX, SLICE_HIT_COARSE,
} from './sampler-model.js';

const RECORD_LENGTHS = [2, 4, 8, 16];
const TAKES = [
  { value: 'mic', label: 'Mic' },
  { value: 'file', label: 'File' },
  { value: 'loop', label: 'Loop' },
  { value: 'output', label: 'Output' },
];
const EVEN = [4, 8, 16];

const FIELDS = {
  mode: { id: 'samplerMode', label: 'Playback', curve: 'enum', min: 0, max: SAMPLER_MODES.length - 1, default: 0, options: SAMPLER_MODES },
  dir: { id: 'samplerDir', label: 'Direction', curve: 'enum', min: 0, max: SAMPLER_DIRS.length - 1, default: 0, options: SAMPLER_DIRS },
  loop: { id: 'samplerLoop', label: 'Loop', curve: 'bool', min: 0, max: 1, default: 0 },
  sustain: { id: 'samplerSustain', label: 'Sustain', curve: 'bool', min: 0, max: 1, default: 1 },
  root: { id: 'samplerRoot', label: 'Root', curve: 'int', min: 0, max: 127, default: 60 },
  fine: { id: 'samplerFine', label: 'Fine', curve: 'lin', min: -100, max: 100, default: 0, unit: 'ct' },
  attack: { id: 'samplerAttack', label: 'Attack', curve: 'exp', min: 0.0005, max: 4, default: 0.002, unit: 's' },
  decay: { id: 'samplerDecay', label: 'Decay', curve: 'exp', min: 0.01, max: 20, default: 2, unit: 's' },
  level: { id: 'samplerLevel', label: 'Level', curve: 'lin', min: 0, max: 1, default: 0.8 },
};

const GRAIN = {
  size: { id: 'grainSize', label: 'Size', curve: 'exp', min: 0.01, max: 0.5, default: 0.08, unit: 's' },
  density: { id: 'grainDensity', label: 'Density', curve: 'lin', min: 1, max: 100, default: 20 },
  spread: { id: 'grainSpread', label: 'Spread', curve: 'lin', min: 0, max: 1, default: 0.1 },
  jitter: { id: 'grainJitter', label: 'Jitter', curve: 'lin', min: 0, max: 12, default: 0, unit: 'st' },
  rev: { id: 'grainRev', label: 'Reverse', curve: 'lin', min: 0, max: 1, default: 0 },
};

async function decodeStereo(buf) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio files');
  const copy = buf && typeof buf.slice === 'function' ? buf.slice(0) : buf;
  const ab = await new Ctx(2, 1, SAMPLER_RATE).decodeAudioData(copy);
  const L = new Float32Array(ab.length);
  L.set(ab.getChannelData(0));
  let R = null;
  if (ab.numberOfChannels > 1) {
    R = new Float32Array(ab.length);
    R.set(ab.getChannelData(1));
  }
  return fitStereo(L, R, SAMPLER_RATE);
}

export function createSamplerPanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const sel = () => binder.selected();
  const samplerPath = () => `parts.${sel()}.sampler`;
  let alive = true;
  let busy = false;
  let take = 'mic';
  let holdTimer = 0;

  function subscribeSampler(fn) {
    let part = sel();
    let off = store.subscribe(`parts.${part}.sampler`, fn);
    const offSel = store.subscribe('ui.selectedPart', () => {
      off();
      part = sel();
      off = store.subscribe(`parts.${part}.sampler`, fn);
      fn();
    });
    return () => { off(); offSel(); };
  }

  function writeField(key, value, grain = false) {
    const cur = store.get(samplerPath());
    const base = (cur && typeof cur === 'object') ? cur : defaultSampler();
    const prev = sanitizeSampler(base) || defaultSampler();
    const nextSrc = grain
      ? { ...base, grain: { ...(base.grain && typeof base.grain === 'object' ? base.grain : {}), [key]: value } }
      : { ...base, [key]: value };
    const next = sanitizeSampler(nextSrc);
    if (!next) return;
    const before = grain ? prev.grain[key] : prev[key];
    const after = grain ? next.grain[key] : next[key];
    if (before === after) return;
    store.set(samplerPath(), next, { source: 'ui' });
  }

  function fieldBinding(key, def, grain = false) {
    return {
      def,
      id: def.id,
      scope: 'custom',
      part: sel,
      path: samplerPath,
      modPath: () => null,
      learnTarget: () => null,
      get() {
        const s = sanitizeSampler(store.get(samplerPath())) || defaultSampler();
        const src = grain ? s.grain : s;
        const v = src[key];
        return typeof v === 'number' && Number.isFinite(v) ? v : def.default;
      },
      set(v) { writeField(key, v, grain); },
      reset() { this.set(def.default); },
      subscribe: subscribeSampler,
    };
  }

  function setSamplerOn(on) {
    const path = samplerPath();
    const cur = store.get(path);
    const base = sanitizeSampler(cur) || defaultSampler();
    const next = sanitizeSampler({ ...base, on: on ? 1 : 0 });
    const run = typeof store.batch === 'function' ? (fn) => store.batch(fn) : (fn) => fn();
    run(() => {
      if (on) {
        const drum = store.get(`parts.${sel()}.drum`);
        if (drum && typeof drum === 'object' && drum.on) {
          store.set(`parts.${sel()}.drum`, { ...drum, on: 0 }, { source: 'ui' });
        }
      }
      if (next) store.set(path, next, { source: 'ui' });
    });
  }

  const toggle = h('button', { type: 'button', class: 'toggle toggle--sm', 'aria-pressed': 'false', 'aria-label': 'Sampler' }, 'Sampler');
  scope.on(toggle, 'click', () => {
    const s = sanitizeSampler(store.get(samplerPath()));
    setSamplerOn(!(s && s.on));
  });

  const tuneBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-expanded': 'false' }, 'Tune');
  const tuneBox = h('div', { class: 'sampler-tune', hidden: true });
  let tuner = null;
  scope.on(tuneBtn, 'click', () => {
    const open = tuneBox.hidden;
    tuneBox.hidden = !open;
    tuneBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open || tuner) return;
    import('./tuner-panel.js').then((mod) => {
      if (!alive || tuner) return;
      tuner = mod.createTunerPanel(ctx);
      tuneBox.appendChild(tuner.el);
      scope.add(tuner.dispose);
    }).catch(() => { tuneBox.hidden = true; tuneBtn.setAttribute('aria-expanded', 'false'); });
  });

  const status = h('p', { class: 'sampler-status', 'aria-live': 'polite' });
  function say(text) { if (alive) setText(status, text); }
  function errorText(err, fallback) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) return 'Microphone access was refused.';
    return (err && err.message) || fallback;
  }

  let recordSecs = 4;
  const recordListeners = new Set();
  const recordBinding = {
    def: { id: 'samplerRecord', label: 'Record length', min: 2, max: 16, default: 4 },
    get: () => recordSecs,
    set(v) {
      const n = RECORD_LENGTHS.includes(v) ? v : 4;
      if (n === recordSecs) return;
      recordSecs = n;
      for (const fn of recordListeners) fn();
    },
    subscribe(fn) { recordListeners.add(fn); return () => recordListeners.delete(fn); },
  };
  const recordSeg = createSegmented(ctx, recordBinding, {
    label: 'Record length',
    size: 'sm',
    options: RECORD_LENGTHS.map((n) => ({ value: n, label: `${n} s` })),
  });
  scope.add(recordSeg.dispose);

  const takeListeners = new Set();
  const takeBinding = {
    def: { id: 'samplerTake', label: 'Take', default: 'mic' },
    get: () => take,
    set(v) {
      const n = TAKES.some((t) => t.value === v) ? v : 'mic';
      if (n === take) return;
      take = n;
      for (const fn of takeListeners) fn();
    },
    subscribe(fn) { takeListeners.add(fn); return () => takeListeners.delete(fn); },
  };
  const takeSeg = createSegmented(ctx, takeBinding, { label: 'Take', size: 'sm', options: TAKES });
  scope.add(takeSeg.dispose);

  const actionBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Record 4 s');
  const fileIn = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });

  function actionText() {
    if (busy && take === 'output') return 'Recording output';
    if (busy && take === 'mic') return 'Recording';
    if (take === 'mic') return `Record ${recordSecs} s`;
    if (take === 'file') return 'Import';
    if (take === 'loop') return 'Grab loop';
    return 'Record output';
  }
  function refreshAction() {
    if (!alive) return;
    setText(actionBtn, actionText());
    recordSeg.el.hidden = take !== 'mic' && take !== 'output';
    actionBtn.disabled = busy;
  }
  scope.add(recordBinding.subscribe(() => schedule(refreshAction)));
  scope.add(takeBinding.subscribe(() => schedule(refreshAction)));

  function setBusy(on) {
    busy = on;
    refreshAction();
  }

  function commitSample(part, fit, name) {
    if (!fit || !fit.data || !fit.data.length) { say('That sample was empty.'); return; }
    let data;
    let right = '';
    try {
      data = pcmToBase64(fit.data);
      if (fit.stereo && fit.right && fit.right.length === fit.data.length) right = pcmToBase64(fit.right);
    } catch { say('That sample could not be stored.'); return; }
    const path = `parts.${part}.sampler`;
    const cur = store.get(path);
    const base = (cur && typeof cur === 'object') ? cur : defaultSampler();
    const rest = { ...base };
    delete rest.slices;
    const sample = { rate: fit.rate, data };
    if (right) sample.right = right;
    const next = sanitizeSampler({
      ...rest,
      on: base.on ? 1 : 0,
      name: cleanSampleName(name),
      sample,
    });
    if (!next || !next.sample) { say('That sample is too long to store.'); return; }
    store.set(path, next, { source: 'ui' });
    const secs = (fit.data.length / fit.rate).toFixed(1);
    const label = next.name || 'Sample';
    const ch = next.sample.right ? 'stereo' : 'mono';
    const cut = fit.trimmed ? ' The rest was cut to fit.' : '';
    say(`Stored ${label}, ${secs} s, ${ch}.${cut}`);
  }

  async function recordMicTake(part) {
    const secs = recordSecs;
    setBusy(true);
    say('Recording, 0%.');
    try {
      const audio = await recordMic(secs, (p) => say(`Recording, ${Math.round(p * 100)}%.`));
      commitSample(part, fitSample(audio, SAMPLER_RATE), 'Recording');
    } catch (err) {
      say(errorText(err, 'Recording failed.'));
    } finally { setBusy(false); }
  }

  async function importFile(part, file) {
    setBusy(true);
    say(`Reading ${cleanSampleName(file.name)}.`);
    try {
      const fit = await decodeStereo(await file.arrayBuffer());
      commitSample(part, fit, file.name);
    } catch (err) {
      say(errorText(err, 'That file could not be read.'));
    } finally { setBusy(false); }
  }

  async function grabLoop(part) {
    setBusy(true);
    say('Reading the loop.');
    try {
      const looper = ctx.engine && ctx.engine.looper;
      if (!looper || typeof looper.getLoop !== 'function') {
        say('The looper is not available.');
        return;
      }
      const loop = await looper.getLoop();
      const fit = loopToSample(loop);
      if (!fit) { say('There is no loop to grab.'); return; }
      commitSample(part, fit, 'Loop');
    } catch {
      say('The loop could not be read.');
    } finally { setBusy(false); }
  }

  async function recordOutput(part) {
    const looper = ctx.engine && ctx.engine.looper;
    if (!looper || typeof looper.capture !== 'function') { say('The looper is not available.'); return; }
    const secs = recordSecs;
    const sr = (typeof looper.status === 'function' && looper.status().sampleRate) || SAMPLER_RATE;
    setBusy(true);
    say('Recording output, 0%.');
    let off = () => {};
    try {
      if (typeof looper.on === 'function') {
        off = looper.on('pos', (s) => {
          if (s && typeof s.capture === 'number' && s.capture >= 0) say(`Recording output, ${Math.round(s.capture * 100)}%.`);
        }) || (() => {});
      }
      const audio = await looper.capture({ frames: Math.max(1, Math.round(secs * sr)) });
      const fit = loopToSample(audio);
      if (!fit) { say('Nothing was recorded.'); return; }
      commitSample(part, fit, 'Output');
    } catch {
      say('The output could not be recorded.');
    } finally {
      if (typeof off === 'function') off();
      setBusy(false);
    }
  }

  scope.on(actionBtn, 'click', () => {
    if (busy) return;
    const part = sel();
    if (take === 'mic') recordMicTake(part);
    else if (take === 'file') fileIn.click();
    else if (take === 'loop') grabLoop(part);
    else recordOutput(part);
  });
  scope.on(fileIn, 'change', () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f || busy) return;
    importFile(sel(), f);
  });

  const nameEl = h('span', { class: 'sampler-name' });
  const chip = h('span', { class: 'sampler-chip', hidden: true });
  const emptyHint = h('p', { class: 'sampler-empty' }, 'No sample yet. Choose Mic, File, Loop or Output.');
  const canvas = h('canvas', {
    class: 'sampler-wave',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Sample waveform. Drag the edges to set the region.',
  });
  let pcm = null;
  let pcmR = null;
  let pcmRate = SAMPLER_RATE;
  let pcmKey = '';
  let peakCache = null;
  let lastMark = -1;
  const startB = binder.partParam('smpStart');
  const endB = binder.partParam('smpEnd');

  function currentSlices() {
    const s = sanitizeSampler(store.get(samplerPath()));
    return s && s.slices ? s.slices.slice() : [];
  }
  function inSlices() {
    const s = sanitizeSampler(store.get(samplerPath()));
    return !!(pcm && s && s.mode === 3);
  }
  function writeSlices(frames) {
    const cur = store.get(samplerPath());
    const base = (cur && typeof cur === 'object') ? { ...cur } : defaultSampler();
    if (!frames || !frames.length) delete base.slices;
    else base.slices = frames;
    const next = sanitizeSampler(base);
    if (next) store.set(samplerPath(), next, { source: 'ui' });
  }

  function cssColor(name, fallback) {
    try {
      const v = getComputedStyle(canvas).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  }

  function drawBand(g, peaks, top, bandH, w) {
    const mid = top + bandH / 2;
    const amp = bandH * 0.46;
    const cols = peaks.min.length;
    const colW = w / cols;
    for (let i = 0; i < cols; i++) {
      const y0 = mid - peaks.max[i] * amp;
      const y1 = mid - peaks.min[i] * amp;
      const x = Math.round(i * colW);
      const bw = Math.max(1, Math.round(colW));
      g.fillRect(x, Math.round(Math.min(y0, y1)), bw, Math.max(1, Math.round(Math.abs(y1 - y0))));
    }
  }

  function draw() {
    if (!alive || !pcm || !pcm.length || canvas.hidden) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight || 84;
    if (!cssW) return;
    const dpr = pixelRatioOf();
    const w = Math.max(1, Math.round(cssW * dpr));
    const hgt = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
    const g = canvas.getContext('2d');
    if (!g) return;
    const cols = Math.max(1, Math.round(cssW));
    if (!peakCache || peakCache.cols !== cols || peakCache.key !== pcmKey) {
      const leftPeaks = waveformPeaks(pcm, cols);
      const rightPeaks = pcmR ? waveformPeaks(pcmR, cols) : leftPeaks;
      peakCache = { key: pcmKey, cols, leftPeaks, rightPeaks };
    }
    const { leftPeaks, rightPeaks } = peakCache;
    const start = startB.get();
    const end = endB.get();
    const lo = Math.min(Math.max(0, start), Math.max(0, end));
    const hi = Math.max(Math.min(1, start), Math.min(1, end));
    g.clearRect(0, 0, w, hgt);
    g.fillStyle = cssColor('--part-soft', 'rgba(80, 160, 150, 0.18)');
    g.fillRect(Math.round(lo * w), 0, Math.max(1, Math.round((hi - lo) * w)), hgt);
    const gap = Math.max(1, Math.round(dpr));
    const bandH = Math.max(1, Math.floor((hgt - gap) / 2));
    g.fillStyle = cssColor('--part', '#3aa89a');
    drawBand(g, leftPeaks, 0, bandH, w);
    drawBand(g, rightPeaks, bandH + gap, Math.max(1, hgt - bandH - gap), w);
    g.fillStyle = cssColor('--text', '#e8e8e8');
    const handleW = Math.max(1, Math.round(dpr));
    for (const t of [start, end]) {
      const x = Math.round(Math.min(1, Math.max(0, t)) * w);
      g.fillRect(Math.min(w - handleW, Math.max(0, x - (handleW >> 1))), 0, handleW, hgt);
    }
    const s = sanitizeSampler(store.get(samplerPath()));
    if (s && s.mode === 3 && s.slices && pcm.length) {
      g.fillStyle = cssColor('--accent', '#e8e8e8');
      const tickH = Math.max(2, Math.round(3 * dpr));
      const tickW = Math.max(handleW * 5, Math.round(6 * dpr));
      for (const frame of s.slices) {
        const x = Math.round(Math.min(1, Math.max(0, frame / pcm.length)) * w);
        const cx = Math.min(w - handleW, Math.max(0, x));
        g.fillRect(cx, 0, handleW, hgt);
        g.fillRect(Math.min(w - tickW, Math.max(0, cx - ((tickW - handleW) >> 1))), 0, tickW, tickH);
      }
    }
  }

  let drag = null;
  function pointerBox(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, width: r.width || 1 };
  }
  function clearHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
  }
  scope.on(canvas, 'pointerdown', (e) => {
    if (!pcm || (e.pointerType === 'mouse' && e.button !== 0)) return;
    clearHold();
    const box = pointerBox(e);
    const slop = e.pointerType === 'mouse' ? SLICE_HIT_PX : SLICE_HIT_COARSE;
    const mark = inSlices() ? pickSliceMark(box.x, box.width, currentSlices(), pcm.length, slop) : -1;
    if (mark >= 0) {
      lastMark = mark;
      drag = { id: e.pointerId, kind: 'slice', index: mark, moved: false, x: box.x };
      holdTimer = setTimeout(() => {
        if (!drag || drag.kind !== 'slice' || drag.moved) return;
        const idx = drag.index;
        drag = null;
        const next = deleteSliceMark(idx, currentSlices());
        lastMark = -1;
        writeSlices(next);
        say(next.length ? `${next.length} slices.` : 'Slices cleared.');
      }, 400);
    } else {
      drag = {
        id: e.pointerId,
        kind: 'region',
        which: pickRegionHandle(box.x, box.width, startB.get(), endB.get()),
        moved: false,
        x: box.x,
      };
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    canvas.focus({ preventScroll: true });
  });
  scope.on(canvas, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || !pcm) return;
    const box = pointerBox(e);
    if (Math.abs(box.x - drag.x) > 3) {
      drag.moved = true;
      clearHold();
    }
    if (!drag.moved) return;
    const norm = Math.min(1, Math.max(0, box.x / box.width));
    if (drag.kind === 'slice') {
      writeSlices(moveSliceMark(drag.index, norm * pcm.length, currentSlices(), pcm.length));
    } else {
      const curS = startB.get();
      const curE = endB.get();
      const next = moveRegionHandle(drag.which, norm, curS, curE);
      if (next.start !== curS) startB.set(next.start);
      if (next.end !== curE) endB.set(next.end);
    }
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    clearHold();
    if (drag.kind === 'slice' && drag.moved && pcm && !(e && e.altKey)) {
      const cur = currentSlices();
      const frame = cur[drag.index];
      if (frame != null) {
        const snapped = nearestZeroCross(pcm, pcmR, frame, pcmRate);
        writeSlices(moveSliceMark(drag.index, snapped, cur, pcm.length));
      }
    }
    drag = null;
  };
  scope.on(canvas, 'pointerup', endDrag);
  scope.on(canvas, 'pointercancel', endDrag);
  scope.on(canvas, 'dblclick', (e) => {
    if (!inSlices()) return;
    const box = pointerBox(e);
    if (pickSliceMark(box.x, box.width, currentSlices(), pcm.length, SLICE_HIT_PX) >= 0) return;
    const norm = Math.min(1, Math.max(0, box.x / box.width));
    let frame = norm * pcm.length;
    if (!e.altKey) frame = nearestZeroCross(pcm, pcmR, frame, pcmRate);
    const res = addSliceMark(frame, currentSlices(), pcm.length);
    if (!res.added && res.reason === 'limit') { say('32 slices is the limit.'); return; }
    if (!res.added && res.reason === 'gap') { say('That slice is too close to another.'); return; }
    if (res.added) {
      lastMark = typeof res.index === 'number' ? res.index : -1;
      writeSlices(res.slices);
      say(`${res.slices.length} slices.`);
    }
  });
  scope.on(canvas, 'contextmenu', (e) => {
    if (!inSlices()) return;
    e.preventDefault();
    const box = pointerBox(e);
    const mark = pickSliceMark(box.x, box.width, currentSlices(), pcm.length, SLICE_HIT_COARSE);
    if (mark < 0) return;
    const next = deleteSliceMark(mark, currentSlices());
    if (lastMark === mark) lastMark = -1;
    writeSlices(next);
    say(next.length ? `${next.length} slices.` : 'Slices cleared.');
  });
  scope.on(canvas, 'keydown', (e) => {
    if (!inSlices() || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    if (lastMark < 0) return;
    e.preventDefault();
    const next = deleteSliceMark(lastMark, currentSlices());
    lastMark = -1;
    writeSlices(next);
    say(next.length ? `${next.length} slices.` : 'Slices cleared.');
  });
  const watched = watchSize(canvas, () => schedule(draw));
  scope.add(watched.dispose);
  scope.add(startB.subscribe(() => schedule(draw)));
  scope.add(endB.subscribe(() => schedule(draw)));

  const modeSeg = createSegmented(ctx, fieldBinding('mode', FIELDS.mode), { label: 'Playback', size: 'sm' });
  const dirSeg = createSegmented(ctx, fieldBinding('dir', FIELDS.dir), { label: 'Direction', size: 'sm' });
  const loopToggle = createToggle(ctx, fieldBinding('loop', FIELDS.loop), { label: 'Loop', className: 'toggle--sm' });
  const sustainToggle = createToggle(ctx, fieldBinding('sustain', FIELDS.sustain), { label: 'Sustain', className: 'toggle--sm' });
  const rootStep = createStepper(ctx, fieldBinding('root', FIELDS.root), { label: 'Root note', format: (v) => midiNoteName(v) });
  for (const c of [modeSeg, dirSeg, loopToggle, sustainToggle, rootStep]) scope.add(c.dispose);

  const knob = (binding, opts = {}) => {
    const k = createKnob(ctx, binding, { size: 'sm', ...opts });
    scope.add(k.dispose);
    return k.el;
  };
  const fineEl = knob(fieldBinding('fine', FIELDS.fine), { format: (v) => `${Math.round(v)} ct` });
  const attackEl = knob(fieldBinding('attack', FIELDS.attack));
  const decayEl = knob(fieldBinding('decay', FIELDS.decay));
  const levelEl = knob(fieldBinding('level', FIELDS.level));
  const speedEl = knob(binder.partParam('smpSpeed'));
  const posEl = knob(binder.partParam('smpPos'));

  const grainBox = h('div', { class: 'sampler-grain' },
    h('span', { class: 'mini-label' }, 'Grains'),
    h('div', { class: 'knob-row' },
      posEl,
      knob(fieldBinding('size', GRAIN.size, true)),
      knob(fieldBinding('density', GRAIN.density, true), { format: (v) => `${Math.round(v)} /s` }),
      knob(fieldBinding('spread', GRAIN.spread, true)),
      knob(fieldBinding('jitter', GRAIN.jitter, true), { format: (v) => `${v.toFixed(1)} st` }),
      knob(fieldBinding('rev', GRAIN.rev, true))));

  const evenListeners = new Set();
  const evenBinding = {
    def: { id: 'samplerEven', label: 'Equal slices', default: '' },
    get() {
      if (!pcm) return '';
      const sl = currentSlices();
      for (const n of EVEN) {
        const want = evenSliceMarks(n, pcm.length);
        if (want.length === sl.length && want.every((f, i) => f === sl[i])) return n;
      }
      return '';
    },
    set(v) {
      const n = EVEN.includes(v) ? v : 0;
      if (!n || !pcm) return;
      const frames = evenSliceMarks(n, pcm.length);
      writeSlices(frames);
      say(`${frames.length} even slices.`);
      for (const fn of evenListeners) fn();
    },
    subscribe(fn) { evenListeners.add(fn); return () => evenListeners.delete(fn); },
  };
  const evenSeg = createSegmented(ctx, evenBinding, {
    label: 'Equal slices',
    size: 'sm',
    options: EVEN.map((n) => ({ value: n, label: String(n), aria: `${n} equal slices` })),
  });
  scope.add(evenSeg.dispose);
  scope.add(subscribeSampler(() => { for (const fn of evenListeners) fn(); }));

  const findBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Find transients');
  scope.on(findBtn, 'click', () => {
    if (busy || !pcm) { say('Load a sample before slicing.'); return; }
    const audio = pcmR ? mixToMono(pcm, pcmR) : pcm;
    const cuts = sliceTransients(audio, pcmRate, MAX_SLICES);
    const frames = [];
    for (const c of cuts) {
      const f = Math.round(c.start);
      if (!frames.length || f > frames[frames.length - 1]) frames.push(f);
    }
    const kept = sanitizeSampler({ slices: frames });
    const n = kept && kept.slices ? kept.slices.length : 0;
    if (!n) { say('No transients found.'); return; }
    writeSlices(kept.slices);
    say(n === 1 ? '1 slice.' : `${n} slices.`);
  });

  const sliceRow = h('div', { class: 'sampler-slice' }, evenSeg.el, findBtn);

  const body = h('div', { class: 'sampler-body' },
    h('div', { class: 'sampler-wave-wrap' }, h('div', { class: 'sampler-id' }, nameEl, chip), emptyHint, canvas),
    h('div', { class: 'sampler-actions' }, takeSeg.el, recordSeg.el, actionBtn, fileIn),
    status,
    sliceRow,
    h('div', { class: 'sampler-modes' },
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Playback'), modeSeg.el),
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Direction'), dirSeg.el)),
    h('div', { class: 'sampler-row' },
      loopToggle.el,
      sustainToggle.el,
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Root'), rootStep.el),
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Fine'), fineEl)),
    h('div', { class: 'knob-row' }, levelEl, speedEl, attackEl, decayEl),
    grainBox);

  function sync() {
    if (!alive) return;
    const s = sanitizeSampler(store.get(samplerPath())) || defaultSampler();
    const on = !!s.on;
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggle.classList.toggle('is-on', on);
    body.hidden = !on;
    grainBox.hidden = s.mode !== 4;
    sliceRow.hidden = s.mode !== 3;
    const right = s.sample && s.sample.right ? s.sample.right : '';
    const key = s.sample ? s.sample.data + (right ? '\n' + right : '') : '';
    if (key !== pcmKey) {
      pcmKey = key;
      lastMark = -1;
      try {
        pcm = s.sample ? base64ToPcm(s.sample.data) : null;
        pcmR = right ? base64ToPcm(right) : null;
        if (pcmR && pcm && pcmR.length !== pcm.length) pcmR = null;
      } catch { pcm = null; pcmR = null; }
      pcmRate = s.sample ? s.sample.rate : SAMPLER_RATE;
      peakCache = null;
    }
    canvas.hidden = !pcm;
    emptyHint.hidden = !!pcm;
    setText(nameEl, s.sample ? (s.name || 'Sample') : '');
    const stereo = !!(pcm && pcmR);
    chip.hidden = !pcm;
    setText(chip, stereo ? 'Stereo' : 'Mono');
    canvas.setAttribute('aria-label', s.mode === 3
      ? 'Sample waveform. Drag a slice mark to move it. Double-click empty space to add one. Right-click or hold to remove one. Drag the edges to set the region.'
      : 'Sample waveform. Drag the edges to set the region.');
    refreshAction();
    for (const fn of evenListeners) fn();
    draw();
  }
  scope.add(subscribeSampler(() => schedule(sync)));
  sync();

  const el = h('section', { class: 'dock-card dock-card--sampler', 'aria-labelledby': 'sec-sampler' },
    h('header', { class: 'section-head' },
      h('h3', { class: 'section-title', id: 'sec-sampler' }, 'Sampler'),
      h('div', { class: 'sampler-head-actions' }, tuneBtn, toggle)),
    tuneBox,
    body);

  return {
    el,
    dispose() {
      alive = false;
      drag = null;
      clearHold();
      scope.dispose();
    },
  };
}
