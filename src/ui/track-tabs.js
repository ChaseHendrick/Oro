// Top bar track tabs: one tab per track (name, patch, note LED), a + button
// that adds a track and a menu button with the track actions (rename,
// duplicate, move, remove). The tabs scroll sideways when they do not fit
// (a compact strip with 44px targets on phones). Tabs can be dragged to
// reorder them (mouse), or moved with Alt+Left / Alt+Right; F2 renames.
//
// All MAX_PARTS tab elements are built once and the ones past the end of
// the track list are hidden, so adding or removing a track never rebuilds
// the strip.

import { MAX_PARTS, PART_COLORS } from '../core/params.js';
import { partCount, moveTrack } from '../core/tracks.js';
import { h, createScope, setText, setAttr } from './dom.js';
import { schedule, addLoop } from './frame.js';
import { partVars, applyVars } from './color.js';
import { icon } from './icons.js';
import { addTrackAction, openTrackMenu, openRenameTrack } from './track-actions.js';

export function createTrackTabs(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const count = () => partCount(store);

  const tabs = [];
  const scroller = h('div', { class: 'part-tabs-scroll', role: 'radiogroup', 'aria-label': 'Tracks' });
  for (let i = 0; i < MAX_PARTS; i++) {
    const led = h('span', { class: 'led part-led', 'aria-hidden': 'true' });
    const name = h('span', { class: 'part-name' });
    const patch = h('span', { class: 'part-patch' });
    const tab = h('button', {
      type: 'button', class: 'part-tab', role: 'radio', 'aria-checked': 'false', tabindex: '-1', draggable: 'true',
      dataset: { part: String(i), tip: i < 9 ? `Select track ${i + 1} (key ${i + 1}). Drag to reorder` : `Select track ${i + 1}. Drag to reorder` },
    }, led, h('span', { class: 'part-num', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 'part-texts' }, name, patch), h('span', { class: 'part-frozen', 'aria-hidden': 'true', html: icon('freeze') }), h('span', { class: 'part-mute', 'aria-hidden': 'true' }, 'M'));
    scope.on(tab, 'click', () => store.set('ui.selectedPart', i, { source: 'ui' }));
    scope.on(tab, 'dblclick', () => openRenameTrack(ctx, tab, i));
    scope.on(tab, 'contextmenu', (e) => { e.preventDefault(); store.set('ui.selectedPart', i, { source: 'ui' }); openTrackMenu(ctx, tab, i); });
    tabs.push({ tab, led, name, patch });
    scroller.appendChild(tab);
  }

  const addBtn = h('button', {
    type: 'button', class: 'icon-btn part-tab-btn part-tab-add', 'aria-label': 'Add track', html: icon('plus'),
    dataset: { tip: `Add a track (up to ${MAX_PARTS})` },
  });
  scope.on(addBtn, 'click', () => addTrackAction(ctx));
  const moreBtn = h('button', {
    type: 'button', class: 'icon-btn part-tab-btn part-tab-more', 'aria-label': 'Track options', 'aria-haspopup': 'menu', html: icon('more'),
    dataset: { tip: 'Rename, duplicate, move or remove the selected track' },
  });
  scope.on(moreBtn, 'click', () => openTrackMenu(ctx, moreBtn, binder.selected()));
  const el = h('div', { class: 'part-tabs', role: 'group', 'aria-label': 'Tracks' }, scroller, addBtn, moreBtn);

  // ---------------------------------------------------------------- keyboard
  scope.on(scroller, 'keydown', (e) => {
    const i = tabs.findIndex(t => t.tab === document.activeElement);
    if (i < 0) return;
    const n = count();
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (e.key === 'F2') { e.preventDefault(); openRenameTrack(ctx, tabs[i].tab, i); return; }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openTrackMenu(ctx, tabs[i].tab, i); return; }
    if (!fwd && !back) return;
    e.preventDefault();
    if (e.altKey) {
      // Alt+arrows move the track itself; focus follows it
      const to = i + (fwd ? 1 : -1);
      if (to >= 0 && to < n && moveTrack(store, i, to)) schedule(() => tabs[to].tab.focus());
      return;
    }
    const next = fwd ? (i + 1) % n : (i - 1 + n) % n;
    store.set('ui.selectedPart', next, { source: 'ui' });
    tabs[next].tab.focus();
  });

  // ---------------------------------------------------------------- drag to reorder
  let dragFrom = -1;
  const clearDrop = () => { for (const t of tabs) t.tab.classList.remove('is-drop-before', 'is-drop-after', 'is-dragging'); };
  const dropIndex = (e, i) => {
    const r = tabs[i].tab.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2 ? i + 1 : i;
  };
  tabs.forEach(({ tab }, i) => {
    scope.on(tab, 'dragstart', (e) => {
      dragFrom = i;
      tab.classList.add('is-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch { /* old browsers */ }
    });
    scope.on(tab, 'dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const at = dropIndex(e, i);
      for (const t of tabs) t.tab.classList.remove('is-drop-before', 'is-drop-after');
      tab.classList.add(at > i ? 'is-drop-after' : 'is-drop-before');
    });
    scope.on(tab, 'drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const at = dropIndex(e, i);
      const to = at > dragFrom ? at - 1 : at;
      const from = dragFrom;
      dragFrom = -1;
      clearDrop();
      moveTrack(store, from, to);
    });
    scope.on(tab, 'dragend', () => { dragFrom = -1; clearDrop(); });
  });

  // ---------------------------------------------------------------- render
  let lastSel = -1;
  function render() {
    const sel = binder.selected();
    const n = count();
    const theme = document.documentElement.dataset.theme;
    tabs.forEach(({ tab, name, patch }, i) => {
      const live = i < n;
      tab.hidden = !live;
      if (!live) return;
      const on = i === sel;
      setAttr(tab, 'aria-checked', String(on));
      tab.tabIndex = on ? 0 : -1;
      const nm = store.get(`parts.${i}.name`) || `Track ${i + 1}`;
      const pn = store.get(`parts.${i}.patchName`) || 'Init';
      setText(name, nm);
      setText(patch, pn);
      const frozen = !!(ctx.freeze && ctx.freeze.isFrozen(i));
      setAttr(tab, 'aria-label', `${nm}, ${pn}${frozen ? ', frozen' : ''}`);
      tab.classList.toggle('is-frozen', frozen);
      tab.classList.toggle('is-muted', !!store.get(`parts.${i}.params.mute`));
      applyVars(tab, partVars(store.get(`parts.${i}.color`) || PART_COLORS[i % PART_COLORS.length], theme, ctx.panelBg()));
    });
    addBtn.disabled = n >= MAX_PARTS;
    el.classList.toggle('is-scrolling', scroller.scrollWidth > scroller.clientWidth + 1);
    if (sel !== lastSel) {
      lastSel = sel;
      const t = tabs[sel] && tabs[sel].tab;
      if (t && typeof t.scrollIntoView === 'function') t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  const invalidate = () => schedule(render);
  scope.add(store.subscribe('ui.selectedPart', invalidate));
  scope.add(store.subscribe('parts', (path) => { if (/^parts(\.\d+(\.(name|patchName|color|params(\.mute)?))?)?$/.test(path)) { if (path === 'parts') lastSel = -1; invalidate(); } }));
  scope.add(store.subscribe('', (path) => { if (path === '') { lastSel = -1; invalidate(); } }));
  scope.on(window, 'orograph:theme', invalidate);
  scope.on(window, 'resize', invalidate);
  if (ctx.freeze) scope.add(ctx.freeze.on('change', invalidate));

  // ---------------------------------------------------------------- note LEDs
  // Lit while notes sound on a track, with a flash on each new note.
  let heldCount = new Array(MAX_PARTS).fill(0);
  scope.add(store.subscribe('parts', (path) => { if (path === 'parts') { heldCount = new Array(MAX_PARTS).fill(0); for (const t of tabs) t.led.classList.remove('is-on'); } }));
  if (ctx.notes) {
    scope.add(ctx.notes.on(({ part, on }) => {
      if (!(part >= 0 && part < count())) return;
      heldCount[part] = Math.max(0, heldCount[part] + (on ? 1 : -1));
      const led = tabs[part].led;
      led.classList.toggle('is-on', heldCount[part] > 0);
      if (on) { led.classList.remove('is-flash'); void led.offsetWidth; led.classList.add('is-flash'); }
    }));
  }
  // Fallback: the engine's voice counts keep LEDs honest if note events are missed.
  scope.add(addLoop(() => {
    if (!ctx.tele || !ctx.tele.fresh()) return;
    for (let i = 0; i < count(); i++) {
      const active = ctx.tele.activeVoices(i) > 0;
      if (!active && heldCount[i] > 0) { heldCount[i] = 0; tabs[i].led.classList.remove('is-on'); }
      tabs[i].led.classList.toggle('is-sounding', active);
    }
  }));

  render();
  return { el, tabs, render, dispose: scope.dispose };
}
