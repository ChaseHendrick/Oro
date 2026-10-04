// 2.12 Listening modes UI: the headphones button in the top bar (with a short
// label while a mode other than Normal is on, so it is never forgotten) and
// the same choice in Settings > Audio. The mode lives in store.ui.listenMode,
// saved per computer by prefs.js; the engine applies it (src/audio/listen.js).

import { h, createScope, setText } from './dom.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';
import { LISTEN_MODES } from '../audio/listen.js';

const NOTE = 'Only changes what you hear. Recordings, the looper, bounces and exports never include it.';
const SHORT = { normal: '', headphones: 'Phones', mono: 'Mono', small: 'Small', swap: 'Swap' };

const current = (store) => {
  const v = store.get('ui.listenMode');
  return LISTEN_MODES.some(m => m.value === v) ? v : 'normal';
};

/** Radio list of the modes (popover and Settings). */
export function createListenChoices(ctx, { name = 'listen-mode', onPick = null } = {}) {
  const scope = createScope();
  const { store } = ctx;
  const inputs = [];
  const list = h('div', { class: 'listen-choices', role: 'radiogroup', 'aria-label': 'Listening mode' },
    LISTEN_MODES.map((m) => {
      const input = h('input', { type: 'radio', name, value: m.value });
      inputs.push(input);
      scope.on(input, 'change', () => { if (input.checked) { store.set('ui.listenMode', m.value, { source: 'ui' }); if (onPick) onPick(m.value); } });
      return h('label', { class: 'listen-choice' }, input, h('span', { class: 'listen-choice-text' }, h('span', { class: 'listen-choice-label' }, m.label), h('span', { class: 'setting-hint' }, m.text)));
    }));
  const render = () => { const v = current(store); for (const i of inputs) i.checked = i.value === v; };
  scope.add(store.subscribe('ui.listenMode', render));
  render();
  return { el: list, dispose: scope.dispose };
}

/** Top bar button. */
export function createListenButton(ctx) {
  const scope = createScope();
  const { store } = ctx;
  const badge = h('span', { class: 'listen-badge' });
  const btn = h('button', {
    type: 'button', class: 'icon-btn listen-btn', 'aria-haspopup': 'dialog',
    html: icon('headphones'),
  });
  btn.appendChild(badge);
  let pop = null;
  scope.on(btn, 'click', () => {
    if (pop && pop.isOpen()) { pop.close(); return; }
    const choices = createListenChoices(ctx, { name: 'listen-mode-pop' });
    const body = h('div', { class: 'listen-pop' },
      h('div', { class: 'popover-title' }, 'Listen'),
      choices.el,
      h('p', { class: 'popover-note' }, NOTE));
    pop = openPopover(ctx.layers, btn, body, { className: 'popover--listen', label: 'Listening mode', placement: 'bottom-end', onClose: () => choices.dispose() });
  });
  const render = () => {
    const v = current(store);
    const m = LISTEN_MODES.find(x => x.value === v);
    btn.classList.toggle('is-on', v !== 'normal');
    setText(badge, SHORT[v] || '');
    btn.setAttribute('aria-label', v === 'normal' ? 'Listening mode: Normal' : `Listening mode: ${m.label} (only what you hear)`);
    btn.dataset.tip = v === 'normal' ? 'Listen: headphones crossfeed, mono check, small speaker preview' : `Listening: ${m.label}. Only what you hear changes; exports are unaffected`;
  };
  scope.add(store.subscribe('ui.listenMode', render));
  render();
  return { el: btn, dispose: () => { if (pop && pop.isOpen()) pop.close(); scope.dispose(); } };
}

export { NOTE as LISTEN_NOTE };
