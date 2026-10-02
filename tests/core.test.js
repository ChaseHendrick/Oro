import { describe, it, expect } from 'vitest';
import { PART_PARAMS, GLOBAL_PARAMS, toNorm, fromNorm, formatValue, defaultState, stepToMidi, MOD_PARAM_IDS, LINK_SOURCES } from '../src/core/params.js';
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
  it('has modulatable params', () => { expect(MOD_PARAM_IDS).toContain('centerX'); expect(MOD_PARAM_IDS.length).toBe(18); expect(MOD_PARAM_IDS).toContain('laps'); expect(MOD_PARAM_IDS).toContain('pace'); });
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
    expect(m.parts[0].patterns[0].steps[0]).toMatchObject({ on: 1, degree: 3, lock: 0, lx: 0.5, ly: 0.5 });
    expect(m.parts[0].patterns[0].lockGlide).toBe(0.5);
    expect(migrateState({ parts: [{ seq: { steps: [{ lock: 1, lx: 7, ly: -1 }] } }] }).parts[0].patterns[0].steps[0]).toMatchObject({ lock: 1, lx: 1, ly: 0 });
    expect(m.parts.length).toBe(4);
    expect(migrateState(null).parts.length).toBe(4);
  });
});

describe('round D contract', () => {
  it('keeps the optional low byte plane of an imported 16-bit terrain', () => {
    const ut = { name: 'dem', kind: 'image', w: 4, h: 4, mirror: 1, data: 'AAAA', lo: 'BBBB' };
    const kept = migrateState({ parts: [{ userTerrain: { A: ut, B: { ...ut, lo: 42 } } }] }).parts[0].userTerrain;
    expect(kept.A).toEqual(ut);
    expect(kept.B).not.toHaveProperty('lo');
    expect(kept.B.data).toBe('AAAA');
    const empty = migrateState({ parts: [{ userTerrain: { A: { ...ut, lo: '' } } }] }).parts[0].userTerrain.A;
    expect(empty).not.toHaveProperty('lo');
  });

  it('migrates links, lfo steps, dot extras', () => {
    const m = migrateState({ parts: [{
      links: [{ src: 99, dst: 'cutoff', amt: 3, curve: 1 }, { src: 0, dst: 'nope', amt: 1 }, { src: 2, dst: 'tune', amt: 1 }],
      mods: { morph: { lfoShape: 6, steps: [2, -2] } },
      dot: { mode: 4, waypoints: [{ x: 2, y: 0.3, beats: 99 }, null], tourMode: 9 },
    }] });
    const p = m.parts[0];
    // An unknown source index is clamped to the last known source (Voice Level since v1.4).
    expect(p.links).toEqual([{ src: LINK_SOURCES.length - 1, dst: 'cutoff', amt: 1, curve: 1 }]);
    expect(p.mods.morph.lfoShape).toBe(6);
    expect(p.mods.morph.steps.length).toBe(16);
    expect(p.mods.morph.steps.slice(0, 3)).toEqual([1, -1, 0.2]);
    expect(p.dot).toMatchObject({ mode: 4, tourMode: 2, waypoints: [{ x: 1, y: 0.3, beats: 16 }] });
    expect(m.parts[1].links).toEqual([{ src: 1, dst: 'morph', amt: 1, curve: 0 }]);
  });
  it('gives every part its own lfo step arrays', () => {
    const s = defaultState();
    s.parts[0].mods.morph.steps[0] = 0.123;
    expect(s.parts[0].mods.warp.steps[0]).not.toBe(0.123);
    expect(s.parts[1].mods.morph.steps[0]).not.toBe(0.123);
  });
});
