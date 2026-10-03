// SOUND tab: voice, filter, amp envelope and Envelope 2 for the selected part.

import { INHARMONIC_PROFILES } from '../core/params.js';
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

  const select = (id, label) => {
    const c = createSelect(ctx, binder.partParam(id), { label, className: 'select--sm' });
    scope.add(c.dispose);
    return h('label', { class: 'sound-field' }, h('span', { class: 'mini-label' }, label), c.el);
  };
  const noiseFile = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac', hidden: true });
  const noiseImport = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Import noise recording');
  const noiseName = h('span', { class: 'section-aside' });
  const refreshNoise = () => { noiseName.textContent = ctx.store.get(`parts.${binder.selected()}.noiseRecording`)?.name || 'Up to 16 seconds, looped'; };
  scope.on(noiseImport, 'click', () => noiseFile.click());
  scope.on(noiseFile, 'change', async () => {
    const file = noiseFile.files?.[0]; noiseFile.value = ''; if (!file) return;
    const part = binder.selected(); noiseImport.disabled = true;
    try { await ctx.engine.importNoiseFile(part, file); ctx.toast('Noise recording imported', { kind: 'info' }); }
    catch (err) { ctx.toast(err.message || 'Could not import audio', { kind: 'error' }); }
    finally { noiseImport.disabled = false; }
  });
  scope.add(ctx.store.subscribe('parts', refreshNoise));
  scope.add(ctx.store.subscribe('ui.selectedPart', refreshNoise)); refreshNoise();

  const mode = createSegmented(ctx, binder.partParam('polyMode'), { label: 'Voice mode', size: 'sm' });
  const ftype = createSelect(ctx, binder.partParam('filterType'), { label: 'Filter type', className: 'select--sm select--filter' });
  scope.add(mode.dispose);
  scope.add(ftype.dispose);

  const amp = createEnvGraph(ctx, { ids: ['attack', 'decay', 'sustain', 'release'], label: 'Amp six-stage envelope shape', delayId: 'ampDelay', holdId: 'ampHold', modeId: 'ampMode' });
  const env2 = createEnvGraph(ctx, { ids: ['env2Attack', 'env2Decay', 'env2Sustain', 'env2Release'], label: 'Envelope 2 six-stage shape', delayId: 'env2Delay', holdId: 'env2Hold', modeId: 'env2Mode' });
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
        ...['octave', 'tune', 'fine', 'glide', 'bendRange', 'unison', 'detune', 'spread', 'velSens'].map(id => k(id, { size: 'sm' })))),
    card('Unison', null,
      h('div', { class: 'sound-selects' }, select('unisonMode', 'Unison spread'), select('unisonStack', 'Unison stack')),
      h('div', { class: 'knob-row' }, k('unisonBlend'), k('unisonMap'))),
    card('Sub oscillators', null,
      h('div', { class: 'sound-selects' }, select('subWave', 'One octave down'), select('sub2Wave', 'Two octaves down')),
      h('div', { class: 'knob-row' }, k('sub'), k('sub2'))),
    card('Noise', select('airType', 'Noise type'),
      h('div', { class: 'knob-row' }, k('air'), k('airTone'), k('airTexture', { label: 'Position', ariaLabel: () => 'Texture position' })),
      h('div', { class: 'sound-selects' }, noiseImport, noiseFile, noiseName)),
    card('Partial profiles', h('span', { class: 'section-aside' }, '11 original ratio banks'),
      h('div', { class: 'knob-row' }, k('inharmProfile', { label: 'Profile', ariaLabel: () => 'Partial profile', format: v => {
        const i = Math.floor(v), next = Math.min(10, i + 1), fraction = v - i;
        return fraction < 0.01 ? INHARMONIC_PROFILES[i] : `${INHARMONIC_PROFILES[i]} / ${INHARMONIC_PROFILES[next]} ${Math.round(fraction * 100)}%`;
      } }), k('inharmAmount'))),
    card('Phase and ring modulation', null,
      h('div', { class: 'knob-grid knob-grid--4' }, ...['phaseMod','phaseRatio','ringMod','ringRatio'].map(id => k(id, { size: 'sm' })))),
    card('Karplus-Strong pluck', null,
      h('div', { class: 'knob-grid knob-grid--4' }, ...['pluck','pluckDecay','pluckTone','pluckDispersion'].map(id => k(id, { size: 'sm' })))),
    card('Filter', ftype.el,
      h('div', { class: 'filter-grid' },
        k('cutoff', { size: 'lg', className: 'is-hero' }), k('resonance'), k('drive'), k('filterEnv'), k('keyTrack'), formantKnob)),
    card('Filter 2', select('filter2Type', 'Filter 2 type'),
      h('div', { class: 'sound-selects' }, select('filterRoute', 'Filter routing')),
      h('div', { class: 'filter-grid' },
        k('filter2Cutoff', { size: 'lg', className: 'is-hero', ariaLabel: () => 'Filter 2 cutoff' }), k('filter2Reso', { ariaLabel: () => 'Filter 2 resonance' }),
        k('filter2Env', { ariaLabel: () => 'Filter 2 envelope amount' }), k('filter2Key', { ariaLabel: () => 'Filter 2 key tracking' }), k('filter2Mix', { ariaLabel: () => 'Filter 2 mix' }))),
    card('Amp envelope', select('ampMode', 'Amp envelope mode'),
      h('div', { class: 'env-wrap' }, amp.el),
      h('div', { class: 'knob-row knob-row--env' }, ['ampDelay','attack','ampHold','decay','sustain','release'].map(id => amp4('Amp')(id)))),
    card('Envelope 2', select('env2Mode', 'Envelope 2 mode'),
      h('div', { class: 'env-wrap' }, env2.el),
      h('div', { class: 'knob-row knob-row--env' }, ['env2Delay','env2Attack','env2Hold','env2Decay','env2Sustain','env2Release'].map(id => amp4('Envelope 2')(id)))));

  return { el, dispose: scope.dispose };
}
