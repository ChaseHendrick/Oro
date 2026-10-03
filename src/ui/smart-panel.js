// Smart controls card (v2.8), at the top of the SOUND tab: the selected
// track's eight smart knobs and an editor for the chosen one. A smart knob
// sets up to four of the track's modulatable parameters at once, each across
// its own range (src/core/smart.js). Add a target with Learn (arm, then move
// any sound knob: where it started becomes the knob's start, where you leave
// it the knob's end) or from the list; then edit each range, invert it or
// give it a curve. Smart knobs can be MIDI-learned like any knob.

import { PART_PARAM_MAP, MOD_PARAM_IDS, toNorm, fromNorm, formatValue, clamp } from '../core/params.js';
import {
  SMART_KNOBS, SMART_MAX_TARGETS, SMART_CURVES, readSmart, applySmartKnob, setSmartMap, editSmartMap,
  removeSmartMap, renameSmartKnob, clearSmartKnob, smartKnobLabel, smartTargetLabel, isSmartTarget,
} from '../core/smart.js';
import { h, createScope, setText, setAttr } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createMiniSlider } from './controls.js';
import { icon } from './icons.js';

const GROUPS = { terrain: 'Terrain', path: 'Path', voice: 'Voice', filter: 'Filter', filter2: 'Filter 2', mix: 'Mix' };
const LEARN_SOURCES = new Set(['ui', 'midi', 'visual']);
const PCT = (v) => `${Math.round(v * 100)}%`;

function selectBox(select) {
  return h('div', { class: 'select select--xs' }, select, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
}

/** The "Add a target" list: every modulatable parameter, grouped. */
function targetOptions(select) {
  select.appendChild(h('option', { value: '' }, 'Add a target...'));
  const groups = new Map();
  for (const id of MOD_PARAM_IDS) {
    const g = GROUPS[PART_PARAM_MAP[id].group] || 'Other';
    if (!groups.has(g)) groups.set(g, h('optgroup', { label: g }));
    groups.get(g).appendChild(h('option', { value: id }, smartTargetLabel(id)));
  }
  for (const og of groups.values()) select.appendChild(og);
}

export function createSmartPanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const sel = () => binder.selected();
  const smart = () => readSmart(store, sel());
  let current = 0;           // the knob the editor shows
  let learn = null;          // { part, k, before: {id: value} }

  // ---------------------------------------------------------------- knobs
  function knobBinding(k) {
    const def = { id: `smart${k + 1}`, label: `Smart ${k + 1}`, curve: 'lin', min: 0, max: 1, default: 0, hint: 'Smart knob: sets each of its targets across its range' };
    const path = () => `parts.${sel()}.smart.knobs.${k}.value`;
    return {
      def, id: def.id, scope: 'smart',
      part: sel, path,
      get() { const v = store.get(path()); return typeof v === 'number' && Number.isFinite(v) ? v : 0; },
      set(v, meta = { source: 'ui' }) { applySmartKnob(store, sel(), k, clamp(Number(v) || 0, 0, 1), meta); },
      reset(meta = { source: 'ui' }) { this.set(0, meta); },
      subscribe(fn) {
        let p = sel();
        let off = store.subscribe(`parts.${p}.smart`, fn);
        const offSel = store.subscribe('ui.selectedPart', () => { off(); p = sel(); off = store.subscribe(`parts.${p}.smart`, fn); fn(); });
        const offAll = store.subscribe('', (path) => { if (path === '' || path === 'parts') fn(); });
        return () => { off(); offSel(); offAll(); };
      },
      modPath: () => null,
      learnTarget: () => ({ scope: 'smart', part: 'sel', id: def.id }),
    };
  }

  const cells = [];
  const knobs = [];
  for (let k = 0; k < SMART_KNOBS; k++) {
    const knob = createKnob(ctx, knobBinding(k), {
      size: 'md', caption: 'both', format: PCT,
      label: () => smartKnobLabel(smart().knobs[k], k),
      ariaLabel: (l) => `Smart knob ${k + 1}: ${l}`,
    });
    scope.add(knob.dispose);
    knobs.push(knob);
    const cell = h('div', { class: 'smart-cell', dataset: { k: String(k) } }, knob.el);
    // Clicking or focusing a knob shows its targets in the editor.
    scope.on(cell, 'pointerdown', () => choose(k));
    scope.on(cell, 'focusin', () => choose(k));
    cells.push(cell);
  }
  const knobRow = h('div', { class: 'smart-knobs', role: 'group', 'aria-label': 'Smart knobs' }, cells);

  // ---------------------------------------------------------------- editor
  const title = h('span', { class: 'smart-title' });
  const nameIn = h('input', { class: 'field field--inline smart-name', type: 'text', maxlength: '24', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Smart knob name' });
  const learnBtn = h('button', { type: 'button', class: 'btn btn--sm smart-learn', 'aria-pressed': 'false', html: icon('learn') + '<span>Learn</span>' });
  const addSel = h('select', { class: 'select-native', 'aria-label': 'Add a target to this smart knob' });
  targetOptions(addSel);
  const clearBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', html: icon('trash') + '<span>Clear</span>' });
  const list = h('div', { class: 'smart-maps', role: 'list', 'aria-label': 'Targets of this smart knob' });
  const status = h('p', { class: 'smart-status', role: 'status', 'aria-live': 'polite' });
  const editor = h('div', { class: 'smart-editor', role: 'group', 'aria-label': 'Smart knob targets' },
    h('div', { class: 'smart-editor-head' }, title, nameIn, learnBtn, selectBox(addSel), clearBtn),
    list, status);

  let rowScope = createScope();
  scope.add(() => rowScope.dispose());
  let structure = '';

  function rangeBinding(k, j, field) {
    const p = sel();
    const def = { id: `smart-${field}`, label: field === 'min' ? 'Start' : 'End', curve: 'lin', min: 0, max: 1, default: field === 'min' ? 0 : 1 };
    return {
      def, id: def.id, scope: 'local', part: () => p, path: () => `parts.${p}.smart`,
      get() { const m = readSmart(store, p).knobs[k].maps[j]; return m ? m[field] : def.default; },
      set(v) { editSmartMap(store, p, k, j, { [field]: clamp(Number(v) || 0, 0, 1) }); },
      reset() { this.set(def.default); },
      subscribe(fn) { return store.subscribe(`parts.${p}.smart`, fn); },
      modPath: () => null, learnTarget: () => null,
    };
  }

  function mapRow(k, j, map) {
    const def = PART_PARAM_MAP[map.id];
    const name = smartTargetLabel(map.id);
    const fmt = (n) => formatValue(def, fromNorm(def, n));
    const from = createMiniSlider(ctx, rangeBinding(k, j, 'min'), { ariaLabel: `${name}: value at the knob's start`, format: fmt, className: 'smart-range' });
    const to = createMiniSlider(ctx, rangeBinding(k, j, 'max'), { ariaLabel: `${name}: value at the knob's end`, format: fmt, className: 'smart-range' });
    rowScope.add(from.dispose); rowScope.add(to.dispose);
    const fromVal = h('span', { class: 'smart-val mono' });
    const toVal = h('span', { class: 'smart-val mono' });
    const curve = h('select', { class: 'select-native', 'aria-label': `${name}: curve` }, SMART_CURVES.map((c, i) => h('option', { value: String(i) }, c)));
    curve.value = String(map.curve || 0);
    rowScope.on(curve, 'change', () => editSmartMap(store, sel(), k, j, { curve: Number(curve.value) }));
    const invert = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': `Invert the range of ${name}`, dataset: { tip: 'Invert: swap the start and end values' }, html: icon('rotate') });
    rowScope.on(invert, 'click', () => {
      const m = readSmart(store, sel()).knobs[k].maps[j];
      if (m) editSmartMap(store, sel(), k, j, { min: m.max, max: m.min });
    });
    const remove = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': `Remove ${name} from this smart knob`, dataset: { tip: 'Remove this target' }, html: icon('close') });
    rowScope.on(remove, 'click', () => { removeSmartMap(store, sel(), k, j); setText(status, `${name} removed.`); });
    const row = h('div', { class: 'smart-map', role: 'listitem' },
      h('span', { class: 'smart-map-name' }, name),
      h('div', { class: 'smart-map-range' },
        h('span', { class: 'mini-label' }, 'Start'), from.el, fromVal,
        h('span', { class: 'mini-label' }, 'End'), to.el, toVal),
      selectBox(curve), invert, remove);
    const renderVals = () => {
      const m = readSmart(store, sel()).knobs[k].maps[j];
      if (!m) return;
      setText(fromVal, fmt(m.min));
      setText(toVal, fmt(m.max));
      if (curve.value !== String(m.curve)) curve.value = String(m.curve);
      row.classList.toggle('is-inverted', m.min > m.max);
    };
    rowScope.add(store.subscribe(`parts.${sel()}.smart`, () => schedule(renderVals)));
    renderVals();
    return row;
  }

  function renderEditor() {
    const p = sel();
    const sm = smart();
    const knob = sm.knobs[current];
    const key = `${p}|${current}|${knob.maps.map(m => m.id).join(',')}`;
    setText(title, `Smart ${current + 1}`);
    nameIn.placeholder = knob.maps.length ? smartTargetLabel(knob.maps[0].id) : `Smart ${current + 1}`;
    if (document.activeElement !== nameIn && nameIn.value !== knob.name) nameIn.value = knob.name;
    addSel.disabled = knob.maps.length >= SMART_MAX_TARGETS;
    clearBtn.disabled = !knob.maps.length && !knob.name;
    if (key !== structure) {
      structure = key;
      rowScope.dispose();
      rowScope = createScope();
      list.replaceChildren(...knob.maps.map((m, j) => mapRow(current, j, m)));
      if (!knob.maps.length) list.appendChild(h('p', { class: 'smart-empty' }, 'No targets yet. Press Learn and move any sound knob, or pick one from the list.'));
    }
    cells.forEach((c, i) => {
      const kn = sm.knobs[i];
      c.classList.toggle('is-current', i === current);
      c.classList.toggle('is-empty', !kn.maps.length);
      c.classList.toggle('is-learning', !!learn && learn.k === i);
      knobs[i].setDisabled(!kn.maps.length, 'No targets yet: choose this knob, press Learn, then move a sound knob');
    });
    learnBtn.classList.toggle('is-on', !!learn);
    setAttr(learnBtn, 'aria-pressed', String(!!learn));
    learnBtn.lastChild.textContent = learn ? 'Done' : 'Learn';
    setAttr(learnBtn, 'aria-label', learn ? `Stop learning targets for smart knob ${current + 1}` : `Learn targets for smart knob ${current + 1}`);
  }
  const invalidate = () => schedule(renderEditor);

  function choose(k) {
    if (k === current) return;
    if (learn) stopLearn();
    current = k;
    renderEditor();
  }

  // ---------------------------------------------------------------- learn
  function startLearn() {
    const p = sel();
    learn = { part: p, k: current, before: { ...(store.get(`parts.${p}.params`) || {}) }, warned: '' };
    setText(status, `Learning for Smart ${current + 1}: move any sound knob (up to ${SMART_MAX_TARGETS}). Where it starts becomes the knob's start, where you leave it the knob's end. Press Done or Esc to finish.`);
    renderEditor();
  }
  function stopLearn(message) {
    if (!learn) return;
    learn = null;
    if (message) setText(status, message);
    renderEditor();
  }
  // Learned targets are written right after the change that taught them (a
  // microtask: not inside the store's own notification, and not waiting for a frame).
  const pendingLearn = new Map();
  let flushQueued = false;
  function flushLearn() {
    flushQueued = false;
    if (!learn) { pendingLearn.clear(); return; }
    for (const [id, to] of pendingLearn) {
      const from = learn.before[id] ?? PART_PARAM_MAP[id].default;
      const res = setSmartMap(store, learn.part, learn.k, id, from, to);
      const def = PART_PARAM_MAP[id];
      if (res === 'added') setText(status, `Added ${smartTargetLabel(id)}: ${formatValue(def, from)} to ${formatValue(def, to)}. Move another knob, or press Done.`);
      else if (res === 'updated') setText(status, `${smartTargetLabel(id)}: ${formatValue(def, from)} to ${formatValue(def, to)}. Move another knob, or press Done.`);
      else if (res === 'full') setText(status, `Smart ${learn.k + 1} already has ${SMART_MAX_TARGETS} targets. Remove one to add ${smartTargetLabel(id)}.`);
    }
    pendingLearn.clear();
  }
  scope.add(store.subscribe('parts', (path, value, meta) => {
    if (!learn || (meta && meta.smart) || !LEARN_SOURCES.has(meta && meta.source)) return;
    const m = /^parts\.(\d+)\.params\.(\w+)$/.exec(path);
    if (!m || Number(m[1]) !== learn.part || !PART_PARAM_MAP[m[2]]) return;
    const id = m[2];
    if (!isSmartTarget(id)) {
      if (learn.warned !== id) { learn.warned = id; setText(status, `${PART_PARAM_MAP[id].label} cannot be a smart control target: choose a knob that can be modulated.`); }
      return;
    }
    if (typeof value !== 'number') return;
    if (Math.abs(toNorm(PART_PARAM_MAP[id], value) - toNorm(PART_PARAM_MAP[id], learn.before[id] ?? value)) < 1e-6) return;
    pendingLearn.set(id, value);
    if (!flushQueued) { flushQueued = true; queueMicrotask(flushLearn); }
  }));
  scope.on(learnBtn, 'click', () => (learn ? stopLearn('Learn finished.') : startLearn()));
  scope.on(window, 'keydown', (e) => { if (learn && e.key === 'Escape') stopLearn('Learn finished.'); });

  // ---------------------------------------------------------------- other edits
  scope.on(addSel, 'change', () => {
    const id = addSel.value;
    addSel.value = '';
    if (!id) return;
    const def = PART_PARAM_MAP[id];
    const cur = store.get(`parts.${sel()}.params.${id}`) ?? def.default;
    const n = toNorm(def, cur);
    const res = setSmartMap(store, sel(), current, id, cur, fromNorm(def, n < 0.5 ? 1 : 0));
    if (res === 'added') setText(status, `Added ${smartTargetLabel(id)}. Set its start and end below.`);
    else if (res === 'updated') setText(status, `${smartTargetLabel(id)} is already a target of this knob.`);
    else if (res === 'full') setText(status, `This smart knob already has ${SMART_MAX_TARGETS} targets.`);
  });
  const commitName = () => { renameSmartKnob(store, sel(), current, nameIn.value); };
  scope.on(nameIn, 'change', commitName);
  scope.on(nameIn, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); nameIn.blur(); } });
  scope.on(clearBtn, 'click', () => { clearSmartKnob(store, sel(), current); setText(status, `Smart ${current + 1} cleared.`); });

  scope.add(store.subscribe('ui.selectedPart', () => { if (learn) stopLearn('Learn stopped: the track changed.'); invalidate(); }));
  scope.add(store.subscribe('parts', (path) => {
    if (path === 'parts' || new RegExp(`^parts\\.${sel()}(\\.smart.*)?$`).test(path)) invalidate();
  }));
  scope.add(store.subscribe('', (path) => { if (path === '') invalidate(); }));
  scope.add(() => { learn = null; });

  renderEditor();
  const el = h('section', { class: ['dock-card', 'dock-card--smart'], 'aria-labelledby': 'sec-smart-controls' },
    h('header', { class: 'section-head' },
      h('h3', { class: 'section-title', id: 'sec-smart-controls' }, 'Smart controls'),
      h('span', { class: 'section-aside' }, 'Eight knobs, each moving up to four sound controls')),
    h('div', { class: 'smart-body' }, knobRow, editor));
  return { el, dispose: scope.dispose };
}
