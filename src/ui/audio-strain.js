// Audio strain safety net (2.11). New installs start at Pristine and 96 kHz;
// if this computer cannot keep up, the DSP load meter shows it first. When
// it reports sustained trouble, Oro offers (once per session, never silently)
// to step down to High. "Don't ask again" is remembered on this computer.

import { listen } from './dom.js';

export const STRAIN_LIMITS = Object.freeze({ dropoutWindowMs: 10000, dropoutLimit: 3, loadPercent: 90, loadMs: 5000 });
export const STRAIN_NO_ASK_KEY = 'orograph.strainNoAsk';

/**
 * Watch load reports ({ percent, overruns } per meter window, src/dsp/load-meter.js).
 * push() returns 'dropouts' when more than 3 blocks missed their deadline in
 * 10 s, 'load' after 5 s above 90%, otherwise null.
 */
export function createStrainWatch({ now = () => performance.now(), limits = STRAIN_LIMITS } = {}) {
  let drops = [];
  let highSince = null;
  return {
    push(report) {
      if (!report) return null;
      const t = now();
      const n = Math.min(64, Math.max(0, Math.round(Number(report.overruns) || 0)));
      for (let i = 0; i < n; i++) drops.push(t);
      drops = drops.filter(x => t - x <= limits.dropoutWindowMs);
      if (Number(report.percent) > limits.loadPercent) { if (highSince == null) highSince = t; }
      else highSince = null;
      if (drops.length > limits.dropoutLimit) return 'dropouts';
      if (highSince != null && t - highSince >= limits.loadMs) return 'load';
      return null;
    },
    reset() { drops = []; highSince = null; },
  };
}

const QUALITY_LABELS = { eco: 'Eco', standard: 'Standard', high: 'High', pristine: 'Pristine', raw: 'Raw' };
export function khz(hz) { return `${Math.round(hz / 100) / 10} kHz`; }
export function strainMessage(quality, rate) {
  return `Audio is struggling at ${QUALITY_LABELS[quality] || quality}${rate ? `, ${khz(rate)}` : ''}. Step down to High?`;
}

/**
 * The one-time suggestion. offer(reason) shows it when the quality is
 * Pristine, it has not been shown this session and the person has not said
 * "Don't ask again"; returns true when it was shown.
 */
export function createStrainSuggestion({ store, engine, toast, storage = globalThis.localStorage }) {
  let shown = false;
  const noAsk = () => { try { return storage?.getItem(STRAIN_NO_ASK_KEY) === '1'; } catch { return false; } };
  return {
    offer() {
      if (shown || noAsk() || store.get('ui.audioQuality') !== 'pristine') return false;
      shown = true;
      toast(strainMessage('pristine', engine && engine.sampleRate), {
        kind: 'warn', timeout: 20000,
        detail: 'High uses less processing. You can change it any time in Settings > Audio.',
        actions: [
          { label: 'Step down', onClick: () => store.set('ui.audioQuality', 'high', { source: 'ui' }) },
          { label: 'Keep' },
          { label: "Don't ask again", onClick: () => { try { storage?.setItem(STRAIN_NO_ASK_KEY, '1'); } catch { /* blocked */ } } },
        ],
      });
      return true;
    },
    get shown() { return shown; },
  };
}

/** Feed engine load reports to the watch; `onStrain(reason)` runs for each strained report. */
export function watchEngineStrain(engine, onStrain, { now } = {}) {
  const watch = createStrainWatch(now ? { now } : undefined);
  return listen(engine, 'load', (m) => { const reason = watch.push(m); if (reason) onStrain(reason); });
}
