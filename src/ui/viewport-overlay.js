// Overlay on the 3D view: camera presets, auto-rotate, map render style and
// palette, dot behaviour (Pin / Roll / Drift / Explore / Tour) with its
// settings popover, the waypoint editing chip, and the signal
// card (scope + cycle view). If the 3D view failed to start, a flat map takes
// its place so the dot can still be placed anywhere.

import { DOT_MODES } from '../core/params.js';
import { h, createScope, call, setText, listen, softDisable } from './dom.js';
import { createSegmented, createToggle } from './controls.js';
import { createScopeCard } from './scope.js';
import { addLoop } from './frame.js';
import { openDotSettings } from './dot-settings.js';
import { openPopover } from './layers.js';
import { openPalettePopover } from './palettes.js';
import { createFlatMap } from './flat-map.js';
import { icon } from './icons.js';

export const VIEWS = [
  { value: 'orbit', label: 'Orbit view', icon: 'view-orbit' },
  { value: 'top', label: 'Top view', icon: 'view-top' },
  { value: 'low', label: 'Low view', icon: 'view-low' },
  { value: 'front', label: 'Front view', icon: 'view-low' },
  { value: 'side', label: 'Side view', icon: 'view-low' },
  { value: 'diagonal', label: 'Diagonal view', icon: 'view-orbit' },
];
export const STYLES = [
  { value: 'relief', label: 'Relief', icon: 'relief' },
  { value: 'wire', label: 'Wireframe', icon: 'wire' },
  { value: 'contour', label: 'Contours', icon: 'contour' },
  { value: 'heat', label: 'Heat map', icon: 'heat' },
  { value: 'points', label: 'Points', icon: 'points' },
  { value: 'normals', label: 'Normals', icon: 'relief' },
];
const DOT_ICONS = ['pin', 'roll', 'drift', 'explore', 'tour'];
const DOT_TIPS = [
  'Pin: the dot stays exactly where you place it',
  'Roll: the dot is a marble that rolls downhill. Flick it to throw it',
  'Drift: the dot wanders slowly on its own',
  'Explore: the marble roams and plays in-key notes at peaks and valleys',
  'Tour: the dot travels through your waypoints in time',
];
const DOT_DEF = { id: 'dotMode', label: 'Dot', curve: 'enum', min: 0, max: DOT_MODES.length - 1, default: 0, options: DOT_MODES };

export function createViewportOverlay(ctx, viewportEl) {
  const scope = createScope();
  const { store, binder } = ctx;
  const visuals = ctx.visuals;
  const overlay = h('div', { class: 'vp-overlay' });

  // ---- view + style toolbar
  // The visuals own the camera: ask them first, then make sure the store agrees
  // (the real visuals also follow these ui keys, so either path stays in sync).
  const via = (binding, method, toArg = v => v) => ({
    ...binding,
    set(v, meta) {
      call(visuals, method, toArg(v));
      binding.set(v, meta);
    },
  });
  const viewBinding = via(binder.uiValue('view', VIEWS.map(v => v.value), 'orbit'), 'setView');
  const styleBinding = via(binder.uiValue('renderStyle', STYLES.map(s => s.value), 'relief'), 'setRenderStyle');
  const rotateBinding = { ...via(binder.uiValue('autoRotate', [0, 1], 1), 'setAutoRotate', v => !!v), def: { id: 'autoRotate', label: 'Auto-rotate', default: 1 } };
  const viewSeg = createSegmented(ctx, viewBinding, { label: 'Camera', iconOnly: true, size: 'sm', className: 'seg--camera', options: VIEWS.slice(0, 3) });
  const rotate = createToggle(ctx, rotateBinding, { label: 'Auto-rotate', iconName: 'rotate', text: false, className: 'toggle--icon', tip: 'Slowly circle the map (Orbit view)' });
  const styleSeg = createSegmented(ctx, styleBinding, { label: 'Map style', iconOnly: true, size: 'sm', className: 'seg--style', options: STYLES });
  for (const c of [viewSeg, rotate, styleSeg]) scope.add(c.dispose);
  const paletteBtn = h('button', { type: 'button', class: 'icon-btn icon-btn--sm vp-palette', 'aria-label': 'Map palette', 'aria-haspopup': 'dialog', dataset: { tip: 'Colours of the land' }, html: icon('palette') });
  if (!visuals) softDisable(paletteBtn, 'Palettes colour the 3D map, which is not running here', (r) => ctx.toast(r, { kind: 'info' }));
  let palettePop = null;
  scope.on(paletteBtn, 'click', () => {
    if (palettePop && palettePop.isOpen()) { palettePop.close(); return; }
    palettePop = openPalettePopover(ctx, paletteBtn);
  });

  const cameraBtn = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Camera views and saved views', 'aria-haspopup': 'dialog', dataset: { tip: 'Six camera presets and your saved views' }, html: icon('save') });
  cameraBtn.disabled = !visuals;
  scope.on(cameraBtn, 'click', () => openCameraViews(ctx, cameraBtn));

  const left = h('div', { class: 'vp-toolbar vp-toolbar--left', role: 'toolbar', 'aria-label': 'View' },
    viewSeg.el, cameraBtn, rotate.el, h('span', { class: 'vp-sep', 'aria-hidden': 'true' }), styleSeg.el, paletteBtn);

  // ---- dot behaviour
  const dotBinding = binder.path('dot.mode', DOT_DEF);
  const dotSeg = createSegmented(ctx, dotBinding, {
    label: 'Dot behaviour', size: 'sm', className: 'seg--dot',
    options: DOT_MODES.map((m, i) => ({ value: i, label: m, icon: DOT_ICONS[i] || 'pin', tip: DOT_TIPS[i] || m, aria: m })),
  });
  scope.add(dotSeg.dispose);
  const physicsBtn = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Dot settings', 'aria-haspopup': 'dialog', dataset: { tip: 'Settings for the current dot behaviour' }, html: icon('sliders') });
  let physicsPop = null;
  scope.on(physicsBtn, 'click', () => {
    if (physicsPop && physicsPop.isOpen()) { physicsPop.close(); return; }
    physicsPop = openDotSettings(ctx, physicsBtn);
  });
  const right = h('div', { class: 'vp-toolbar vp-toolbar--right', role: 'toolbar', 'aria-label': 'Dot' },
    h('span', { class: 'vp-label' }, 'Dot'), dotSeg.el, physicsBtn);

  // ---- signal card + coordinates
  const scopeCard = createScopeCard(ctx);
  scope.add(scopeCard.dispose);
  const coordsText = h('span', { class: 'vp-coords-xy' });
  const heightText = h('span', { class: 'vp-coords-h' });
  const coords = h('div', { class: 'vp-coords', 'aria-live': 'off', dataset: { tip: 'Dot position on the map, and the height of the land under it' } }, coordsText, heightText);
  const editChip = h('div', { class: 'vp-edit-chip', role: 'status', hidden: true },
    h('span', { html: icon('waypoint') }), h('span', null, 'Click the map to add waypoints, drag to move, right-click to delete'),
    h('button', { type: 'button', class: 'btn btn--xs', onClick: () => store.set('ui.editWaypoints', 0, { source: 'ui' }) }, 'Done'));
  const hint = h('div', { class: 'vp-hint', role: 'note' }, h('span', { class: 'vp-hint-dot', 'aria-hidden': 'true' }), 'Click anywhere on the map to move the dot');
  const bottom = h('div', { class: 'vp-bottom' }, scopeCard.el, h('div', { class: 'vp-bottom-right' }, hint, coords));

  overlay.append(left, right, editChip, bottom);
  const renderEdit = () => { editChip.hidden = !store.get('ui.editWaypoints'); };
  scope.add(store.subscribe('ui.editWaypoints', renderEdit));
  renderEdit();
  // Esc ends waypoint editing too, once no menu or dialog is left to close.
  scope.on(document, 'keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !store.get('ui.editWaypoints')) return;
    if (ctx.layers && ctx.layers.count() > 0) return;
    store.set('ui.editWaypoints', 0, { source: 'ui' });
  });
  // Height under the dot from telemetry, a few times a second (it is read, not watched).
  let lastH = 0;
  scope.add(addLoop((t) => {
    if (t - lastH < 120) return;
    lastH = t;
    const tl = ctx.tele && ctx.tele.latest;
    const hv = tl && typeof tl.terrainHeight === 'number' && tl.part === binder.selected() ? tl.terrainHeight : null;
    setText(heightText, hv == null ? '' : `  h ${hv >= 0 ? '+' : ''}${hv.toFixed(2)}`);
  }));
  viewportEl.appendChild(overlay);

  // Hide the hint after the first dot move (and when tips are off).
  const showHint = () => hint.classList.toggle('is-hidden', !ctx.prefs.get('showTips') || hintDone);
  let hintDone = false;
  let lastPart = binder.selected();
  const renderCoords = () => {
    const p = binder.selected();
    const x = store.get(`parts.${p}.params.centerX`) ?? 0.5, y = store.get(`parts.${p}.params.centerY`) ?? 0.5;
    setText(coordsText, `${x.toFixed(2)}  ${y.toFixed(2)}`);
  };
  scope.add(store.subscribe('parts', (path, value, meta) => {
    if (/\.params\.center[XY]$/.test(path)) {
      renderCoords();
      if (meta && (meta.source === 'visual' || meta.source === 'ui') && binder.selected() === lastPart && !hintDone && path.startsWith(`parts.${lastPart}`)) {
        hintDone = true;
        showHint();
      }
    } else if (path === 'parts' || /^parts\.\d+$/.test(path)) renderCoords();
  }));
  scope.add(store.subscribe('ui.selectedPart', () => { lastPart = binder.selected(); renderCoords(); }));
  scope.add(ctx.prefs.on(showHint));
  renderCoords();
  showHint();

  // ---- fallback flat map when the 3D view is missing
  let flat = null;
  if (!visuals) {
    viewportEl.classList.add('is-flat');
    flat = createFlatMap(viewportEl, { store, terrains: ctx.terrains, tele: ctx.tele, source: 'ui' });
    viewportEl.insertBefore(flat.el, overlay);
    const notice = h('div', { class: 'vp-notice', role: 'status' }, h('span', { html: icon('info') }),
      'The 3D view could not start here (WebGL may be off), so this flat map stands in. Click it to move the dot.');
    overlay.appendChild(notice);
    viewSeg.setDisabled(true, '3D view unavailable');
    styleSeg.setDisabled(true, '3D view unavailable');
    rotate.setDisabled(true, '3D view unavailable');
    scope.add(() => flat.dispose());
  }

  return { el: overlay, dispose() { scope.dispose(); overlay.remove(); } };
}

/** Device-local camera presets, named captures, restore and deletion. */
export function openCameraViews(ctx, anchor) {
  const { store, visuals, prefs } = ctx;
  const name = h('input', { type: 'text', maxlength: '60', placeholder: 'Name this view', 'aria-label': 'Saved camera view name', class: 'field' });
  const select = h('select', { 'aria-label': 'Saved camera views', class: 'select-native' });
  const save = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Save current view');
  const load = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Restore');
  const remove = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Delete');
  const message = h('p', { class: 'popover-note', 'aria-live': 'polite' });
  const presets = VIEWS.map(v => h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: () => { call(visuals, 'setView', v.value); store.set('ui.view', v.value, { source: 'ui' }); render(); } }, v.label.replace(' view', '')));
  const body = h('div', { class: 'import-pop' }, h('div', { class: 'popover-title' }, 'Camera views'),
    h('div', { class: 'knob-grid knob-grid--3 knob-grid--tight' }, presets),
    h('p', { class: 'popover-note' }, 'Save a camera angle, zoom and focus point on this device. Restore pauses auto-rotate.'),
    name, save, select, h('div', { class: 'import-actions' }, remove, load), message);
  const list = () => prefs.get('savedCameraViews') || [];
  function render() {
    const selected = select.value, views = list();
    select.replaceChildren(...views.map(v => h('option', { value: v.id }, v.name)));
    if (views.some(v => v.id === selected)) select.value = selected;
    load.disabled = remove.disabled = views.length === 0;
    select.disabled = views.length === 0;
    presets.forEach((b, i) => { const on = store.get('ui.view') === VIEWS[i].value; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
  }
  save.addEventListener('click', () => {
    const camera = call(visuals, 'captureCameraView');
    if (!camera) { setText(message, 'The camera is not available.'); return; }
    const views = list(), label = name.value.trim() || `View ${views.length + 1}`, existing = views.find(v => v.name === label);
    if (!existing && views.length >= 24) { setText(message, 'Delete a saved view to make room. You can keep 24 views.'); return; }
    const id = existing?.id || `camera-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const next = views.filter(v => v.id !== id); next.push({ id, name: label, ...camera });
    prefs.set('savedCameraViews', next); prefs.flush(); render(); select.value = id;
    setText(message, `Saved ${label}.`);
  });
  load.addEventListener('click', () => {
    const saved = list().find(v => v.id === select.value);
    if (saved && call(visuals, 'restoreCameraView', saved)) { render(); setText(message, `Restored ${saved.name}.`); }
  });
  remove.addEventListener('click', () => {
    const saved = list().find(v => v.id === select.value);
    if (!saved) return;
    prefs.set('savedCameraViews', list().filter(v => v.id !== saved.id)); prefs.flush(); render(); setText(message, `Deleted ${saved.name}.`);
  });
  const off = prefs.on(key => { if (key === 'savedCameraViews') render(); });
  render();
  return openPopover(ctx.layers, anchor, body, { className: 'popover--import', label: 'Camera views', placement: 'bottom-start', focus: 'input', onClose: off });
}
