import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, SCALE_NAMES } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { generatePattern, makeRng, chordDegrees, randomizePattern, shiftPattern, clearPattern } from '../../src/music/patterns.js';

describe('pattern generator', () => {
  it('is repeatable with a seed and always anchors beat one', () => {
    const a = generatePattern({ rng: makeRng(7) });
    const b = generatePattern({ rng: makeRng(7) });
    expect(a).toEqual(b);
    for (let seed = 1; seed < 30; seed++) {
      const p = generatePattern({ rng: makeRng(seed), density: 0.3 });
      expect(p[0].on).toBe(1);
      expect(p[0].degree).toBe(0);
    }
  });

  it('follows density and prefers strong beats', () => {
    const count = (d) => {
      let total = 0, strong = 0, weak = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const p = generatePattern({ rng: makeRng(seed), density: d });
        p.forEach((s, i) => { if (s.on) { total++; if (i % 4 === 0) strong++; else if (i % 2) weak++; } });
      }
      return { total: total / 200, strong: strong / (200 * 4), weak: weak / (200 * 8) };
    };
    const lo = count(0.25), hi = count(0.85);
    expect(hi.total).toBeGreaterThan(lo.total + 4);
    expect(hi.strong).toBeGreaterThan(hi.weak);
    expect(lo.total).toBeGreaterThanOrEqual(2);
  });

  it('weights chord tones and keeps melodies in range', () => {
    const tones = new Map();
    for (let seed = 1; seed <= 300; seed++) {
      for (const s of generatePattern({ rng: makeRng(seed), density: 0.7 })) {
        if (!s.on) continue;
        expect(s.degree).toBeGreaterThanOrEqual(-2);
        expect(s.degree).toBeLessThanOrEqual(12);
        tones.set(s.degree, (tones.get(s.degree) || 0) + 1);
      }
    }
    const top = [...tones.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    expect(top).toContain(0);
    expect(top.some(d => d === 4 || d === 2)).toBe(true);
  });

  it('uses slides and accents sparingly', () => {
    let notes = 0, slides = 0, accents = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const s of generatePattern({ rng: makeRng(seed), density: 0.7, style: 'bass' })) {
        if (!s.on) continue;
        notes++; slides += s.slide; accents += s.accent;
      }
    }
    expect(slides / notes).toBeLessThan(0.15);
    expect(accents / notes).toBeLessThan(0.15);
    expect(slides).toBeGreaterThan(0);
  });

  it('finds chord tones in every scale', () => {
    for (let i = 0; i < SCALE_NAMES.length; i++) {
      const c = chordDegrees(i);
      expect(c.third).toBeGreaterThan(0);
      expect(c.fifth).toBeGreaterThan(c.third);
      expect(c.octave).toBeGreaterThan(c.fifth);
    }
    expect(chordDegrees(SCALE_NAMES.indexOf('Pent Min'))).toEqual({ root: 0, third: 1, fifth: 3, octave: 5 });
  });

  it('produces values that survive migration unchanged', () => {
    const store = createStore(defaultState());
    randomizePattern(store, 1, { density: 0.8, rng: makeRng(3) });
    const state = store.serialize();
    expect(migrateState(state).parts[1].patterns[0]).toEqual(state.parts[1].patterns[0]);
    expect(state.parts[1].seqOn).toBe(1);
  });
});

describe('pattern edits', () => {
  it('shifts within the pattern length and clears', () => {
    const store = createStore(defaultState());
    const seq = store.get('parts.0.patterns.0');
    seq.length = 4;
    seq.steps[0].on = 1; seq.steps[0].degree = 5;
    seq.steps[6].on = 1;
    seq.lane = { id: 'cutoff', curve: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
    store.set('parts.0.patterns.0', seq);
    shiftPattern(store, 0, 1);
    let st = store.get('parts.0.patterns.0.steps');
    expect(st[1]).toMatchObject({ on: 1, degree: 5 });
    expect(st[0].on).toBe(0);
    expect(st[6].on).toBe(1); // outside the length: untouched
    expect(store.get('parts.0.patterns.0.lane').curve.slice(0, 8)).toEqual([0, 0, 0, 1, 1, 0, 0, 0]);
    shiftPattern(store, 0, -1);
    shiftPattern(store, 0, -1);
    st = store.get('parts.0.patterns.0.steps');
    expect(st[3]).toMatchObject({ on: 1, degree: 5 });
    clearPattern(store, 0);
    expect(store.get('parts.0.patterns.0.steps').every(s => !s.on)).toBe(true);
    expect(store.get('parts.0.patterns.0.lane')).toBeNull();
  });
});
