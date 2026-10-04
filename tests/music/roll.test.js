import { describe, it, expect } from 'vitest';
import { defaultStep, stepToMidi, defaultPattern } from '../../src/core/params.js';
import { sanitizePattern } from '../../src/core/migrate.js';
import { paintNote, eraseNote, midiToDegree, notesOf, quarterTime, laneAt } from '../../src/music/roll.js';

describe('piano roll notes', () => {
  it('paints the first note onto the step and omits a zero quarter', () => {
    const next = paintNote(defaultStep(), { degree: 2, octave: 1, vel: 0.5, gate: 0.4, q: 0 });
    expect(next.on).toBe(1);
    expect(next.degree).toBe(2);
    expect(next.octave).toBe(1);
    expect(next.q).toBeUndefined();
    expect(next.extras).toBeUndefined();
  });

  it('keeps the grid note when a second pitch is painted', () => {
    const first = paintNote(defaultStep(), { degree: 0, octave: 0, vel: 0.8, gate: 0.5, q: 1 });
    const next = paintNote(first, { degree: 4, octave: 0, vel: 0.6, gate: 0.3, q: 2 });
    expect(next.degree).toBe(0);
    expect(next.q).toBe(1);
    expect(next.extras).toEqual([{ degree: 4, octave: 0, vel: 0.6, gate: 0.3, q: 2 }]);
    expect(notesOf(next).map((n) => n.first)).toEqual([true, false]);
  });

  it('promotes an extra when the first note is erased', () => {
    const step = paintNote(paintNote(defaultStep(), { degree: 1, octave: 0, vel: 0.8, gate: 0.5, q: 0 }), { degree: 3, octave: 0, vel: 0.4, gate: 0.5, q: 0 });
    const next = eraseNote(step, { degree: 1, octave: 0 });
    expect(next.on).toBe(1);
    expect(next.degree).toBe(3);
    expect(next.extras).toBeUndefined();
  });

  it('round-trips scale notes and rejects notes outside the scale', () => {
    const midi = stepToMidi({ degree: 2, octave: 0 }, 3, 9, 1);
    expect(midiToDegree(midi, 3, 9, 1)).toEqual({ degree: 2, octave: 0 });
    expect(midiToDegree(midi + 1, 3, 9, 1)).toBeNull();
  });

  it('stores quarters, extras and a lane only when they are valid', () => {
    const plain = sanitizePattern(defaultPattern(1), 1);
    expect(plain.steps[0].q).toBeUndefined();
    expect(plain.lane).toBeUndefined();
    const curve = Array.from({ length: 64 }, () => 0.25);
    const kept = sanitizePattern({ length: 16, steps: [{ on: 1, degree: 1, q: 2, extras: [{ degree: 5, octave: 0, vel: 0.5, gate: 0.4, q: 1 }, { degree: 9 }] }], lane: { id: 'cutoff', curve } }, 1);
    expect(kept.steps[0].q).toBe(2);
    expect(kept.steps[0].extras).toHaveLength(2);
    expect(kept.lane.id).toBe('cutoff');
    expect(kept.lane.curve).toHaveLength(64);
    expect(sanitizePattern({ lane: { id: 'nope', curve } }, 1).lane).toBeUndefined();
  });

  it('places a quarter inside the step', () => {
    expect(quarterTime(1, 1.5, 0)).toBe(1);
    expect(quarterTime(1, 1.5, 2)).toBeCloseTo(1.25);
    expect(laneAt({ curve: [0, 0.5, 1, 0.2] }, 0, 1, 16)).toBe(0.5);
  });
});
