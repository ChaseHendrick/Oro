// Piano roll for the active pattern. The 16-step grid stays visible.
// Notes start on a quarter step. The first note of a step is the grid note.
// One automation lane sits under the keys. Step locks still win on their step.

import {
  NOTE_NAMES, SEQ_STEPS, PLOCK_IDS, PART_PARAM_MAP, patternPath, stepToMidi, toNorm, clamp, defaultStep,
} from '../core/params.js';
import { paintNote, eraseNote, notesOf, lanePointCount, isLaneId } from '../music/roll.js';
import { h, createScope, setAttr } from './dom.js';
import { schedule } from './frame.js';
import '../styles/piano-roll.css';

const GROUP_NAMES = { terrain: 'Terrain', path: 'Path', voice: 'Voice', filter: 'Filter', filter2: 'Filter 2', mix: 'Mix', sampler: 'Sampler' };
const BLACK = new Set([1, 3, 6, 8, 10]);

function midiName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

export function createPianoRoll(ctx) {
  const { store } = ctx;
  const scope = createScope();
  let open = false;
  let laneId = 'cutoff';
  let selected = null;

  const button = h('button', {
    type: 'button', class: 'btn btn--ghost btn--sm seq-roll-btn', 'aria-pressed': 'false',
  }, 'Piano roll');
  const closeBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Close');
  const ruler = h('div', { class: 'roll-ruler', 'aria-hidden': 'true' });
  const keys = h('div', { class: 'roll-keys' });
  const grid = h('div', { class: 'roll-grid', role: 'application', 'aria-label': 'Piano roll' });
  const curve = h('div', { class: 'roll-curve', role: 'slider', tabindex: '0', 'aria-label': 'Lane curve', 'aria-valuemin': '0', 'aria-valuemax': '100' });
  const groups = {};
  for (const id of PLOCK_IDS) (groups[PART_PARAM_MAP[id].group] = groups[PART_PARAM_MAP[id].group] || []).push(id);
  const laneSelect = h('select', { class: 'select-native', 'aria-label': 'Lane parameter' },
    ...Object.keys(groups).map((g) => h('optgroup', { label: GROUP_NAMES[g] || g },
      ...groups[g].map((id) => h('option', { value: id }, PART_PARAM_MAP[id].label)))));
  laneSelect.value = laneId;

  const el = h('section', { class: 'seq-block piano-roll', hidden: true, 'aria-label': 'Piano roll' },
    h('header', { class: 'section-head roll-head' },
      h('h3', { class: 'section-title' }, 'Piano roll'), closeBtn),
    ruler,
    h('div', { class: 'roll-body' }, keys, grid),
    h('div', { class: 'roll-lane' },
      h('span', { class: 'section-title' }, 'Lane'),
      h('span', { class: 'select select--sm' }, laneSelect),
      curve,
      h('p', { class: 'roll-hint' }, 'Step locks still win on their step.')));
  el.hidden = true;

  const sel = () => store.get('ui.selectedPart') || 0;
  const path = () => patternPath(store, sel());
  const pattern = () => store.get(path()) || {};
  const drumOn = () => !!(store.get(`parts.${sel()}.drum`) || {}).on;

  function scaleAt() {
    const pat = pattern();
    return {
      base: pat.baseOctave ?? 3,
      root: store.get('global.scaleRoot') || 0,
      scaleType: store.get('global.scaleType') || 0,
    };
  }

  function midiOf(note) {
    const s = scaleAt();
    return stepToMidi(note, s.base, s.root, s.scaleType);
  }

  function rowHeight() {
    try {
      if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return 28;
    } catch { /* a test DOM has no matchMedia */ }
    return 16;
  }

  /**
   * One row per sounding pitch. A step can store the same pitch as a degree
   * plus an octave, so rows are matched by MIDI note, not by that encoding.
   * The row itself prefers octave 0, which is what the grid usually stores.
   */
  function rows() {
    const byMidi = new Map();
    for (let octave = -2; octave <= 2; octave++) {
      for (let degree = -21; degree <= 28; degree++) {
        const midi = midiOf({ degree, octave });
        if (midi < 0 || midi > 127) continue;
        const prev = byMidi.get(midi);
        if (!prev || Math.abs(octave) < Math.abs(prev.octave)) byMidi.set(midi, { degree, octave, midi });
      }
    }
    return [...byMidi.values()].sort((a, b) => b.midi - a.midi);
  }

  function setOpen(on) {
    open = !!on && !drumOn();
    el.hidden = !open;
    setAttr(button, 'aria-pressed', open ? 'true' : 'false');
    if (open) draw();
  }

  function draw() {
    const pat = pattern();
    const length = clamp(Math.round(pat.length) || 16, 1, SEQ_STEPS);
    const steps = pat.steps || [];
    const list = rows();
    const rowH = rowHeight();
    const track = h('div', { class: 'roll-ruler-track', style: { gridTemplateColumns: `repeat(${length}, minmax(0, 1fr))` } },
      ...Array.from({ length }, (_, i) => h('span', { class: 'roll-num' }, String(i + 1))));
    ruler.replaceChildren(h('span', { 'aria-hidden': 'true' }), track);
    keys.replaceChildren(...list.map((r) => {
      const black = BLACK.has(((r.midi % 12) + 12) % 12);
      return h('span', {
        class: black ? 'roll-key is-black' : 'roll-key',
        style: { height: `${rowH}px`, lineHeight: `${rowH}px` },
      }, midiName(r.midi));
    }));
    grid.style.height = `${Math.max(rowH, list.length * rowH)}px`;
    const noteEls = [];
    for (let i = 0; i < length; i++) {
      const notes = notesOf(steps[i] || defaultStep());
      for (const n of notes) {
        const noteMidi = midiOf(n);
        const row = list.findIndex((r) => r.midi === noteMidi);
        if (row < 0) continue;
        const q = n.q || 0;
        const span = Math.max(1, Math.round((n.gate || 0.5) * 4));
        noteEls.push(h('button', {
          type: 'button',
          class: n.first ? 'roll-note is-first' : 'roll-note',
          style: { left: `${((i * 4 + q) / (length * 4)) * 100}%`, width: `${(span / (length * 4)) * 100}%`, top: `${(row / list.length) * 100}%`, height: `${100 / list.length}%` },
          dataset: { step: String(i), degree: String(n.degree), octave: String(n.octave || 0) },
          'aria-label': `Step ${i + 1} ${midiName(list[row].midi)}`,
        }));
      }
    }
    grid.replaceChildren(...noteEls);
    const lane = pat.lane && pat.lane.id === laneId ? pat.lane : null;
    const n = lanePointCount(length);
    curve.replaceChildren(...Array.from({ length: n }, (_, i) => {
      const u = lane && typeof lane.curve[i] === 'number' ? lane.curve[i] : null;
      return h('span', {
        class: 'roll-point',
        style: { height: u == null ? '0' : `${Math.round(u * 100)}%` },
        dataset: { i: String(i) },
      });
    }));
    button.disabled = drumOn();
    if (drumOn() && open) setOpen(false);
  }

  function writeStep(i, next) {
    store.set(`${path()}.steps.${i}`, next, { source: 'ui' });
  }

  function cellAt(e) {
    const rect = grid.getBoundingClientRect();
    const pat = pattern();
    const length = clamp(Math.round(pat.length) || 16, 1, SEQ_STEPS);
    const list = rows();
    if (!rect.width || !rect.height || !list.length) return null;
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 0.999);
    const y = clamp((e.clientY - rect.top) / rect.height, 0, 0.999);
    const col = Math.min(length * 4 - 1, Math.floor(x * length * 4));
    const row = list[Math.min(list.length - 1, Math.floor(y * list.length))];
    return { step: Math.floor(col / 4), q: col % 4, degree: row.degree, octave: row.octave };
  }

  function paintAt(e) {
    const hit = cellAt(e);
    if (!hit) return;
    const i = hit.step;
    const cur = (pattern().steps || [])[i] || defaultStep();
    const hitMidi = midiOf(hit);
    const existing = notesOf(cur).find((n) => midiOf(n) === hitMidi);
    const src = existing || hit;
    writeStep(i, paintNote(cur, {
      degree: src.degree,
      octave: src.octave || 0,
      vel: existing ? existing.vel : 0.8,
      gate: existing ? existing.gate : 0.5,
      q: hit.q,
    }));
    selected = { step: i, degree: src.degree, octave: src.octave || 0 };
  }

  scope.on(button, 'click', () => setOpen(!open));
  scope.on(closeBtn, 'click', () => setOpen(false));
  scope.on(laneSelect, 'change', () => {
    laneId = isLaneId(laneSelect.value) ? laneSelect.value : 'cutoff';
    draw();
  });
  scope.on(grid, 'pointerdown', (e) => {
    if (e.button === 2) return;
    const note = e.target && e.target.closest ? e.target.closest('.roll-note') : null;
    if (note) {
      const i = Number(note.dataset.step);
      const cur = (pattern().steps || [])[i] || defaultStep();
      writeStep(i, eraseNote(cur, { degree: Number(note.dataset.degree), octave: Number(note.dataset.octave) }));
      selected = null;
      return;
    }
    paintAt(e);
  });
  scope.on(grid, 'pointermove', (e) => {
    if (!(e.buttons & 1) || (e.target && e.target.closest && e.target.closest('.roll-note'))) return;
    paintAt(e);
  });
  scope.on(grid, 'contextmenu', (e) => {
    const note = e.target && e.target.closest ? e.target.closest('.roll-note') : null;
    if (!note) return;
    e.preventDefault();
    const i = Number(note.dataset.step);
    const cur = (pattern().steps || [])[i] || defaultStep();
    writeStep(i, eraseNote(cur, { degree: Number(note.dataset.degree), octave: Number(note.dataset.octave) }));
    selected = null;
  });
  scope.on(grid, 'keydown', (e) => {
    if ((e.key !== 'Delete' && e.key !== 'Backspace') || !selected) return;
    e.preventDefault();
    const cur = (pattern().steps || [])[selected.step] || defaultStep();
    writeStep(selected.step, eraseNote(cur, selected));
    selected = null;
  });
  scope.on(curve, 'pointerdown', (e) => setCurve(e));
  scope.on(curve, 'pointermove', (e) => { if (e.buttons & 1) setCurve(e); });

  function setCurve(e) {
    const rect = curve.getBoundingClientRect();
    const pat = pattern();
    const length = clamp(Math.round(pat.length) || 16, 1, SEQ_STEPS);
    const n = lanePointCount(length);
    if (!rect.width || !rect.height) return;
    const i = clamp(Math.floor(((e.clientX - rect.left) / rect.width) * n), 0, n - 1);
    const u = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
    const def = PART_PARAM_MAP[laneId];
    const raw = store.get(`parts.${sel()}.params.${laneId}`);
    const base = toNorm(def, typeof raw === 'number' ? raw : def.default);
    const prev = pat.lane && pat.lane.id === laneId && Array.isArray(pat.lane.curve) && pat.lane.curve.length === n
      ? pat.lane.curve.slice()
      : Array.from({ length: n }, () => base);
    prev[i] = u;
    store.set(`${path()}.lane`, { id: laneId, curve: prev }, { source: 'ui' });
  }

  scope.add(store.subscribe('parts', () => schedule(draw)));
  scope.add(store.subscribe('ui.selectedPart', () => schedule(draw)));
  scope.add(store.subscribe('global', () => schedule(draw)));
  draw();

  return { el, button, dispose: scope.dispose, open: () => setOpen(true), close: () => setOpen(false), isOpen: () => open };
}
