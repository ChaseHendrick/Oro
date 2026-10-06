import { describe, it, expect } from 'vitest';
import { installConsoleEgg } from '../../src/ui/eggs.js';

describe('console egg with the agent API (2.17)', () => {
  it('adds secret() to an existing window.oro instead of being skipped', () => {
    const win = { oro: { play() { return 1; } } };
    installConsoleEgg(win);
    expect(typeof win.oro.secret).toBe('function');
    expect(win.oro.play()).toBe(1);
    expect(Object.keys(win.oro)).toEqual(['play']);   // not enumerable: help() lists stay clean
  });
  it('still makes window.oro when there is none', () => {
    const win = {};
    installConsoleEgg(win);
    expect(typeof win.oro.secret).toBe('function');
  });
});
