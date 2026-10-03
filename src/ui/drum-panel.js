// Drum kit (v2.7): turns the track into an eight-pad kit with an eight-lane
// step grid. The default kit is synthesized; Import or Record turns any
// recording into a kit by cutting it at its transients (one hit per pad).
// v2.8: the Sound map (src/ui/sound-map-view.js) picks pad sounds from the
// drum library by ear, and two generators write lanes: a Euclidean fill for
// the selected pad and a Groove pad for the whole kit.
import { h, createScope, setText } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createStepper, createSelect } from './controls.js';
import { chunks } from './lazy.js';
import { euclidLane, grooveLanes, GROOVE_STYLES } from '../music/drum-gen.js';
import { SEQ_STEPS, patternPath } from '../core/params.js';
import { KIT_PADS, KIT_BASE_NOTE, sanitizeDrum, sanitizeLanes, sliceTransients, pcmToBase64, defaultDrum } from '../dsp/drum-kit.js';

const RECORD_SECONDS = 4;
const SLICE_RATE = 48000;
const CYCLE = [0.8, 1, 0.45, 0];

/** Decode an audio file to mono Float32 at SLICE_RATE. */
async function decodeMono(buf) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio files');
  const ab = await new Ctx(1, 1, SLICE_RATE).decodeAudioData(buf);
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels; }
  return out;
}

/** Record the microphone for `secs` seconds and decode it. */
async function recordMic(secs, onTick) {
  if (!navigator.mediaDevices || !globalThis.MediaRecorder) throw new Error('Recording is not available in this browser');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  try {
    const rec = new MediaRecorder(stream), chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start();
    for (let i = 1; i <= secs * 4; i++) { await new Promise(r => setTimeout(r, 250)); onTick?.(i / (secs * 4)); }
    rec.stop(); await done;
    return decodeMono(await new Blob(chunks, { type: rec.mimeType }).arrayBuffer());
  } finally { for (const t of stream.getTracks()) t.stop(); }
}

export function createDrumPanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const sel = () => binder.selected();
  const drum = () => sanitizeDrum(store.get(`parts.${sel()}.drum`));
  const putDrum = (d) => store.set(`parts.${sel()}.drum`, d, { source: 'ui' });
  const lanesPath = () => `${patternPath(store, sel())}.drumLanes`;
  const lanes = () => sanitizeLanes(store.get(lanesPath()), SEQ_STEPS) || Array.from({ length: KIT_PADS }, () => new Array(SEQ_STEPS).fill(0));
  let padSel = 0;

  const toggle = h('button', { type: 'button', class: 'toggle toggle--sm', 'aria-pressed': 'false' }, 'Drum kit');
  scope.on(toggle, 'click', () => { const d = drum(); d.on = d.on ? 0 : 1; putDrum(d); });
  const status = h('span', { class: 'popover-note', 'aria-live': 'polite' });
  const fileIn = h('input', { type: 'file', accept: 'audio/*', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const importBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Import & slice');
  const recordBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, `Record ${RECORD_SECONDS} s & slice`);
  const synthBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Synth kit');
  const mapBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-haspopup': 'dialog' }, 'Sound map');
  scope.on(mapBtn, 'click', () => {
    chunks.soundMap.run(m => m.openSoundMap(ctx, { part: sel(), pad: padSel, onPad: (k) => { if (k !== padSel) { padSel = k; schedule(renderGrid); } } }), 'Sound map');
  });

  async function useRecording(mono, label) {
    const slices = sliceTransients(mono, SLICE_RATE, KIT_PADS);
    if (!slices.length) { setText(status, `No hits found in ${label}. Try something with clear taps or knocks.`); return; }
    const d = drum();
    slices.forEach((s, i) => { d.pads[i] = { ...d.pads[i], name: `${label} ${i + 1}`, synth: -1, sample: { rate: SLICE_RATE, data: pcmToBase64(s.data) }, choke: 0 }; });
    d.on = 1;
    putDrum(d);
    setText(status, `${slices.length} hit${slices.length === 1 ? '' : 's'} from ${label} on pads 1 to ${slices.length}.`);
  }
  scope.on(importBtn, 'click', () => fileIn.click());
  scope.on(fileIn, 'change', async () => {
    const f = fileIn.files && fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    setText(status, `Slicing ${f.name}…`);
    try { await useRecording(await decodeMono(await f.arrayBuffer()), f.name.replace(/\.[^.]+$/, '').slice(0, 14) || 'Import'); }
    catch (err) { setText(status, err.message || 'That file could not be read.'); }
  });
  scope.on(recordBtn, 'click', async () => {
    recordBtn.disabled = true;
    try { await useRecording(await recordMic(RECORD_SECONDS, (p) => setText(status, `Recording… ${Math.round(p * 100)}%. Tap, knock, click.`)), 'Rec'); }
    catch (err) { setText(status, err.name === 'NotAllowedError' ? 'Microphone access was refused.' : (err.message || 'Recording failed.')); }
    finally { recordBtn.disabled = false; }
  });
  scope.on(synthBtn, 'click', () => { const d = defaultDrum(); d.on = 1; putDrum(d); setText(status, 'The synthesized kit is back on all pads.'); });

  // ---- grid
  const gridEl = h('div', { class: 'drum-grid', role: 'grid', 'aria-label': 'Drum lanes: click a cell to add a hit, click again to change its velocity' });
  const padEl = h('div', { class: 'drum-pad' });
  let padScope = createScope();
  scope.add(() => padScope.dispose());

  function audition(r) {
    const router = ctx.music && ctx.music.router;
    if (router && typeof router.noteOn === 'function') { router.noteOn('sel', KIT_BASE_NOTE + r, 0.9, 'ui'); setTimeout(() => router.noteOff('sel', KIT_BASE_NOTE + r, 'ui'), 80); }
    else if (ctx.engine && typeof ctx.engine.noteOn === 'function') { ctx.engine.noteOn(sel(), KIT_BASE_NOTE + r, 0.9); setTimeout(() => ctx.engine.noteOff(sel(), KIT_BASE_NOTE + r), 80); }
  }

  function renderGrid(withPad = true) {
    const d = drum(), L = lanes();
    const len = Math.max(1, Math.min(SEQ_STEPS, Number(store.get(`${patternPath(store, sel())}.length`)) || 16));
    toggle.setAttribute('aria-pressed', String(!!d.on)); toggle.classList.toggle('is-on', !!d.on);
    gridEl.hidden = padEl.hidden = genEl.hidden = mapBtn.hidden = !d.on;
    gridEl.replaceChildren(...d.pads.map((pad, r) => {
      const name = h('button', { type: 'button', class: ['drum-name', r === padSel && 'is-sel'], 'aria-label': `Pad ${r + 1}: ${pad.name}. Click to hear it and edit it` }, pad.name);
      name.addEventListener('click', () => { padSel = r; audition(r); renderGrid(); });
      const cells = Array.from({ length: len }, (_, c) => {
        const v = L[r][c];
        const b = h('button', { type: 'button', class: ['drum-cell', c % 4 === 0 && 'is-beat', v > 0 && 'is-on'], 'aria-label': `${pad.name}, step ${c + 1}: ${v > 0 ? Math.round(v * 100) + '%' : 'off'}`, style: { '--v': String(v) } });
        b.addEventListener('click', () => {
          const next = lanes(); const cur = next[r][c];
          next[r][c] = cur === 0 ? CYCLE[0] : CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length] ?? 0;
          store.set(lanesPath(), sanitizeLanes(next, SEQ_STEPS), { source: 'ui' });
        });
        return b;
      });
      return h('div', { class: 'drum-row', role: 'row' }, name, ...cells);
    }));
    if (withPad) renderPad(d);
    refreshGen();
  }

  function renderPad(d) {
    padScope.dispose(); padScope = createScope();
    const i = padSel, pad = d.pads[i];
    const knob = (key, def) => { const k = createKnob(ctx, binder.path(`drum.pads.${i}.${key}`, { id: `pad${key}`, ...def }), { size: 'sm' }); padScope.add(k.dispose); return k.el; };
    padEl.replaceChildren(
      h('div', { class: 'mini-label' }, `Pad ${i + 1}: ${pad.name}${pad.synth >= 0 ? ' (synth)' : ' (sample)'}`),
      h('div', { class: 'knob-row' },
        knob('pitch', { label: 'Pitch', curve: 'int', min: -24, max: 24, default: 0, unit: 'st' }),
        knob('decay', { label: 'Decay', curve: 'lin', min: 0.02, max: 1, default: 1 }),
        knob('level', { label: 'Level', curve: 'lin', min: 0, max: 1, default: 0.8 }),
        knob('pan', { label: 'Pan', curve: 'lin', min: -1, max: 1, default: 0 }),
        knob('choke', { label: 'Choke', curve: 'int', min: 0, max: 4, default: 0, hint: 'Pads in the same choke group cut each other off (0 = none), like open and closed hats' })));
  }

  // ---- generators (v2.8)
  const patLen = () => Math.max(1, Math.min(SEQ_STEPS, Number(store.get(`${patternPath(store, sel())}.length`)) || 16));
  const putLanes = (L) => store.set(lanesPath(), sanitizeLanes(L, SEQ_STEPS), { source: 'ui' });
  function localBinding(def, get, set) {
    const subs = new Set();
    return { def, get, set, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }, notify() { for (const fn of subs) fn(); } };
  }
  // Euclid: hits and rotation per lane (kept while the panel lives); a lane
  // never set here shows its current number of hits
  const euState = new Map();
  const euKey = () => `${lanesPath()}:${padSel}`;
  const euGet = () => euState.get(euKey()) || { hits: lanes()[padSel].slice(0, patLen()).filter(v => v > 0).length, rot: 0 };
  function euPut(next) {
    const len = patLen(), e = { hits: Math.max(0, Math.min(len, next.hits)), rot: ((next.rot % len) + len) % len };
    euState.set(euKey(), e);
    putLanes(euclidLane(lanes(), padSel, e.hits, e.rot, len));
  }
  const hitsB = localBinding({ id: 'euHits', label: 'Hits', min: 0, max: SEQ_STEPS }, () => Math.min(euGet().hits, patLen()), (v) => euPut({ ...euGet(), hits: v }));
  const rotB = localBinding({ id: 'euRot', label: 'Rotate', min: 0, max: SEQ_STEPS - 1 }, () => euGet().rot, (v) => euPut({ ...euGet(), rot: v }));
  const hitsSt = createStepper(ctx, hitsB, { label: 'Euclidean hits', format: v => String(v) });
  const rotSt = createStepper(ctx, rotB, { label: 'Euclidean rotation', format: v => String(v) });
  scope.add(hitsSt.dispose); scope.add(rotSt.dispose);
  const euLabel = h('span', { class: 'mini-label' }, 'Euclid, pad 1');
  const euEl = h('div', { class: 'drum-gen-group', role: 'group', 'aria-label': 'Euclidean rhythm for the selected pad' }, euLabel,
    h('div', { class: 'drum-gen-row' },
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Hits'), hitsSt.el),
      h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Rotate'), rotSt.el)));

  // Groove pad: complexity left to right, loudness bottom to top
  const groove = { style: 'straight', complexity: 0.4, loudness: 0.7, fill: false, seed: 0 };
  const writeGroove = () => putLanes(grooveLanes({ ...groove, length: patLen() }));
  const styleB = localBinding({ id: 'grooveStyle', label: 'Groove style' }, () => groove.style, (v) => { groove.style = v; styleB.notify(); writeGroove(); });
  const styleSel = createSelect(ctx, styleB, { label: 'Groove style', options: GROOVE_STYLES.map(s => ({ value: s.id, label: s.label })) });
  scope.add(styleSel.dispose);
  const xyDot = h('span', { class: 'groove-dot', 'aria-hidden': 'true' });
  const xy = h('div', { class: 'groove-xy', role: 'slider', tabindex: '0', 'aria-roledescription': '2D slider',
    'aria-label': 'Groove pad. Left and right set complexity, up and down set loudness. Moving it writes a new pattern.', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('span', { class: 'groove-axis groove-axis--x', 'aria-hidden': 'true' }, 'Complexity'),
    h('span', { class: 'groove-axis groove-axis--y', 'aria-hidden': 'true' }, 'Loudness'), xyDot);
  const fillBtn = h('button', { type: 'button', class: 'toggle toggle--sm', 'aria-pressed': 'false', title: 'End the pattern with a fill' }, 'Fill');
  const varyBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', title: 'Another pattern with the same settings' }, 'Vary');
  function showXY() {
    const c = Math.round(groove.complexity * 100), l = Math.round(groove.loudness * 100);
    xyDot.style.left = `${c}%`; xyDot.style.top = `${100 - l}%`;
    xy.setAttribute('aria-valuenow', String(c));
    xy.setAttribute('aria-valuetext', `Complexity ${c}%, loudness ${l}%`);
    fillBtn.setAttribute('aria-pressed', String(groove.fill)); fillBtn.classList.toggle('is-on', groove.fill);
  }
  let xyQueued = false;
  function moveXY(c, l) {
    groove.complexity = Math.max(0, Math.min(1, c)); groove.loudness = Math.max(0, Math.min(1, l));
    showXY();
    if (xyQueued) return;
    xyQueued = true;
    schedule(() => { xyQueued = false; writeGroove(); });
  }
  const fromPointer = (e) => { const r = xy.getBoundingClientRect(); moveXY((e.clientX - r.left) / (r.width || 1), 1 - (e.clientY - r.top) / (r.height || 1)); };
  let dragId = null;
  scope.on(xy, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); xy.focus(); dragId = e.pointerId;
    try { xy.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    fromPointer(e);
  });
  scope.on(xy, 'pointermove', (e) => { if (dragId === e.pointerId) fromPointer(e); });
  const endDrag = (e) => { if (dragId === e.pointerId) dragId = null; };
  scope.on(xy, 'pointerup', endDrag); scope.on(xy, 'pointercancel', endDrag);
  scope.on(xy, 'keydown', (e) => {
    const big = e.shiftKey || e.key.startsWith('Page') ? 0.2 : 0.05;
    const m = { ArrowRight: [big, 0], ArrowLeft: [-big, 0], ArrowUp: [0, big], ArrowDown: [0, -big], PageUp: [0, big], PageDown: [0, -big] }[e.key];
    if (m) { e.preventDefault(); e.stopPropagation(); moveXY(groove.complexity + m[0], groove.loudness + m[1]); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); writeGroove(); }
  });
  scope.on(fillBtn, 'click', () => { groove.fill = !groove.fill; showXY(); writeGroove(); });
  scope.on(varyBtn, 'click', () => { groove.seed = (groove.seed + 1) % 1000; writeGroove(); });
  showXY();
  const grooveEl = h('div', { class: 'drum-gen-group', role: 'group', 'aria-label': 'Groove pad' }, h('span', { class: 'mini-label' }, 'Groove'),
    h('div', { class: 'drum-gen-row' }, xy, h('div', { class: 'drum-gen-col' }, styleSel.el, h('div', { class: 'drum-gen-row' }, fillBtn, varyBtn))));
  const genEl = h('div', { class: 'drum-gen' }, euEl, grooveEl);
  function refreshGen() {
    setText(euLabel, `Euclid, pad ${padSel + 1}`);
    hitsB.notify(); rotB.notify();
  }

  // A pad knob edit only redraws the grid, so the knob being dragged survives.
  const gridOnly = () => renderGrid(false);
  const knobEdit = /^parts\.\d+\.drum\.pads\.\d+\.(pitch|decay|level|pan|choke)$/;
  // lane edits (cells, generators) leave the pad editor and generator controls in place
  const laneEdit = /^parts\.\d+\.patterns\.\d+\.drumLanes$/;
  // Only kit and pattern edits redraw; the moving dot writes to the track every frame.
  scope.add(store.subscribe('parts', (p) => {
    const pre = `parts.${sel()}`;
    if (p === 'parts' || p === pre) { schedule(renderGrid); return; }
    if (!p.startsWith(pre + '.') || !/^(drum|patterns|activePattern)(\.|$)/.test(p.slice(pre.length + 1))) return;
    schedule(knobEdit.test(p) || laneEdit.test(p) ? gridOnly : renderGrid);
  }));
  scope.add(store.subscribe('ui.selectedPart', () => { padSel = 0; schedule(renderGrid); }));
  scope.add(store.subscribe('', (p) => { if (p === '') schedule(renderGrid); }));
  renderGrid();

  const el = h('section', { class: 'drum-panel', 'aria-label': 'Drum kit' },
    h('div', { class: 'drum-bar' }, toggle, synthBtn, mapBtn, importBtn, recordBtn, fileIn, status),
    gridEl, padEl, genEl);
  return { el, isOn: () => !!drum().on, dispose: scope.dispose };
}
