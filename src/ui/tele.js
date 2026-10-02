// Telemetry hub: keeps only the latest 'tele' message from the engine. Widgets
// read it in the shared frame loop instead of reacting to every message.

import { listen } from './dom.js';

const STALE_MS = 400;

export function createTele(engine) {
  let latest = null;
  let at = 0;
  const off = listen(engine, 'tele', (t) => {
    if (t && typeof t === 'object') { latest = t; at = performance.now(); }
  });
  const fresh = () => !!latest && performance.now() - at < STALE_MS;
  return {
    fresh,
    get latest() { return fresh() ? latest : null; },
    /** Live normalised value of a modulated parameter for `part`, or null. */
    norm(part, id) {
      if (!fresh() || latest.part !== part || !latest.n) return null;
      const v = latest.n[id];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },
    activeVoices(part) {
      if (!fresh() || !Array.isArray(latest.activeVoices)) return 0;
      return latest.activeVoices[part] || 0;
    },
    peak() {
      if (!fresh() || !Array.isArray(latest.peak)) return null;
      return latest.peak;
    },
    spinPhase(part) {
      if (!fresh() || latest.part !== part) return null;
      return typeof latest.spinPhase === 'number' ? latest.spinPhase : null;
    },
    dispose: off,
  };
}
