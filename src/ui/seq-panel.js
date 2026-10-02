// SEQ tab: 16-step sequencer for the selected part plus its arpeggiator and the
// global key, scale, swing and keyboard mode. Steps store scale degrees, so the
// note names shown here follow the global key and scale.

import {
  SEQ_STEPS, SEQ_RATES, ARP_MODES, NOTE_NAMES, SCALES, SCALE_NAMES, stepToMidi, clamp, defaultStep,
} from '../core/params.js';
import { h, createScope, setText, setAttr, listen, call, has } from './dom.js';
import { schedule } from './frame.js';
import { createToggle, createSelect, createStepper, createMiniSlider, createSegmented } from './controls.js';
import { icon } from './icons.js';

export function midiName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

const ROWS = ['on', 'degree', 'octave', 'vel', 'gate', 'accent', 'slide', 'lock'];
const LABELS = ['Step', 'Note', 'Oct', 'Vel', 'Gate', 'Accent', 'Slide', 'Dot'];

// Local pattern tools so editing still works if the music module is missing.
function localClear(store, part) {
  store.set(`parts.${part}.seq.steps`, Array.from({ length: SEQ_STEPS }, defaultStep), { source: 'ui' });
}
function localShift(store, part, dir) {
  const steps = store.get(`parts.${part}.seq.steps`) || [];
  const len = clamp(store.get(`parts.${part}.seq.length`) || SEQ_STEPS, 1, SEQ_STEPS);
  const head = steps.slice(0, len), tail = steps.slice(len);
  const rotated = dir > 0 ? [head[len - 1], ...head.slice(0, len - 1)] : [...head.slice(1), head[0]];
  store.set(`parts.${part}.seq.steps`, [...rotated, ...tail].map(s => ({ ...s })), { source: 'ui' });
}
function localRandom(store, part, density = 0.6) {
  const scaleLen = (SCALES[SCALE_NAMES[store.get('global.scaleType')]] || SCALES.Minor).length;
  const steps = Array.from({ length: SEQ_STEPS }, (_, i) => ({
    ...defaultStep(),
    on: Math.random() < (i % 4 === 0 ? density + 0.25 : density) ? 1 : 0,
    degree: Math.floor(Math.random() * (scaleLen + 3)) - 2,
    vel: 0.55 + Math.random() * 0.4,
    gate: 0.3 + Math.random() * 0.5,
    accent: Math.random() < 0.15 ? 1 : 0,
    slide: Math.random() < 0.1 ? 1 : 0,
  }));
  store.set(`parts.${part}.seq.steps`, steps, { source: 'ui' });
}

export function createSeqPanel(ctx) {
  const scope = createScope();
  const { store, binder, music } = ctx;
  const hasMusic = !!(music && music.transport);
  const sel = () => binder.selected();
  const seqPath = () => `parts.${sel()}.seq`;

  // ---------------------------------------------------------------- side controls
  const P = (rel, def) => binder.path(rel, def);
  const seqOn = createToggle(ctx, P('seq.enabled', { id: 'seqEnabled', label: 'Sequencer', curve: 'bool', min: 0, max: 1, default: 0 }), {
    label: 'Seq on', iconName: 'seq', className: 'toggle--seq', tip: 'Play this pattern when the transport runs',
  });
  const seqRate = createSelect(ctx, P('seq.rate', { id: 'seqRate', label: 'Step rate', curve: 'enum', min: 0, max: 5, default: 3, options: SEQ_RATES.map(r => r.name) }), { label: 'Step rate', className: 'select--sm' });
  const seqLen = createStepper(ctx, P('seq.length', { id: 'seqLength', label: 'Length', curve: 'int', min: 1, max: 16, default: 16 }), { label: 'Pattern length', format: v => String(v) });
  const seqOct = createStepper(ctx, P('seq.baseOctave', { id: 'seqOct', label: 'Octave', curve: 'int', min: 0, max: 7, default: 3 }), { label: 'Base octave', format: v => 'C' + v });
  const tool = (name, label, fn) => {
    const b = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': label, dataset: { tip: label }, html: icon(name) });
    scope.on(b, 'click', fn);
    return b;
  };
  const lockGlide = createMiniSlider(ctx, P('seq.lockGlide', { id: 'lockGlide', label: 'Dot glide', curve: 'lin', min: 0, max: 1, default: 0.5, hint: 'How long the dot takes to reach a step\'s locked spot (0 jumps)' }), {
    ariaLabel: 'Dot lock glide time', format: v => (v < 0.005 ? 'Jump' : Math.round(v * 100) + '% of a step'),
  });
  const lockRec = createToggle(ctx, { ...binder.uiValue('lockRecord', [0, 1], 0), def: { id: 'lockRecord', label: 'Rec dot', default: 0 } }, {
    label: 'Rec dot', iconName: 'record', className: 'toggle--sm toggle--rec',
    tip: 'While playing, moving the dot records it into the step that is sounding',
  });
  const tools = h('div', { class: 'seq-tools' },
    tool('dice', 'Randomise pattern', () => {
      if (has(music, 'randomizePattern')) call(music, 'randomizePattern', sel(), { density: 0.6 }); else localRandom(store, sel());
    }),
    tool('trash', 'Clear pattern', () => {
      if (has(music, 'clearPattern')) call(music, 'clearPattern', sel()); else localClear(store, sel());
    }),
    tool('arrow-left', 'Shift pattern left', () => {
      if (has(music, 'shiftPattern')) call(music, 'shiftPattern', sel(), -1); else localShift(store, sel(), -1);
    }),
    tool('arrow-right', 'Shift pattern right', () => {
      if (has(music, 'shiftPattern')) call(music, 'shiftPattern', sel(), 1); else localShift(store, sel(), 1);
    }));

  const arpMode = createSelect(ctx, P('arp.mode', { id: 'arpMode', label: 'Arp mode', curve: 'enum', min: 0, max: ARP_MODES.length - 1, default: 0, options: ARP_MODES }), { label: 'Arpeggiator mode', className: 'select--sm' });
  const arpRate = createSelect(ctx, P('arp.rate', { id: 'arpRate', label: 'Arp rate', curve: 'enum', min: 0, max: 5, default: 3, options: SEQ_RATES.map(r => r.name) }), { label: 'Arpeggiator rate', className: 'select--sm' });
  const arpOct = createSegmented(ctx, P('arp.octaves', { id: 'arpOct', label: 'Octaves', curve: 'int', min: 1, max: 4, default: 1 }), {
    label: 'Arpeggiator octaves', size: 'sm', options: [1, 2, 3, 4].map(v => ({ value: v, label: String(v), aria: `${v} octave${v > 1 ? 's' : ''}` })),
  });
  const arpGate = createMiniSlider(ctx, P('arp.gate', { id: 'arpGate', label: 'Gate', curve: 'lin', min: 0.05, max: 1, default: 0.6 }), { ariaLabel: 'Arpeggiator gate length', format: v => Math.round(v * 100) + '%' });
  const arpHold = createToggle(ctx, P('arp.hold', { id: 'arpHold', label: 'Hold', curve: 'bool', min: 0, max: 1, default: 0, hint: 'Latch: notes keep arpeggiating after you let go' }), { label: 'Hold', iconName: 'hold', className: 'toggle--sm' });

  const key = createSelect(ctx, binder.globalParam('scaleRoot'), { label: 'Key', className: 'select--sm' });
  const scale = createSelect(ctx, binder.globalParam('scaleType'), { label: 'Scale', className: 'select--sm' });
  const swing = createMiniSlider(ctx, binder.globalParam('swing'), { ariaLabel: 'Swing', format: v => Math.round(v * 100) + '%' });
  const keyMode = createSegmented(ctx, binder.globalParam('keyMode'), { label: 'Keyboard plays', size: 'sm' });
  for (const c of [seqOn, seqRate, seqLen, seqOct, arpMode, arpRate, arpOct, arpGate, arpHold, key, scale, swing, keyMode, lockGlide, lockRec]) scope.add(c.dispose);

  const field = (label, control, cls = '') => h('div', { class: ['field-row', cls] }, h('span', { class: 'mini-label' }, label), control);
  const side = h('div', { class: 'seq-side' },
    h('section', { class: 'seq-block', 'aria-label': 'Pattern' },
      h('header', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Pattern')),
      h('div', { class: 'seq-line' }, seqOn.el, seqRate.el),
      h('div', { class: 'seq-pair' },
        h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Length'), seqLen.el),
        h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Octave'), seqOct.el)),
      h('div', { class: 'seq-line seq-dotline' }, lockRec.el, h('div', { class: 'field-col field-col--grow' }, h('span', { class: 'mini-label' }, 'Dot glide'), lockGlide.el)),
      tools));

  const globalBar = h('div', { class: 'seq-global', role: 'group', 'aria-label': 'Key and feel (all parts)' },
    field('Key', key.el), field('Scale', scale.el), field('Swing', swing.el, 'field-row--swing'), field('Keys play', keyMode.el),
    h('span', { class: 'seq-global-note' }, 'All parts'));
  const arpBar = h('div', { class: 'seq-arp', role: 'group', 'aria-label': 'Arpeggiator for this part' },
    h('span', { class: 'section-title' }, 'Arp'), arpMode.el, arpRate.el, field('Octaves', arpOct.el), field('Gate', arpGate.el, 'field-row--gate'), arpHold.el);

  // ---------------------------------------------------------------- grid
  const cells = {};
  for (const r of ROWS) cells[r] = [];
  const nums = [];
  const cols = [];
  for (let i = 0; i < SEQ_STEPS; i++) {
    const num = h('span', { class: 'seq-num', 'aria-hidden': 'true' }, String(i + 1));
    nums.push(num);
    const pad = h('button', { type: 'button', class: 'seq-pad', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1}` });
    const note = h('span', { class: 'seq-note', role: 'spinbutton', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} note` });
    const oct = h('span', { class: 'seq-oct', role: 'spinbutton', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} octave`, 'aria-valuemin': '-2', 'aria-valuemax': '2' });
    const vel = h('span', { class: 'seq-bar seq-bar--vel', role: 'slider', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} velocity`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { class: 'seq-bar-fill' }));
    const gate = h('span', { class: 'seq-bar seq-bar--gate', role: 'slider', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} gate`, 'aria-valuemin': '5', 'aria-valuemax': '100' }, h('span', { class: 'seq-bar-fill' }));
    const acc = h('button', { type: 'button', class: 'seq-flag seq-flag--acc', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1} accent` });
    const slide = h('button', { type: 'button', class: 'seq-flag seq-flag--slide', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1} slide` });
    const lock = h('button', {
      type: 'button', class: 'seq-lock', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1} dot lock`,
      dataset: { tip: 'Dot lock: the dot glides here when this step plays. Click to lock it to where the dot is now, Shift-click to move the lock, click again to clear.' },
    }, h('span', { class: 'seq-lock-dot' }));
    cells.on.push(pad); cells.degree.push(note); cells.octave.push(oct); cells.vel.push(vel); cells.gate.push(gate); cells.accent.push(acc); cells.slide.push(slide); cells.lock.push(lock);
    const col = h('div', { class: ['seq-col', i % 4 === 0 && 'is-beat'], dataset: { step: String(i) } }, num, pad, note, oct, vel, gate, acc, slide, lock);
    cols.push(col);
  }
  const labels = h('div', { class: 'seq-labels', 'aria-hidden': 'true' },
    h('span', { class: 'seq-num' }, ''), ...LABELS.map(t => h('span', { class: `seq-label seq-label--${t.toLowerCase()}` }, t)));
  const grid = h('div', { class: 'seq-grid', role: 'group', 'aria-label': 'Steps. Use the arrow keys to move along a row and up or down to change a value.' }, labels, ...cols);
  const playNote = h('span', { class: 'seq-status', 'aria-live': 'off' });
  const main = h('div', { class: 'seq-main' }, globalBar, grid, arpBar, playNote);
  const el = h('div', { class: 'dock-pane dock-pane--seq' }, side, main);
  if (!hasMusic) {
    playNote.textContent = 'Playback is unavailable here (the music engine did not start). You can still edit patterns.';
    el.classList.add('no-music');
    seqOn.setDisabled(true, 'The music engine is not available');
    arpMode.setDisabled(true, 'The music engine is not available');
  }

  // ---------------------------------------------------------------- state
  const steps = () => store.get(`${seqPath()}.steps`) || [];
  const setStep = (i, field, value) => {
    const p = sel();
    const cur = store.get(`parts.${p}.seq.steps.${i}`);
    if (!cur || cur[field] === value) return;
    store.set(`parts.${p}.seq.steps.${i}.${field}`, value, { source: 'ui' });
  };

  function render() {
    const st = steps();
    const p = sel();
    const len = clamp(store.get(`parts.${p}.seq.length`) || 16, 1, 16);
    const baseOct = store.get(`parts.${p}.seq.baseOctave`) ?? 3;
    const root = store.get('global.scaleRoot') ?? 9, scaleType = store.get('global.scaleType') ?? 1;
    for (let i = 0; i < SEQ_STEPS; i++) {
      const s = st[i] || defaultStep();
      const midi = stepToMidi(s, baseOct, root, scaleType);
      const name = midiName(midi);
      cols[i].classList.toggle('is-out', i >= len);
      cols[i].classList.toggle('is-on', !!s.on);
      setAttr(cells.on[i], 'aria-pressed', String(!!s.on));
      cells.on[i].classList.toggle('is-accent', !!s.accent);
      setText(cells.degree[i], name);
      setAttr(cells.degree[i], 'aria-valuenow', String(s.degree));
      setAttr(cells.degree[i], 'aria-valuetext', `${name}, scale degree ${s.degree + 1}`);
      setText(cells.octave[i], s.octave > 0 ? '+' + s.octave : String(s.octave));
      cells.octave[i].classList.toggle('is-zero', !s.octave);
      setAttr(cells.octave[i], 'aria-valuenow', String(s.octave));
      cells.vel[i].firstChild.style.transform = `scaleY(${s.vel})`;
      setAttr(cells.vel[i], 'aria-valuenow', String(Math.round(s.vel * 100)));
      cells.gate[i].firstChild.style.transform = `scaleX(${s.gate})`;
      setAttr(cells.gate[i], 'aria-valuenow', String(Math.round(s.gate * 100)));
      setAttr(cells.accent[i], 'aria-pressed', String(!!s.accent));
      setAttr(cells.slide[i], 'aria-pressed', String(!!s.slide));
      const locked = !!s.lock;
      setAttr(cells.lock[i], 'aria-pressed', String(locked));
      setAttr(cells.lock[i], 'aria-description', locked ? `Dot at ${(s.lx ?? 0.5).toFixed(2)}, ${(s.ly ?? 0.5).toFixed(2)}` : null);
      const dot = cells.lock[i].firstChild;
      dot.style.left = ((s.lx ?? 0.5) * 100).toFixed(1) + '%';
      dot.style.top = ((s.ly ?? 0.5) * 100).toFixed(1) + '%';
    }
  }
  const invalidate = () => schedule(render);
  scope.add(store.subscribe('parts', (path) => { if (path === 'parts' || /^parts\.\d(\.seq.*)?$/.test(path)) invalidate(); }));
  scope.add(store.subscribe('global.scaleRoot', invalidate));
  scope.add(store.subscribe('global.scaleType', invalidate));
  scope.add(store.subscribe('ui.selectedPart', () => { clearPlayhead(); invalidate(); }));
  scope.add(store.subscribe('', (path) => { if (path === '') invalidate(); }));

  // ---------------------------------------------------------------- interaction
  // Pads: click toggles; dragging across paints the same state.
  let paint = null;
  cells.on.forEach((pad, i) => {
    scope.on(pad, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      pad.focus({ preventScroll: true });
      const st = steps()[i];
      const next = st && st.on ? 0 : 1;
      paint = { value: next, id: e.pointerId };
      setStep(i, 'on', next);
      if (next) previewStep(i);
    });
    scope.on(pad, 'click', (e) => { if (e.detail === 0) { const st = steps()[i]; setStep(i, 'on', st && st.on ? 0 : 1); } });
  });
  scope.on(grid, 'pointermove', (e) => {
    if (!paint || e.pointerId !== paint.id) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const i = target ? cells.on.indexOf(target.closest?.('.seq-pad')) : -1;
    if (i >= 0) setStep(i, 'on', paint.value);
  });
  scope.on(window, 'pointerup', () => { paint = null; });

  // Bars: set from the pointer's position, painting across steps while dragging.
  function barDrag(kind, field, min) {
    let active = null;
    const valueAt = (bar, e) => {
      const r = bar.getBoundingClientRect();
      return kind === 'vel' ? clamp((r.bottom - e.clientY) / r.height, min, 1) : clamp((e.clientX - r.left) / r.width, min, 1);
    };
    cells[field].forEach((bar, i) => {
      scope.on(bar, 'pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        bar.focus({ preventScroll: true });
        active = e.pointerId;
        setStep(i, field, Math.round(valueAt(bar, e) * 100) / 100);
      });
    });
    scope.on(grid, 'pointermove', (e) => {
      if (active !== e.pointerId) return;
      for (let i = 0; i < SEQ_STEPS; i++) {
        const r = cells[field][i].getBoundingClientRect();
        if (e.clientX >= r.left - 1 && e.clientX <= r.right + 1) { setStep(i, field, Math.round(valueAt(cells[field][i], e) * 100) / 100); break; }
      }
    });
    scope.on(window, 'pointerup', () => { active = null; });
  }
  barDrag('vel', 'vel', 0);
  barDrag('gate', 'gate', 0.05);

  // Note cells: vertical drag, wheel.
  cells.degree.forEach((cell, i) => {
    let st = null;
    scope.on(cell, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      cell.focus({ preventScroll: true });
      st = { id: e.pointerId, y: e.clientY, v: (steps()[i] || {}).degree || 0, moved: false };
      try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      cell.classList.add('is-active');
    });
    scope.on(cell, 'pointermove', (e) => {
      if (!st || st.id !== e.pointerId) return;
      const d = Math.round((st.y - e.clientY) / 9);
      if (d !== 0 || st.moved) {
        st.moved = true;
        const next = clamp(st.v + d, -21, 28);
        if (next !== (steps()[i] || {}).degree) { setStep(i, 'degree', next); previewStep(i); }
      }
    });
    const end = () => { if (st && !st.moved) previewStep(i); st = null; cell.classList.remove('is-active'); };
    scope.on(cell, 'pointerup', end);
    scope.on(cell, 'pointercancel', end);
    let acc = 0;
    scope.on(cell, 'wheel', (e) => {
      e.preventDefault();
      acc += e.deltaY || e.deltaX;
      if (Math.abs(acc) < 30) return;
      const dir = acc < 0 ? 1 : -1;
      acc = 0;
      setStep(i, 'degree', clamp(((steps()[i] || {}).degree || 0) + dir, -21, 28));
    }, { passive: false });
  });
  cells.octave.forEach((cell, i) => {
    let st = null;
    scope.on(cell, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      cell.focus({ preventScroll: true });
      st = { id: e.pointerId, y: e.clientY, v: (steps()[i] || {}).octave || 0, moved: false };
      try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    scope.on(cell, 'pointermove', (e) => {
      if (!st || st.id !== e.pointerId) return;
      const d = Math.round((st.y - e.clientY) / 14);
      if (d !== 0) st.moved = true;
      setStep(i, 'octave', clamp(st.v + d, -2, 2));
    });
    const end = () => {
      if (st && !st.moved) {
        // A plain click cycles 0 -> +1 -> +2 -> -2 -> -1 -> 0.
        const v = (steps()[i] || {}).octave || 0;
        setStep(i, 'octave', v >= 2 ? -2 : v + 1);
      }
      st = null;
    };
    scope.on(cell, 'pointerup', end);
    scope.on(cell, 'pointercancel', () => { st = null; });
  });
  for (const field of ['accent', 'slide']) {
    cells[field].forEach((b, i) => scope.on(b, 'click', () => setStep(i, field, (steps()[i] || {})[field] ? 0 : 1)));
  }
  function toggleLock(i, recapture) {
    const p = sel();
    const st = (store.get(`parts.${p}.seq.steps.${i}`)) || defaultStep();
    if (st.lock && !recapture) { setStep(i, 'lock', 0); return; }
    const x = store.get(`parts.${p}.params.centerX`) ?? 0.5, y = store.get(`parts.${p}.params.centerY`) ?? 0.5;
    store.batch(() => {
      store.set(`parts.${p}.seq.steps.${i}.lx`, clamp(x - Math.floor(x), 0, 1), { source: 'ui' });
      store.set(`parts.${p}.seq.steps.${i}.ly`, clamp(y - Math.floor(y), 0, 1), { source: 'ui' });
      store.set(`parts.${p}.seq.steps.${i}.lock`, 1, { source: 'ui' });
    });
  }
  cells.lock.forEach((b, i) => scope.on(b, 'click', (e) => toggleLock(i, e.shiftKey)));

  // Keyboard: roving focus within each row.
  for (const row of ROWS) {
    const list = cells[row];
    list.forEach((cell, i) => {
      scope.on(cell, 'keydown', (e) => {
        const s = steps()[i] || defaultStep();
        let move = 0, handled = true;
        switch (e.key) {
          case 'ArrowLeft': move = -1; break;
          case 'ArrowRight': move = 1; break;
          case 'Home': move = -i; break;
          case 'End': move = SEQ_STEPS - 1 - i; break;
          case 'ArrowUp': case 'ArrowDown': case 'PageUp': case 'PageDown': {
            const dir = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : -1;
            const big = e.key.startsWith('Page');
            if (row === 'degree') { setStep(i, 'degree', clamp(s.degree + dir * (big ? 7 : 1), -21, 28)); previewStep(i); }
            else if (row === 'octave') setStep(i, 'octave', clamp(s.octave + dir, -2, 2));
            else if (row === 'vel') setStep(i, 'vel', clamp(Math.round((s.vel + dir * (big ? 0.2 : 0.05)) * 100) / 100, 0, 1));
            else if (row === 'gate') setStep(i, 'gate', clamp(Math.round((s.gate + dir * (big ? 0.2 : 0.05)) * 100) / 100, 0.05, 1));
            else handled = false;
            break;
          }
          case ' ': case 'Enter':
            if (row === 'on' || row === 'accent' || row === 'slide') {
              const field = row;
              setStep(i, field, s[field] ? 0 : 1);
              if (row === 'on' && !s.on) previewStep(i);
            } else if (row === 'lock') {
              toggleLock(i, e.shiftKey);
            } else handled = false;
            break;
          default: handled = false;
        }
        if (!handled) return;
        e.preventDefault();
        e.stopPropagation();
        if (move) {
          const n = clamp(i + move, 0, SEQ_STEPS - 1);
          list.forEach((c, k) => { c.tabIndex = k === n ? 0 : -1; });
          list[n].focus();
        }
      });
      scope.on(cell, 'focus', () => list.forEach((c, k) => { c.tabIndex = k === i ? 0 : -1; }));
    });
  }

  // Audition a step when you set it (only while the transport is stopped).
  let previewOff = 0;
  function previewStep(i) {
    if (!music || !music.router || (music.transport && call(music.transport, 'isPlaying'))) return;
    const s = steps()[i];
    if (!s) return;
    const p = sel();
    const note = stepToMidi(s, store.get(`parts.${p}.seq.baseOctave`) ?? 3, store.get('global.scaleRoot') ?? 9, store.get('global.scaleType') ?? 1);
    call(music.router, 'noteOn', p, note, s.vel ?? 0.8, 'ui-preview');
    clearTimeout(previewOff);
    previewOff = setTimeout(() => call(music.router, 'noteOff', p, note, 'ui-preview'), 180);
  }

  // ---------------------------------------------------------------- playhead
  let lastCol = -1;
  function clearPlayhead() {
    if (lastCol >= 0 && cols[lastCol]) cols[lastCol].classList.remove('is-play');
    lastCol = -1;
  }
  if (hasMusic) {
    scope.add(listen(music.transport, 'step', (ev) => {
      if (!ev || ev.part !== sel()) return;
      const i = ev.step;
      schedule(() => {
        if (!call(music.transport, 'isPlaying')) return;
        clearPlayhead();
        if (cols[i]) { cols[i].classList.add('is-play'); lastCol = i; }
      });
    }));
    scope.add(listen(music.transport, 'state', (ev) => { if (!ev || !ev.playing) schedule(clearPlayhead); }));
  }
  scope.add(store.subscribe('ui.playing', () => { if (!store.get('ui.playing')) schedule(clearPlayhead); }));
  scope.add(() => clearTimeout(previewOff));

  render();
  return { el, dispose: scope.dispose };
}
