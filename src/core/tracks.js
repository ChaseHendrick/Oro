// Tracks: the live list of parts in the store and the operations on it.
//
// `state.parts` is the source of truth for which tracks exist and in which
// order (1..MAX_PARTS of them, each with a stable string `id`). Everything
// that keeps per-track resources (the DSP's parts, the router's held notes,
// the terrain tables, the visuals' height fields) allocates MAX_PARTS slots
// and maps them by index. When the list changes shape (add, remove,
// duplicate, move, a scene load) those slots must follow their tracks:
//
//   trackPerm(oldIds, newIds) -> { perm, fresh, count, oldCount } or null
//     perm[newIndex] = oldIndex for all MAX_PARTS slots (a bijection), so a
//     kept track's slot moves with it, a new track gets an unused slot (one
//     that has been silent longest first), and a removed track's slot goes to
//     the back of the inactive slots, where it can fade out.
//   permute(list, perm) -> the list with its slots moved the same way.
//   watchTracks(store, fn) calls fn(change, meta) whenever the list of ids
//     changes, after the store has changed (every module computes the same
//     permutation from the same ids, so nobody needs to pass it around).
//
// Pure store operations (addTrack, removeTrack, duplicateTrack, moveTrack,
// renameTrack, plus the pattern helpers) write the new list with one
// store.set('parts', ...) tagged { source: 'tracks' } and keep the selected
// track selected.

import {
  MAX_PARTS, MIN_PARTS, MAX_PATTERNS, PART_COLORS, defaultPart, defaultPattern, activePatternIndex,
} from './params.js';

const deepCopy = (v) => (v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

/** Number of tracks in a store (or state) right now, at least 1. */
export function partCount(src) {
  const parts = src && typeof src.get === 'function' ? src.get('parts') : src && src.parts;
  const n = Array.isArray(parts) ? parts.length : 0;
  return n < MIN_PARTS ? MIN_PARTS : n > MAX_PARTS ? MAX_PARTS : n;
}

/** Is `p` the index of a track that exists in `store` now? */
export function isTrack(store, p) {
  return Number.isInteger(p) && p >= 0 && p < partCount(store);
}

/** The selected track's index, clamped into the live list. */
export function selectedIndex(store) {
  const n = Math.round(Number(store.get('ui.selectedPart')) || 0);
  const max = partCount(store) - 1;
  return n < 0 ? 0 : n > max ? max : n;
}

/** Ids of a track list (index-based stand-ins for tracks without one). */
export function trackIds(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.slice(0, MAX_PARTS).map((p, i) => (p && typeof p.id === 'string' && p.id ? p.id : `#${i}`));
}

/**
 * How MAX_PARTS index-mapped slots move when the track list goes from
 * `oldIds` to `newIds`. null when nothing moves (same ids, same order).
 * `replace`: every track in the new list is new, whatever its id (a scene
 * load): the old tracks fade out in their slots while the new ones start in
 * fresh slots.
 */
export function trackPerm(oldIds, newIds, max = MAX_PARTS, replace = false) {
  const n0 = Math.min(oldIds.length, max), n1 = Math.min(newIds.length, max);
  if (!replace && n0 === n1 && newIds.slice(0, n1).every((id, i) => id === oldIds[i])) return null;
  const oldIndex = new Map();
  if (!replace) for (let i = 0; i < n0; i++) if (!oldIndex.has(oldIds[i])) oldIndex.set(oldIds[i], i);
  const perm = new Array(max).fill(-1);
  const used = new Uint8Array(max);
  for (let i = 0; i < n1; i++) {
    const j = oldIndex.get(newIds[i]);
    if (j !== undefined && !used[j]) { perm[i] = j; used[j] = 1; }
  }
  // Unused slots: the ones that were already inactive (longest silent first),
  // then the ones that just lost their track (still fading, used last).
  const order = [];
  for (let j = n0; j < max; j++) if (!used[j]) order.push(j);
  for (let j = 0; j < n0; j++) if (!used[j]) order.push(j);
  let k = 0;
  const fresh = [];
  for (let i = 0; i < n1; i++) if (perm[i] < 0) { perm[i] = order[k++]; fresh.push(i); }
  for (let i = n1; i < max; i++) perm[i] = order[k++];
  return { perm, fresh, count: n1, oldCount: n0 };
}

/** `list` (MAX_PARTS long) with its slots moved by `perm`; slots in `fresh` come from make(i) when given. */
export function permute(list, perm, fresh = null, make = null) {
  const out = perm.map(j => list[j]);
  if (fresh && make) for (const i of fresh) out[i] = make(i);
  return out;
}

/** Old index -> new index (-1 for none) of a permutation. */
export function inversePerm(perm) {
  const inv = new Array(perm.length).fill(-1);
  perm.forEach((j, i) => { if (j >= 0 && j < inv.length) inv[j] = i; });
  return inv;
}

/** Store meta that marks a whole new track list (scene load): see trackPerm's `replace`. */
export const REPLACE_TRACKS = 'replaceTracks';

/**
 * The change from `ids` to the store's current track list after a store
 * event with `meta`: { ids, change } (change null when nothing moved).
 */
export function trackChange(ids, store, meta) {
  const next = trackIds(store.get('parts'));
  return { ids: next, change: trackPerm(ids, next, MAX_PARTS, !!(meta && meta[REPLACE_TRACKS])) };
}

/**
 * Call fn({ perm, fresh, count, oldCount }, meta) after every store change
 * that reorders, adds or removes tracks. Returns the unsubscribe function.
 */
export function watchTracks(store, fn) {
  let ids = trackIds(store.get('parts'));
  return store.subscribe('', (path, value, meta) => {
    if (path !== '' && path !== 'parts') return;
    const r = trackChange(ids, store, meta);
    ids = r.ids;
    if (r.change) fn(r.change, meta);
  });
}

// ------------------------------------------------------------------ ids, names

/** A track id not used in `parts`: t<n> with n one more than the highest so far. */
export function newTrackId(parts) {
  let max = 0;
  for (const p of parts || []) {
    const m = /^t(\d+)$/.exec(p && p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  const taken = new Set((parts || []).map(p => p && p.id));
  while (taken.has(`t${n}`)) n++;
  return `t${n}`;
}

/** A pattern id not used in `patterns`. */
export function newPatternId(patterns) {
  let max = 0;
  for (const p of patterns || []) {
    const m = /^p(\d+)$/.exec(p && p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}`;
}

/** 'Track N' with the smallest N not taken by a track name. */
export function nextTrackName(parts, base = 'Track') {
  const taken = new Set((parts || []).map(p => p && p.name));
  for (let n = (parts || []).length + 1; n < 1000; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return base;
}

/** A colour from the palette that no track uses yet (the first one when all are taken). */
export function nextTrackColor(parts) {
  const used = new Set((parts || []).map(p => String(p && p.color).toLowerCase()));
  return PART_COLORS.find(c => !used.has(c.toLowerCase())) || PART_COLORS[(parts || []).length % PART_COLORS.length];
}

/** A copy of `name` that no track uses: 'Bass' -> 'Bass 2'. */
function copyName(parts, name) {
  const taken = new Set((parts || []).map(p => p && p.name));
  const base = String(name || 'Track').replace(/ \d+$/, '').slice(0, 34);
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return base;
}

// ------------------------------------------------------------------ operations

function commit(store, parts, select) {
  store.batch(() => {
    store.set('parts', parts, { source: 'tracks' });
    if (select !== undefined && select !== null) {
      const sel = Math.max(0, Math.min(parts.length - 1, select));
      if (store.get('ui.selectedPart') !== sel) store.set('ui.selectedPart', sel, { source: 'tracks' });
    }
  });
}

function currentParts(store) {
  const parts = store.get('parts');
  return Array.isArray(parts) ? parts.slice() : [];
}

/**
 * Add a track after the last one (or at `index`), select it and return its
 * index, or -1 when the list is full. `part` (optional) is a track to add
 * as it is (its id and name are made unique).
 */
export function addTrack(store, { index, part, select = true } = {}) {
  const parts = currentParts(store);
  if (parts.length >= MAX_PARTS) return -1;
  const at = Number.isInteger(index) ? Math.max(0, Math.min(parts.length, index)) : parts.length;
  const fresh = part ? deepCopy(part) : defaultPart(parts.length, { name: nextTrackName(parts), color: nextTrackColor(parts) });
  // A given track keeps its id when no other track has it (an undone remove).
  if (!(part && typeof part.id === 'string' && part.id && !parts.some(p => p.id === part.id))) fresh.id = newTrackId(parts);
  if (part && parts.some(p => p.name === fresh.name)) fresh.name = copyName(parts, fresh.name);
  parts.splice(at, 0, fresh);
  const sel = store.get('ui.selectedPart');
  commit(store, parts, select ? at : (Number.isInteger(sel) && sel >= at ? sel + 1 : sel));
  return at;
}

/** Copy track `i` (sound, patterns, mix) into a new track right after it. Returns the new index or -1. */
export function duplicateTrack(store, i) {
  const parts = currentParts(store);
  if (!(i >= 0 && i < parts.length) || parts.length >= MAX_PARTS) return -1;
  const copy = deepCopy(parts[i]);
  copy.name = copyName(parts, parts[i].name);
  copy.color = nextTrackColor(parts);
  // A duplicate starts unsoloed, so it does not silence the rest by surprise.
  if (copy.params) copy.params.solo = 0;
  return addTrack(store, { index: i + 1, part: copy });
}

/**
 * Remove track `i`. Its notes are released and its DSP slot freed (the
 * engine fades it out). The last track cannot be removed. Returns true when
 * it was removed.
 */
export function removeTrack(store, i) {
  const parts = currentParts(store);
  if (!(i >= 0 && i < parts.length) || parts.length <= MIN_PARTS) return false;
  parts.splice(i, 1);
  const sel = Math.round(Number(store.get('ui.selectedPart')) || 0);
  commit(store, parts, sel > i ? sel - 1 : Math.min(sel, parts.length - 1));
  return true;
}

/** Move track `from` to position `to` (the selection follows the track it was on). */
export function moveTrack(store, from, to) {
  const parts = currentParts(store);
  if (!(from >= 0 && from < parts.length)) return false;
  const dest = Math.max(0, Math.min(parts.length - 1, Math.round(to)));
  if (dest === from) return false;
  const selId = parts[Math.round(Number(store.get('ui.selectedPart')) || 0)]?.id;
  const [t] = parts.splice(from, 1);
  parts.splice(dest, 0, t);
  const sel = parts.findIndex(p => p.id === selId);
  commit(store, parts, sel >= 0 ? sel : dest);
  return true;
}

/** Rename track `i` (trimmed, at most 40 characters; an empty name is ignored). */
export function renameTrack(store, i, name) {
  if (!isTrack(store, i)) return false;
  const v = String(name ?? '').trim().slice(0, 40);
  if (!v) return false;
  store.set(`parts.${i}.name`, v, { source: 'ui' });
  return true;
}

/**
 * Replace the whole track list (a scene load does this through the store's
 * load). Ids are made unique and the selection is clamped. For callers that
 * build a list from scratch.
 */
export function setTracks(store, parts) {
  const list = (Array.isArray(parts) ? parts : []).slice(0, MAX_PARTS).map(deepCopy);
  if (!list.length) list.push(defaultPart(0));
  uniqueIds(list);
  commit(store, list, Math.min(Math.round(Number(store.get('ui.selectedPart')) || 0), list.length - 1));
}

/** Give every track in `list` a unique id (in place); tracks without one get t1, t2... by position. */
export function uniqueIds(list) {
  const seen = new Set();
  list.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    let id = typeof p.id === 'string' && /^[\w-]{1,24}$/.test(p.id) ? p.id : `t${i + 1}`;
    if (seen.has(id)) id = null;
    if (!id) {
      let n = i + 1;
      while (seen.has(`t${n}`) || list.some((q, k) => k > i && q && q.id === `t${n}`)) n++;
      id = `t${n}`;
    }
    p.id = id;
    seen.add(id);
  });
  return list;
}

// ------------------------------------------------------------------ patterns

/** Add a pattern to track `p` (a copy of the one it plays when `copy`), make it active, return its index. */
export function addPattern(store, p, { copy = true } = {}) {
  if (!isTrack(store, p)) return -1;
  const part = store.get(`parts.${p}`);
  const list = Array.isArray(part.patterns) ? part.patterns.slice() : [];
  if (list.length >= MAX_PATTERNS) return -1;
  const id = newPatternId(list);
  const n = Number(id.slice(1));
  const src = list[activePatternIndex(part)];
  const pat = copy && src ? { ...deepCopy(src), id, name: `Pattern ${n}` } : { ...defaultPattern(n), id };
  list.push(pat);
  store.batch(() => {
    store.set(`parts.${p}.patterns`, list, { source: 'tracks' });
    store.set(`parts.${p}.activePattern`, list.length - 1, { source: 'tracks' });
  });
  return list.length - 1;
}

/** Make pattern `k` the one track `p` plays. */
export function selectPattern(store, p, k) {
  if (!isTrack(store, p)) return false;
  const list = store.get(`parts.${p}.patterns`) || [];
  if (!(k >= 0 && k < list.length)) return false;
  if (store.get(`parts.${p}.activePattern`) !== k) store.set(`parts.${p}.activePattern`, k, { source: 'tracks' });
  return true;
}

/** Remove pattern `k` of track `p` (a track keeps at least one). */
export function removePattern(store, p, k) {
  if (!isTrack(store, p)) return false;
  const part = store.get(`parts.${p}`);
  const list = Array.isArray(part.patterns) ? part.patterns.slice() : [];
  if (list.length <= 1 || !(k >= 0 && k < list.length)) return false;
  const active = activePatternIndex(part);
  list.splice(k, 1);
  store.batch(() => {
    store.set(`parts.${p}.patterns`, list, { source: 'tracks' });
    store.set(`parts.${p}.activePattern`, active > k ? active - 1 : Math.min(active, list.length - 1), { source: 'tracks' });
  });
  return true;
}
