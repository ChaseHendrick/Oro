// Pedal presets stored with scenes and patches (v1.1): one optional Program
// Change per pedal, `{ purrting: 12, lostAndFound: 0 }`. A pedal that is not
// listed is left as it is. Numbers are the raw Program Change data byte and
// keep each profile's own meaning (the Lost + Found's PC 0 is "Live", the
// Purr-ting's presets start at 1), so they are checked against the profile's
// range and never shifted.

import { PEDAL_PROFILES, PEDAL_IDS, checkProgram } from './profiles.js';

/** Pedals that take Program Change (the Xero documents none). */
export const PRESET_PEDAL_IDS = Object.freeze(PEDAL_IDS.filter(id => PEDAL_PROFILES[id].programs));

/**
 * Keep only known pedals with a valid preset number. Returns a new object, or
 * null when nothing valid is left (so old scenes and patches stay unchanged).
 */
export function sanitizePedalPresets(src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const out = {};
  for (const id of PRESET_PEDAL_IDS) {
    const v = src[id];
    if (typeof v !== 'number' || !Number.isInteger(v)) continue;
    if (checkProgram(PEDAL_PROFILES[id], v).ok) out[id] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** "Live (0)" for documented special numbers, otherwise the number. */
export function programLabel(id, program) {
  const p = PEDAL_PROFILES[id];
  const special = p && p.programs && p.programs.special && p.programs.special[program];
  return special ? `${special} (${program})` : String(program);
}

/** Plain-language range for a pedal's presets, e.g. "0 = Live, 1-127 saved presets". */
export function programHint(id) {
  const p = PEDAL_PROFILES[id];
  if (!p || !p.programs) return 'No presets';
  const { min, max, special } = p.programs;
  const specials = special ? Object.keys(special).map(Number).sort((a, b) => a - b) : [];
  if (!specials.length) return `${min}-${max}`;
  const parts = specials.map(n => `${n} = ${special[n]}`);
  const first = Math.max(min, specials[specials.length - 1] + 1);
  if (first <= max) parts.push(`${first}-${max} saved presets`);
  return parts.join(', ');
}

/** Short summary for lists: "Purr-ting 12, Lost + Found Live (0)". */
export function describePedalPresets(map) {
  const clean = sanitizePedalPresets(map);
  if (!clean) return '';
  return Object.entries(clean).map(([id, n]) => `${shortName(id)} ${programLabel(id, n)}`).join(', ');
}

/** The pedal's name without its maker, for compact labels. */
export function shortName(id) {
  const p = PEDAL_PROFILES[id];
  if (!p) return id;
  return p.maker && p.name.startsWith(p.maker) ? p.name.slice(p.maker.length).trim() : p.name.replace(/^\S+\s+/, '');
}
