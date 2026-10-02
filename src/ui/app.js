// Orograph user interface entry point.
//
//   createUI(root, { store, engine, visuals, music, presets, midi })
//
// Builds the whole interface around the [data-viewport] element (where the 3D
// view is already mounted) without moving it. Every module except the store
// may be null or only partly working: affected controls are disabled with an
// explanation and nothing here throws because of them.

import { PART_COLORS } from '../core/params.js';
import { h, createScope, listen, call, has } from './dom.js';
import { addLoop, schedule } from './frame.js';
import { createBinder, clampPart } from './bind.js';
import { createTheme } from './theme.js';
import { createPrefs } from './prefs.js';
import { createLayers } from './layers.js';
import { createToaster } from './toast.js';
import { createTooltips } from './tooltip.js';
import { createTele } from './tele.js';
import { createTerrainSource } from './terrain-source.js';
import { partVars, applyVars } from './color.js';
import { createTopbar } from './topbar.js';
import { createViewportOverlay } from './viewport-overlay.js';
import { createMapPanel } from './map-panel.js';
import { createDock, DOCK_TABS } from './dock.js';
import { createPiano } from './piano.js';
import { openModPopover } from './mod-popover.js';
import { openSettings } from './settings.js';
import { openHelp } from './help.js';
import { createStartOverlay } from './start-overlay.js';
import { installShortcuts } from './shortcuts.js';
import { icon } from './icons.js';

function emitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    emit(type, detail) {
      for (const fn of [...(map.get(type) || [])]) {
        try { fn(detail); } catch (err) { console.warn(`[ui] ${type} handler failed`, err); }
      }
    },
  };
}

function region(root, name, tag, cls) {
  let el = root.querySelector(`[data-region="${name}"]`);
  if (!el) {
    el = h(tag, { class: cls, dataset: { region: name } });
    root.appendChild(el);
  }
  return el;
}

const MOBILE_TABS = [
  { id: 'map', label: 'Map', icon: 'map' },
  ...DOCK_TABS.map(t => ({ id: t.id, label: t.label, icon: t.icon })),
  { id: 'keys', label: 'Keys', icon: 'keyboard' },
];

export function createUI(root, modules = {}) {
  const { store } = modules;
  if (!root || !store) throw new Error('createUI needs a root element and a store');
  const engine = modules.engine || null;
  const visuals = modules.visuals || null;
  const music = modules.music || null;
  const presets = modules.presets || null;
  const midi = modules.midi || null;
  const scope = createScope();
  const docEl = document.documentElement;

  root.classList.add('app');
  // ---------------------------------------------------------------- regions
  let viewport = root.querySelector('[data-viewport]');
  const topbarEl = region(root, 'topbar', 'header', 'topbar');
  let stage = root.querySelector('[data-region="stage"]');
  if (!stage) {
    stage = h('main', { class: 'stage', dataset: { region: 'stage' } });
    if (viewport && viewport.parentNode) viewport.parentNode.insertBefore(stage, viewport);
    root.appendChild(stage);
  }
  if (!viewport) {
    viewport = h('div', { class: 'viewport', dataset: { viewport: '' } });
    stage.appendChild(viewport);
  } else if (!stage.contains(viewport)) {
    stage.appendChild(viewport);
  }
  viewport.classList.add('viewport');
  const mapEl = region(root, 'map', 'aside', 'mappanel');
  mapEl.setAttribute('aria-label', 'Map');
  const mtabsEl = region(root, 'mtabs', 'nav', 'mobile-tabs');
  const dockEl = region(root, 'dock', 'section', 'dock');
  dockEl.setAttribute('aria-label', 'Sound, modulation, sequencer and mixer');
  const keysEl = region(root, 'keys', 'section', 'keys');
  keysEl.setAttribute('aria-label', 'Keyboard');
  // Keep a predictable DOM order for keyboard navigation: top bar, stage, map, dock, keys.
  for (const el of [topbarEl, stage, mtabsEl, mapEl, dockEl, keysEl]) root.appendChild(el);

  // ---------------------------------------------------------------- context
  const layers = createLayers();
  scope.add(layers.dispose);
  const prefs = createPrefs({ store });
  scope.add(prefs.dispose);
  const bus = emitter();
  const binder = createBinder(store);
  const tele = createTele(engine);
  scope.add(tele.dispose);
  const toast = createToaster(layers.host);
  const tooltips = createTooltips(layers.host, { enabled: () => !!prefs.get('showTips') });
  scope.add(tooltips.dispose);
  const terrains = createTerrainSource({ store, engine });
  scope.add(terrains.dispose);

  // Shared note stream: router note events (incl. sequencer and arp) plus
  // locally generated events when the router is missing.
  const noteBus = emitter();
  const notes = { on: (fn) => noteBus.on('note', fn), emitLocal: (ev) => noteBus.emit('note', ev) };
  if (music && music.router) scope.add(listen(music.router, 'note', (ev) => { if (ev) noteBus.emit('note', ev); }));

  // Per-frame "live" widgets (modulation beads); they only run while telemetry flows.
  const liveFns = new Set();
  const live = { add(fn) { liveFns.add(fn); return () => liveFns.delete(fn); } };
  let wasFresh = false;
  scope.add(addLoop(() => {
    const fresh = tele.fresh();
    if (fresh || wasFresh) for (const fn of liveFns) fn();
    wasFresh = fresh;
  }));

  const panelBgCache = {};
  let piano = null;
  const ctx = {
    root, store, engine, visuals, music, presets, midi,
    layers, prefs, bus, binder, tele, toast, tooltips, terrains, notes, live,
    theme: null,
    /** Surfaces a part colour must stay readable on, for the active theme. */
    panelBg() {
      const theme = docEl.dataset.theme || 'dark';
      if (!panelBgCache[theme]) {
        const cs = getComputedStyle(docEl);
        const list = ['--panel-solid', '--panel-2', '--panel-3'].map(n => cs.getPropertyValue(n).trim()).filter(Boolean);
        if (list.length) panelBgCache[theme] = list;
      }
      return panelBgCache[theme] || [theme === 'light' ? '#fbf7ef' : '#0f1422'];
    },
    /** True when there is a real audio graph (not just a stand-in engine). */
    audioOk: () => !!engine && engine.mode !== 'none' && !!engine.context,
    async startAudio() {
      if (!engine) return false;
      const running = engine.context && engine.context.state === 'running';
      if (running && store.get('ui.audioStarted')) return true;
      try {
        await engine.start();
        store.set('ui.audioStarted', 1, { source: 'ui' });
        return true;
      } catch (err) {
        console.warn('[ui] audio did not start', err);
        toast('Audio could not start', { kind: 'error', detail: 'Click Start again, or check that this tab is allowed to play sound.' });
        return false;
      }
    },
    panic() {
      call(engine, 'panic');
      if (music && music.router) call(music.router, 'allNotesOff');
      call(midi, 'panic');
      if (piano) piano.releaseAll();
      toast('All notes stopped', { kind: 'info' });
    },
    openSettings: (tab) => openSettingsDialog(tab),
    openHelp: () => openHelpDialog(),
    openModPopover: (binding, anchor) => openModPopover(ctx, binding, anchor),
    midiOk: () => !!midi && midi.supported !== false && has(midi, 'learn'),
    findMapping(target) {
      if (!midi || !target) return null;
      const list = call(midi, 'mappings') || [];
      return list.find(m => m && m.target && m.target.scope === target.scope && m.target.id === target.id
        && (target.scope === 'global' || String(m.target.part) === String(target.part))) || null;
    },
    unmap(target) {
      call(midi, 'unmap', target);
      bus.emit('mappings');
      toast('MIDI mapping removed', { kind: 'info' });
    },
    learn: null,
    announce(text) { live.region && (live.region.textContent = text); },
  };
  live.region = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  layers.host.appendChild(live.region);

  // MIDI learn: one at a time, Esc cancels, toasts report the result.
  let learning = null;
  ctx.learn = {
    start(target, label, onEnd) {
      if (!ctx.midiOk()) return;
      this.cancel();
      const state = { done: false };
      const finish = () => {
        if (state.done) return;
        state.done = true;
        pop();
        dismissToast();
        store.set('ui.midiLearn', 0, { source: 'ui' });
        learning = null;
        try { onEnd && onEnd(); } catch { /* widget gone */ }
      };
      const pop = layers.push({ el: null, anchor: null, modal: false, close: () => { call(midi, 'cancelLearn'); finish(); }, dismissOnOutside: false });
      const dismissToast = toast(`MIDI Learn: move a knob or fader on your controller to map ${label}.`, { kind: 'info', timeout: 60000, detail: midi.status !== 'ready' ? 'MIDI is not connected yet. Open Settings > MIDI & MPC to connect.' : 'Press Esc to cancel.' });
      store.set('ui.midiLearn', 1, { source: 'ui' });
      learning = { finish };
      let p;
      try { p = midi.learn(target); } catch (err) { p = Promise.reject(err); }
      Promise.resolve(p).then((m) => {
        if (state.done) return;
        toast(`Mapped CC ${m && m.cc != null ? m.cc : ''} to ${label}`, { kind: 'success' });
        bus.emit('mappings');
        finish();
      }).catch(() => finish());
    },
    cancel() {
      if (!learning) return;
      call(midi, 'cancelLearn');
      learning.finish();
    },
  };
  scope.add(() => ctx.learn.cancel());

  // ---------------------------------------------------------------- theme + colours
  function applyPartColours() {
    const p = binder.selected();
    applyVars(docEl, partVars(store.get(`parts.${p}.color`) || PART_COLORS[p], docEl.dataset.theme, ctx.panelBg()));
    bus.emit('part-colors');
  }
  ctx.theme = createTheme({ store, onResolved: () => { applyPartColours(); } });
  scope.add(ctx.theme.dispose);
  scope.add(store.subscribe('ui.selectedPart', () => schedule(applyPartColours)));
  scope.add(store.subscribe('parts', (path) => { if (/^parts(\.\d(\.color)?)?$/.test(path)) schedule(applyPartColours); }));
  scope.add(store.subscribe('', (path) => { if (path === '') schedule(applyPartColours); }));

  function applyMotion() {
    const m = prefs.get('reduceMotion');
    if (m === 'on') docEl.dataset.motion = 'reduce';
    else if (m === 'off') docEl.dataset.motion = 'full';
    else delete docEl.dataset.motion;
  }
  function applyLayoutPrefs() {
    root.classList.toggle('map-collapsed', !!prefs.get('mapCollapsed'));
  }
  scope.add(prefs.on((key) => {
    if (key === 'reduceMotion') applyMotion();
    if (key === 'mapCollapsed') { applyLayoutPrefs(); requestAnimationFrame(() => call(visuals, 'resize')); }
  }));
  applyMotion();
  applyLayoutPrefs();
  if (visuals) {
    call(visuals, 'setQuality', store.get('ui.quality'));
    scope.add(store.subscribe('ui.quality', () => call(visuals, 'setQuality', store.get('ui.quality'))));
  }

  // ---------------------------------------------------------------- build
  const safely = (label, fn) => {
    try { return fn(); } catch (err) {
      console.error(`[ui] ${label} failed to build`, err);
      return null;
    }
  };
  const topbar = safely('top bar', () => createTopbar(ctx, topbarEl));
  if (topbar) scope.add(topbar.dispose);
  const overlay = safely('viewport overlay', () => createViewportOverlay(ctx, viewport));
  if (overlay) scope.add(overlay.dispose);
  const mapPanel = safely('map panel', () => createMapPanel(ctx, mapEl));
  if (mapPanel) scope.add(mapPanel.dispose);
  const dock = safely('dock', () => createDock(ctx, dockEl));
  if (dock) scope.add(dock.dispose);
  piano = safely('keyboard', () => createPiano(ctx));
  if (piano) {
    keysEl.append(piano.el, piano.bar);
    scope.add(piano.dispose);
  }

  // Mobile tab bar (MAP / SOUND / MOD / SEQ / MIX / KEYS); hidden on wide screens.
  const mtabs = MOBILE_TABS.map(t => {
    const b = h('button', { type: 'button', class: 'mtab', role: 'tab', 'aria-selected': 'false', tabindex: '-1', dataset: { tab: t.id }, html: icon(t.icon) + `<span>${t.label}</span>` });
    b.addEventListener('click', () => setMobileTab(t.id));
    return b;
  });
  mtabsEl.setAttribute('role', 'tablist');
  mtabsEl.setAttribute('aria-label', 'Panels');
  mtabsEl.append(...mtabs);
  mtabsEl.addEventListener('keydown', (e) => {
    const i = mtabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % mtabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + mtabs.length) % mtabs.length;
    if (n >= 0) { e.preventDefault(); setMobileTab(MOBILE_TABS[n].id); mtabs[n].focus(); }
  });
  function setMobileTab(id) {
    root.dataset.mtab = id;
    mtabs.forEach(b => { const on = b.dataset.tab === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    if (DOCK_TABS.some(t => t.id === id)) store.set('ui.panel', id, { source: 'ui' });
    if (id === 'keys' && !prefs.get('keysOpen')) prefs.set('keysOpen', 1);
  }
  scope.add(store.subscribe('ui.panel', () => {
    const id = store.get('ui.panel');
    if (root.dataset.mtab !== 'map' && root.dataset.mtab !== 'keys' && root.dataset.mtab !== id) setMobileTab(id);
  }));
  setMobileTab('map');

  // ---------------------------------------------------------------- dialogs
  let settingsModal = null;
  let helpModal = null;
  function openSettingsDialog(tab) {
    if (settingsModal && settingsModal.isOpen()) { if (tab) settingsModal.select(tab); return settingsModal; }
    if (helpModal && helpModal.isOpen()) helpModal.close();
    layers.closeAll('dialog');
    settingsModal = openSettings(ctx, tab || 'general', { onClose: () => store.set('ui.settingsOpen', 0, { source: 'ui' }) });
    store.set('ui.settingsOpen', 1, { source: 'ui' });
    return settingsModal;
  }
  function openHelpDialog() {
    if (helpModal && helpModal.isOpen()) return helpModal;
    if (settingsModal && settingsModal.isOpen()) settingsModal.close();
    layers.closeAll('dialog');
    helpModal = openHelp(ctx, { onClose: () => store.set('ui.helpOpen', 0, { source: 'ui' }) });
    store.set('ui.helpOpen', 1, { source: 'ui' });
    return helpModal;
  }
  scope.add(store.subscribe('ui.settingsOpen', () => {
    const want = !!store.get('ui.settingsOpen');
    const isOpen = !!(settingsModal && settingsModal.isOpen());
    if (want && !isOpen) openSettingsDialog();
    else if (!want && isOpen) settingsModal.close();
  }));
  scope.add(store.subscribe('ui.helpOpen', () => {
    const want = !!store.get('ui.helpOpen');
    const isOpen = !!(helpModal && helpModal.isOpen());
    if (want && !isOpen) openHelpDialog();
    else if (!want && isOpen) helpModal.close();
  }));

  // ---------------------------------------------------------------- shortcuts
  scope.add(installShortcuts({
    layers,
    actions: {
      togglePlay: () => { if (topbar) topbar.togglePlay(); },
      selectPart: (i) => store.set('ui.selectedPart', clampPart(i), { source: 'ui' }),
      help: () => openHelpDialog(),
      settings: () => openSettingsDialog(),
      record: () => { if (topbar && topbar.recorder.supported) topbar.recorder.toggle(); },
      prevPatch: () => { if (topbar) topbar.patch.step(-1); },
      nextPatch: () => { if (topbar) topbar.patch.step(1); },
      preview: async () => {
        if (!music || !has(music, 'preview')) return;
        await ctx.startAudio();
        call(music, 'preview', 'sel');
      },
    },
  }));

  // ---------------------------------------------------------------- MIDI device toasts
  if (midi) {
    let known = null;
    const snapshot = () => new Map([...(call(midi, 'inputs') || []), ...(call(midi, 'outputs') || [])]
      .filter(p => p && p.state !== 'disconnected').map(p => [p.name || p.id, p]));
    scope.add(listen(midi, 'change', () => {
      bus.emit('mappings');
      const now = snapshot();
      if (known) {
        for (const [name, p] of now) if (!known.has(name)) toast(p.isMpc ? `Akai MPC connected: ${name}` : `MIDI device connected: ${name}`, { kind: 'success' });
        for (const [name] of known) if (!now.has(name)) toast(`MIDI device disconnected: ${name}`, { kind: 'warn' });
      }
      known = midi.status === 'ready' ? now : known;
    }));
    if (midi.status === 'ready') known = snapshot();
  }

  // ---------------------------------------------------------------- viewport size
  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => call(visuals, 'resize'));
    });
    ro.observe(viewport);
    scope.add(() => { ro.disconnect(); cancelAnimationFrame(raf); });
  }

  // ---------------------------------------------------------------- start overlay
  const audioRunning = engine && engine.context && engine.context.state === 'running';
  if (!store.get('ui.audioStarted') || (engine && !audioRunning)) {
    createStartOverlay(ctx, stage);
  }
  if (engine && engine.context && typeof engine.context.addEventListener === 'function') {
    scope.on(engine.context, 'statechange', () => {
      if (engine.context.state === 'running') store.set('ui.audioStarted', 1, { source: 'engine' });
    });
  }

  root.classList.add('is-ready');
  applyPartColours();

  const api = {
    ctx,
    openSettings: openSettingsDialog,
    openHelp: openHelpDialog,
    dispose() {
      scope.dispose();
      root.classList.remove('is-ready');
    },
  };
  // The bootstrap publishes window.orograph right after this returns; add the
  // UI handle to it (useful for tests and debugging) without replacing anything.
  queueMicrotask(() => {
    try { if (window.orograph && typeof window.orograph === 'object' && !window.orograph.ui) window.orograph.ui = api; } catch { /* frozen */ }
  });
  return api;
}
