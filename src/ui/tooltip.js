// Hover tooltips for anything with data-tip (parameter hints, icon buttons).
// One delegated listener and one tooltip element for the whole app. Mouse only:
// touch users get the same information from labels and the help overlay.

import { h, setText } from './dom.js';
import { placeFloating } from './layers.js';

export function createTooltips(host, { enabled = () => true } = {}) {
  const tip = h('div', { class: 'tooltip', role: 'tooltip', 'aria-hidden': 'true' },
    h('div', { class: 'tooltip-title' }), h('div', { class: 'tooltip-text' }));
  const titleEl = tip.firstChild, textEl = tip.lastChild;
  host.appendChild(tip);
  let timer = 0, current = null;

  function hide() {
    clearTimeout(timer);
    current = null;
    tip.classList.remove('is-visible');
  }

  function show(el) {
    const text = el.dataset.tip;
    if (!text || !enabled() || !el.isConnected) return;
    if (el.closest('.is-dragging, .is-active')) return;
    setText(titleEl, el.dataset.tipTitle || '');
    titleEl.hidden = !el.dataset.tipTitle;
    setText(textEl, text);
    tip.classList.add('is-visible');
    placeFloating(tip, el, el.dataset.tipPlace || 'top-center', 8);
  }

  function onOver(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tip]');
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = setTimeout(() => show(el), el.dataset.tipDelay ? +el.dataset.tipDelay : 520);
  }

  document.addEventListener('pointerover', onOver);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);

  return {
    hide,
    dispose() {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('wheel', hide, { capture: true });
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
      tip.remove();
    },
  };
}
