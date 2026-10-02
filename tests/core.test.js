import { describe, it, expect } from 'vitest';
import { PART_PARAMS, GLOBAL_PARAMS, toNorm, fromNorm, formatValue, defaultState, stepToMidi, MOD_PARAM_IDS } from '../src/core/params.js';
import { createStore } from '../src/core/store.js';
import { migrateState } from '../src/core/migrate.js';

describe('params', () => {
  it('round-trips every default through the knob curve', () => {
    for (const d of [...PART_PARAMS, ...GLOBAL_PARAMS]) {
      const n = toNorm(d, d.default);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
      expect(fromNorm(d, n)).toBeCloseTo(d.default, 6);
      expect(typeof formatValue(d, d.default)).toBe('string');
    }
  });
  it('maps endpoints to min/max', () => {
    for (const d of [...PART_PARAMS, ...GLOBAL_PARAMS]) {
      expect(fromNorm(d, 0)).toBeCloseTo(d.curve === 'bipow' ? -d.max : d.min, 6);
      expect(fromNorm(d, 1)).toBeCloseTo(d.max, 6);
    }
  });
  it('has modulatable params', () => { expect(MOD_PARAM_IDS).toContain('centerX'); expect(MOD_PARAM_IDS.length).toBe(17); expect(MOD_PARAM_IDS).toContain('laps'); expect(MOD_PARAM_IDS).toContain('pace'); });
  it('resolves scale degrees to MIDI notes', () => {
    // A minor (root 9, scaleType 1), base octave 3: degree 0 -> A3 = 57
    expect(stepToMidi({ degree: 0, octave: 0 }, 3, 9, 1)).toBe(57);
    expect(stepToMidi({ degree: 7, octave: 0 }, 3, 9, 1)).toBe(69);
    expect(stepToMidi({ degree: -1, octave: 0 }, 3, 9, 1)).toBe(55);
  });
});

describe('store', () => {
  it('notifies overlapping subscribers', () => {
    const s = createStore(defaultState());
    const seen = [];
    s.subscribe('parts.0.params.cutoff', p => seen.push('leaf:' + p));
    s.subscribe('parts.0', p => seen.push('part:' + p));
    s.subscribe('parts.1', p => seen.push('other:' + p));
    s.set('parts.0.params.cutoff', 500);
    s.set('parts.0', s.get('parts.0'));
    expect(seen).toEqual(['leaf:parts.0.params.cutoff', 'part:parts.0.params.cutoff', 'leaf:parts.0', 'part:parts.0']);
    expect(s.get('parts.0.params.cutoff')).toBe(500);
  });
  it('batches and serializes without ui', () => {
    const s = createStore(defaultState());
    let count = 0; s.subscribe('global', () => count++);
    s.batch(() => { s.set('global.tempo', 100); s.set('global.swing', 0.2); expect(count).toBe(0); });
    expect(count).toBe(2);
    expect(s.serialize().ui).toBeUndefined();
    expect(s.get('ui.selectedPart')).toBe(0);
  });
});

describe('migrate', () => {
  it('fills defaults and clamps garbage', () => {
    const m = migrateState({ global: { tempo: 9999 }, parts: [{ params: { cutoff: 'x', size: -5 }, seq: { steps: [{ on: 1, degree: 3 }] } }] });
    expect(m.global.tempo).toBe(240);
    expect(m.parts[0].params.cutoff).toBe(9000);
    expect(m.parts[0].params.size).toBe(0);
    expect(m.parts[0].seq.steps[0]).toMatchObject({ on: 1, degree: 3, lock: 0, lx: 0.5, ly: 0.5 });
    expect(m.parts[0].seq.lockGlide).toBe(0.5);
    expect(migrateState({ parts: [{ seq: { steps: [{ lock: 1, lx: 7, ly: -1 }] } }] }).parts[0].seq.steps[0]).toMatchObject({ lock: 1, lx: 1, ly: 0 });
    expect(m.parts.length).toBe(4);
    expect(migrateState(null).parts.length).toBe(4);
  });
});
