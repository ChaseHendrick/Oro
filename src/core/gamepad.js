// Game controllers and haptics (2.12): the pure part. Mapping, deadzones and
// response curves, which note an action plays, golf aiming, rumble effects and
// the beat / bass pulse timing all live here so they are tested in Node; the
// browser side (polling, the dot, notes, golf and rumble) is
// src/ui/gamepad-host.js and the Settings pane is src/ui/settings-controllers.js.
//
// The defaults follow the browser's "standard" gamepad layout
// (https://w3c.github.io/gamepad/#remapping): buttons 0 A (bottom), 1 B (right),
// 2 X (left), 3 Y (top), 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 10 and 11
// the stick clicks, 12 to 15 the D-pad (up, down, left, right); axes 0 and 1
// the left stick, 2 and 3 the right stick (down and right are positive).
//
// Triggers are notes, not Link sources: the left trigger plays the root of the
// key and the right trigger a triad on it, with the velocity from how far the
// trigger is pulled. The right stick is the two Link sources (Pad Stick X/Y).

import { stepToMidi } from './params.js';

import { PAD_PREFS_KEY } from './gamepad-key.js';
export { PAD_PREFS_KEY };
export const MAX_BUTTONS = 32;
export const MAX_AXES = 8;

/** Every assignable action: kind 'axis' reads an axis, 'button' a button. */
export const PAD_ACTIONS = Object.freeze([
  { id: 'dotX', label: 'Move the dot left and right', kind: 'axis', def: 0 },
  { id: 'dotY', label: 'Move the dot up and down', kind: 'axis', def: 1 },
  { id: 'linkX', label: 'Pad Stick X (Link source)', kind: 'axis', def: 2 },
  { id: 'linkY', label: 'Pad Stick Y (Link source)', kind: 'axis', def: 3 },
  { id: 'root', label: 'Root note (or pad 1 on a drum kit)', kind: 'button', def: 6 },
  { id: 'chord', label: 'Chord on the root (or pad 2)', kind: 'button', def: 7 },
  { id: 'note1', label: 'Note 1 of the scale (golf: tee or next hole)', kind: 'button', def: 0 },
  { id: 'note2', label: 'Note 2 of the scale (golf: quit)', kind: 'button', def: 1 },
  { id: 'note3', label: 'Note 3 of the scale', kind: 'button', def: 2 },
  { id: 'note4', label: 'Note 4 of the scale', kind: 'button', def: 3 },
  { id: 'shift', label: 'Hold for notes 5 to 8 (or pads 5 to 8)', kind: 'button', def: 4 },
  { id: 'octUp', label: 'Octave up', kind: 'button', def: 12 },
  { id: 'octDown', label: 'Octave down', kind: 'button', def: 13 },
  { id: 'prevTrack', label: 'Previous track', kind: 'button', def: 14 },
  { id: 'nextTrack', label: 'Next track', kind: 'button', def: 15 },
  { id: 'transport', label: 'Play or stop', kind: 'button', def: 9 },
].map(Object.freeze));
export const PAD_ACTION_MAP = Object.freeze(Object.fromEntries(PAD_ACTIONS.map(a => [a.id, a])));
export const NOTE_ACTIONS = Object.freeze(['root', 'chord', 'note1', 'note2', 'note3', 'note4']);

export const BUTTON_NAMES = Object.freeze(['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'Left stick click', 'Right stick click', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home']);
export const AXIS_NAMES = Object.freeze(['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y']);

/** Readable name of an input in the standard layout. */
export function inputName(kind, index) {
  if (!(index >= 0)) return 'Not set';
  if (kind === 'axis') return AXIS_NAMES[index] || `Axis ${index + 1}`;
  return BUTTON_NAMES[index] || `Button ${index + 1}`;
}

export const OCTAVE_MIN = -3, OCTAVE_MAX = 3;
export const BASE_OCTAVE = 4;            // octave 0 puts the root at middle C's octave
export const DRUM_FIRST_NOTE = 36;       // pads 1..8 are MIDI notes 36..43 (src/dsp/drum-kit.js)
export const TRIGGER_ON = 0.12, TRIGGER_OFF = 0.06;
export const GOLF_TURN = 1.6;            // radians per second at full stick
export const GOLF_CHARGE_MS = 1300;      // the same charge time as holding Space

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function defaultPadPrefs() {
  const map = {};
  for (const a of PAD_ACTIONS) map[a.id] = a.def;
  return {
    on: false,           // controllers (off by default)
    speed: 0.5,          // the dot's speed at full stick, map widths per second
    deadzone: 0.15,
    rumble: false,       // controller rumble following the bass or kick
    rumbleAmount: 0.6,
    beat: false,         // phone pulses on the beat
    map,
  };
}

export function sanitizePadPrefs(p) {
  const d = defaultPadPrefs();
  if (!p || typeof p !== 'object') return d;
  const map = { ...d.map };
  if (p.map && typeof p.map === 'object') {
    for (const a of PAD_ACTIONS) {
      const v = Math.round(num(p.map[a.id], NaN));
      if (v === -1) map[a.id] = -1;
      else if (v >= 0 && v < (a.kind === 'axis' ? MAX_AXES : MAX_BUTTONS)) map[a.id] = v;
    }
  }
  return {
    on: !!p.on,
    speed: clamp(num(p.speed, d.speed), 0.05, 2),
    deadzone: clamp(num(p.deadzone, d.deadzone), 0, 0.6),
    rumble: !!p.rumble,
    rumbleAmount: clamp(num(p.rumbleAmount, d.rumbleAmount), 0, 1),
    beat: !!p.beat,
    map,
  };
}

const local = () => { try { return globalThis.localStorage || null; } catch { return null; } };

/** This computer's controller settings (never in the session). */
export function loadPadPrefs(storage = local()) {
  try { return sanitizePadPrefs(JSON.parse(storage?.getItem(PAD_PREFS_KEY) || 'null')); } catch { return defaultPadPrefs(); }
}
export function savePadPrefs(prefs, storage = local()) {
  const clean = sanitizePadPrefs(prefs);
  try { storage?.setItem(PAD_PREFS_KEY, JSON.stringify(clean)); } catch { /* private mode or full */ }
  return clean;
}

// ---------------------------------------------------------------- sticks

/** One axis with a deadzone, rescaled so the edge of the deadzone is 0 and full travel is 1. */
export function deadzone1(v, dz) {
  const x = num(v, 0), a = Math.abs(x);
  if (a <= dz) return 0;
  return Math.sign(x) * Math.min(1, (a - dz) / (1 - dz));
}

/**
 * A stick with a round deadzone and a squared response (fine control near the
 * middle, full speed at the edge). Writes { x, y } into `out` (no allocation).
 */
export function stickResponse(x, y, dz, out) {
  const sx = num(x, 0), sy = num(y, 0);
  const m = Math.hypot(sx, sy);
  if (m <= dz || m === 0) { out.x = 0; out.y = 0; return out; }
  const r = Math.min(1, (m - dz) / (1 - dz));
  const k = (r * r) / m;
  out.x = sx * k; out.y = sy * k;
  return out;
}

/** The dot after `dt` seconds of stick velocity (sx, sy already shaped); stays on the map. */
export function moveDot(cx, cy, sx, sy, speed, dt, out) {
  out.x = clamp(cx + sx * speed * dt, 0, 1);
  out.y = clamp(cy + sy * speed * dt, 0, 1);
  return out;
}

/** Note velocity from how far an analog trigger is pulled. */
export function triggerVelocity(v) {
  return clamp(0.2 + 0.8 * num(v, 0), 0.05, 1);
}

/** Hysteresis for an analog trigger as a note: returns the new held state. */
export function triggerHeld(wasHeld, v) {
  return wasHeld ? v > TRIGGER_OFF : v >= TRIGGER_ON;
}

// ---------------------------------------------------------------- notes

const NOTE_DEGREE = { note1: 0, note2: 1, note3: 2, note4: 3 };

/**
 * MIDI notes an action plays, written into `out` (an Int16Array of 3);
 * returns how many. Drum kits play pads (36..43), others the key and scale.
 */
export function actionNotes(action, { drum = false, root = 0, scaleType = 0, octave = 0, shift = false } = {}, out) {
  if (drum) {
    let pad = -1;
    if (action === 'root') pad = 0;
    else if (action === 'chord') pad = 1;
    else if (action in NOTE_DEGREE) pad = NOTE_DEGREE[action] + (shift ? 4 : 0);
    if (pad < 0) return 0;
    out[0] = DRUM_FIRST_NOTE + pad;
    return 1;
  }
  const base = BASE_OCTAVE + clamp(Math.round(octave), OCTAVE_MIN, OCTAVE_MAX);
  const step = { degree: 0, octave: 0 };
  let n = 0;
  const put = (degree) => { step.degree = degree; const m = stepToMidi(step, base, root, scaleType); if (m >= 0 && m <= 127) out[n++] = m; };
  if (action === 'root') put(0);
  else if (action === 'chord') { put(0); put(2); put(4); }
  else if (action in NOTE_DEGREE) put(NOTE_DEGREE[action] + (shift ? 4 : 0));
  return n;
}

// ---------------------------------------------------------------- input edges

/** Button and axis state between frames, with no allocation per frame. */
export function createPadReader() {
  const prev = new Uint8Array(MAX_BUTTONS), cur = new Uint8Array(MAX_BUTTONS), value = new Float32Array(MAX_BUTTONS);
  const axes = new Float32Array(MAX_AXES);
  return {
    cur, value, axes,
    /** Read a Gamepad (or a plain object shaped like one). */
    read(pad) {
      prev.set(cur);
      const b = (pad && pad.buttons) || [], a = (pad && pad.axes) || [];
      for (let i = 0; i < MAX_BUTTONS; i++) {
        const btn = b[i];
        const v = btn == null ? 0 : typeof btn === 'number' ? btn : num(btn.value, btn.pressed ? 1 : 0);
        value[i] = v;
        cur[i] = (btn && btn.pressed) || v >= 0.5 ? 1 : 0;
      }
      for (let i = 0; i < MAX_AXES; i++) axes[i] = num(a[i], 0);
    },
    pressed: (i) => i >= 0 && i < MAX_BUTTONS && cur[i] === 1 && prev[i] === 0,
    released: (i) => i >= 0 && i < MAX_BUTTONS && cur[i] === 0 && prev[i] === 1,
    down: (i) => i >= 0 && i < MAX_BUTTONS && cur[i] === 1,
    axis: (i) => (i >= 0 && i < MAX_AXES ? axes[i] : 0),
    button: (i) => (i >= 0 && i < MAX_BUTTONS ? value[i] : 0),
    reset() { prev.fill(0); cur.fill(0); value.fill(0); axes.fill(0); },
  };
}

/**
 * "Press a button to assign": the input that moved since `base` (a snapshot
 * of { buttons: number[], axes: number[] } values), or null.
 */
export function detectAssign(pad, base, kind) {
  if (!pad) return null;
  if (kind === 'axis') {
    const a = pad.axes || [];
    let best = -1, bestV = 0.6;
    for (let i = 0; i < Math.min(a.length, MAX_AXES); i++) {
      const d = Math.abs(num(a[i], 0) - num(base?.axes?.[i], 0));
      if (d > bestV) { best = i; bestV = d; }
    }
    return best >= 0 ? best : null;
  }
  const b = pad.buttons || [];
  for (let i = 0; i < Math.min(b.length, MAX_BUTTONS); i++) {
    const v = typeof b[i] === 'number' ? b[i] : num(b[i]?.value, b[i]?.pressed ? 1 : 0);
    if (v >= 0.5 && num(base?.buttons?.[i], 0) < 0.5) return i;
  }
  return null;
}

/** A plain snapshot of a pad's values, for detectAssign. */
export function padSnapshot(pad) {
  return {
    buttons: Array.from((pad && pad.buttons) || [], b => (typeof b === 'number' ? b : num(b?.value, b?.pressed ? 1 : 0))),
    axes: Array.from((pad && pad.axes) || [], v => num(v, 0)),
  };
}

// ---------------------------------------------------------------- golf

/** Turn the aim with a stick axis: radians after `dt` seconds. */
export function golfTurn(angle, x, dt, dz = 0.15) {
  const v = deadzone1(x, dz);
  return angle + Math.sign(v) * v * v * GOLF_TURN * dt;
}

/** Power (0..1) after holding the charge for `ms`. */
export function golfPower(ms) {
  return clamp(num(ms, 0) / GOLF_CHARGE_MS, 0, 1);
}

// ---------------------------------------------------------------- haptics

/**
 * A 'dual-rumble' effect for a note ('note', vel 0..1), a golf shot
 * ('impact', power 0..1) or a ball in the hole ('sink'). null when silent.
 */
export function rumbleEffect(kind, amount, strength = 1) {
  const a = clamp(num(amount, 0), 0, 1) * clamp(num(strength, 1), 0, 1);
  if (a <= 0.001) return null;
  if (kind === 'sink') return { startDelay: 0, duration: 260, strongMagnitude: clamp(0.9 * a + 0.1, 0, 1), weakMagnitude: clamp(0.6 * a, 0, 1) };
  if (kind === 'impact') return { startDelay: 0, duration: Math.round(60 + 80 * a), strongMagnitude: clamp(a, 0, 1), weakMagnitude: clamp(0.4 * a, 0, 1) };
  return { startDelay: 0, duration: 45, strongMagnitude: clamp(a, 0, 1), weakMagnitude: clamp(0.25 * a, 0, 1) };
}

/**
 * Which notes get a bass pulse: notes on drum kit pad 1, and notes on the
 * track whose latest note is the lowest of the tracks heard in the last `windowMs`. At most one
 * pulse every `gapMs`.
 */
export function createBassFollower(parts = 16, { windowMs = 2000, gapMs = 70 } = {}) {
  const low = new Float64Array(parts).fill(Infinity), at = new Float64Array(parts).fill(-Infinity);
  let lastPulse = -Infinity;
  return {
    /** A note-on heard at `now` (ms). True when it should pulse. */
    note(part, note, drumKick, now) {
      if (!(part >= 0 && part < parts)) return false;
      low[part] = note;
      at[part] = now;
      let lowest = true;
      if (!drumKick) {
        for (let p = 0; p < parts; p++) {
          if (p !== part && now - at[p] < windowMs && low[p] < low[part]) { lowest = false; break; }
        }
      }
      if (!lowest || now - lastPulse < gapMs) return false;
      lastPulse = now;
      return true;
    },
    reset() { low.fill(Infinity); at.fill(-Infinity); lastPulse = -Infinity; },
  };
}

/** Is this drum note pad 1 (the kick in the default kit)? */
export const isKickNote = (note) => ((Math.round(note) - DRUM_FIRST_NOTE) % 8 + 8) % 8 === 0;

/**
 * Phone pulse length (ms) when the transport moves from beat `prev` to
 * `beat`: 0 between beats, longer on the first beat of a bar.
 */
export function beatPulse(prev, beat, beatsPerBar = 4) {
  if (!Number.isFinite(beat) || beat < 0) return 0;
  const b = Math.floor(beat + 1e-6);
  if (Number.isFinite(prev) && Math.floor(prev + 1e-6) === b) return 0;
  return b % beatsPerBar === 0 ? 30 : 15;
}
