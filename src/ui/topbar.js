// Top bar: wordmark, track tabs (name, patch, note LED; + and a track menu), the patch browser
// (with Preview), transport (play/stop, tempo, record, loop, bounce), Macros, MIDI
// activity, theme, settings, help. In the desktop app it is also the window's
// drag handle (see the app-region rules in panels.css).

import { h, createScope, setText, setAttr, listen, call, has } from './dom.js';
import { schedule, addLoop } from './frame.js';
import { createDragNumber } from './controls.js';
import { createPatchBrowser } from './patch-browser.js';
import { createRecorder, formatElapsed } from './record.js';
import { createLooperButton } from './looper-panel.js';
import { openBounce, bounceSupported } from './bounce.js';
import { openMacros } from './macros.js';
import { openPopover } from './layers.js';
import { createTrackTabs } from './track-tabs.js';
import { icon, brandGlyph } from './icons.js';
import { tempoParser } from './eggs.js';

const THEME_LABEL = { system: 'System', dark: 'Dark', light: 'Light' };
const THEME_NEXT = { system: 'dark', dark: 'light', light: 'system' };

export function createTopbar(ctx, container) {
  const scope = createScope();
  const { store, binder, music, midi } = ctx;

  // ---------------------------------------------------------------- brand
  const brand = h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: brandGlyph(26) }), h('span', { class: 'brand-word' }, 'OROGRAPH'));

  // ---------------------------------------------------------------- tracks
  // Tabs, add and track menu: src/ui/track-tabs.js.
  const trackTabs = createTrackTabs(ctx);
  scope.add(trackTabs.dispose);
  const partGroup = trackTabs.el;

  // ---------------------------------------------------------------- patch
  const patch = createPatchBrowser(ctx);
  scope.add(patch.dispose);

  // ---------------------------------------------------------------- transport
  const canPlay = !!(music && music.transport);
  const play = h('button', {
    type: 'button', class: 'transport-btn play-btn', 'aria-pressed': 'false', 'aria-label': 'Play', disabled: !canPlay,
    dataset: { tip: canPlay ? 'Play / stop the sequencers (Space)' : 'Playback needs the music engine, which is not available' }, html: icon('play'),
  });
  scope.on(play, 'click', async () => {
    await ctx.startAudio();
    call(music.transport, 'toggle');
  });
  const renderPlay = () => {
    const on = !!store.get('ui.playing');
    setAttr(play, 'aria-pressed', String(on));
    setAttr(play, 'aria-label', on ? 'Stop' : 'Play');
    play.innerHTML = icon(on ? 'stop' : 'play');
    play.classList.toggle('is-on', on);
  };
  scope.add(store.subscribe('ui.playing', () => schedule(renderPlay)));
  renderPlay();

  // v2.9 one tempo cannot be found (src/ui/eggs.js): typing it keeps the tempo you had
  const tempo = createDragNumber(ctx, binder.globalParam('tempo'), { label: 'Tempo in BPM', suffix: 'BPM', step: 1, pxPerStep: 3, className: 'tempo', parse: tempoParser(() => ctx.eggs?.tempoNotFound()) });
  scope.add(tempo.dispose);
  const ext = h('span', { class: 'ext-badge', hidden: true, dataset: { tip: 'Following external MIDI clock' } }, 'EXT');
  const renderExt = () => {
    const clock = midi && midi.externalClock;
    const follow = !!(clock && clock.active);
    ext.hidden = !follow;
    tempo.setReadOnly(follow);
    if (follow && clock.bpm) tempo.input.value = Math.round(clock.bpm);
  };
  if (midi) {
    scope.add(listen(midi, 'clock', () => schedule(renderExt)));
    scope.add(listen(midi, 'change', () => schedule(renderExt)));
  }
  if (canPlay) scope.add(listen(music.transport, 'state', () => schedule(renderExt)));
  renderExt();

  const recDot = h('span', { class: 'rec-dot', html: icon('record') });
  const recTime = h('span', { class: 'rec-time' });
  const rec = h('button', { type: 'button', class: 'transport-btn rec-btn', 'aria-pressed': 'false', 'aria-label': 'Record' }, recDot, recTime);
  let recLoop = null;
  const recorder = createRecorder(ctx, {
    onState: ({ recording, busy }) => {
      setAttr(rec, 'aria-pressed', String(recording));
      setAttr(rec, 'aria-label', recording ? 'Stop recording and save' : 'Record');
      rec.classList.toggle('is-on', recording);
      rec.classList.toggle('is-busy', busy);
      if (recording && !recLoop) {
        recLoop = addLoop(() => setText(recTime, formatElapsed(recorder.elapsed())));
      } else if (!recording && recLoop) { recLoop(); recLoop = null; setText(recTime, ''); }
    },
  });
  if (!recorder.supported) { rec.disabled = true; rec.dataset.tip = 'Recording needs the audio engine, which is not available'; }
  else rec.dataset.tip = 'Record the output to a WAV file (R)';
  scope.on(rec, 'click', () => recorder.toggle());
  scope.add(recorder.dispose);
  scope.add(() => { if (recLoop) recLoop(); });

  const bounceBtn = h('button', {
    type: 'button', class: 'transport-btn bounce-btn', 'aria-label': 'Bounce to WAV', 'aria-haspopup': 'dialog', html: icon('bounce'),
    dataset: { tip: bounceSupported(ctx) ? 'Bounce: render bars of the sequencers to a WAV file' : 'Bouncing needs the audio and music engines' },
  });
  let bouncePop = null;
  scope.on(bounceBtn, 'click', () => {
    if (bouncePop && bouncePop.isOpen()) { bouncePop.close(); return; }
    bouncePop = openBounce(ctx, bounceBtn);
  });
  // v1.2 looper: Record / Play / Overdub with the loop position ring.
  const loopBtn = createLooperButton(ctx);
  scope.add(loopBtn.dispose);
  const transport = h('div', { class: 'transport', role: 'group', 'aria-label': 'Transport' }, play, h('div', { class: 'tempo-wrap' }, tempo.el, ext), rec, loopBtn.el, bounceBtn);

  // ---------------------------------------------------------------- utilities
  const midiLed = h('span', { class: 'led midi-led', 'aria-hidden': 'true' });
  const midiBtn = h('button', { type: 'button', class: 'icon-btn midi-btn', 'aria-label': 'MIDI settings', html: icon('midi') }, midiLed);
  scope.on(midiBtn, 'click', () => ctx.openSettings('midi'));
  const renderMidi = () => {
    const st = midi ? midi.status : 'unsupported';
    midiBtn.dataset.status = st || 'idle';
    const mpc = midi && has(midi, 'inputs') && (call(midi, 'inputs') || []).some(p => p.isMpc);
    midiBtn.dataset.tip = !midi || midi.supported === false ? 'MIDI is not available in this browser' : st === 'ready' ? (mpc ? 'MIDI ready: Akai MPC detected' : 'MIDI ready') : 'Connect MIDI devices';
  };
  if (midi) {
    let flashTimer = 0;
    scope.add(listen(midi, 'activity', (a) => {
      midiLed.dataset.dir = a && a.dir === 'out' ? 'out' : 'in';
      midiLed.classList.add('is-on');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => midiLed.classList.remove('is-on'), 90);
    }));
    scope.add(listen(midi, 'change', () => schedule(renderMidi)));
  }
  renderMidi();

  const themeBtn = h('button', { type: 'button', class: 'icon-btn theme-btn' });
  const renderTheme = () => {
    const pref = store.get('ui.theme') || 'system';
    themeBtn.innerHTML = icon(`theme-${pref}`);
    themeBtn.setAttribute('aria-label', `Theme: ${THEME_LABEL[pref]}. Switch to ${THEME_LABEL[THEME_NEXT[pref]]}`);
    themeBtn.dataset.tip = `Theme: ${THEME_LABEL[pref]}`;
  };
  scope.on(themeBtn, 'click', () => {
    const before = document.documentElement.dataset.theme;
    const pref = ctx.theme.cycle();
    // System can resolve to the theme already showing; say so, or the click looks broken.
    if (document.documentElement.dataset.theme === before) {
      ctx.toast(pref === 'system' ? `Theme follows your system (${before} right now)` : `${THEME_LABEL[pref]} theme`, { kind: 'info', timeout: 2200 });
    }
  });
  scope.add(store.subscribe('ui.theme', renderTheme));
  renderTheme();

  const settingsBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', 'aria-haspopup': 'dialog', dataset: { tip: 'Settings ( , )' }, html: icon('settings') });
  scope.on(settingsBtn, 'click', () => ctx.openSettings());
  const helpBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Help', 'aria-haspopup': 'dialog', dataset: { tip: 'How it works ( ? )' }, html: icon('help') });
  scope.on(helpBtn, 'click', () => ctx.openHelp());
  const macrosBtn = h('button', { type: 'button', class: 'icon-btn macros-btn', 'aria-label': 'Macros', 'aria-haspopup': 'dialog', dataset: { tip: 'Macros: four knobs you can link to anything' }, html: icon('macro') });
  let macrosPop = null;
  scope.on(macrosBtn, 'click', () => {
    if (macrosPop && macrosPop.isOpen()) { macrosPop.close(); return; }
    macrosPop = openMacros(ctx, macrosBtn);
  });
  // v2.6 undo / redo, with the history list on the undo button's menu (right-click or long-press)
  const undoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Undo', html: icon('undo') });
  const redoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Redo', html: icon('redo') });
  const hist = ctx.history;
  const renderHist = () => {
    if (!hist) { undoBtn.disabled = redoBtn.disabled = true; return; }
    const { past, future } = hist.list();
    undoBtn.disabled = !hist.canUndo; redoBtn.disabled = !hist.canRedo;
    undoBtn.dataset.tip = past.length ? `Undo ${past[past.length - 1]} (Cmd/Ctrl+Z). Right-click for the history` : 'Nothing to undo';
    redoBtn.dataset.tip = future.length ? `Redo ${future[0]} (Shift+Cmd/Ctrl+Z)` : 'Nothing to redo';
  };
  if (hist) {
    scope.on(undoBtn, 'click', () => { const l = hist.undo(); if (l) ctx.toast(`Undid ${l}`); });
    scope.on(redoBtn, 'click', () => { const l = hist.redo(); if (l) ctx.toast(`Redid ${l}`); });
    scope.on(undoBtn, 'contextmenu', (e) => { e.preventDefault(); openHistory(ctx, undoBtn); });
    scope.add(hist.on(renderHist));
  }
  renderHist();
  const utils = h('div', { class: 'utils' }, undoBtn, redoBtn, macrosBtn, midiBtn, themeBtn, settingsBtn, helpBtn);

  // On hendrickresearch.com (served under /music/oro/) a way back to the site's Music page.
  const siteBack = isOnSite()
    ? h('a', { class: 'icon-btn site-back', href: '/music/', 'aria-label': 'Back to Hendrick Research', title: 'Back to Hendrick Research', html: icon('chevron-left') })
    : null;
  if (siteBack) brand.prepend(siteBack);
  container.append(brand, partGroup, patch.el, h('span', { class: 'topbar-spacer' }), transport, utils);

  return {
    recorder,
    patch,
    togglePlay: () => { if (canPlay) play.click(); },
    dispose: scope.dispose,
  };
}

/** True when the app is the copy hosted on hendrickresearch.com (or its previews). */
export function isOnSite(loc = typeof location !== 'undefined' ? location : null) {
  if (!loc || !/^https?:$/.test(loc.protocol || '')) return false;
  return /^\/music\/(oro|orograph)(\/|$)/.test(loc.pathname || '');
}

/** The undo history as a list: click an edit to go back to just before it. */
function openHistory(ctx, anchor) {
  const hist = ctx.history;
  const { past } = hist.list();
  const items = past.slice(-20).map((label, i, arr) => {
    const keep = past.length - arr.length + i;
    const b = h('button', { type: 'button', class: 'history-item' }, label);
    b.addEventListener('click', () => { hist.undoTo(keep); pop.close('select'); });
    return b;
  }).reverse();
  const body = h('div', { class: 'history-pop' }, h('div', { class: 'popover-title' }, 'History'),
    items.length ? h('div', { class: 'history-list' }, items) : h('p', { class: 'popover-note' }, 'Nothing to undo yet.'),
    h('p', { class: 'popover-note' }, 'Click an edit to undo it and everything after it. Redo brings them back.'));
  const pop = openPopover(ctx.layers, anchor, body, { className: 'popover--history', label: 'Undo history', placement: 'bottom-end' });
  return pop;
}
