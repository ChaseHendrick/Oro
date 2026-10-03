// v2.9 microtuning: Scala parsing, keyboard maps, tuning tables and the
// engine playing from them.
import { describe, it, expect, vi } from 'vitest';
import {
  parseScl, parseKbm, sanitizeTuning, tuningHz, tuningTable, tuningFollowsKey, describeTuning, TUNINGS, HZ_MAX,
} from '../../src/dsp/tuning.js';
import { mtof } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { SR, makeDSP, render } from './helpers.js';

vi.setConfig({ testTimeout: 60000 });

const cents = (a, b) => 1200 * Math.log2(a / b);

describe('Scala .scl parsing', () => {
  it('reads cents, ratios, whole numbers, comments and the period', () => {
    const s = parseScl([
      '! test.scl', '!', 'A test scale', ' 5', '! a comment between notes',
      ' 100.0 cents', ' 5/4', '3/2 the fifth', '7', '2/1', '',
    ].join('\r\n'));
    expect(s.name).toBe('A test scale');
    expect(s.cents.length).toBe(5);
    expect(s.cents[0]).toBe(100);
    expect(s.cents[1]).toBeCloseTo(cents(5, 4), 9);
    expect(s.cents[2]).toBeCloseTo(cents(3, 2), 9);
    expect(s.cents[3]).toBeCloseTo(cents(7, 1), 9);
    expect(s.cents[4]).toBeCloseTo(1200, 9);
  });

  it('accepts an empty description (using the file name) and negative cents', () => {
    const s = parseScl('!x\n\n2\n-10.5\n1200.\n', 'mine.scl');
    expect(s.name).toBe('mine.scl');
    expect(s.cents).toEqual([-10.5, 1200]);
  });

  it('rejects nonsense with a readable reason', () => {
    expect(() => parseScl('')).toThrow(/not a Scala scale/);
    expect(() => parseScl('d\nlots\n1/1\n')).toThrow(/whole number/);
    expect(() => parseScl('d\n0\n')).toThrow(/no notes/);
    expect(() => parseScl('d\n200\n' + '2/1\n'.repeat(200))).toThrow(/up to 128/);
    expect(() => parseScl('d\n3\n100.0\n2/1\n')).toThrow(/2 of its 3/);
    expect(() => parseScl('d\n2\nabc\n2/1\n')).toThrow(/Note 1/);
    expect(() => parseScl('d\n2\n3/0\n2/1\n')).toThrow(/positive ratio/);
    expect(() => parseScl('d\n1\n1/2\n')).toThrow(/period/);
    expect(() => parseScl(42)).toThrow();
  });
});

describe('Scala .kbm keyboard maps', () => {
  const WHITE = ['! white keys only', '12', '0', '127', '60', '69', '440.0', '7',
    '0', 'x', '1', 'x', '2', '3', 'x', '4', 'x', '5', 'x', '6'].join('\n');

  it('parses the header and the map with unmapped keys', () => {
    const m = parseKbm(WHITE);
    expect(m).toMatchObject({ size: 12, first: 0, last: 127, middle: 60, refNote: 69, refHz: 440, octave: 7 });
    expect(m.keys).toEqual([0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6]);
  });

  it('maps a 7-note scale onto the white keys, the reference key at its frequency', () => {
    const scl = parseScl('just major\n7\n9/8\n5/4\n4/3\n3/2\n5/3\n15/8\n2/1\n');
    const hz = tuningHz({ id: 'scala', scale: scl, map: parseKbm(WHITE) });
    expect(hz[69]).toBeCloseTo(440, 9);
    expect(hz[60]).toBeCloseTo(440 * 3 / 5, 9);          // A is 5/3 above C
    expect(hz[64] / hz[60]).toBeCloseTo(5 / 4, 12);      // E
    expect(hz[72] / hz[60]).toBeCloseTo(2, 12);           // the octave degree repeats the map
    expect(hz[61]).toBe(hz[60]);                          // unmapped keys play the mapped key below
  });

  it('a linear map (size 0) steps one degree per key', () => {
    const m = parseKbm('0\n0\n127\n60\n60\n261.0\n0\n');
    const hz = tuningHz({ id: 'equal19', map: m });
    expect(hz[60]).toBeCloseTo(261, 9);
    expect(hz[61] / hz[60]).toBeCloseTo(Math.pow(2, 1 / 19), 12);
  });

  it('rejects broken maps', () => {
    expect(() => parseKbm('12\n0\n')).toThrow(/header/);
    expect(() => parseKbm('12\n0\n127\n60\n69\nfast\n12\n')).toThrow(/frequency/);
    expect(() => parseKbm('12\n100\n10\n60\n69\n440\n12\n')).toThrow(/first key/);
    expect(() => parseKbm('2\n0\n127\n60\n69\n440\n12\nx\nx\n')).toThrow(/unmapped/);
    expect(() => parseKbm('2\n0\n127\n60\n69\n440\n12\n0\nq\n')).toThrow(/Map entry 2/);
  });
});

describe('tuning tables', () => {
  it('the default table is exactly 440 * 2^((n - 69) / 12), and the engine gets none', () => {
    const hz = tuningHz(null);
    for (let n = 0; n < 128; n++) expect(hz[n]).toBe(mtof(n));
    expect(tuningTable(undefined)).toBe(null);
    expect(tuningTable({ id: 'equal12', ref: 440 })).toBe(null);
    expect(sanitizeTuning({ id: 'equal12', ref: 440, root: 3 })).toBe(null);
  });

  it('reference pitch moves A4 and clamps to 400..480 Hz', () => {
    expect(tuningHz({ id: 'equal12', ref: 432 })[69]).toBe(432);
    expect(tuningHz({ id: 'equal12', ref: 432 })[81]).toBeCloseTo(864, 9);
    expect(sanitizeTuning({ id: 'equal12', ref: 9000 }).ref).toBe(480);
    expect(sanitizeTuning({ id: 'equal12', ref: -5 }).ref).toBe(400);
  });

  it('19-TET steps by 2^(1/19); 24-TET and 31-TET likewise', () => {
    for (const [id, n] of [['equal19', 19], ['equal24', 24], ['equal31', 31]]) {
      const hz = tuningHz({ id, root: 0 });
      expect(hz[61] / hz[60]).toBeCloseTo(Math.pow(2, 1 / n), 12);
      expect(hz[60 + n] / hz[60]).toBeCloseTo(2, 12);
      expect(hz[60]).toBeCloseTo(mtof(60), 9);      // the root keeps its 12-TET pitch
    }
  });

  it('just intonation has a 5/4 major third and A4 stays on the reference', () => {
    const hz = tuningHz({ id: 'just5', root: 0 });
    expect(hz[64] / hz[60]).toBeCloseTo(5 / 4, 12);
    expect(hz[67] / hz[60]).toBeCloseTo(3 / 2, 12);
    expect(hz[69]).toBeCloseTo(440, 9);
    expect(hz[72] / hz[60]).toBeCloseTo(2, 12);
  });

  it('Pythagorean, meantone and Werckmeister III have their characteristic intervals', () => {
    const py = tuningHz({ id: 'pythagorean', root: 0 });
    expect(py[64] / py[60]).toBeCloseTo(81 / 64, 12);
    const mt = tuningHz({ id: 'meantone', root: 0 });
    expect(mt[64] / mt[60]).toBeCloseTo(5 / 4, 12);           // pure third from four narrowed fifths
    expect(cents(mt[67], mt[60])).toBeCloseTo(1200 * Math.log2(5) / 4, 6);
    const w = TUNINGS.find(t => t.id === 'werckmeister3').cents;
    const expected = [90.225, 192.180, 294.135, 390.225, 498.045, 588.270, 696.090, 792.180, 888.270, 996.090, 1092.180, 1200];
    w.forEach((c, i) => expect(c).toBeCloseTo(expected[i], 2));
  });

  it('Bohlen-Pierce repeats at 3/1 after 13 steps', () => {
    const hz = tuningHz({ id: 'bohlenPierce', root: 0 });
    expect(hz[73] / hz[60]).toBeCloseTo(3, 12);
    expect(hz[61] / hz[60]).toBeCloseTo(Math.pow(3, 1 / 13), 12);
    expect(Math.max(...hz)).toBeLessThanOrEqual(HZ_MAX);
  });

  it('a tuning that follows the key moves its root with it', () => {
    const t = { id: 'just5' };
    expect(tuningFollowsKey(t)).toBe(true);
    const inA = tuningHz(t, 9);
    expect(inA[73] / inA[69]).toBeCloseTo(5 / 4, 12);      // A to C# is the just third
    expect(tuningFollowsKey({ id: 'just5', root: 2 })).toBe(false);
    expect(describeTuning(t).text).toMatch(/Just intonation.*12 notes per octave/);
  });

  it('is saved only when it is not the default', () => {
    expect('tuning' in migrateState({ version: 5, parts: [] })).toBe(false);
    expect(migrateState({ version: 5, parts: [], tuning: { id: 'equal12', ref: 440 } }).tuning).toBe(undefined);
    expect(migrateState({ version: 5, parts: [], tuning: { id: 'equal19', ref: 441 } }).tuning).toEqual({ id: 'equal19', ref: 441, root: -1 });
    // a broken imported scale falls back to the default
    expect(migrateState({ parts: [], tuning: { id: 'scala', scale: { cents: [NaN] } } }).tuning).toBe(undefined);
  });
});

describe('engine plays the tuning', () => {
  const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
  const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
  const PLAIN = { filterType: 0, pathShape: P.ellipse, pathOrder: 1, size: 0.3, attack: 0.001, sustain: 1, velSens: 0 };

  function tone(note, tuning, extra = []) {
    const dsp = makeDSP({ terrainA: T.swell, params: PLAIN });
    if (tuning !== undefined) dsp.handleMessage({ t: 'tuning', hz: tuning });
    for (const m of extra) dsp.handleMessage(m);
    dsp.handleMessage({ t: 'noteOn', part: 0, note, vel: 1, time: 0 });
    return render(dsp, 0.5).L;
  }

  /** Fundamental by normalised autocorrelation, refined with a parabola. */
  function pitch(x, lo, hi, start = 6000, N = 12000) {
    const lagMin = Math.floor(SR / hi), lagMax = Math.ceil(SR / lo);
    let best = -Infinity, bl = lagMin;
    const r = [];
    for (let L = lagMin - 1; L <= lagMax + 1; L++) {
      let s = 0, e1 = 0, e2 = 0;
      for (let n = start; n < start + N; n++) { s += x[n] * x[n + L]; e1 += x[n] * x[n]; e2 += x[n + L] * x[n + L]; }
      r[L] = s / Math.sqrt(e1 * e2 + 1e-30);
      if (L >= lagMin && L <= lagMax && r[L] > best) { best = r[L]; bl = L; }
    }
    const a = r[bl - 1], b = r[bl], c = r[bl + 1];
    const off = 0.5 * (a - c) / (a - 2 * b + c);
    return SR / (bl + (Number.isFinite(off) ? off : 0));
  }

  it('the default tuning (and an explicit reset) renders bit for bit as before', () => {
    const a = tone(57);
    const b = tone(57, null);
    expect(b).toEqual(a);
  });

  it('a 19-TET key sounds at its tuned frequency', () => {
    const hz = tuningTable({ id: 'equal19', root: 0 });
    const f = pitch(tone(61, hz), 240, 300);
    const want = mtof(60) * Math.pow(2, 1 / 19);
    expect(Math.abs(f / want - 1)).toBeLessThan(0.002);
    expect(Math.abs(f / mtof(61) - 1)).toBeGreaterThan(0.01);
  });

  it('bend and Tune move by keys through the tuning; Fine and Octave stay equal-tempered', () => {
    const hz = tuningHz({ id: 'just5', root: 0 });
    const tab = tuningTable({ id: 'just5', root: 0 });
    const near = (f, want) => expect(Math.abs(f / want - 1)).toBeLessThan(0.002);
    // a full bend of 2 semitones plays two keys up: E -> F#, the tuned 45/32
    near(pitch(tone(64, tab, [{ t: 'params', part: 0, p: { bendRange: 2 } }, { t: 'bend', part: 0, v: 1 }]), 300, 420), hz[66]);
    // half of a 1 semitone bend lands halfway (in log frequency) between E and F
    near(pitch(tone(64, tab, [{ t: 'params', part: 0, p: { bendRange: 1 } }, { t: 'bend', part: 0, v: 0.5 }]), 300, 400), Math.sqrt(hz[64] * hz[65]));
    // Tune +2 is two keys; Fine 50 is 50 cents; Octave +1 is 2/1
    near(pitch(tone(64, tab, [{ t: 'params', part: 0, p: { tune: 2 } }]), 300, 420), hz[66]);
    near(pitch(tone(64, tab, [{ t: 'params', part: 0, p: { fine: 50 } }]), 300, 400), hz[64] * Math.pow(2, 50 / 1200));
    near(pitch(tone(64, tab, [{ t: 'params', part: 0, p: { octave: 1 } }]), 600, 800), hz[64] * 2);
  });

  it('beyond the table ends the end step is extrapolated', () => {
    const dsp = makeDSP({});
    dsp.setTuning(tuningTable({ id: 'equal19', root: 0 }));
    const t = dsp.tuneSemis;
    expect(dsp.tunedPitch(129)).toBeCloseTo(t[127] + 2 * (t[127] - t[126]), 9);
    expect(dsp.tunedPitch(-1)).toBeCloseTo(t[0] - (t[1] - t[0]), 9);
    expect(dsp.tunedPitch(60.5)).toBeCloseTo((t[60] + t[61]) / 2, 12);
  });
});
