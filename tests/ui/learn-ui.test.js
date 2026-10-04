import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createLearn } from '../../src/learn/learn-ui.js';

let dom;
beforeEach(() => { dom = installFakeDom(); document.body = document.createElement('body'); });
afterEach(() => { dom.flush(); dom.restore(); });

describe('learn panel', () => {
  it('keeps the lesson in place when opened again, and restores on close', () => {
    const store = createStore(defaultState());
    const original = store.serialize();
    const ended = [];
    const ui = createLearn({
      store,
      onLessonEnd(snap) {
        ended.push(snap);
        if (snap) store.load(snap, { source: 'learn' });
      },
    });
    document.body.appendChild(ui.el);
    ui.open();
    ui.el.querySelector('.learn-item').click();
    expect(ui.el.textContent).toContain('One cycle');
    expect(store.serialize()).not.toEqual(original);
    ui.open();
    expect(ui.el.textContent).toContain('One cycle');
    expect(ended).toEqual([]);
    ui.close();
    expect(ended).toHaveLength(1);
    expect(store.serialize()).toEqual(original);
    ui.dispose();
  });
});
