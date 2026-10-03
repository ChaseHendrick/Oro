// v2.9 secrets: the recognisers (Konami sequence, logo taps, drops, tempo
// eggs), the catalog of secrets and badges, the Bookkeeping progress and the
// one-at-a-time toasts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './fake-dom.js';
import { createMemoryStorage } from '../music/fakes.js';
import { _useStorage, found, list } from '../../src/core/fun.js';
import { SECRETS, BADGES, progress, findName, catalogEntry } from '../../src/core/fun-catalog.js';
import { qwertyNote } from '../../src/ui/piano.js';

let dom, eggs;
beforeAll(async () => {
  dom = installFakeDom();
  eggs = await import('../../src/ui/eggs.js');
});
afterAll(() => dom.restore());
beforeEach(() => _useStorage(createMemoryStorage()));
afterEach(() => _useStorage(null));

const calls = { prevented: 0, stopped: 0 };
function key(k, more = {}) {
  const code = k.startsWith('Arrow') ? k : `Key${k.toUpperCase()}`;
  return { type: 'keydown', key: k, code, target: document.body, repeat: false, preventDefault() { calls.prevented++; }, stopPropagation() { calls.stopped++; }, ...more };
}
const SEQ = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

describe('Konami recogniser', () => {
  it('matches the sequence, passively', () => {
    let hits = 0;
    const k = eggs.createKonami(() => hits++);
    calls.prevented = calls.stopped = 0;
    const results = SEQ.map(x => k.feed(key(x)));
    expect(results.at(-1)).toBe(true);
    expect(results.slice(0, -1).every(r => r === false)).toBe(true);
    expect(hits).toBe(1);
    // never prevents or stops a key, so B and A keep their shortcut and note
    expect(calls).toEqual({ prevented: 0, stopped: 0 });
    expect(qwertyNote('KeyA', 4)).toBe(60);
    // again from the start
    SEQ.forEach(x => k.feed(key(x)));
    expect(hits).toBe(2);
  });

  it('resets on a wrong key, and keeps Up Up after an extra Up', () => {
    let hits = 0;
    const k = eggs.createKonami(() => hits++);
    for (const x of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'x', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) k.feed(key(x));
    expect(hits).toBe(0);
    for (const x of ['ArrowUp', ...SEQ]) k.feed(key(x));
    expect(hits).toBe(1);
    // uppercase letters (Caps Lock) still count
    for (const x of SEQ.slice(0, 8)) k.feed(key(x));
    k.feed(key('B')); k.feed(key('A'));
    expect(hits).toBe(2);
  });

  it('ignores keys typed in fields, modifier chords and auto-repeat', () => {
    let hits = 0;
    const k = eggs.createKonami(() => hits++);
    const field = document.createElement('input');
    field.type = 'text';
    SEQ.forEach(x => k.feed(key(x, { target: field })));
    expect(hits).toBe(0);
    SEQ.slice(0, 9).forEach(x => k.feed(key(x)));
    k.feed(key('a', { target: field }));
    expect(hits).toBe(0);
    SEQ.slice(0, 9).forEach(x => k.feed(key(x)));
    k.feed(key('a', { ctrlKey: true }));
    expect(hits).toBe(0);
    SEQ.forEach((x, i) => { k.feed(key(x)); if (i === 3) k.feed(key(x, { repeat: true })); });
    expect(hits).toBe(1);
  });
});

describe('burst counters', () => {
  it('logo: seven taps within the window, not slower', () => {
    const c = eggs.createLogoCounter();
    let t = 1000;
    for (let i = 0; i < 6; i++) expect(c.hit(t += 300)).toBe(false);
    expect(c.hit(t += 300)).toBe(true);
    // starts over after a match
    expect(c.hit(t += 100)).toBe(false);
    const slow = eggs.createLogoCounter();
    let s = 0;
    for (let i = 0; i < 14; i++) expect(slow.hit(s += eggs.LOGO_WINDOW_MS / 6 + 10)).toBe(false);
  });

  it('drops: ten within 30 seconds', () => {
    const c = eggs.createDropCounter();
    let t = 0;
    for (let i = 0; i < 9; i++) expect(c.hit(t += 3000)).toBe(false);
    expect(c.hit(t += 2900)).toBe(true);
    const spread = eggs.createDropCounter();
    let u = 0;
    for (let i = 0; i < 20; i++) expect(spread.hit(u += 3400)).toBe(false);
  });
});

describe('tempo eggs', () => {
  it('404 is not found and keeps the tempo; other values parse as before', () => {
    let missing = 0;
    const parse = eggs.tempoParser(() => missing++);
    expect(Number.isNaN(parse(' 404 '))).toBe(true);
    expect(missing).toBe(1);
    expect(parse('120')).toBe(120);
    expect(parse('99,5')).toBe(99.5);
    expect(parse('400')).toBe(400);
    expect(missing).toBe(1);
  });

  it('the tempo field keeps its previous tempo when 404 is typed', async () => {
    const { createDragNumber } = await import('../../src/ui/controls.js');
    let tempo = 128;
    const subs = new Set();
    const binding = {
      def: { id: 'tempo', label: 'Tempo', min: 20, max: 400, default: 120 },
      get: () => tempo, set: (v) => { tempo = v; for (const f of subs) f(); }, subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    };
    let missing = 0;
    const num = createDragNumber({}, binding, { parse: eggs.tempoParser(() => missing++) });
    num.input.blur = () => {};
    const enter = (text) => { num.input.value = text; num.input.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {}, stopPropagation() {} }); };
    enter('404');
    expect(tempo).toBe(128);
    expect(missing).toBe(1);
    enter('405');
    expect(tempo).toBe(400);
    num.dispose();
  });

  it('303 offers the acid patch only when the person set it', () => {
    expect(eggs.isAcidTempo(303, { source: 'ui' })).toBe(true);
    expect(eggs.isAcidTempo(303, { source: 'preset' })).toBe(false);
    expect(eggs.isAcidTempo(303, undefined)).toBe(false);
    expect(eggs.isAcidTempo(302, { source: 'ui' })).toBe(false);
  });
});

describe('toasts', () => {
  it('shows one at a time', () => {
    const shown = [];
    const queue = [];
    const timers = { setTimeout: (f) => { queue.push(f); return queue.length; }, clearTimeout() {} };
    const t = eggs.createFunToaster((m) => { shown.push(m); return () => {}; }, timers);
    t.say('one'); t.say('two'); t.say('three');
    expect(shown).toEqual(['one']);
    queue.shift()();
    expect(shown).toEqual(['one', 'two']);
    queue.shift()();
    queue.shift()();
    expect(shown).toEqual(['one', 'two', 'three']);
    expect(t.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------- catalog

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');
function sources(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('fun catalog', () => {
  it('has unique, valid ids with names and hints, and no em dashes', () => {
    for (const listOf of [SECRETS, BADGES]) {
      const ids = listOf.map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of listOf) {
        expect(e.id).toMatch(/^[a-z0-9-]{1,40}$/);
        expect(e.name.length).toBeGreaterThan(0);
        expect(e.hint.length).toBeGreaterThan(0);
        expect(`${e.name} ${e.hint}`).not.toMatch(/\u2014/);
      }
    }
  });

  it('lists every badge id used in the source', () => {
    const used = new Set();
    for (const f of sources()) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/found\(\s*['"]badge['"]\s*,\s*['"]([a-z0-9-]+)['"]/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter(id => !catalogEntry('badge', id));
    expect(missing).toEqual([]);
    for (const id of ['golf-first-hole', 'golf-hole-in-one', 'golf-under-par', 'golf-round', 'seed-word', 'night-owl', 'met-pet',
      'postcard-sent', 'postcard-opened', 'ghost-recorded', 'place-earth', 'place-moon', 'place-mars', 'night-sky', 'weather', 'data-terrain',
      'first-drop', 'soaked', 'notes-1000', 'repair-crew']) expect(catalogEntry('badge', id)).not.toBe(null);
  });

  it('lists every secret the app reveals, and every listed secret can be found', () => {
    const revealed = new Set(), recorded = new Set();
    for (const f of sources()) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:reveal|record)\(\s*'([a-z0-9-]+)'/g)) revealed.add(m[1]);
      for (const m of text.matchAll(/found\(\s*['"]secret['"]\s*,\s*['"]([a-z0-9-]+)['"]/g)) recorded.add(m[1]);
    }
    expect([...revealed].filter(id => !catalogEntry('secret', id))).toEqual([]);
    expect(SECRETS.filter(s => !revealed.has(s.id) && !recorded.has(s.id)).map(s => s.id)).toEqual([]);
  });

  it('counts unlisted finds and hides the rest behind hints', () => {
    found('secret', 'konami', 5);
    found('secret', 'made-up-secret', 6);
    const p = progress('secret', list('secret'));
    expect(p.found).toBe(2);
    expect(p.total).toBe(SECRETS.length + 1);
    expect(p.earned.map(e => e.name)).toEqual(['Cabinet code', 'Unlisted']);
    expect(p.missing.length).toBe(SECRETS.length - 1);
    expect(p.missing.every(m => m.hint && !('name' in m))).toBe(true);
    expect(findName('badge', 'nope')).toBe('Unlisted');
  });

  it('Bookkeeping lists secrets and badges, unearned as ???', async () => {
    const { createFunProgress } = await import('../../src/ui/fun-progress.js');
    const view = createFunProgress();
    const text = () => [...view.el.walk()].map(e => e.textContent).join('|');
    expect(text()).toContain(`Secrets found: 0 of ${SECRETS.length}`);
    expect(text()).toContain('???');
    found('secret', 'konami', Date.UTC(2026, 0, 2));
    found('badge', 'first-drop', Date.UTC(2026, 0, 2));
    expect(text()).toContain(`Secrets found: 1 of ${SECRETS.length}`);
    expect(text()).toContain('Cabinet code');
    expect(text()).toContain('First drop');
    view.dispose();
  });
});
