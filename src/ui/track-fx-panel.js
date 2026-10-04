import { FX_TYPES, FX_TYPE_MAP, FX_ROUTINGS, defaultFxSlot, sanitizeTrackFx, formatFxParam, fxParamScale } from '../dsp/track-fx-config.js';
import { fromNorm, toNorm } from '../core/params.js';
import { h, createScope, setText } from './dom.js';
import { createKnob } from './knob.js';
import { icon } from './icons.js';

/** A native select dressed like the app's other selects. */
const selectBox = (select) => h('div', { class: 'select select--sm' }, select, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));

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
  const routing = h('select', { class: 'select-native', 'aria-label': 'Track effects routing' }, FX_ROUTINGS.map(r => option(r.id, r.name)));
  const sidechain = h('select', { class: 'select-native', 'aria-label': 'Track effects sidechain' });
  const diagram = h('div', { class: 'tfx-diagram', 'aria-label': 'Signal flow' });
  scope.on(routing, 'change', () => change(fx => { fx.routing = Number(routing.value); }));
  scope.on(sidechain, 'change', () => change(fx => { fx.sidechain = sidechain.value; }));
  const cards = [];
  const row = h('div', { class: 'track-fx-slots' });
  for (let slotIndex = 0; slotIndex < 4; slotIndex++) {
    const letter = String.fromCharCode(65 + slotIndex);
    const select = h('select', { class: 'select-native', 'aria-label': `Slot ${letter} effect` }, FX_TYPES.map(type => option(type.id, type.name)));
    const hint = h('p', { class: 'tfx-hint' });
    const mod = h('select', { class: 'select-native', 'aria-label': `Slot ${letter} modulator` });
    const modField = h('label', { class: 'tfx-field tfx-mod', hidden: true }, h('span', { class: 'mini-label' }, 'Modulator'), selectBox(mod));
    const voiceHint = h('p', { class: 'tfx-hint' }, 'Turn Voice on to use the microphone');
    const voiceBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Voice');
    const voiceRow = h('div', { class: 'tfx-voice', hidden: true }, voiceHint, voiceBtn);
    const knobs = h('div', { class: 'knob-row tfx-knobs' });
    const card = { select, hint, knobs, controls: [], type: '', key: '', slotIndex, letter, mod, modField, voiceRow, modKey: '' };
    cards.push(card);
    scope.on(select, 'change', () => change(fx => { fx.slots[slotIndex] = defaultFxSlot(select.value); }));
    scope.on(mod, 'change', () => change(fx => { if (fx.slots[slotIndex].type === 'vocoder') fx.slots[slotIndex].mod = mod.value; }));
    scope.on(voiceBtn, 'click', () => { if (typeof ctx.openSettings === 'function') ctx.openSettings('voice'); });
    row.appendChild(h('section', { class: 'fx-card tfx-card', 'aria-label': `Effect slot ${letter}` },
      h('div', { class: 'fx-title' }, h('span', null, `Slot ${letter}`), selectBox(select)), hint, modField, voiceRow, knobs));
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
      if (i && !label) continue;
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
      const slot = fx.slots[card.slotIndex];
      const type = FX_TYPE_MAP[slot.type];
      card.select.value = type.id; setText(card.hint, type.hint);
      const key = `${index}:${type.id}`;
      if (key !== card.key) { card.key = key; card.type = type.id; buildKnobs(card, type); }
      const isVoc = type.id === 'vocoder';
      card.modField.hidden = !isVoc;
      if (isVoc) {
        const modKey = tracks.map((track, i) => i === index || !track.id ? '' : `${track.id}:${track.name}`).join('|');
        if (modKey !== card.modKey) {
          card.modKey = modKey;
          card.mod.replaceChildren(option('mic', 'Microphone'),
            ...tracks.flatMap((track, i) => i === index || !track.id ? [] : [option(track.id, track.name || `Track ${i + 1}`)]));
        }
        const saved = slot.mod || 'mic';
        card.mod.value = Array.from(card.mod.options).some(o => o.value === saved) ? saved : 'mic';
        const voiceOn = !!(ctx.voice && ctx.voice.prefs && ctx.voice.prefs.enabled);
        const needVoice = (card.mod.value || 'mic') === 'mic' && !voiceOn;
        card.voiceRow.hidden = !needVoice;
      } else card.voiceRow.hidden = true;
    }
  }
  scope.add(store.subscribe('', changed => {
    if (affected(changed) || /^parts\.\d+\.(name|id)$/.test(changed)) render();
  }));
  if (ctx.voice && typeof ctx.voice.on === 'function') scope.add(ctx.voice.on('change', render));
  scope.add(() => { for (const card of cards) for (const control of card.controls) control.dispose(); });
  const el = h('section', { class: 'track-fx-panel', 'aria-label': 'Selected track effects' },
    h('header', { class: 'section-head tfx-head' }, title,
      h('label', { class: 'tfx-field' }, h('span', { class: 'mini-label' }, 'Routing'), selectBox(routing)), h('label', { class: 'tfx-field' }, h('span', { class: 'mini-label' }, 'Sidechain'), selectBox(sidechain))),
    diagram, h('p', { class: 'tfx-note' }, 'Four slots run before the track fader and sends. Parallel branches are averaged. Ducking uses the selected sidechain; other-track sidechains follow the previous audio block.'), row);
  render();
  return { el, dispose: scope.dispose };
}
