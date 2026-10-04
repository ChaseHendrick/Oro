// Live performance mode (2.12): the full-screen stage view, loaded on demand
// from the top bar's Live button or Shift+L.
//
// The view asks for full screen on its own root element; where that is not
// offered (or refused) it stays a fixed overlay over the whole window. The
// 3D map's element is moved in as the backdrop while the view is open and
// put back on exit, and the floating layers (dialogs, menus, toasts) move in
// with it so they show in full screen too.
//
// Keys while open (window capture, so the note keys and other shortcuts do
// not fire underneath): 1 to 0 and Q to Y play the 16 pads, Space plays and
// stops, the arrow keys step through the setlist, Esc or Shift+L leaves.
// Typing in a text field is never taken over.
//
// The lock ignores pointer input outside the pads (and the lock button,
// which unlocks when held). Keys, MIDI and Esc keep working while locked, so
// Esc always leaves live mode.

import '../styles/live.css';
import { h, s, setText, createScope, isTypingTarget, prefersReducedMotion, listen } from '../ui/dom.js';
import { addLoop, schedule } from '../ui/frame.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { hexToRgb, luminance } from '../ui/color.js';
import { readSmart, smartKnobLabel, applySmartKnob, SMART_KNOBS } from '../core/smart.js';
import { NOTE_NAMES, SCALE_NAMES } from '../core/params.js';
import { getVersions } from '../core/versions.js';
import { createLiveController } from './controller.js';
import { createWakeLock, enterFullscreen, leaveFullscreen } from './wake.js';
import { PAD_COUNT, PAD_KEY_LABELS, liveKeyAction, liveMidiAction, lockBlocks, nowNext } from './setup.js';
import { openPadEditor, openSetlistEditor } from './live-edit.js';

export const UNLOCK_HOLD_MS = 1200;
const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'wheel'];
const STORE_PATHS = /^(|live(\..*)?|parts|parts\.\d+|parts\.\d+\.(activePattern|patterns|name|color|smart(\..*)?|drum(\.on)?|params(\.(mute|solo))?)|global|global\.(tempo|masterVolume|macro\d|scaleRoot|scaleType)|ui\.(selectedPart|playing))$/;
const TYPE_SHORT = { scene: 'Scene', section: 'Section', pattern: 'Pattern', mute: 'Mute', solo: 'Solo', drum: 'Drum', note: 'Notes', macros: 'Macros', smart: 'Smart' };
const QUANT_TEXT = { beat: 'Next beat', bar: 'Next bar' };

let current = null;

export const isLiveOpen = () => !!current;

/** Open live mode, or leave it when it is open. */
export function toggleLive(ctx) {
  if (current) { current.close(); return null; }
  return openLive(ctx);
}

const inkFor = (hex) => (luminance(hexToRgb(hex)) > 0.32 ? '#05070d' : '#ffffff');
const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

export function openLive(ctx) {
  if (current) return current;
  const { store, music, presets, layers, midi } = ctx;
  const scope = createScope();
  const reduced = () => prefersReducedMotion();
  const live = createLiveController({
    store, music, presets, getVersions,
    togglePlay: () => (typeof ctx.togglePlay === 'function' ? ctx.togglePlay() : (music && music.transport ? music.transport.toggle() : undefined)),
    panic: () => (typeof ctx.panic === 'function' ? ctx.panic() : undefined),
  });
  scope.add(live.dispose);
  let editMode = false;
  let confirmFor = -1;       // setlist index waiting for an OK (songChange 'confirm')
  let confirmTimer = 0;

  // ------------------------------------------------------------- header
  const status = h('p', { class: 'live-status', role: 'status', 'aria-live': 'polite' });
  let statusTimer = 0;
  const say = (text, ms = 4000) => {
    setText(status, text);
    clearTimeout(statusTimer);
    if (text && ms) statusTimer = setTimeout(() => setText(status, ''), ms);
  };
  scope.add(() => clearTimeout(statusTimer));

  const nowName = h('strong', { class: 'live-now-name' });
  const nowMeta = h('span', { class: 'live-meta' });
  const nowCues = h('span', { class: 'live-cues' });
  const nextName = h('strong', { class: 'live-next-name' });
  const nextMeta = h('span', { class: 'live-meta' });
  const nextRing = ring('live-next-ring');
  const nextBox = h('div', { class: 'live-next' }, h('span', { class: 'live-kicker' }, 'Next'), h('div', { class: 'live-next-line' }, nextRing.el, nextName), nextMeta);
  const nowBox = h('div', { class: 'live-now' }, h('span', { class: 'live-kicker' }, 'Now'), nowName, nowMeta, nowCues);
  const barText = h('span', { class: 'live-bar-num' });
  const beatText = h('span', { class: 'live-beat-num' });
  const counter = h('div', { class: 'live-counter', 'aria-label': 'Bar and beat' }, h('span', { class: 'live-kicker' }, 'Bar'), h('div', { class: 'live-counter-nums' }, barText, beatText));
  const clockText = h('span', { class: 'live-clock-num' });
  const clockBox = h('div', { class: 'live-clock' }, h('span', { class: 'live-kicker' }, 'Time'), clockText);

  const btn = (label, iconName, cls = '', tip = '') => h('button', { type: 'button', class: `live-btn ${cls}`, 'aria-label': label, dataset: tip ? { tip } : null, html: `${iconName ? icon(iconName) : ''}<span>${label}</span>` });
  const prevBtn = btn('Previous', 'arrow-left', 'live-prev', 'Previous song (Left arrow)');
  const nextBtn = btn('Next', 'arrow-right', 'live-nextbtn', 'Next song (Right arrow)');
  const lockBtn = h('button', { type: 'button', class: 'live-btn live-lock', dataset: { liveSafe: '' }, 'aria-pressed': 'false' },
    h('span', { class: 'live-lock-fill', 'aria-hidden': 'true' }), h('span', { class: 'live-lock-icon', html: icon('unlock') }), h('span', { class: 'live-lock-text' }, 'Lock'));
  const editBtn = btn('Edit pads', 'edit', 'live-edit', 'Choose what each pad does');
  editBtn.setAttribute('aria-pressed', 'false');
  const setlistBtn = btn('Setlist', 'setlist', 'live-setlist-btn', 'Songs, notes and options');
  const exitBtn = btn('Exit', 'exit-full', 'live-exit', 'Leave live mode (Esc)');
  const head = h('header', { class: 'live-head' },
    h('div', { class: 'live-songs' }, nowBox, nextBox),
    h('div', { class: 'live-readouts' }, counter, clockBox),
    h('div', { class: 'live-actions' }, prevBtn, nextBtn, lockBtn, editBtn, setlistBtn, exitBtn));

  // --------------------------------------------------------------- pads
  const padEls = [];
  const padsEl = h('section', { class: 'live-pads', role: 'group', 'aria-label': 'Pads', dataset: { liveSafe: '' } });
  for (let i = 0; i < PAD_COUNT; i++) {
    const r = ring('live-pad-ring');
    const el = h('button', { type: 'button', class: 'live-pad', dataset: { index: String(i), state: 'empty' } },
      h('span', { class: 'live-pad-key', 'aria-hidden': 'true' }, PAD_KEY_LABELS[i]),
      h('span', { class: 'live-pad-q', 'aria-hidden': 'true' }),
      r.el,
      h('span', { class: 'live-pad-label' }),
      h('span', { class: 'live-pad-sub' }),
      h('span', { class: 'live-pad-wait' }));
    padEls.push({ el, ring: r, label: el.querySelector('.live-pad-label'), sub: el.querySelector('.live-pad-sub'), wait: el.querySelector('.live-pad-wait'), q: el.querySelector('.live-pad-q') });
    padsEl.appendChild(el);
  }

  // ---------------------------------------------------- big controls
  const playBtn = h('button', { type: 'button', class: 'live-big live-play', 'aria-label': 'Play', dataset: { tip: 'Play / stop (Space)' }, html: icon('play') });
  const tempoNum = h('span', { class: 'live-tempo-num' });
  const tempoUnit = h('span', { class: 'live-tempo-unit' }, 'BPM');
  const tempoDown = h('button', { type: 'button', class: 'live-big live-tempo-step', 'aria-label': 'Slower', html: icon('minus') });
  const tempoUp = h('button', { type: 'button', class: 'live-big live-tempo-step', 'aria-label': 'Faster', html: icon('plus') });
  const tapBtn = h('button', { type: 'button', class: 'live-big live-tap', dataset: { tip: 'Tap four times in time to set the tempo' } }, 'Tap');
  const panicBtn = h('button', { type: 'button', class: 'live-big live-panic', dataset: { tip: 'Stop every note at once' }, html: `${icon('panic')}<span>Panic</span>` });
  const tempoBox = h('div', { class: 'live-tempo', role: 'group', 'aria-label': 'Tempo' }, tempoDown, h('div', { class: 'live-tempo-read' }, tempoNum, tempoUnit), tempoUp, tapBtn);
  const transportRow = h('div', { class: 'live-transport' }, playBtn, tempoBox, panicBtn);
  const faders = [];
  const faderRow = h('div', { class: 'live-faders' });
  const faderCaption = h('p', { class: 'live-fader-caption' });
  const controls = h('section', { class: 'live-controls', 'aria-label': 'Controls' }, transportRow, faderCaption, faderRow);

  // ------------------------------------------------------------ confirm
  const confirmText = h('span', { class: 'live-confirm-text' });
  const confirmGo = h('button', { type: 'button', class: 'live-btn live-confirm-go' }, 'Go at the next bar');
  const confirmNo = h('button', { type: 'button', class: 'live-btn' }, 'Cancel');
  const confirmBar = h('div', { class: 'live-confirm', role: 'alertdialog', 'aria-label': 'Change song', hidden: true, dataset: { liveSafe: '' } }, confirmText, confirmGo, confirmNo);

  // --------------------------------------------------------------- root
  const backdrop = h('div', { class: 'live-backdrop', 'aria-hidden': 'true' });
  const main = h('div', { class: 'live-main' }, head, h('div', { class: 'live-body' }, padsEl, controls), confirmBar, status);
  const root = h('div', { class: 'live-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Live mode', tabindex: '-1' }, backdrop, h('div', { class: 'live-scrim', 'aria-hidden': 'true' }), main);

  // ------------------------------------------------------------ helpers

  function ring(cls) {
    const prog = s('circle', { class: 'ring-prog', cx: '18', cy: '18', r: '15', pathLength: '100', 'stroke-dasharray': '100', 'stroke-dashoffset': '100' });
    const el = s('svg', { class: `live-ring ${cls}`, viewBox: '0 0 36 36', 'aria-hidden': 'true' },
      s('circle', { class: 'ring-track', cx: '18', cy: '18', r: '15', pathLength: '100' }), prog);
    let last = -1;
    return {
      el,
      set(p) {
        const v = p == null ? 100 : Math.round((1 - Math.max(0, Math.min(1, p))) * 1000) / 10;
        if (v !== last) { last = v; prog.setAttribute('stroke-dashoffset', String(v)); }
      },
    };
  }

  const keyName = (g) => `${NOTE_NAMES[Math.round(Number(g && g.scaleRoot) || 0)] || 'C'} ${SCALE_NAMES[Math.round(Number(g && g.scaleType) || 0)] || ''}`.trim();

  function songInfo(entry) {
    if (!entry) return { name: '', meta: '' };
    let key = entry.key, tempo = entry.tempo;
    if (entry.kind === 'scene' && presets && (!key || !tempo)) {
      try {
        const sc = presets.scenes().find(x => x.id === entry.ref);
        if (sc) { key = key || sc.key; tempo = tempo || sc.tempo; }
      } catch { /* library unavailable */ }
    } else if (entry.kind === 'version' && (!key || !tempo)) {
      const v = getVersions();
      const it = v ? v.list().find(x => x.id === entry.ref) : null;
      if (it) { key = key || it.key; tempo = tempo || it.tempo; }
    }
    return { name: entry.name, meta: [key, tempo ? `${tempo} BPM` : ''].filter(Boolean).join(', ') };
  }

  // ------------------------------------------------------------- render

  function renderPads() {
    const list = live.pads();
    for (let i = 0; i < PAD_COUNT; i++) {
      const pad = list[i];
      const st = live.status(i, list);
      const p = padEls[i];
      p.el.dataset.state = st;
      const color = pad ? pad.color : '#6f7a92';
      p.el.style.setProperty('--pad', color);
      p.el.style.setProperty('--pad-ink', inkFor(color));
      const label = pad ? (pad.label || TYPE_SHORT[pad.type]) : (editMode ? 'Empty' : '');
      setText(p.label, label);
      let sub = '';
      if (pad) {
        if (pad.type === 'pattern') sub = `Pattern ${pad.pattern + 1}, track ${pad.track + 1}`;
        else if (pad.type === 'mute' || pad.type === 'solo') sub = `${TYPE_SHORT[pad.type]}, track ${pad.track + 1}`;
        else if (pad.type === 'drum') sub = `Drum, track ${pad.track + 1}`;
        else if (pad.type === 'note' && pad.track !== 'sel') sub = `Notes, track ${pad.track + 1}`;
        else sub = TYPE_SHORT[pad.type];
      } else if (editMode) sub = 'Tap to set up';
      if (st === 'missing') sub = 'Not available';
      setText(p.sub, sub);
      setText(p.wait, st === 'queued' ? (QUANT_TEXT[pad && pad.quant] || 'Waiting') : '');
      setText(p.q, pad && pad.quant !== 'off' && st !== 'queued' ? (pad.quant === 'bar' ? 'Bar' : 'Beat') : '');
      const stateText = { empty: 'empty', missing: 'not available', queued: 'queued', active: 'on', armed: 'ready' }[st];
      p.el.setAttribute('aria-label', `Pad ${i + 1}, key ${PAD_KEY_LABELS[i]}: ${label || 'empty'}, ${stateText}`);
      p.el.setAttribute('aria-pressed', String(st === 'active'));
      if (st !== 'queued') p.ring.set(null);
      else if (reduced()) p.ring.set(1);
    }
  }

  function renderSongs() {
    const list = live.setlist();
    const pos = live.position();
    const queued = live.queuedSong();
    const nn = nowNext(list, pos);
    const nextIndex = queued >= 0 ? queued : (confirmFor >= 0 ? confirmFor : nn.nextIndex);
    const now = songInfo(nn.now);
    if (nn.now) { setText(nowName, now.name); setText(nowMeta, now.meta); setText(nowCues, nn.now.cues || ''); }
    else if (list.length) { setText(nowName, 'Ready'); setText(nowMeta, 'Press Next to start the setlist'); setText(nowCues, ''); }
    else {
      const sc = live.lastScene() && presets ? (presets.scenes().find(x => x.id === live.lastScene()) || null) : null;
      setText(nowName, sc ? sc.name : 'This session');
      setText(nowMeta, `${keyName(store.get('global'))}, ${Math.round(Number(store.get('global.tempo')) || 0)} BPM`);
      setText(nowCues, 'Add songs in Setlist');
    }
    const next = nextIndex >= 0 ? list[nextIndex] : null;
    const ni = songInfo(next);
    setText(nextName, next ? ni.name : (list.length ? 'End of the setlist' : 'No setlist'));
    setText(nextMeta, next ? (queued >= 0 ? 'Loads at the next bar' : ni.meta) : '');
    nextBox.dataset.state = queued >= 0 ? 'queued' : 'idle';
    if (queued < 0) nextRing.set(null); else if (reduced()) nextRing.set(1);
    prevBtn.disabled = !list.length || pos <= 0;
    nextBtn.disabled = !list.length || (pos >= list.length - 1 && queued < 0);
  }

  function renderTransport() {
    const on = !!store.get('ui.playing');
    playBtn.innerHTML = icon(on ? 'stop' : 'play');
    playBtn.setAttribute('aria-label', on ? 'Stop' : 'Play');
    playBtn.classList.toggle('is-on', on);
    const clock = midi && midi.externalClock;
    const ext = !!(clock && clock.active);
    const bpm = ext && clock.bpm ? clock.bpm : Number(store.get('global.tempo')) || 0;
    setText(tempoNum, String(Math.round(bpm)));
    setText(tempoUnit, ext ? 'BPM, external clock' : 'BPM');
    tempoDown.disabled = tempoUp.disabled = tapBtn.disabled = ext;
  }

  function renderSetup() {
    const cfg = live.setup();
    root.dataset.backdrop = cfg.backdrop;
    root.dataset.look = cfg.look;
    root.dataset.locked = cfg.lock ? '1' : '0';
    lockBtn.setAttribute('aria-pressed', String(!!cfg.lock));
    lockBtn.querySelector('.live-lock-icon').innerHTML = icon(cfg.lock ? 'lock' : 'unlock');
    setText(lockBtn.querySelector('.live-lock-text'), cfg.lock ? 'Hold to unlock' : 'Lock');
    lockBtn.setAttribute('aria-label', cfg.lock ? 'Locked. Hold to unlock' : 'Lock');
    lockBtn.dataset.tip = cfg.lock ? 'Locked: only the pads respond. Hold here to unlock (Esc still leaves)' : 'Lock: ignore clicks outside the pads';
    // Map off: hide it so it stops drawing (it is out of sight anyway).
    backdrop.hidden = cfg.backdrop === 'off';
  }

  function renderFaders() { for (const f of faders) f.render(); }

  const renderAll = () => { renderSetup(); renderPads(); renderSongs(); renderTransport(); renderFaders(); };

  // ------------------------------------------------------------- faders

  function createFader({ label, get, set, target, enabled = () => true, group }) {
    const fill = h('span', { class: 'live-fader-fill' });
    const thumb = h('span', { class: 'live-fader-thumb' });
    const track = h('span', { class: 'live-fader-track' }, fill, thumb);
    const value = h('span', { class: 'live-fader-value' });
    const name = h('span', { class: 'live-fader-label' });
    const el = h('div', { class: 'live-fader', role: 'slider', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-orientation': 'vertical', dataset: { group } }, value, track, name);
    let last = null;
    function render() {
      const on = enabled();
      el.classList.toggle('is-off', !on);
      el.setAttribute('aria-disabled', String(!on));
      const v = Math.max(0, Math.min(1, Number(get()) || 0));
      const l = typeof label === 'function' ? label() : label;
      const key = `${on}|${v}|${l}`;
      if (key === last) return;
      last = key;
      el.style.setProperty('--v', String(v));
      setText(value, on ? pct(v) : 'Off');
      setText(name, l);
      el.setAttribute('aria-label', l);
      el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      el.setAttribute('aria-valuetext', on ? pct(v) : 'not set up');
      const t = target && target();
      el.classList.toggle('is-mapped', !!(t && ctx.findMapping && ctx.findMapping(t)));
    }
    const put = (v) => { if (!enabled()) return; set(Math.max(0, Math.min(1, Math.round(v * 1000) / 1000))); render(); };
    let dragging = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !enabled()) return;
      e.preventDefault();
      el.focus({ preventScroll: true });
      dragging = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
      el.classList.add('is-dragging');
      move(e);
    });
    const move = (e) => {
      if (dragging !== e.pointerId) return;
      const r = track.getBoundingClientRect();
      if (r.height > 0) put(1 - (e.clientY - r.top) / r.height);
    };
    el.addEventListener('pointermove', move);
    const end = (e) => { if (dragging === e.pointerId) { dragging = null; el.classList.remove('is-dragging'); } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.001 : 0.01;
      const map = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 0.1, PageDown: -0.1 };
      if (e.key in map) { e.preventDefault(); e.stopPropagation(); put((Number(get()) || 0) + map[e.key]); }
      else if (e.key === 'Home') { e.preventDefault(); put(0); }
      else if (e.key === 'End') { e.preventDefault(); put(1); }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = target && target();
      if (!t || !ctx.midiOk || !ctx.midiOk()) { say('Connect MIDI in Settings to map a controller to this fader.'); return; }
      const mapping = ctx.findMapping(t);
      const l = typeof label === 'function' ? label() : label;
      const items = [{ heading: l }, { label: 'MIDI Learn', icon: icon('learn'), hint: mapping ? `CC ${mapping.cc}` : '', onSelect: () => ctx.learn.start(t, l, () => render()) }];
      if (mapping) items.push({ label: 'Remove MIDI mapping', icon: icon('close'), onSelect: () => { ctx.unmap(t); last = null; render(); } });
      openMenu(layers, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : el, items, { label: `${l} options` });
    });
    const f = { el, render };
    faders.push(f);
    faderRow.appendChild(el);
    return f;
  }

  const sel = () => Math.max(0, Math.min((store.get('parts') || []).length - 1, Math.round(Number(store.get('ui.selectedPart')) || 0)));
  for (let k = 1; k <= 4; k++) {
    const b = ctx.binder.globalParam(`macro${k}`);
    createFader({ group: 'macro', label: `Macro ${k}`, get: () => b.get(), set: (v) => b.set(v, { source: 'ui' }), target: () => b.learnTarget() });
  }
  for (let k = 0; k < SMART_KNOBS; k++) {
    const knob = () => readSmart(store, sel()).knobs[k];
    createFader({
      group: 'smart',
      label: () => smartKnobLabel(knob(), k),
      get: () => knob().value,
      set: (v) => applySmartKnob(store, sel(), k, v, { source: 'ui' }),
      target: () => ({ scope: 'smart', part: 'sel', id: `smart${k + 1}` }),
      enabled: () => knob().maps.length > 0,
    });
  }
  {
    const b = ctx.binder.globalParam('masterVolume');
    createFader({ group: 'master', label: 'Volume', get: () => b.get(), set: (v) => b.set(v, { source: 'ui' }), target: () => b.learnTarget() });
  }
  const renderSmartHint = () => {
    const name = store.get(`parts.${sel()}.name`) || `Track ${sel() + 1}`;
    setText(faderCaption, `Macros 1 to 4, then the smart controls of ${name}, then the master volume. Right-click a fader for MIDI Learn.`);
  };

  // ------------------------------------------------------------ actions

  function pressPad(i, { hold = true } = {}) {
    if (editMode) { openPadEditor(ctx, live, i, { appRoot: main }); return; }
    if (typeof ctx.startAudio === 'function') ctx.startAudio();
    const r = live.press(i, { hold });
    const pad = live.pads()[i];
    if (r === 'missing') say(`Pad ${i + 1}: ${live.missing(i)}.`);
    else if (r === 'queued') say(`${pad.label || 'Pad'} at the ${pad.quant === 'beat' ? 'next beat' : 'next bar'}. Press again to cancel.`, 2500);
    else if (r === 'cancelled') say(`${pad.label || 'Pad'} cancelled.`, 2500);
    else if (r === 'empty' && !editMode) say('That pad is empty. Use Edit pads to set it up.');
    schedule(renderAll);
  }

  function clearConfirm() {
    confirmFor = -1;
    clearTimeout(confirmTimer);
    confirmBar.hidden = true;
    schedule(renderSongs);
  }
  scope.add(() => clearTimeout(confirmTimer));

  async function song(dir) {
    if (confirmFor >= 0) {
      // A second Next (or Previous) while asking is the OK.
      const target = confirmFor;
      clearConfirm();
      const r = await live.goTo(target, { confirmed: true });
      reportSong(r, target);
      return;
    }
    const pos = live.position();
    const target = dir > 0 ? pos + 1 : pos - 1;
    const r = dir > 0 ? await live.next() : await live.prev();
    if (r === 'confirm') {
      confirmFor = target;
      const entry = live.setlist()[target];
      setText(confirmText, `Go to "${entry ? entry.name : 'the next song'}"? Press ${dir > 0 ? 'Next' : 'Previous'} again or choose:`);
      confirmBar.hidden = false;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(clearConfirm, 10000);
      schedule(renderSongs);
      return;
    }
    reportSong(r, target);
  }

  function reportSong(r, target) {
    const entry = live.setlist()[target];
    if (r === 'queued') say(`"${entry ? entry.name : 'Next song'}" loads at the next bar. Press again to cancel.`, 3000);
    else if (r === 'cancelled') say('Song change cancelled.', 2500);
    else if (r === 'loaded') say(`Now playing "${entry ? entry.name : ''}".`, 2500);
    else if (r === 'end') say('That was the last song in the setlist.');
    else if (r === 'start') say('This is the first song in the setlist.');
    else if (r === 'empty') say('The setlist is empty. Add songs in Setlist.');
    else if (r === 'missing') say(`"${entry ? entry.name : 'That song'}" cannot be loaded: ${live.songMissing(target)}.`, 6000);
    else if (r === 'failed') say('That song could not be loaded.', 6000);
    schedule(renderAll);
  }

  function act(a, opts) {
    if (!a) return;
    if (a.kind === 'pad') pressPad(a.index, opts);
    else if (a.kind === 'play') { live.play(); schedule(renderTransport); }
    else if (a.kind === 'next') song(1);
    else if (a.kind === 'prev') song(-1);
    else if (a.kind === 'exit') close();
  }

  // Pads: press on pointer down, let go on pointer up (note pads hold); keyboard activation taps.
  const downs = new Map();
  padsEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest && e.target.closest('.live-pad');
    if (!el || e.button > 0) return;
    const i = Number(el.dataset.index);
    if (editMode) return;   // edit opens on click
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    downs.set(e.pointerId, i);
    pressPad(i, { hold: true });
  });
  const padUp = (e) => {
    if (!downs.has(e.pointerId)) return;
    const i = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    live.release(i);
    schedule(renderPads);
  };
  padsEl.addEventListener('pointerup', padUp);
  padsEl.addEventListener('pointercancel', padUp);
  padsEl.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('.live-pad');
    if (!el) return;
    const i = Number(el.dataset.index);
    if (editMode) { openPadEditor(ctx, live, i, { appRoot: main }); return; }
    // detail 0: Enter or Space on a focused pad (a pointer press was handled on pointer down)
    if (e.detail === 0) { pressPad(i, { hold: false }); }
  });
  padsEl.addEventListener('contextmenu', (e) => {
    const el = e.target.closest && e.target.closest('.live-pad');
    if (!el) return;
    e.preventDefault();
    if (live.setup().lock) return;
    const i = Number(el.dataset.index);
    const t = { scope: 'action', id: `live.pad${i + 1}` };
    const mapping = ctx.findMapping ? ctx.findMapping(t) : null;
    const items = [{ heading: `Pad ${i + 1}` }, { label: 'Edit pad...', icon: icon('edit'), onSelect: () => openPadEditor(ctx, live, i, { appRoot: main }) }];
    if (ctx.midiOk && ctx.midiOk()) {
      items.push({ label: 'MIDI Learn', icon: icon('learn'), hint: mapping ? `CC ${mapping.cc}` : '', onSelect: () => ctx.learn.start(t, `pad ${i + 1}`) });
      if (mapping) items.push({ label: 'Remove MIDI mapping', icon: icon('close'), onSelect: () => ctx.unmap(t) });
    }
    openMenu(layers, el, items, { label: `Pad ${i + 1} options` });
  });

  prevBtn.addEventListener('click', () => song(-1));
  nextBtn.addEventListener('click', () => song(1));
  confirmGo.addEventListener('click', () => song(1));
  confirmNo.addEventListener('click', () => { clearConfirm(); say('Song change cancelled.', 2500); });
  editBtn.addEventListener('click', () => {
    editMode = !editMode;
    root.dataset.edit = editMode ? '1' : '0';
    editBtn.setAttribute('aria-pressed', String(editMode));
    setText(editBtn.querySelector('span'), editMode ? 'Done' : 'Edit pads');
    editBtn.setAttribute('aria-label', editMode ? 'Done editing pads' : 'Edit pads');
    say(editMode ? 'Tap a pad to choose what it does. Press Done when you are finished.' : '', 0);
    schedule(renderPads);
  });
  setlistBtn.addEventListener('click', () => openSetlistEditor(ctx, live, { onChange: () => schedule(renderAll), appRoot: main }));
  exitBtn.addEventListener('click', () => close());
  playBtn.addEventListener('click', () => { live.play(); schedule(renderTransport); });
  tempoDown.addEventListener('click', () => live.setTempo((Number(store.get('global.tempo')) || 120) - 1));
  tempoUp.addEventListener('click', () => live.setTempo((Number(store.get('global.tempo')) || 120) + 1));
  tapBtn.addEventListener('pointerdown', (e) => { if (e.button > 0) return; e.preventDefault(); const bpm = live.tap(); if (bpm == null) say('Keep tapping in time.', 1500); });
  tapBtn.addEventListener('click', (e) => { if (e.detail === 0) live.tap(); });
  panicBtn.addEventListener('click', () => { live.panic(); schedule(renderAll); });

  // ---------------------------------------------------------------- lock
  let holdTimer = 0;
  let unlockedAt = 0;   // the click that ends an unlocking hold must not lock again
  const holdStart = () => {
    if (!live.setup().lock || holdTimer) return;
    lockBtn.classList.add('is-holding');
    if (reduced()) setText(lockBtn.querySelector('.live-lock-text'), 'Keep holding');
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      lockBtn.classList.remove('is-holding');
      live.writeLive({ lock: 0 }, { source: 'prefs' });
      unlockedAt = Date.now();
      say('Unlocked.', 2000);
    }, UNLOCK_HOLD_MS);
  };
  const holdEnd = () => {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = 0;
    lockBtn.classList.remove('is-holding');
    renderSetup();
  };
  scope.add(() => clearTimeout(holdTimer));
  lockBtn.addEventListener('pointerdown', (e) => { if (e.button > 0) return; if (live.setup().lock) { e.preventDefault(); holdStart(); } });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) lockBtn.addEventListener(t, holdEnd);
  lockBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.repeat && live.setup().lock) { e.preventDefault(); holdStart(); } });
  lockBtn.addEventListener('keyup', (e) => { if (e.key === 'Enter') holdEnd(); });
  lockBtn.addEventListener('click', (e) => {
    if (live.setup().lock) { e.preventDefault(); if (e.detail !== 0 && !holdTimer) say('Hold the lock button to unlock. Esc still leaves live mode.'); return; }
    if (Date.now() - unlockedAt < 1500) { unlockedAt = 0; return; }
    live.writeLive({ lock: 1 }, { source: 'prefs' });
    if (editMode) editBtn.click();
    say('Locked: only the pads respond to clicks and taps. Hold the lock button to unlock.', 5000);
  });
  // While locked, pointer input outside the pads (and the lock, and dialogs) is dropped.
  const guard = (e) => {
    if (!lockBlocks(e.target, !!live.setup().lock)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'pointerdown') say('Locked: hold the lock button to unlock.', 2500);
  };
  for (const t of BLOCKED) root.addEventListener(t, guard, { capture: true, passive: false });

  // ---------------------------------------------------------------- keys
  const heldKeys = new Map();   // code -> pad index
  const onKeyDown = (e) => {
    if (layers && layers.hasModal && layers.hasModal()) return;           // a dialog has the keys
    if (e.key === 'Escape' && layers && layers.count && layers.count() > 0) return;   // closes the menu or MIDI learn
    if (isTypingTarget(e.target)) return;
    if (e.key === 'Escape' && confirmFor >= 0) { e.preventDefault(); e.stopImmediatePropagation(); clearConfirm(); say('Song change cancelled.', 2500); return; }
    const a = liveKeyAction(e);
    if (!a) {
      // Keep the note keys and the app's other shortcuts quiet while live mode is open.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key && e.key.length === 1) e.stopImmediatePropagation();
      return;
    }
    const onFader = e.target && e.target.closest && e.target.closest('.live-fader');
    if ((a.kind === 'next' || a.kind === 'prev') && onFader) { e.stopImmediatePropagation(); return; }   // the fader moves
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (a.kind === 'pad') heldKeys.set(e.code, a.index);
    act(a, { hold: true });
  };
  const onKeyUp = (e) => {
    // Space is always play / stop here (Enter presses a focused button), so it must not click one on release.
    if ((e.code === 'Space' || e.key === ' ') && !isTypingTarget(e.target) && !(layers && layers.hasModal && layers.hasModal())) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (!heldKeys.has(e.code)) return;
    const i = heldKeys.get(e.code);
    heldKeys.delete(e.code);
    e.stopImmediatePropagation();
    live.release(i);
    schedule(renderPads);
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  scope.add(() => { window.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('keyup', onKeyUp, true); });
  const onBlur = () => { for (const i of heldKeys.values()) live.release(i); heldKeys.clear(); };
  window.addEventListener('blur', onBlur);
  scope.add(() => window.removeEventListener('blur', onBlur));

  // ---------------------------------------------------------------- MIDI
  if (midi) scope.add(listen(midi, 'action', (e) => { const a = liveMidiAction(e && e.id); if (a) act(a, { hold: false }); }));
  if (midi) scope.add(listen(midi, 'clock', () => schedule(renderTransport)));

  // ------------------------------------------------------- subscriptions
  scope.add(live.on('change', () => schedule(renderAll)));
  scope.add(store.subscribe('', (path) => {
    if (STORE_PATHS.test(path)) { schedule(renderAll); schedule(renderSmartHint); }
  }));
  if (presets && typeof presets.on === 'function') scope.add(presets.on('change', () => schedule(renderAll)));
  if (ctx.bus) scope.add(ctx.bus.on('mappings', () => schedule(renderFaders)));

  // Bar counter and clock (text changes only when the numbers do), queued rings while waiting.
  let lastRead = 0, lastClock = '';
  scope.add(addLoop((t) => {
    if (t - lastRead >= 90) {
      lastRead = t;
      const tr = music && music.transport;
      const playing = !!(tr && tr.isPlaying());
      const p = playing && typeof tr.position === 'function' ? tr.position() : null;
      setText(barText, p ? String(p.bar + 1) : '-');
      setText(beatText, p ? `.${p.beat + 1}` : '');
      const d = new Date();
      const c = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (c !== lastClock) { lastClock = c; setText(clockText, c); }
    }
    if (reduced()) return;
    const q = live.queued();
    if (!q.length) return;
    for (const e of q) {
      if (typeof e.pad === 'number') padEls[e.pad].ring.set(live.progress(e.pad));
      else if (e.pad === 'song') nextRing.set(live.songProgress());
    }
  }));

  // -------------------------------------------------------- mount / exit
  const viewport = ctx.viewport || (ctx.root && ctx.root.querySelector('[data-viewport]'));
  const vpHome = viewport ? { parent: viewport.parentNode, next: viewport.nextSibling } : null;
  const hostHome = layers && layers.host ? { parent: layers.host.parentNode } : null;
  const appRoot = ctx.root || null;
  const prevFocus = document.activeElement;
  const prevInert = appRoot ? appRoot.inert : false;
  document.body.appendChild(root);
  if (viewport) backdrop.appendChild(viewport);
  if (layers && layers.host) { layers.host.dataset.liveSafe = ''; root.appendChild(layers.host); }
  if (appRoot) appRoot.inert = true;
  document.documentElement.classList.add('is-live');
  renderAll();
  renderSmartHint();
  root.focus({ preventScroll: true });
  const wake = createWakeLock();
  wake.acquire();
  let wasFull = false;
  enterFullscreen(root).then((ok) => { wasFull = ok; root.classList.toggle('is-fullscreen', ok); });
  const onFsChange = () => {
    const full = document.fullscreenElement === root;
    root.classList.toggle('is-fullscreen', full);
    // Esc in full screen is taken by the browser: leaving full screen leaves live mode.
    if (wasFull && !full) close();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  scope.add(() => document.removeEventListener('fullscreenchange', onFsChange));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    current = null;
    for (const i of heldKeys.values()) live.release(i);
    scope.dispose();
    wake.release();
    if (document.fullscreenElement === root) leaveFullscreen();
    if (viewport && vpHome && vpHome.parent) vpHome.parent.insertBefore(viewport, vpHome.next && vpHome.next.parentNode === vpHome.parent ? vpHome.next : null);
    if (layers && layers.host && hostHome && hostHome.parent) { delete layers.host.dataset.liveSafe; hostHome.parent.appendChild(layers.host); }
    if (appRoot) appRoot.inert = prevInert;
    document.documentElement.classList.remove('is-live');
    root.remove();
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true });
  }

  current = { close, root, controller: live, isOpen: () => !closed };
  return current;
}
