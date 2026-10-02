// v1.1: the DSP's pedal send bus (fourth output), Pre/Post, Insert, and the
// Guitar Level link source. The send is silent and Insert ignored until the
// host says the pedal loop runs ({t:'pedal', active: true}).
import { describe, it, expect } from 'vitest';
import { MOD_PARAM_IDS, LINK_SOURCES } from '../../src/core/params.js';
import { makeDSP, rms, allFinite } from '../dsp/helpers.js';

const SR = 48000;
const GUITAR = LINK_SOURCES.indexOf('Guitar Level');

/** Render with all four buses; `ped: false` passes no pedal arrays (the v1.0 call). */
function run(dsp, seconds, { ped = true } = {}) {
  const total = Math.round(seconds * SR);
  const out = { L: new Float32Array(total), D: new Float32Array(total), V: new Float32Array(total), P: new Float32Array(total), PR: new Float32Array(total) };
  const b = Array.from({ length: 8 }, () => new Float32Array(128));
  let t = dsp.lastTime || 0;
  for (let i = 0; i < total; i += 128) {
    const n = Math.min(128, total - i);
    if (ped) dsp.process(b[0], b[1], b[2], b[3], b[4], b[5], n, t, b[6], b[7]);
    else dsp.process(b[0], b[1], b[2], b[3], b[4], b[5], n, t);
    out.L.set(b[0].subarray(0, n), i); out.D.set(b[2].subarray(0, n), i); out.V.set(b[4].subarray(0, n), i);
    if (ped) { out.P.set(b[6].subarray(0, n), i); out.PR.set(b[7].subarray(0, n), i); }
    t += n / SR;
  }
  dsp.lastTime = t;
  return out;
}

function playing(params, { active = true } = {}) {
  const dsp = makeDSP({ terrainA: 0, terrainB: 1, params: { level: 0.75, delaySend: 0.3, reverbSend: 0.3, sustain: 1, attack: 0.001, ...params } });
  if (active) dsp.handleMessage({ t: 'pedal', active: true });
  dsp.handleMessage({ t: 'noteOn', part: 0, note: 57, vel: 0.9, time: 0 });
  return dsp;
}

const tail = (a) => rms(a, a.length >> 1);

describe('DSP pedal send', () => {
  it('is silent and changes nothing until the host turns the pedal loop on', () => {
    const a = run(playing({ pedalSend: 1, pedalInsert: 1 }, { active: false }), 0.25);
    const b = run(playing({ pedalSend: 1, pedalInsert: 1 }, { active: false }), 0.25, { ped: false });
    expect(tail(a.L)).toBeGreaterThan(0.01);
    expect(a.P.every(x => x === 0)).toBe(true);
    // Same dry output with or without the pedal arrays (the bounce path passes none).
    expect(a.L).toEqual(b.L);
    expect(a.D).toEqual(b.D);
  });

  it('post-fader: the send follows the level fader', () => {
    const o = run(playing({ pedalSend: 0.5, level: 0.75 }), 0.3);
    expect(allFinite(o.P) && allFinite(o.PR)).toBe(true);
    expect(tail(o.P) / tail(o.L)).toBeCloseTo(0.5, 2);
    expect(tail(o.PR)).toBeGreaterThan(0);
  });

  it('pre-fader: the send ignores the level fader', () => {
    const o = run(playing({ pedalSend: 0.5, pedalPre: 1, level: 0.25 }), 0.3);
    // pre = send, post dry = level^2  ->  ratio 0.5 / 0.0625 = 8
    expect(tail(o.P) / tail(o.L)).toBeCloseTo(8, 1);
  });

  it('mute silences the send, pre or post', () => {
    for (const pre of [0, 1]) {
      const o = run(playing({ pedalSend: 1, pedalPre: pre, mute: 1 }), 0.3);
      expect(tail(o.P)).toBe(0);
    }
  });

  it('insert mutes the dry sound and its delay/reverb sends while the send runs', () => {
    const o = run(playing({ pedalSend: 0.8, pedalInsert: 1 }), 0.3);
    expect(tail(o.L)).toBe(0);
    expect(tail(o.D)).toBe(0);
    expect(tail(o.V)).toBe(0);
    expect(tail(o.P)).toBeGreaterThan(0.01);
  });

  it('turning the loop off brings the dry sound back and silences the send', () => {
    const dsp = playing({ pedalSend: 0.8, pedalInsert: 1 });
    run(dsp, 0.2);
    dsp.handleMessage({ t: 'pedal', active: false });
    const o = run(dsp, 0.3);
    expect(tail(o.L)).toBeGreaterThan(0.01);
    expect(tail(o.P)).toBe(0);
  });
});

describe('Guitar Level link source', () => {
  it('moves the linked parameter with the guitar envelope from the host', () => {
    const dsp = makeDSP({ terrainA: 0, params: { cutoff: 200 } });
    dsp.handleMessage({ t: 'links', part: 0, links: [{ src: GUITAR, dst: 'cutoff', amt: 1, curve: 0 }] });
    const slot = MOD_PARAM_IDS.indexOf('cutoff');
    run(dsp, 0.05);
    expect(dsp.parts[0].partLink[slot]).toBe(0);
    dsp.handleMessage({ t: 'guitar', v: 0.8 });
    run(dsp, 0.3);
    expect(dsp.parts[0].partLink[slot]).toBeCloseTo(0.8, 3);
    dsp.handleMessage({ t: 'guitar', v: 7 });   // clamped to 0..1
    run(dsp, 0.3);
    expect(dsp.parts[0].partLink[slot]).toBeCloseTo(1, 3);
  });
});
