// Turning a patch (a partial parameter set) into a full part, shared by the
// preset store and the factory scene builder.

import { defaultPart, defaultPartParams, defaultMods, defaultLinks, MOD_DEFAULT, PART_PARAM_MAP, PEDAL_PARAM_IDS, SEND_PARAM_IDS, SPACE_PARAM_IDS } from '../core/params.js';
import { sanitizeTrackFx } from '../dsp/track-fx-config.js';
import { sanitizeNoiseRecording } from '../dsp/noise-recording.js';
import { sanitizeLinks } from '../core/migrate.js';
import { sanitizeSmart } from '../core/smart.js';

// Mod settings may hold arrays (the Steps LFO values). Each part gets its own
// copies, so editing one part's steps can never touch another part, a factory
// patch or the frozen defaults.
const copyField = (v) => (Array.isArray(v) ? v.slice() : v);
const sameField = (a, b) => (Array.isArray(a) || Array.isArray(b)
  ? Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
  : a === b);

export function patchParams(patch) {
  const params = defaultPartParams();
  for (const [id, v] of Object.entries((patch && patch.params) || {})) {
    if (PART_PARAM_MAP[id] && typeof v === 'number' && Number.isFinite(v)) params[id] = v;
  }
  return params;
}

export function patchMods(patch) {
  const mods = defaultMods();
  for (const [id, m] of Object.entries((patch && patch.mods) || {})) {
    if (!mods[id] || !m || typeof m !== 'object') continue;
    const merged = { ...mods[id], ...m };
    if (Array.isArray(merged.steps) && merged.steps.length === 16) merged.steps = merged.steps.flatMap(v => [v, v]);
    for (const k of Object.keys(merged)) merged[k] = copyField(merged[k]);
    mods[id] = merged;
  }
  return mods;
}

export function patchDot(patch) {
  const dot = { ...defaultPart(0).dot, ...((patch && patch.dot) || {}) };
  // Waypoints are objects in an array: copy them so parts never share them.
  if (Array.isArray(dot.waypoints)) dot.waypoints = dot.waypoints.map(w => ({ ...w }));
  return dot;
}

/**
 * The patch's Links (copies), or the default routing (Mod Wheel -> Morph) for
 * patches saved before Links existed, which is what the wheel used to do.
 */
export function patchLinks(patch) {
  return patch && Array.isArray(patch.links) ? sanitizeLinks(patch.links) : defaultLinks();
}

/**
 * The part `base` with `patch` loaded: sound, modulation, Links, dot
 * behaviour, imported terrains and smart controls come from the patch; name, colour,
 * sequence, arp, the mixer's mute/solo, the pedal routing (Pedal send, Pre,
 * Insert: part of the rig, not the sound) and the Send A / Send B amounts stay
 * as they were.
 */
export function partWithPatch(base, patch) {
  const params = patchParams(patch);
  params.mute = base.params ? base.params.mute || 0 : 0;
  params.solo = base.params ? base.params.solo || 0 : 0;
  for (const id of PEDAL_PARAM_IDS) params[id] = base.params && Number.isFinite(base.params[id]) ? base.params[id] : PART_PARAM_MAP[id].default;
  // v2.8 smart controls belong to the sound: the patch's own, or none.
  const rest = { ...base };
  delete rest.smart;
  const smart = sanitizeSmart(patch && patch.smart);
  // v2.8 the Send A / Send B amounts are part of the mix, like the pedal routing
  for (const id of SEND_PARAM_IDS) params[id] = base.params && Number.isFinite(base.params[id]) ? base.params[id] : PART_PARAM_MAP[id].default;
  // 2.12 and so is the 3D position
  for (const id of SPACE_PARAM_IDS) params[id] = base.params && Number.isFinite(base.params[id]) ? base.params[id] : PART_PARAM_MAP[id].default;
  return {
    ...rest,
    ...(smart ? { smart } : {}),
    patchName: String((patch && patch.name) || 'Init').slice(0, 60),
    params,
    mods: patchMods(patch),
    links: patchLinks(patch),
    dot: patchDot(patch),
    trackFx: sanitizeTrackFx(patch?.trackFx),
    noiseRecording: sanitizeNoiseRecording(patch?.noiseRecording),
    userTerrain: {
      A: (patch && patch.userTerrain && patch.userTerrain.A) || null,
      B: (patch && patch.userTerrain && patch.userTerrain.B) || null,
    },
  };
}

/** Only the modulation entries that differ from the default (for compact saving). */
export function compactMods(mods) {
  const out = {};
  for (const [id, m] of Object.entries(mods || {})) {
    if (!m) continue;
    const diff = {};
    for (const [k, v] of Object.entries(m)) if (!sameField(MOD_DEFAULT[k], v)) diff[k] = copyField(v);
    if (Object.keys(diff).length) out[id] = diff;
  }
  return out;
}
