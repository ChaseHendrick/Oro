// v2.9 secrets, badges and small scores, kept on this computer only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { found, has, list, funData, setFunData, onFun, resetFun, _useStorage } from '../../src/core/fun.js';
import { createMemoryStorage } from '../music/fakes.js';

describe('fun store', () => {
  beforeEach(() => _useStorage(createMemoryStorage()));
  afterEach(() => _useStorage(null));

  it('records a find once, in order, and tells listeners', () => {
    const seen = [];
    const off = onFun((e) => seen.push(e));
    expect(found('secret', 'konami', 2)).toBe(true);
    expect(found('secret', 'konami', 3)).toBe(false);
    expect(found('badge', 'first-drop', 1)).toBe(true);
    expect(has('secret', 'konami')).toBe(true);
    expect(has('badge', 'konami')).toBe(false);
    expect(list('secret')).toEqual([{ id: 'konami', at: 2 }]);
    expect(seen).toEqual([{ kind: 'secret', id: 'konami' }, { kind: 'badge', id: 'first-drop' }]);
    off();
  });

  it('rejects bad kinds and ids, keeps small data, and resets', () => {
    expect(found('nope', 'x')).toBe(false);
    expect(found('secret', 'Bad Id!')).toBe(false);
    expect(setFunData('golf', { best: 3 })).toBe(true);
    expect(funData('golf')).toEqual({ best: 3 });
    expect(setFunData('golf', 'x'.repeat(20000))).toBe(false);
    expect(funData('golf')).toEqual({ best: 3 });
    resetFun();
    expect(list('secret')).toEqual([]);
    expect(funData('golf')).toBeNull();
  });

  it('survives storage that throws', () => {
    _useStorage({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
    expect(found('secret', 'konami')).toBe(true);
    expect(has('secret', 'konami')).toBe(false);
    expect(() => resetFun()).not.toThrow();
  });
});
