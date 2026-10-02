// Turning a patch (a partial parameter set) into a full part, shared by the
// preset store and the factory scene builder.

import { defaultPart, defaultPartParams, defaultMods, MOD_DEFAULT, PART_PARAM_MAP } from '../core/params.js';

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
    if (mods[id] && m && typeof m === 'object') mods[id] = { ...MOD_DEFAULT, ...m };
  }
  return mods;
}

export function patchDot(patch) {
  return { ...defaultPart(0).dot, ...((patch && patch.dot) || {}) };
}

/**
 * The part `base` with `patch` loaded: sound, modulation, dot behaviour and
 * imported terrains come from the patch; name, colour, sequence, arp and the
 * mixer's mute/solo stay as they were.
 */
export function partWithPatch(base, patch) {
  const params = patchParams(patch);
  params.mute = base.params ? base.params.mute || 0 : 0;
  params.solo = base.params ? base.params.solo || 0 : 0;
  return {
    ...base,
    patchName: String((patch && patch.name) || 'Init').slice(0, 60),
    params,
    mods: patchMods(patch),
    dot: patchDot(patch),
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
    for (const [k, v] of Object.entries(m)) if (MOD_DEFAULT[k] !== v) diff[k] = v;
    if (Object.keys(diff).length) out[id] = diff;
  }
  return out;
}
