// SOUND tab: voice, filter, amp envelope and Envelope 2 for the selected part.

import { h, createScope } from './dom.js';
import { createKnob } from './knob.js';
import { createSegmented, createSelect } from './controls.js';
import { schedule } from './frame.js';
import { createEnvGraph } from './env-graph.js';

function card(title, aside, ...children) {
  const id = 'sec-' + title.toLowerCase().replace(/\W+/g, '-');
  return h('section', { class: ['dock-card', `dock-card--${title.toLowerCase().replace(/\W+/g, '-')}`], 'aria-labelledby': id },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id }, title), aside), ...children);
}

export function createSoundPanel(ctx) {
  const scope = createScope();
  const { binder } = ctx;
  const k = (id, opts = {}) => {
    const knob = createKnob(ctx, binder.partParam(id), { size: 'md', ...opts });
    scope.add(knob.dispose);
    return knob.el;
  };

  const mode = createSegmented(ctx, binder.partParam('polyMode'), { label: 'Voice mode', size: 'sm' });
  const ftype = createSelect(ctx, binder.partParam('filterType'), { label: 'Filter type', className: 'select--sm select--filter' });
  scope.add(mode.dispose);
  scope.add(ftype.dispose);

  const amp = createEnvGraph(ctx, { ids: ['attack', 'decay', 'sustain', 'release'], label: 'Amp envelope shape' });
  const env2 = createEnvGraph(ctx, { ids: ['env2Attack', 'env2Decay', 'env2Sustain', 'env2Release'], label: 'Envelope 2 shape' });
  scope.add(amp.dispose);
  scope.add(env2.dispose);

  // Vowel only matters for the Comb and Vowel filters; dim it otherwise.
  const formantKnob = k('formant');
  const renderFormant = () => {
    const t = ctx.store.get(`parts.${binder.selected()}.params.filterType`) ?? 1;
    const used = t === 5 || t === 6;
    formantKnob.classList.toggle('is-dimmed', !used);
    formantKnob.querySelector('.knob-dial').dataset.tip = used ? (t === 5 ? 'Comb: blends positive and negative comb (the spread)' : 'Vowel: morphs A, E, I, O, U') : 'Used by the Comb and Vowel filter types';
  };
  scope.add(binder.partParam('filterType').subscribe(() => schedule(renderFormant)));
  renderFormant();

  const amp4 = (pfx) => (id, label) => k(id, { size: 'sm', ariaLabel: (l) => `${pfx} ${l}`, label });

  const el = h('div', { class: 'dock-pane dock-pane--sound' },
    card('Voice', mode.el,
      h('div', { class: 'knob-grid knob-grid--6' },
        ...['octave', 'tune', 'fine', 'glide', 'bendRange', 'sub', 'unison', 'detune', 'spread', 'velSens', 'air', 'airTone'].map(id => k(id, { size: 'sm' })))),
    card('Filter', ftype.el,
      h('div', { class: 'filter-grid' },
        k('cutoff', { size: 'lg', className: 'is-hero' }), k('resonance'), k('drive'), k('filterEnv'), k('keyTrack'), formantKnob)),
    card('Amp envelope', null,
      h('div', { class: 'env-wrap' }, amp.el),
      h('div', { class: 'knob-row knob-row--env' }, ['attack', 'decay', 'sustain', 'release'].map(id => amp4('Amp')(id)))),
    card('Envelope 2', h('span', { class: 'section-aside', dataset: { tip: 'Envelope 2 drives the filter Env Amt and every Env 2 depth in the MOD tab' } }, 'Filter + mod'),
      h('div', { class: 'env-wrap' }, env2.el),
      h('div', { class: 'knob-row knob-row--env' }, ['env2Attack', 'env2Decay', 'env2Sustain', 'env2Release'].map(id => amp4('Envelope 2')(id)))));

  return { el, dispose: scope.dispose };
}
