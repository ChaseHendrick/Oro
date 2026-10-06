// 2.12 game controllers and haptics: mapping, deadzones and curves, notes,
// golf aiming, rumble and beat pulses (pure), the controller host with a
// mocked gamepad and vibrate, settings persistence, and the Pad Stick Link sources.
import { describe, it, expect, vi } from 'vitest';
import {
  deadzone1, stickResponse, moveDot, triggerVelocity, triggerHeld, actionNotes, createPadReader, detectAssign, padSnapshot,
  golfTurn, golfPower, rumbleEffect, createBassFollower, isKickNote, beatPulse, defaultPadPrefs, sanitizePadPrefs,
  loadPadPrefs, savePadPrefs, PAD_ACTIONS, PAD_PREFS_KEY, GOLF_CHARGE_MS, inputName,
} from '../../src/core/gamepad.js';
import { createPadHost } from '../../src/ui/gamepad-host.js';
import { PadBank } from '../../src/dsp/pad-sources.js';
import { LINK_SOURCES, defaultState, SCALE_NAMES } from '../../src/core/params.js';
import { createStore } from '../../src/core/store.js';
import { makeDSP, render } from '../dsp/helpers.js';

const memStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const btn = (v) => ({ pressed: v >= 0.5, value: v });
function fakePad({ axes = [0, 0, 0, 0], buttons = {}, rumble = null } = {}) {
  const b = Array.from({ length: 17 }, (_, i) => btn(buttons[i] || 0));
  return { id: 'Test pad', index: 0, connected: true, mapping: 'standard', axes: axes.slice(), buttons: b, vibrationActuator: rumble };
}

describe('controller mapping (pure)', () => {
  it('deadzones and the stick curve', () => {
    expect(deadzone1(0.1, 0.15)).toBe(0);
    expect(deadzone1(1, 0.15)).toBe(1);
    expect(deadzone1(-1, 0.15)).toBe(-1);
    expect(deadzone1(0.575, 0.15)).toBeCloseTo(0.5, 5);
    const out = { x: 9, y: 9 };
    expect(stickResponse(0.1, 0.1, 0.15, out)).toEqual({ x: 0, y: 0 });
    stickResponse(1, 0, 0.15, out);
    expect(out.x).toBeCloseTo(1, 5); expect(out.y).toBe(0);
    stickResponse(0.575, 0, 0.15, out);
    expect(out.x).toBeCloseTo(0.25, 5);           // half travel past the deadzone, squared
    stickResponse(0, -1, 0.15, out);
    expect(out.y).toBeCloseTo(-1, 5);
    const d = moveDot(0.5, 0.5, 1, -1, 0.5, 0.1, { x: 0, y: 0 });
    expect(d.x).toBeCloseTo(0.55); expect(d.y).toBeCloseTo(0.45);
    expect(moveDot(0.99, 0.01, 1, -1, 2, 1, { x: 0, y: 0 })).toEqual({ x: 1, y: 0 });
  });

  it('triggers: hysteresis and velocity', () => {
    expect(triggerHeld(false, 0.1)).toBe(false);
    expect(triggerHeld(false, 0.2)).toBe(true);
    expect(triggerHeld(true, 0.08)).toBe(true);
    expect(triggerHeld(true, 0.02)).toBe(false);
    expect(triggerVelocity(1)).toBe(1);
    expect(triggerVelocity(0.25)).toBeLessThan(triggerVelocity(0.9));
  });

  it('notes in the key, chords, octaves and drum pads', () => {
    const out = new Int16Array(3), minor = SCALE_NAMES.indexOf('Minor');
    expect(actionNotes('root', { root: 9, scaleType: minor }, out)).toBe(1);
    expect(out[0]).toBe(69);                                     // A4
    expect(actionNotes('chord', { root: 9, scaleType: minor }, out)).toBe(3);
    expect(Array.from(out)).toEqual([69, 72, 76]);               // A minor triad
    actionNotes('note2', { root: 0, scaleType: 0, octave: -1 }, out);
    expect(out[0]).toBe(50);                                     // D3
    actionNotes('note1', { root: 0, scaleType: 0, shift: true }, out);
    expect(out[0]).toBe(67);                                     // degree 5 (G)
    actionNotes('note3', { drum: true }, out);
    expect(out[0]).toBe(38);
    actionNotes('root', { drum: true }, out);
    expect(out[0]).toBe(36);
    expect(actionNotes('octUp', {}, out)).toBe(0);
    expect(isKickNote(36)).toBe(true); expect(isKickNote(44)).toBe(true); expect(isKickNote(37)).toBe(false);
  });

  it('reads edges without allocating, and assigns the input that moved', () => {
    const r = createPadReader();
    r.read(fakePad());
    r.read(fakePad({ buttons: { 0: 1 } }));
    expect(r.pressed(0)).toBe(true);
    r.read(fakePad({ buttons: { 0: 1 } }));
    expect(r.pressed(0)).toBe(false); expect(r.down(0)).toBe(true);
    r.read(fakePad());
    expect(r.released(0)).toBe(true);
    const base = padSnapshot(fakePad({ buttons: { 3: 1 }, axes: [0, 0, 0, 0] }));
    expect(detectAssign(fakePad({ buttons: { 3: 1 } }), base, 'button')).toBe(null);   // held from before
    expect(detectAssign(fakePad({ buttons: { 3: 1, 5: 1 } }), base, 'button')).toBe(5);
    expect(detectAssign(fakePad({ axes: [0, 0.2, 0, -0.9] }), base, 'axis')).toBe(3);
    expect(inputName('button', 7)).toBe('RT'); expect(inputName('axis', 2)).toBe('Right stick X'); expect(inputName('button', -1)).toBe('Not set');
  });

  it('settings: defaults off, cleaned, and saved per computer', () => {
    const d = defaultPadPrefs();
    expect(d.on).toBe(false); expect(d.rumble).toBe(false); expect(d.beat).toBe(false);
    expect(d.deadzone).toBeCloseTo(0.15);
    expect(Object.keys(d.map).sort()).toEqual(PAD_ACTIONS.map(a => a.id).sort());
    const s = sanitizePadPrefs({ on: 1, speed: 99, deadzone: -1, map: { dotX: 99, note1: 4, root: -1, bogus: 2 } });
    expect(s.speed).toBe(2); expect(s.deadzone).toBe(0);
    expect(s.map.dotX).toBe(0); expect(s.map.note1).toBe(4); expect(s.map.root).toBe(-1); expect(s.map.bogus).toBeUndefined();
    const st = memStorage();
    expect(loadPadPrefs(st)).toEqual(d);
    savePadPrefs({ ...d, on: true, map: { ...d.map, transport: 8 } }, st);
    expect(JSON.parse(st.getItem(PAD_PREFS_KEY)).on).toBe(true);
    expect(loadPadPrefs(st).map.transport).toBe(8);
    st.setItem(PAD_PREFS_KEY, '{not json');
    expect(loadPadPrefs(st)).toEqual(d);
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(loadPadPrefs(broken)).toEqual(d);
    expect(() => savePadPrefs(d, broken)).not.toThrow();
  });
});

describe('golf with a controller (pure)', () => {
  it('the stick turns the aim, the hold charges the power', () => {
    expect(golfTurn(1, 0.1, 0.5)).toBe(1);                 // in the deadzone
    expect(golfTurn(0, 1, 0.5)).toBeCloseTo(0.8);          // full right for half a second
    expect(golfTurn(0, -1, 0.5)).toBeCloseTo(-0.8);
    expect(Math.abs(golfTurn(0, 0.5, 1))).toBeLessThan(Math.abs(golfTurn(0, 1, 1)) / 2);   // finer near the middle
    expect(golfPower(0)).toBe(0);
    expect(golfPower(GOLF_CHARGE_MS / 2)).toBeCloseTo(0.5);
    expect(golfPower(GOLF_CHARGE_MS * 3)).toBe(1);
  });
});

describe('haptics (pure)', () => {
  it('rumble effects scale with the strength setting and stay in range', () => {
    expect(rumbleEffect('note', 1, 0)).toBe(null);
    const n = rumbleEffect('note', 1, 0.5);
    expect(n.strongMagnitude).toBeCloseTo(0.5); expect(n.duration).toBeLessThan(100);
    const hit = rumbleEffect('impact', 1, 1), soft = rumbleEffect('impact', 0.2, 1);
    expect(hit.duration).toBeGreaterThan(soft.duration);
    const sink = rumbleEffect('sink', 1, 1);
    for (const fx of [n, hit, sink]) { expect(fx.strongMagnitude).toBeLessThanOrEqual(1); expect(fx.weakMagnitude).toBeLessThanOrEqual(1); }
  });

  it('follows the lowest track and the kick, at most one pulse per gap', () => {
    const f = createBassFollower(4, { windowMs: 2000, gapMs: 70 });
    expect(f.note(0, 40, false, 0)).toBe(true);          // bass
    expect(f.note(0, 41, false, 30)).toBe(false);        // too soon after the last pulse
    expect(f.note(1, 72, false, 100)).toBe(false);       // the lead is higher
    expect(f.note(0, 43, false, 300)).toBe(true);
    expect(f.note(2, 60, true, 500)).toBe(true);         // a drum kick always counts
    expect(f.note(1, 74, false, 3000)).toBe(true);       // the bass went quiet: the lead is lowest now
  });

  it('pulses once per beat, longer on the bar', () => {
    expect(beatPulse(NaN, 0.01)).toBe(30);
    expect(beatPulse(0.01, 0.5)).toBe(0);
    expect(beatPulse(0.9, 1.02)).toBe(15);
    expect(beatPulse(3.95, 4.0)).toBe(30);
    expect(beatPulse(1, -1)).toBe(0);
  });
});

function hostEnv({ pads = [], vibrate = null } = {}) {
  const store = createStore(defaultState());
  const loops = new Set();
  const events = {};
  const nav = { getGamepads: () => pads, ...(vibrate ? { vibrate } : {}) };
  const win = { addEventListener: (t, fn) => { events[t] = fn; }, removeEventListener: () => {} };
  const doc = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
  const router = { noteOn: vi.fn(), noteOff: vi.fn() };
  const engine = { setPadStick: vi.fn(), context: { currentTime: 0 } };
  const noteFns = new Set(), busFns = {};
  const transport = { playing: false, beat: 0, isPlaying() { return this.playing; }, beatAt() { return this.beat; }, toggle: vi.fn() };
  const ctx = {
    store, engine, music: { router, transport },
    notes: { on: (fn) => { noteFns.add(fn); return () => noteFns.delete(fn); } },
    bus: { on: (t, fn) => { busFns[t] = fn; return () => {}; }, emit: (t, d) => busFns[t]?.(d) },
    togglePlay: vi.fn(), announce: vi.fn(),
  };
  let t = 0;
  const host = createPadHost(ctx, { nav, win, doc, now: () => t, loop: (fn) => { loops.add(fn); return () => loops.delete(fn); }, reducedMotion: () => false });
  const tick = (ms = 16) => { t += ms; for (const fn of [...loops]) fn(); };
  return { store, host, tick, loops, events, router, engine, ctx, noteFns, transport, doc, nav, setPads: (p) => { pads.length = 0; pads.push(...p); } };
}

describe('controller host (mocked gamepad)', () => {
  it('does nothing until turned on, polls only with a pad connected', () => {
    const pads = [];
    const env = hostEnv({ pads });
    expect(env.loops.size).toBe(0);
    env.host.setPrefs({ on: true });
    expect(env.loops.size).toBe(0);                      // no pad yet
    pads.push(fakePad());
    env.events.gamepadconnected();
    expect(env.loops.size).toBe(1);
    pads.length = 0;
    env.events.gamepaddisconnected();
    expect(env.loops.size).toBe(0);
    env.host.dispose();
  });

  it('left stick moves the dot, right stick feeds the Link sources', () => {
    const pad = fakePad();
    const env = hostEnv({ pads: [pad] });
    env.host.setPrefs({ on: true, speed: 0.5 });
    env.tick();
    expect(env.store.get('parts.0.params.centerX')).toBe(0.5);
    expect(env.engine.setPadStick).not.toHaveBeenCalled();
    pad.axes[0] = 1; pad.axes[1] = 0.05;                 // right, the y wobble is inside the deadzone
    pad.axes[2] = -1; pad.axes[3] = -1;
    env.tick(100);
    expect(env.store.get('parts.0.params.centerX')).toBeCloseTo(0.55, 2);
    expect(env.store.get('parts.0.params.centerY')).toBeCloseTo(0.5, 2);
    expect(env.engine.setPadStick).toHaveBeenLastCalledWith(-1, 1);     // stick up is +1
    const calls = env.engine.setPadStick.mock.calls.length;
    env.tick();
    expect(env.engine.setPadStick.mock.calls.length).toBe(calls);      // unchanged: nothing sent
    env.host.dispose();
  });

  it('triggers and face buttons play notes; D-pad, Start and tracks', () => {
    const pad = fakePad();
    const env = hostEnv({ pads: [pad] });
    env.store.set('global.scaleRoot', 0); env.store.set('global.scaleType', SCALE_NAMES.indexOf('Major'));
    env.host.setPrefs({ on: true });
    env.tick();
    pad.buttons[7] = btn(0.3); env.tick();               // right trigger passes the threshold
    pad.buttons[7] = btn(0.9); env.tick();               // velocity read a frame later
    expect(env.router.noteOn.mock.calls.map(c => c[1])).toEqual([60, 64, 67]);
    expect(env.router.noteOn.mock.calls[0][2]).toBeCloseTo(triggerVelocity(0.9));
    pad.buttons[7] = btn(0); env.tick();
    expect(env.router.noteOff).toHaveBeenCalledTimes(3);
    env.router.noteOn.mockClear();
    pad.buttons[12] = btn(1); env.tick(); pad.buttons[12] = btn(0); env.tick();   // octave up
    pad.buttons[1] = btn(1); env.tick();                 // B: note 2 of the scale
    expect(env.router.noteOn).toHaveBeenLastCalledWith(0, 74, 0.8, 'gamepad');
    pad.buttons[1] = btn(0); env.tick();
    expect(env.router.noteOff).toHaveBeenLastCalledWith(0, 74, 'gamepad');
    pad.buttons[9] = btn(1); env.tick(); pad.buttons[9] = btn(0); env.tick();
    expect(env.ctx.togglePlay).toHaveBeenCalledTimes(1);
    env.host.dispose();
  });

  it('rumbles with the bass only when rumble is on, and never while hidden', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const pad = fakePad({ rumble: { playEffect } });
    const env = hostEnv({ pads: [pad] });
    env.host.setPrefs({ on: true });
    env.tick();
    const note = (part, n) => { for (const fn of env.noteFns) fn({ part, note: n, vel: 1, on: true }); };
    note(0, 36);
    expect(playEffect).not.toHaveBeenCalled();
    env.host.setPrefs({ rumble: true, rumbleAmount: 0.5 });
    env.tick(200); note(0, 36);
    expect(playEffect).toHaveBeenCalledWith('dual-rumble', expect.objectContaining({ strongMagnitude: 0.5 }));
    env.doc.visibilityState = 'hidden';
    env.tick(200); note(0, 36);
    expect(playEffect).toHaveBeenCalledTimes(1);
    env.doc.visibilityState = 'visible';
    env.ctx.bus.emit('golf', { type: 'sink' });
    expect(playEffect).toHaveBeenCalledTimes(2);
    env.host.dispose();
  });

  it('phone pulses on the beat: off by default, only while playing', () => {
    const vibrate = vi.fn(() => true);
    const env = hostEnv({ vibrate });
    expect(env.loops.size).toBe(0);
    env.host.setPrefs({ beat: true });
    expect(env.loops.size).toBe(1);
    env.tick();
    expect(vibrate).not.toHaveBeenCalled();             // stopped
    env.transport.playing = true;
    env.transport.beat = 0.02; env.tick();
    env.transport.beat = 0.5; env.tick();
    env.transport.beat = 1.01; env.tick();
    expect(vibrate.mock.calls.map(c => c[0])).toEqual([30, 15]);
    env.doc.visibilityState = 'hidden';
    env.transport.beat = 2.01; env.tick();
    expect(vibrate).toHaveBeenCalledTimes(2);
    env.host.setPrefs({ beat: false });
    expect(env.loops.size).toBe(0);
    env.host.dispose();
  });
});

describe('Pad Stick Link sources', () => {
  it('are appended after the weather sources', () => {
    expect(LINK_SOURCES.indexOf('Weather Clouds')).toBe(34);
    expect(LINK_SOURCES.indexOf('Pad Stick X')).toBe(35);
    expect(LINK_SOURCES.indexOf('Pad Stick Y')).toBe(36);
    // 2.17 appended the Touch sources after them
    expect(LINK_SOURCES.length).toBeGreaterThanOrEqual(37);
    expect(LINK_SOURCES.indexOf('Touch X')).toBe(37);
  });

  it('the bank smooths toward the stick and clamps', () => {
    const b = new PadBank();
    b.step(0.01);
    expect(Array.from(b.out)).toEqual([0, 0]);
    b.set([2, -0.5]);
    b.step(0.03);
    expect(b.out[0]).toBeGreaterThan(0.5); expect(b.out[0]).toBeLessThan(1);
    b.step(1);
    expect(b.out[0]).toBeCloseTo(1); expect(b.out[1]).toBeCloseTo(-0.5);
    b.set([0.25, 0.75], true);
    expect(Array.from(b.out)).toEqual([0.25, 0.75]);
  });

  it('a Pad Stick link is silent until the stick moves, then changes the sound', () => {
    const link = [{ src: LINK_SOURCES.indexOf('Pad Stick X'), dst: 'size', amt: 0.9, curve: 0 }];
    const play = (links, stick) => {
      const dsp = makeDSP({ params: {} });
      if (links) dsp.handleMessage({ t: 'links', part: 0, links });
      if (stick) dsp.handleMessage({ t: 'pad', v: stick, snap: true });
      return render(dsp, 0.3, (d, t, k) => { if (k === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 57, vel: 1, time: 0 }); }).L;
    };
    const plain = play(null), idle = play(link), moved = play(link, [1, 0]);
    expect(Array.from(idle)).toEqual(Array.from(plain));
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff += Math.abs(plain[i] - moved[i]);
    expect(diff).toBeGreaterThan(1);
  });
});
