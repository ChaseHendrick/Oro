// v2.9 Operator panel Bookkeeping: local-only counters in localStorage.
import { describe, it, expect } from 'vitest';
import { createBookkeeping, sanitizeBook, formatPlayTime, BOOKKEEPING_KEY } from '../../src/core/bookkeeping.js';

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

describe('bookkeeping', () => {
  it('counts, saves on flush and reads the counters back', () => {
    const storage = memory();
    const a = createBookkeeping({ storage, now: () => 1000 });
    a.add('sessions'); a.add('seconds', 90); a.add('notes', 12); a.add('patches'); a.add('bogus', 5); a.add('notes', -3);
    expect(storage.map.has(BOOKKEEPING_KEY)).toBe(false);
    expect(a.flush()).toBe(true);
    const b = createBookkeeping({ storage, now: () => 5000 });
    expect(b.get()).toEqual({ seconds: 90, notes: 12, sessions: 1, patches: 1, since: 1000 });
    b.reset();
    expect(createBookkeeping({ storage }).get()).toMatchObject({ seconds: 0, notes: 0, sessions: 0, patches: 0, since: 5000 });
  });

  it('survives broken or blocked storage', () => {
    const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
    const b = createBookkeeping({ storage: broken });
    b.add('notes', 2);
    expect(b.flush()).toBe(false);
    expect(b.get().notes).toBe(2);
    expect(createBookkeeping({ storage: null }).flush()).toBe(true);
    expect(sanitizeBook({ seconds: -4, notes: 'x', sessions: 2.7 })).toMatchObject({ seconds: 0, notes: 0, sessions: 2 });
  });

  it('formats play time plainly', () => {
    expect(formatPlayTime(12)).toBe('12 s');
    expect(formatPlayTime(250)).toBe('4 min 10 s');
    expect(formatPlayTime(7500)).toBe('2 h 05 min');
  });
});
