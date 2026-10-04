// Game controllers and haptics (2.11): the browser side. Loaded only when the
// person turns controllers or phone pulses on (src/ui/gamepad-boot.js), so it
// adds nothing to startup otherwise.
//
// Polling runs on the shared animation frame only while controllers are on
// and a pad is connected, reads the pad into preallocated arrays (no
// allocation per frame) and acts on the mapped inputs: the left stick moves
// the dot, the right stick feeds the Pad Stick X/Y Link sources, triggers and
// face buttons play notes (or drum pads), the D-pad changes octave and track,
// Start plays or stops. In Golf the stick aims and a trigger charges the shot.
//
// Haptics follow the bass: a short rumble on notes of the lowest playing track
// or drum kit pad 1, a bump when a golf ball is hit and when it drops. Phones
// can pulse on the beat (navigator.vibrate), off by default, never with
// reduced motion, and never while the tab is hidden.

import { addLoop } from './frame.js';
import { prefersReducedMotion } from './dom.js';
import { found } from '../core/fun.js';
import { golfActive, golfPad } from './golf.js';
import {
  loadPadPrefs, savePadPrefs, createPadReader, stickResponse, deadzone1, moveDot, triggerHeld, triggerVelocity,
  actionNotes, rumbleEffect, createBassFollower, isKickNote, beatPulse, NOTE_ACTIONS, OCTAVE_MIN, OCTAVE_MAX,
} from '../core/gamepad.js';

const META = Object.freeze({ source: 'gamepad' });
const SEND_EPS = 0.004;
const TRIGGERS = Object.freeze(['root', 'chord']);
const FACE = Object.freeze(['note1', 'note2', 'note3', 'note4']);

/** Feature checks, for the Settings pane. */
export function padSupport(nav = globalThis.navigator) {
  return {
    gamepads: !!nav && typeof nav.getGamepads === 'function',
    vibrate: !!nav && typeof nav.vibrate === 'function',
  };
}
export const canRumble = (pad) => !!(pad && pad.vibrationActuator && typeof pad.vibrationActuator.playEffect === 'function');

/** Connected pads (a plain list without the browser's empty slots). */
export function listPads(nav = globalThis.navigator) {
  if (!nav || typeof nav.getGamepads !== 'function') return [];
  let raw = [];
  try { raw = nav.getGamepads() || []; } catch { return []; }
  const out = [];
  for (let i = 0; i < raw.length; i++) if (raw[i] && raw[i].connected !== false) out.push(raw[i]);
  return out;
}

let host = null;

/** The one controller host for the app (created on first use). */
export function startPadHost(ctx, env = {}) {
  if (host) return host;
  host = createPadHost(ctx, env);
  return host;
}
export function padHost() { return host; }

export function createPadHost(ctx, { nav = globalThis.navigator, win = globalThis.window, doc = globalThis.document, now = () => performance.now(), loop = addLoop, reducedMotion = prefersReducedMotion } = {}) {
  const { store } = ctx;
  let prefs = loadPadPrefs();
  const reader = createPadReader();
  const stick = { x: 0, y: 0 }, dot = { x: 0, y: 0 };
  const follower = createBassFollower(16);
  const subs = new Set();
  let offLoop = null, last = 0, octave = 0, assigning = null, pad = null, usedOnce = false;
  let sentX = 0, sentY = 0, sentAny = false;
  // per note action: the part it started on and its notes (released on button up)
  const held = {};
  for (const id of NOTE_ACTIONS) held[id] = { on: false, pending: false, part: -1, n: 0, notes: new Int16Array(3) };
  const trig = { root: false, chord: false };
  let golfCharging = false;
  let cxPath = '', cyPath = '', pathPart = -1;

  const notify = () => { for (const fn of subs) { try { fn(); } catch { /* ignore */ } } };
  const router = () => (ctx.music && ctx.music.router) || null;
  const selPart = () => Math.max(0, Math.round(Number(store.get('ui.selectedPart')) || 0));
  const partCount = () => (Array.isArray(store.get('parts')) ? store.get('parts').length : 1);
  const isDrum = (p) => !!store.get(`parts.${p}.drum.on`);

  function connected() { return listPads(nav).length > 0; }

  function update() {
    const want = prefs.on && connected();
    if (want && !offLoop) { last = now(); reader.reset(); offLoop = loop(frame); }
    else if (!want && offLoop) { offLoop(); offLoop = null; releaseAll(); }
    notify();
  }

  function pickPad() {
    if (!nav || typeof nav.getGamepads !== 'function') return null;
    let list;
    try { list = nav.getGamepads(); } catch { return null; }
    if (!list) return null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].connected !== false) return list[i];
    return null;
  }

  // ------------------------------------------------------------ notes
  const keyOpts = { drum: false, root: 0, scaleType: 0, octave: 0, shift: false };
  function startNote(id, vel) {
    const r = router(), slot = held[id];
    if (!r || typeof r.noteOn !== 'function' || slot.on) return;
    const part = selPart();
    keyOpts.drum = isDrum(part);
    keyOpts.root = Math.round(Number(store.get('global.scaleRoot')) || 0);
    keyOpts.scaleType = Math.round(Number(store.get('global.scaleType')) || 0);
    keyOpts.octave = octave;
    keyOpts.shift = reader.down(prefs.map.shift);
    slot.n = actionNotes(id, keyOpts, slot.notes);
    slot.part = part; slot.on = true;
    for (let i = 0; i < slot.n; i++) { try { r.noteOn(part, slot.notes[i], vel, 'gamepad'); } catch { /* gone */ } }
  }
  function stopNote(id) {
    const r = router(), slot = held[id];
    if (!slot.on) return;
    slot.on = false; slot.pending = false;
    if (!r || typeof r.noteOff !== 'function') return;
    for (let i = 0; i < slot.n; i++) { try { r.noteOff(slot.part, slot.notes[i], 'gamepad'); } catch { /* gone */ } }
  }
  function releaseAll() {
    for (const id of NOTE_ACTIONS) stopNote(id);
    trig.root = trig.chord = false;
    if (golfCharging) { golfCharging = false; golfPad()?.charge(false); }
  }

  // ------------------------------------------------------------ the frame
  function frame() {
    const t = now();
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    pad = pickPad();
    if (!pad) { releaseAll(); return; }
    reader.read(pad);
    if (assigning) return;               // the Settings pane is listening for a new input
    const m = prefs.map, dz = prefs.deadzone;

    // right stick: the two Link sources (sent only when they move)
    const lx = deadzone1(reader.axis(m.linkX), dz), ly = -deadzone1(reader.axis(m.linkY), dz);   // up is +1
    if (!sentAny || Math.abs(lx - sentX) > SEND_EPS || Math.abs(ly - sentY) > SEND_EPS) {
      if (sentAny || lx !== 0 || ly !== 0) { ctx.engine?.setPadStick?.(lx, ly); sentX = lx; sentY = ly; sentAny = true; used(); }
    }

    const game = golfActive() ? golfPad() : null;
    if (game) {
      releaseNotesOnly();
      game.turn(reader.axis(m.dotX), dt, dz);
      const tv = Math.max(reader.button(m.root), reader.button(m.chord));
      const down = triggerHeld(golfCharging, tv);
      if (down !== golfCharging) { golfCharging = down; game.charge(down); used(); }
      if (reader.pressed(m.note1)) { game.primary(); used(); }
      if (reader.pressed(m.note2)) { game.quit(); used(); }
      return;
    }
    if (golfCharging) golfCharging = false;

    // left stick: the dot (relative velocity)
    stickResponse(reader.axis(m.dotX), reader.axis(m.dotY), dz, stick);
    if (stick.x !== 0 || stick.y !== 0) {
      const p = selPart();
      if (p !== pathPart) { pathPart = p; cxPath = `parts.${p}.params.centerX`; cyPath = `parts.${p}.params.centerY`; }
      const cx = Number(store.get(cxPath)), cy = Number(store.get(cyPath));
      moveDot(Number.isFinite(cx) ? cx : 0.5, Number.isFinite(cy) ? cy : 0.5, stick.x, stick.y, prefs.speed, dt, dot);
      store.batch(() => { store.set(cxPath, dot.x, META); store.set(cyPath, dot.y, META); });
      used();
    }

    // triggers: analog notes. The velocity is read one frame after the trigger
    // passes the threshold, so a fast pull plays louder than a slow squeeze.
    for (let k = 0; k < 2; k++) {
      const id = TRIGGERS[k];
      const v = reader.button(m[id]), slot = held[id];
      const down = triggerHeld(trig[id], v);
      if (down && !trig[id]) { trig[id] = true; slot.pending = true; }
      else if (down && slot.pending) { slot.pending = false; startNote(id, triggerVelocity(v)); used(); }
      else if (!down && trig[id]) { trig[id] = false; if (slot.pending) { slot.pending = false; startNote(id, triggerVelocity(v)); } stopNote(id); }
    }
    // face buttons
    for (let k = 0; k < 4; k++) {
      const id = FACE[k];
      if (reader.pressed(m[id])) { startNote(id, 0.8); used(); }
      else if (reader.released(m[id])) stopNote(id);
    }
    // D-pad: octave and track
    if (reader.pressed(m.octUp)) { octave = Math.min(OCTAVE_MAX, octave + 1); announce(`Octave ${octave >= 0 ? '+' : ''}${octave}`); used(); }
    if (reader.pressed(m.octDown)) { octave = Math.max(OCTAVE_MIN, octave - 1); announce(`Octave ${octave >= 0 ? '+' : ''}${octave}`); used(); }
    const step = reader.pressed(m.nextTrack) ? 1 : reader.pressed(m.prevTrack) ? -1 : 0;
    if (step) {
      const n = partCount();
      store.set('ui.selectedPart', (selPart() + step + n) % n, { source: 'ui' });
      used();
    }
    if (reader.pressed(m.transport)) { if (typeof ctx.togglePlay === 'function') ctx.togglePlay(); else ctx.music?.transport?.toggle?.(); used(); }
  }
  function releaseNotesOnly() { for (const id of NOTE_ACTIONS) stopNote(id); trig.root = trig.chord = false; }
  function announce(text) { try { ctx.announce?.(text); } catch { /* ignore */ } }
  function used() { if (!usedOnce) { usedOnce = true; found('badge', 'gamepad'); } }

  // ------------------------------------------------------------ haptics
  function rumble(kind, amount) {
    if (!prefs.on || !prefs.rumble) return false;
    const p = pad || pickPad();
    if (!canRumble(p)) return false;
    const fx = rumbleEffect(kind, amount, prefs.rumbleAmount);
    if (!fx) return false;
    try { const r = p.vibrationActuator.playEffect('dual-rumble', fx); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { return false; }
    return true;
  }
  const offNotes = ctx.notes && typeof ctx.notes.on === 'function' ? ctx.notes.on((ev) => {
    if (!ev || !ev.on || !prefs.on || !prefs.rumble || !offLoop) return;
    if (doc && doc.visibilityState === 'hidden') return;
    const drum = isDrum(ev.part);
    if (drum && !isKickNote(ev.note)) return;
    if (follower.note(ev.part, ev.note, drum, now())) rumble('note', Number.isFinite(ev.vel) ? ev.vel : 0.8);
  }) : null;
  const offGolf = ctx.bus && typeof ctx.bus.on === 'function' ? ctx.bus.on('golf', (e) => {
    if (e && e.type === 'shoot') rumble('impact', e.power);
    else if (e && e.type === 'sink') rumble('sink', 1);
  }) : null;

  // Phones: a short pulse on each beat while the transport plays.
  let offBeat = null, prevBeat = NaN;
  function beatFrame() {
    const tr = ctx.music && ctx.music.transport, ac = ctx.engine && ctx.engine.context;
    if (!tr || !ac || !tr.isPlaying?.() || (doc && doc.visibilityState === 'hidden') || reducedMotion()) { prevBeat = NaN; return; }
    const beat = tr.beatAt(ac.currentTime);
    const ms = beatPulse(prevBeat, beat);
    prevBeat = beat;
    if (ms > 0) { try { nav.vibrate(ms); } catch { /* ignore */ } }
  }
  function updateBeat() {
    const want = prefs.beat && typeof nav?.vibrate === 'function';
    if (want && !offBeat) { prevBeat = NaN; offBeat = loop(beatFrame); }
    else if (!want && offBeat) { offBeat(); offBeat = null; }
  }
  const onHidden = () => {
    if (doc && doc.visibilityState === 'hidden') { releaseAll(); try { nav?.vibrate?.(0); } catch { /* ignore */ } }
  };

  // ------------------------------------------------------------ events
  const onPads = () => update();
  win?.addEventListener?.('gamepadconnected', onPads);
  win?.addEventListener?.('gamepaddisconnected', onPads);
  doc?.addEventListener?.('visibilitychange', onHidden);
  update();
  updateBeat();

  const api = {
    get prefs() { return prefs; },
    get running() { return !!offLoop; },
    get octave() { return octave; },
    /** Change and save settings (only on this computer). */
    setPrefs(patch) {
      prefs = savePadPrefs({ ...prefs, ...patch, map: { ...prefs.map, ...(patch && patch.map) } });
      if (!prefs.on && sentAny) { ctx.engine?.setPadStick?.(0, 0); sentX = sentY = 0; }
      update(); updateBeat();
      return prefs;
    },
    pads: () => listPads(nav),
    /** While the Settings pane waits for "press a button", inputs do nothing. */
    setAssigning(v) { assigning = v || null; if (assigning) releaseAll(); },
    rumble, rescan: update,
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    _frame: frame, _beatFrame: beatFrame,
    dispose() {
      releaseAll();
      if (offLoop) { offLoop(); offLoop = null; }
      if (offBeat) { offBeat(); offBeat = null; }
      offNotes?.(); offGolf?.();
      win?.removeEventListener?.('gamepadconnected', onPads);
      win?.removeEventListener?.('gamepaddisconnected', onPads);
      doc?.removeEventListener?.('visibilitychange', onHidden);
      if (host === api) host = null;
    },
  };
  return api;
}
