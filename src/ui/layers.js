// Floating layers: popovers, menus, the settings dialog, MIDI learn. One stack
// decides what Esc closes (always the top-most layer) and which layers an
// outside click dismisses. Every layer is { el, anchor, modal, close(reason) }.

import { h, focusables } from './dom.js';

export function createLayers() {
  const host = h('div', { class: 'layer-host' });
  document.body.appendChild(host);
  const stack = [];

  function onKey(e) {
    if (e.key !== 'Escape' || !stack.length) return;
    const top = stack[stack.length - 1];
    e.preventDefault();
    e.stopPropagation();
    top.close('escape');
  }

  function onPointer(e) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const layer = stack[i];
      if (contains(layer, e.target)) break;
      if (layer.modal) break;
      if (layer.dismissOnOutside !== false) layer.close('outside');
    }
  }

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);

  return {
    host,
    push(layer) {
      stack.push(layer);
      return () => {
        const i = stack.indexOf(layer);
        if (i >= 0) stack.splice(i, 1);
      };
    },
    count: () => stack.length,
    hasModal: () => stack.some(l => l.modal),
    closeAll(reason = 'close') {
      for (const layer of [...stack].reverse()) layer.close(reason);
    },
    dispose() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      host.remove();
    },
  };
}

function contains(layer, target) {
  if (!target || !(target instanceof Node)) return false;
  if (layer.el && layer.el.contains(target)) return true;
  if (layer.anchor instanceof Node && layer.anchor.contains(target)) return true;
  return false;
}

const MARGIN = 8;

/** Place `el` next to an anchor element or a {x, y} point, inside the window. */
export function placeFloating(el, anchor, placement = 'bottom-start', gap = 6) {
  const vw = window.innerWidth, vh = window.innerHeight;
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.maxHeight = '';
  const pw = el.offsetWidth, ph = el.offsetHeight;
  let rect;
  if (anchor instanceof Element) rect = anchor.getBoundingClientRect();
  else rect = { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };

  const [side, align] = placement.split('-');
  let x, y, finalSide = side;
  if (side === 'bottom' || side === 'top') {
    const below = vh - rect.bottom - gap - MARGIN;
    const above = rect.top - gap - MARGIN;
    finalSide = side === 'bottom' ? (below >= ph || below >= above ? 'bottom' : 'top') : (above >= ph || above >= below ? 'top' : 'bottom');
    y = finalSide === 'bottom' ? rect.bottom + gap : rect.top - gap - ph;
    if (align === 'end') x = rect.right - pw;
    else if (align === 'center') x = rect.left + rect.width / 2 - pw / 2;
    else x = rect.left;
    const room = finalSide === 'bottom' ? below : above;
    if (ph > room && room > 120) {
      el.style.maxHeight = room + 'px';
      if (finalSide === 'top') y = rect.top - gap - room;
    }
  } else {
    const right = vw - rect.right - gap - MARGIN;
    finalSide = side === 'right' ? (right >= pw ? 'right' : 'left') : (rect.left - gap - MARGIN >= pw ? 'left' : 'right');
    x = finalSide === 'right' ? rect.right + gap : rect.left - gap - pw;
    y = align === 'end' ? rect.bottom - ph : align === 'center' ? rect.top + rect.height / 2 - ph / 2 : rect.top;
  }
  const h2 = el.offsetHeight;
  x = Math.max(MARGIN, Math.min(x, vw - pw - MARGIN));
  y = Math.max(MARGIN, Math.min(y, vh - h2 - MARGIN));
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';
  el.dataset.side = finalSide;
  return finalSide;
}

/**
 * Open a non-modal popover anchored to an element (or point). Returns
 * { el, close(), reposition() }. Closes on Esc, outside click, or when focus
 * leaves it; focus returns to the anchor when it was inside the popover.
 */
export function openPopover(layers, anchor, content, opts = {}) {
  const {
    className = '', label = '', role = 'dialog', placement = 'bottom-start',
    focus = true, onClose = null, gap = 6, closeOnBlur = true,
  } = opts;
  const el = h('div', { class: ['popover', className], role, 'aria-label': label || null, tabindex: '-1' }, content);
  layers.host.appendChild(el);
  const returnFocus = document.activeElement;
  let closed = false;

  const reposition = () => { if (!closed) placeFloating(el, anchor, placement, gap); };
  reposition();
  requestAnimationFrame(() => el.classList.add('is-open'));

  const onResize = () => reposition();
  window.addEventListener('resize', onResize);
  const onFocusOut = (e) => {
    if (!closeOnBlur || closed) return;
    const to = e.relatedTarget;
    if (to && !el.contains(to) && !(anchor instanceof Node && anchor.contains(to)) && !to.closest?.('.popover')) close('blur');
  };
  el.addEventListener('focusout', onFocusOut);

  const layer = { el, anchor: anchor instanceof Node ? anchor : null, modal: false, close };
  const pop = layers.push(layer);

  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    pop();
    window.removeEventListener('resize', onResize);
    el.removeEventListener('focusout', onFocusOut);
    const hadFocus = el.contains(document.activeElement) || document.activeElement === document.body;
    el.classList.remove('is-open');
    el.classList.add('is-closing');
    setTimeout(() => el.remove(), 140);
    if (hadFocus && reason !== 'outside') {
      const target = anchor instanceof HTMLElement && anchor.isConnected ? anchor : returnFocus;
      if (target && typeof target.focus === 'function' && target.isConnected) target.focus({ preventScroll: true });
    }
    if (onClose) onClose(reason);
  }

  if (focus) {
    const first = typeof focus === 'string' ? el.querySelector(focus) : focusables(el)[0];
    (first || el).focus({ preventScroll: true });
  }
  return { el, close, reposition, isOpen: () => !closed };
}
