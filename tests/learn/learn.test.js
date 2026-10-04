import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateAll, BADGE_IDS } from '../../src/learn/index.js';
import { applySetup, runCheck } from '../../src/learn/engine.js';
import { createProgress } from '../../src/learn/progress.js';
import { TARGETS } from '../../src/learn/targets.js';
import { LESSONS } from '../../src/learn/lessons.js';
import { GLOSSARY } from '../../src/learn/glossary.js';
import { defaultState } from '../../src/core/params.js';
import { BADGES } from '../../src/core/fun-catalog.js';

describe('learn', () => {
  it('validates every lesson and every glossary link', () => {
    const res = validateAll();
    expect(res.errors).toEqual([]);
    expect(LESSONS).toHaveLength(11);
    for (const lesson of LESSONS) expect(lesson.steps.length).toBeGreaterThanOrEqual(5);
  });

  it('finds each highlight snippet in its file', () => {
    for (const t of Object.values(TARGETS)) {
      const text = readFileSync(t.file, 'utf8');
      expect(text.includes(t.snippet), t.file).toBe(true);
    }
  });

  it('checks eq, near, wrap, moved, all and any', () => {
    const state = defaultState(1);
    state.parts[0].params.cutoff = 1000;
    state.parts[0].params.centerX = 0.02;
    const before = defaultState(1);
    expect(runCheck({ op: 'eq', path: 'parts.0.params.cutoff', value: 1000 }, state)).toBe(true);
    expect(runCheck({ op: 'near', path: 'parts.0.params.centerX', value: 0.98, tolerance: 0.05, wrap: true }, state)).toBe(true);
    expect(runCheck({ op: 'moved', path: 'parts.0.params.cutoff' }, state, before)).toBe(true);
    expect(runCheck({ op: 'all', of: [{ op: 'eq', path: 'parts.0.params.cutoff', value: 1000 }, { op: 'gte', path: 'parts.0.params.cutoff', value: 100 }] }, state)).toBe(true);
    expect(runCheck({ op: 'any', of: [{ op: 'eq', path: 'parts.0.params.cutoff', value: 1 }, { op: 'lte', path: 'parts.0.params.cutoff', value: 1000 }] }, state)).toBe(true);
  });

  it('saves progress and does not mutate the session while setting up', () => {
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const progress = createProgress(storage);
    progress.mark('harmonics');
    expect(createProgress(storage).completed('harmonics')).toBe(true);
    expect(progress.allDone(['harmonics', 'paths'])).toBe(false);
    const state = defaultState(1);
    const history = [];
    const next = applySetup(state, [{ type: 'terrain', id: 'spectra' }, { type: 'param', id: 'size', value: 0.5 }]);
    expect(state.parts[0].params.size).not.toBe(0.5);
    expect(next.parts[0].params.size).toBe(0.5);
    expect(history).toEqual([]);
    expect(JSON.stringify(state)).not.toBe(JSON.stringify(next));
  });

  it('has no em dash or en dash, and lists its badges', () => {
    const blob = JSON.stringify(LESSONS) + JSON.stringify(GLOSSARY);
    expect(blob.includes('\u2014')).toBe(false);
    expect(blob.includes('\u2013')).toBe(false);
    for (const id of BADGE_IDS) expect(BADGES.some((b) => b.id === id)).toBe(true);
  });
});
