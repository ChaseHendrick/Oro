// Version history panel (v2.12), loaded on demand from the top bar. Lists
// the saved versions by day, with Preview / Restore / Rename / Delete /
// Export, and shows the "Previewing ..." bar while a version is on trial.
// The versions themselves live in src/core/versions.js.

import '../styles/archive.css';
import { h, setText, downloadBlob } from './dom.js';
import { openModal } from './modal.js';
import { startVersions } from '../core/versions.js';
import { FORMAT, PRESET_VERSION } from '../presets/presets.js';

const KIND = { auto: 'Automatic', close: 'On close', manual: 'Saved', restore: 'Before restore' };
const timeText = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M$/i, (m, a) => ` ${a.toLowerCase()}m`);
const dateText = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** "Today", "Yesterday" or a date, for the day of `t` seen from `now`. */
export function dayLabel(t, now = Date.now()) {
  const d = new Date(t), n = new Date(now);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(n) - start(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
}

/** Versions newest first, grouped by day: [{ label, items }]. */
export function groupByDay(list, now = Date.now()) {
  const groups = [];
  for (const v of list.slice().sort((a, b) => b.time - a.time)) {
    const label = dayLabel(v.time, now);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(v);
  }
  return groups;
}

let bar = null;
function previewBar(ctx, versions) {
  if (bar) return bar;
  const text = h('span', { class: 'version-bar-text' });
  const keep = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Keep this');
  const back = h('button', { type: 'button', class: 'btn btn--sm' }, 'Go back');
  const el = h('div', { class: 'version-bar', role: 'region', 'aria-label': 'Version preview', hidden: true }, h('span', { role: 'status', 'aria-live': 'polite' }, text), keep, back);
  (ctx.layers && ctx.layers.host ? ctx.layers.host : document.body).appendChild(el);
  const render = () => {
    const p = versions.previewing;
    el.hidden = !p;
    if (p) setText(text, `Previewing ${dateText(p.entry.time)}, ${timeText(p.entry.time)}${p.entry.name ? ` (${p.entry.name})` : ''}`);
  };
  keep.addEventListener('click', async () => { await versions.keep(); ctx.toast('Version restored', { kind: 'success', detail: 'Undo brings back what you had.' }); });
  back.addEventListener('click', () => { versions.goBack(); ctx.toast('Back to your session'); });
  versions.on(render);
  render();
  bar = { el, render };
  return bar;
}

export async function openVersionHistory(ctx) {
  const versions = await startVersions({ store: ctx.store });
  await versions.ready;
  previewBar(ctx, versions);

  const nameIn = h('input', { type: 'text', class: 'input', placeholder: 'Name (optional)', 'aria-label': 'Version name', maxlength: '80' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm' }, 'Save version');
  const status = h('p', { class: 'popover-note version-status', role: 'status', 'aria-live': 'polite' });
  const listEl = h('div', { class: 'version-list' });
  const content = h('div', { class: 'version-panel' },
    h('p', { class: 'popover-note' }, 'Oro keeps a version when your session has changed and then rests for two minutes, when you close it, and when you save one here. Older versions thin out to one a day; named ones stay.'),
    h('div', { class: 'version-save' }, nameIn, saveBtn), status, listEl);

  const say = (t) => setText(status, t);
  const act = (label, fn, cls = '') => {
    const b = h('button', { type: 'button', class: `btn btn--xs ${cls}` }, label);
    b.addEventListener('click', async () => {
      try { await fn(b); } catch (err) { console.warn('[ui] version action failed', err); say(err && err.message ? err.message : 'That did not work.'); }
    });
    return b;
  };

  function item(v) {
    const title = h('span', { class: 'version-name' }, v.name || KIND[v.kind] || 'Version');
    const row = h('li', { class: 'version-item' },
      h('div', { class: 'version-head' }, h('span', { class: 'version-time mono' }, timeText(v.time)), title),
      h('div', { class: 'version-meta' }, `${v.tracks} track${v.tracks === 1 ? '' : 's'}, ${v.tempo} BPM, ${v.key}`),
      h('div', { class: 'version-diff' }, v.summary || ''));
    const actions = h('div', { class: 'version-actions' },
      act('Preview', async () => { await versions.preview(v.id); modal.close('preview'); }),
      act('Restore', async () => { await versions.restore(v.id); ctx.toast('Version restored', { kind: 'success', detail: 'Your session before it is saved as a version, and Undo brings it back.' }); modal.close('restore'); }),
      act('Rename', () => {
        const input = h('input', { type: 'text', class: 'input', value: v.name || '', 'aria-label': 'New name', maxlength: '80' });
        const ok = h('button', { type: 'button', class: 'btn btn--xs btn--primary' }, 'Save');
        const done = async () => { await versions.rename(v.id, input.value); };
        ok.addEventListener('click', done);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') { e.stopPropagation(); render(); } });
        title.replaceWith(h('span', { class: 'version-rename' }, input, ok));
        input.focus();
      }),
      act('Delete', async (b) => {
        if (b.dataset.armed) { await versions.remove(v.id); say('Version deleted.'); return; }
        b.dataset.armed = '1';
        setText(b, 'Delete?');
        b.setAttribute('aria-label', 'Press again to delete this version');
      }, 'btn--ghost'),
      act('Export', async () => {
        const state = await versions.get(v.id);
        const label = v.name || `${dateText(v.time)} ${timeText(v.time)}`;
        const data = { format: FORMAT, version: PRESET_VERSION, patches: [], scenes: [{ ...state, name: label, description: `Version from ${new Date(v.time).toLocaleString()}` }] };
        const d = new Date(v.time), p = (n) => String(n).padStart(2, '0');
        downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `oro-version-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`);
        say('Saved as a session file. Import it from the patch browser to load it as a scene.');
      }));
    row.appendChild(actions);
    return row;
  }

  function render() {
    const groups = groupByDay(versions.list());
    if (!groups.length) { listEl.replaceChildren(h('p', { class: 'popover-note' }, 'No versions yet. The first one is saved two minutes after you change something, or press Save version.')); return; }
    listEl.replaceChildren(...groups.map(g => h('section', { class: 'version-day', 'aria-label': g.label },
      h('h3', { class: 'version-day-title' }, g.label), h('ul', { class: 'version-items' }, g.items.map(item)))));
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try { const v = await versions.saveNamed(nameIn.value); nameIn.value = ''; say(`Saved "${v.name}".`); } catch (err) { say(err && err.message ? err.message : 'The version could not be saved.'); } finally { saveBtn.disabled = false; }
  });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); } });
  const off = versions.on(() => { if (modal.isOpen()) render(); });
  render();
  const modal = openModal(ctx.layers, ctx.root, { title: 'Version history', content, className: 'version-modal', initialFocus: nameIn, onClose: () => off() });
  return modal;
}
