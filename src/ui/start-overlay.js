// First-run overlay. Browsers only let audio start after a user gesture, so
// this invites one: a Start button, plus any first click or key press anywhere
// starts audio too. It sits over the live 3D view without hiding it.

import { h, createScope } from './dom.js';
import { brandGlyph, icon } from './icons.js';

export function createStartOverlay(ctx, host) {
  const scope = createScope();
  const hasEngine = ctx.audioOk ? ctx.audioOk() : !!ctx.engine;
  const startBtn = h('button', { type: 'button', class: 'btn btn--primary btn--xl start-btn', dataset: { action: 'start' }, html: icon('play') + `<span>${hasEngine ? 'Start' : 'Explore'}</span>` });
  const tips = [
    ['pin', 'Click the map to move the dot'],
    ['sliders', 'Twist the knobs'],
    ['keyboard', 'Press Play, or play the keys A W S E D...'],
  ];
  const card = h('div', { class: 'start-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'start-title', 'aria-describedby': 'start-desc' },
    h('div', { class: 'start-mark', html: brandGlyph(44) }),
    h('h1', { class: 'start-title', id: 'start-title' }, 'ORO'),
    h('p', { class: 'start-desc', id: 'start-desc' }, 'A 3D wave terrain synthesizer: the sound is the land under a moving dot.'),
    startBtn,
    hasEngine ? null : h('p', { class: 'start-warn' }, 'Audio could not start in this browser, but you can still explore the map and controls.'),
    h('ul', { class: 'start-tips' }, tips.map(([ic, t]) => h('li', null, h('span', { html: icon(ic) }), t))));
  const el = h('div', { class: 'start-overlay' }, card);
  host.appendChild(el);

  let done = false;
  async function dismiss() {
    if (done) return;
    done = true;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 420);
    scope.dispose();
    await ctx.startAudio();
  }
  scope.on(startBtn, 'click', (e) => { e.stopPropagation(); dismiss(); });
  // Any first interaction anywhere also starts audio (and still does its job).
  scope.on(document, 'pointerdown', (e) => { if (!card.contains(e.target)) dismiss(); }, true);
  scope.on(document, 'keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'Shift' || e.metaKey || e.ctrlKey || e.altKey) return;
    dismiss();
  }, true);
  requestAnimationFrame(() => el.classList.add('is-in'));

  return { el, dismiss, isOpen: () => !done };
}
