// MAP panel: the land (Terrain A and B with live previews, import, morph and
// shaping knobs) and the orbit (path picker with drawn icons and the path
// knobs). Everything here follows the selected part.

import { TERRAINS, PATHS, TERRAIN_INDEX } from '../dsp/catalog.js';
import { h, s, createScope, setText, has, uniqueId } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createToggle } from './controls.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';
import { drawTerrain, downsample, previewTable, prewarmPreviews } from './terrain-art.js';
import { pathOutline } from './dsp-bridge.js';
import { openTerrainLibrary } from './terrain-library.js';
import { openRealPlaces } from './real-places.js';
import { openDataPanel } from './data-panel.js';
import { openFormulaTerrain } from './formula-terrain.js';

const TERRAIN_KNOBS = ['morph', 'warp', 'lift', 'fold', 'seed', 'detail'];
const PATH_KNOBS = ['pathOrder', 'pathParam', 'size', 'noteSize', 'stretch', 'rotate', 'spin', 'laps', 'pace', 'paceShape', 'centerX', 'centerY', 'pathWindow', 'pathMangle', 'pathMirror', 'warpMode', 'warpAmount'];
const ACCEPT = 'image/*,audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.aif,.aiff';

export function friendlyImportError(err) {
  const msg = String((err && err.message) || err || '');
  if (/decode|unsupported|format|invalid|corrupt/i.test(msg)) return 'That file could not be read as a terrain. Try a PNG or JPEG image, or an audio file.';
  if (/large|size|too big/i.test(msg)) return 'That file is too large to import. Try a smaller image or a shorter recording.';
  if (msg && msg.length < 140 && !/^\w+Error\b/.test(msg) && !/undefined|null|cannot read/i.test(msg)) return msg;
  return 'That file could not be used as a terrain. Try a PNG or JPEG image, or an audio file.';
}

export function createMapPanel(ctx, container) {
  const scope = createScope();
  const { store, binder } = ctx;
  const canImport = has(ctx.engine, 'importTerrainFile');

  const head = h('header', { class: 'panel-head' },
    h('h2', { class: 'panel-title' }, 'Map'),
    h('span', { class: 'panel-sub', dataset: { role: 'part-name' } }),
    h('button', {
      type: 'button', class: 'icon-btn icon-btn--sm map-collapse', 'aria-label': 'Collapse the map panel', 'aria-expanded': 'true',
      html: icon('chevron-right'), onClick: () => ctx.prefs.set('mapCollapsed', ctx.prefs.get('mapCollapsed') ? 0 : 1),
    }));
  const rail = h('button', { type: 'button', class: 'map-rail', 'aria-label': 'Expand the map panel', onClick: () => ctx.prefs.set('mapCollapsed', 0) },
    h('span', { html: icon('map') }), h('span', { class: 'map-rail-text' }, 'Map'));

  // ---------------------------------------------------------------- terrain
  const slots = ['A', 'B'].map(slot => createTerrainSlot(ctx, scope, slot, canImport));
  const morphBar = h('div', { class: 'morph-bar', 'aria-hidden': 'true' }, h('span', { class: 'morph-bar-fill' }));
  const terrainKnobs = TERRAIN_KNOBS.map(id => createKnob(ctx, binder.partParam(id), { size: 'sm' }));
  terrainKnobs.forEach(k => scope.add(k.dispose));
  const renderMorph = () => {
    const m = store.get(`parts.${binder.selected()}.params.morph`) ?? 0;
    morphBar.firstChild.style.transform = `scaleX(${m})`;
  };
  scope.add(binder.partParam('morph').subscribe(() => schedule(renderMorph)));
  renderMorph();

  const terrainSection = h('section', { class: 'panel-section', 'aria-labelledby': 'sec-terrain' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-terrain' }, 'Terrain'),
      h('span', { class: 'section-aside' }, 'The land under the dot')),
    h('div', { class: 'terrain-slots' }, slots[0].el, h('div', { class: 'morph-link' }, morphBar, h('span', { class: 'morph-link-label' }, 'Morph')), slots[1].el),
    h('div', { class: 'knob-grid knob-grid--3 knob-grid--tight' }, terrainKnobs.map(k => k.el)));

  // ---------------------------------------------------------------- path
  const pathBtnIcon = s('svg', { class: 'path-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: '' }));
  const pathName = h('span', { class: 'picker-name' });
  const pathDesc = h('span', { class: 'picker-desc' });
  const pathBtn = h('button', { type: 'button', class: 'picker-btn path-picker', 'aria-haspopup': 'listbox', 'aria-label': 'Choose path shape' },
    h('span', { class: 'picker-art' }, pathBtnIcon), h('span', { class: 'picker-text' }, pathName, pathDesc), h('span', { class: 'picker-caret', html: icon('chevron-down') }));
  const shapeDef = () => PATHS[store.get(`parts.${binder.selected()}.params.pathShape`)] || PATHS[0];
  const pathKnobs = PATH_KNOBS.map(id => {
    const opts = { size: 'sm' };
    if (id === 'pathOrder') opts.label = () => shapeDef().orderLabel;
    if (id === 'pathParam') opts.label = () => shapeDef().paramLabel;
    if (id === 'pathOrder' || id === 'pathParam') opts.ariaLabel = (l) => `${l} (path ${id === 'pathOrder' ? 'order' : 'shape'})`;
    return createKnob(ctx, binder.partParam(id), opts);
  });
  pathKnobs.forEach(k => scope.add(k.dispose));
  function renderPath() {
    const p = store.get(`parts.${binder.selected()}.params`) || {};
    const def = PATHS[p.pathShape] || PATHS[0];
    pathBtnIcon.firstChild.setAttribute('d', pathOutline(p.pathShape ?? 0, p.pathOrder ?? 2, p.pathParam ?? 0.5, 24, 2.5, 180));
    setText(pathName, def.name);
    setText(pathDesc, def.desc);
    pathKnobs[0].refresh();
    pathKnobs[1].refresh();
  }
  for (const id of ['pathShape', 'pathOrder', 'pathParam']) scope.add(binder.partParam(id).subscribe(() => schedule(renderPath)));
  renderPath();
  let pathPop = null;
  scope.on(pathBtn, 'click', () => {
    if (pathPop && pathPop.isOpen()) { pathPop.close(); return; }
    pathPop = openPathPicker(ctx, pathBtn);
  });

  // Two-way enums read best as plain on/off switches.
  const enumToggle = (id, onLabel, tip) => {
    const b = binder.partParam(id);
    const t = createToggle(ctx, { ...b, get: () => (b.get() ? 1 : 0), set: (v) => b.set(v ? 1 : 0) }, { label: onLabel, className: 'toggle--sm', tip });
    scope.add(t.dispose);
    return t.el;
  };
  const pathSection = h('section', { class: 'panel-section', 'aria-labelledby': 'sec-path' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-path' }, 'Path'),
      h('span', { class: 'section-aside' }, 'The orbit traced each cycle')),
    pathBtn,
    h('div', { class: 'path-switches' },
      enumToggle('traverse', 'Even speed', 'Move at constant speed along the path (otherwise corners speed up and slow down)'),
      enumToggle('direction', 'Ping-pong', 'Run the path forward then backward each cycle, so open paths never jump')),
    h('div', { class: 'knob-grid knob-grid--4 knob-grid--tight' }, pathKnobs.map(k => k.el)));

  const body = h('div', { class: 'panel-scroll' }, terrainSection, pathSection);
  container.append(head, body, rail);

  const partName = head.querySelector('[data-role="part-name"]');
  const renderHead = () => {
    const p = binder.selected();
    setText(partName, `${store.get(`parts.${p}.name`) || `Part ${p + 1}`} · ${store.get(`parts.${p}.patchName`) || 'Init'}`);
  };
  scope.add(store.subscribe('ui.selectedPart', renderHead));
  scope.add(store.subscribe('parts', (path) => { if (/^parts(\.\d(\.(name|patchName))?)?$/.test(path)) renderHead(); }));
  renderHead();

  const syncCollapse = () => {
    const c = !!ctx.prefs.get('mapCollapsed');
    head.querySelector('.map-collapse').setAttribute('aria-expanded', String(!c));
  };
  scope.add(ctx.prefs.on(syncCollapse));
  syncCollapse();

  // Warm the picker previews a few seconds after start, while the user looks around.
  const warm = setTimeout(() => {
    const p = store.get(`parts.${binder.selected()}.params`) || {};
    prewarmPreviews(TERRAINS.length, { seed: p.seed ?? 7, detail: p.detail ?? 0.5, size: 64 });
  }, 2500);
  scope.add(() => clearTimeout(warm));

  return { dispose: scope.dispose };
}

function createTerrainSlot(ctx, parentScope, slot, canImport) {
  const { store, binder } = ctx;
  const id = 'terrain' + slot;
  const canvas = h('canvas', { class: 'terrain-thumb', width: 112, height: 112, 'aria-hidden': 'true' });
  const name = h('span', { class: 'picker-name' });
  const sub = h('span', { class: 'picker-desc' });
  const pick = h('button', { type: 'button', class: 'terrain-pick', 'aria-haspopup': 'listbox', 'aria-label': `Choose terrain ${slot}` },
    h('span', { class: 'terrain-art' }, canvas, h('span', { class: 'slot-badge' }, slot), h('span', { class: 'terrain-busy', 'aria-hidden': 'true' })),
    h('span', { class: 'terrain-text' }, name, sub), h('span', { class: 'picker-caret', html: icon('chevron-down') }));
  const fileInput = h('input', { type: 'file', accept: ACCEPT, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const importBtn = h('button', {
    type: 'button', class: 'icon-btn icon-btn--sm terrain-import', disabled: !canImport,
    dataset: { tip: canImport ? 'Import your own image (height map) or audio recording. You can also drop a file here.' : 'Importing needs the audio engine, which is not available' },
    html: icon('import'), 'aria-label': `Import an image or audio into terrain ${slot}`,
  });
  const libraryBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': `Browse original image library for terrain ${slot}` }, 'Image library');
  parentScope.on(libraryBtn, 'click', () => openTerrainLibrary(ctx, libraryBtn, slot));
  const formulaBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': `Build terrain ${slot} from a formula` }, 'Formula');
  parentScope.on(formulaBtn, 'click', () => openFormulaTerrain(ctx, formulaBtn, slot));
  // v2.10 Real places (Earth, Moon, Mars, night sky) and Sonify your data
  const placesBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': `Real places and the night sky for terrain ${slot}` }, 'Real places');
  parentScope.on(placesBtn, 'click', () => openRealPlaces(ctx, placesBtn, slot));
  const dataBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': `Make terrain ${slot} or a melody from your data` }, 'Data');
  parentScope.on(dataBtn, 'click', () => openDataPanel(ctx, dataBtn, slot));
  const channel = createKnob(ctx, binder.partParam('imageChannel' + slot), { size: 'sm', label: 'Channel', ariaLabel: () => 'Image channel' });
  const mapping = createKnob(ctx, binder.partParam('imageMapping' + slot), { size: 'sm', label: 'Mapping', ariaLabel: () => 'Image mapping' });
  parentScope.add(channel.dispose); parentScope.add(mapping.dispose);
  const imageControls = h('div', { class: 'knob-grid knob-grid--2 knob-grid--tight' }, channel.el, mapping.el);
  const card = h('div', { class: 'terrain-card', style: { position: 'relative' } }, pick, importBtn);
  pick.style.width = '100%';
  const el = h('div', { class: 'terrain-slot', dataset: { slot } }, card, fileInput, h('div', { class: 'terrain-source-btns' }, libraryBtn, formulaBtn, placesBtn, dataBtn), imageControls);

  function render() {
    const part = binder.selected();
    const idx = store.get(`parts.${part}.params.${id}`) ?? 0;
    const t = TERRAINS[idx] || TERRAINS[0];
    const user = idx === TERRAIN_INDEX.user;
    const ut = store.get(`parts.${part}.userTerrain.${slot}`);
    imageControls.hidden = !user || !ut;
    channel.el.hidden = !ut?.channels;
    setText(name, user ? (ut ? ut.name : 'Imported') : t.name);
    setText(sub, user ? (ut ? (ut.libraryId ? 'Original procedural image' : ut.placeId ? (ut.placeId.startsWith('sky-') ? 'Real stars' : 'Real place') : ut.kind === 'wavetable' ? 'Your wavetable' : ut.kind === 'audio' ? 'Your audio recording' : ut.kind === 'formula' ? 'Formula: ' + (ut.formula || '') : 'Your image') : 'Nothing imported yet') : t.desc);
    pick.dataset.tip = user && !ut ? 'Import an image or audio to use this slot' : t.desc;
    const table = ctx.terrains ? ctx.terrains.get(part, slot) : null;
    drawTerrain(canvas, downsample(table, 112), { color: store.get(`parts.${part}.color`), theme: document.documentElement.dataset.theme });
    el.classList.toggle('is-empty', !table);
  }
  const invalidate = () => schedule(render);
  parentScope.add(binder.partParam(id).subscribe(invalidate));
  parentScope.add(store.subscribe('ui.selectedPart', invalidate));
  if (ctx.terrains) parentScope.add(ctx.terrains.on((p, sl) => { if (p === binder.selected() && sl === slot) invalidate(); }));
  parentScope.on(window, 'orograph:theme', invalidate);
  if (ctx.bus) parentScope.add(ctx.bus.on('part-colors', invalidate));

  let pop = null;
  parentScope.on(pick, 'click', () => {
    if (pop && pop.isOpen()) { pop.close(); return; }
    pop = openTerrainPicker(ctx, pick, slot, () => fileInput.click());
  });

  async function doImport(file, opts) {
    if (!file || !canImport) return;
    const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name);
    const isAudio = /^audio\//.test(file.type) || /\.(wav|mp3|m4a|aac|ogg|flac|aiff?)$/i.test(file.name);
    if (isAudio && !opts) { openAudioImportOptions(ctx, importBtn, file, o => doImport(file, o)); return; }
    if (isImage && !opts) { openImportOptions(ctx, importBtn, file, (o) => doImport(file, o)); return; }
    const part = binder.selected();
    el.classList.add('is-busy');
    try {
      await (opts ? ctx.engine.importTerrainFile(part, slot, file, opts) : ctx.engine.importTerrainFile(part, slot, file));
      ctx.toast(`Imported "${file.name}" as terrain ${slot}`, { kind: 'success' });
    } catch (err) {
      console.warn('[ui] terrain import failed', err);
      ctx.toast('Import did not work', { kind: 'error', detail: friendlyImportError(err) });
    } finally {
      el.classList.remove('is-busy');
      invalidate();
    }
  }
  parentScope.on(importBtn, 'click', () => fileInput.click());
  parentScope.on(fileInput, 'change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; doImport(f); });
  // Drop a file straight onto the slot.
  parentScope.on(el, 'dragover', (e) => { if (canImport && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); el.classList.add('is-drop'); } });
  parentScope.on(el, 'dragleave', () => el.classList.remove('is-drop'));
  parentScope.on(el, 'drop', (e) => { e.preventDefault(); el.classList.remove('is-drop'); doImport(e.dataTransfer && e.dataTransfer.files[0]); });

  render();
  return { el };
}

/** Options for turning an image into a height map, then Import. */
function openImportOptions(ctx, anchor, file, onImport) {
  const opts = { channel: 'r', smooth: 0.3, tile: 'mirror' };
  const seg = (label, key, options) => {
    const btns = options.map(([value, text]) => {
      const b = h('button', { type: 'button', class: ['seg-btn', opts[key] === value && 'is-on'], role: 'radio', 'aria-checked': String(opts[key] === value) }, text);
      b.addEventListener('click', () => {
        opts[key] = value;
        btns.forEach(x => { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-checked', String(on)); });
      });
      return b;
    });
    return h('div', { class: 'import-row' }, h('span', { class: 'mini-label' }, label), h('div', { class: 'seg seg--sm seg--plain', role: 'radiogroup', 'aria-label': label }, btns));
  };
  const smooth = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '0.3', class: 'range', 'aria-label': 'Smoothing' });
  smooth.addEventListener('input', () => { opts.smooth = Number(smooth.value); });
  const go = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('import') + '<span>Import</span>' });
  const cancel = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Cancel');
  const body = h('div', { class: 'import-pop' },
    h('div', { class: 'popover-title' }, 'Import height map'),
    h('p', { class: 'popover-note import-file' }, file.name),
    seg('Start channel', 'channel', [['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['luma', 'Brightness']]),
    h('div', { class: 'import-row' }, h('span', { class: 'mini-label' }, 'Smoothing'), smooth),
    seg('Edges', 'tile', [['mirror', 'Mirror'], ['wrap', 'Wrap']]),
    h('p', { class: 'popover-note' }, 'Mirror makes any image tile without seams. Wrap suits images that already tile. All color channels remain available to morph live. 16-bit PNG height maps keep their full detail.'),
    h('div', { class: 'import-actions' }, cancel, go));
  let pop;
  go.addEventListener('click', () => { pop.close('import'); onImport({ ...opts }); });
  cancel.addEventListener('click', () => pop.close('cancel'));
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--import', label: 'Import height map', placement: 'bottom-start', focus: '.btn--primary' });
  return pop;
}

/** Audio import supports full recordings as well as explicit single-cycle frames. */
function openAudioImportOptions(ctx, anchor, file, onImport) {
  const recording = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Entire recording');
  const wavetable = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Wavetable frames');
  const body = h('div', { class: 'import-pop' }, h('div', { class: 'popover-title' }, 'Import audio terrain'),
    h('p', { class: 'popover-note import-file' }, file.name),
    h('p', { class: 'popover-note' }, 'Entire recording lays consecutive waveform samples across a 512 × 512 terrain. Wavetable frames suits files made of single-cycle waves. Both support polar mapping.'),
    h('div', { class: 'import-actions' }, wavetable, recording));
  let pop;
  recording.addEventListener('click', () => { pop.close('import'); onImport({ audioMode: 'recording' }); });
  wavetable.addEventListener('click', () => { pop.close('import'); onImport({ audioMode: 'wavetable' }); });
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--import', label: 'Import audio terrain', placement: 'bottom-start', focus: '.btn--primary' });
  return pop;
}

/** Grid picker of all terrains with generated previews. */
function openTerrainPicker(ctx, anchor, slot, openImport) {
  const { store, binder } = ctx;
  const part = binder.selected();
  const p = store.get(`parts.${part}.params`) || {};
  const current = p['terrain' + slot];
  const color = store.get(`parts.${part}.color`);
  const theme = document.documentElement.dataset.theme;
  const listId = uniqueId('terrains');
  const desc = h('div', { class: 'picker-footer', id: listId + '-desc', 'aria-live': 'polite' });
  const items = TERRAINS.map((t, i) => {
    const c = h('canvas', { class: 'grid-thumb', width: 64, height: 64, 'aria-hidden': 'true' });
    const isUser = i === TERRAIN_INDEX.user;
    if (isUser) {
      const ut = store.get(`parts.${part}.userTerrain.${slot}`);
      const tbl = ctx.terrains && ut ? ctx.terrains.get(part, slot) : null;
      if (ut && tbl && current === i) drawTerrain(c, downsample(tbl, 64), { color, theme });
      else c.classList.add('is-import');
    } else {
      previewTable(i, { seed: p.seed ?? 7, detail: p.detail ?? 0.5, size: 64 }, (tbl) => drawTerrain(c, tbl, { color, theme }), true);
    }
    return h('button', {
      type: 'button', role: 'option', class: ['grid-item', i === current && 'is-current'], 'aria-selected': String(i === current), tabindex: i === current ? '0' : '-1',
      dataset: { index: String(i), desc: t.desc },
    }, h('span', { class: 'grid-art' }, c, isUser ? h('span', { class: 'grid-import', html: icon('import') }) : null), h('span', { class: 'grid-name' }, t.name));
  });
  if (!items.some(b => b.tabIndex === 0)) items[0].tabIndex = 0;
  const grid = h('div', { class: 'picker-grid', role: 'listbox', 'aria-label': `Terrain ${slot}`, 'aria-describedby': listId + '-desc' }, items);
  const body = h('div', { class: 'picker-pop' }, h('div', { class: 'popover-title' }, `Terrain ${slot}`), grid, desc);
  const show = (b) => setText(desc, b ? `${TERRAINS[+b.dataset.index].name}: ${b.dataset.desc}` : '');
  let pop;
  const choose = (b) => {
    const i = +b.dataset.index;
    if (i === TERRAIN_INDEX.user && !store.get(`parts.${part}.userTerrain.${slot}`)) { pop.close('select'); openImport(); return; }
    store.set(`parts.${part}.params.terrain${slot}`, i, { source: 'ui' });
    pop.close('select');
  };
  items.forEach(b => {
    b.addEventListener('click', () => choose(b));
    b.addEventListener('focus', () => show(b));
    b.addEventListener('pointerenter', () => show(b));
  });
  gridKeys(grid, items, 4);
  show(items.find(b => b.tabIndex === 0));
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--picker', label: `Choose terrain ${slot}`, placement: 'bottom-start', focus: '.grid-item[tabindex="0"]' });
  return pop;
}

function openPathPicker(ctx, anchor) {
  const { store, binder } = ctx;
  const part = binder.selected();
  const current = store.get(`parts.${part}.params.pathShape`) ?? 0;
  const desc = h('div', { class: 'picker-footer', 'aria-live': 'polite' });
  const items = PATHS.map((pth, i) => h('button', {
    type: 'button', role: 'option', class: ['grid-item', 'grid-item--path', i === current && 'is-current'], 'aria-selected': String(i === current), tabindex: i === current ? '0' : '-1',
    dataset: { index: String(i), desc: pth.desc },
  }, h('span', { class: 'grid-art' }, s('svg', { class: 'path-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: pathOutline(i, i === 6 ? 2 : 3, 0.5, 24, 2.5, 200) }))),
  h('span', { class: 'grid-name' }, pth.name)));
  const grid = h('div', { class: 'picker-grid', role: 'listbox', 'aria-label': 'Path shape' }, items);
  const body = h('div', { class: 'picker-pop' }, h('div', { class: 'popover-title' }, 'Path'), grid, desc);
  const show = (b) => setText(desc, b ? `${PATHS[+b.dataset.index].name}: ${b.dataset.desc}` : '');
  let pop;
  items.forEach(b => {
    b.addEventListener('click', () => { store.set(`parts.${part}.params.pathShape`, +b.dataset.index, { source: 'ui' }); pop.close('select'); });
    b.addEventListener('focus', () => show(b));
    b.addEventListener('pointerenter', () => show(b));
  });
  gridKeys(grid, items, 4);
  show(items[current]);
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--picker', label: 'Choose path shape', placement: 'bottom-start', focus: '.grid-item[tabindex="0"]' });
  return pop;
}

/** Arrow-key navigation for a grid of buttons with a roving tabindex. */
export function gridKeys(grid, items, cols) {
  grid.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    let n = null;
    if (e.key in map) n = Math.max(0, Math.min(items.length - 1, i + map[e.key]));
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n == null) return;
    e.preventDefault();
    items.forEach((b, k) => { b.tabIndex = k === n ? 0 : -1; });
    items[n].focus();
  });
}
