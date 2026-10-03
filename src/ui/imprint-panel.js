// Imprint (2.10): a sound becomes a landscape (src/audio/imprint.js). The
// popover takes an audio file (chosen or dropped) or a short recording through
// the voice input, then writes it into terrain A or B of the selected track as
// one undo step.
import { h, setText } from './dom.js';
import { openPopover } from './layers.js';
import { analyseImprint, imprintTerrain, MAX_RINGS } from '../audio/imprint.js';
import { addUserTerrain, audioSource, MAX_IMPORT_BYTES } from '../audio/importers.js';

const MAX_SECONDS = 10;
const RECORD_SECONDS = 3;

/** File -> mono samples (at most MAX_SECONDS) and its rate. */
async function decodeFile(file) {
  if (!file || !(file.size > 0)) throw new Error('That file is empty');
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Files up to 25 MB can be used');
  const src = await audioSource(await file.arrayBuffer());
  const n = Math.min(src.length, Math.round(MAX_SECONDS * src.sampleRate));
  const samples = Float32Array.from(src.read(0, n));
  return { samples, sampleRate: src.sampleRate };
}

export function openImprint(ctx, anchor, slot) {
  const part = ctx.binder.selected();
  let source = null;   // { samples, sampleRate, label }
  let busy = false;

  const status = h('p', { class: 'imprint-status', role: 'status', 'aria-live': 'polite' }, 'Choose or drop an audio file of one held note, or record one.');
  const fileInput = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg,.m4a', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const choose = h('button', { type: 'button', class: 'btn btn--sm' }, 'Choose file');
  const record = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, `Record ${RECORD_SECONDS} s`);
  const srcName = h('span', { class: 'imprint-src' }, 'No sound yet');
  const drop = h('div', { class: 'imprint-drop' }, h('div', { class: 'imprint-row', style: { justifyContent: 'center' } }, choose, record), srcName, fileInput);

  const radio = (value, label, checked) => h('label', { class: 'imprint-field' },
    h('input', { type: 'radio', name: `imprint-mode-${slot}`, value, checked }), h('span', null, label));
  const single = radio('single', 'Single: one cycle along the path', true);
  const time = radio('time', `Time: up to ${MAX_RINGS} cycles on rings, Size moves through the sound`, false);
  const modeSet = h('fieldset', { class: 'imprint-pop', style: { border: '0', padding: '0', margin: '0', gap: '4px' } },
    h('legend', { class: 'mini-label' }, 'Mode'), single, time);

  const strength = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '60', 'aria-label': 'Imprint strength' });
  const strengthOut = h('output', null, '60%');
  strength.addEventListener('input', () => setText(strengthOut, `${strength.value}%`));
  const strengthRow = h('label', { class: 'imprint-field', dataset: { tip: 'How much of the land the imprint takes over. The path itself always carries the sound; 0 keeps the old land everywhere else, 100% grows smooth land from the imprint' } },
    h('span', null, 'Strength'), strength, strengthOut);

  const go = h('button', { type: 'button', class: 'btn btn--sm btn--primary', disabled: true }, `Imprint into ${slot}`);
  const body = h('div', { class: 'imprint-pop' },
    h('div', { class: 'popover-title' }, `Imprint into terrain ${slot}`),
    h('p', { class: 'popover-note' }, 'Writes one cycle of a sound along the dot\'s current path, so this track plays it back at any note; the rest of the land blends in smoothly. Works best with Laps 1, Direction Forward and Morph at this side.'),
    drop, modeSet, strengthRow, h('div', { class: 'import-actions' }, go), status);

  function setSource(s) {
    source = s;
    setText(srcName, s ? s.label : 'No sound yet');
    go.disabled = !s || busy;
    if (s) setText(status, `Ready: ${(s.samples.length / s.sampleRate).toFixed(1)} s of sound.`);
  }

  async function useFile(file) {
    if (!file || busy) return;
    setText(status, 'Reading the file...');
    try {
      const d = await decodeFile(file);
      setSource({ ...d, label: `"${String(file.name || 'Audio').slice(0, 60)}"` });
    } catch (err) {
      setSource(null);
      setText(status, err.message || 'That file could not be read.');
    }
  }
  choose.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; useFile(f); });
  drop.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('is-drop'); } });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-drop'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-drop'); useFile(e.dataTransfer && e.dataTransfer.files[0]); });

  record.addEventListener('click', async () => {
    const voice = ctx.engine && ctx.engine.voice;
    if (!voice) { setText(status, 'Recording uses the voice input, which is not available here. Choose a file instead.'); return; }
    if (busy) return;
    busy = true; record.disabled = true; go.disabled = true;
    setText(status, `Recording for ${RECORD_SECONDS} seconds: hold one note...`);
    try {
      const r = await voice.capture({ seconds: RECORD_SECONDS });
      if (!r.ok) { setText(status, `${r.reason} (Settings > Voice turns the input on.)`); return; }
      busy = false;
      setSource({ samples: r.samples, sampleRate: r.sampleRate, label: 'Your recording' });
    } finally { busy = false; record.disabled = false; go.disabled = !source; }
  });

  let pop = null;
  go.addEventListener('click', async () => {
    if (!source || busy) return;
    const mode = time.querySelector('input').checked ? 'time' : 'single';
    busy = true; go.disabled = true;
    setText(status, 'Finding the pitch and imprinting...');
    await new Promise(r => setTimeout(r, 0));
    try {
      const a = analyseImprint(source.samples, source.sampleRate, { frames: mode === 'time' ? MAX_RINGS : 9 });
      if (!a.ok) { setText(status, a.reason); return; }
      const params = ctx.store.get(`parts.${part}.params`) || {};
      const base = ctx.engine && ctx.engine.getTerrain ? ctx.engine.getTerrain(part, slot) : null;
      const plain = source.label.replace(/^"|"$/g, '');
      const name = `Imprint of ${plain}`.slice(0, 80);
      const ut = imprintTerrain({ frames: a.frames, mode, params, base, strength: Number(strength.value) / 100, name });
      await addUserTerrain(ctx.store, part, slot, ut, { source: 'imprint' });
      const hz = `${Math.round(a.freq)} Hz`;
      const msg = mode === 'time'
        ? `Imprinted ${Math.min(MAX_RINGS, a.frames.length)} cycles (${hz}) from ${source.label} on rings. Turn Size to move through the sound.`
        : `Imprinted ${hz} cycle from ${source.label}`;
      setText(status, msg);
      ctx.toast(msg, { kind: 'success' });
    } catch (err) {
      console.warn('[ui] imprint failed', err);
      setText(status, err.message || 'The imprint did not work.');
    } finally { busy = false; go.disabled = !source; }
  });

  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--imprint', label: `Imprint into terrain ${slot}`, placement: 'bottom-start', focus: 'button' });
  return pop;
}
