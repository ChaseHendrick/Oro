// Top bar: wordmark, part tabs (name, patch, note LED), the patch browser,
// transport (play/stop, tempo, record), MIDI activity, theme, settings, help.

import { NUM_PARTS, PART_COLORS } from '../core/params.js';
import { h, createScope, setText, setAttr, listen, call, has } from './dom.js';
import { schedule, addLoop } from './frame.js';
import { createDragNumber } from './controls.js';
import { createPatchBrowser } from './patch-browser.js';
import { createRecorder, formatElapsed } from './record.js';
import { openBounce, bounceSupported } from './bounce.js';
import { partVars, applyVars } from './color.js';
import { icon, brandGlyph } from './icons.js';

const THEME_LABEL = { system: 'System', dark: 'Dark', light: 'Light' };
const THEME_NEXT = { system: 'dark', dark: 'light', light: 'system' };

export function createTopbar(ctx, container) {
  const scope = createScope();
  const { store, binder, music, midi } = ctx;

  // ---------------------------------------------------------------- brand
  const brand = h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: brandGlyph(26) }), h('span', { class: 'brand-word' }, 'OROGRAPH'));

  // ---------------------------------------------------------------- parts
  const tabs = [];
  const partGroup = h('div', { class: 'part-tabs', role: 'radiogroup', 'aria-label': 'Parts' });
  for (let i = 0; i < NUM_PARTS; i++) {
    const led = h('span', { class: 'led part-led', 'aria-hidden': 'true' });
    const name = h('span', { class: 'part-name' });
    const patch = h('span', { class: 'part-patch' });
    const tab = h('button', {
      type: 'button', class: 'part-tab', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { part: String(i), tip: `Select part ${i + 1} (key ${i + 1})` },
    }, led, h('span', { class: 'part-num', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 'part-texts' }, name, patch), h('span', { class: 'part-mute', 'aria-hidden': 'true' }, 'M'));
    scope.on(tab, 'click', () => store.set('ui.selectedPart', i, { source: 'ui' }));
    tabs.push({ tab, led, name, patch });
    partGroup.appendChild(tab);
  }
  scope.on(partGroup, 'keydown', (e) => {
    const i = tabs.findIndex(t => t.tab === document.activeElement);
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % NUM_PARTS;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + NUM_PARTS) % NUM_PARTS;
    if (n >= 0) { e.preventDefault(); store.set('ui.selectedPart', n, { source: 'ui' }); tabs[n].tab.focus(); }
  });
  function renderParts() {
    const sel = binder.selected();
    const theme = document.documentElement.dataset.theme;
    tabs.forEach(({ tab, name, patch }, i) => {
      const on = i === sel;
      setAttr(tab, 'aria-checked', String(on));
      tab.tabIndex = on ? 0 : -1;
      const nm = store.get(`parts.${i}.name`) || `Part ${i + 1}`;
      const pn = store.get(`parts.${i}.patchName`) || 'Init';
      setText(name, nm);
      setText(patch, pn);
      setAttr(tab, 'aria-label', `${nm}, ${pn}`);
      tab.classList.toggle('is-muted', !!store.get(`parts.${i}.params.mute`));
      applyVars(tab, partVars(store.get(`parts.${i}.color`) || PART_COLORS[i], theme, ctx.panelBg()));
    });
  }
  scope.add(store.subscribe('ui.selectedPart', () => schedule(renderParts)));
  scope.add(store.subscribe('parts', (path) => { if (/^parts(\.\d(\.(name|patchName|color|params(\.mute)?))?)?$/.test(path)) schedule(renderParts); }));
  scope.add(store.subscribe('', (path) => { if (path === '') schedule(renderParts); }));
  scope.on(window, 'orograph:theme', () => schedule(renderParts));

  // Note LEDs: lit while notes sound on a part, with a flash on each new note.
  const heldCount = new Array(NUM_PARTS).fill(0);
  if (ctx.notes) {
    scope.add(ctx.notes.on(({ part, on }) => {
      if (part < 0 || part >= NUM_PARTS) return;
      heldCount[part] = Math.max(0, heldCount[part] + (on ? 1 : -1));
      const led = tabs[part].led;
      led.classList.toggle('is-on', heldCount[part] > 0);
      if (on) { led.classList.remove('is-flash'); void led.offsetWidth; led.classList.add('is-flash'); }
    }));
  }
  // Fallback: the engine's voice counts keep LEDs honest if note events are missed.
  scope.add(addLoop(() => {
    if (!ctx.tele || !ctx.tele.fresh()) return;
    for (let i = 0; i < NUM_PARTS; i++) {
      const active = ctx.tele.activeVoices(i) > 0;
      if (!active && heldCount[i] > 0) { heldCount[i] = 0; tabs[i].led.classList.remove('is-on'); }
      tabs[i].led.classList.toggle('is-sounding', active);
    }
  }));

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

  const tempo = createDragNumber(ctx, binder.globalParam('tempo'), { label: 'Tempo in BPM', suffix: 'BPM', step: 1, pxPerStep: 3, className: 'tempo' });
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
  const transport = h('div', { class: 'transport', role: 'group', 'aria-label': 'Transport' }, play, h('div', { class: 'tempo-wrap' }, tempo.el, ext), rec, bounceBtn);

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
  const utils = h('div', { class: 'utils' }, midiBtn, themeBtn, settingsBtn, helpBtn);

  container.append(brand, partGroup, patch.el, h('span', { class: 'topbar-spacer' }), transport, utils);
  renderParts();

  return {
    recorder,
    patch,
    togglePlay: () => { if (canPlay) play.click(); },
    dispose: scope.dispose,
  };
}
