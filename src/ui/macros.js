// Macros: the four global performance knobs (global.macro1..4). They do nothing
// on their own; Links in any part route them to any modulatable knob. Shown in
// a top-bar popover so they are always one click away while playing, and in
// MOD > Links + Macros next to the routing.

import { GLOBAL_PARAM_MAP, LINK_SOURCES } from '../core/params.js';
import { h, createScope, setText } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';

export const MACRO_IDS = ['macro1', 'macro2', 'macro3', 'macro4'].filter(id => GLOBAL_PARAM_MAP[id]);

/** Index of "Macro N" in the Links source list (or -1). */
export function macroSourceIndex(n) {
  return (LINK_SOURCES || []).indexOf(`Macro ${n}`);
}

/** How many links across all parts use each macro: [n1, n2, n3, n4]. */
export function macroUsage(parts) {
  const out = MACRO_IDS.map(() => 0);
  for (const p of parts || []) {
    for (const l of (p && Array.isArray(p.links) ? p.links : [])) {
      MACRO_IDS.forEach((_, i) => { if (l && Number(l.src) === macroSourceIndex(i + 1) && Math.abs(Number(l.amt) || 0) > 0.0005) out[i]++; });
    }
  }
  return out;
}

/** The four macro knobs with a line under each saying what it drives. */
export function createMacroKnobs(ctx, { size = 'md', caption = 'both' } = {}) {
  const scope = createScope();
  const { store, binder } = ctx;
  const uses = [];
  const knobs = MACRO_IDS.map((id) => {
    const k = createKnob(ctx, binder.globalParam(id), { size, caption });
    scope.add(k.dispose);
    const use = h('span', { class: 'macro-use' });
    uses.push(use);
    return h('div', { class: 'macro-cell' }, k.el, use);
  });
  const render = () => {
    const counts = macroUsage(store.get('parts'));
    counts.forEach((n, i) => {
      setText(uses[i], n ? `${n} link${n === 1 ? '' : 's'}` : 'No links');
      uses[i].classList.toggle('is-idle', !n);
    });
  };
  scope.add(store.subscribe('parts', (p) => { if (p === 'parts' || /^parts\.\d(\.links.*)?$/.test(p)) schedule(render); }));
  scope.add(store.subscribe('', (p) => { if (p === '') schedule(render); }));
  render();
  return { el: h('div', { class: 'macro-knobs' }, knobs), dispose: scope.dispose };
}

export function openMacros(ctx, anchor) {
  const scope = createScope();
  const knobs = createMacroKnobs(ctx);
  scope.add(knobs.dispose);
  const linksBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('chain') + '<span>Edit links</span>' });
  const body = h('div', { class: 'macro-pop' },
    h('div', { class: 'popover-title' }, 'Macros'),
    h('p', { class: 'popover-note' }, 'Four knobs shared by every part. A link in MOD > Links lets a macro move any knob, in as many parts as you like. Right-click a macro to MIDI-learn it.'),
    knobs.el,
    h('div', { class: 'macro-actions' }, linksBtn));
  let pop = null;
  scope.on(linksBtn, 'click', () => {
    pop.close('links');
    ctx.store.set('ui.panel', 'mod', { source: 'ui' });
    ctx.bus.emit('mod-view', 'links');
  });
  pop = openPopover(ctx.layers, anchor, body, {
    className: 'popover--macros', label: 'Macros', placement: 'bottom-end', focus: '.knob-dial',
    onClose: () => scope.dispose(),
  });
  return pop;
}
