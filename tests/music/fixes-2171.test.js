import { describe, it, expect } from 'vitest';
import { check, compose, STYLES } from '../../src/music/score.js';
import { planTracks, voicedPart } from '../../src/music/desk.js';
import { inRange } from '../../src/music/score-styles.js';
import { PITCHED } from '../../src/music/orchestra.js';
import { renderScoreInBackground } from '../../src/music/score-render-host.js';
import { createAgentApi, pitchClass } from '../../src/agent/api.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, defaultPart } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const head = 'title T\nbpm 120\nbars 2\n';

describe('2.17.1 planTracks: percussion always lands on a kit', () => {
  it('uses a free existing track as the percussion kit when all 16 tracks exist', () => {
    const p = planTracks(check(`${head}shaker x 0 0.2 1\nconga x 1 0.2 1\n`), 16);
    expect(p.fallback.size).toBe(0);
    const part = p.partOf.get('shaker');
    expect(p.slots.find((s) => s.part === part).kind).toBe('perc');
    expect(p.partOf.get('conga')).toBe(part);
  });
  it('never sends pads to a pitched track', () => {
    const text = `${head}violin A4 0 1 0.8\nviola A3 0 1 0.8\nshaker x 0 0.2 1\n`;
    const p = planTracks(check(text), 16);
    const kind = p.slots.find((s) => s.part === p.partOf.get('shaker')).kind;
    expect(['perc', 'kit']).toContain(kind);
  });
  it('makes room for the pads when every track holds a pitched voice', () => {
    const voices = Object.keys(PITCHED).slice(0, 16);
    const text = `${head}${voices.map((v) => `${v} C4 0 1 0.5`).join('\n')}\nshaker x 0 0.2 1\n`;
    const r = check(text);
    expect(r.ok).toBe(true);
    const p = planTracks(r, 16);
    const kitPart = p.partOf.get('shaker');
    const slot = p.slots.find((s) => s.part === kitPart);
    expect(slot.kind).toBe('kit');
    // no pitched voice was left on the kit track
    for (const v of voices) expect(p.slots.find((s) => s.part === p.partOf.get(v)).kind).toBe('pitched');
    // and the kit track is really a drum kit once voiced
    const part = voicedPart(defaultPart(kitPart), slot, r, 'patch');
    expect(part.drum.on).toBe(1);
  });
});

describe('2.17.1 compose keys', () => {
  it('reads Dm, d, D minor and Bb as keys', () => {
    expect(compose({ style: 'strings', key: 'Dm' }).score).toMatchObject({ key: 'D', mode: 'minor' });
    expect(compose({ style: 'strings', key: 'd', mode: 'minor' }).score).toMatchObject({ key: 'D', mode: 'minor' });
    expect(compose({ style: 'strings', key: 'D minor' }).score).toMatchObject({ key: 'D', mode: 'minor' });
    expect(compose({ style: 'strings', key: 'Bb', mode: 'major' }).score).toMatchObject({ key: 'Bb', mode: 'major' });
  });
  it('keeps the style\'s mode when only a key is given, and uses mode without a key', () => {
    expect(compose({ style: 'anime-song', key: 'E' }).score.mode).toBe(STYLES['anime-song'].mode);
    expect(compose({ style: 'strings', mode: 'major' }).score.mode).toBe('major');
  });
  it('says what is wrong instead of writing C major', () => {
    const r = compose({ style: 'strings', key: 'H' });
    expect(r.ok).toBe(false);
    expect(r.errors[0].field).toBe('key');
    expect(compose({ style: 'strings', mode: 'dorian' }).errors[0].field).toBe('mode');
  });
});

describe('2.17.1 composed notes stay in range', () => {
  it('folds a note into its instrument by octaves', () => {
    const [lo, hi] = PITCHED.oboe.range;
    expect(inRange('oboe', lo - 12)).toBe(lo);
    expect(inRange('oboe', hi + 12)).toBe(hi);
    expect(inRange('kick', 3)).toBe(3);
  });
  it('writes no range warnings for any style', () => {
    for (const style of Object.keys(STYLES)) {
      for (const key of ['C', 'E', 'F#', 'Bb']) {
        const r = compose({ style, key, mode: 'minor', seed: 3 });
        expect(r.ok, style).toBe(true);
        expect(r.warnings.filter((w) => /range/.test(w.message)), `${style} in ${key}`).toEqual([]);
      }
    }
  });
});

describe('2.17.1 repeats stop at the end of the score', () => {
  it('cuts the last repeated note instead of failing', () => {
    const r = check(`${head}hat x 0 1 0.5 every 0.5\n`);
    expect(r.ok).toBe(true);
    const last = r.score.notes[r.score.notes.length - 1];
    expect(last.beat + last.len).toBeLessThanOrEqual(8 + 1e-6);
  });
});

describe('2.17.1 agent api', () => {
  function setup() {
    const clock = createFakeClock({ startSec: 1 });
    const engine = createFakeEngine(clock);
    const store = createStore(defaultState());
    const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
    return { store, api: createAgentApi({ store, engine, music, timers: clock.timers }) };
  }
  it('reads flat and lower-case key names', () => {
    expect(pitchClass('Bb')).toBe(10);
    expect(pitchClass('eb')).toBe(3);
    expect(pitchClass('f#')).toBe(6);
    expect(pitchClass('H')).toBe(-1);
    const { api, store } = setup();
    expect(api.setGlobal({ scaleRoot: 'Bb' }).set.scaleRoot).toBe(10);
    expect(api.setGlobal('scaleRoot', 'd').set.scaleRoot).toBe(2);
    const bad = api.setGlobal('scaleRoot', 'H');
    expect(bad.ok).toBe(false);
    expect(store.get('global.scaleRoot')).toBe(2);
  });
  it('switches the viewport between the map and the visualizers', () => {
    const { api, store } = setup();
    expect(api.show('spectrum')).toMatchObject({ ok: true, showing: 'spectrum' });
    expect(store.get('ui.visualizer')).toBe('spectrum');
    expect(api.show('oscilloscope').showing).toBe('scope');
    expect(api.show('nope').ok).toBe(false);
    expect(api.show('map').showing).toBe('map');
  });
});

describe('2.17.1 background render', () => {
  it('falls back to the page where there is no Worker, with the same result', async () => {
    const r = await renderScoreInBackground(`${head}piano C4 0 1 0.8\n`, { quality: 'eco', tail: 0.2, sampleRate: 22050 });
    expect(r.ok).toBe(true);
    expect(r.ranIn).toBe('page');
    expect(r.left.length).toBe(r.right.length);
    expect(r.stats.peakDb).toBeLessThanOrEqual(-0.99);
  });
});
