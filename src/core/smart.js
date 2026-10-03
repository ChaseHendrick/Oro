// Smart controls (v2.8): eight knobs per track, each setting up to four of
// the track's modulatable parameters at once, every target across its own
// range. Saved with the track as `parts.N.smart` and with patches.
//
//   part.smart = { knobs: [SMART_KNOBS x { name, value, maps: [{ id, min, max, curve }] }] }
//
// `value` is the knob position (0..1). `min` and `max` are positions of the
// target parameter in normalised knob units (0..1, the same space as
// toNorm/fromNorm), so a range follows the parameter's own curve (cutoff
// moves in octaves, not hertz); min above max inverts the mapping. `curve`
// indexes SMART_CURVES and shapes how the knob travels through the range.
// `name` is the knob's label ('' shows the first target's name).
//
// Smart knobs write the parameters directly through the store (source 'ui'
// by default, so a turn is one undo step), they do not modulate. A track
// without smart controls has no `smart` key at all, so sessions and patches
// saved before 2.8, and tracks that never use them, are unchanged.

import { MOD_PARAM_IDS, PART_PARAM_MAP, toNorm, fromNorm, clamp } from './params.js';

export const SMART_KNOBS = 8;
export const SMART_MAX_TARGETS = 4;
export const SMART_CURVES = ['Linear', 'Slow start', 'Fast start', 'S-curve'];
const MOD_SET = new Set(MOD_PARAM_IDS);

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round4 = (v) => Math.round(v * 10000) / 10000;

/** Shape a 0..1 knob travel by curve index (SMART_CURVES). */
export function smartCurve(curve, x) {
  const t = clamp(num(x, 0), 0, 1);
  switch (Math.round(num(curve, 0))) {
    case 1: return t * t;                       // slow start
    case 2: return 1 - (1 - t) * (1 - t);       // fast start
    case 3: return t * t * (3 - 2 * t);         // S-curve
    default: return t;
  }
}

/** Where a mapping puts its target (normalised 0..1) for knob position v. */
export function smartTargetNorm(map, v) {
  const lo = clamp(num(map && map.min, 0), 0, 1), hi = clamp(num(map && map.max, 1), 0, 1);
  return clamp(lo + (hi - lo) * smartCurve(map && map.curve, v), 0, 1);
}

/** The plain parameter value a mapping sets for knob position v (snapped like a knob would). */
export function smartTargetValue(map, v) {
  const def = PART_PARAM_MAP[map && map.id];
  if (!def) return NaN;
  let x = fromNorm(def, smartTargetNorm(map, v));
  if (def.curve === 'int' || def.curve === 'enum' || def.curve === 'bool') x = Math.round(x);
  return x;
}

/** Whether a parameter can be a smart control target. */
export function isSmartTarget(id) {
  return MOD_SET.has(id);
}

/** An empty knob. */
export function defaultSmartKnob() {
  return { name: '', value: 0, maps: [] };
}

/** Eight empty knobs (what a track shows before any are set up). */
export function defaultSmart() {
  return { knobs: Array.from({ length: SMART_KNOBS }, defaultSmartKnob) };
}

function sanitizeMap(m) {
  if (!m || typeof m !== 'object' || !isSmartTarget(m.id)) return null;
  return {
    id: m.id,
    min: round4(clamp(num(m.min, 0), 0, 1)),
    max: round4(clamp(num(m.max, 1), 0, 1)),
    curve: Math.round(clamp(num(m.curve, 0), 0, SMART_CURVES.length - 1)),
  };
}

/**
 * A saved `smart` field -> the current shape, or null when there is nothing
 * worth keeping (no knob has a target or a name). Unknown or non-modulatable
 * targets, repeats of a target on one knob and targets past the fourth are
 * dropped.
 */
export function sanitizeSmart(src) {
  if (!src || typeof src !== 'object' || !Array.isArray(src.knobs)) return null;
  let any = false;
  const knobs = Array.from({ length: SMART_KNOBS }, (_, i) => {
    const k = src.knobs[i];
    if (!k || typeof k !== 'object') return defaultSmartKnob();
    const maps = [];
    const seen = new Set();
    for (const m of Array.isArray(k.maps) ? k.maps : []) {
      if (maps.length >= SMART_MAX_TARGETS) break;
      const c = sanitizeMap(m);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      maps.push(c);
    }
    const name = typeof k.name === 'string' ? k.name.trim().slice(0, 24) : '';
    if (maps.length || name) any = true;
    return { name, value: round4(clamp(num(k.value, 0), 0, 1)), maps };
  });
  return any ? { knobs } : null;
}

/** A target's name, with "Filter 2" in front of the second filter's controls so they read apart. */
export function smartTargetLabel(id) {
  const def = PART_PARAM_MAP[id];
  if (!def) return String(id);
  return def.group === 'filter2' ? `Filter 2 ${def.label.toLowerCase()}` : def.label;
}

/** The label a smart knob shows: its name, else its first target, else "Smart N". */
export function smartKnobLabel(knob, i) {
  if (knob && knob.name) return knob.name;
  const first = knob && knob.maps && knob.maps[0];
  if (first && PART_PARAM_MAP[first.id]) return smartTargetLabel(first.id);
  return `Smart ${i + 1}`;
}

// ---------------------------------------------------------------- store helpers

const partOk = (store, p) => Number.isInteger(p) && p >= 0 && Array.isArray(store.get('parts')) && p < store.get('parts').length;

/** The track's smart controls, always eight knobs (copies). */
export function readSmart(store, p) {
  return sanitizeSmart(store.get(`parts.${p}.smart`)) || defaultSmart();
}

/** Replace the track's smart controls; an empty set removes the field. */
export function writeSmart(store, p, smart, meta = { source: 'ui' }) {
  if (!partOk(store, p)) return;
  const clean = sanitizeSmart(smart);
  const part = store.get(`parts.${p}`);
  if (!clean) {
    if (part && 'smart' in part) {
      const next = { ...part };
      delete next.smart;
      store.set(`parts.${p}`, next, meta);
    }
    return;
  }
  store.set(`parts.${p}.smart`, clean, meta);
}

/**
 * Turn smart knob `k` of track `p` to `v` (0..1): every target moves to its
 * place in its range, then the knob position is stored, all in one batch.
 * Returns false (and changes nothing) when the knob has no targets.
 */
export function applySmartKnob(store, p, k, v, meta = { source: 'ui' }) {
  if (!partOk(store, p) || !(k >= 0 && k < SMART_KNOBS)) return false;
  const smart = sanitizeSmart(store.get(`parts.${p}.smart`));
  const knob = smart && smart.knobs[k];
  if (!knob || !knob.maps.length) return false;
  const x = round4(clamp(num(v, 0), 0, 1));
  const m = { ...meta, smart: true };
  store.batch(() => {
    for (const map of knob.maps) {
      const val = smartTargetValue(map, x);
      const path = `parts.${p}.params.${map.id}`;
      if (Number.isFinite(val) && store.get(path) !== val) store.set(path, val, m);
    }
    if (store.get(`parts.${p}.smart.knobs.${k}.value`) !== x) store.set(`parts.${p}.smart.knobs.${k}.value`, x, m);
  });
  return true;
}

/**
 * Add parameter `id` to knob `k` (or update its range when it is already
 * there). `from` and `to` are plain parameter values: the range runs from
 * `from` at the knob's start to `to` at its end.
 * @returns {'added'|'updated'|'full'|'invalid'}
 */
export function setSmartMap(store, p, k, id, from, to, { curve, meta = { source: 'ui' } } = {}) {
  const def = PART_PARAM_MAP[id];
  if (!partOk(store, p) || !(k >= 0 && k < SMART_KNOBS) || !def || !isSmartTarget(id)) return 'invalid';
  const smart = readSmart(store, p);
  const knob = smart.knobs[k];
  const i = knob.maps.findIndex(m => m.id === id);
  const map = { id, min: toNorm(def, num(from, def.default)), max: toNorm(def, num(to, def.default)), curve: num(curve, i >= 0 ? knob.maps[i].curve : 0) };
  let result;
  if (i >= 0) { knob.maps[i] = map; result = 'updated'; }
  else if (knob.maps.length >= SMART_MAX_TARGETS) return 'full';
  else { knob.maps.push(map); result = 'added'; }
  writeSmart(store, p, smart, meta);
  return result;
}

/** Change fields of mapping `j` of knob `k` ({ min, max, curve } in normalised units). */
export function editSmartMap(store, p, k, j, fields, meta = { source: 'ui' }) {
  if (!partOk(store, p)) return false;
  const smart = readSmart(store, p);
  const knob = smart.knobs[k];
  if (!knob || !knob.maps[j]) return false;
  knob.maps[j] = { ...knob.maps[j], ...fields };
  writeSmart(store, p, smart, meta);
  return true;
}

/** Remove mapping `j` from knob `k`. */
export function removeSmartMap(store, p, k, j, meta = { source: 'ui' }) {
  if (!partOk(store, p)) return false;
  const smart = readSmart(store, p);
  const knob = smart.knobs[k];
  if (!knob || !knob.maps[j]) return false;
  knob.maps.splice(j, 1);
  writeSmart(store, p, smart, meta);
  return true;
}

/** Rename knob `k` ('' goes back to the automatic label). */
export function renameSmartKnob(store, p, k, name, meta = { source: 'ui' }) {
  if (!partOk(store, p)) return false;
  const smart = readSmart(store, p);
  if (!smart.knobs[k]) return false;
  smart.knobs[k].name = String(name || '').trim().slice(0, 24);
  writeSmart(store, p, smart, meta);
  return true;
}

/** Remove every mapping and the name of knob `k`. */
export function clearSmartKnob(store, p, k, meta = { source: 'ui' }) {
  if (!partOk(store, p)) return false;
  const smart = readSmart(store, p);
  if (!smart.knobs[k]) return false;
  smart.knobs[k] = defaultSmartKnob();
  writeSmart(store, p, smart, meta);
  return true;
}
