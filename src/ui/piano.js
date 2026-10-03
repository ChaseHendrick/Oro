// On-screen keyboard: scales to its width, velocity from where you strike a
// key (lower = louder), glissando by dragging, multi-touch, held notes shown
// from the router (including sequencer and arp notes), pitch bend and mod
// wheel strips, sustain, octave shift, and the computer keyboard:
//   A W S E D F T G Y H U J K O L P ; '   play (C to F an octave up)
//   Z / X  octave down / up,   C / V  velocity down / up
//   (C inserts a coin instead while Free Play is off, see coin-slot.js)

import { NOTE_NAMES, clamp } from '../core/params.js';
import { h, createScope, setText, isTypingTarget, call, has } from './dom.js';
import { schedule, addLoop } from './frame.js';
import { icon } from './icons.js';

export const QWERTY = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon', 'Quote'];
const QWERTY_LABEL = ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G', 'Y', 'H', 'U', 'J', 'K', 'O', 'L', 'P', ';', "'"];
const BLACK = new Set([1, 3, 6, 8, 10]);

/** MIDI note for a physical key code at a keyboard octave (C4 = 60 at octave 4), or null. */
export function qwertyNote(code, octave) {
  const i = QWERTY.indexOf(code);
  return i < 0 ? null : 12 * (octave + 1) + i;
}

export function isBlack(note) {
  return BLACK.has(((note % 12) + 12) % 12);
}

/** Velocity from the strike position on a key: 0 at the top edge, 1 at the bottom. */
export function velocityFromY(frac) {
  return clamp(0.3 + 0.7 * clamp(frac, 0, 1), 0.05, 1);
}

/** Key layout for a range [lo, hi]: positions in % of the keyboard width. */
export function layoutKeys(lo, hi) {
  const whites = [];
  for (let n = lo; n <= hi; n++) if (!isBlack(n)) whites.push(n);
  const ww = 100 / whites.length;
  const keys = [];
  let wi = 0;
  for (let n = lo; n <= hi; n++) {
    if (isBlack(n)) {
      const pc = ((n % 12) + 12) % 12;
      // Nudge black keys off-centre the way real keyboards do.
      const nudge = { 1: -0.12, 3: 0.12, 6: -0.15, 8: 0, 10: 0.15 }[pc];
      const bw = ww * 0.58;
      keys.push({ note: n, black: true, left: wi * ww - bw / 2 + nudge * bw, width: bw });
    } else {
      keys.push({ note: n, black: false, left: wi * ww, width: ww });
      wi++;
    }
  }
  return keys;
}

export function noteName(n) {
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

export function createPiano(ctx) {
  const scope = createScope();
  const { store, binder, music, engine } = ctx;
  const router = music && music.router;
  const canPlay = !!router || has(engine, 'noteOn');
  let velocity = 0.8;

  // ---- sound out
  function noteOn(note, vel, source) {
    if (router) call(router, 'noteOn', 'sel', note, vel, source);
    else if (engine) { call(engine, 'noteOn', binder.selected(), note, vel); localHeld(binder.selected(), note, vel, true); }
  }
  function noteOff(note, source) {
    if (router) call(router, 'noteOff', 'sel', note, source);
    else if (engine) { call(engine, 'noteOff', binder.selected(), note); localHeld(binder.selected(), note, 0, false); }
  }
  // Without the router there are no note events, so emit our own for the UI.
  function localHeld(part, note, vel, on) { if (ctx.notes) ctx.notes.emitLocal({ part, note, vel, on }); }
  function targets() {
    const r = router ? call(router, 'resolve', 'sel') : null;
    return Array.isArray(r) && r.length ? r : [binder.selected()];
  }

  // ---- DOM
  const keysEl = h('div', { class: 'pk-keys', role: 'group', 'aria-label': 'On-screen keyboard. The computer keys A to apostrophe play notes, Z and X change octave.' });
  const range = h('span', { class: 'pk-range' });
  const velEl = h('span', { class: 'pk-vel' });
  const octDown = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Octave down (Z)', dataset: { tip: 'Octave down (Z)' }, html: icon('chevron-left') });
  const octUp = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Octave up (X)', dataset: { tip: 'Octave up (X)' }, html: icon('chevron-right') });
  const sustainBtn = h('button', { type: 'button', class: 'toggle toggle--sm has-icon', 'aria-pressed': 'false', dataset: { tip: 'Sustain pedal for the keyboard' }, html: icon('hold') + '<span class="toggle-text">Sustain</span>' });
  const collapseBtn = h('button', { type: 'button', class: 'icon-btn icon-btn--sm pk-collapse', 'aria-label': 'Hide keyboard', 'aria-expanded': 'true', html: icon('chevron-down') });
  const bend = createStrip('Pitch bend', true);
  const wheel = createStrip('Mod wheel', false);

  const controls = h('div', { class: 'pk-controls' },
    h('div', { class: 'pk-octave' }, octDown, range, octUp),
    h('div', { class: 'pk-meta' }, velEl, sustainBtn));
  const el = h('div', { class: 'piano' },
    h('div', { class: 'pk-side' }, controls, h('div', { class: 'pk-strips' }, bend.el, wheel.el)),
    keysEl,
    collapseBtn);
  const bar = h('button', { type: 'button', class: 'pk-bar', 'aria-label': 'Show keyboard', html: icon('keyboard') + '<span>Keyboard</span><span class="pk-bar-hint">A W S E D F ... play notes</span>' });

  if (!canPlay) {
    el.classList.add('is-disabled');
    keysEl.dataset.tip = 'Playing needs the audio engine, which is not available here';
  }

  // ---- layout
  let keyEls = new Map();
  let lo = 48, hi = 84;
  function octavesFor(width) { return width < 520 ? 1 : width < 860 ? 2 : 3; }
  function build() {
    const oct = clamp(Math.round(store.get('ui.keyboardOctave') ?? 4), 1, 7);
    const span = octavesFor(keysEl.clientWidth || 1000);
    const startOct = span === 3 ? oct - 1 : oct;
    lo = 12 * (startOct + 1);
    hi = lo + 12 * span;
    keysEl.textContent = '';
    keyEls = new Map();
    const qBase = 12 * (oct + 1);
    for (const k of layoutKeys(lo, hi)) {
      const qi = k.note - qBase;
      const label = qi >= 0 && qi < QWERTY_LABEL.length ? QWERTY_LABEL[qi] : '';
      const key = h('div', {
        class: ['pk', k.black ? 'pk--black' : 'pk--white', k.note % 12 === 0 && 'pk--c'],
        style: { left: k.left.toFixed(4) + '%', width: k.width.toFixed(4) + '%' },
        dataset: { note: String(k.note) },
      },
      k.note % 12 === 0 ? h('span', { class: 'pk-name' }, noteName(k.note)) : null,
      label ? h('span', { class: 'pk-q' }, label) : null);
      keyEls.set(k.note, key);
      keysEl.appendChild(key);
    }
    setText(range, `${noteName(lo)}-${noteName(hi)}`);
    paintHeld();
  }
  function renderVel() { setText(velEl, `Vel ${Math.round(velocity * 100)}`); velEl.dataset.tip = 'Keyboard velocity (C / V)'; }

  // ---- held notes
  const held = new Map(); // note -> Set(part)
  function paintHeld() {
    const selPart = binder.selected();
    const layer = (store.get('global.keyMode') || 0) === 1;
    for (const [note, key] of keyEls) {
      const parts = held.get(note);
      const on = !!parts && parts.size > 0 && (layer || parts.has(selPart));
      key.classList.toggle('is-down', on);
    }
  }
  if (ctx.notes) {
    scope.add(ctx.notes.on(({ part, note, on }) => {
      const n = Math.round(note);
      let set = held.get(n);
      if (on) { if (!set) held.set(n, set = new Set()); set.add(part); }
      else if (set) { set.delete(part); if (!set.size) held.delete(n); }
      // One class on one key: cheap enough to apply straight away, so the
      // key lights the instant the note starts.
      const key = keyEls.get(n);
      if (key) {
        const layer = (store.get('global.keyMode') || 0) === 1;
        const cur = held.get(n);
        key.classList.toggle('is-down', !!cur && cur.size > 0 && (layer || cur.has(binder.selected())));
      }
    }));
  }

  // ---- pointer playing
  const pointers = new Map(); // pointerId -> note
  function keyAt(x, y) {
    const t = document.elementFromPoint(x, y);
    const k = t && t.closest ? t.closest('.pk') : null;
    return k && keysEl.contains(k) ? k : null;
  }
  function strike(pid, key, e) {
    const note = +key.dataset.note;
    const r = key.getBoundingClientRect();
    const vel = velocityFromY((e.clientY - r.top) / r.height);
    pointers.set(pid, note);
    key.classList.add('is-pressed');
    noteOn(note, vel, 'ui');
  }
  function release(pid) {
    const note = pointers.get(pid);
    if (note == null) return;
    pointers.delete(pid);
    const key = keyEls.get(note);
    if (key && ![...pointers.values()].includes(note)) key.classList.remove('is-pressed');
    if (![...pointers.values()].includes(note)) noteOff(note, 'ui');
  }
  scope.on(keysEl, 'pointerdown', (e) => {
    if (!canPlay || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const key = keyAt(e.clientX, e.clientY);
    if (!key) return;
    e.preventDefault();
    try { keysEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    strike(e.pointerId, key, e);
  });
  scope.on(keysEl, 'pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const key = keyAt(e.clientX, e.clientY);
    if (!key) return;
    if (+key.dataset.note !== pointers.get(e.pointerId)) { release(e.pointerId); strike(e.pointerId, key, e); }
  });
  const up = (e) => release(e.pointerId);
  scope.on(keysEl, 'pointerup', up);
  scope.on(keysEl, 'pointercancel', up);
  scope.on(keysEl, 'lostpointercapture', up);
  scope.on(keysEl, 'contextmenu', (e) => e.preventDefault());

  // ---- computer keyboard
  const qHeld = new Map(); // code -> note
  function onKeyDown(e) {
    // Shift is left for shortcuts (Shift+P previews); the keyboard never needs it.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (isTypingTarget(e.target)) return;
    if (ctx.layers && ctx.layers.hasModal()) return;
    const code = e.code;
    if (code === 'KeyZ' || code === 'KeyX') {
      e.preventDefault();
      if (!e.repeat) shiftOctave(code === 'KeyZ' ? -1 : 1);
      return;
    }
    // v2.9 with Free Play off, C inserts a coin (src/ui/coin-slot.js) instead of lowering the velocity
    if (code === 'KeyC' && ctx.coins && ctx.coins.coinKey()) {
      e.preventDefault();
      if (!e.repeat) ctx.coins.insert();
      return;
    }
    if (code === 'KeyC' || code === 'KeyV') {
      e.preventDefault();
      velocity = clamp(Math.round((velocity + (code === 'KeyV' ? 0.1 : -0.1)) * 10) / 10, 0.1, 1);
      renderVel();
      ctx.announce?.(`Keyboard velocity ${Math.round(velocity * 100)}`);
      return;
    }
    const note = qwertyNote(code, clamp(Math.round(store.get('ui.keyboardOctave') ?? 4), 1, 7));
    if (note == null || !canPlay) return;
    e.preventDefault();
    if (e.repeat || qHeld.has(code)) return;
    qHeld.set(code, note);
    keyEls.get(note)?.classList.add('is-pressed');
    noteOn(note, velocity, 'qwerty');
  }
  function onKeyUp(e) {
    const note = qHeld.get(e.code);
    if (note == null) return;
    qHeld.delete(e.code);
    keyEls.get(note)?.classList.remove('is-pressed');
    noteOff(note, 'qwerty');
  }
  function releaseAll() {
    for (const [code, note] of qHeld) { noteOff(note, 'qwerty'); keyEls.get(note)?.classList.remove('is-pressed'); qHeld.delete(code); }
    for (const pid of [...pointers.keys()]) release(pid);
  }
  scope.on(document, 'keydown', onKeyDown);
  scope.on(document, 'keyup', onKeyUp);
  scope.on(window, 'blur', releaseAll);
  scope.on(document, 'visibilitychange', () => { if (document.hidden) releaseAll(); });
  scope.add(releaseAll);

  function shiftOctave(d) {
    const cur = clamp(Math.round(store.get('ui.keyboardOctave') ?? 4), 1, 7);
    const next = clamp(cur + d, 1, 7);
    if (next === cur) return;
    // Let go of computer-keyboard notes first so none get stuck.
    for (const [code, note] of qHeld) { noteOff(note, 'qwerty'); qHeld.delete(code); }
    store.set('ui.keyboardOctave', next, { source: 'ui' });
  }
  scope.on(octDown, 'click', () => shiftOctave(-1));
  scope.on(octUp, 'click', () => shiftOctave(1));
  scope.add(store.subscribe('ui.keyboardOctave', () => schedule(build)));
  scope.add(store.subscribe('ui.selectedPart', () => schedule(paintHeld)));
  scope.add(store.subscribe('global.keyMode', () => schedule(paintHeld)));

  // ---- sustain
  let sustainOn = false;
  scope.on(sustainBtn, 'click', () => {
    sustainOn = !sustainOn;
    sustainBtn.setAttribute('aria-pressed', String(sustainOn));
    sustainBtn.classList.toggle('is-on', sustainOn);
    if (router) call(router, 'sustain', 'sel', sustainOn);
  });
  if (!router) { sustainBtn.disabled = true; sustainBtn.dataset.tip = 'Sustain needs the music engine'; }

  // ---- bend + wheel strips
  function createStrip(label, spring) {
    const thumb = h('span', { class: 'pk-strip-thumb' });
    const strip = h('div', {
      class: ['pk-strip', spring && 'is-bend'], role: 'slider', tabindex: '0', 'aria-label': label,
      'aria-valuemin': spring ? '-1' : '0', 'aria-valuemax': '1', 'aria-valuenow': '0', dataset: { tip: spring ? 'Pitch bend: drag up or down, springs back' : 'Mod wheel: adds movement to Morph' },
    }, h('span', { class: 'pk-strip-track' }), thumb);
    let value = 0, target = 0, dragging = null, anim = null;
    const send = (v) => {
      for (const p of targets()) {
        if (spring) call(engine, 'bend', p, v); else call(engine, 'wheel', p, v);
      }
    };
    const paint = () => {
      const pos = spring ? (value + 1) / 2 : value;
      thumb.style.bottom = `calc(${(pos * 100).toFixed(2)}% - ${(pos * 10).toFixed(2)}px)`;
      strip.setAttribute('aria-valuenow', value.toFixed(2));
    };
    const set = (v) => { value = clamp(v, spring ? -1 : 0, 1); paint(); send(value); };
    const fromEvent = (e) => {
      const r = strip.getBoundingClientRect();
      const n = clamp((r.bottom - e.clientY) / r.height, 0, 1);
      return spring ? n * 2 - 1 : n;
    };
    scope.on(strip, 'pointerdown', (e) => {
      if (!has(engine, spring ? 'bend' : 'wheel')) return;
      e.preventDefault();
      strip.focus({ preventScroll: true });
      dragging = e.pointerId;
      if (anim) { anim(); anim = null; }
      try { strip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      set(fromEvent(e));
    });
    scope.on(strip, 'pointermove', (e) => { if (dragging === e.pointerId) set(fromEvent(e)); });
    const end = () => {
      if (dragging == null) return;
      dragging = null;
      if (spring) {
        target = 0;
        anim = addLoop(() => {
          const v = value + (target - value) * 0.35;
          set(Math.abs(v) < 0.01 ? 0 : v);
          if (value === 0 && anim) { anim(); anim = null; }
        });
      }
    };
    scope.on(strip, 'pointerup', end);
    scope.on(strip, 'pointercancel', end);
    scope.on(strip, 'keydown', (e) => {
      const map = { ArrowUp: 0.1, ArrowRight: 0.1, ArrowDown: -0.1, ArrowLeft: -0.1 };
      if (e.key in map) { e.preventDefault(); e.stopPropagation(); set(value + map[e.key]); }
      else if (e.key === 'Home' || e.key === 'Delete') { e.preventDefault(); set(spring ? 0 : 0); }
    });
    scope.on(strip, 'keyup', (e) => { if (spring && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) set(0); });
    scope.add(() => { if (anim) anim(); });
    if (!has(engine, spring ? 'bend' : 'wheel')) { strip.setAttribute('aria-disabled', 'true'); strip.classList.add('is-disabled'); }
    paint();
    return { el: strip };
  }

  // ---- collapse
  function renderOpen() {
    const open = !!ctx.prefs.get('keysOpen');
    ctx.root.classList.toggle('keys-closed', !open);
    collapseBtn.setAttribute('aria-expanded', String(open));
    if (open) schedule(build);
  }
  scope.on(collapseBtn, 'click', () => { releaseAll(); ctx.prefs.set('keysOpen', 0); bar.focus(); });
  scope.on(bar, 'click', () => { ctx.prefs.set('keysOpen', 1); collapseBtn.focus(); });
  scope.add(ctx.prefs.on((k) => { if (k === 'keysOpen') renderOpen(); }));

  if (typeof ResizeObserver !== 'undefined') {
    let lastSpan = 0;
    const ro = new ResizeObserver(() => {
      const span = octavesFor(keysEl.clientWidth || 1000);
      if (span !== lastSpan) { lastSpan = span; schedule(build); }
    });
    ro.observe(keysEl);
    scope.add(() => ro.disconnect());
  }

  renderVel();
  build();
  renderOpen();
  return { el, bar, releaseAll, dispose: scope.dispose };
}
