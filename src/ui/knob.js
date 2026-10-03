// Rotary knob: SVG, 270 degree sweep. Shows the value arc in the part colour
// (bipolar parameters fill from their zero point), a thin outer arc for the
// modulation range when the parameter is modulated, and a bead that follows
// the live modulated value reported by the audio engine.
//
// Interactions: vertical or horizontal drag (Shift = fine), wheel, double-click
// or Ctrl/Cmd-click to reset, full keyboard support as an ARIA slider, Enter to
// type a value, right-click or long-press for the context menu (Modulate...,
// MIDI Learn, Remove mapping, Reset).

import { toNorm, fromNorm, clamp } from '../core/params.js';
import { formatParam } from './formats.js';
import { h, s, setText, setAttr, createScope } from './dom.js';
import { schedule } from './frame.js';
import { openMenu } from './menu.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';

const START = -135;
const SWEEP = 270;
const C = 28; // centre of the 56 x 56 viewBox
const R_TRACK = 21.5;
const R_MOD = 26;
const R_FACE = 16;

export function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

export function normToAngle(n) {
  return START + SWEEP * clamp(n, 0, 1);
}

/** SVG arc path along the knob sweep between two normalised positions. */
export function arcPath(cx, cy, r, n0, n1) {
  let a = clamp(Math.min(n0, n1), 0, 1), b = clamp(Math.max(n0, n1), 0, 1);
  if (b - a < 0.0015) b = Math.min(1, a + 0.0015);
  const a0 = normToAngle(a), a1 = normToAngle(b);
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function isBipolar(def) {
  return def.curve === 'bipow' || (def.min < 0 && def.max > 0);
}

/** Normalised position of the arc's origin (0, or the zero point if bipolar). */
export function arcOrigin(def) {
  if (!isBipolar(def)) return 0;
  return toNorm(def, 0);
}

export function isDiscrete(def) {
  return def.curve === 'int' || def.curve === 'enum' || def.curve === 'bool';
}

/** Drag distance (px) to normalised change. ~220 px for the full range. */
export function dragToNorm(dx, dy, fine) {
  return (dx - dy) * (fine ? 1 / 1400 : 1 / 220);
}

/** Step a discrete parameter by whole units; continuous by a normalised amount. */
export function stepValue(def, value, units, fineNorm) {
  if (isDiscrete(def)) {
    const lo = def.curve === 'bipow' ? -def.max : def.min;
    return clamp(Math.round(value) + units, lo, def.max);
  }
  return fromNorm(def, clamp(toNorm(def, value) + fineNorm, 0, 1));
}

/** Parse what a user typed into a value for this parameter (or null). */
export function parseTyped(def, text) {
  const raw = String(text).trim().toLowerCase();
  if (!raw) return null;
  if (def.options) {
    const i = def.options.findIndex(o => o.toLowerCase() === raw);
    if (i >= 0) return i;
  }
  const m = raw.replace(',', '.').match(/^([+-]?\d*\.?\d+)\s*([a-z%°]*)$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const suffix = m[2];
  if (!Number.isFinite(v)) return null;
  if (def.unit === 'Hz' && (suffix === 'k' || suffix === 'khz')) v *= 1000;
  else if (def.unit === 's' && suffix === 'ms') v /= 1000;
  else if (!def.unit && !def.options && def.curve !== 'int' && Math.max(Math.abs(def.min), Math.abs(def.max)) <= 1) {
    v /= 100; // plain 0..1 parameters are shown as percentages
  }
  const lo = def.curve === 'bipow' ? -def.max : def.min;
  return clamp(v, lo, def.max);
}

let defsReady = false;
/** One shared gradient for every knob face, coloured by theme tokens. */
function ensureDefs() {
  if (defsReady || typeof document === 'undefined') return;
  defsReady = true;
  const grad = s('radialGradient', { id: 'og-knob-face', cx: '38%', cy: '28%', r: '78%' },
    s('stop', { offset: '0%', style: 'stop-color: var(--knob-face-1)' }),
    s('stop', { offset: '100%', style: 'stop-color: var(--knob-face-2)' }));
  const svg = s('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false', style: 'position:absolute;width:0;height:0;overflow:hidden' }, s('defs', null, grad));
  document.body.appendChild(svg);
}

export function createKnob(ctx, binding, opts = {}) {
  ensureDefs();
  const def = binding.def;
  const {
    size = 'md', format = v => formatParam(def, v), caption = 'swap',
    modulatable = !!(def.mod && binding.scope === 'part'), ariaLabel, className = '',
    label: labelOpt, onChange, learnable = true,
  } = opts;
  const scope = createScope();
  const labelFn = typeof labelOpt === 'function' ? labelOpt : () => (labelOpt ?? def.label);
  const discrete = isDiscrete(def);
  const steps = discrete ? Math.round(def.max - (def.curve === 'bipow' ? -def.max : def.min)) : 0;

  // ---- DOM
  const face = s('circle', { class: 'knob-face', cx: C, cy: C, r: R_FACE });
  const faceRing = s('circle', { class: 'knob-face-ring', cx: C, cy: C, r: R_FACE });
  const track = s('path', { class: 'knob-track', d: arcPath(C, C, R_TRACK, 0, 1) });
  const ticks = s('g', { class: 'knob-ticks' });
  if (discrete && steps > 0 && steps <= 12) {
    for (let i = 0; i <= steps; i++) {
      const [x, y] = polar(C, C, R_MOD, normToAngle(i / steps));
      ticks.appendChild(s('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: 0.9 }));
    }
  }
  const modArc = s('path', { class: 'knob-modrange', d: '' });
  const fill = s('path', { class: 'knob-fill', d: '' });
  const pointer = s('line', { class: 'knob-pointer', x1: C, y1: C - R_FACE + 4.5, x2: C, y2: C - R_FACE + 10 });
  const pointerG = s('g', { class: 'knob-pointer-g' }, pointer);
  const live = s('circle', { class: 'knob-live', cx: C, cy: C - R_TRACK, r: 2.6 });
  const svg = s('svg', { class: 'knob-svg', viewBox: '0 0 56 56', 'aria-hidden': 'true', focusable: 'false' },
    face, faceRing, track, ticks, modArc, fill, pointerG, live);

  const dial = h('div', {
    class: 'knob-dial', role: 'slider', tabindex: '0',
    'aria-valuemin': String(def.curve === 'bipow' ? -def.max : def.min), 'aria-valuemax': String(def.max),
  }, svg);
  if (def.hint) { dial.dataset.tip = def.hint; dial.dataset.tipTitle = labelFn(); }
  const labelEl = h('span', { class: 'knob-label' });
  const valueEl = h('span', { class: 'knob-value' });
  const midiPip = h('span', { class: 'knob-midi', title: 'Mapped to MIDI', 'aria-hidden': 'true' });
  const el = h('div', { class: ['knob', `knob--${size}`, `caption-${caption}`, className], dataset: { param: def.id } },
    dial, h('div', { class: 'knob-caption' }, labelEl, valueEl), midiPip);

  // ---- state
  let lastValue = NaN, lastLabel = '', lastModKey = '';
  let liveN = null, liveShown = false, modActive = false;
  let disabled = false, disabledReason = '';

  function value() {
    const v = binding.get();
    return typeof v === 'number' && Number.isFinite(v) ? v : def.default;
  }

  function setValue(v, meta) {
    if (disabled) return;
    const before = value();
    binding.set(v, meta);
    const after = value();
    if (after !== before && onChange) onChange(after);
  }

  function render() {
    const v = value();
    const lbl = labelFn();
    if (lbl !== lastLabel) {
      lastLabel = lbl;
      setText(labelEl, lbl);
      setAttr(dial, 'aria-label', ariaLabel ? ariaLabel(lbl) : lbl);
      if (def.hint) dial.dataset.tipTitle = lbl;
    }
    if (v !== lastValue) {
      lastValue = v;
      const n = toNorm(def, v);
      fill.setAttribute('d', arcPath(C, C, R_TRACK, arcOrigin(def), n));
      pointerG.setAttribute('transform', `rotate(${normToAngle(n).toFixed(2)} ${C} ${C})`);
      const text = format(v);
      setText(valueEl, text);
      setAttr(dial, 'aria-valuenow', String(Math.round(v * 1000) / 1000));
      setAttr(dial, 'aria-valuetext', text);
      el.classList.toggle('is-zero', isBipolar(def) ? Math.abs(n - arcOrigin(def)) < 0.004 : n < 0.004);
    }
    renderMod();
  }

  function modState() {
    const path = modulatable ? binding.modPath() : null;
    return path ? ctx.store.get(path) : null;
  }

  function renderMod() {
    const m = modState();
    const depth = m ? m.lfoDepth || 0 : 0;
    const env = m ? m.envDepth || 0 : 0;
    const n = toNorm(def, value());
    const ctrlRange = [1,2,3,4].reduce((sum,i) => sum + Math.abs(m?.[`ctrl${i}Depth`] || 0), 0);
    const key = `${depth}|${env}|${ctrlRange}|${n}`;
    if (key === lastModKey) return;
    lastModKey = key;
    modActive = Math.abs(depth) > 0.0005 || Math.abs(env) > 0.0005 || ctrlRange > 0.0005;
    el.classList.toggle('is-modulated', modActive);
    if (!modActive) { modArc.setAttribute('d', ''); return; }
    const lo = clamp(n - Math.abs(depth) + Math.min(0, env) - ctrlRange, 0, 1);
    const hi = clamp(n + Math.abs(depth) + Math.max(0, env) + ctrlRange, 0, 1);
    modArc.setAttribute('d', arcPath(C, C, R_MOD, lo, hi));
  }

  const invalidate = () => schedule(render);

  // Live modulated value, driven by the app's single frame loop.
  function liveFrame() {
    if (!modActive || disabled) { if (liveShown) { liveShown = false; el.classList.remove('has-live'); } return; }
    const target = ctx.tele ? ctx.tele.norm(binding.part(), def.id) : null;
    if (target == null) { if (liveShown) { liveShown = false; el.classList.remove('has-live'); } return; }
    liveN = liveN == null ? target : liveN + (target - liveN) * 0.45;
    const [x, y] = polar(C, C, R_TRACK, normToAngle(liveN));
    live.setAttribute('cx', x.toFixed(2));
    live.setAttribute('cy', y.toFixed(2));
    if (!liveShown) { liveShown = true; el.classList.add('has-live'); }
  }
  if (modulatable && ctx.live) scope.add(ctx.live.add(liveFrame));

  scope.add(binding.subscribe(() => { liveN = null; invalidate(); }));
  if (modulatable) {
    // The mod path changes with the selected part, so follow it like the value.
    let modOff = ctx.store.subscribe(binding.modPath(), invalidate);
    scope.add(() => modOff());
    scope.add(ctx.store.subscribe('ui.selectedPart', () => {
      modOff();
      modOff = ctx.store.subscribe(binding.modPath(), invalidate);
    }));
  }

  // ---- MIDI mapping indicator
  function learnTarget() { return learnable && ctx.midiOk() ? binding.learnTarget() : null; }
  function refreshMidi() {
    const t = learnTarget();
    el.classList.toggle('is-mapped', !!(t && ctx.findMapping(t)));
  }
  if (ctx.bus) scope.add(ctx.bus.on('mappings', refreshMidi));
  scope.add(ctx.store.subscribe('ui.selectedPart', refreshMidi));
  refreshMidi();

  // ---- pointer
  let drag = null;
  let longPress = 0;

  function onPointerDown(e) {
    if (disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.ctrlKey || e.metaKey) && e.pointerType === 'mouse') { e.preventDefault(); setValue(def.default); return; }
    e.preventDefault();
    dial.focus({ preventScroll: true });
    try { dial.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, n: toNorm(def, value()), moved: false };
    el.classList.add('is-active');
    if (e.pointerType !== 'mouse') {
      clearTimeout(longPress);
      longPress = setTimeout(() => {
        if (drag && !drag.moved) { endDrag(); openContextMenu({ x: e.clientX, y: e.clientY }); }
      }, 520);
    }
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
      drag.moved = true;
      clearTimeout(longPress);
      document.documentElement.classList.add('is-knob-dragging');
      el.classList.add('is-dragging');
      ctx.tooltips?.hide();
    }
    drag.n = clamp(drag.n + dragToNorm(dx, dy, e.shiftKey), 0, 1);
    const next = fromNorm(def, drag.n);
    if (next !== value()) setValue(next, { source: 'ui', gesture: true });
  }

  function endDrag() {
    clearTimeout(longPress);
    if (!drag) return;
    try { dial.releasePointerCapture(drag.id); } catch { /* already released */ }
    drag = null;
    el.classList.remove('is-active', 'is-dragging');
    document.documentElement.classList.remove('is-knob-dragging');
  }

  scope.on(dial, 'pointerdown', onPointerDown);
  scope.on(dial, 'pointermove', onPointerMove);
  scope.on(dial, 'pointerup', endDrag);
  scope.on(dial, 'pointercancel', endDrag);
  scope.on(dial, 'lostpointercapture', endDrag);
  scope.on(dial, 'dblclick', (e) => { e.preventDefault(); if (!disabled) setValue(def.default); });

  let wheelAcc = 0;
  scope.on(dial, 'wheel', (e) => {
    if (disabled) return;
    e.preventDefault();
    let d = e.deltaY || e.deltaX;
    if (e.deltaMode === 1) d *= 16;
    if (discrete) {
      wheelAcc += d;
      if (Math.abs(wheelAcc) >= 40) {
        const units = wheelAcc < 0 ? 1 : -1;
        wheelAcc = 0;
        setValue(stepValue(def, value(), units, 0));
      }
      return;
    }
    const k = e.shiftKey ? 0.00025 : 0.0016;
    setValue(fromNorm(def, clamp(toNorm(def, value()) - clamp(d, -80, 80) * k, 0, 1)));
  }, { passive: false });

  scope.on(dial, 'keydown', (e) => {
    if (disabled) return;
    const v = value();
    const big = discrete ? Math.max(1, Math.round(steps / 8)) : 0;
    let next = null;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': next = stepValue(def, v, 1, e.shiftKey ? 0.002 : 0.01); break;
      case 'ArrowDown': case 'ArrowLeft': next = stepValue(def, v, -1, e.shiftKey ? -0.002 : -0.01); break;
      case 'PageUp': next = stepValue(def, v, big, 0.1); break;
      case 'PageDown': next = stepValue(def, v, -big, -0.1); break;
      case 'Home': next = fromNorm(def, 0); break;
      case 'End': next = fromNorm(def, 1); break;
      case 'Delete': case 'Backspace': next = def.default; break;
      case 'Enter': e.preventDefault(); openEntry(); return;
      case 'ContextMenu': e.preventDefault(); openContextMenu(dial); return;
      default:
        if (e.key === 'F10' && e.shiftKey) { e.preventDefault(); openContextMenu(dial); }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    setValue(next);
  });

  scope.on(dial, 'contextmenu', (e) => {
    e.preventDefault();
    if (disabled) return;
    endDrag();
    openContextMenu(e.pointerType === 'touch' || (e.clientX === 0 && e.clientY === 0) ? dial : { x: e.clientX, y: e.clientY });
  });

  // ---- typed value entry
  function openEntry() {
    if (disabled || !ctx.layers) return;
    const input = h('input', { class: 'field knob-entry-input', type: 'text', value: format(value()), 'aria-label': `Type a value for ${labelFn()}`, spellcheck: 'false', autocomplete: 'off' });
    const pop = openPopover(ctx.layers, dial, h('div', { class: 'knob-entry' }, input), { className: 'popover--entry', label: `${labelFn()} value`, placement: 'bottom-center' });
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = parseTyped(def, input.value);
        if (v != null) setValue(v);
        pop.close('enter');
      }
    });
  }

  // ---- context menu
  let menuAt = 0;
  function openContextMenu(at) {
    if (!ctx.layers) return;
    // A touch long-press can also raise a native contextmenu event; open once.
    if (performance.now() - menuAt < 800) return;
    menuAt = performance.now();
    const target = learnTarget();
    const mapping = target ? ctx.findMapping(target) : null;
    const items = [{ heading: labelFn() }];
    if (modulatable && ctx.openModPopover) {
      items.push({ label: 'Modulate...', icon: icon('mod'), onSelect: () => ctx.openModPopover(binding, dial) });
    }
    if (target) {
      items.push({ label: 'MIDI Learn', icon: icon('learn'), hint: mapping ? `CC ${mapping.cc}` : '', onSelect: () => startLearn() });
      if (mapping) items.push({ label: 'Remove MIDI mapping', icon: icon('close'), onSelect: () => ctx.unmap(target) });
    }
    items.push({ label: 'Type a value...', icon: icon('edit'), hint: 'Enter', onSelect: () => openEntry() });
    items.push({ separator: true });
    items.push({ label: `Reset to ${format(def.default)}`, icon: icon('init'), hint: 'Double-click', onSelect: () => setValue(def.default) });
    openMenu(ctx.layers, at, items, { label: `${labelFn()} options` });
  }

  function startLearn() {
    const target = learnTarget();
    if (!target || !ctx.learn) return;
    el.classList.add('is-learning');
    ctx.learn.start(target, labelFn(), () => { el.classList.remove('is-learning'); refreshMidi(); });
  }

  render();

  return {
    el,
    dial,
    binding,
    refresh: invalidate,
    openMenu: openContextMenu,
    setDisabled(on, reason = '') {
      disabled = !!on;
      disabledReason = reason;
      el.classList.toggle('is-disabled', disabled);
      setAttr(dial, 'aria-disabled', disabled ? 'true' : null);
      if (disabled && reason) { dial.dataset.tip = reason; }
      else if (def.hint) dial.dataset.tip = def.hint;
      else delete dial.dataset.tip;
    },
    get disabledReason() { return disabledReason; },
    dispose() { endDrag(); scope.dispose(); },
  };
}
