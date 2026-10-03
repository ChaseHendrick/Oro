import { render, terrainChain } from '../helpers.js';

export const AIR_SCENARIOS = [
  { sr: 48000, quality: 'standard', tone: .3, unison: 2 },
  { sr: 44100, quality: 'eco', tone: -1, unison: 1 },
  { sr: 96000, quality: 'high', tone: 1, unison: 4 },
  { sr: 48000, quality: 'raw', tone: 0, unison: 2 },
];

// Legacy Air with two complete tracks, voice envelopes, modulation, gliding
// notes, changing noise/sub levels and a release. All six output buses matter.
export function renderLegacyAir(DSP, scenario) {
  const { sr, quality, tone, unison } = scenario;
  const dsp = new DSP(sr);
  dsp.handleMessage({ t: 'quality', mode: quality });
  for (let part = 0; part < 2; part++) {
    dsp.handleMessage({ t: 'terrain', part, slot: 0, levels: terrainChain(5) });
    dsp.handleMessage({ t: 'terrain', part, slot: 1, levels: terrainChain(0) });
    dsp.handleMessage({ t: 'params', part, p: {
      unison, sustain: .7, release: .04, air: .5, airTone: tone, sub: .2,
      glide: .035, keyTrack: .35, filterEnv: .25, detune: 23, spread: .8,
      velSens: .4, morph: .25, warp: .15, cutoff: 3200,
    } });
    dsp.handleMessage({ t: 'mods', part, m: {
      cutoff: { lfoRate: 4, lfoDepth: .08 },
      pan: { envDepth: .1 },
    } });
    for (let i = 0; i < 8; i++) dsp.handleMessage({ t: 'noteOn', part, note: 40 + i * 5 + part, vel: .45 + i * .05 });
  }
  return render(dsp, .26, (engine, time, block) => {
    if (block === 23) for (let part = 0; part < 2; part++) engine.handleMessage({ t: 'params', part, p: { air: .18, airTone: -tone, sub: .4 } });
    if (block === 39) for (let part = 0; part < 2; part++) engine.handleMessage({ t: 'params', part, p: { air: .65, cutoff: 750, detune: 5, spread: .25 } });
    if (time >= .17) for (let part = 0; part < 2; part++) for (let i = 0; i < 8; i++) engine.handleMessage({ t: 'noteOff', part, note: 40 + i * 5 + part });
  });
}
