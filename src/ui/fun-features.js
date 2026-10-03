// Day and night and the pet (v2.9): two map extras that run in the
// background once switched on in Settings (both off by default; nothing
// happens until then). Day and night asks the map for a palette tint at most
// once a minute; the pet follows the shared note stream to hop and wake up.

import { call } from './dom.js';
import { found, funData, setFunData } from '../core/fun.js';
import { dayTint, hourOf, isNightOwlHour } from '../visual/day-night.js';
import { petName } from '../visual/pet.js';

const MINUTE = 60000;

/** The pet's name (saved on this computer), or the default. */
export function getPetName() {
  const d = funData('pet');
  return petName(d && typeof d === 'object' ? d.name : '');
}

/** Rename the pet. Returns the name kept. */
export function setPetName(name) {
  const n = petName(name);
  const d = funData('pet');
  setFunData('pet', { ...(d && typeof d === 'object' ? d : {}), name: n });
  return n;
}

export function createFunFeatures(ctx, { now = () => new Date() } = {}) {
  const { prefs, visuals } = ctx;
  const fun = visuals && visuals.fun;
  let dayTimer = 0, dayOn = false, offNotes = null;

  function dayTick() {
    const hour = hourOf(now());
    call(visuals, 'setDayTint', dayTint(hour));
    if (isNightOwlHour(hour)) found('badge', 'night-owl');
  }
  function applyDay() {
    const on = !!prefs.get('dayNight');
    if (on === dayOn) return;
    dayOn = on;
    clearInterval(dayTimer); dayTimer = 0;
    if (on) { dayTick(); dayTimer = setInterval(dayTick, MINUTE); }
    else call(visuals, 'setDayTint', null);
  }

  function applyPet() {
    const on = !!prefs.get('pet') && !!fun;
    if (on === !!offNotes) return;
    fun.setPet(on);
    if (on) {
      offNotes = ctx.notes.on((ev) => { if (ev && ev.on) fun.petNote(); });
      found('badge', 'met-pet');
    } else {
      offNotes();
      offNotes = null;
    }
  }

  const offPrefs = prefs.on((key) => {
    if (key === 'dayNight') applyDay();
    else if (key === 'pet') applyPet();
  });
  applyDay();
  applyPet();

  return {
    dispose() {
      offPrefs();
      clearInterval(dayTimer);
      if (offNotes) offNotes();
    },
  };
}
