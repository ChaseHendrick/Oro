// The pet (v2.9): a small creature that lives on the map. Pure logic only:
// fun-layer.js draws it. It wanders slowly, turns away from steep ground,
// falls asleep after a while without notes and hops when a note plays.
// Positions are terrain coordinates (tiles, wrapping); times are seconds.
// Nothing here allocates after createPet().

export const PET = Object.freeze({
  speed: 0.035,          // tiles / s
  reducedSpeed: 0.015,   // with reduced motion
  sleepAfter: 20,        // s without notes
  hopTime: 0.4,          // s
  hopHeight: 0.16,       // world units
  maxSlope: 0.6,         // world rise per unit of run it will not walk up or down
  lookAhead: 0.02,       // tiles
});

export const DEFAULT_PET_NAME = 'Moss';
export const MAX_PET_NAME = 24;

/** A tidy name for the pet: trimmed, short, or the default. */
export function petName(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PET_NAME);
  return s || DEFAULT_PET_NAME;
}

const wrap = (x) => x - Math.floor(x);

export function createPet(u = 0.5, v = 0.5, now = 0, heading = 0) {
  return { u: wrap(u), v: wrap(v), heading, state: 'wander', hop: 0, lastNote: now, turnIn: 2, blocked: 0 };
}

/** 'hop' while hopping, otherwise 'wander' or 'sleep'. */
export function petMode(pet) {
  return pet.hop > 0 ? 'hop' : pet.state;
}

/** A note played: wake up, and hop unless motion is reduced. */
export function petNote(pet, now, reduced = false) {
  pet.lastNote = now;
  pet.state = 'wander';
  if (!reduced) pet.hop = PET.hopTime;
}

/** Height of the hop above the ground (world units). */
export function petHopHeight(pet) {
  if (!(pet.hop > 0)) return 0;
  const t = 1 - pet.hop / PET.hopTime;
  return Math.sin(Math.PI * t) * PET.hopHeight;
}

/**
 * Advance the pet by dt seconds. `slopeAt(u, v)` gives the steepness of the
 * land (world rise per unit of run), `rng()` a number in [0, 1).
 */
export function petStep(pet, dt, now, slopeAt, rng, reduced = false) {
  if (!(dt > 0)) return pet;
  if (pet.hop > 0) pet.hop = Math.max(0, pet.hop - dt);
  if (now - pet.lastNote >= PET.sleepAfter) pet.state = 'sleep';
  if (pet.state === 'sleep' || pet.hop > 0) return pet;
  pet.turnIn -= dt;
  if (pet.turnIn <= 0) {
    pet.heading += (rng() - 0.5) * 1.6;
    pet.turnIn = 1.5 + rng() * 3;
  }
  const c = Math.cos(pet.heading), s = Math.sin(pet.heading);
  if (slopeAt(wrap(pet.u + c * PET.lookAhead), wrap(pet.v + s * PET.lookAhead)) > PET.maxSlope) {
    // too steep ahead: turn away and try again next step
    pet.heading += Math.PI * (0.5 + rng());
    pet.blocked++;
    return pet;
  }
  const d = (reduced ? PET.reducedSpeed : PET.speed) * dt;
  pet.u = wrap(pet.u + c * d);
  pet.v = wrap(pet.v + s * d);
  return pet;
}
