// A speaking ring that holds steady instead of flickering with the level.

export const SPEAK_ON = 0.08;
export const SPEAK_OFF = 0.04;
export const SPEAK_HOLD_MS = 180;

export function createSpeaking({ now = () => Date.now(), holdMs = SPEAK_HOLD_MS } = {}) {
  let on = false;
  let until = 0;
  return {
    push(level, t = now()) {
      const n = Number(level) || 0;
      if (n >= SPEAK_ON) { on = true; until = t + holdMs; }
      else if (on && n <= SPEAK_OFF && t >= until) on = false;
      return on;
    },
    get speaking() { return on; },
  };
}
