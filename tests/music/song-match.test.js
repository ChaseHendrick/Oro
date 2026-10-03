// 2.12 Match a song: tempo and key from synthetic audio (click tracks, chord
// progressions, a scale), low confidence on silence and noise, and Apply as
// one undo step.
import { describe, it, expect } from 'vitest';
import { analyseSong, describeResult, keyName, KK_MAJOR, KK_MINOR, rankKeys } from '../../src/music/song-match.js';
import { applyMatch } from '../../src/ui/match-song.js';
import { createStore } from '../../src/core/store.js';
import { createHistory } from '../../src/core/history.js';
import { defaultState, SCALE_NAMES } from '../../src/core/params.js';

const SR = 44100;
function clicks(bpm, secs = 16, accent = false) {
  const x = new Float32Array(SR * secs), per = 60 / bpm;
  for (let b = 0; b * per < secs; b++) {
    const o = Math.round(b * per * SR), amp = accent && b % 2 ? 0.4 : 0.9;
    for (let i = 0; i < 400 && o + i < x.length; i++) x[o + i] += amp * Math.sin(2 * Math.PI * 1500 * i / SR) * Math.exp(-i / 80);
  }
  return x;
}
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
function chords(prog, secsEach = 1, reps = 4, saw = false) {
  const x = new Float32Array(Math.ceil(SR * prog.length * secsEach * reps));
  let t0 = 0;
  for (let r = 0; r < reps; r++) for (const ch of prog) {
    const o = Math.round(t0 * SR), n = Math.round(secsEach * SR);
    for (const m of ch) {
      const f = hz(m);
      for (let i = 0; i < n; i++) {
        const ph = (f * i / SR) % 1, env = Math.min(1, i / 400) * Math.exp(-i / (SR * 0.8));
        x[o + i] += 0.15 * env * (saw ? 2 * ph - 1 : Math.sin(2 * Math.PI * ph));
      }
    }
    t0 += secsEach;
  }
  return x;
}

describe('tempo', () => {
  it.each([62, 90, 120, 128, 174, 195])('a click track at %i BPM', (bpm) => {
    const { tempo } = analyseSong(clicks(bpm), SR);
    expect(Math.abs(tempo.bpm - bpm)).toBeLessThanOrEqual(1);
    expect(tempo.confidence).toBeGreaterThan(0.6);
  });

  it('half and double: slow clicks stay slow, fast clicks stay fast, the other is offered', () => {
    const slow = analyseSong(clicks(70), SR).tempo, fast = analyseSong(clicks(180), SR).tempo;
    expect(Math.round(slow.bpm)).toBe(70); expect(slow.alt).toBe(140);
    expect(Math.round(fast.bpm)).toBe(180); expect(fast.alt).toBe(90);
    expect(Math.round(analyseSong(clicks(120, 16, true), SR).tempo.bpm)).toBe(120);   // accented off-beats
  });
});

describe('key', () => {
  const prog = (root, minor) => (minor
    ? [[0, 12, 15, 19], [5, 12, 17, 20], [7, 11, 14, 19], [0, 12, 15, 19]]    // i iv V i
    : [[0, 12, 16, 19], [5, 12, 17, 21], [7, 11, 14, 19], [0, 12, 16, 19]])   // I IV V I
    .map(ch => ch.map(n => n + 36 + root));
  it.each([[0, false, 'C major'], [9, true, 'A minor'], [3, false, 'D# major'], [6, true, 'F# minor']])('progression on %i (minor %s) is %s', (root, minor, name) => {
    for (const saw of [false, true]) {
      const { key } = analyseSong(chords(prog(root, minor), 1, 4, saw), SR);
      expect(keyName(key.best)).toBe(name);
      expect(key.confidence).toBeGreaterThan(0.6);
      expect(key.next).toBeTruthy();
    }
  });

  it('a D major scale', () => {
    const notes = [0, 2, 4, 5, 7, 9, 11, 12, 7, 4, 0].map(s => [62 + s]);
    const res = analyseSong(chords(notes, 0.4, 4, true), SR);
    expect(keyName(res.key.best)).toBe('D major');
    expect(Math.round(res.tempo.bpm)).toBe(150);
  });

  it('the profiles rank their own tonic first', () => {
    expect(keyName(rankKeys(KK_MAJOR)[0])).toBe('C major');
    expect(keyName(rankKeys(KK_MINOR)[0])).toBe('C minor');
  });
});

describe('unsure', () => {
  it('silence is too quiet, noise is low confidence', () => {
    const quiet = analyseSong(new Float32Array(SR * 10), SR);
    expect(quiet.quiet).toBe(true);
    expect(describeResult(quiet)).toMatch(/too quiet/);
    let seed = 1;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const noise = analyseSong(new Float32Array(SR * 12).map(() => (rnd() * 2 - 1) * 0.3), SR);
    expect(noise.quiet).toBe(false);
    expect(noise.tempo.confidence).toBeLessThan(0.35);
    expect(noise.key.confidence).toBeLessThan(0.35);
    expect(describeResult(noise)).toMatch(/not sure/);
    expect(describeResult(noise)).not.toMatch(/—/);
  });
});

describe('apply', () => {
  it('sets tempo, key and scale as one undo step', () => {
    const store = createStore(defaultState());
    const history = createHistory(store, { timers: { setTimeout: () => 0, clearTimeout: () => {} } });
    const before = [store.get('global.tempo'), store.get('global.scaleRoot'), store.get('global.scaleType')];
    applyMatch(store, { bpm: 123.6, key: { root: 2, mode: 'major' } });
    history.flush();
    expect(store.get('global.tempo')).toBe(124);
    expect(store.get('global.scaleRoot')).toBe(2);
    expect(store.get('global.scaleType')).toBe(SCALE_NAMES.indexOf('Major'));
    history.undo();
    expect([store.get('global.tempo'), store.get('global.scaleRoot'), store.get('global.scaleType')]).toEqual(before);
    applyMatch(store, { key: { root: 9, mode: 'minor' } });
    expect(store.get('global.scaleType')).toBe(SCALE_NAMES.indexOf('Minor'));
    expect(store.get('global.tempo')).toBe(before[0]);
  });
});
