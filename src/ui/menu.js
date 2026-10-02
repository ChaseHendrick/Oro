// Context / dropdown menu built on the popover layer: role=menu, arrow-key
// navigation, Enter/Space to activate, Esc to close.

import { h } from './dom.js';
import { openPopover } from './layers.js';

/**
 * items: [{ label, onSelect, icon?, hint?, disabled?, danger?, checked? } | { separator: true } | { heading }]
 */
export function openMenu(layers, anchor, items, { label = 'Menu', placement = 'bottom-start' } = {}) {
  const buttons = [];
  const list = h('div', { class: 'menu-list' });
  let pop = null;
  for (const item of items) {
    if (!item) continue;
    if (item.separator) { list.appendChild(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (item.heading) { list.appendChild(h('div', { class: 'menu-heading', role: 'presentation' }, item.heading)); continue; }
    const btn = h('button', {
      type: 'button',
      class: ['menu-item', item.danger && 'is-danger', item.checked && 'is-checked'],
      role: item.checked != null ? 'menuitemcheckbox' : 'menuitem',
      'aria-checked': item.checked != null ? String(!!item.checked) : null,
      tabindex: '-1',
      disabled: !!item.disabled,
      onClick: () => {
        if (item.disabled) return;
        pop.close('select');
        try { item.onSelect?.(); } catch (err) { console.warn('[ui] menu action failed', err); }
      },
    },
    item.icon ? h('span', { class: 'menu-icon', html: item.icon, 'aria-hidden': 'true' }) : h('span', { class: 'menu-icon', 'aria-hidden': 'true' }),
    h('span', { class: 'menu-label' }, item.label),
    item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null);
    buttons.push(btn);
    list.appendChild(btn);
  }

  const enabled = () => buttons.filter(b => !b.disabled);
  list.addEventListener('keydown', (e) => {
    const en = enabled();
    if (!en.length) return;
    const i = en.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = en[(i + 1) % en.length];
    else if (e.key === 'ArrowUp') next = en[(i - 1 + en.length) % en.length];
    else if (e.key === 'Home') next = en[0];
    else if (e.key === 'End') next = en[en.length - 1];
    else if (e.key === 'Tab') { e.preventDefault(); pop.close('tab'); return; }
    if (next) { e.preventDefault(); next.focus(); }
  });

  pop = openPopover(layers, anchor, list, { className: 'menu', role: 'menu', label, placement, focus: false, gap: 4 });
  const first = enabled()[0];
  if (first) first.focus({ preventScroll: true });
  return pop;
}
