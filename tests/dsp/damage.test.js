// v2.9 Operator panel DSP: drop and water damage, Glitch, Slowdown, Vintage
// and the Service test tones (src/dsp/damage.js), plus the master hook in
// OroDSP, the session sanitizer and the store sync message.
import { describe, it, expect } from 'vitest';
import { MasterOperator, sanitizeOperator, operatorSounds, OPERATOR_DEFAULTS } from '../../src/dsp/damage.js';
import { migrateState } from '../../src/core/migrate.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { SR, makeDSP, render } from './helpers.js';

const on = (o) => ({ ...OPERATOR_DEFAULTS, ...o });

function sine(seconds, f = 440, a = 0.5) {
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = R[i] = a * Math.sin(2 * Math.PI * f * i / SR);
  return { L, R };
}
function silence(seconds) { const n = Math.round(seconds * SR); return { L: new Float32Array(n), R: new Float32Array(n) }; }
function noise(seconds, a = 0.3) {
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; L[i] = R[i] = a * (s / 2147483648 - 1); }
  return { L, R };
}

/** Runs a copy of `input` through `op` in 128-sample blocks; `script(op, block)` runs before each block. */
function run(op, input, { voices = 0, script = null } = {}) {
  const L = Float32Array.from(input.L), R = Float32Array.from(input.R);
  for (let i = 0, k = 0; i < L.length; i += 128, k++) {
    if (script) script(op, k);
    const n = Math.min(128, L.length - i);
    op.process(L.subarray(i, i + n), R.subarray(i, i + n), n, voices);
  }
  return { L, R };
}

function goertzel(x, f, from = 0, to = x.length) {
  const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) * 2 / (to - from);
}
/** Strongest frequency near f0 (0.1 Hz steps) -> cents from f0. */
function centsOff(x, f0, from, to) {
  let best = 0, bf = f0;
  for (let f = f0 * 0.96; f <= f0 * 1.04; f += 0.1) { const g = goertzel(x, f, from, to); if (g > best) { best = g; bf = f; } }
  return 1200 * Math.log2(bf / f0);
}
const mix = ({ L, R }) => L.map((v, i) => v + R[i]);
const rmsAt = (x, from, len) => { let s = 0; for (let i = from; i < from + len; i++) s += x[i] * x[i]; return Math.sqrt(s / len); };
const diffRms = (x, from, to) => { let s = 0; for (let i = from + 1; i < to; i++) { const d = x[i] - x[i - 1]; s += d * d; } return Math.sqrt(s / (to - from)); };

describe('operator: off is bit-identical', () => {
  const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
  const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
  const PLAIN = { filterType: 0, pathShape: P.ellipse, pathOrder: 1, size: 0.3, attack: 0.001, sustain: 1, velSens: 0 };
  const play = (setup) => {
    const dsp = makeDSP({ terrainA: T.swell, params: PLAIN });
    if (setup) setup(dsp);
    dsp.handleMessage({ t: 'noteOn', part: 0, note: 57, vel: 1, time: 0 });
    return render(dsp, 0.4);
  };

  it('renders exactly the same with no operator, an all-off one, or one turned on and off again', () => {
    const ref = play(null);
    const allOff = play((d) => d.handleMessage({ t: 'operator', cfg: { ...OPERATOR_DEFAULTS, dropSeverity: 0.9, hum: 60 } }));
    const back = play((d) => {
      d.handleMessage({ t: 'operator', cfg: on({ drop: 1, water: 1, vintage: 1 }) });
      d.handleMessage({ t: 'operator', cfg: null });
    });
    for (const r of [allOff, back]) {
      expect(r.L).toEqual(ref.L); expect(r.R).toEqual(ref.R);
      expect(r.DL).toEqual(ref.DL); expect(r.VL).toEqual(ref.VL);
    }
    expect(ref.L.some(v => v !== 0)).toBe(true);
  });

  it('the processor leaves the buffers untouched while nothing is on', () => {
    const op = new MasterOperator(SR);
    const src = sine(0.1);
    expect(run(op, src).L).toEqual(src.L);
    op.configure(on({ drop: 1, water: 1 }));   // switched on, but nothing has happened yet
    expect(op.needs()).toBe(false);
    expect(run(op, src).R).toEqual(src.R);
    expect(op.action('drop')).toBe(true);
    op.configure(null);
    expect(op.action('drop')).toBe(false);     // Drop it does nothing while Drop damage is off
  });

  it('a session dsp hook changes the sound once a drop happens, and reports it', () => {
    const msgs = [];
    const dsp = makeDSP({ terrainA: T.swell, params: PLAIN });
    dsp.postMessage = (m) => msgs.push(m);
    dsp.handleMessage({ t: 'watch', part: 0 });
    dsp.handleMessage({ t: 'operator', cfg: on({ drop: 1, dropSeverity: 1 }) });
    dsp.handleMessage({ t: 'opAction', a: 'drop', v: 1 });
    dsp.handleMessage({ t: 'noteOn', part: 0, note: 57, vel: 1, time: 0 });
    const out = render(dsp, 0.4);
    expect(out.L).not.toEqual(play(null).L);
    const tele = msgs.filter(m => m.t === 'tele').pop();
    expect(tele.op.dmg).toBeCloseTo(0.5, 6);
    dsp.handleMessage({ t: 'opAction', a: 'bogus' });     // unknown actions are ignored
    dsp.handleMessage({ t: 'opState', dmg: 0.25, wet: 0.5, dir: -1 });
    expect(dsp.op.telemetry()).toMatchObject({ dmg: 0.25, wet: 0.5, dir: -1 });
  });
});

describe('operator: drop damage', () => {
  const dropped = (sev, drops = 1, input = silence(40)) => {
    const op = new MasterOperator(SR);
    op.configure(on({ drop: 1, dropSeverity: sev }));
    for (let i = 0; i < drops; i++) op.action('drop', 1);
    return { op, out: run(op, input) };
  };

  it('adds a thud, then crackle, cutouts and dropouts that grow with severity', () => {
    const none = dropped(0), low = dropped(0.3), high = dropped(1);
    expect(none.op.dmg).toBe(0);
    expect(none.out.L.every(v => v === 0)).toBe(true);
    expect(Math.max(...high.out.L.subarray(0, SR / 4).map(Math.abs))).toBeGreaterThan(0.2);     // the thud
    expect(high.op.stats.clicks).toBeGreaterThan(low.op.stats.clicks);
    expect(low.op.stats.clicks).toBeGreaterThan(0);
    expect(high.op.stats.cutouts).toBeGreaterThan(low.op.stats.cutouts);
    expect(rmsAt(high.out.L, 2 * SR, 30 * SR)).toBeGreaterThan(rmsAt(low.out.L, 2 * SR, 30 * SR));
  });

  it('cuts the sound out briefly and drops one side now and then', () => {
    const { op, out } = dropped(1, 2, sine(40));
    expect(op.dmg).toBe(1);
    const win = SR / 100;
    let both = 0, oneSide = 0;
    for (let i = SR; i + win < out.L.length; i += win) {
      const l = rmsAt(out.L, i, win), r = rmsAt(out.R, i, win);
      if (l < 0.02 && r < 0.02) both++;
      else if ((l < 0.02 && r > 0.2) || (r < 0.02 && l > 0.2)) oneSide++;
    }
    expect(both).toBeGreaterThan(0);
    expect(oneSide).toBeGreaterThan(0);
    expect(op.stats.dropouts).toBeGreaterThan(0);
    expect(op.stats.scratches).toBeGreaterThan(0);
  });

  it('knocks the pitch out of tune in proportion to severity', () => {
    const measure = (sev) => {
      const { op, out } = dropped(sev, 1, sine(6));
      return { cents: centsOff(mix(out), 440, 2 * SR, 6 * SR), dir: op.dir };
    };
    const low = measure(0.2), high = measure(0.8);
    expect(Math.sign(high.cents)).toBe(high.dir);
    expect(Math.abs(high.cents)).toBeGreaterThan(10);
    expect(Math.abs(high.cents)).toBeLessThan(30);
    expect(Math.abs(high.cents)).toBeGreaterThan(Math.abs(low.cents) * 2);
  });
});

describe('operator: water damage', () => {
  const wet = (o, input, seconds) => {
    const op = new MasterOperator(SR);
    op.configure(on({ water: 1, waterSeverity: 1, ...o }));
    op.action('spill', 1);
    return { op, out: run(op, input || silence(seconds)) };
  };

  it('muffles the tone (less high-frequency energy)', () => {
    const src = noise(3);
    const { out } = wet({ staysWet: 1 }, src);
    const ratio = (x) => diffRms(x, SR, 3 * SR) / rmsAt(x, SR, 2 * SR);
    expect(ratio(out.L)).toBeLessThan(ratio(src.L) * 0.5);
  });

  it('adds mains hum at the chosen 50 or 60 Hz', () => {
    const at = (hum) => { const { out } = wet({ staysWet: 1, hum }, null, 4); return [goertzel(out.L, 50, 2 * SR, 4 * SR), goertzel(out.L, 60, 2 * SR, 4 * SR)]; };
    const [a50, a60] = at(50), [b50, b60] = at(60);
    expect(a50).toBeGreaterThan(0.003);
    expect(a50).toBeGreaterThan(a60 * 5);
    expect(b60).toBeGreaterThan(b50 * 5);
  });

  it('shorts out and has rare bit errors when soaked', () => {
    const op = new MasterOperator(SR);
    op.configure(on({ water: 1, waterSeverity: 1, staysWet: 1 }));
    op.action('spill', 1); op.action('spill', 1);
    run(op, sine(60));
    expect(op.wet).toBe(1);
    expect(op.stats.shorts).toBeGreaterThan(5);
    expect(op.stats.bitErrors).toBeGreaterThan(0);
  });

  it('dries out over a few minutes, unless Stays wet is on', () => {
    const drying = wet({}, null, 60).op;
    expect(drying.wet).toBeGreaterThan(0.1);
    expect(drying.wet).toBeLessThan(0.3);
    run(drying, silence(120));
    expect(drying.wet).toBe(0);
    const staying = wet({ staysWet: 1 }, null, 60).op;
    expect(staying.wet).toBeCloseTo(0.6, 9);
  });
});

describe('operator: repair and determinism', () => {
  it('Repair clears the damage and the output returns to the exact input', () => {
    const op = new MasterOperator(SR);
    op.configure(on({ drop: 1, water: 1, dropSeverity: 1, waterSeverity: 1 }));
    op.action('drop', 1); op.action('spill', 1);
    const src = sine(1);
    run(op, sine(2));
    expect(op.action('repair', 'drop')).toBe(true);
    expect(op.dmg).toBe(0);
    expect(op.wet).toBeGreaterThan(0);
    op.action('repair', 'all');
    expect(op.wet).toBe(0);
    run(op, sine(4));
    expect(op.needs()).toBe(false);
    expect(run(op, src).L).toEqual(src.L);
  });

  it('gives the same output for the same actions', () => {
    const go = () => {
      const op = new MasterOperator(SR);
      op.configure(on({ drop: 1, water: 1, glitch: 1, glitchAmount: 1 }));
      return run(op, sine(5), { script: (o, k) => { if (k === 10) o.action('drop', 1); if (k === 200) o.action('spill', 0.7); } });
    };
    const a = go(), b = go();
    expect(a.L).toEqual(b.L);
    expect(a.R).toEqual(b.R);
  });
});

describe('operator: quirks and vintage', () => {
  it('Glitch repeats short slices of what just played', () => {
    const n = 30 * SR, L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = (i + 1) / n;     // every sample distinct
    const op = new MasterOperator(SR);
    op.configure(on({ glitch: 1, glitchAmount: 1 }));
    const out = run(op, { L, R: L.slice() });
    expect(op.stats.stutters).toBeGreaterThan(2);
    let repeated = 0;
    for (let i = 0; i < n; i++) {
      const v = out.L[i];
      if (v !== L[i] && v > 0 && Math.abs(v * n - Math.round(v * n)) < 1e-3 && Math.round(v * n) - 1 < i) repeated++;
    }
    expect(repeated).toBeGreaterThan(1000);
  });

  it('Slowdown sags the pitch when many voices sound, and leaves a light load alone', () => {
    const op = new MasterOperator(SR);
    op.configure(on({ slowdown: 1, slowAmount: 1 }));
    const src = sine(5);
    const light = run(op, src, { voices: 2 });
    expect(light.L).toEqual(src.L);
    const heavy = run(new MasterOperator(SR), src, { voices: 12, script: (o, k) => { if (k === 0) o.configure(on({ slowdown: 1, slowAmount: 1 })); } });
    const c = centsOff(mix(heavy), 440, 3 * SR, 5 * SR);
    expect(c).toBeLessThan(-55);
    expect(c).toBeGreaterThan(-85);
  });

  it('Vintage quantises to 12 bits and filters above the lower rate', () => {
    const dc = (v) => {
      const op = new MasterOperator(SR);
      op.configure(on({ vintage: 1 }));
      const n = SR / 10, L = new Float32Array(n).fill(v);
      return run(op, { L, R: L.slice() }).L[n - 1];
    };
    expect(dc(0.0001)).toBe(0);                     // below half a 12-bit step
    expect(dc(0.001)).toBeCloseTo(2 / 2048, 6);
    const op = new MasterOperator(SR);
    op.configure(on({ vintage: 1 }));
    const src = noise(1);
    const out = run(op, src);
    expect(goertzel(out.L, 18000, 0, SR)).toBeLessThan(goertzel(src.L, 18000, 0, SR) * 0.3);
  });
});

describe('operator: service tones', () => {
  it('plays a 1 kHz sine at -18 dBFS, a one-sided check and positive polarity pulses', () => {
    const op = new MasterOperator(SR);
    op.action('tone', 'sine');
    const s = run(op, silence(0.5));
    const peak = Math.max(...s.L.subarray(SR / 4).map(Math.abs));
    expect(20 * Math.log10(peak)).toBeCloseTo(-18, 1);
    expect(goertzel(s.L, 1000, SR / 4, SR / 2)).toBeGreaterThan(0.1);
    op.action('tone', 'left');
    const left = run(op, silence(0.5));
    expect(left.R.subarray(SR / 10).every(v => v === 0)).toBe(true);
    expect(rmsAt(left.L, SR / 10, SR / 4)).toBeGreaterThan(0.05);
    op.action('tone', 'polarity');
    const pol = run(op, silence(1.2));
    const tail = pol.L.subarray(SR / 10);
    expect(Math.max(...tail)).toBeGreaterThan(0.2);
    expect(Math.min(...tail)).toBeGreaterThanOrEqual(0);
    op.action('tone', 'off');
    run(op, silence(0.2));
    expect(op.needs()).toBe(false);
  });
});

describe('operator: session and sync', () => {
  it('sanitizes, omits the defaults and round-trips', () => {
    expect(sanitizeOperator(null)).toBe(null);
    expect(sanitizeOperator({ drop: 0, hum: 50 })).toBe(null);
    const s = migrateState({ ...defaultState(), operator: { drop: 1, dropSeverity: 3, hum: 60, water: 'yes', junk: 4 } });
    expect(s.operator).toEqual({ ...OPERATOR_DEFAULTS, drop: 1, dropSeverity: 1, hum: 60 });
    expect(migrateState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect('operator' in migrateState(defaultState())).toBe(false);
    expect(operatorSounds(s.operator)).toBe(true);
    expect(operatorSounds({ ...OPERATOR_DEFAULTS, realDrops: 1 })).toBe(false);
  });

  it('sends {t:"operator"} only once a session changes it, and null when it goes back', () => {
    const store = createStore(defaultState());
    const batches = [];
    let pending = null;
    const sync = createStoreSync({ store, post: (m) => batches.push(m), defer: (fn) => { pending = fn; } });
    const flush = () => { const f = pending; pending = null; if (f) f(); };
    expect(sync.snapshot().some(m => m.t === 'operator')).toBe(false);
    store.set('operator', { drop: 1 });
    flush();
    expect(batches.flat().find(m => m.t === 'operator').cfg.drop).toBe(1);
    expect(sync.snapshot().filter(m => m.t === 'operator').length).toBe(1);
    store.set('operator', undefined);
    flush();
    expect(batches.flat().filter(m => m.t === 'operator').pop().cfg).toBe(null);
  });
});
