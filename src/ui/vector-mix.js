import { h, createScope, setText } from './dom.js';
import { createKnob } from './knob.js';
export function createVectorMix(ctx) {
  const scope = createScope(), { store, binder } = ctx;
  const pad = h('div', { class: 'vector-pad', tabindex: '0', role: 'group', 'aria-label': 'Vector mixing pad. Arrow keys move, shift moves faster.' });
  const dot = h('span', { class: 'vector-dot', 'aria-hidden': 'true' });
  const corners = Array.from({ length: 4 }, (_, i) => h('span', { class: `vector-corner vector-corner--${i}` }));
  pad.append(...corners, dot);
  const bank = h('select', { class: 'select select--sm', 'aria-label': 'Vector track bank' });
  const amount = createKnob(ctx, binder.globalParam('vectorMix'), { size: 'sm', caption: 'both' });
  scope.add(amount.dispose);
  const readout = h('span', { class: 'section-aside', 'aria-live': 'polite' });
  let drag = null;
  const move = e => {
    const r = pad.getBoundingClientRect();
    store.batch(() => {
      store.set('global.vectorX', Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), { source: 'ui' });
      store.set('global.vectorY', Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), { source: 'ui' });
    });
  };
  scope.on(pad, 'pointerdown', e => {
    if (e.button && e.pointerType === 'mouse') return;
    e.preventDefault(); drag = e.pointerId; pad.focus(); pad.setPointerCapture(e.pointerId); move(e);
  });
  scope.on(pad, 'pointermove', e => { if (drag === e.pointerId) move(e); });
  scope.on(pad, 'pointerup', () => { drag = null; }); scope.on(pad, 'pointercancel', () => { drag = null; });
  scope.on(pad, 'keydown', e => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const delta = { ArrowLeft: [-step,0], ArrowRight: [step,0], ArrowUp: [0,-step], ArrowDown: [0,step] }[e.key];
    if (!delta) return;
    e.preventDefault(); e.stopPropagation();
    store.batch(() => {
      store.set('global.vectorX', Math.max(0, Math.min(1, (store.get('global.vectorX') || 0) + delta[0])), { source: 'ui' });
      store.set('global.vectorY', Math.max(0, Math.min(1, (store.get('global.vectorY') || 0) + delta[1])), { source: 'ui' });
    });
  });
  scope.on(bank, 'change', () => store.set('global.vectorBank', Number(bank.value), { source: 'ui' }));
  function render() {
    const parts = store.get('parts') || [], n = Math.max(1, Math.ceil(parts.length / 4));
    if (bank.options.length !== n) {
      bank.textContent = '';
      for (let i = 0; i < n; i++) bank.append(h('option', { value: i }, `Tracks ${i * 4 + 1} to ${Math.min(parts.length, i * 4 + 4)}`));
    }
    const b = Math.min(n - 1, store.get('global.vectorBank') || 0); bank.value = String(b);
    if (store.get('global.vectorBank') !== b) store.set('global.vectorBank', b, { source: 'ui' });
    const x = store.get('global.vectorX') ?? .5, y = store.get('global.vectorY') ?? .5;
    dot.style.left = `${x * 100}%`; dot.style.top = `${y * 100}%`;
    corners.forEach((el, i) => setText(el, parts[b * 4 + i]?.name || 'Empty'));
    setText(readout, `X ${Math.round(x * 100)}%, Y ${Math.round(y * 100)}%`);
  }
  scope.add(store.subscribe('global', render)); scope.add(store.subscribe('parts', render)); render();
  return { el: h('section', { class: 'dock-card vector-mix' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Vector mix'), bank),
    h('div', { class: 'vector-body' }, pad, amount.el),
    h('p', { class: 'popover-note' }, 'Blend four tracks with equal-power corner weights. Set Vector mix to 100% for the full crossfade.'), readout), dispose: scope.dispose };
}
