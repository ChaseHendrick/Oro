// Compact controls that bind to the store through a binding (see bind.js):
// segmented choice, toggle, select, stepper, mini slider, vertical fader and a
// drag-or-type number field. All are keyboard accessible and update in rAF.

import { toNorm, fromNorm, clamp } from '../core/params.js';
import { formatParam as formatValue } from './formats.js';
import { h, setText, setAttr, createScope } from './dom.js';
import { schedule } from './frame.js';
import { icon } from './icons.js';

function optionsFor(binding, options) {
  if (options) return options;
  return (binding.def.options || []).map((label, value) => ({ value, label }));
}

function disabler(el, focusEl, defaultTip) {
  return (on, reason = '') => {
    el.classList.toggle('is-disabled', !!on);
    for (const b of (focusEl ? [focusEl] : el.querySelectorAll('button, select, input, [role=slider], [role=spinbutton]'))) {
      if ('disabled' in b && b.tagName !== 'DIV') b.disabled = !!on;
      else setAttr(b, 'aria-disabled', on ? 'true' : null);
    }
    if (on && reason) el.dataset.tip = reason;
    else if (defaultTip) el.dataset.tip = defaultTip;
    else delete el.dataset.tip;
  };
}

/** Segmented radio group with a sliding highlight. */
export function createSegmented(ctx, binding, { options, label, className = '', iconOnly = false, size = 'md', onChange } = {}) {
  const scope = createScope();
  const opts = optionsFor(binding, options);
  const thumb = h('span', { class: 'seg-thumb', 'aria-hidden': 'true' });
  const buttons = opts.map((o) => h('button', {
    type: 'button', class: ['seg-btn', o.icon && 'has-icon'], role: 'radio', tabindex: '-1',
    'aria-label': iconOnly ? (o.aria || o.label) : (o.aria || null), dataset: { value: String(o.value), tip: o.tip || (iconOnly ? o.label : undefined) },
    html: o.icon ? icon(o.icon) + (iconOnly ? '' : `<span class="seg-text">${escapeHtml(o.label)}</span>`) : undefined,
  }, o.icon ? null : o.label));
  const el = h('div', { class: ['seg', `seg--${size}`, iconOnly && 'seg--icons', className], role: 'radiogroup', 'aria-label': label || binding.def.label }, thumb, buttons);

  let current;
  function render() {
    const v = binding.get();
    buttons.forEach((b, i) => {
      const on = String(opts[i].value) === String(v);
      setAttr(b, 'aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-on', on);
    });
    if (!buttons.some(b => b.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0;
    current = v;
    placeThumb();
  }
  function placeThumb() {
    const i = opts.findIndex(o => String(o.value) === String(current));
    const b = buttons[i];
    if (!b || !b.offsetWidth) { thumb.style.opacity = '0'; return; }
    thumb.style.opacity = '1';
    thumb.style.width = b.offsetWidth + 'px';
    thumb.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  function choose(i, focus) {
    const o = opts[i];
    if (!o || el.classList.contains('is-disabled')) return;
    binding.set(o.value);
    if (onChange) onChange(o.value);
    if (focus) buttons[i].focus();
  }
  buttons.forEach((b, i) => scope.on(b, 'click', () => choose(i, false)));
  scope.on(el, 'keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = buttons.length - 1;
    if (n >= 0) { e.preventDefault(); e.stopPropagation(); choose(n, true); }
  });
  scope.add(binding.subscribe(() => schedule(render)));
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => schedule(placeThumb));
    ro.observe(el);
    scope.add(() => ro.disconnect());
  }
  render();
  return { el, refresh: () => schedule(render), setDisabled: disabler(el), dispose: scope.dispose };
}

/** On/off button bound to a 0/1 value. */
export function createToggle(ctx, binding, { label, iconName, className = '', tip, ariaLabel, onChange, text = true } = {}) {
  const scope = createScope();
  const lbl = label ?? binding.def.label;
  const btn = h('button', {
    type: 'button', class: ['toggle', iconName && 'has-icon', className], 'aria-pressed': 'false',
    'aria-label': ariaLabel || (!text ? lbl : null), dataset: { tip: tip || binding.def.hint || undefined },
    html: (iconName ? icon(iconName) : '') + (text ? `<span class="toggle-text">${escapeHtml(lbl)}</span>` : ''),
  });
  function render() {
    const on = !!binding.get();
    setAttr(btn, 'aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
  }
  scope.on(btn, 'click', () => {
    const next = binding.get() ? 0 : 1;
    binding.set(next);
    if (onChange) onChange(next);
  });
  scope.add(binding.subscribe(() => schedule(render)));
  render();
  return { el: btn, refresh: () => schedule(render), setDisabled: disabler(btn, btn, tip), dispose: scope.dispose };
}

/** Native select (accessible everywhere, comfortable on touch) with our styling. */
export function createSelect(ctx, binding, { options, label, className = '', onChange, groups } = {}) {
  const scope = createScope();
  const opts = optionsFor(binding, options);
  const select = h('select', { class: 'select-native', 'aria-label': label || binding.def.label });
  if (groups) {
    for (const g of groups) {
      const og = h('optgroup', { label: g.label });
      for (const o of g.options) og.appendChild(h('option', { value: String(o.value) }, o.label));
      select.appendChild(og);
    }
  } else {
    for (const o of opts) select.appendChild(h('option', { value: String(o.value) }, o.label));
  }
  const el = h('div', { class: ['select', className] }, select, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  const all = groups ? groups.flatMap(g => g.options) : opts;
  function render() {
    const v = String(binding.get());
    if (select.value !== v) select.value = v;
  }
  scope.on(select, 'change', () => {
    const o = all.find(x => String(x.value) === select.value);
    if (!o) return;
    binding.set(o.value);
    if (onChange) onChange(o.value);
  });
  scope.add(binding.subscribe(() => schedule(render)));
  render();
  return { el, select, refresh: () => schedule(render), setDisabled: disabler(el, select), dispose: scope.dispose };
}

/** [-] value [+] for small integer ranges (length, octave). */
export function createStepper(ctx, binding, { label, format, className = '', min, max } = {}) {
  const scope = createScope();
  const def = binding.def;
  const lo = min ?? def.min, hi = max ?? def.max;
  const fmt = format || (v => formatValue(def, v));
  const lbl = label || def.label;
  const dec = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `Decrease ${lbl}`, tabindex: '-1', html: icon('minus') });
  const inc = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `Increase ${lbl}`, tabindex: '-1', html: icon('plus') });
  const val = h('span', { class: 'stepper-value', role: 'spinbutton', tabindex: '0', 'aria-label': lbl, 'aria-valuemin': String(lo), 'aria-valuemax': String(hi) });
  const el = h('div', { class: ['stepper', className] }, dec, val, inc);
  const get = () => Math.round(binding.get());
  const put = (v) => binding.set(clamp(Math.round(v), lo, hi));
  function render() {
    const v = get();
    setText(val, fmt(v));
    setAttr(val, 'aria-valuenow', String(v));
    setAttr(val, 'aria-valuetext', fmt(v));
    dec.disabled = v <= lo || el.classList.contains('is-disabled');
    inc.disabled = v >= hi || el.classList.contains('is-disabled');
  }
  scope.on(dec, 'click', () => put(get() - 1));
  scope.on(inc, 'click', () => put(get() + 1));
  scope.on(val, 'keydown', (e) => {
    const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 4, PageDown: -4 };
    if (e.key in map) { e.preventDefault(); e.stopPropagation(); put(get() + map[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); put(lo); }
    else if (e.key === 'End') { e.preventDefault(); put(hi); }
  });
  let acc = 0;
  scope.on(val, 'wheel', (e) => {
    e.preventDefault();
    acc += e.deltaY || e.deltaX;
    if (Math.abs(acc) >= 40) { put(get() + (acc < 0 ? 1 : -1)); acc = 0; }
  }, { passive: false });
  attachVerticalDrag(scope, val, () => get(), (v) => put(v), { pxPerStep: 14 });
  scope.add(binding.subscribe(() => schedule(render)));
  render();
  const setDis = disabler(el);
  return { el, refresh: () => schedule(render), setDisabled: (on, r) => { setDis(on, r); render(); }, dispose: scope.dispose };
}

/** Drag a value vertically in whole steps (used by steppers and sequencer cells). */
export function attachVerticalDrag(scope, target, get, put, { pxPerStep = 12, onStart, onEnd } = {}) {
  let st = null;
  scope.on(target, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    st = { id: e.pointerId, y: e.clientY, v: get(), moved: false };
    try { target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (onStart) onStart(e);
  });
  scope.on(target, 'pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dy = st.y - e.clientY;
    if (!st.moved && Math.abs(dy) < 4) return;
    st.moved = true;
    target.classList.add('is-dragging');
    const next = st.v + Math.round(dy / pxPerStep);
    if (next !== get()) put(next);
  });
  const end = (e) => {
    if (!st || (e && e.pointerId !== st.id)) return;
    const moved = st.moved;
    st = null;
    target.classList.remove('is-dragging');
    if (onEnd) onEnd(moved, e);
  };
  scope.on(target, 'pointerup', end);
  scope.on(target, 'pointercancel', end);
}

/**
 * Horizontal (or vertical) bar slider. Click/drag sets the value at the pointer
 * position; Shift-drag is relative and fine. Bipolar bars fill from the centre.
 */
export function createMiniSlider(ctx, binding, { label, format, bipolar, className = '', vertical = false, ariaLabel, live, relative = false } = {}) {
  const scope = createScope();
  const def = binding.def;
  const fmt = format || (v => formatValue(def, v));
  const bip = bipolar ?? (def.min < 0 && def.max > 0);
  const fillEl = h('span', { class: 'mslider-fill' });
  const thumb = h('span', { class: 'mslider-thumb' });
  const liveEl = live ? h('span', { class: 'mslider-live' }) : null;
  const track = h('span', { class: 'mslider-track' }, fillEl, liveEl, thumb);
  const el = h('div', {
    class: ['mslider', vertical && 'is-vertical', bip && 'is-bipolar', className], role: 'slider', tabindex: '0',
    'aria-label': ariaLabel || label || def.label, 'aria-orientation': vertical ? 'vertical' : 'horizontal',
    'aria-valuemin': String(def.min), 'aria-valuemax': String(def.max), dataset: { tip: def.hint || undefined },
  }, track);

  function render() {
    const v = binding.get();
    const n = toNorm(def, v);
    const origin = bip ? toNorm(def, 0) : 0;
    const a = Math.min(origin, n), b = Math.max(origin, n);
    if (vertical) {
      fillEl.style.bottom = (a * 100).toFixed(2) + '%';
      fillEl.style.height = ((b - a) * 100).toFixed(2) + '%';
      thumb.style.bottom = (n * 100).toFixed(2) + '%';
    } else {
      fillEl.style.left = (a * 100).toFixed(2) + '%';
      fillEl.style.width = ((b - a) * 100).toFixed(2) + '%';
      thumb.style.left = (n * 100).toFixed(2) + '%';
    }
    setAttr(el, 'aria-valuenow', String(Math.round(v * 1000) / 1000));
    setAttr(el, 'aria-valuetext', fmt(v));
    el.classList.toggle('is-zero', Math.abs(n - origin) < 0.004);
  }

  let drag = null;
  function posToNorm(e) {
    const r = track.getBoundingClientRect();
    return vertical ? clamp((r.bottom - e.clientY) / r.height, 0, 1) : clamp((e.clientX - r.left) / r.width, 0, 1);
  }
  scope.on(el, 'pointerdown', (e) => {
    if (el.getAttribute('aria-disabled') === 'true') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, n: toNorm(def, binding.get()), rel: e.shiftKey || relative, fine: e.shiftKey };
    el.classList.add('is-active');
    if (!drag.rel) binding.set(fromNorm(def, posToNorm(e)), { source: 'ui', gesture: true });
  });
  scope.on(el, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.rel || e.shiftKey) {
      const r = track.getBoundingClientRect();
      const d = vertical ? (drag.y - e.clientY) / r.height : (e.clientX - drag.x) / r.width;
      drag.n = clamp(drag.n + d * (e.shiftKey ? 0.2 : relative ? 1 : 0.2), 0, 1);
      drag.rel = true;
      binding.set(fromNorm(def, drag.n), { source: 'ui', gesture: true });
    } else {
      drag.n = posToNorm(e);
      binding.set(fromNorm(def, drag.n), { source: 'ui', gesture: true });
    }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const end = () => { drag = null; el.classList.remove('is-active'); };
  scope.on(el, 'pointerup', end);
  scope.on(el, 'pointercancel', end);
  scope.on(el, 'dblclick', () => binding.reset());
  scope.on(el, 'keydown', (e) => {
    if (el.getAttribute('aria-disabled') === 'true') return;
    const n = toNorm(def, binding.get());
    const discrete = def.curve === 'int' || def.curve === 'enum';
    const unit = discrete ? 1 / Math.max(1, def.max - def.min) : (e.shiftKey ? 0.002 : 0.01);
    const map = { ArrowUp: unit, ArrowRight: unit, ArrowDown: -unit, ArrowLeft: -unit, PageUp: 0.1, PageDown: -0.1 };
    let next = null;
    if (e.key in map) next = n + map[e.key];
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); binding.reset(); return; }
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    binding.set(fromNorm(def, clamp(next, 0, 1)));
  });
  scope.on(el, 'wheel', (e) => {
    if (el.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault();
    const d = e.deltaY || e.deltaX;
    binding.set(fromNorm(def, clamp(toNorm(def, binding.get()) - clamp(d, -80, 80) * (e.shiftKey ? 0.0003 : 0.0015), 0, 1)));
  }, { passive: false });
  scope.add(binding.subscribe(() => schedule(render)));
  render();
  return {
    el, refresh: () => schedule(render), setDisabled: disabler(el, el, def.hint), dispose: scope.dispose,
    setLive(n) {
      if (!liveEl) return;
      if (n == null) { liveEl.style.opacity = '0'; return; }
      liveEl.style.opacity = '1';
      if (vertical) liveEl.style.bottom = (clamp(n, 0, 1) * 100).toFixed(2) + '%';
      else liveEl.style.left = (clamp(n, 0, 1) * 100).toFixed(2) + '%';
    },
  };
}

/**
 * Number field you can drag vertically or click to type into (tempo, LFO rate).
 * Arrow keys step (Shift x10), Enter commits, Esc reverts.
 */
export function createDragNumber(ctx, binding, { label, format, parse, step = 1, pxPerStep = 3, className = '', suffix = '', exp = false } = {}) {
  const scope = createScope();
  const def = binding.def;
  const fmt = format || (v => String(Math.round(v)));
  const parser = parse || (t => parseFloat(String(t).replace(',', '.')));
  const input = h('input', {
    class: 'dragnum-input', type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off',
    'aria-label': label || def.label, role: 'spinbutton', 'aria-valuemin': String(def.min), 'aria-valuemax': String(def.max),
  });
  const el = h('div', { class: ['dragnum', className], dataset: { tip: def.hint || undefined } }, input, suffix ? h('span', { class: 'dragnum-suffix', 'aria-hidden': 'true' }, suffix) : null);
  let editing = false;

  function render() {
    const v = binding.get();
    if (!editing) input.value = fmt(v);
    setAttr(input, 'aria-valuenow', String(v));
    setAttr(input, 'aria-valuetext', fmt(v) + (suffix ? ' ' + suffix : ''));
  }
  function nudge(dir, big) {
    if (input.readOnly || input.disabled) return;
    const v = binding.get();
    if (exp) {
      binding.set(fromNorm(def, clamp(toNorm(def, v) + dir * (big ? 0.05 : 0.01), 0, 1)));
    } else {
      binding.set(clamp(v + dir * step * (big ? 10 : 1), def.min, def.max));
    }
  }
  function commit() {
    if (input.readOnly) { editing = false; render(); return; }
    const v = parser(input.value);
    if (Number.isFinite(v)) binding.set(clamp(v, def.min, def.max));
    editing = false;
    render();
  }

  let st = null;
  scope.on(input, 'pointerdown', (e) => {
    if (editing || input.disabled || input.readOnly) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    st = { id: e.pointerId, y: e.clientY, x: e.clientX, v: binding.get(), n: toNorm(def, binding.get()), moved: false };
    try { input.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  scope.on(input, 'pointermove', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dy = st.y - e.clientY + (e.clientX - st.x) * 0.5;
    if (!st.moved && Math.abs(dy) < 3) return;
    if (!st.moved) { st.moved = true; el.classList.add('is-dragging'); document.documentElement.classList.add('is-knob-dragging'); }
    if (exp) binding.set(fromNorm(def, clamp(st.n + dy / (e.shiftKey ? 2000 : 300), 0, 1)), { source: 'ui', gesture: true });
    else binding.set(clamp(st.v + Math.round(dy / (pxPerStep * (e.shiftKey ? 4 : 1))) * step, def.min, def.max), { source: 'ui', gesture: true });
  });
  const end = (e) => {
    if (!st || (e && e.pointerId !== st.id)) return;
    const moved = st.moved;
    st = null;
    el.classList.remove('is-dragging');
    document.documentElement.classList.remove('is-knob-dragging');
    if (!moved && e && e.type === 'pointerup') {
      editing = true;
      input.focus();
      input.select();
    }
  };
  scope.on(input, 'pointerup', end);
  scope.on(input, 'pointercancel', end);
  scope.on(input, 'focus', () => { editing = true; requestAnimationFrame(() => input.select()); });
  scope.on(input, 'blur', () => { if (editing) commit(); });
  scope.on(input, 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editing = false; render(); input.blur(); }
    else if (input.readOnly) return;
    else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1, e.shiftKey); editing = false; render(); editing = true; input.select(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1, e.shiftKey); editing = false; render(); editing = true; input.select(); }
  });
  scope.on(input, 'wheel', (e) => {
    if (input.disabled || input.readOnly) return;
    e.preventDefault();
    nudge((e.deltaY || e.deltaX) < 0 ? 1 : -1, e.shiftKey);
  }, { passive: false });
  scope.add(binding.subscribe(() => schedule(render)));
  render();
  return {
    el, input, refresh: () => schedule(render), dispose: scope.dispose,
    setDisabled(on, reason) { input.disabled = !!on; el.classList.toggle('is-disabled', !!on); if (reason) el.dataset.tip = reason; },
    setReadOnly(on) { input.readOnly = !!on; el.classList.toggle('is-readonly', !!on); },
  };
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Simple labelled group: a section header and a body. */
export function section(title, body, { className = '', aside = null, id } = {}) {
  return h('section', { class: ['panel-section', className], 'aria-label': title, id },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title' }, title), aside),
    h('div', { class: 'section-body' }, body));
}
