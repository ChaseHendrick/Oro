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

  it('disables the button while the drum kit is on', () => {
    const store = createStore(defaultState());
    store.set('parts.0.drum.on', 1);
    const roll = createPianoRoll({ store });
    expect(roll.button.disabled).toBe(true);
    roll.open();
    expect(roll.isOpen()).toBe(false);
    roll.dispose();
  });
});
