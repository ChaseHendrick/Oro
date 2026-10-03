// v2.9 the list of secrets and badges, with names and vague hints for the
// Bookkeeping section of Settings > Operator (src/ui/fun-progress.js). Finds
// themselves are recorded by src/core/fun.js. An id found at runtime that is
// not listed here still counts and shows as "Unlisted".
//
// Hints say where to look, never what to do.

export const SECRETS = Object.freeze([
  { id: 'konami', name: 'Cabinet code', hint: 'Some keys remember older games.' },
  { id: 'logo-seven', name: 'Seven taps', hint: 'The mark at the top likes attention.' },
  { id: 'tempo-404', name: 'Tempo not found', hint: 'Not every tempo can be found.' },
  { id: 'tempo-303', name: 'Acid tempo', hint: 'One tempo has a squelchy reputation.' },
  { id: 'stop-dropping', name: 'Butterfingers', hint: 'Gravity has limits. So does patience.' },
  { id: 'short-circuit', name: 'Short circuit', hint: 'Water and broken things do not mix.' },
  { id: 'oro-path', name: 'Signature path', hint: 'Some paths answer to a name.' },
  { id: 'console', name: 'Console greeting', hint: 'Developers have a place to talk to the machine.' },
  { id: 'insert-coin', name: 'Insert coin', hint: 'Free Play is not the only way to play.' },
  { id: 'kill-screen', name: 'Kill screen', hint: 'Some patterns go on far too long.' },
].map(Object.freeze));

export const BADGES = Object.freeze([
  // Golf
  { id: 'golf-first-hole', name: 'First hole', hint: 'Finish a hole in Golf.' },
  { id: 'golf-hole-in-one', name: 'Hole in one', hint: 'In Golf, sometimes one stroke is all it takes.' },
  { id: 'golf-under-par', name: 'Under par', hint: 'Beat the par on a Golf hole.' },
  { id: 'golf-round', name: 'Full round', hint: 'Finish a round of Golf.' },
  // name seed, day and night, pet
  { id: 'seed-word', name: 'Seed word', hint: 'A word can grow a land.' },
  { id: 'night-owl', name: 'Night owl', hint: 'Play while most people sleep.' },
  { id: 'met-pet', name: 'New friend', hint: 'Someone lives on the map.' },
  // postcards and ghosts
  { id: 'postcard-sent', name: 'Postcard sent', hint: 'Send a sound to someone.' },
  { id: 'postcard-opened', name: 'Postcard opened', hint: 'Open a sound someone sent.' },
  { id: 'ghost-recorded', name: 'Ghost recorded', hint: 'Leave something behind to play along with.' },
  // real places, night sky, weather and data
  { id: 'place-earth', name: 'Home ground', hint: 'Play on a real place.' },
  { id: 'place-moon', name: 'Moonwalk', hint: 'Look a little further than Earth.' },
  { id: 'place-mars', name: 'Red dust', hint: 'Look further still.' },
  { id: 'night-sky', name: 'Stargazer', hint: 'Look up.' },
  { id: 'weather', name: 'Weather report', hint: 'Let the outside in.' },
  { id: 'data-terrain', name: 'Data land', hint: 'Numbers can be mountains too.' },
  // Operator
  { id: 'first-drop', name: 'First drop', hint: 'Accidents happen. Some on purpose.' },
  { id: 'soaked', name: 'Soaked', hint: 'Stay damp for a long time.' },
  { id: 'notes-1000', name: 'Thousand notes', hint: 'Keep playing.' },
  { id: 'repair-crew', name: 'Repair crew', hint: 'Fix what was broken.' },
].map(Object.freeze));

const SECRET_MAP = new Map(SECRETS.map(s => [s.id, s]));
const BADGE_MAP = new Map(BADGES.map(b => [b.id, b]));

/** The catalog entry for a find, or null when it is not listed. */
export function catalogEntry(kind, id) {
  return (kind === 'secret' ? SECRET_MAP : kind === 'badge' ? BADGE_MAP : new Map()).get(id) || null;
}

/** Display name for a find: its catalog name, or "Unlisted". */
export function findName(kind, id) {
  const e = catalogEntry(kind, id);
  return e ? e.name : 'Unlisted';
}

/**
 * Progress for one kind: `found` is fun.list(kind) ([{ id, at }]). Returns
 * { found, total, earned: [{ id, name, at, listed }], missing: [{ id, hint }] }.
 * Unlisted finds count towards both numbers.
 */
export function progress(kind, found = []) {
  const list = kind === 'secret' ? SECRETS : BADGES;
  const got = new Map(found.map(f => [f.id, f.at]));
  const earned = found.map(f => ({ id: f.id, name: findName(kind, f.id), at: f.at, listed: !!catalogEntry(kind, f.id) }));
  const missing = list.filter(e => !got.has(e.id)).map(e => ({ id: e.id, hint: e.hint }));
  const unlisted = earned.filter(e => !e.listed).length;
  return { found: earned.length, total: list.length + unlisted, earned, missing };
}
