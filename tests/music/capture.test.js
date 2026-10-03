// v2.9 Capture: the router's buffer of notes people play, the phrase to
// pattern conversion, drum kit tracks, bounce events, migration and undo.
import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, stepToMidi } from '../../src/core/params.js';
import { sanitizePattern, migrateState } from '../../src/core/migrate.js';
import { createHistory } from '../../src/core/history.js';
import { createMusic } from '../../src/music/music.js';
import { capturePhrase, noteToDegree, isPersonSource } from '../../src/music/capture.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const D = 0.125;   // a 1/16 step at 120 BPM
const C_MAJOR = { root: 0, scaleType: 0, baseOctave: 3 };

function setup({ drum = false } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = defaultState();
  s.global.tempo = 120;
  s.global.swing = 0;
  s.global.scaleRoot = 0;
  s.global.scaleType = 0;
  if (drum) s.parts[0].drum.on = 1;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

/** Play [note, startStep, lengthSteps, vel] on track 0 from `source`, in real (fake) time. */
function play(env, notes, source = 'ui') {
  let now = 0;
  const events = [];
  for (const [note, at, len, vel = 0.8] of notes) {
    events.push([at * D, 'on', note, vel], [(at + len) * D, 'off', note]);
  }
  events.sort((a, b) => a[0] - b[0] || (a[1] === 'off' ? -1 : 1));
  for (const [t, kind, note, vel] of events) {
    if (t > now) { env.clock.advance(t - now); now = t; }
    if (kind === 'on') env.music.router.noteOn(0, note, vel, source);
    else env.music.router.noteOff(0, note, source);
  }
  env.clock.advance(0.05);
}

const midiOf = (step) => stepToMidi(step, 3, 0, 0);

describe('the capture buffer', () => {
  it('keeps notes people play, not the sequencer, the arp, previews or bounces', () => {
    expect(['ui', 'qwerty', 'midi:in1:0', 'guitar'].every(isPersonSource)).toBe(true);
    expect(['seq', 'arp', 'ui-preview', 'bounce', 'preview', 'explore', undefined].some(isPersonSource)).toBe(false);
    const env = setup();
    play(env, [[60, 0, 1]]);
    play(env, [[62, 0, 1]], 'ui-preview');
    env.store.set('parts.0.seqOn', 1);
    env.store.set('parts.0.patterns.0.steps.0.on', 1);
    env.music.transport.play();
    env.clock.advance(0.5);
    env.music.transport.stop();
    expect(env.music.router.captured(0).map(n => n.note)).toEqual([60]);
  });

  it('follows the track when the list is reordered (notes are kept by track id)', () => {
    const env = setup();
    play(env, [[64, 0, 1]]);
    const parts = env.store.get('parts');
    env.store.set('parts', [parts[1], parts[0], ...parts.slice(2)], { source: 'tracks' });
    expect(env.music.router.captured(1).map(n => n.note)).toEqual([64]);
    expect(env.music.router.captured(0)).toEqual([]);
  });
});

describe('Capture into a melodic pattern', () => {
  it('writes the phrase as scale degrees, velocity and gate, from the first note, and switches the sequencer on', () => {
    const env = setup();
    play(env, [[60, 0, 0.5, 0.5], [64, 2, 1, 0.9], [67, 4, 0.25], [72, 6, 0.5]]);
    const res = env.music.capture(0);
    expect(res.ok).toBe(true);
    expect(res.message).toBe('Captured 4 notes into Pattern 1 (16 steps of 1/16). Sequencer switched on.');
    const steps = env.store.get('parts.0.patterns.0.steps');
    expect(steps.map(s => s.on).slice(0, 8)).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    expect([0, 2, 4, 6].map(i => midiOf(steps[i]))).toEqual([60, 64, 67, 72]);
    expect(steps[0]).toMatchObject({ vel: 0.5, gate: 0.5, slide: 0 });
    expect(steps[2]).toMatchObject({ vel: 0.9, gate: 1 });
    expect(env.store.get('parts.0.seqOn')).toBe(1);
  });

  it('snaps out-of-scale notes and says so', () => {
    const env = setup();
    play(env, [[61, 0, 0.5], [66, 1, 0.5]]);
    const res = env.music.capture(0);
    expect(res.message).toContain('2 notes outside C Major moved to the nearest scale note.');
    const steps = env.store.get('parts.0.patterns.0.steps');
    expect([midiOf(steps[0]), midiOf(steps[1])]).toEqual([60, 65]);
  });

  it('says why nothing was captured', () => {
    const env = setup();
    const res = env.music.capture(0);
    expect(res.ok).toBe(false);
    expect(res.message).toBe('Nothing captured: play some notes on this track first (keys or MIDI).');
    expect(env.store.get('parts.0.seqOn')).toBe(0);
  });

  it('keeps dot and parameter locks on their steps', () => {
    const env = setup();
    const path = 'parts.0.patterns.0.steps.1';
    env.store.set(path, { ...env.store.get(path), lock: 1, lx: 0.3, ly: 0.4, plocks: { cutoff: 900 } });
    play(env, [[60, 0, 0.5]]);
    env.music.capture(0);
    expect(env.store.get(path)).toMatchObject({ on: 0, lock: 1, lx: 0.3, ly: 0.4, plocks: { cutoff: 900 } });
  });

  it('quantizes to the transport grid while it plays', () => {
    const env = setup();
    env.music.transport.play();
    env.clock.advance(0.06 + 5 * D + 0.01);   // just after step 5 of the bar
    env.music.router.noteOn(0, 62, 0.8, 'qwerty');
    env.clock.advance(0.05);
    env.music.router.noteOff(0, 62, 'qwerty');
    env.music.capture(0);
    env.music.transport.stop();
    const steps = env.store.get('parts.0.patterns.0.steps');
    expect(steps.findIndex(s => s.on)).toBe(5);
    expect(midiOf(steps[5])).toBe(62);
  });

  it('is one undo step', () => {
    const env = setup();
    const history = createHistory(env.store, { timers: env.clock.timers });
    const before = JSON.parse(JSON.stringify(env.store.get('parts.0')));
    play(env, [[60, 0, 1], [62, 1, 1], [64, 2, 1]]);
    env.music.capture(0);
    history.flush();
    expect(history.list().past).toEqual(['Capture']);
    history.undo();
    expect(env.store.get('parts.0')).toEqual(before);
  });

  it('round trips through save and load and plays back in bounces', () => {
    const env = setup();
    play(env, [[60, 0, 0.5], [67, 3, 0.5]]);
    env.music.capture(0);
    const saved = JSON.parse(JSON.stringify(env.store.serialize()));
    const once = migrateState(saved);
    expect(once.parts[0].patterns[0]).toEqual(sanitizePattern(env.store.get('parts.0.patterns.0'), 1));
    const on = sequencerEvents(once, 1).filter(e => e.msg.t === 'noteOn' && e.msg.part === 0);
    expect(on.slice(0, 2).map(e => [e.time, e.msg.note])).toEqual([[0, 60], [0.375, 67]]);
  });
});

describe('Capture into a drum kit track', () => {
  it('writes the kit lanes (note 36 + r to lane r) and leaves the melodic steps alone', () => {
    const env = setup({ drum: true });
    play(env, [[36, 0, 0.2, 1], [38, 4, 0.2, 0.7], [42, 2, 0.2, 0.5], [42, 6, 0.2, 0.5], [90, 1, 0.2]]);
    const res = env.music.capture(0);
    expect(res.message).toBe('Captured 4 hits into Pattern 1 (16 steps of 1/16). 1 note not on a pad left out. Sequencer switched on.');
    const lanes = env.store.get('parts.0.patterns.0.drumLanes');
    expect(lanes[0][0]).toBe(1);
    expect(lanes[2][4]).toBe(0.7);
    expect(lanes[6].slice(0, 8)).toEqual([0, 0, 0.5, 0, 0, 0, 0.5, 0]);
    expect(env.store.get('parts.0.patterns.0.steps').every(s => !s.on)).toBe(true);
    const ev = env.music.renderEvents(1).filter(e => e.msg.t === 'noteOn');
    expect(ev.slice(0, 2).map(e => [e.time, e.msg.note])).toEqual([[0, 36], [0.25, 42]]);
  });

  it('says so when no note was on a pad', () => {
    const env = setup({ drum: true });
    play(env, [[80, 0, 1]]);
    expect(env.music.capture(0).message).toBe('Nothing captured: none of the notes were on the kit\'s pads (C2 to G2).');
  });
});

describe('capturePhrase', () => {
  const at = (step, len, note, vel = 0.8) => ({ note, vel, on: 10 + step * D, off: 10 + (step + len) * D });
  const opts = { spb: 0.5, rateBeats: 0.25, length: 16, ...C_MAJOR, now: 100 };

  it('keeps the last N steps ending at the last note, each at its place in the loop', () => {
    // a one-bar riff played twice and a final note on the next downbeat
    const riff = [[0, 60], [4, 62], [8, 64], [12, 65]];
    const notes = [...riff.map(([s, n]) => at(s, 0.5, n)), ...riff.map(([s, n]) => at(s + 16, 0.5, n + 12)), at(32, 0.5, 48)];
    const res = capturePhrase(notes, opts);
    expect(res.older).toBe(5);   // first bar and the second bar's first note fall outside
    expect(res.steps.map(s => (s ? stepToMidi(s, 3, 0, 0) : null)).filter(Boolean)).toEqual([48, 74, 76, 77]);
    expect(res.steps[0] && stepToMidi(res.steps[0], 3, 0, 0)).toBe(48);
  });

  it('starts a new phrase after two bars of silence', () => {
    const res = capturePhrase([at(0, 1, 60), at(40, 1, 62), at(41, 1, 64)], opts);
    expect(res.count).toBe(2);
    expect(res.older).toBe(0);
  });

  it('ties a held note over the empty steps after it and slides legato notes', () => {
    const res = capturePhrase([at(0, 2.7, 60), at(3, 1.02, 62), at(4, 0.5, 64)], opts);
    expect(res.steps.slice(0, 5).map(s => s && [s.degree, s.slide, s.gate])).toEqual([
      [7, 1, 1], [7, 1, 1], [7, 0, 0.7], // C held about three steps: tied
      [8, 1, 1],                         // D held into E: slide
      [9, 0, 0.5],
    ]);
  });

  it('keeps the loudest note when two land on one step', () => {
    const res = capturePhrase([at(0, 1, 60, 0.4), at(0.2, 1, 64, 0.9)], opts);
    expect(res.count).toBe(1);
    expect(res.overlap).toBe(1);
    expect(res.steps[0].degree).toBe(9);
  });

  it('noteToDegree snaps to the nearest scale note, the lower one on a tie', () => {
    // base octave 3: degree 0 is C3 (MIDI 48)
    expect(noteToDegree(48, C_MAJOR)).toEqual({ degree: 0, octave: 0, snapped: false });
    expect(noteToDegree(49, C_MAJOR)).toEqual({ degree: 0, octave: 0, snapped: true });
    expect(noteToDegree(59, C_MAJOR)).toEqual({ degree: 6, octave: 0, snapped: false });
    expect(noteToDegree(36, C_MAJOR)).toEqual({ degree: -7, octave: 0, snapped: false });
    expect(noteToDegree(48 + 12 * 5, C_MAJOR)).toEqual({ degree: 28, octave: 1, snapped: false });
    for (let n = 20; n < 110; n++) {
      const d = noteToDegree(n, C_MAJOR);
      if (!d.snapped) expect(stepToMidi(d, 3, 0, 0)).toBe(n);
    }
  });
});
