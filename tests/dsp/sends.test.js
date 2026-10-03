// v2.8 send effects: two shared return buses (src/dsp/send-fx.js) fed by
// every track's post-fader Send A / Send B.
import { describe, it, expect } from 'vitest';
import { makeDSP, render, rms, allFinite, SR } from './helpers.js';
import { SendReturns, sendDelaySeconds, SEND_IDLE_SECONDS } from '../../src/dsp/send-fx.js';
import { GLOBAL_PARAMS, PART_PARAM_MAP, DELAY_DIVS, defaultState, defaultPart } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { partWithPatch } from '../../src/presets/apply.js';
import { passInit } from '../../src/audio/bounce.js';

const plain = { filterType: 0, size: 0.28, attack: 0.001, sustain: 1, velSens: 0, release: 0.02, delaySend: 0.3, reverbSend: 0.3 };
const note = (part = 0) => ({ t: 'noteOn', part, note: 57, vel: 0.8 });
const off = (part = 0) => ({ t: 'noteOff', part, note: 57 });

function play(params = {}, global = null, seconds = 0.6) {
  const dsp = makeDSP({ params: { ...plain, ...params }, terrainA: 0 });
  if (global) dsp.handleMessage({ t: 'global', p: global });
  dsp.handleMessage(note());
  const a = render(dsp, 0.2);
  dsp.handleMessage(off());
  const b = render(dsp, seconds);
  return { dsp, a, b };
}
const diff = (x, y) => { const d = new Float32Array(x.length); for (let i = 0; i < x.length; i++) d[i] = x[i] - y[i]; return d; };

describe('send effects', () => {
  it('adds Send A / Send B and their returns as appended, default-off parameters', () => {
    expect(PART_PARAM_MAP.sendA.default).toBe(0);
    expect(PART_PARAM_MAP.sendB.default).toBe(0);
    const ids = GLOBAL_PARAMS.map(p => p.id);
    for (const id of ['sendASize', 'sendADecay', 'sendADamp', 'sendAPredelay', 'sendAReturn', 'sendBSync', 'sendBDiv', 'sendBTime', 'sendBFeedback', 'sendBTone', 'sendBPingPong', 'sendBReturn']) expect(ids).toContain(id);
    // appended after every older global, so numeric slots stay stable
    expect(ids.indexOf('sendASize')).toBeGreaterThan(ids.indexOf('sciTuringDiv'));
  });

  it('with every send at 0 the output is bit-identical and the buses never run', () => {
    const ref = play();
    // the send settings may be anything: nothing is sent, so nothing changes
    const other = play({}, { sendASize: 0.9, sendADecay: 9, sendAPredelay: 120, sendAReturn: 1, sendBSync: 0, sendBTime: 50, sendBFeedback: 0.9, sendBReturn: 1 });
    for (const k of ['L', 'R', 'DL', 'DR', 'VL', 'VR']) {
      expect(other.a[k]).toEqual(ref.a[k]);
      expect(other.b[k]).toEqual(ref.b[k]);
    }
    expect(ref.dsp.sendFx).toBe(null);
    expect(other.dsp.sendFx).toBe(null);
  });

  it('a nonzero Send A adds reverb energy on the return, after the note ends', () => {
    const ref = play();
    const wet = play({ sendA: 0.8 });
    expect(allFinite(wet.b.L) && allFinite(wet.b.R)).toBe(true);
    const tail = diff(wet.b.L, ref.b.L);
    // the reverb rings on well after the 20 ms release
    expect(rms(tail, Math.round(0.1 * SR), Math.round(0.4 * SR))).toBeGreaterThan(1e-3);
    expect(rms(ref.b.L, Math.round(0.1 * SR), Math.round(0.4 * SR))).toBeLessThan(1e-4);
    // the old delay / reverb send outputs are untouched by Send A
    expect(wet.a.DL).toEqual(ref.a.DL);
    expect(wet.a.VL).toEqual(ref.a.VL);
    // Return 0 silences the bus output
    const muted = play({ sendA: 0.8 }, { sendAReturn: 0 });
    expect(rms(diff(muted.b.L, ref.b.L))).toBeLessThan(1e-6);
  });

  it('Send B echoes exactly one tempo division later, alternating sides when ping-pong', () => {
    // a click: a very short note, Send B only, 1/8 at 120 bpm = 0.25 s
    const tempo = 120, div = DELAY_DIVS.findIndex(d => d.name === '1/8');
    const g = { tempo, sendBSync: 1, sendBDiv: div, sendBFeedback: 0.5, sendBPingPong: 1, sendBReturn: 1 };
    expect(sendDelaySeconds(g)).toBeCloseTo(0.25, 12);
    const click = { ...plain, attack: 0.001, decay: 0.001, sustain: 0, release: 0.001, delaySend: 0, reverbSend: 0 };
    const run = (sendB) => {
      const dsp = makeDSP({ params: { ...click, sendB }, terrainA: 0 });
      dsp.handleMessage({ t: 'global', p: g });
      dsp.handleMessage(note());
      return render(dsp, 0.8);
    };
    const dry = run(0), wet = run(1);
    const echo = { L: diff(wet.L, dry.L), R: diff(wet.R, dry.R) };
    const onset = (x, from = 0) => { const pk = Math.max(...x.map(Math.abs)); for (let i = from; i < x.length; i++) if (Math.abs(x[i]) > pk * 0.05) return i; return -1; };
    const d0 = onset(Array.from(dry.L));
    const e1 = onset(Array.from(echo.L));
    expect(Math.abs(e1 - d0 - 0.25 * SR)).toBeLessThanOrEqual(2);
    // ping-pong: the first echo is on the left only, the second on the right
    expect(rms(echo.R, e1, e1 + 2000)).toBeLessThan(rms(echo.L, e1, e1 + 2000) * 0.01);
    const e2 = onset(Array.from(echo.R));
    expect(Math.abs(e2 - d0 - 0.5 * SR)).toBeLessThanOrEqual(2);
  });

  it('free time in milliseconds when Sync is off', () => {
    expect(sendDelaySeconds({ sendBSync: 0, sendBTime: 375 })).toBeCloseTo(0.375, 12);
    expect(sendDelaySeconds({ sendBSync: 0, sendBTime: 5000 })).toBe(2);
  });

  it('a bus goes back to sleep once nothing is sent and it has rung out', () => {
    const s = new SendReturns(SR);
    s.configure({ sendBFeedback: 0, sendBSync: 0, sendBTime: 100 });
    const n = 128, z = new Float64Array(n), x = new Float64Array(n), oL = new Float64Array(n), oR = new Float64Array(n);
    x[0] = 1;
    s.process(z, z, x, x, oL, oR, n, false, true);
    expect(s.active).toBe(true);
    let blocks = 0;
    while (s.active && blocks < 2000) { s.process(z, z, z, z, oL, oR, n, false, false); blocks++; }
    expect(s.active).toBe(false);
    expect(blocks * n / SR).toBeGreaterThanOrEqual(SEND_IDLE_SECONDS);
  });

  it('Panic clears the return tails', () => {
    const wet = play({ sendA: 1, sendB: 1 }, null, 0.05);
    wet.dsp.handleMessage({ t: 'panic' });
    const after = render(wet.dsp, 0.1);
    expect(rms(after.L)).toBe(0);
  });

  it('a bounce pass carries the returns: the offline DSP renders them into the dry output', () => {
    const snapshot = [{ t: 'tracks', count: 1 }, { t: 'params', part: 0, p: { ...plain, sendA: 1, sendB: 1 } }, { t: 'global', p: { sendAReturn: 1, sendBReturn: 1 } }];
    const events = [{ time: 0, msg: { ...note(), time: 0 } }, { time: 0.1, msg: { ...off(), time: 0.1 } }];
    const renderPassHere = (snap) => {
      const { init } = passInit({ snapshot: snap, terrains: [], events });
      const dsp = makeDSP({ terrainA: 0 });
      for (const m of init) dsp.handleMessage(m);
      return render(dsp, 1);
    };
    const withSends = renderPassHere(snapshot);
    const without = renderPassHere(snapshot.map(m => (m.t === 'params' ? { ...m, p: { ...m.p, sendA: 0, sendB: 0 } } : m)));
    const late = (r) => rms(r.L, Math.round(0.3 * SR), Math.round(0.9 * SR));
    expect(late(without)).toBeLessThan(1e-4);
    expect(late(withSends)).toBeGreaterThan(1e-3);
  });

  it('sessions without the new fields load with sends at 0 and default returns; values round-trip', () => {
    const old = defaultState(2);
    for (const p of old.parts) { delete p.params.sendA; delete p.params.sendB; }
    for (const k of Object.keys(old.global)) if (k.startsWith('send')) delete old.global[k];
    const m = migrateState(JSON.parse(JSON.stringify(old)));
    for (const p of m.parts) { expect(p.params.sendA).toBe(0); expect(p.params.sendB).toBe(0); }
    expect(m.global.sendAReturn).toBe(0.8);
    expect(m.global.sendBSync).toBe(1);
    const st = defaultState(1);
    st.parts[0].params.sendA = 0.4; st.parts[0].params.sendB = 7;
    st.global.sendAPredelay = 999; st.global.sendBDiv = 2.4; st.global.sendBFeedback = 0.5;
    const r = migrateState(JSON.parse(JSON.stringify(st)));
    expect(r.parts[0].params.sendA).toBe(0.4);
    expect(r.parts[0].params.sendB).toBe(1);
    expect(r.global.sendAPredelay).toBe(250);
    expect(r.global.sendBDiv).toBe(2);
    expect(migrateState(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });

  it('a patch load keeps the track\'s Send A / Send B amounts', () => {
    const base = defaultPart(0);
    base.params.sendA = 0.5; base.params.sendB = 0.25;
    const loaded = partWithPatch(base, { name: 'X', params: { cutoff: 500, sendA: 1 } });
    expect(loaded.params.sendA).toBe(0.5);
    expect(loaded.params.sendB).toBe(0.25);
    expect(loaded.params.cutoff).toBe(500);
  });
});
