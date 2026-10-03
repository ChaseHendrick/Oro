// Formula terrains (v2.3): type z = f(x, y) and load it into terrain A or B
// (or both, with t = 0 in A and t = 1 in B so Morph animates t).
import { h, setText } from './dom.js';
import { openPopover } from './layers.js';
import { compileFormula, formulaHeights, FORMULA_EXAMPLES, FORMULA_FUNCTIONS, FORMULA_MAX_LENGTH } from '../dsp/formula.js';
import { heightsToPlanes } from '../audio/heightmap.js';
import { bytesToBase64, addUserTerrain } from '../audio/importers.js';

const SIZE = 512;

/** A UserTerrain built from a formula at time t (mirror-tiled so any formula wraps without a seam). */
export function formulaTerrain(src, t = 0, name = 'Formula') {
  const { heights, flat } = formulaHeights(src, SIZE, t);
  if (flat) throw new Error('That formula gives flat land: every point has the same height');
  const planes = heightsToPlanes(heights);
  return { name, kind: 'formula', formula: src, w: SIZE, h: SIZE, mirror: 1, data: bytesToBase64(planes.hi), lo: bytesToBase64(planes.lo) };
}

export function openFormulaTerrain(ctx, anchor, slot) {
  const part = ctx.binder.selected();
  const saved = ctx.store.get(`parts.${part}.userTerrain.${slot}`);
  const input = h('textarea', { class: 'field formula-field', rows: '3', maxlength: String(FORMULA_MAX_LENGTH), spellcheck: 'false', 'aria-label': 'Height formula', placeholder: 'sin(6*x) * cos(6*y)' });
  input.value = saved && saved.kind === 'formula' && saved.formula ? saved.formula : FORMULA_EXAMPLES[0].src;
  const msg = h('p', { class: 'popover-note', 'aria-live': 'polite' });
  const both = h('input', { type: 'checkbox' });
  const load = h('button', { type: 'button', class: 'btn btn--sm btn--primary' }, `Load into ${slot}`);
  const examples = h('div', { class: 'formula-examples' }, FORMULA_EXAMPLES.map(ex => {
    const b = h('button', { type: 'button', class: 'btn btn--ghost btn--xs' }, ex.name);
    b.addEventListener('click', () => { input.value = ex.src; check(); });
    return b;
  }));
  const body = h('div', { class: 'formula-pop' },
    h('div', { class: 'popover-title' }, `Formula terrain ${slot}`),
    h('p', { class: 'popover-note' }, 'Height z = f(x, y). x and y run from -1 to 1 across the tile; r and th are the distance from the centre and the angle. Use + - * / % ^, comparisons and ' + FORMULA_FUNCTIONS.join(', ') + '.'),
    input, examples,
    h('label', { class: 'formula-both' }, both, h('span', null, 'Fill A and B with t = 0 and t = 1, so Morph animates t')),
    h('div', { class: 'import-actions' }, load), msg);
  function check() {
    try { compileFormula(input.value); setText(msg, 'Looks good.'); load.disabled = false; return true; }
    catch (err) { setText(msg, err.message); load.disabled = true; return false; }
  }
  input.addEventListener('input', check);
  let pop = null;
  load.addEventListener('click', async () => {
    if (!check()) return;
    load.disabled = true; setText(msg, 'Building the land…');
    await new Promise(r => setTimeout(r, 0));
    try {
      const src = input.value.trim();
      if (both.checked) {
        await addUserTerrain(ctx.store, part, 'A', formulaTerrain(src, 0, 'Formula (t = 0)'), { source: 'ui' });
        await addUserTerrain(ctx.store, part, 'B', formulaTerrain(src, 1, 'Formula (t = 1)'), { source: 'ui' });
        ctx.toast('Loaded the formula into A and B: turn Morph to animate it', { kind: 'success' });
      } else {
        await addUserTerrain(ctx.store, part, slot, formulaTerrain(src, slot === 'B' ? 1 : 0), { source: 'ui' });
        ctx.toast(`Loaded the formula into terrain ${slot}`, { kind: 'success' });
      }
      pop.close('select');
    } catch (err) { setText(msg, err.message || 'The formula could not be built.'); load.disabled = false; }
  });
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--formula', label: `Formula terrain ${slot}`, placement: 'bottom-start', focus: 'textarea' });
  check();
  return pop;
}
