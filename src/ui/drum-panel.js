// Drum kit (v2.7): turns the track into an eight-pad kit with an eight-lane
// step grid. The default kit is synthesized; Import or Record turns any
// recording into a kit by cutting it at its transients (one hit per pad).
import { h, createScope, setText } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
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
    gridEl.hidden = padEl.hidden = !d.on;
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
  }

  function renderPad(d) {
    padScope.dispose(); padScope = createScope();
    const i = padSel, pad = d.pads[i];
    const knob = (key, def) => { const k = createKnob(ctx, binder.path(`drum.pads.${i}.${key}`, { id: `pad${key}`, ...def }), { size: 'sm' }); padScope.add(k.dispose); return k.el; };
    padEl.replaceChildren(
      h('div', { class: 'mini-label' }, `Pad ${i + 1}: ${pad.name}${pad.synth >= 0 ? ' (synth)' : ' (sample)'}`),
      h('div', { class: 'knob-row' },
        knob('pitch', { label: 'Pitch', curve: 'lin', min: -24, max: 24, default: 0, unit: 'st' }),
        knob('decay', { label: 'Decay', curve: 'lin', min: 0.02, max: 1, default: 1 }),
        knob('level', { label: 'Level', curve: 'lin', min: 0, max: 1, default: 0.8 }),
        knob('pan', { label: 'Pan', curve: 'lin', min: -1, max: 1, default: 0 }),
        knob('choke', { label: 'Choke', curve: 'int', min: 0, max: 4, default: 0, hint: 'Pads in the same choke group cut each other off (0 = none), like open and closed hats' })));
  }

  // A pad knob edit only redraws the grid, so the knob being dragged survives.
  const gridOnly = () => renderGrid(false);
  const knobEdit = /^parts\.\d+\.drum\.pads\.\d+\.(pitch|decay|level|pan|choke)$/;
  scope.add(store.subscribe('parts', (p) => {
    if (p !== 'parts' && !new RegExp(`^parts\\.${sel()}(\\.|$)`).test(p)) return;
    schedule(knobEdit.test(p) ? gridOnly : renderGrid);
  }));
  scope.add(store.subscribe('ui.selectedPart', () => { padSel = 0; schedule(renderGrid); }));
  scope.add(store.subscribe('', (p) => { if (p === '') schedule(renderGrid); }));
  renderGrid();

  const el = h('section', { class: 'drum-panel', 'aria-label': 'Drum kit' },
    h('div', { class: 'drum-bar' }, toggle, synthBtn, importBtn, recordBtn, fileIn, status),
    gridEl, padEl);
  return { el, isOn: () => !!drum().on, dispose: scope.dispose };
}
