// Links: per-part modulation routing from a source (velocity, mod wheel,
// pressure, key, macros, the marble, envelopes, random, terrain height) to any
// modulatable parameter, with an amount and a response curve. Shown in the MOD
// tab next to the four global Macro knobs that Links can use as sources.

import * as params from '../core/params.js';
import { h, createScope, setText } from './dom.js';
import { schedule } from './frame.js';
import { createMacroKnobs } from './macros.js';
import { createMiniSlider, createSelect } from './controls.js';
import { createKnob } from './knob.js';
import { createFunctionEditor } from './function-editor.js';
import { icon } from './icons.js';
import { openWeatherPanel } from './weather-panel.js';

const { PART_PARAM_MAP, GLOBAL_PARAM_MAP, MOD_PARAM_IDS, clamp } = params;
export const LINK_SOURCES = params.LINK_SOURCES || ['Velocity', 'Mod Wheel', 'Pressure', 'Key', 'Slide', 'Macro 1', 'Macro 2', 'Macro 3', 'Macro 4', 'Marble Speed', 'Marble Height', 'Env 1', 'Env 2', 'Random', 'Terrain Height'];
export const LINK_CURVES = params.LINK_CURVES || ['Linear', 'Soft', 'Hard'];
export const MAX_LINKS = params.MAX_LINKS || 8;
const GROUP_LABEL = { terrain: 'Terrain', path: 'Path', voice: 'Voice', filter: 'Filter', mix: 'Mix' };
const AMOUNT_DEF = { id: 'amt', label: 'Amount', curve: 'lin', min: -1, max: 1, default: 0 };

export function sanitizeLink(l) {
  const dst = MOD_PARAM_IDS.includes(l && l.dst) ? l.dst : MOD_PARAM_IDS[0];
  return {
    src: clamp(Math.round(Number(l && l.src) || 0), 0, LINK_SOURCES.length - 1),
    dst,
    amt: clamp(Number(l && l.amt) || 0, -1, 1),
    curve: clamp(Math.round(Number(l && l.curve) || 0), 0, LINK_CURVES.length - 1),
    ...(l && Number.isFinite(Number(l.via)) && l.via !== null && Number(l.via) >= 0 && Number(l.via) < LINK_SOURCES.length ? { via: Math.round(Number(l.via)) } : {}),
  };
}

/** A sensible next link: the first source/destination pair not already used. */
export function suggestLink(existing) {
  const used = new Set(existing.map(l => `${l.src}|${l.dst}`));
  const tries = [[0, 'cutoff'], [3, 'size'], [5, 'morph'], [12, 'warp'], [9, 'fold'], [2, 'cutoff'], [6, 'size'], [13, 'pathParam']];
  for (const [src, dst] of tries) if (MOD_PARAM_IDS.includes(dst) && !used.has(`${src}|${dst}`)) return { src, dst, amt: 0.5, curve: 0 };
  return { src: 0, dst: MOD_PARAM_IDS[0], amt: 0.5, curve: 0 };
}

function selectEl(label, options, value, onChange, cls = '') {
  const sel = h('select', { class: 'select-native', 'aria-label': label });
  for (const o of options) {
    if (o.group) {
      const og = h('optgroup', { label: o.group });
      for (const x of o.options) og.appendChild(h('option', { value: String(x.value) }, x.label));
      sel.appendChild(og);
    } else sel.appendChild(h('option', { value: String(o.value) }, o.label));
  }
  sel.value = String(value);
  sel.addEventListener('change', () => onChange(sel.value));
  return h('div', { class: ['select', 'select--xs', cls] }, sel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
}

function destinationOptions() {
  const groups = new Map();
  for (const id of MOD_PARAM_IDS) {
    const d = PART_PARAM_MAP[id];
    const g = GROUP_LABEL[d.group] || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ value: id, label: d.label });
  }
  return [...groups].map(([group, options]) => ({ group, options }));
}

export function createLinksPanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const path = () => `parts.${binder.selected()}.links`;
  const getLinks = () => (Array.isArray(store.get(path())) ? store.get(path()) : []).map(sanitizeLink);
  const putLinks = (arr) => store.set(path(), arr.slice(0, MAX_LINKS).map(sanitizeLink), { source: 'ui' });

  // Macros (global): the same knobs as the top bar's Macros popover.
  const macros = createMacroKnobs(ctx, { size: 'sm', caption: 'swap' });
  macros.el.classList.add('macro-knobs--grid');
  scope.add(macros.dispose);
  const macroCard = h('section', { class: 'links-macros', 'aria-labelledby': 'sec-macros' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-macros' }, 'Macros')),
    macros.el,
    h('p', { class: 'links-note' }, 'Shared by all parts. Right-click to MIDI-learn.'));

  // Science sources (global, v2.1): the generators behind the Neuron, Lorenz,
  // Pendulum, Smooth Random, Collapse and Swirl link sources.
  const sciGroup = (title, ids, note) => {
    const cells = ids.map((id) => {
      const def = GLOBAL_PARAM_MAP[id];
      const ctl = def.curve === 'enum'
        ? createSelect(ctx, binder.globalParam(id), { label: `${title} ${def.label}`, className: 'select--sm' })
        : createKnob(ctx, binder.globalParam(id), { size: 'sm' });
      scope.add(ctl.dispose);
      return def.curve === 'enum' ? h('label', { class: 'sci-select' }, h('span', null, def.label), ctl.el) : ctl.el;
    });
    return h('div', { class: 'sci-group' }, h('h4', { class: 'sci-title' }, title), h('div', { class: 'sci-controls' }, cells), h('p', { class: 'links-note' }, note));
  };
  const sciCard = h('section', { class: 'links-science', 'aria-labelledby': 'sec-science' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-science' }, 'Science sources')),
    h('p', { class: 'links-note' }, 'Shared by all tracks. Pick one as a link source above to let it move any knob.'),
    h('div', { class: 'sci-groups' },
      sciGroup('Neuron', ['sciNeuronCurrent', 'sciNeuronKick', 'sciNeuronTemp', 'sciNeuronRate'], 'Hodgkin and Huxley 1952. Neuron is the membrane voltage, Neuron Spike pulses at each spike.'),
      sciGroup('Lorenz', ['sciLorenzRate'], 'The classic chaotic attractor: never repeats.'),
      sciGroup('Pendulum', ['sciPendEnergy', 'sciPendRate'], 'A double pendulum: Pendulum 1 and 2 are its two arms.'),
      sciGroup('Smooth random', ['sciSmoothTime', 'sciSmoothness'], 'Random wandering, as smooth as you like.'),
      sciGroup('Turing', ['sciTuringChance', 'sciTuringLength', 'sciTuringDiv'], 'A looping random sequence: Chance 0 repeats the same Length steps forever, 1 is new every step. The source is Turing.'),
      sciGroup('Collapse', ['sciCollapseShape', 'sciCollapseBars', 'sciCollapseDir'], 'Point vortices spiralling to a collapse, in time with the tempo. Collapse is how far in; Swirl X and Y place each voice on its own vortex.')));

  const rowsEl = h('div', { class: 'links-rows' });
  const addBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('plus') + '<span>Add link</span>' });
  const count = h('span', { class: 'mod-count' });
  const listCard = h('section', { class: 'links-list', 'aria-labelledby': 'sec-links' },
    h('header', { class: 'section-head' },
      h('div', { class: 'mod-top-text' }, h('h3', { class: 'section-title', id: 'sec-links' }, 'Links'), count),
      addBtn),
    h('div', { class: 'links-row links-row--head', 'aria-hidden': 'true' },
      h('span', null, 'Source'), h('span', null, 'Via'), h('span', null, 'Curve'), h('span', null, 'Amount'), h('span', null, ''), h('span', null, 'Destination'), h('span', null, '')),
    rowsEl);

  const dests = destinationOptions();
  const sources = LINK_SOURCES.map((label, value) => ({ value, label }));
  // v2.4 Via: a second source that scales the link
  const vias = [{ value: -1, label: 'No via' }, ...LINK_SOURCES.map((label, value) => ({ value, label: `× ${label}` }))];
  const curves = LINK_CURVES.map((label, value) => ({ value, label }));

  let rowScope = createScope();
  let amtVals = [];
  scope.add(() => rowScope.dispose());
  function render() {
    rowScope.dispose();
    rowScope = createScope();
    amtVals = [];
    const links = getLinks();
    rowsEl.textContent = '';
    setText(count, links.length ? `${links.length} of ${MAX_LINKS}` : 'None yet');
    addBtn.disabled = links.length >= MAX_LINKS;
    if (!links.length) {
      rowsEl.appendChild(h('p', { class: 'links-empty' }, 'A link lets something you play, like velocity, the mod wheel or the marble, move any knob. Add one to start.'));
      return;
    }
    links.forEach((l, i) => {
      const update = (patch) => { const arr = getLinks(); arr[i] = { ...arr[i], ...patch }; putLinks(arr); };
      const amtBinding = {
        def: AMOUNT_DEF, id: 'amt', scope: 'link', part: () => binder.selected(), path: () => `${path()}.${i}.amt`,
        get: () => (getLinks()[i] || {}).amt ?? 0,
        set: (v) => update({ amt: clamp(Number(v) || 0, -1, 1) }),
        reset() { this.set(0); },
        subscribe: (fn) => store.subscribe(path(), fn),
        modPath: () => null, learnTarget: () => null,
      };
      const amt = createMiniSlider(ctx, amtBinding, { ariaLabel: `Link ${i + 1} amount`, format: v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`, className: 'mslider--mod' });
      rowScope.add(amt.dispose);
      const amtVal = h('span', { class: 'mod-val' }, `${l.amt > 0 ? '+' : ''}${Math.round(l.amt * 100)}%`);
      amtVals.push(amtVal);
      const del = h('button', { type: 'button', class: 'icon-btn icon-btn--xs', 'aria-label': `Remove link ${i + 1}`, dataset: { tip: 'Remove' }, html: icon('close') });
      del.addEventListener('click', () => putLinks(getLinks().filter((_, k) => k !== i)));
      rowsEl.appendChild(h('div', { class: 'links-row', role: 'group', 'aria-label': `Link ${i + 1}: ${LINK_SOURCES[l.src]} to ${PART_PARAM_MAP[l.dst]?.label}` },
        selectEl(`Link ${i + 1} source`, sources, l.src, v => update({ src: Number(v) })),
        selectEl(`Link ${i + 1} via`, vias, l.via ?? -1, v => update({ via: Number(v) })),
        selectEl(`Link ${i + 1} curve`, curves, l.curve, v => update({ curve: Number(v) })),
        h('span', { class: 'mod-depth' }, amt.el, amtVal),
        h('span', { class: 'links-arrow', html: icon('arrow-right'), 'aria-hidden': 'true' }),
        selectEl(`Link ${i + 1} destination`, dests, l.dst, v => update({ dst: v })),
        del));
    });
  }
  scope.on(addBtn, 'click', () => {
    const arr = getLinks();
    if (arr.length >= MAX_LINKS) return;
    arr.push(suggestLink(arr));
    putLinks(arr);
  });
  // Rebuild rows only when the list's shape changes; an amount drag just
  // updates the numbers, so the slider being dragged is never replaced.
  const shapeKey = () => `${binder.selected()}|${JSON.stringify(getLinks().map(l => [l.src, l.via ?? -1, l.dst, l.curve]))}`;
  let renderedFor = shapeKey();
  const refreshAmounts = () => getLinks().forEach((l, i) => { if (amtVals[i]) setText(amtVals[i], `${l.amt > 0 ? '+' : ''}${Math.round(l.amt * 100)}%`); });
  const onChange = () => {
    const key = shapeKey();
    if (key !== renderedFor) { renderedFor = key; schedule(render); } else schedule(refreshAmounts);
  };
  scope.add(store.subscribe('parts', (p) => { if (p === 'parts' || /^parts\.\d+(\.links.*)?$/.test(p)) onChange(); }));
  scope.add(store.subscribe('ui.selectedPart', onChange));
  scope.add(store.subscribe('', (p) => { if (p === '') onChange(); }));
  render();

  const fn = createFunctionEditor(ctx);
  scope.add(fn.dispose);
  // v2.10 live weather (opt-in): Weather Wind, Rain, Temp and Clouds sources
  const weatherBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Live weather');
  scope.on(weatherBtn, 'click', () => openWeatherPanel(ctx, weatherBtn));
  const weatherCard = h('section', { class: 'links-science', 'aria-labelledby': 'sec-weather' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-weather' }, 'Live weather'), weatherBtn),
    h('p', { class: 'links-note' }, 'Off by default. Wind, rain, temperature and clouds where you choose, as link sources. Weather data by Open-Meteo.com.'));
  const el = h('div', { class: 'links-pane' }, macroCard, listCard, fn.el, sciCard, weatherCard);
  return { el, dispose: scope.dispose };
}
