// Settings > Audio > Tuning (v2.9): built-in tunings, the reference pitch,
// the tuning root and Scala .scl / .kbm import. The choice is part of the
// session (`tuning` in the store, absent for 12-TET at A4 = 440 Hz); the
// audio sync turns it into the engine's key -> Hz table.

import { NOTE_NAMES } from '../core/params.js';
import { TUNINGS, REF_MIN, REF_MAX, REF_DEFAULT, sanitizeTuning, parseScl, parseKbm, describeTuning } from '../dsp/tuning.js';
import { h, createScope, setText } from './dom.js';
import { icon } from './icons.js';

const selectWrap = (el) => h('div', { class: 'select select--sm' }, el, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));

export function createTuningSettings(ctx) {
  const { store } = ctx;
  const scope = createScope();
  const current = () => sanitizeTuning(store.get('tuning')) || { id: 'equal12', ref: REF_DEFAULT, root: -1 };
  const write = (next) => store.set('tuning', sanitizeTuning(next) || undefined, { source: 'ui' });

  const presetSel = h('select', { class: 'select-native', id: 'tuning-preset', 'aria-label': 'Tuning' });
  const rootSel = h('select', { class: 'select-native', id: 'tuning-root', 'aria-label': 'Tuning root' },
    h('option', { value: '-1' }, 'Follow key'), ...NOTE_NAMES.map((n, i) => h('option', { value: String(i) }, n)));
  const refIn = h('input', {
    class: 'field tuning-ref', id: 'tuning-ref', type: 'number', min: String(REF_MIN), max: String(REF_MAX), step: '0.1', inputmode: 'decimal',
    'aria-label': `Reference pitch for A4 in hertz, ${REF_MIN} to ${REF_MAX}`,
  });
  const fileIn = h('input', { type: 'file', accept: '.scl,.kbm', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const importBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('plus') + '<span>Import .scl / .kbm</span>', 'aria-label': 'Import a Scala scale (.scl) or keyboard map (.kbm)' });
  const clearMapBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': 'Remove the keyboard map' }, 'Remove map');
  const resetBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'aria-label': 'Back to 12-TET at A4 = 440 Hz' }, 'Reset');
  const readout = h('p', { class: 'setting-hint tuning-readout', role: 'status', 'aria-live': 'polite' });
  let message = '';

  function render() {
    const t = current();
    const opts = TUNINGS.map((x) => [x.id, x.name]);
    if (t.id === 'scala') opts.push(['scala', `Imported: ${t.scale.name}`]);
    if (presetSel.options.length !== opts.length || opts.some(([id, name], i) => presetSel.options[i].value !== id || presetSel.options[i].textContent !== name)) {
      presetSel.replaceChildren(...opts.map(([id, name]) => h('option', { value: id }, name)));
    }
    presetSel.value = t.id;
    rootSel.value = String(t.root);
    if (document.activeElement !== refIn) refIn.value = String(t.ref);
    const mapped = !!t.map;
    rootSel.disabled = mapped;
    refIn.disabled = mapped;
    clearMapBtn.hidden = !mapped;
    const d = describeTuning(t);
    const where = mapped
      ? ` Keyboard map${t.map.name ? ` ${t.map.name}` : ''}: key ${t.map.refNote} plays ${t.map.refHz} Hz.`
      : ` A4 = ${t.ref} Hz${d.notes === 12 ? '' : `, root key at its 12-TET pitch`}.`;
    setText(readout, `${d.text}.${where}${message ? ` ${message}` : ''}`);
  }

  scope.on(presetSel, 'change', () => {
    const t = current();
    message = '';
    write({ ...t, id: presetSel.value, scale: presetSel.value === 'scala' ? t.scale : undefined });
  });
  scope.on(rootSel, 'change', () => { message = ''; write({ ...current(), root: Number(rootSel.value) }); });
  const commitRef = () => {
    const v = Number(refIn.value);
    if (!Number.isFinite(v) || refIn.value === '') { refIn.value = String(current().ref); return; }
    message = '';
    write({ ...current(), ref: Math.min(REF_MAX, Math.max(REF_MIN, v)) });
    refIn.value = String(current().ref);
  };
  scope.on(refIn, 'change', commitRef);
  scope.on(refIn, 'keydown', (e) => { if (e.key === 'Enter') commitRef(); });
  scope.on(importBtn, 'click', () => fileIn.click());
  scope.on(clearMapBtn, 'click', () => { message = ''; write({ ...current(), map: undefined }); importBtn.focus(); });
  scope.on(resetBtn, 'click', () => { message = ''; write(null); });
  scope.on(fileIn, 'change', async () => {
    const files = [...(fileIn.files || [])];
    fileIn.value = '';
    // a scale first, so a .kbm chosen with it maps the new scale
    files.sort((a, b) => (/\.kbm$/i.test(a.name) ? 1 : 0) - (/\.kbm$/i.test(b.name) ? 1 : 0));
    const done = [];
    for (const f of files) {
      try {
        const text = await f.text();
        if (/\.kbm$/i.test(f.name)) {
          const map = parseKbm(text);
          write({ ...current(), map: { ...map, name: f.name } });
        } else {
          const scale = parseScl(text, f.name);
          write({ ...current(), id: 'scala', scale });
        }
        done.push(f.name);
      } catch (err) {
        message = `${f.name} was not loaded: ${err && err.message ? err.message : 'unreadable file'}.`;
        render();
        if (ctx.toast) ctx.toast('Tuning file not loaded', { kind: 'error', detail: message });
        return;
      }
    }
    message = done.length ? `Loaded ${done.join(' and ')}.` : '';
    render();
  });

  scope.add(store.subscribe('tuning', () => render()));
  scope.add(store.subscribe('', (path) => { if (path === '') render(); }));
  render();

  const field = (label, forId, control) => h('label', { class: 'tuning-field', for: forId }, h('span', { class: 'mini-label' }, label), control);
  const el = h('div', { class: 'tuning' },
    h('div', { class: 'tuning-grid' },
      field('Tuning', 'tuning-preset', selectWrap(presetSel)),
      field('Root', 'tuning-root', selectWrap(rootSel)),
      field('A4 (Hz)', 'tuning-ref', refIn)),
    readout,
    h('div', { class: 'btn-row' }, importBtn, clearMapBtn, resetBtn, fileIn));
  return { el, dispose: () => scope.dispose() };
}
