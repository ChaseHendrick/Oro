import { describe, it, expect } from 'vitest';
import { arcPath, normToAngle, polar, isBipolar, arcOrigin, isDiscrete, dragToNorm, stepValue, parseTyped } from '../../src/ui/knob.js';
import { createBinder, snapValue, clampPart } from '../../src/ui/bind.js';
import { PART_PARAM_MAP, GLOBAL_PARAM_MAP, toNorm, defaultState } from '../../src/core/params.js';
import { createStore } from '../../src/core/store.js';

const P = PART_PARAM_MAP;

describe('knob geometry', () => {
  it('sweeps 270 degrees from -135 to +135', () => {
    expect(normToAngle(0)).toBe(-135);
    expect(normToAngle(1)).toBe(135);
    expect(normToAngle(0.5)).toBe(0);
    const [x, y] = polar(28, 28, 10, 0);
    expect(x).toBeCloseTo(28);
    expect(y).toBeCloseTo(18);
  });
  it('draws arcs with the right large-arc flag', () => {
    expect(arcPath(28, 28, 20, 0, 1)).toMatch(/A20 20 0 1 1/);
    expect(arcPath(28, 28, 20, 0, 0.3)).toMatch(/A20 20 0 0 1/);
    expect(arcPath(28, 28, 20, 0.5, 0.2)).toMatch(/^M/);
  });
  it('fills bipolar parameters from their zero point', () => {
    expect(isBipolar(P.stretch)).toBe(true);
    expect(isBipolar(P.cutoff)).toBe(false);
    expect(arcOrigin(P.pan)).toBeCloseTo(0.5);
    expect(arcOrigin(P.spin)).toBeCloseTo(0.5);
    expect(arcOrigin(P.tune)).toBeCloseTo(0.5);
    expect(arcOrigin(P.morph)).toBe(0);
  });
});

describe('knob interaction maths', () => {
  it('maps drag distance to normalised change (fine is slower)', () => {
    expect(dragToNorm(0, -220, false)).toBeCloseTo(1);
    expect(Math.abs(dragToNorm(0, -220, true))).toBeLessThan(0.2);
    expect(dragToNorm(10, 0, false)).toBeGreaterThan(0);
  });
  it('steps discrete params by whole units and continuous by travel', () => {
    expect(isDiscrete(P.octave)).toBe(true);
    expect(stepValue(P.octave, 0, 1, 0.01)).toBe(1);
    expect(stepValue(P.octave, 3, 1, 0.01)).toBe(3);
    expect(stepValue(P.unison, 1, -1, 0)).toBe(1);
    const v = stepValue(P.cutoff, 1000, 1, 0.1);
    expect(toNorm(P.cutoff, v)).toBeCloseTo(toNorm(P.cutoff, 1000) + 0.1, 5);
  });
  it('parses typed values with units', () => {
    expect(parseTyped(P.cutoff, '2.5k')).toBe(2500);
    expect(parseTyped(P.cutoff, '440')).toBe(440);
    expect(parseTyped(P.cutoff, '99999')).toBe(18000);
    expect(parseTyped(P.attack, '250ms')).toBeCloseTo(0.25);
    expect(parseTyped(P.morph, '50')).toBeCloseTo(0.5);
    expect(parseTyped(P.morph, '50%')).toBeCloseTo(0.5);
    expect(parseTyped(P.polyMode, 'mono')).toBe(1);
    expect(parseTyped(P.cutoff, 'loud')).toBeNull();
    expect(parseTyped(P.octave, '-2')).toBe(-2);
  });
});

describe('bindings', () => {
  it('snaps and clamps values', () => {
    expect(snapValue(P.octave, 2.6)).toBe(3);
    expect(snapValue(P.octave, 99)).toBe(3);
    expect(snapValue(P.cutoff, 'x')).toBe(P.cutoff.default);
    expect(snapValue(P.spin, -9)).toBe(-4);
    expect(clampPart(7, 4)).toBe(3);
    expect(clampPart(7)).toBe(7);
    expect(clampPart(99)).toBe(15);
    expect(clampPart('nope')).toBe(0);
  });
  it('part params follow the selected part and resubscribe', () => {
    const store = createStore(defaultState());
    const b = createBinder(store).partParam('cutoff');
    let calls = 0;
    const off = b.subscribe(() => calls++);
    b.set(1234);
    expect(store.get('parts.0.params.cutoff')).toBeCloseTo(1234);
    expect(calls).toBe(1);
    store.set('ui.selectedPart', 2);
    expect(calls).toBe(2);
    expect(b.path()).toBe('parts.2.params.cutoff');
    store.set('parts.0.params.cutoff', 500);
    expect(calls).toBe(2);
    store.set('parts.2.params.cutoff', 700);
    expect(calls).toBe(3);
    expect(b.get()).toBe(700);
    expect(b.modPath()).toBe('parts.2.mods.cutoff');
    expect(b.learnTarget()).toEqual({ scope: 'part', part: 'sel', id: 'cutoff' });
    off();
    store.set('parts.2.params.cutoff', 800);
    expect(calls).toBe(3);
  });
  it('fixed-part, global, mod and path bindings write the right paths', () => {
    const store = createStore(defaultState());
    const binder = createBinder(store);
    binder.partParam('level', { part: 3 }).set(0.5);
    expect(store.get('parts.3.params.level')).toBe(0.5);
    binder.globalParam('tempo').set(300);
    expect(store.get('global.tempo')).toBe(GLOBAL_PARAM_MAP.tempo.max);
    binder.modField('cutoff', 'lfoDepth', { curve: 'lin', min: -1, max: 1, default: 0 }).set(0.4);
    expect(store.get('parts.0.mods.cutoff.lfoDepth')).toBe(0.4);
    binder.path('seq.length', { curve: 'int', min: 1, max: 16, default: 16 }).set(40);
    expect(store.get('parts.0.patterns.0.length')).toBe(16);
    const view = binder.uiValue('view', ['orbit', 'top', 'low'], 'orbit');
    view.set('top');
    expect(store.get('ui.view')).toBe('top');
  });
});
