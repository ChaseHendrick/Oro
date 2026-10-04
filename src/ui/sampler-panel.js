// Sampler card (2.13): one sample per track, played across the keyboard.
// The card is a normal dock section. Record, import, or grab the looper,
// then trim the region on the waveform. Grain controls show only in Granular.
// Drum kit and sampler stay mutually exclusive: the kit wins in the engine
// if both are on, and each toggle turns the other off.

import { h, createScope, setText, watchSize, pixelRatioOf } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createSegmented, createToggle, createStepper } from './controls.js';
import { recordMic, decodeMono } from './drum-panel.js';
import {
  SAMPLER_MODES, SAMPLER_DIRS, SAMPLER_RATE, defaultSampler, sanitizeSampler,
} from '../dsp/sampler.js';
import { pcmToBase64, base64ToPcm, sliceTransients } from '../dsp/drum-kit.js';
import {
  midiNoteName, fitSample, loopToSample, waveformPeaks, pickRegionHandle, moveRegionHandle, cleanSampleName,
} from './sampler-model.js';

// recordMic / decodeMono return mono audio at the drum slice rate, which is
// the sampler rate (48 kHz).
const DECODE_RATE = SAMPLER_RATE;
const RECORD_LENGTHS = [2, 4, 8, 16];
const SLICE_CAP = 32;

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

export function createSamplerPanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const sel = () => binder.selected();
  const samplerPath = () => `parts.${sel()}.sampler`;
  let alive = true;
  let busy = false;

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

  const recordBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Record 4 s');
  const importBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Import');
  const grabBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Grab loop');
  const fileIn = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  scope.add(recordBinding.subscribe(() => setText(recordBtn, `Record ${recordBinding.get()} s`)));

  function setBusy(on) {
    busy = on;
    if (!alive) return;
    recordBtn.disabled = importBtn.disabled = grabBtn.disabled = on;
  }

  function commitSample(part, fit, name) {
    if (!fit || !fit.data || !fit.data.length) { say('That sample was empty.'); return; }
    let data;
    try { data = pcmToBase64(fit.data); }
    catch { say('That sample could not be stored.'); return; }
    const path = `parts.${part}.sampler`;
    const cur = store.get(path);
    const base = (cur && typeof cur === 'object') ? cur : defaultSampler();
    const rest = { ...base };
    delete rest.slices;
    const next = sanitizeSampler({
      ...rest,
      on: base.on ? 1 : 0,
      name: cleanSampleName(name),
      sample: { rate: fit.rate, data },
    });
    if (!next || !next.sample) { say('That sample is too long to store.'); return; }
    store.set(path, next, { source: 'ui' });
    const secs = (fit.data.length / fit.rate).toFixed(1);
    const label = next.name || 'Sample';
    say(fit.trimmed ? `Stored ${label} (${secs} s). The rest was cut to fit.` : `Stored ${label} (${secs} s).`);
  }

  scope.on(recordBtn, 'click', async () => {
    if (busy) return;
    const part = sel();
    const secs = recordSecs;
    setBusy(true);
    say(`Recording... 0%.`);
    try {
      const audio = await recordMic(secs, (p) => say(`Recording... ${Math.round(p * 100)}%.`));
      commitSample(part, fitSample(audio, DECODE_RATE), 'Recording');
    } catch (err) {
      say(errorText(err, 'Recording failed.'));
    } finally { setBusy(false); }
  });

  scope.on(importBtn, 'click', () => fileIn.click());
  scope.on(fileIn, 'change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f || busy) return;
    const part = sel();
    setBusy(true);
    say(`Reading ${cleanSampleName(f.name)}...`);
    try {
      const audio = await decodeMono(await f.arrayBuffer());
      commitSample(part, fitSample(audio, DECODE_RATE), f.name);
    } catch (err) {
      say(errorText(err, 'That file could not be read.'));
    } finally { setBusy(false); }
  });

  scope.on(grabBtn, 'click', async () => {
    if (busy) return;
    const part = sel();
    setBusy(true);
    say('Reading the loop...');
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
  });

  const nameEl = h('span', { class: 'sampler-name' });
  const emptyHint = h('p', { class: 'sampler-empty' }, 'No sample yet. Record, import a file, or grab the loop.');
  const canvas = h('canvas', {
    class: 'sampler-wave',
    role: 'group',
    'aria-label': 'Sample waveform. Drag to move the start and end of the region.',
  });
  let pcm = null;
  let pcmKey = '';
  let peakCache = null;
  const startB = binder.partParam('smpStart');
  const endB = binder.partParam('smpEnd');

  function peaksFor(cols) {
    if (peakCache && peakCache.key === pcmKey && peakCache.cols === cols) return peakCache.peaks;
    const peaks = waveformPeaks(pcm, cols);
    peakCache = { key: pcmKey, cols, peaks };
    return peaks;
  }

  function cssColor(name, fallback) {
    try {
      const v = getComputedStyle(canvas).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
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
    const peaks = peaksFor(Math.max(1, Math.round(cssW)));
    const start = startB.get();
    const end = endB.get();
    const lo = Math.min(Math.max(0, start), Math.max(0, end));
    const hi = Math.max(Math.min(1, start), Math.min(1, end));
    g.clearRect(0, 0, w, hgt);
    g.fillStyle = cssColor('--part-soft', 'rgba(80, 160, 150, 0.18)');
    g.fillRect(Math.round(lo * w), 0, Math.max(1, Math.round((hi - lo) * w)), hgt);
    const mid = hgt / 2;
    const amp = mid * 0.92;
    g.strokeStyle = cssColor('--scope-grid', 'rgba(128, 128, 128, 0.35)');
    g.lineWidth = Math.max(1, dpr);
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();
    g.fillStyle = cssColor('--part', '#3aa89a');
    const cols = peaks.min.length;
    const colW = w / cols;
    for (let i = 0; i < cols; i++) {
      const y0 = mid - peaks.max[i] * amp;
      const y1 = mid - peaks.min[i] * amp;
      const x = Math.round(i * colW);
      const bw = Math.max(1, Math.round(colW) - (dpr > 1.5 ? 1 : 0));
      g.fillRect(x, Math.round(Math.min(y0, y1)), bw, Math.max(1, Math.round(Math.abs(y1 - y0))));
    }
    g.fillStyle = cssColor('--text', '#e8e8e8');
    const handleW = Math.max(1, Math.round(dpr));
    for (const t of [start, end]) {
      const x = Math.round(Math.min(1, Math.max(0, t)) * w);
      g.fillRect(Math.min(w - handleW, Math.max(0, x - (handleW >> 1))), 0, handleW, hgt);
    }
  }

  let drag = null;
  function pointerBox(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, width: r.width || 1 };
  }
  scope.on(canvas, 'pointerdown', (e) => {
    if (!pcm || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const box = pointerBox(e);
    drag = {
      id: e.pointerId,
      which: pickRegionHandle(box.x, box.width, startB.get(), endB.get()),
    };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  scope.on(canvas, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const box = pointerBox(e);
    const norm = Math.min(1, Math.max(0, box.x / box.width));
    const curS = startB.get();
    const curE = endB.get();
    const next = moveRegionHandle(drag.which, norm, curS, curE);
    if (next.start !== curS) startB.set(next.start);
    if (next.end !== curE) endB.set(next.end);
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
  };
  scope.on(canvas, 'pointerup', endDrag);
  scope.on(canvas, 'pointercancel', endDrag);
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
  const startEl = knob(startB);
  const endEl = knob(endB);
  const posEl = knob(binder.partParam('smpPos'));

  const grainBox = h('div', { class: 'sampler-grain' },
    h('span', { class: 'mini-label' }, 'Grains'),
    h('div', { class: 'knob-row' },
      knob(fieldBinding('size', GRAIN.size, true)),
      knob(fieldBinding('density', GRAIN.density, true), { format: (v) => `${Math.round(v)} /s` }),
      knob(fieldBinding('spread', GRAIN.spread, true)),
      knob(fieldBinding('jitter', GRAIN.jitter, true), { format: (v) => `${v.toFixed(1)} st` }),
      knob(fieldBinding('rev', GRAIN.rev, true))));

  const sliceBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Slice on transients');
  const sliceNote = h('span', { class: 'sampler-note' });
  const sliceRow = h('div', { class: 'sampler-slice' }, sliceBtn, sliceNote);
  scope.on(sliceBtn, 'click', () => {
    if (busy) return;
    const cur = store.get(samplerPath());
    const s = sanitizeSampler(cur);
    if (!s || !s.sample) { say('Load a sample before slicing.'); return; }
    let audio;
    try { audio = base64ToPcm(s.sample.data); }
    catch { say('That sample could not be read.'); return; }
    const cuts = sliceTransients(audio, s.sample.rate, SLICE_CAP);
    const frames = cuts.map((c) => c.start);
    const next = sanitizeSampler({ ...cur, slices: frames });
    const n = next && next.slices ? next.slices.length : 0;
    if (!n) { say('No transients found to slice.'); return; }
    store.set(samplerPath(), next, { source: 'ui' });
    say(n === 1 ? '1 slice stored.' : `${n} slices stored.`);
  });

  const body = h('div', { class: 'sampler-body' },
    h('div', { class: 'sampler-actions' }, recordSeg.el, recordBtn, importBtn, fileIn, grabBtn, status),
    h('div', { class: 'sampler-wave-wrap' }, nameEl, emptyHint, canvas),
    h('div', { class: 'sampler-modes' },
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Playback'), modeSeg.el),
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Direction'), dirSeg.el)),
    h('div', { class: 'sampler-row' },
      loopToggle.el,
      sustainToggle.el,
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Root'), rootStep.el)),
    h('div', { class: 'knob-row' }, fineEl, attackEl, decayEl, levelEl),
    h('div', { class: 'knob-row' }, speedEl, startEl, endEl, posEl),
    grainBox,
    sliceRow);

  function sync() {
    if (!alive) return;
    const s = sanitizeSampler(store.get(samplerPath())) || defaultSampler();
    const on = !!s.on;
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggle.classList.toggle('is-on', on);
    body.hidden = !on;
    grainBox.hidden = s.mode !== 4;
    const key = s.sample ? s.sample.data : '';
    if (key !== pcmKey) {
      pcmKey = key;
      try { pcm = key ? base64ToPcm(key) : null; }
      catch { pcm = null; }
      peakCache = null;
    }
    canvas.hidden = !pcm;
    emptyHint.hidden = !!pcm;
    setText(nameEl, s.sample ? (s.name || 'Sample') : '');
    const nSlices = s.slices ? s.slices.length : 0;
    sliceRow.hidden = s.mode !== 3;
    if (s.mode === 3) {
      sliceBtn.hidden = !s.sample || nSlices > 0;
      setText(sliceNote, !s.sample
        ? 'Load a sample, then slice it on transients.'
        : nSlices
          ? `${nSlices} slice${nSlices === 1 ? '' : 's'} stored. Slice points are not edited here.`
          : 'No slices yet.');
    }
    draw();
  }
  scope.add(subscribeSampler(() => schedule(sync)));
  sync();

  const el = h('section', { class: 'dock-card dock-card--sampler', 'aria-labelledby': 'sec-sampler' },
    h('header', { class: 'section-head' },
      h('h3', { class: 'section-title', id: 'sec-sampler' }, 'Sampler'),
      toggle),
    body);

  return {
    el,
    dispose() {
      alive = false;
      drag = null;
      scope.dispose();
    },
  };
}
