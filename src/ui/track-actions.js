// Track list actions shared by the top bar tabs and the mixer strips: add,
// duplicate, rename, move and remove (with Undo), plus the menu that offers
// them. The store operations themselves live in src/core/tracks.js.

import { MAX_PARTS, MIN_PARTS } from '../core/params.js';
import {
  partCount, addTrack, duplicateTrack, removeTrack, moveTrack, renameTrack,
} from '../core/tracks.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { openPopover } from './layers.js';

const nameOf = (store, i) => store.get(`parts.${i}.name`) || `Track ${i + 1}`;

/** Add a track at the end and select it. Tells the person when the list is full. */
export function addTrackAction(ctx) {
  const i = addTrack(ctx.store);
  if (i < 0) { ctx.toast(`${MAX_PARTS} tracks is the most Oro can play at once`, { kind: 'info' }); return -1; }
  return i;
}

export function duplicateTrackAction(ctx, i) {
  const n = duplicateTrack(ctx.store, i);
  if (n < 0 && partCount(ctx.store) >= MAX_PARTS) ctx.toast(`${MAX_PARTS} tracks is the most Oro can play at once`, { kind: 'info' });
  return n;
}

/** Remove track `i`; the toast offers Undo (the track comes back where it was, with its id). */
export function removeTrackAction(ctx, i) {
  const { store } = ctx;
  if (partCount(store) <= MIN_PARTS) { ctx.toast('A session always keeps at least one track', { kind: 'info' }); return false; }
  const part = JSON.parse(JSON.stringify(store.get(`parts.${i}`)));
  const name = nameOf(store, i);
  if (!removeTrack(store, i)) return false;
  ctx.toast(`Removed ${name}`, {
    kind: 'info', timeout: 6000,
    action: { label: 'Undo', onClick: () => { addTrack(store, { index: i, part }); } },
  });
  return true;
}

/** A small popover with a text field to rename track `i`. */
export function openRenameTrack(ctx, anchor, i) {
  const { store } = ctx;
  const input = h('input', { class: 'field', type: 'text', value: nameOf(store, i), maxlength: '40', 'aria-label': `New name for ${nameOf(store, i)}` });
  const save = h('button', { type: 'submit', class: 'btn btn--sm btn--primary' }, 'Rename');
  const form = h('form', { class: 'track-rename' }, input, save);
  let pop = null;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    renameTrack(store, i, input.value);
    pop.close('save');
  });
  pop = openPopover(ctx.layers, anchor, form, { className: 'popover--rename', label: 'Rename track', placement: 'bottom-start' });
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return pop;
}

/** The track menu for track `i` (Rename, Duplicate, Move, Remove, Add). */
export function openTrackMenu(ctx, anchor, i) {
  const { store } = ctx;
  const n = partCount(store);
  const full = n >= MAX_PARTS;
  return openMenu(ctx.layers, anchor, [
    { heading: nameOf(store, i) },
    { label: 'Rename...', icon: icon('edit'), hint: 'F2', onSelect: () => openRenameTrack(ctx, anchor, i) },
    { label: 'Duplicate', icon: icon('copy'), disabled: full, onSelect: () => duplicateTrackAction(ctx, i) },
    { label: 'Move left', icon: icon('arrow-left'), hint: 'Alt+Left', disabled: i <= 0, onSelect: () => moveTrack(store, i, i - 1) },
    { label: 'Move right', icon: icon('arrow-right'), hint: 'Alt+Right', disabled: i >= n - 1, onSelect: () => moveTrack(store, i, i + 1) },
    { separator: true },
    { label: 'Add track', icon: icon('plus'), disabled: full, onSelect: () => addTrackAction(ctx) },
    { label: 'Remove track', icon: icon('trash'), danger: true, disabled: n <= MIN_PARTS, onSelect: () => removeTrackAction(ctx, i) },
  ], { label: `Track ${i + 1} options` });
}
