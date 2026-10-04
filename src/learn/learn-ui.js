import { h, createScope, setText } from '../ui/dom.js';
import { LESSONS } from './lessons.js';
import { glossaryEntry } from './glossary.js';
import { createProgress } from './progress.js';
import { highlightSelector } from './targets.js';
import { applySetup, runCheck } from './engine.js';
import '../styles/learn.css';

export { highlightSelector };

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function renderText(text, onTerm) {
  const frag = [];
  const re = /\[\[([A-Za-z0-9-]+)\|([^\]]+)\]\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.push(document.createTextNode(text.slice(last, m.index)));
    const id = m[1].toLowerCase();
    const btn = h('button', { type: 'button', class: 'learn-term' }, m[2]);
    btn.addEventListener('click', () => onTerm(id));
    frag.push(btn);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.push(document.createTextNode(text.slice(last)));
  return frag;
}

export function createLearn(ctx = {}) {
  const scope = createScope();
  const progress = createProgress(ctx.storage || memoryStorage());
  const live = h('div', { class: 'learn-live', 'aria-live': 'polite' });
  const body = h('div', { class: 'learn-body' });
  const el = h('aside', { class: 'learn-card', hidden: true, 'aria-label': 'Learn' },
    h('header', { class: 'learn-head' }, h('h2', null, 'Learn'), h('button', { type: 'button', class: 'btn btn--ghost btn--sm learn-close' }, 'Close')),
    live, body);
  el.hidden = true;
  let lesson = null;
  let highlighted = null;

  function clearHighlight() {
    if (highlighted) { highlighted.classList.remove('learn-target'); highlighted = null; }
    el.dataset.highlight = '';
  }

  function applyActions(actions) {
    if (!ctx.store || !actions || !actions.length) return;
    const rest = actions.filter((a) => a.type !== 'tab' && a.type !== 'quality');
    if (rest.length) {
      try {
        const base = ctx.store.serialize ? ctx.store.serialize() : ctx.store.get('');
        ctx.store.load(applySetup(base, rest), { source: 'learn' });
      } catch { /* the lesson text still shows */ }
    }
    for (const a of actions) {
      if (a.type === 'tab') ctx.store.set('ui.panel', a.id, { source: 'learn' });
      if (a.type === 'quality') ctx.store.set('ui.audioQuality', a.id, { source: 'learn' });
    }
  }

  function endLesson() {
    clearHighlight();
    if (typeof ctx.onLessonEnd === 'function') ctx.onLessonEnd(snapshot);
    if (ctx.history && ctx.history.pause) ctx.history.pause(false);
    if (typeof ctx.pauseVersions === 'function') ctx.pauseVersions(false);
    snapshot = null;
  }
  let index = 0;
  let before = null;
  let snapshot = null;

  function showList() {
    if (snapshot) endLesson();
    lesson = null;
    body.replaceChildren(...LESSONS.map((item) => {
      const b = h('button', { type: 'button', class: 'learn-item' },
        h('span', { class: 'learn-item-title' }, item.title),
        h('span', { class: 'learn-item-meta' }, `${item.level} · ${item.minutes} min${progress.completed(item.id) ? ' · Done' : ''}`));
      b.addEventListener('click', () => openLesson(item));
      return b;
    }));
  }

  function openLesson(item) {
    lesson = item;
    index = 0;
    if (ctx.store && ctx.store.serialize) snapshot = ctx.store.serialize();
    if (typeof ctx.pauseVersions === 'function') ctx.pauseVersions(true);
    if (ctx.history && ctx.history.pause) ctx.history.pause(true);
    if (typeof ctx.onLessonStart === 'function') ctx.onLessonStart(snapshot);
    applyActions(item.setup);
    showStep();
  }

  function showStep() {
    const s = lesson.steps[index];
    setText(live, s.title);
    const paras = (s.text || []).map((t) => h('p', null, ...renderText(t, (id) => {
      const g = glossaryEntry(id);
      setText(live, g ? g.text : '');
    })));
    const hint = h('p', { class: 'learn-hint', hidden: true });
    hint.hidden = true;
    body.replaceChildren(
      h('h3', null, s.title),
      ...paras,
      hint,
      h('div', { class: 'learn-row' },
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: () => { hint.hidden = false; setText(hint, s.hint || 'Keep going.'); } }, 'Hint'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: () => advance(true) }, 'Skip'),
        h('button', { type: 'button', class: 'btn btn--sm', onClick: () => advance(false) }, index + 1 === lesson.steps.length ? 'Finish' : 'Next')));
    const sel = highlightSelector(s.highlight);
    el.dataset.highlight = sel || '';
    clearHighlight();
    el.dataset.highlight = sel || '';
    if (sel && typeof document.querySelector === 'function') {
      try {
        const node = document.querySelector(sel);
        if (node && node.classList) { node.classList.add('learn-target'); highlighted = node; }
      } catch { /* selector the page does not have */ }
    }
    applyActions(s.setup);
  }

  function advance(skip) {
    const s = lesson.steps[index];
    if (!skip && s.check && ctx.store) {
      const state = ctx.store.get('');
      if (!runCheck(s.check, state, before)) { setText(live, 'Not yet. Use Hint or Skip.'); return; }
    }
    before = ctx.store ? ctx.store.get('') : before;
    index++;
    if (index >= lesson.steps.length) {
      progress.mark(lesson.id);
      if (progress.allDone(LESSONS.map((l) => l.id)) && typeof ctx.found === 'function') ctx.found('badge', 'all-lessons');
      else if (typeof ctx.found === 'function') ctx.found('badge', 'lesson-complete');
      endLesson();
      showList();
      return;
    }
    showStep();
  }

  function close() {
    el.hidden = true;
    endLesson();
    showList();
  }

  scope.on(el.querySelector('.learn-close'), 'click', close);
  scope.on(el, 'keydown', (e) => { if (e.key === 'Escape') close(); });
  showList();

  return {
    el, close, highlightSelector, progress, applySetup,
    open() {
      el.hidden = false;
      if (!lesson) showList();
    },
    dispose: scope.dispose,
  };
}
