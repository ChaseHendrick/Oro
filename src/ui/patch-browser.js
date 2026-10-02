// Patch browser in the top bar: previous / next, a searchable categorised
// list of patches and scenes, Save, Dice (randomise) and Init, plus scene
// saving and JSON export / import in the list footer.

import { h, createScope, setText, listen, call, has, uniqueId, downloadBlob } from './dom.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';

export function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [item.name, item.category, item.description, ...(item.tags || [])].filter(Boolean).join(' ').toLowerCase();
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
  const el = h('div', { class: ['patch-browser', !ok && 'is-disabled'], role: 'group', 'aria-label': 'Patch' },
    h('div', { class: 'patch-main' }, prev, open, next), h('div', { class: 'patch-tools' }, save, dice, init));

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

  let pop = null;
  scope.on(open, 'click', () => {
    if (pop && pop.isOpen()) { pop.close(); return; }
    pop = openBrowser(ctx, open);
  });

  return { el, step, openBrowser: () => { if (ok) pop = openBrowser(ctx, open); }, dispose: scope.dispose };
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
  const go = h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, 'Save');
  const form = h('form', { class: 'save-form' },
    h('div', { class: 'popover-title' }, kind === 'patch' ? 'Save patch' : 'Save scene'),
    h('p', { class: 'popover-note' }, kind === 'patch' ? 'Saves the sound of this part (not its pattern) to your patches.' : 'Saves all four parts, patterns, tempo and key as a scene.'),
    h('div', { class: 'save-row' }, input, go));
  let pop;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim() || (kind === 'patch' ? 'My patch' : 'My scene');
    try {
      let saved = name;
      if (kind === 'patch') {
        const id = presets.savePatch(part, name);
        saved = (typeof presets.getPatch === 'function' && id != null && presets.getPatch(id)?.name) || store.get(`parts.${part}.patchName`) || name;
      } else {
        const id = presets.saveScene(name);
        saved = (typeof presets.getScene === 'function' && id != null && presets.getScene(id)?.name) || name;
      }
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
  const tabScenes = h('button', { type: 'button', class: 'tab-btn', role: 'tab', 'aria-selected': 'false' }, 'Scenes');
  const list = h('div', { class: 'preset-list', id: listId, role: 'listbox', 'aria-label': 'Presets' });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const saveScene = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('scene') + '<span>Save scene</span>' });
  const exportBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('export') + '<span>Export</span>', disabled: !has(presets, 'exportJSON') });
  const importBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('import') + '<span>Import</span>', disabled: !has(presets, 'importJSON') });
  const body = h('div', { class: 'browser' },
    h('div', { class: 'browser-top' },
      h('div', { class: 'search-wrap' }, h('span', { class: 'search-icon', html: icon('search') }), search),
      h('div', { class: 'tabs tabs--sm', role: 'tablist', 'aria-label': 'Preset type' }, tabPatches, tabScenes)),
    list,
    h('footer', { class: 'browser-foot' }, saveScene, h('span', { class: 'spacer' }), exportBtn, importBtn, fileInput));

  function items() {
    if (tab === 'patches') return (call(presets, 'patches') || []).filter(p => matchesQuery(p, query));
    return (call(presets, 'scenes') || []).filter(sc => matchesQuery(sc, query));
  }

  function render() {
    list.textContent = '';
    options = [];
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
        const meta = tab === 'scenes' ? h('span', { class: 'preset-meta' }, [it.tempo ? `${Math.round(it.tempo)} BPM` : '', it.key || ''].filter(Boolean).join(' · ')) : (it.factory ? null : h('span', { class: 'badge' }, 'User'));
        const opt = h('div', {
          class: ['preset-item', isCurrent && 'is-current'], role: 'option', id, 'aria-selected': String(isCurrent), dataset: { id: String(it.id) },
        }, h('span', { class: 'preset-texts' }, h('span', { class: 'preset-name' }, it.name), tab === 'scenes' && it.description ? h('span', { class: 'preset-desc' }, it.description) : null), meta, del);
        opt.addEventListener('pointerdown', (e) => { if (!e.target.closest('.preset-del')) e.preventDefault(); });
        opt.addEventListener('click', (e) => {
          if (e.target.closest('.preset-del')) return;
          choose(it);
        });
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
      call(presets, 'loadPatch', part, it.id);
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
    search.placeholder = t === 'patches' ? 'Search patches' : 'Search scenes';
    render();
  }
  scope.on(tabPatches, 'click', () => setTab('patches'));
  scope.on(tabScenes, 'click', () => setTab('scenes'));
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
      downloadBlob(blob, 'orograph-presets.json');
      ctx.toast('Exported your patches and scenes', { kind: 'success' });
    } catch (err) {
      console.warn('[ui] export failed', err);
      ctx.toast('Export did not work', { kind: 'error' });
    }
  });
  scope.on(importBtn, 'click', () => fileInput.click());
  scope.on(fileInput, 'change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const res = await presets.importJSON(file);
      const n = (res && res.patches) || 0, m = (res && res.scenes) || 0;
      ctx.toast(`Imported ${n} patch${n === 1 ? '' : 'es'} and ${m} scene${m === 1 ? '' : 's'}`, { kind: 'success' });
      render();
    } catch (err) {
      console.warn('[ui] import failed', err);
      const msg = String((err && err.message) || '');
      const friendly = msg && msg.length < 140 && !/JSON|Unexpected|undefined|null|cannot read/i.test(msg) ? msg : 'That file does not look like an Orograph preset file.';
      ctx.toast('Import did not work', { kind: 'error', detail: friendly });
    }
  });
  scope.add(listen(presets, 'change', () => { if (body.isConnected) render(); }));

  render();
  const pop = openPopover(ctx.layers, anchor, body, { className: 'popover--browser', label: 'Patch browser', placement: 'bottom-start', focus: false, onClose: () => scope.dispose() });
  search.focus();
  return pop;
}
