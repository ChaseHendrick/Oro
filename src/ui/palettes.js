// Map palette picker: one swatch per palette the 3D view offers
// (visuals.palettes() -> [{ name, dark: [hex...], light: [hex...] }], valley to
// peak), drawn for the current theme. Used in Settings > General and in the
// map toolbar's palette popover. Writes ui.palette (the visuals follow it).

import { h, createScope, call, has } from './dom.js';
import { openPopover } from './layers.js';
import { schedule } from './frame.js';

const FALLBACK = ['Natural', 'Aurora', 'Ember', 'Mono'];

/** Normalise whatever the visuals report into [{ name, dark: [hex], light: [hex] }]. */
export function paletteList(visuals) {
  let src = null;
  if (visuals) {
    try { src = has(visuals, 'palettes') ? visuals.palettes() : visuals.palettes; } catch { src = null; }
  }
  if (!Array.isArray(src) || !src.length) src = visuals ? FALLBACK : [];
  return src.map((p, i) => {
    if (typeof p === 'string') return { name: p, dark: [], light: [] };
    const ramp = (r) => (Array.isArray(r) ? r.filter(c => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)) : []);
    return { name: String((p && p.name) || `Palette ${i + 1}`), dark: ramp(p && p.dark), light: ramp(p && p.light) };
  });
}

/** CSS gradient for a ramp, or '' when there is nothing to draw. */
export function rampGradient(colors) {
  if (!colors || !colors.length) return '';
  if (colors.length === 1) return colors[0];
  return `linear-gradient(90deg, ${colors.map((c, i) => `${c} ${Math.round((i / (colors.length - 1)) * 100)}%`).join(', ')})`;
}

export function createPalettePicker(ctx, { className = '' } = {}) {
  const scope = createScope();
  const { store, visuals } = ctx;
  const list = paletteList(visuals);
  const ok = !!visuals && list.length > 0;
  const buttons = list.map((p, i) => h('button', {
    type: 'button', class: 'palette-swatch', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { index: String(i) },
  }, h('span', { class: 'palette-ramp', 'aria-hidden': 'true' }), h('span', { class: 'palette-name' }, p.name)));
  const note = h('p', { class: 'palette-note' });
  const group = h('div', { class: 'palette-list', role: 'radiogroup', 'aria-label': 'Map palette' }, buttons);
  const el = h('div', { class: ['palette-picker', className] }, group, note);

  const current = () => {
    const v = Number(store.get('ui.palette'));
    return Number.isInteger(v) && v >= 0 && v < list.length ? v : 0;
  };
  function render() {
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    const cur = current();
    buttons.forEach((b, i) => {
      const on = i === cur;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-on', on);
      const grad = rampGradient(list[i][theme].length ? list[i][theme] : list[i].dark);
      b.firstChild.style.background = grad || '';
      b.firstChild.classList.toggle('is-plain', !grad);
    });
    const style = store.get('ui.renderStyle');
    note.textContent = !ok ? 'The 3D view is not running, so there are no palettes to pick.'
      : style === 'heat' ? 'Heat map uses its own colour scale, so the palette shows in the other styles.'
      : style === 'normals' ? 'Normals shows surface direction. Palettes apply to the other map styles.' : '';
    note.hidden = !note.textContent;
  }
  function choose(i, focus) {
    if (!ok || i < 0 || i >= list.length) return;
    call(visuals, 'setPalette', i);
    store.set('ui.palette', i, { source: 'ui' });
    if (focus) buttons[i].focus();
  }
  buttons.forEach((b, i) => scope.on(b, 'click', () => choose(i, false)));
  scope.on(group, 'keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = buttons.length - 1;
    if (n >= 0) { e.preventDefault(); e.stopPropagation(); choose(n, true); }
  });
  scope.add(store.subscribe('ui.palette', () => schedule(render)));
  scope.add(store.subscribe('ui.renderStyle', () => schedule(render)));
  scope.on(window, 'orograph:theme', () => schedule(render));
  if (!ok) {
    buttons.forEach(b => { b.disabled = true; });
    group.setAttribute('aria-disabled', 'true');
  }
  render();
  return { el, dispose: scope.dispose, count: list.length };
}

export function openPalettePopover(ctx, anchor) {
  const scope = createScope();
  const picker = createPalettePicker(ctx, { className: 'palette-picker--pop' });
  scope.add(picker.dispose);
  const body = h('div', { class: 'palette-pop' }, h('div', { class: 'popover-title' }, 'Map palette'), picker.el);
  return openPopover(ctx.layers, anchor, body, {
    className: 'popover--palette', label: 'Map palette', placement: 'bottom-start', focus: '.palette-swatch[tabindex="0"]',
    onClose: () => scope.dispose(),
  });
}
