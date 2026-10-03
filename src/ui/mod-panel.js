// MOD tab: every modulatable parameter of the selected part in one table, so
// all motion is visible at a glance and editable inline: LFO shape, rate (Hz or
// synced division), LFO depth, Envelope 2 depth, retrigger, with a live bar
// showing the base value, the modulation range and the moving value.

import { MOD_PARAM_IDS, PART_PARAM_MAP, LFO_SHAPES, SYNC_DIVS, MOD_DEFAULT, toNorm, clamp } from '../core/params.js';
import { h, createScope, setText } from './dom.js';
import { schedule } from './frame.js';
import { createMiniSlider, createToggle, createSelect, createDragNumber, createSegmented } from './controls.js';
import { createLinksPanel } from './links-panel.js';
import { openMenu } from './menu.js';
import { icon } from './icons.js';
import { RATE_DEF, DEPTH_DEF, ENV_DEF, DIV_DEF, SYNC_DEF, RETRIG_DEF, formatDepth } from './mod-popover.js';

const GROUP_LABEL = { terrain: 'Terrain', path: 'Path', voice: 'Voice', filter: 'Filter', mix: 'Mix' };

/** Default modulation settings with their own copy of the step values. */
export function freshMod() {
  const m = { ...MOD_DEFAULT };
  if (Array.isArray(MOD_DEFAULT.steps)) m.steps = [...MOD_DEFAULT.steps];
  return m;
}

function formatHz(v) {
  return v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

export function createModPanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const rows = MOD_PARAM_IDS.map(id => createRow(ctx, scope, id));
  const count = h('span', { class: 'mod-count' });
  const clearAll = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('close') + '<span>Clear all</span>' });
  const head = h('div', { class: 'mod-row mod-row--head', 'aria-hidden': 'true' },
    h('span', null, 'Parameter'), h('span', null, 'Live'), h('span', null, ''), h('span', null, 'LFO'),
    h('span', null, 'Depth'), h('span', null, 'Env'), h('span', null, ''), h('span', null, ''));
  const table = h('div', { class: 'mod-table', role: 'group', 'aria-label': 'Modulation overview' },
    h('div', { class: 'mod-col' }, head.cloneNode(true), rows.slice(0, Math.ceil(rows.length / 2)).map(r => r.el)),
    h('div', { class: 'mod-col' }, head, rows.slice(Math.ceil(rows.length / 2)).map(r => r.el)));
  // Two views: every parameter's own LFO / Env 2, and the Links + Macros router.
  let view = 'params';
  const viewBinding = {
    def: { id: 'modView', default: 'params' }, id: 'modView', scope: 'ui', part: () => null, path: () => 'modView',
    get: () => view, set: (v) => { view = v; showView(); viewListeners.forEach(fn => fn()); }, reset() {},
    subscribe: (fn) => { viewListeners.add(fn); return () => viewListeners.delete(fn); }, modPath: () => null, learnTarget: () => null,
  };
  const viewListeners = new Set();
  const viewSeg = createSegmented(ctx, viewBinding, { label: 'Modulation view', size: 'sm', options: [{ value: 'params', label: 'LFO + Env' }, { value: 'links', label: 'Links + Macros' }] });
  scope.add(viewSeg.dispose);
  let links = null;
  const linksHost = h('div', { class: 'mod-view', hidden: true });
  const paramsTools = h('div', { class: 'mod-top' },
    count,
    h('span', { class: 'spacer' }),
    clearAll);
  const paramsView = h('div', { class: 'mod-view' }, table);
  function showView() {
    paramsView.hidden = view !== 'params';
    paramsTools.hidden = view !== 'params';
    linksHost.hidden = view !== 'links';
    if (view === 'links' && !links) {
      links = createLinksPanel(ctx);
      scope.add(links.dispose);
      linksHost.appendChild(links.el);
    }
  }
  // Other places (the top bar's Macros popover) can ask for the Links view.
  if (ctx.bus) scope.add(ctx.bus.on('mod-view', (v) => { if (v === 'links' || v === 'params') viewBinding.set(v); }));
  const el = h('div', { class: 'dock-pane dock-pane--mod' },
    h('div', { class: 'mod-switch' }, h('h3', { class: 'section-title' }, 'Modulation'), viewSeg.el, paramsTools),
    paramsView, linksHost);

  function renderCount() {
    const mods = store.get(`parts.${binder.selected()}.mods`) || {};
    const n = MOD_PARAM_IDS.filter(id => mods[id] && (Math.abs(mods[id].lfoDepth) > 0.0005 || Math.abs(mods[id].envDepth) > 0.0005 || [1,2,3,4].some(n => Math.abs(mods[id][`ctrl${n}Depth`] || 0) > 0.0005))).length;
    setText(count, n === 0 ? 'Nothing is moving yet' : n === 1 ? '1 parameter moving' : `${n} parameters moving`);
    clearAll.disabled = n === 0;
  }
  scope.on(clearAll, 'click', () => {
    const p = binder.selected();
    store.batch(() => {
      for (const id of MOD_PARAM_IDS) store.set(`parts.${p}.mods.${id}`, freshMod(), { source: 'ui' });
    });
    ctx.toast('Cleared all modulation for this part', { kind: 'info' });
  });
  scope.add(store.subscribe('parts', (path) => { if (/^parts(\.\d+(\.mods.*)?)?$/.test(path)) schedule(renderCount); }));
  scope.add(store.subscribe('ui.selectedPart', () => schedule(renderCount)));
  renderCount();

  return { el, dispose: scope.dispose };
}

function createRow(ctx, parentScope, id) {
  const { store, binder } = ctx;
  const def = PART_PARAM_MAP[id];
  const f = (field, d) => binder.modField(id, field, d);
  const modPath = () => `parts.${binder.selected()}.mods.${id}`;
  const getMod = () => ({ ...MOD_DEFAULT, ...(store.get(modPath()) || {}) });

  const nameBtn = h('button', { type: 'button', class: 'mod-name', 'aria-haspopup': 'dialog', dataset: { tip: def.hint || `Open the ${def.label} modulation editor` } },
    h('span', { class: 'mod-dot', 'aria-hidden': 'true' }), h('span', { class: 'mod-name-text' }, def.label), h('span', { class: 'mod-group' }, GROUP_LABEL[def.group] || ''));
  parentScope.on(nameBtn, 'click', () => ctx.openModPopover(binder.partParam(id), nameBtn));

  // live bar
  const base = h('span', { class: 'livebar-base' });
  const range = h('span', { class: 'livebar-range' });
  const dot = h('span', { class: 'livebar-dot' });
  const bar = h('span', { class: 'livebar', role: 'img', 'aria-label': `${def.label} modulation range` }, range, base, dot);

  // shape picker
  const shapeBtn = h('button', { type: 'button', class: 'icon-btn icon-btn--xs mod-shape', 'aria-haspopup': 'menu' });
  parentScope.on(shapeBtn, 'click', () => {
    const m = getMod();
    openMenu(ctx.layers, shapeBtn, LFO_SHAPES.map((name, i) => ({
      label: name, icon: icon(`lfo-${i}`), checked: m.lfoShape === i,
      onSelect: () => store.set(`${modPath()}.lfoShape`, i, { source: 'ui' }),
    })), { label: `${def.label} LFO shape` });
  });

  const rate = createDragNumber(ctx, f('lfoRate', RATE_DEF), { label: `${def.label} LFO rate`, format: formatHz, exp: true, suffix: 'Hz', className: 'dragnum--xs' });
  const div = createSelect(ctx, f('lfoDiv', DIV_DEF), { label: `${def.label} LFO division`, className: 'select--xs' });
  const sync = createToggle(ctx, f('lfoSync', SYNC_DEF), { label: 'Sync', iconName: 'bolt', text: false, className: 'toggle--xs', ariaLabel: `${def.label} LFO tempo sync`, tip: 'Sync to tempo' });
  const rateCell = h('span', { class: 'mod-rate' }, rate.el, div.el, sync.el);
  const depth = createMiniSlider(ctx, f('lfoDepth', DEPTH_DEF), { ariaLabel: `${def.label} LFO depth`, format: formatDepth, className: 'mslider--mod' });
  const env = createMiniSlider(ctx, f('envDepth', ENV_DEF), { ariaLabel: `${def.label} Envelope 2 depth`, format: formatDepth, className: 'mslider--mod' });
  const depthVal = h('span', { class: 'mod-val' });
  const envVal = h('span', { class: 'mod-val' });
  const retrig = createToggle(ctx, f('retrig', RETRIG_DEF), { label: 'Retrig', iconName: 'init', text: false, className: 'toggle--xs', ariaLabel: `${def.label} LFO retrigger`, tip: 'Restart the LFO on each new note' });
  const clear = h('button', { type: 'button', class: 'icon-btn icon-btn--xs mod-clear', 'aria-label': `Clear ${def.label} modulation`, dataset: { tip: 'Clear' }, html: icon('close') });
  parentScope.on(clear, 'click', () => store.set(modPath(), freshMod(), { source: 'ui' }));
  for (const c of [rate, div, sync, depth, env, retrig]) parentScope.add(c.dispose);

  const el = h('div', { class: 'mod-row', role: 'group', 'aria-label': `${def.label} modulation`, dataset: { param: id } },
    h('span', null, nameBtn), h('span', null, bar), h('span', null, shapeBtn), h('span', null, rateCell),
    h('span', { class: 'mod-depth' }, depth.el, depthVal), h('span', { class: 'mod-depth' }, env.el, envVal),
    h('span', null, retrig.el), h('span', null, clear));

  let active = false, lo = 0, hi = 0, liveN = null;
  function render() {
    const m = getMod();
    const p = binder.selected();
    const v = store.get(`parts.${p}.params.${id}`) ?? def.default;
    const n = toNorm(def, v);
    active = Math.abs(m.lfoDepth) > 0.0005 || Math.abs(m.envDepth) > 0.0005 || [1,2,3,4].some(n => Math.abs(m[`ctrl${n}Depth`] || 0) > 0.0005);
    const controllerRange = [1,2,3,4].reduce((sum,n) => sum + Math.abs(m[`ctrl${n}Depth`] || 0), 0);
    el.classList.toggle('is-active', active);
    el.classList.toggle('is-synced', !!m.lfoSync);
    lo = clamp(n - Math.abs(m.lfoDepth) + Math.min(0, m.envDepth) - controllerRange, 0, 1);
    hi = clamp(n + Math.abs(m.lfoDepth) + Math.max(0, m.envDepth) + controllerRange, 0, 1);
    base.style.left = (n * 100).toFixed(2) + '%';
    range.style.left = (lo * 100).toFixed(2) + '%';
    range.style.width = ((hi - lo) * 100).toFixed(2) + '%';
    shapeBtn.innerHTML = icon(`lfo-${m.lfoShape}`);
    shapeBtn.setAttribute('aria-label', `${def.label} LFO shape: ${LFO_SHAPES[m.lfoShape]}`);
    shapeBtn.dataset.tip = `${LFO_SHAPES[m.lfoShape]} (click to change)`;
    setText(depthVal, formatDepth(m.lfoDepth));
    setText(envVal, formatDepth(m.envDepth));
    envVal.title = m.envOwn ? 'Own parameter envelope' : 'Envelope 2';
    div.el.hidden = !m.lfoSync;
    rate.el.hidden = !!m.lfoSync;
    rateCell.dataset.tip = m.lfoSync ? `Synced: ${SYNC_DIVS[m.lfoDiv]?.name}` : '';
  }
  const invalidate = () => schedule(render);
  let off = store.subscribe(modPath(), invalidate);
  let offV = store.subscribe(`parts.${binder.selected()}.params.${id}`, invalidate);
  parentScope.add(() => { off(); offV(); });
  parentScope.add(store.subscribe('ui.selectedPart', () => {
    off(); offV();
    off = store.subscribe(modPath(), invalidate);
    offV = store.subscribe(`parts.${binder.selected()}.params.${id}`, invalidate);
    liveN = null;
    invalidate();
  }));

  if (ctx.live) {
    parentScope.add(ctx.live.add(() => {
      if (!active || !el.isConnected || el.offsetParent === null) { if (dot.style.opacity !== '0') dot.style.opacity = '0'; return; }
      const t = ctx.tele ? ctx.tele.norm(binder.selected(), id) : null;
      if (t == null) { dot.style.opacity = '0'; return; }
      liveN = liveN == null ? t : liveN + (t - liveN) * 0.45;
      dot.style.opacity = '1';
      dot.style.left = (liveN * 100).toFixed(2) + '%';
    }));
  }
  render();
  return { el };
}
