// New-install defaults (2.12): Pristine quality and a 96 kHz audio context.
//
// Existing installs keep every choice they have, including the old defaults
// (Standard, Auto rate) they never changed: the new defaults are written only
// when this computer has no saved session, settings or pedal rig at all. They
// are written once, as ordinary saved choices, so they stay put afterwards and
// Settings can change them like any other.

import { SETTINGS_KEY, sanitizePrefs } from '../ui/prefs.js';
import { RIG_KEY, defaultRig, sanitizeRig } from '../pedals/rig-settings.js';

export const NEW_INSTALL_DEFAULTS = Object.freeze({ audioQuality: 'pristine', sampleRate: 96000 });

/**
 * Seed the new-install defaults when nothing has been saved on this computer.
 * `hasSession`: a saved session was found (it may live outside localStorage).
 * Returns true when the defaults were written. Never throws.
 */
export function seedNewInstallDefaults({ hasSession = false, storage = globalThis.localStorage } = {}) {
  try {
    if (!storage || hasSession) return false;
    if (storage.getItem(SETTINGS_KEY) != null || storage.getItem(RIG_KEY) != null) return false;
    storage.setItem(SETTINGS_KEY, JSON.stringify(sanitizePrefs({ audioQuality: NEW_INSTALL_DEFAULTS.audioQuality })));
    storage.setItem(RIG_KEY, JSON.stringify(sanitizeRig({ ...defaultRig(), sampleRate: NEW_INSTALL_DEFAULTS.sampleRate })));
    return true;
  } catch {
    return false; // storage blocked: the old defaults apply, nothing breaks
  }
}
