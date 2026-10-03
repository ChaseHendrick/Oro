// v2.9 Settings > Operator > Bookkeeping: secrets found so far (with a vague
// hint for each one still hidden) and the badges, earned ones with their date,
// the rest as "???" with a hint. Reads src/core/fun.js, lists from
// src/core/fun-catalog.js. Kept on this computer only.

import { h } from './dom.js';
import { list, onFun } from '../core/fun.js';
import { progress } from '../core/fun-catalog.js';

const date = (at) => (at > 0 ? new Date(at).toLocaleDateString() : '');

export function createFunProgress() {
  const secretsHead = h('h4', { class: 'op-subtitle' });
  const secretList = h('ul', { class: 'fun-list', 'aria-label': 'Secrets' });
  const badgesHead = h('h4', { class: 'op-subtitle' });
  const badgeList = h('ul', { class: 'fun-list', 'aria-label': 'Badges' });

  function item(name, note, earned) {
    return h('li', { class: ['fun-item', earned ? 'is-earned' : 'is-hidden'] },
      h('span', { class: 'fun-name' }, name), note ? h('span', { class: 'fun-note' }, note) : null);
  }

  function render() {
    const s = progress('secret', list('secret'));
    const b = progress('badge', list('badge'));
    secretsHead.textContent = `Secrets found: ${s.found} of ${s.total}`;
    secretList.replaceChildren(
      ...s.earned.map(e => item(e.name, date(e.at), true)),
      ...s.missing.map(m => item('???', m.hint, false)));
    badgesHead.textContent = `Badges: ${b.found} of ${b.total}`;
    badgeList.replaceChildren(
      ...b.earned.map(e => item(e.name, date(e.at), true)),
      ...b.missing.map(m => item('???', m.hint, false)));
  }
  const off = onFun(render);
  render();

  const el = h('div', { class: 'fun-progress' }, secretsHead, secretList, badgesHead, badgeList);
  return { el, render, dispose: off };
}
