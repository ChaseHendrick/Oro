// Toasts: short, polite status messages (device connected, preset saved,
// recording saved, import problems). Announced to screen readers through an
// aria-live region; errors use role=alert so they are read immediately.

import { h } from './dom.js';
import { icon } from './icons.js';

const ICONS = { info: 'info', success: 'check', warn: 'warn', error: 'error' };

export function createToaster(host) {
  const region = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  host.appendChild(region);
  const MAX = 4;

  function dismiss(el) {
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  }

  // `actions` (2.11): several buttons, e.g. Step down / Keep / Don't ask again. Each dismisses the toast.
  function toast(message, { kind = 'info', timeout, action, actions, detail } = {}) {
    const buttons = (actions || (action ? [action] : [])).map(a => h('button', { type: 'button', class: 'toast-action', onClick: () => { dismiss(el); a.onClick?.(); } }, a.label));
    const ms = timeout ?? (kind === 'error' ? 7000 : kind === 'warn' ? 5500 : 3600);
    const el = h('div', { class: ['toast', `is-${kind}`], role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast-icon', html: icon(ICONS[kind] || 'info'), 'aria-hidden': 'true' }),
      h('div', { class: 'toast-body' },
        h('div', { class: 'toast-msg' }, message),
        detail ? h('div', { class: 'toast-detail' }, detail) : null),
      buttons.length > 1 ? h('div', { class: 'toast-actions' }, buttons) : buttons[0] || null,
      h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss notification', html: icon('close'), onClick: () => dismiss(el) }));
    region.appendChild(el);
    while (region.children.length > MAX) region.firstElementChild.remove();
    requestAnimationFrame(() => el.classList.add('is-in'));
    let timer = setTimeout(() => dismiss(el), ms);
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => { clearTimeout(timer); timer = setTimeout(() => dismiss(el), 1800); });
    return () => dismiss(el);
  }

  return toast;
}
