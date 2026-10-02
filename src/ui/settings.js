// Settings dialog: General, Audio, MIDI & MPC, Shortcuts, About. An accessible
// modal with a vertical tab list (horizontal on narrow screens).

import { h, createScope, call, has, listen } from './dom.js';
import { openModal } from './modal.js';
import { createSegmented, createToggle } from './controls.js';
import { createMidiSettings } from './settings-midi.js';
import { createPedalSettings } from './settings-pedals.js';
import { SHORTCUTS } from './shortcuts.js';
import { STYLES } from './viewport-overlay.js';
import { openBounce, bounceSupported } from './bounce.js';
import { createPalettePicker } from './palettes.js';
import { icon } from './icons.js';

export const SETTINGS_TABS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'audio', label: 'Audio', icon: 'speaker' },
  { id: 'midi', label: 'MIDI & MPC', icon: 'midi' },
  { id: 'pedals', label: 'Pedals', icon: 'pedal' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard' },
  { id: 'about', label: 'About', icon: 'info' },
];

export const VERSION = '1.3.0';

const row = (label, hint, control) => h('div', { class: 'setting-row' },
  h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'setting-hint' }, hint) : null), control);

function prefBinding(ctx, key, fallback) {
  return {
    def: { id: key, default: fallback }, id: key, scope: 'pref', part: () => null, path: () => key,
    get: () => ctx.prefs.get(key), set: (v) => ctx.prefs.set(key, v), reset() {},
    subscribe: (fn) => ctx.prefs.on((k) => { if (k === key) fn(); }), modPath: () => null, learnTarget: () => null,
  };
}

function generalTab(ctx, scope) {
  const { binder, visuals } = ctx;
  const via = (binding, method, toArg = v => v) => ({ ...binding, set(v, meta) { call(visuals, method, toArg(v)); binding.set(v, meta); } });
  const theme = createSegmented(ctx, binder.uiValue('theme', ['system', 'dark', 'light'], 'system'), {
    label: 'Theme', options: [{ value: 'system', label: 'System', icon: 'theme-system' }, { value: 'dark', label: 'Dark', icon: 'theme-dark' }, { value: 'light', label: 'Light', icon: 'theme-light' }],
  });
  const quality = createSegmented(ctx, via(binder.uiValue('quality', ['high', 'medium', 'low'], 'high'), 'setQuality'), {
    label: 'Visual quality', options: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }],
  });
  const style = createSegmented(ctx, via(binder.uiValue('renderStyle', STYLES.map(s => s.value), 'relief'), 'setRenderStyle'), { label: 'Map style', options: STYLES.map(s => ({ ...s, label: s.label.replace('Wireframe', 'Wire').replace('Contours', 'Contour').replace('Heat map', 'Heat') })) });
  const palette = createPalettePicker(ctx);
  const rotate = createToggle(ctx, { ...via(binder.uiValue('autoRotate', [0, 1], 1), 'setAutoRotate', v => !!v), def: { id: 'autoRotate', label: 'Auto-rotate', default: 1 } }, { label: 'Auto-rotate', className: 'toggle--switch' });
  const motion = createSegmented(ctx, prefBinding(ctx, 'reduceMotion', 'system'), {
    label: 'Reduce motion', options: [{ value: 'system', label: 'System' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
  });
  const tips = createToggle(ctx, { ...prefBinding(ctx, 'showTips', 1), def: { id: 'showTips', label: 'Show tips', default: 1 } }, { label: 'Show tips', className: 'toggle--switch' });
  for (const c of [theme, quality, style, palette, rotate, motion, tips]) scope.add(c.dispose);
  if (!visuals) {
    for (const c of [quality, style, rotate]) c.setDisabled(true, 'The 3D view is not running');
  }

  return h('div', { class: 'settings-pane' },
    h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, 'Appearance'),
      row('Theme', 'System follows your computer\'s light or dark setting', theme.el),
      row('Reduce motion', 'Calms animations. System follows your computer\'s setting.', motion.el),
      row('Show tips', 'Hover hints and the map hint', tips.el)),
    h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, '3D map'),
      row('Visual quality', 'Lower it if the map stutters on this computer', quality.el),
      row('Map style', null, style.el),
      h('div', { class: 'setting-row setting-row--stack' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'Palette'), h('div', { class: 'setting-hint' }, 'Colours of the land, from valleys to peaks')), palette.el),
      row('Auto-rotate', 'Slowly circles the map in Orbit view', rotate.el)));
}

export const AUDIO_QUALITY = [
  { value: 'eco', label: 'Eco', text: 'Lightest on the processor. Some aliasing on high notes.' },
  { value: 'standard', label: 'Standard', text: 'Two times oversampling. The balanced default.' },
  { value: 'high', label: 'High', text: 'Four times oversampling. Cleaner high notes, more processing.' },
  { value: 'pristine', label: 'Pristine', text: 'Band-limited single cycles when the orbit is steady, for the cleanest tone.' },
  { value: 'raw', label: 'Raw', text: 'No anti-aliasing smoothing: deliberately gritty and digital.' },
];

function audioTab(ctx, scope) {
  const { engine } = ctx;
  const qBinding = {
    ...ctx.binder.uiValue('audioQuality', AUDIO_QUALITY.map(q => q.value), 'standard'),
  };
  const qSet = qBinding.set.bind(qBinding);
  qBinding.set = (v, meta) => { call(engine, 'setQuality', v); qSet(v, meta); };
  const qSeg = createSegmented(ctx, qBinding, { label: 'Audio quality', size: 'sm', options: AUDIO_QUALITY.map(q => ({ value: q.value, label: q.label, tip: q.text })) });
  scope.add(qSeg.dispose);
  const qText = h('div', { class: 'setting-hint' });
  const renderQ = () => { qText.textContent = (AUDIO_QUALITY.find(q => q.value === (ctx.store.get('ui.audioQuality') || 'standard')) || AUDIO_QUALITY[1]).text; };
  scope.add(qBinding.subscribe(renderQ));
  renderQ();
  const status = h('dl', { class: 'status-facts status-facts--wide' });
  const startBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('play') + '<span>Start audio</span>' });
  const testBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('speaker') + '<span>Test tone</span>', disabled: !engine });
  const panicBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', html: icon('panic') + '<span>Panic</span>' });
  const deviceWrap = h('div', { class: 'device-pick' });
  const bounceBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('bounce') + '<span>Bounce...</span>', disabled: !bounceSupported(ctx) });
  scope.on(bounceBtn, 'click', () => openBounce(ctx, bounceBtn));

  function render() {
    status.textContent = '';
    const c = engine && engine.context;
    const fact = (k, v, good = true) => status.append(h('dt', null, k), h('dd', { class: good ? '' : 'is-bad' }, v));
    if (!engine || engine.mode === 'none') {
      fact('Engine', engine ? 'This browser has no Web Audio' : 'Not available', false);
      startBtn.hidden = true;
      testBtn.disabled = true;
      return;
    }
    const state = c ? c.state : 'unknown';
    fact('State', state === 'running' ? 'Running' : state === 'suspended' ? 'Waiting for Start' : state, state === 'running');
    fact('Mode', engine.mode === 'worklet' ? 'AudioWorklet (best)' : engine.mode === 'script' ? 'ScriptProcessor fallback' : String(engine.mode || 'unknown'), engine.mode !== 'script');
    if (c) {
      fact('Sample rate', `${Math.round(c.sampleRate / 100) / 10} kHz`);
      const lat = ((c.baseLatency || 0) + (c.outputLatency || 0)) * 1000;
      fact('Latency', lat > 0 ? `${lat.toFixed(1)} ms` : 'Not reported');
    }
    startBtn.hidden = state === 'running';
  }
  scope.on(startBtn, 'click', async () => { await ctx.startAudio(); render(); });
  scope.on(testBtn, 'click', async () => {
    await ctx.startAudio();
    if (has(engine, 'testTone')) { call(engine, 'testTone'); return; }
    const part = ctx.binder.selected();
    call(engine, 'noteOn', part, 69, 0.7);
    setTimeout(() => call(engine, 'noteOff', part, 69), 700);
  });
  scope.on(panicBtn, 'click', () => ctx.panic());
  const ctxObj = engine && engine.context;
  if (ctxObj && typeof ctxObj.addEventListener === 'function') scope.on(ctxObj, 'statechange', render);
  scope.add(listen(engine, 'state', render));
  render();

  // Output device picker (only where the browser supports choosing one).
  (async () => {
    if (!has(engine, 'listOutputDevices') || !has(engine, 'setOutputDevice')) {
      deviceWrap.append(h('p', { class: 'setting-hint' }, 'This browser plays through your system\'s default output. Change it in your computer\'s sound settings.'));
      return;
    }
    let devices = [];
    try { devices = (await engine.listOutputDevices()) || []; } catch { devices = []; }
    if (!devices.length) {
      deviceWrap.append(h('p', { class: 'setting-hint' }, 'Choosing an output is not supported here, so Orograph uses the system default.'));
      return;
    }
    const sel = h('select', { class: 'select-native', 'aria-label': 'Output device' },
      devices.map(d => h('option', { value: d.deviceId ?? d.id ?? '' }, d.label || d.name || 'Output')));
    if (engine.outputDeviceId != null) sel.value = engine.outputDeviceId;
    sel.addEventListener('change', async () => {
      try { await engine.setOutputDevice(sel.value); ctx.toast('Output changed', { kind: 'success' }); }
      catch (err) { console.warn(err); ctx.toast('Could not switch output', { kind: 'error' }); }
    });
    deviceWrap.append(h('div', { class: 'select' }, sel, h('span', { class: 'select-caret', html: icon('chevron-down') })));
  })();

  return h('div', { class: 'settings-pane' },
    h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, 'Engine'), status, h('div', { class: 'btn-row' }, startBtn, testBtn, panicBtn)),
    h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, 'Quality'),
      h('div', { class: 'setting-row setting-row--stack' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'Oscillator quality'), qText), qSeg.el)),
    h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, 'Output'), row('Output device', null, deviceWrap)),
    h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, 'Export'),
      row('Bounce to WAV', bounceSupported(ctx) ? 'Render bars of the sequencers offline, faster than real time' : 'Needs the audio and music engines', bounceBtn)));
}

export function shortcutsList() {
  return h('div', { class: 'shortcuts' }, SHORTCUTS.map(g => h('section', { class: 'shortcut-group' },
    h('h3', { class: 'group-title' }, g.group),
    h('dl', { class: 'shortcut-list' }, g.items.map(it => [
      h('dt', null, (it.keys.length > 6 ? [it.compact] : it.keys).map((k, i) => [i ? h('span', { class: 'kbd-join' }, it.join || ' ') : null, h('kbd', null, k)])),
      h('dd', null, it.text),
    ])))));
}

function aboutTab() {
  return h('div', { class: 'settings-pane about' },
    h('div', { class: 'about-head' },
      h('div', { class: 'about-word' }, 'OROGRAPH'),
      h('div', { class: 'about-version' }, `Version ${VERSION}`)),
    h('p', null, 'Wave terrain synthesis traces a closed path across a landscape once per cycle, and the height under the moving point becomes the sound. Pitch is how fast the path is traced; timbre is the shape of the land it crosses.'),
    h('p', null, 'Orograph is an independent, clean-room implementation inspired by the idea of a terrain synthesizer. Terrain Synth is a trademark of Conductive Labs; Orograph is not affiliated with or endorsed by Conductive Labs.'),
    h('dl', { class: 'about-facts' },
      h('dt', null, 'License'), h('dd', null, 'MIT'),
      h('dt', null, 'Built with'), h('dd', null, 'three.js (MIT), Rapier physics (Apache-2.0), Web Audio and Web MIDI'),
      h('dt', null, 'Source'), h('dd', null, h('a', { href: 'https://github.com/ChaseHendrick/synth', target: '_blank', rel: 'noopener noreferrer' }, 'github.com/ChaseHendrick/synth', h('span', { html: icon('link') })))));
}

export function openSettings(ctx, initialTab = 'general', { onClose } = {}) {
  const scope = createScope();
  const tabs = [];
  const panels = [];
  const tablist = h('div', { class: 'settings-tabs', role: 'tablist', 'aria-label': 'Settings sections', 'aria-orientation': 'vertical' });
  const content = h('div', { class: 'settings-content' });
  const builders = {
    general: () => generalTab(ctx, scope),
    audio: () => audioTab(ctx, scope),
    midi: () => { const m = createMidiSettings(ctx); scope.add(m.dispose); return h('div', { class: 'settings-pane' }, m.el); },
    pedals: () => { const m = createPedalSettings(ctx); scope.add(m.dispose); return h('div', { class: 'settings-pane' }, m.el); },
    shortcuts: () => h('div', { class: 'settings-pane' }, shortcutsList()),
    about: () => aboutTab(),
  };
  for (const t of SETTINGS_TABS) {
    const tab = h('button', {
      type: 'button', class: 'settings-tab', role: 'tab', id: `stab-${t.id}`, 'aria-controls': `spanel-${t.id}`, 'aria-selected': 'false', tabindex: '-1',
      html: icon(t.icon) + `<span>${t.label.replace('&', '&amp;')}</span>`,
    });
    const panel = h('div', { class: 'settings-panel', role: 'tabpanel', id: `spanel-${t.id}`, 'aria-labelledby': `stab-${t.id}`, hidden: true, tabindex: '0' });
    tab.addEventListener('click', () => select(t.id, false));
    tabs.push(tab);
    panels.push(panel);
    tablist.appendChild(tab);
    content.appendChild(panel);
  }
  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n >= 0) { e.preventDefault(); select(SETTINGS_TABS[n].id, true); }
  });

  function select(id, focus) {
    const idx = Math.max(0, SETTINGS_TABS.findIndex(t => t.id === id));
    tabs.forEach((t, i) => { t.setAttribute('aria-selected', String(i === idx)); t.tabIndex = i === idx ? 0 : -1; });
    panels.forEach((p, i) => {
      p.hidden = i !== idx;
      if (i === idx && !p.firstChild) p.appendChild(builders[SETTINGS_TABS[i].id]());
    });
    content.scrollTop = 0;
    if (focus) tabs[idx].focus();
    current = SETTINGS_TABS[idx].id;
  }
  let current = initialTab;

  const layout = h('div', { class: 'settings' }, tablist, content);
  const modal = openModal(ctx.layers, ctx.root, {
    title: 'Settings', content: layout, wide: true, className: 'modal--settings',
    onClose: (reason) => { scope.dispose(); if (onClose) onClose(reason); },
  });
  select(initialTab, false);
  tabs[SETTINGS_TABS.findIndex(t => t.id === current)]?.focus();
  return { ...modal, select: (id) => select(id, true), current: () => current };
}

