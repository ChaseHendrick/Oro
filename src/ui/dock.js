// Bottom dock: a slim vertical tab rail (SOUND / MOD / SEQ / MIX / LOOP) and the
// active pane. Panes are built the first time they are shown.

import { h, createScope } from './dom.js';
import { icon } from './icons.js';
import { createSoundPanel } from './sound-panel.js';
import { createModPanel } from './mod-panel.js';
import { createSeqPanel } from './seq-panel.js';
import { createMixPanel } from './mix-panel.js';
import { createLooperPanel } from './looper-panel.js';

export const DOCK_TABS = [
  { id: 'sound', label: 'Sound', icon: 'sound', build: createSoundPanel },
  { id: 'mod', label: 'Mod', icon: 'mod', build: createModPanel },
  { id: 'seq', label: 'Seq', icon: 'seq', build: createSeqPanel },
  { id: 'mix', label: 'Mix', icon: 'mix', build: createMixPanel },
  { id: 'loop', label: 'Loop', icon: 'loop', build: createLooperPanel },
];

export function createDock(ctx, container) {
  const scope = createScope();
  const { store } = ctx;
  const rail = h('div', { class: 'dock-rail', role: 'tablist', 'aria-label': 'Panels', 'aria-orientation': 'vertical' });
  const body = h('div', { class: 'dock-body' });
  const tabs = new Map();
  const panes = new Map();

  for (const t of DOCK_TABS) {
    const tab = h('button', {
      type: 'button', role: 'tab', class: 'dock-tab', id: `dtab-${t.id}`, 'aria-controls': `dpane-${t.id}`, 'aria-selected': 'false', tabindex: '-1',
      html: icon(t.icon) + `<span>${t.label}</span>`,
    });
    const pane = h('div', { class: 'dock-panel', role: 'tabpanel', id: `dpane-${t.id}`, 'aria-labelledby': `dtab-${t.id}`, hidden: true, dataset: { pane: t.id } });
    tab.addEventListener('click', () => store.set('ui.panel', t.id, { source: 'ui' }));
    tabs.set(t.id, tab);
    panes.set(t.id, { el: pane, built: null, def: t });
    rail.appendChild(tab);
    body.appendChild(pane);
  }
  scope.on(rail, 'keydown', (e) => {
    const ids = DOCK_TABS.map(t => t.id);
    const i = ids.findIndex(id => tabs.get(id) === document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % ids.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length;
    if (n < 0) return;
    e.preventDefault();
    store.set('ui.panel', ids[n], { source: 'ui' });
    tabs.get(ids[n]).focus();
  });

  let ro = null;
  function show() {
    let id = store.get('ui.panel');
    if (!panes.has(id)) id = 'sound';
    for (const [pid, p] of panes) {
      const on = pid === id;
      tabs.get(pid).setAttribute('aria-selected', String(on));
      tabs.get(pid).tabIndex = on ? 0 : -1;
      if (on && !p.built) {
        try {
          p.built = p.def.build(ctx);
          p.el.appendChild(p.built.el);
          scope.add(p.built.dispose);
          if (ro && p.built.el) ro.observe(p.built.el);
        } catch (err) {
          console.error(`[ui] the ${p.def.label} panel failed to build`, err);
          p.built = { el: null };
          p.el.appendChild(h('p', { class: 'panel-error' }, `The ${p.def.label} panel could not load. The rest of Oro still works.`));
        }
      }
      p.el.hidden = !on;
    }
    container.dataset.pane = id;
  }
  // When a pane is taller than the dock (short windows), fade its bottom edge
  // so it is clear there is more to scroll to.
  const updateMore = () => {
    const p = panes.get(container.dataset.pane);
    const el = p && p.el;
    const more = !!el && !el.hidden && el.scrollHeight - el.scrollTop - el.clientHeight > 4;
    body.classList.toggle('has-more', more);
  };
  for (const p of panes.values()) scope.on(p.el, 'scroll', updateMore, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => updateMore());
    ro.observe(body);
    for (const p of panes.values()) { ro.observe(p.el); if (p.built && p.built.el) ro.observe(p.built.el); }
    scope.add(() => ro.disconnect());
  }
  scope.add(store.subscribe('ui.panel', () => { show(); requestAnimationFrame(updateMore); }));
  container.append(rail, body);
  show();
  requestAnimationFrame(updateMore);
  return { dispose: scope.dispose, show };
}
