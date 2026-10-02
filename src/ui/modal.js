// Accessible modal dialog: role=dialog + aria-modal, focus trapped inside,
// the app behind it made inert, Esc / close button / backdrop click close it,
// and focus returns to whatever opened it.

import { h, focusables, uniqueId } from './dom.js';
import { icon } from './icons.js';

let openCount = 0;

export function openModal(layers, appRoot, { title, content, className = '', onClose, initialFocus, wide = false } = {}) {
  const titleId = uniqueId('dlg-title');
  const returnFocus = document.activeElement;
  const closeBtn = h('button', { type: 'button', class: 'icon-btn modal-close', 'aria-label': 'Close', html: icon('close') });
  const titleEl = h('h2', { class: 'modal-title', id: titleId }, title);
  const body = h('div', { class: 'modal-body' }, content);
  const dialog = h('div', {
    class: ['modal', wide && 'is-wide', className], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
  }, h('header', { class: 'modal-head' }, titleEl, closeBtn), body);
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  layers.host.appendChild(backdrop);
  let closed = false;

  openCount += 1;
  if (appRoot) appRoot.inert = true;

  const layer = { el: dialog, anchor: null, modal: true, close };
  const pop = layers.push(layer);

  function onKey(e) {
    if (e.key !== 'Tab') return;
    const items = focusables(dialog);
    if (!items.length) { e.preventDefault(); dialog.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  dialog.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => close('button'));
  let downOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (downOnBackdrop && e.target === backdrop) close('backdrop'); });

  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  const first = typeof initialFocus === 'string' ? dialog.querySelector(initialFocus) : initialFocus;
  (first || focusables(body)[0] || dialog).focus({ preventScroll: true });

  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    pop();
    dialog.removeEventListener('keydown', onKey);
    openCount -= 1;
    if (appRoot && openCount <= 0) { openCount = 0; appRoot.inert = false; }
    backdrop.classList.remove('is-open');
    backdrop.classList.add('is-closing');
    // The fade-out keeps the old dialog around briefly; take it out of the
    // accessibility tree and free its ids so a reopened dialog never clashes.
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.inert = true;
    for (const n of backdrop.querySelectorAll('[id]')) n.removeAttribute('id');
    setTimeout(() => backdrop.remove(), 200);
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    if (onClose) onClose(reason);
  }

  return { el: dialog, body, titleEl, close, isOpen: () => !closed };
}
