// Sonify your data (2.10): paste numbers or drop a CSV, then play them as a
// terrain (into this slot) or as a melody (into the selected track's active
// pattern, in the global key and scale, one undo step). Data never leaves
// this computer.

import { h, setText } from './dom.js';
import { openPopover } from './layers.js';
import { addUserTerrain } from '../audio/importers.js';
import { heightsToUserTerrain } from '../audio/places.js';
import { parseData, seriesStats, seriesTerrain, gridTerrain, writeMelody, DATA_MAX_CHARS, DATA_MAX_ROWS } from '../music/data-sonify.js';
import { found } from '../core/fun.js';

const GRID = '__grid';
const fmt = (v) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : String(Number(v.toPrecision(5))));

export function openDataPanel(ctx, anchor, slot) {
  let parsed = null, timer = 0, pop;
  const text = h('textarea', { class: 'field data-text', rows: '6', spellcheck: 'false', 'aria-label': 'Your numbers or CSV', placeholder: 'One number per line, or paste a CSV table\n3\n7.5\n12\n9' });
  const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const openBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Open a CSV file');
  const column = h('select', { class: 'select-native', 'aria-label': 'Column to use' });
  const stats = h('p', { class: 'popover-note', 'aria-live': 'polite' }, 'Nothing pasted yet.');
  const asTerrain = h('button', { type: 'button', class: 'btn btn--sm', disabled: true }, 'As a terrain');
  const asMelody = h('button', { type: 'button', class: 'btn btn--sm', disabled: true }, 'As a melody');
  const body = h('div', { class: 'places-pop' },
    h('div', { class: 'popover-title' }, 'Sonify your data'),
    h('p', { class: 'popover-note' }, `Paste numbers or drop a CSV file (up to ${DATA_MAX_ROWS.toLocaleString('en-US')} rows). Your data stays on this computer.`),
    text, h('div', { class: 'data-row' }, openBtn, column, file), stats,
    h('div', { class: 'data-row' }, asTerrain, asMelody),
    h('p', { class: 'places-credit' }, `As a terrain: one column becomes a ridge in terrain ${slot}, several become a grid. As a melody: the values become notes of the current key and scale in the selected track's pattern.`));

  const selected = () => {
    if (!parsed?.columns) return null;
    if (column.value === GRID) return { grid: true, columns: parsed.columns };
    return { columns: [parsed.columns[Number(column.value) || 0]] };
  };

  function update() {
    const sel = selected();
    if (!sel) return;
    const values = sel.grid ? sel.columns.flatMap(c => c.values) : sel.columns[0].values;
    const s = seriesStats(values);
    const extra = parsed.truncated ? ` The first ${DATA_MAX_ROWS.toLocaleString('en-US')} rows are used; ${parsed.truncated.toLocaleString('en-US')} more were left out.` : '';
    setText(stats, `${s.count.toLocaleString('en-US')} points${sel.grid ? ` in ${sel.columns.length} columns` : ''}. Min ${fmt(s.min)}, max ${fmt(s.max)}.${extra}`);
    asMelody.disabled = !!sel.grid;
  }

  function parse() {
    parsed = parseData(text.value);
    if (parsed.error) {
      setText(stats, text.value.trim() ? parsed.error : 'Nothing pasted yet.');
      column.hidden = true; asTerrain.disabled = asMelody.disabled = true;
      return;
    }
    const prev = column.value;
    column.replaceChildren(...parsed.columns.map((c, i) => h('option', { value: String(i) }, c.name)),
      ...(parsed.columns.length > 1 ? [h('option', { value: GRID }, 'All columns as a grid')] : []));
    if ([...column.options].some(o => o.value === prev)) column.value = prev;
    column.hidden = parsed.columns.length < 2;
    asTerrain.disabled = false;
    update();
    pop?.reposition();
  }

  async function readFile(f) {
    if (!f) return;
    if (f.size > DATA_MAX_CHARS) { setText(stats, `That file is ${(f.size / 1048576).toFixed(1)} MB. Files up to 2 MB can be used.`); return; }
    try { text.value = await f.text(); parse(); } catch { setText(stats, 'That file could not be read.'); }
  }

  text.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(parse, 150); });
  column.addEventListener('change', update);
  openBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { readFile(file.files?.[0]); file.value = ''; });
  text.addEventListener('dragover', (e) => { e.preventDefault(); });
  text.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    readFile(f);
  });

  asTerrain.addEventListener('click', async () => {
    const sel = selected();
    if (!sel) return;
    asTerrain.disabled = true;
    try {
      const n = 256;
      const heights = sel.grid ? gridTerrain(sel.columns, n) : seriesTerrain(sel.columns[0].values, n);
      const name = sel.grid ? 'Data grid' : `Data: ${sel.columns[0].name}`;
      await addUserTerrain(ctx.store, ctx.binder.selected(), slot, heightsToUserTerrain(heights, n, { name }), { source: 'ui' });
      found('badge', 'data-terrain');
      ctx.toast(`Your data is now terrain ${slot}`, { kind: 'success' });
    } catch (err) {
      setText(stats, err.message || 'The terrain could not be made.');
    } finally { asTerrain.disabled = false; }
  });
  asMelody.addEventListener('click', () => {
    const sel = selected();
    if (!sel || sel.grid) return;
    const steps = writeMelody(ctx.store, ctx.binder.selected(), sel.columns[0].values);
    if (steps) ctx.toast('Your data is now the pattern of this track', { kind: 'success', detail: 'Undo puts the old pattern back.' });
    else setText(stats, 'Select a track first.');
  });

  column.hidden = true;
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--places', label: 'Sonify your data', placement: 'bottom-start', focus: 'textarea' });
  return pop;
}
