import { describe, it, expect } from 'vitest';
import { makeDSP, render, rms, allFinite } from './helpers.js';
import { defaultTrackFx, defaultFxSlot, FX_ROUTINGS } from '../../src/dsp/track-fx-config.js';
import { MAX_PARTS } from '../../src/core/params.js';
const plain = { filterType: 0, size: .28, attack: .001, sustain: 1, velSens: 0, release: .005 };
const on = (part = 0) => ({ t: 'noteOn', part, note: 57, vel: .8 });
const rack = (type, extra = {}) => { const cfg = defaultTrackFx(); cfg.slots[0] = { ...defaultFxSlot(type), mix: 1, ...extra }; return cfg; };
describe('track rack inside the actual synth render path', () => {
  it('preserves the legacy waveform exactly with four bypass slots at every routing', () => {
    const reference = makeDSP({ params: plain }); reference.handleMessage(on()); const dry = render(reference, .04);
    for (const routing of FX_ROUTINGS) {
      const dsp = makeDSP({ params: plain }), fx = defaultTrackFx(); fx.routing = routing.id;
      dsp.handleMessage({ t: 'trackFx', part: 0, fx, sidechainIndex: -1 }); dsp.handleMessage(on()); const audio = render(dsp, .04);
      expect(audio.L).toEqual(dry.L); expect(audio.R).toEqual(dry.R); expect(audio.DL).toEqual(dry.DL); expect(audio.VL).toEqual(dry.VL);
    }
  });
  it('renders delay tails after voices finish and clears the rack on Panic', () => {
    const dsp = makeDSP({ params: plain });
    dsp.handleMessage({ t: 'trackFx', part: 0, fx: rack('delay', { p1: Math.log(4) / Math.log(100), p2: .9, p3: 1 }), sidechainIndex: -1 });
    render(dsp, .2); dsp.handleMessage(on()); render(dsp, .015); dsp.handleMessage({ t: 'noteOff', part: 0, note: 57 });
    const tail = render(dsp, .3); expect(dsp.parts[0].activeCount()).toBe(0);
    expect(allFinite(tail.L)).toBe(true); expect(rms(tail.L, 6000)).toBeGreaterThan(.002);
    dsp.handleMessage({ t: 'panic' }); const quiet = render(dsp, .1); expect(rms(quiet.L)).toBe(0); expect(dsp.parts[0].effects.meter().rms).toBe(0);
  });
  it('ducking uses the selected raw source while its own signal remains independent', () => {
    const run = (sourceOn) => {
      const dsp = makeDSP({ params: plain }); dsp.handleMessage({ t: 'params', part: 1, p: { ...plain, mute: 1 } });
      dsp.handleMessage({ t: 'trackFx', part: 0, fx: rack('duck', { p1: 1, p2: .35, p3: 0, p4: .1 }), sidechainIndex: 1 });
      render(dsp, .2); dsp.handleMessage(on()); if (sourceOn) dsp.handleMessage(on(1));
      const audio = render(dsp, .2); return { dsp, audio };
    };
    const alone = run(false), driven = run(true);
    expect(rms(alone.audio.L, 5000)).toBeGreaterThan(.02); expect(rms(driven.audio.L, 5000)).toBeLessThan(rms(alone.audio.L, 5000) * .1);
    expect(alone.dsp.parts[0].effects.meter().sidechain).toBe(0); expect(driven.dsp.parts[0].effects.meter().sidechain).toBeGreaterThan(.02);
  });
  it('keeps rack histories with track identity during a direct DSP reorder', () => {
    const dsp = makeDSP({ params: plain }), cfg = rack('delay', { p1: 0, p2: .7 });
    dsp.handleMessage({ t: 'trackFx', part: 0, fx: cfg, sidechainIndex: 2 }); render(dsp, .1); dsp.handleMessage(on()); render(dsp, .06);
    const part = dsp.parts[0], effects = part.effects, history = effects.slots[0].bufL;
    const perm = Array.from({ length: MAX_PARTS }, (_, i) => i); perm[0] = 2; perm[1] = 0; perm[2] = 1;
    dsp.handleMessage({ t: 'tracks', count: 4, perm, fresh: [] });
    expect(dsp.parts[1] === part).toBe(true); expect(dsp.parts[1].effects === effects).toBe(true); expect(dsp.parts[1].effects.slots[0].bufL === history).toBe(true);
    expect(dsp.parts[1].sidechainIndex).toBe(0); expect(rms(render(dsp, .04).L)).toBeGreaterThan(.01);
  });
});
