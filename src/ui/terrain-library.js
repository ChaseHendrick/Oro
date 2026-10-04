// Browsable original procedural PNG imagery. Only the visible page generates
// thumbnails; a selected image is built at 512 x 512 and saved in the session.
import { h, setText } from './dom.js';
import { openPopover } from './layers.js';
import { TERRAIN_LIBRARY, TERRAIN_LIBRARY_CATEGORIES, searchTerrainLibrary, terrainLibraryPng } from '../dsp/terrain-library.js';
import { bytesToBase64, readTerrainFile, addUserTerrain } from '../audio/importers.js';
import { has } from '../core/fun.js';
import { chunks } from './lazy.js';

const thumbnails = new Map();
const PAGE_SIZE = 16;
function thumb(id) {
  if (thumbnails.has(id)) return thumbnails.get(id);
  const url = 'data:image/png;base64,' + bytesToBase64(terrainLibraryPng(id, 64));
  if (thumbnails.size >= 64) thumbnails.delete(thumbnails.keys().next().value);
  thumbnails.set(id, url);
  return url;
}

export function openTerrainLibrary(ctx, anchor, slot) {
  const part = ctx.binder.selected();
  let page = 0, generation = 0, busy = false, pop;
  const search = h('input', { type: 'search', placeholder: 'Search original images', 'aria-label': 'Search terrain library', class: 'field' });
  const category = h('select', { 'aria-label': 'Terrain image category', class: 'select-native' }, h('option', { value: '' }, 'All categories'), TERRAIN_LIBRARY_CATEGORIES.map(c => h('option', { value: c }, c)));
  search.style.minWidth = category.style.minWidth = '0';
  search.style.width = category.style.width = '100%';
  const grid = h('div', { class: 'picker-grid', 'aria-label': 'Original terrain images' });
  const status = h('span', { class: 'popover-note', 'aria-live': 'polite' });
  const previous = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Previous');
  const next = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Next');
  const detail = h('p', { class: 'popover-note', 'aria-live': 'polite' }, 'Select an image to load terrain ' + slot + '.');
  // v2.10: real elevation data and stars live in their own section
  const realPlaces = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Real places: Earth, Moon, Mars and the night sky');
  realPlaces.addEventListener('click', () => { pop.close('switch'); chunks.realPlaces.run(m => m.openRealPlaces(ctx, anchor, slot), 'Real places'); });
  const body = h('div', { class: 'picker-pop' }, h('div', { class: 'popover-title' }, 'Original image terrains'),
    h('p', { class: 'popover-note' }, `${TERRAIN_LIBRARY.length} original procedural images. Each generates a real 512 × 512 PNG. All work offline.`),
    h('div', { class: 'import-row', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' } }, search, category), grid,
    h('div', { class: 'import-actions' }, previous, status, next), detail, realPlaces);

  async function choose(entry, button) {
    if (busy) return;
    busy = true; button.disabled = true; setText(detail, 'Generating ' + entry.name + ' at 512 × 512…');
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      const png = terrainLibraryPng(entry.id);
      const file = new File([png], entry.name + '.png', { type: 'image/png' });
      const ut = await readTerrainFile(file, entry.name, { channel: 'r', smooth: 0.1, tile: 'mirror' });
      await addUserTerrain(ctx.store, part, slot, { ...ut, libraryId: entry.id }, { source: 'ui' });
      ctx.toast(`Loaded ${entry.name} into terrain ${slot}`, { kind: 'success' });
      pop.close('select');
    } catch (err) {
      setText(detail, err.message || 'The image could not be loaded.');
      button.disabled = false;
    } finally { busy = false; }
  }
  function render(reset = false) {
    if (reset) page = 0;
    // v2.9 the Cabinet appears once its secret is found (src/ui/eggs.js)
    const all = searchTerrainLibrary(search.value, category.value, { hidden: has('secret', 'konami') }), pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const visible = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), gen = ++generation;
    const selected = ctx.store.get(`parts.${part}.userTerrain.${slot}`)?.libraryId;
    const items = visible.map(entry => {
      const img = h('img', { width: '64', height: '64', alt: '', class: 'grid-thumb' });
      const b = h('button', { type: 'button', class: ['grid-item', entry.id === selected && 'is-current'], 'aria-label': `${entry.name}: ${entry.desc}`, 'aria-pressed': String(entry.id === selected) }, h('span', { class: 'grid-art' }, img), h('span', { class: 'grid-name' }, entry.name));
      b.addEventListener('click', () => choose(entry, b));
      b.addEventListener('focus', () => setText(detail, entry.desc + '. Original procedural imagery.'));
      b.addEventListener('pointerenter', () => setText(detail, entry.desc + '. Original procedural imagery.'));
      return { entry, img, b };
    });
    grid.replaceChildren(...items.map(x => x.b));
    setText(status, `${all.length} images · ${page + 1}/${pages}`); previous.disabled = page === 0; next.disabled = page + 1 === pages;
    (async () => {
      for (const item of items) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (gen !== generation || !pop?.isOpen()) return;
        item.img.src = thumb(item.entry.id);
      }
    })();
    pop?.reposition();
  }
  search.addEventListener('input', () => render(true)); category.addEventListener('change', () => render(true));
  previous.addEventListener('click', () => { page--; render(); }); next.addEventListener('click', () => { page++; render(); });
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--picker', label: 'Original terrain image library', placement: 'bottom-start', focus: 'input' });
  render();
  return pop;
}
