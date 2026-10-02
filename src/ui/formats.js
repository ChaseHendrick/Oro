// Display formats where the generic formatValue() reads oddly for a control
// (for example Laps would read "100%" and Pan "-0.30"). Everything else
// uses the shared formatter from the parameter registry.

import { formatValue } from '../core/params.js';

const signedPercent = (v) => {
  const p = Math.round(v * 100);
  return (p > 0 ? '+' : '') + p + '%';
};

const VOWELS = ['A', 'E', 'I', 'O', 'U'];

const OVERRIDES = {
  noteSize: signedPercent,
  airTone: (v) => {
    const p = Math.round(Math.abs(v) * 100);
    return p === 0 ? 'Neutral' : `${v < 0 ? 'Dark' : 'Bright'} ${p}%`;
  },
  formant: (v) => {
    const x = Math.max(0, Math.min(1, v)) * 4;
    const i = Math.floor(x), f = x - i;
    if (f < 0.12 || i >= 4) return VOWELS[Math.min(4, Math.round(x))];
    if (f > 0.88) return VOWELS[i + 1];
    return `${VOWELS[i]}-${VOWELS[i + 1]}`;
  },
  laps: (v) => {
    const r = Math.round(v);
    if (Math.abs(v - r) < 0.005) return r === 1 ? '1 lap' : `${r} laps`;
    return `${v.toFixed(2)} laps`;
  },
  pace: signedPercent,
  stretch: signedPercent,
  filterEnv: signedPercent,
  pan: (v) => {
    const p = Math.round(Math.abs(v) * 100);
    if (p === 0) return 'Centre';
    return (v < 0 ? 'L ' : 'R ') + p;
  },
};

export function formatParam(def, v) {
  const f = def && OVERRIDES[def.id];
  return f ? f(v) : formatValue(def, v);
}
