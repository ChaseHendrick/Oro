// Patch browser in the top bar: previous / next, a searchable categorised
// list of patches and scenes, Save, Dice (randomise) and Init, plus scene
// saving and JSON export / import in the list footer. With the pedal rig, the
// save forms have a "Pedal presets" section and your own scenes and patches a
// button to edit theirs.

import { h, createScope, setText, listen, call, has, uniqueId, downloadBlob, softDisable } from './dom.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';
import { createPedalPresetFields, openPedalPresetEditor } from './pedal-presets-form.js';
import { describePedalPresets } from '../pedals/pedal-presets.js';
import { has as hasFun } from '../core/fun.js';
import { CABINET_PATCH } from '../presets/hidden-patches.js';
import { loadPostcardFile } from './postcard.js';
import { wordPatch, normalizeWord, MAX_WORD } from '../presets/word-seed.js';
import { found } from '../core/fun.js';

export function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [item.name, item.category, item.author, item.folder, item.description, ...(item.tags || [])].filter(Boolean).join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

export function groupByCategory(items, order = []) {
  const groups = new Map();
  for (const c of order) groups.set(c, []);
  for (const it of items) {
    const c = it.category || 'Other';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(it);
  }
  return [...groups].filter(([, list]) => list.length);
}

/** v2.9 patches unlocked by a secret (src/ui/eggs.js): listed after the factory ones, loaded as objects. */
export function hiddenPatches(unlocked = hasFun('secret', 'konami')) {
  if (!unlocked) return [];
  return [{ id: 'secret-cabinet', name: CABINET_PATCH.name, category: CABINET_PATCH.category, factory: true, tags: [...CABINET_PATCH.tags], author: '', folder: CABINET_PATCH.folder, favoriteSlots: [], pedalPresets: null, patch: CABINET_PATCH }];
}

export function createPatchBrowser(ctx) {
  const scope = createScope();
  const { store, binder, presets } = ctx;
  const ok = !!presets && has(presets, 'patches');
  const btn = (name, label, extra = {}) => h('button', { type: 'button', class: ['icon-btn', extra.cls], 'aria-label': label, dataset: { tip: extra.tip || label }, html: icon(name), disabled: !ok });

  const prev = btn('chevron-left', 'Previous patch', { tip: 'Previous patch ( [ )' });
  const next = btn('chevron-right', 'Next patch', { tip: 'Next patch ( ] )' });
  const nameEl = h('span', { class: 'patch-name' });
  const catEl = h('span', { class: 'patch-cat' });
  const open = h('button', {
    type: 'button', class: 'patch-open', 'aria-haspopup': 'dialog', disabled: !ok,
    dataset: { tip: ok ? 'Browse patches and scenes' : 'Presets are not available' },
  }, h('span', { class: 'patch-texts' }, catEl, nameEl), h('span', { class: 'picker-caret', html: icon('chevron-down') }));
  const save = btn('save', 'Save patch', { tip: 'Save this part as a patch' });
  const dice = btn('dice', 'Randomise patch', { tip: 'Roll a new random patch' });
  const init = btn('init', 'Initialise patch', { tip: 'Start from a clean Init patch' });
  // Preview plays a short phrase that suits the patch, so a sound can be judged
  // without reaching for a keyboard. It needs the music engine, not the presets.
  const canPreview = has(ctx.music, 'preview');
  const preview = h('button', {
    type: 'button', class: 'icon-btn preview-btn', 'aria-label': 'Preview this patch', 'aria-pressed': 'false', html: icon('preview'),
    dataset: { tip: 'Hear this patch play a short phrase (Shift+P)' },
  });
  if (!canPreview) softDisable(preview, 'Preview needs the music engine, which is not available here', (r) => ctx.toast(r, { kind: 'info' }));
  const el = h('div', { class: ['patch-browser', !ok && 'is-disabled'], role: 'group', 'aria-label': 'Patch' },
    h('div', { class: 'patch-main' }, prev, open, next), h('div', { class: 'patch-tools' }, preview, save, dice, init));

  function currentPatch() {
    const p = binder.selected();
    const name = store.get(`parts.${p}.patchName`) || 'Init';
    let cat = '';
    if (ok) {
      const list = call(presets, 'patches') || [];
      const hit = list.find(x => x.name === name);
      if (hit) cat = hit.category || '';
    }
    return { name, cat };
  }
  function render() {
    const { name, cat } = currentPatch();
    setText(nameEl, name);
    setText(catEl, cat || (ok ? 'Patch' : 'No presets'));
    open.setAttribute('aria-label', `Patch: ${name}. Open the browser`);
    // The name can be cut short in the top bar: the full name on hover and keyboard focus.
    open.dataset.tip = name;
    open.dataset.tipTitle = cat || 'Patch';
    open.dataset.tipFocus = '1';
  }
  scope.add(store.subscribe('ui.selectedPart', render));
  scope.add(store.subscribe('parts', (path) => { if (/^parts(\.\d(\.patchName)?)?$/.test(path)) render(); }));
  scope.add(store.subscribe('', (path) => { if (path === '') render(); }));
  if (ok) scope.add(listen(presets, 'change', render));
  render();

  const step = (dir) => { if (ok) call(presets, 'nextPatch', binder.selected(), dir); };
  scope.on(prev, 'click', () => step(-1));
  scope.on(next, 'click', () => step(1));
  scope.on(dice, 'click', () => { if (ok) call(presets, 'randomizePatch', binder.selected()); });
  scope.on(init, 'click', () => { if (ok) call(presets, 'initPatch', binder.selected()); });
  scope.on(save, 'click', () => openSaveForm(ctx, save, 'patch'));
  const setPreviewing = (on) => {
    preview.classList.toggle('is-on', on);
    preview.setAttribute('aria-pressed', String(on));
  };
  scope.on(preview, 'click', async () => {
    if (!canPreview) return;
    if (has(ctx.music, 'isPreviewing') && ctx.music.isPreviewing()) { call(ctx.music, 'stopPreview'); setPreviewing(false); return; }
    await ctx.startAudio();
    const res = call(ctx.music, 'preview', 'sel');
    // Without preview events, light the button for roughly the phrase length.
    if (!has(ctx.music, 'on')) { setPreviewing(true); setTimeout(() => setPreviewing(false), 1600); }
    else if (res && res.duration) setPreviewing(true);
  });
  if (canPreview && has(ctx.music, 'on')) {
    scope.add(listen(ctx.music, 'preview', (e) => setPreviewing(!!(e && e.playing))));
  }

  let pop = null;
  scope.on(open, 'click', () => {
    if (pop && pop.isOpen()) { pop.close(); return; }
    pop = openBrowser(ctx, open);
  });

  return { el, step, openBrowser: () => { if (ok) pop = openBrowser(ctx, open); }, dispose: scope.dispose };
}

/**
 * Seed from a word (v2.9): the word picks the land and the sound, the same on
 * any computer. Loading it is one patch load (one undo step).
 */
function wordSeedForm(ctx, part) {
  const { presets } = ctx;
  const id = uniqueId('word-seed');
  const input = h('input', { id, class: 'field field--sm', type: 'text', maxlength: String(MAX_WORD), placeholder: 'Any word', autocomplete: 'off', spellcheck: 'false' });
  const go = h('button', { type: 'submit', class: 'btn btn--ghost btn--xs' }, 'Go');
  const ok = has(presets, 'loadPatch');
  if (!ok) { input.disabled = true; go.disabled = true; }
  const form = h('form', { class: 'word-seed' }, h('label', { class: 'word-seed-label', for: id }, 'Seed from a word'), h('div', { class: 'word-seed-row' }, input, go));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const word = normalizeWord(input.value);
    const patch = word ? wordPatch(word) : null;
    if (!ok || !patch) { input.focus(); return; }
    if (call(presets, 'loadPatch', part, patch) === false) return;
    found('badge', 'seed-word');
    ctx.toast(`Seeded from "${word}"`, { kind: 'info' });
  });
  return form;
}

/** Your own scene or patch called `name`, as listed (with its pedal presets), or null. */
function userItem(presets, kind, name) {
  const list = (kind === 'patch' ? call(presets, 'patches') : call(presets, 'scenes')) || [];
  return list.find(x => !x.factory && x.name === name) || null;
}

/** Small popover asking for a name, then saving a patch or a scene. */
export function openSaveForm(ctx, anchor, kind) {
  const { store, binder, presets } = ctx;
  if (!presets) return null;
  const part = binder.selected();
  const current = kind === 'patch' ? (store.get(`parts.${part}.patchName`) || '') : '';
  const input = h('input', {
    class: 'field', type: 'text', maxlength: '60', 'aria-label': kind === 'patch' ? 'Patch name' : 'Scene name',
    value: current && current !== 'Init' ? current : '', placeholder: kind === 'patch' ? 'My patch' : 'My scene',
  });
  const initial = userItem(presets, kind, current);
  const metadata = kind === 'patch' ? { category: h('input', { class: 'field', 'aria-label': 'Patch category', maxlength: '30', value: initial?.category || 'User' }), author: h('input', { class: 'field', 'aria-label': 'Patch author', maxlength: '60', value: initial?.author || 'Chase Hendrick' }), folder: h('input', { class: 'field', 'aria-label': 'Patch folder', maxlength: '80', value: initial?.folder || 'My patches' }) } : null;
  const go = h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, 'Save');
  // Pedal presets (v1.1): only with the pedal rig and a pedal that takes presets.
  const existing = () => userItem(presets, kind, input.value.trim());
  const fields = createPedalPresetFields(ctx, { kind, initial: (existing() || {}).pedalPresets || null });
  if (fields) {
    // Typing the name of one of your own scenes or patches shows its pedal presets (until you change them).
    input.addEventListener('input', () => { if (!fields.touched()) fields.fill((existing() || {}).pedalPresets || null); });
  }
  const form = h('form', { class: 'save-form' },
    h('div', { class: 'popover-title' }, kind === 'patch' ? 'Save patch' : 'Save scene'),
    h('p', { class: 'popover-note' }, kind === 'patch' ? 'Saves the sound of this part (not its pattern) to your patches.' : 'Saves all tracks, patterns, tempo and key as a scene.'),
    h('div', { class: 'save-row' }, input, go),
    metadata ? h('div', { class: 'patch-metadata' }, ...Object.entries(metadata).map(([key, input]) => h('label', null, h('span', { class: 'mini-label' }, key[0].toUpperCase() + key.slice(1)), input))) : null,
    fields ? fields.el : null);
  let pop;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim() || (kind === 'patch' ? 'My patch' : 'My scene');
    // Left out (no section), an existing scene or patch keeps the pedal presets it had.
    let pedalPresets;
    if (fields) {
      const r = fields.read();
      if (!r.ok) { ctx.toast(r.reason, { kind: 'error' }); if (r.input) r.input.focus(); return; }
      pedalPresets = r.value;
    }
    try {
      let saved = name;
      if (kind === 'patch') {
        const id = presets.savePatch(part, name, { pedalPresets, category: metadata.category.value, author: metadata.author.value, folder: metadata.folder.value });
        saved = (typeof presets.getPatch === 'function' && id != null && presets.getPatch(id)?.name) || store.get(`parts.${part}.patchName`) || name;
      } else {
        const id = presets.saveScene(name, { pedalPresets });
        saved = (typeof presets.getScene === 'function' && id != null && presets.getScene(id)?.name) || name;
      }
      if (typeof presets.settled === 'function' && !await presets.settled()) throw new Error('Storage is unavailable');
      ctx.toast(kind === 'patch' ? `Saved patch "${saved}"` : `Saved scene "${saved}"`, { kind: 'success' });
    } catch (err) {
      console.warn('[ui] save failed', err);
      ctx.toast('Could not save', { kind: 'error', detail: 'Your browser may be blocking storage for this page.' });
    }
    pop.close('saved');
  });
  pop = openPopover(ctx.layers, anchor, form, { className: 'popover--save', label: kind === 'patch' ? 'Save patch' : 'Save scene', placement: 'bottom-start' });
  input.focus();
  input.select();
  return pop;
}

function openBrowser(ctx, anchor) {
  const scope = createScope();
  const { store, binder, presets } = ctx;
  const part = binder.selected();
  const listId = uniqueId('presets');
  let tab = 'patches';
  let query = '';
  let activeIdx = -1;
  let options = [];

  const search = h('input', {
    class: 'field field--search', type: 'search', placeholder: 'Search patches', 'aria-label': 'Search', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list',
  });
  const tabPatches = h('button', { type: 'button', class: 'tab-btn', role: 'tab', 'aria-selected': 'true' }, 'Patches');
  const tabFavorites = h('button', { type: 'button', class: 'tab-btn', role: 'tab', 'aria-selected': 'false' }, 'Favourites (36)');
  const folder = h('select', { class: 'select select--sm', 'aria-label': 'Patch folder filter' });
  let folderFilter = '';
  const tabScenes = h('button', { type: 'button', class: 'tab-btn', role: 'tab', 'aria-selected': 'false' }, 'Scenes');
  const list = h('div', { class: 'preset-list', id: listId, role: 'listbox', 'aria-label': 'Presets' });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json,.png,image/png', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  // v2.9 the selected track's sound as a postcard image and share link
  const postcardBtn = ctx.openPostcard ? h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('postcard') + '<span>Postcard</span>', dataset: { tip: 'Share this track\'s sound as an image and a link' } }) : null;
  const saveScene = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('scene') + '<span>Save scene</span>' });
  const exportBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('export') + '<span>Export</span>', disabled: !has(presets, 'exportJSON') });
  const importBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('import') + '<span>Import</span>', disabled: !has(presets, 'importJSON') });
  const body = h('div', { class: 'browser' },
    h('div', { class: 'browser-top' },
      h('div', { class: 'search-wrap' }, h('span', { class: 'search-icon', html: icon('search') }), search),
      h('div', { class: 'tabs tabs--sm', role: 'tablist', 'aria-label': 'Preset type' }, tabPatches, tabScenes, tabFavorites)),
    folder,
    list,
    wordSeedForm(ctx, part),
    h('footer', { class: 'browser-foot' }, saveScene, postcardBtn, h('span', { class: 'spacer' }), exportBtn, importBtn, fileInput));

  function items() {
    if (tab === 'patches') return [...(call(presets, 'patches') || []), ...hiddenPatches()].filter(p => matchesQuery(p, query) && (!folderFilter || p.folder === folderFilter));
    return (call(presets, 'scenes') || []).filter(sc => matchesQuery(sc, query));
  }

  function render() {
    list.textContent = '';
    options = [];
    folder.hidden = tab !== 'patches'; search.hidden = tab === 'favorites';
    const folders = [...new Set((call(presets, 'patches') || []).map(p => p.folder).filter(Boolean))].sort();
    folder.textContent = ''; folder.append(h('option', { value: '' }, 'All folders'));
    for (const name of folders) folder.append(h('option', { value: name }, name));
    folder.value = folderFilter;
    if (tab === 'favorites') {
      list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'MIDI Program Change favourites');
      list.append(h('p', { class: 'popover-note' }, 'Program numbers 1 to 36 recall these slots when MIDI Program Change is enabled in Settings. Once a slot is assigned, empty slots ignore Program Change. An entirely empty bank uses the original patch order.'));
      const favorites = call(presets, 'favorites') || Array(36).fill(null), all = call(presets, 'patches') || [];
      const grid = h('div', { class: 'favorite-grid' });
      favorites.forEach((patch, index) => {
        const picker = h('select', { class: 'select select--sm', 'aria-label': `Favourite slot ${index + 1}` }, h('option', { value: '' }, 'Empty'));
        for (const p of all) picker.append(h('option', { value: p.id }, p.name));
        picker.value = patch?.id || '';
        picker.addEventListener('change', () => call(presets, 'setFavorite', index, picker.value || null));
        const recall = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', 'aria-label': `Recall favourite ${index + 1}`, disabled: !patch }, String(index + 1).padStart(2, '0'));
        recall.addEventListener('click', () => { if (patch) call(presets, 'loadPatch', part, patch.id); });
        grid.append(h('div', { class: 'favorite-slot' }, recall, picker));
      });
      list.append(grid); search.removeAttribute('aria-activedescendant'); return;
    }
    list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Presets');
    const current = store.get(`parts.${part}.patchName`);
    const data = items();
    if (!data.length) {
      list.appendChild(h('div', { class: 'preset-empty' }, query ? `Nothing matches "${query}".` : tab === 'patches' ? 'No patches yet.' : 'No scenes yet.'));
      search.removeAttribute('aria-activedescendant');
      return;
    }
    const groups = tab === 'patches'
      ? groupByCategory(data, call(presets, 'categories') || [])
      : [['Factory scenes', data.filter(s => s.factory)], ['Your scenes', data.filter(s => !s.factory)]].filter(([, l]) => l.length);
    for (const [cat, entries] of groups) {
      const gid = uniqueId('grp');
      const group = h('div', { class: 'preset-group', role: 'group', 'aria-labelledby': gid }, h('div', { class: 'preset-cat', id: gid }, cat));
      for (const it of entries) {
        const id = uniqueId('opt');
        const isCurrent = tab === 'patches' && it.name === current;
        const del = it.factory ? null : h('button', { type: 'button', class: 'icon-btn icon-btn--xs preset-del', tabindex: '-1', 'aria-label': `Delete ${it.name}`, html: icon('trash') });
        // Your own scenes and patches: edit the pedal presets they recall (v1.1).
        const pedalBtn = it.factory || !ctx.pedals ? null : h('button', {
          type: 'button', class: 'icon-btn icon-btn--xs preset-pedals-btn', tabindex: '-1', 'aria-label': `Pedal presets of ${it.name}`,
          dataset: { tip: 'Pedal presets' }, html: icon('pedal'),
        });
        const meta = tab === 'scenes' ? h('span', { class: 'preset-meta' }, [it.tempo ? `${Math.round(it.tempo)} BPM` : '', it.key || ''].filter(Boolean).join(' · ')) : (it.factory ? null : h('span', { class: 'badge' }, 'User'));
        const pedalText = describePedalPresets(it.pedalPresets);
        const opt = h('div', {
          class: ['preset-item', isCurrent && 'is-current'], role: 'option', id, 'aria-selected': String(isCurrent), dataset: { id: String(it.id) },
        }, h('span', { class: 'preset-texts' }, h('span', { class: 'preset-name' }, it.name),
          tab === 'patches' && (it.author || it.folder) ? h('span', { class: 'preset-desc' }, [it.author, it.folder].filter(Boolean).join(' · ')) : null,
          tab === 'scenes' && it.description ? h('span', { class: 'preset-desc' }, it.description) : null,
          pedalText ? h('span', { class: 'preset-desc preset-pedals' }, `Pedals: ${pedalText}`) : null), meta, pedalBtn, del);
        opt.addEventListener('pointerdown', (e) => { if (!e.target.closest('.preset-del, .preset-pedals-btn')) e.preventDefault(); });
        opt.addEventListener('click', (e) => {
          if (e.target.closest('.preset-del, .preset-pedals-btn')) return;
          choose(it);
        });
        if (pedalBtn) {
          pedalBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const kind = tab === 'patches' ? 'patch' : 'scene';
            pop.close('pedals');
            openPedalPresetEditor(ctx, anchor, kind, it);
          });
        }
        if (del) {
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!del.classList.contains('is-confirm')) {
              del.classList.add('is-confirm');
              del.innerHTML = '<span>Delete?</span>';
              setTimeout(() => { if (del.isConnected) { del.classList.remove('is-confirm'); del.innerHTML = icon('trash'); } }, 2500);
              return;
            }
            call(presets, 'deleteUser', tab === 'patches' ? 'patch' : 'scene', it.id);
            ctx.toast(`Deleted "${it.name}"`, { kind: 'info' });
            render();
          });
        }
        options.push({ el: opt, item: it });
        group.appendChild(opt);
      }
      list.appendChild(group);
    }
    const cur = options.findIndex(o => o.el.classList.contains('is-current'));
    setActive(cur >= 0 ? cur : 0, cur >= 0);
  }

  function setActive(i, scroll = true) {
    if (!options.length) return;
    activeIdx = Math.max(0, Math.min(options.length - 1, i));
    options.forEach((o, k) => o.el.classList.toggle('is-active', k === activeIdx));
    const el = options[activeIdx].el;
    search.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function choose(it) {
    if (tab === 'patches') {
      call(presets, 'loadPatch', part, it.patch || it.id);
      render();
    } else {
      call(presets, 'loadScene', it.id);
      ctx.toast(`Loaded scene "${it.name}"`, { kind: 'success' });
      pop.close('select');
    }
  }

  function setTab(t) {
    tab = t;
    tabPatches.setAttribute('aria-selected', String(t === 'patches'));
    tabScenes.setAttribute('aria-selected', String(t === 'scenes'));
    tabFavorites.setAttribute('aria-selected', String(t === 'favorites'));
    search.placeholder = t === 'patches' ? 'Search patches' : 'Search scenes';
    render();
  }
  scope.on(tabPatches, 'click', () => setTab('patches'));
  scope.on(tabScenes, 'click', () => setTab('scenes'));
  scope.on(tabFavorites, 'click', () => setTab('favorites'));
  scope.on(folder, 'change', () => { folderFilter = folder.value; render(); });
  scope.on(search, 'input', () => { query = search.value.trim(); render(); });
  scope.on(search, 'keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive(activeIdx + 8); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive(activeIdx - 8); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[activeIdx]) choose(options[activeIdx].item); }
    else if (e.key === 'Tab' && !e.shiftKey && document.activeElement === search) { /* move into the tabs naturally */ }
  });
  scope.on(saveScene, 'click', () => { pop.close('scene'); openSaveForm(ctx, anchor, 'scene'); });
  scope.on(exportBtn, 'click', () => {
    try {
      const blob = presets.exportJSON('all');
      downloadBlob(blob, 'oro-presets.json');
      ctx.toast('Exported your patches and scenes', { kind: 'success' });
    } catch (err) {
      console.warn('[ui] export failed', err);
      ctx.toast('Export did not work', { kind: 'error' });
    }
  });
  if (postcardBtn) scope.on(postcardBtn, 'click', () => { pop.close('postcard'); ctx.openPostcard(part); });
  scope.on(importBtn, 'click', () => fileInput.click());
  scope.on(fileInput, 'change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    // v2.9 a postcard image loads its sound onto this track
    if (/\.png$/i.test(file.name || '') || file.type === 'image/png') {
      if (!(await loadPostcardFile(ctx, file))) ctx.toast('Import did not work', { kind: 'error', detail: 'This image has no Oro sound in it. Postcards made with Oro carry one.' });
      return;
    }
    try {
      const res = await presets.importJSON(file);
      const n = (res && res.patches) || 0, m = (res && res.scenes) || 0;
      ctx.toast(n || m ? `Imported ${n} patch${n === 1 ? '' : 'es'} and ${m} scene${m === 1 ? '' : 's'}` : 'Imported favorite bank', { kind: 'success' });
      render();
    } catch (err) {
      console.warn('[ui] import failed', err);
      const msg = String((err && err.message) || '');
      const friendly = msg && msg.length < 140 && !/JSON|Unexpected|undefined|null|cannot read/i.test(msg) ? msg : 'That file does not look like an Oro preset file.';
      ctx.toast('Import did not work', { kind: 'error', detail: friendly });
    }
  });
  scope.add(listen(presets, 'change', () => { if (body.isConnected) render(); }));

  render();
  const pop = openPopover(ctx.layers, anchor, body, { className: 'popover--browser', label: 'Patch browser', placement: 'bottom-start', focus: false, onClose: () => scope.dispose() });
  search.focus();
  return pop;
}
