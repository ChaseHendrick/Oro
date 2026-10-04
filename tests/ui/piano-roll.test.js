import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createPianoRoll } from '../../src/ui/piano-roll.js';

let dom;
beforeEach(() => { dom = installFakeDom(); document.body = document.createElement('body'); });
afterEach(() => { dom.flush(); dom.restore(); });

describe('piano roll panel', () => {
  it('starts closed, opens beside the grid, and names the lane rule', () => {
    const store = createStore(defaultState());
    const roll = createPianoRoll({ store });
    expect(roll.button.textContent).toBe('Piano roll');
    expect(roll.el.hidden).toBe(true);
    expect(roll.el.textContent).toContain('Step locks still win on their step.');
    expect(roll.el.querySelector('.roll-lane')).toBeTruthy();
    roll.open();
    expect(roll.el.hidden).toBe(false);
    expect(roll.button.getAttribute('aria-pressed')).toBe('true');
    roll.dispose();
  });

  it('shows a step whose octave is not zero on the row that sounds the same', () => {
    const store = createStore(defaultState());
    store.set('parts.0.patterns.0.steps.0', { on: 1, degree: 0, octave: 1, vel: 0.8, gate: 0.5 });
    const roll = createPianoRoll({ store });
    roll.open();
    const notes = roll.el.querySelectorAll('.roll-note');
    expect(notes.length).toBe(1);
    expect(notes[0].dataset.octave).toBe('1');
    expect(notes[0].dataset.degree).toBe('0');
    roll.dispose();
  });

  it('disables the button while the drum kit is on', () => {
    const store = createStore(defaultState());
    store.set('parts.0.drum.on', 1);
    const roll = createPianoRoll({ store });
    expect(roll.button.disabled).toBe(true);
    roll.open();
    expect(roll.isOpen()).toBe(false);
    roll.dispose();
  });

  it('keeps a lane that is longer than the pattern when a point is drawn', () => {
    const store = createStore(defaultState());
    store.set('parts.0.patterns.0.length', 8);
    store.set('parts.0.patterns.0.lane', { id: 'cutoff', curve: Array.from({ length: 64 }, () => 0.8) });
    const roll = createPianoRoll({ store });
    roll.open();
    dom.flush();
    const curve = roll.el.querySelector('.roll-curve');
    curve.dispatchEvent({ type: 'pointerdown', clientX: 0, clientY: 10, buttons: 1 });
    const lane = store.get('parts.0.patterns.0.lane');
    expect(lane.id).toBe('cutoff');
    expect(lane.curve).toHaveLength(32);
    expect(lane.curve[0]).toBe(0);
    expect(lane.curve[1]).toBe(0.8);
    expect(lane.curve[31]).toBe(0.8);
    roll.dispose();
  });
});
