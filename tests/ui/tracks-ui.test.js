// Track tabs, mixer strips, the track menu and the sequencer's pattern picker
// on a fake DOM (v1.3): the right number of tabs and strips for the track
// list, Add / Duplicate / Move / Remove (with Undo), and pattern switching.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createStore } from '../../src/core/store.js';
import { MAX_PARTS, defaultState } from '../../src/core/params.js';
import { addTrack, removeTrack, moveTrack } from '../../src/core/tracks.js';

let dom, createTrackTabs, createMixPanel, createSeqPanel, createModPanel, createBinder, actions;
const saved = {};
beforeAll(async () => {
  dom = installFakeDom();
  saved.window = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document.documentElement = { dataset: { theme: 'dark' } };
  globalThis.document.body = globalThis.document.createElement('body');   // knobs keep a shared SVG def there
  ({ createTrackTabs } = await import('../../src/ui/track-tabs.js'));
  ({ createMixPanel } = await import('../../src/ui/mix-panel.js'));
  ({ createSeqPanel } = await import('../../src/ui/seq-panel.js'));
  ({ createModPanel } = await import('../../src/ui/mod-panel.js'));
  ({ createBinder } = await import('../../src/ui/bind.js'));
  actions = await import('../../src/ui/track-actions.js');
});
afterAll(() => { dom.restore(); globalThis.window = saved.window; });

function makeCtx(tracks = 4) {
  const store = createStore(defaultState(tracks));
  const toasts = [];
  const ctx = {
    store, binder: createBinder(store), panelBg: () => ['#151a26', '#1c2232'],
    notes: null, tele: null, music: null, layers: null, midiOk: () => false, findMapping: () => null,
    toast: vi.fn((msg, opts) => { toasts.push({ msg, opts }); }),
  };
  return { ctx, store, toasts };
}

const visibleTabs = (tabs) => tabs.el.querySelectorAll('button.part-tab').filter(t => !t.hidden);

describe('modulation on later tracks', () => {
  it('refreshes the count and Clear all after editing track 16', () => {
    const { ctx, store } = makeCtx(16);
    store.set('ui.selectedPart', 15);
    const panel = createModPanel(ctx);
    const clear = panel.el.querySelector('button.btn--xs');
    expect(clear.disabled).toBe(true);
    store.set('parts.15.mods.morph.lfoDepth', .3);
    dom.flush();
    expect(panel.el.querySelector('.mod-count').textContent).toBe('1 parameter moving');
    expect(clear.disabled).toBe(false);
    clear.click(); dom.flush();
    expect(store.get('parts.15.mods.morph.lfoDepth')).toBe(0);
    expect(clear.disabled).toBe(true);
    panel.dispose();
  });
});

describe('track tabs', () => {
  it('shows one tab per track and follows adds, removes and reorders', () => {
    const { ctx, store } = makeCtx();
    const tabs = createTrackTabs(ctx);
    dom.flush();
    expect(tabs.el.querySelectorAll('button.part-tab')).toHaveLength(MAX_PARTS);
    expect(visibleTabs(tabs)).toHaveLength(4);
    tabs.el.querySelector('button.part-tab-add').click();
    dom.flush();
    expect(visibleTabs(tabs)).toHaveLength(5);
    expect(store.get('ui.selectedPart')).toBe(4);
    expect(visibleTabs(tabs)[4].getAttribute('aria-checked')).toBe('true');
    expect(visibleTabs(tabs)[4].getAttribute('aria-label')).toBe('Track 5, Init');
    store.set('parts.0.name', 'Bass');
    moveTrack(store, 0, 4);
    dom.flush();
    expect(visibleTabs(tabs)[4].getAttribute('aria-label')).toBe('Bass, Init');
    removeTrack(store, 4);
    dom.flush();
    expect(visibleTabs(tabs)).toHaveLength(4);
    while (addTrack(store) >= 0);
    dom.flush();
    expect(visibleTabs(tabs)).toHaveLength(MAX_PARTS);
    expect(tabs.el.querySelector('button.part-tab-add').disabled).toBe(true);
    tabs.dispose();
  });

  it('moves the focused track with Alt+arrows and selects with arrows', () => {
    const { ctx, store } = makeCtx(3);
    const tabs = createTrackTabs(ctx);
    dom.flush();
    const scroller = tabs.el.querySelector('div.part-tabs-scroll');
    const t = visibleTabs(tabs);
    t[0].focus();
    const key = (k, altKey = false) => scroller.dispatchEvent({ type: 'keydown', key: k, altKey, preventDefault() {}, stopPropagation() {} });
    key('ArrowRight');
    expect(store.get('ui.selectedPart')).toBe(1);
    t[1].focus();
    key('ArrowRight', true);
    expect(store.get('parts').map(p => p.id)).toEqual(['t1', 't3', 't2']);
    expect(store.get('ui.selectedPart')).toBe(2);
    tabs.dispose();
  });
});

describe('track actions', () => {
  it('removes with Undo, never the last track, and says when the list is full', () => {
    const { ctx, store, toasts } = makeCtx(2);
    expect(actions.removeTrackAction(ctx, 0)).toBe(true);
    expect(store.get('parts').map(p => p.id)).toEqual(['t2']);
    expect(toasts[0].msg).toBe('Removed Track 1');
    toasts[0].opts.action.onClick();
    expect(store.get('parts').map(p => p.id)).toEqual(['t1', 't2']);
    removeTrack(store, 1);
    expect(actions.removeTrackAction(ctx, 0)).toBe(false);
    expect(toasts.at(-1).msg).toMatch(/at least one track/);
    while (addTrack(store) >= 0);
    expect(actions.addTrackAction(ctx)).toBe(-1);
    expect(toasts.at(-1).msg).toMatch(/16 tracks/);
    for (const t of toasts) expect(t.msg).not.toMatch(/\u2014/);
  });
});

describe('mixer strips', () => {
  it('builds one strip per track and an Add track tile', () => {
    const { ctx, store } = makeCtx(6);
    const mix = createMixPanel(ctx);
    dom.flush();
    const strips = () => mix.el.querySelectorAll('section.strip');
    expect(strips()).toHaveLength(6);
    expect(strips()[5].getAttribute('aria-label')).toBe('Track 6 channel');
    mix.el.querySelector('button.strip-add').click();
    dom.flush();
    expect(strips()).toHaveLength(7);
    removeTrack(store, 0); removeTrack(store, 0);
    dom.flush();
    expect(strips()).toHaveLength(5);
    // the last strip reads the track now at its index
    store.set('parts.4.name', 'Last');
    dom.flush();
    expect(strips()[4].querySelector('button.strip-name').textContent).toBe('Last');
    mix.dispose();
  });
});

describe('sequencer pattern picker', () => {
  it('lists the track\'s patterns, adds a copy, switches and removes', () => {
    const { ctx, store } = makeCtx();
    store.set('ui.selectedPart', 2);
    store.set('parts.2.patterns.0.steps.3.on', 1);
    const seq = createSeqPanel(ctx);
    dom.flush();
    const select = seq.el.querySelector('div.seq-pattern-pick').querySelector('select');
    expect(select.options.map(o => o.textContent)).toEqual(['Pattern 1']);
    const [add, del] = seq.el.querySelector('div.seq-patterns').querySelectorAll('button');
    expect(del.disabled).toBe(true);
    add.click();
    dom.flush();
    expect(store.get('parts.2.patterns')).toHaveLength(2);
    expect(store.get('parts.2.activePattern')).toBe(1);
    expect(select.options.map(o => o.textContent)).toEqual(['Pattern 1', 'Pattern 2']);
    // the grid edits the active pattern
    const pad = seq.el.querySelectorAll('button.seq-pad')[5];
    pad.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, pointerId: 1, preventDefault() {} });
    expect(store.get('parts.2.patterns.1.steps.5.on')).toBe(1);
    expect(store.get('parts.2.patterns.0.steps.5.on')).toBe(0);
    select.value = '0';
    select.dispatchEvent({ type: 'change' });
    expect(store.get('parts.2.activePattern')).toBe(0);
    del.disabled = false;
    del.click();
    dom.flush();
    expect(store.get('parts.2.patterns').map(p => p.id)).toEqual(['p2']);
    seq.dispose();
  });
});
