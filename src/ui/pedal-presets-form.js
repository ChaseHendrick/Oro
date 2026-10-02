// The compact "Pedal presets" section of the scene and patch save forms, and
// the small editor for the pedal presets of a saved scene or patch (v1.1).
// One number per pedal that takes Program Change; an empty box means "leave
// that pedal as it is". Numbers keep each profile's meaning (the Lost + Found's
// 0 is Live), and are checked against the profile's range before saving.

import { h, uniqueId } from './dom.js';
import { openPopover } from './layers.js';
import { PEDAL_PROFILES, checkProgram } from '../pedals/profiles.js';
import { PRESET_PEDAL_IDS, sanitizePedalPresets, programHint, shortName } from '../pedals/pedal-presets.js';

const NOTES = {
  scene: 'Sent as Program Change on each pedal\'s channel when the scene loads, to the pedals switched on in Settings > Pedals. Leave a box empty to leave that pedal as it is.',
  patch: 'Sent when this patch loads only while Settings > Pedals > Patches recall pedal presets is on. Leave a box empty to leave that pedal as it is.',
};

/**
 * @param {object} ctx  needs ctx.pedals (the pedal rig); without it there is nothing to show
 * @param {{kind?: 'scene'|'patch', initial?: object|null, open?: boolean}} [o]
 * @returns {null | {el: HTMLElement, read: () => {ok: boolean, value?: object|null, reason?: string}, fill: (map: object|null) => void, touched: () => boolean}}
 */
export function createPedalPresetFields(ctx, { kind = 'scene', initial = null, open } = {}) {
  const rig = ctx && ctx.pedals;
  if (!rig || !rig.prefs) return null;
  const prefs = rig.prefs;
  let base = sanitizePedalPresets(initial) || {};
  // Pedals switched on, plus any the stored presets mention (so editing never hides them).
  const ids = PRESET_PEDAL_IDS.filter(id => (prefs.pedals[id] && prefs.pedals[id].enabled) || base[id] != null);
  if (!ids.length) return null;
  let touched = false;
  const inputs = new Map();
  const rows = h('div', { class: 'pedal-presets-rows' });
  for (const id of ids) {
    const p = PEDAL_PROFILES[id];
    const inputId = uniqueId('pp');
    const on = !!(prefs.pedals[id] && prefs.pedals[id].enabled);
    const input = h('input', {
      id: inputId, class: 'field field--sm', type: 'number', inputmode: 'numeric', step: '1',
      min: String(p.programs.min), max: String(p.programs.max), placeholder: 'Leave',
      value: base[id] != null ? String(base[id]) : '', 'aria-label': `${p.name} preset to recall (empty leaves it as it is)`,
    });
    input.addEventListener('input', () => { touched = true; input.removeAttribute('aria-invalid'); });
    inputs.set(id, input);
    rows.append(
      h('label', { class: 'pedal-presets-name', for: inputId }, shortName(id), h('small', null, programHint(id) + (on ? '' : '. Switched off here'))),
      input);
  }
  const last = typeof rig.lastPrograms === 'function' ? rig.lastPrograms() : {};
  const known = ids.filter(id => last[id] != null);
  const fillBtn = known.length ? h('button', { type: 'button', class: 'btn btn--ghost btn--xs' }, 'Use the presets last sent') : null;
  if (fillBtn) fillBtn.addEventListener('click', () => { for (const id of known) inputs.get(id).value = String(last[id]); touched = true; });
  const el = h('details', { class: 'pedal-presets', open: open ?? Object.keys(base).length > 0 },
    h('summary', null, 'Pedal presets'),
    h('p', { class: 'popover-note' }, NOTES[kind] || NOTES.scene),
    rows, fillBtn);

  return {
    el,
    touched: () => touched,
    /** Show another stored set (e.g. the scene whose name was typed). */
    fill(map) {
      base = sanitizePedalPresets(map) || {};
      for (const [id, input] of inputs) { input.value = base[id] != null ? String(base[id]) : ''; input.removeAttribute('aria-invalid'); }
      if (Object.keys(base).length) el.open = true;
    },
    /** The presets to store (null for none), or the first problem. */
    read() {
      const out = {};
      // Pedals not shown here keep what the stored set had.
      for (const [id, v] of Object.entries(base)) if (!inputs.has(id)) out[id] = v;
      for (const [id, input] of inputs) {
        const raw = String(input.value || '').trim();
        if (!raw) continue;
        const n = Number(raw);
        const c = checkProgram(PEDAL_PROFILES[id], n);
        if (!c.ok) {
          input.setAttribute('aria-invalid', 'true');
          el.open = true;
          return { ok: false, reason: c.reason, input };
        }
        out[id] = n;
      }
      return { ok: true, value: Object.keys(out).length ? out : null };
    },
  };
}

/**
 * Edit only the pedal presets of one of your own scenes or patches.
 * @param {{id: string, name: string, pedalPresets?: object|null}} item
 */
export function openPedalPresetEditor(ctx, anchor, kind, item) {
  const { presets } = ctx;
  if (!presets || typeof presets.setPedalPresets !== 'function' || !item) return null;
  const fields = createPedalPresetFields(ctx, { kind, initial: item.pedalPresets, open: true });
  if (!fields) {
    ctx.toast('Switch on a pedal that takes presets in Settings > Pedals first', { kind: 'info' });
    return null;
  }
  const go = h('button', { type: 'submit', class: 'btn btn--primary btn--sm' }, 'Save');
  const form = h('form', { class: 'save-form' },
    h('div', { class: 'popover-title' }, `Pedal presets: ${item.name}`),
    fields.el,
    h('div', { class: 'save-row' }, go));
  let pop;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const r = fields.read();
    if (!r.ok) { ctx.toast(r.reason, { kind: 'error' }); if (r.input) r.input.focus(); return; }
    if (presets.setPedalPresets(kind, item.id, r.value)) ctx.toast(`Saved the pedal presets of "${item.name}"`, { kind: 'success' });
    else ctx.toast('Could not save', { kind: 'error' });
    pop.close('saved');
  });
  pop = openPopover(ctx.layers, anchor, form, { className: 'popover--save', label: 'Pedal presets', placement: 'bottom-start' });
  const first = form.querySelector('input');
  if (first) first.focus();
  return pop;
}
