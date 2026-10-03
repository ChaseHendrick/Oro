import { FX_TYPES, FX_TYPE_MAP, FX_ROUTINGS, defaultFxSlot, sanitizeTrackFx, formatFxParam, fxParamScale } from '../dsp/track-fx-config.js';
import { fromNorm, toNorm } from '../core/params.js';
import { h, createScope, setText } from './dom.js';
import { createKnob } from './knob.js';

/** The selected track's persisted four-slot rack. The existing knobs provide
 * keyboard, wheel, drag, typed values and reset, just like the sound panel. */
export function createTrackFxPanel(ctx) {
  const { store } = ctx, scope = createScope();
  const option = (value, name) => { const el = h('option', null, name); el.setAttribute('value', String(value)); return el; };
  const selected = () => Math.max(0, Math.min((store.get('parts')?.length || 1) - 1, Math.round(Number(store.get('ui.selectedPart')) || 0)));
  const path = () => `parts.${selected()}.trackFx`;
  const config = () => sanitizeTrackFx(store.get(path()));
  const change = (edit) => { const fx = config(); edit(fx); store.set(path(), fx, { source: 'track-fx' }); };
  const title = h('h3', { class: 'section-title' }, 'Track effects');
  const routing = h('select', { class: 'select select--sm', 'aria-label': 'Track effects routing' }, FX_ROUTINGS.map(r => option(r.id, r.name)));
  const sidechain = h('select', { class: 'select select--sm', 'aria-label': 'Track effects sidechain' });
  const diagram = h('div', { class: 'mini-label', style: 'font-family:var(--font-mono,monospace);line-height:1.6' });
  scope.on(routing, 'change', () => change(fx => { fx.routing = Number(routing.value); }));
  scope.on(sidechain, 'change', () => change(fx => { fx.sidechain = sidechain.value; }));
  const cards = [];
  const row = h('div', { class: 'track-fx-slots', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px' });
  for (let slotIndex = 0; slotIndex < 4; slotIndex++) {
    const letter = String.fromCharCode(65 + slotIndex);
    const select = h('select', { class: 'select select--sm', 'aria-label': `Slot ${letter} effect` }, FX_TYPES.map(type => option(type.id, type.name)));
    const hint = h('p', { class: 'mini-label', style: 'margin:8px 0;min-height:2.8em;line-height:1.4' });
    const knobs = h('div', { class: 'knob-row', style: 'flex-wrap:wrap;justify-content:center;gap:4px' });
    const card = { select, hint, knobs, controls: [], type: '', key: '', slotIndex, letter };
    cards.push(card);
    scope.on(select, 'change', () => change(fx => { fx.slots[slotIndex] = defaultFxSlot(select.value); }));
    row.appendChild(h('section', { class: 'fx-card', 'aria-label': `Effect slot ${letter}`, style: 'min-width:0' },
      h('div', { class: 'fx-title', style: 'gap:8px' }, h('span', null, letter), select), hint, knobs));
  }

  function affected(changed) {
    const current = `parts.${selected()}`;
    return changed === '' || changed === 'parts' || changed === current || changed === 'ui' || changed === 'ui.selectedPart' || changed.startsWith(current + '.trackFx');
  }
  function binding(card, field, def) {
    return {
      def, scope: 'part', part: selected,
      get: () => fromNorm(def, config().slots[card.slotIndex][field]),
      set: (value) => change(fx => { fx.slots[card.slotIndex][field] = toNorm(def, value); }),
      subscribe: fn => store.subscribe('', changed => { if (affected(changed)) fn(); }),
    };
  }
  function buildKnobs(card, type) {
    for (const control of card.controls) control.dispose();
    card.controls.length = 0; card.knobs.replaceChildren();
    const fields = ['mix', 'p1', 'p2', 'p3', 'p4'];
    for (let i = 0; i < fields.length; i++) {
      const label = i ? type.params[i - 1] : 'Mix';
      const scale = i ? fxParamScale(type.id, i - 1) : { min: 0, max: 1, curve: 'lin' };
      const def = { id: `fx${card.slotIndex}${fields[i]}`, ...scale, label };
      def.default = fromNorm(def, i ? type.defaults[i - 1] : type.id === 'bypass' ? 0 : .5);
      const control = createKnob(ctx, binding(card, fields[i], def), {
        size: 'sm', caption: 'both', label, modulatable: false, learnable: false,
        ariaLabel: () => `Slot ${card.letter} ${type.name} ${label}`,
        format: i ? value => formatFxParam(type.id, i - 1, toNorm(def, value)) : value => Math.round(value * 100) + '%',
      });
      control.setDisabled(type.id === 'bypass', 'Choose an effect for this slot.');
      card.controls.push(control); card.knobs.appendChild(control.el);
    }
  }
  let tracksKey = '';
  function render() {
    const fx = config(), tracks = store.get('parts') || [], index = selected();
    const name = tracks[index]?.name || `Track ${index + 1}`;
    setText(title, `${name} effects`);
    routing.value = String(fx.routing); setText(diagram, FX_ROUTINGS[fx.routing].diagram);
    const nextKey = tracks.map((track, i) => `${track.id}:${track.name}:${i === index}`).join('|');
    if (nextKey !== tracksKey) {
      tracksKey = nextKey;
      sidechain.replaceChildren(option('self', 'This track'), option('mix', 'Other tracks together'),
        ...tracks.flatMap((track, i) => i === index || !track.id ? [] : [option(track.id, track.name || `Track ${i + 1}`)]));
    }
    sidechain.value = fx.sidechain;
    if (!Array.from(sidechain.options).some(option => option.value === fx.sidechain)) sidechain.value = 'self';
    for (const card of cards) {
      const type = FX_TYPE_MAP[fx.slots[card.slotIndex].type];
      card.select.value = type.id; setText(card.hint, type.hint);
      const key = `${index}:${type.id}`;
      if (key !== card.key) { card.key = key; card.type = type.id; buildKnobs(card, type); }
    }
  }
  scope.add(store.subscribe('', changed => {
    if (affected(changed) || /^parts\.\d+\.(name|id)$/.test(changed)) render();
  }));
  scope.add(() => { for (const card of cards) for (const control of card.controls) control.dispose(); });
  const el = h('section', { class: 'track-fx-panel', 'aria-label': 'Selected track effects', style: 'padding:14px 0' },
    h('header', { class: 'section-head', style: 'flex-wrap:wrap;gap:12px' }, title,
      h('label', { class: 'mini-label' }, 'Routing ', routing), h('label', { class: 'mini-label' }, 'Sidechain ', sidechain)),
    diagram, h('p', { class: 'mini-label', style: 'line-height:1.5;margin:6px 0 12px' }, 'Four slots run before the track fader and sends. Parallel branches are averaged. Ducking uses the selected sidechain; other-track sidechains follow the previous audio block.'), row);
  render();
  return { el, dispose: scope.dispose };
}
