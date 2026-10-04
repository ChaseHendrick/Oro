import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createSoundMatch } from '../../src/ui/sound-match.js';

let dom;
beforeEach(() => { dom = installFakeDom(); document.body = document.createElement('body'); });
afterEach(() => { dom.flush(); dom.restore(); });

describe('match a sound panel', () => {
  it('starts closed and Close puts it away without a patch', () => {
    const sets = [];
    const ui = createSoundMatch({ store: { get: () => 0, set: (p, v) => sets.push([p, v]) } });
    document.body.appendChild(ui.panel);
    expect(ui.isOpen()).toBe(false);
    ui.open();
    expect(ui.panel.hidden).toBe(false);
    ui.panel.querySelector('[aria-label="Close match a sound"]').click();
    expect(ui.isOpen()).toBe(false);
    expect(sets).toEqual([]);
    ui.dispose();
  });
});
