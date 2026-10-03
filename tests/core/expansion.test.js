import { describe, it, expect } from 'vitest';
import { defaultState, defaultPart, MOD_PARAM_IDS, SCALES, SCALE_NAMES, ARP_RHYTHMS } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { encodeNoiseRecording, decodeNoiseRecording } from '../../src/dsp/noise-recording.js';
import { createStore } from '../../src/core/store.js';
import { createPresets } from '../../src/presets/presets.js';
import { createMemoryStorage, createFakeClock, createFakeEngine } from '../music/fakes.js';
import { createMusic } from '../../src/music/music.js';

describe('v2 compatibility and persistence', () => {
  it('preserves the duration and values of every old Steps LFO cell', () => {
    const old = Array.from({ length: 16 }, (_, i) => i / 8 - 1);
    const loaded = migrateState({ version: 4, parts: [{ mods: { morph: { lfoShape: 6, steps: old } } }] });
    expect(loaded.parts[0].mods.morph.steps).toEqual(old.flatMap(v => [v,v]));
    expect(loaded.parts[0].params.sub2).toBe(0);
    expect(loaded.parts[0].params.phaseMod).toBe(0);
    expect(loaded.global.vectorMix).toBe(0);
    expect(loaded.parts[0].trackFx.slots.every(s => s.type === 'bypass')).toBe(true);
  });
  it('round-trips independent envelopes, all four controller slots, effects and recording', async () => {
    const state = defaultState(), part = state.parts[0];
    for (const id of MOD_PARAM_IDS) Object.assign(part.mods[id], { envOwn:1, envMode:3, envDelay:.2, envHold:.3, lfoCount:32, lfoSkew:.4, stepGlide:.7, ctrl1Source:5,ctrl1Depth:.2,ctrl2Source:6,ctrl2Depth:-.3,ctrl3Source:15,ctrl3Depth:.4,ctrl4Source:16,ctrl4Depth:.5 });
    part.trackFx.routing = 9; part.trackFx.slots[0] = { type:'shimmer',mix:.4,p1:.3,p2:.4,p3:.5,p4:.6 };
    part.noiseRecording = encodeNoiseRecording(Float32Array.from({length:8000}, (_, i) => Math.sin(i*.1)*.5),8000,'Test loop');
    const store = createStore(state), storage = createMemoryStorage(), presets = createPresets({store,storage}); await presets.ready;
    const id = presets.savePatch(0,'Expanded',{category:'Texture',author:'Chase',folder:'Tests'});
    const json = await presets.exportJSON('all').text();
    const restoredStore = createStore(defaultState()), restored = createPresets({store:restoredStore,storage:createMemoryStorage()}); await restored.ready;
    await restored.importJSON(json); restored.loadPatch(0,'Expanded');
    const actual = restoredStore.get('parts.0');
    expect(actual.mods).toEqual(part.mods); expect(actual.trackFx).toEqual(part.trackFx); expect(actual.noiseRecording).toEqual(part.noiseRecording);
    expect(presets.getPatch(id)).toMatchObject({author:'Chase',folder:'Tests',category:'Texture'});
  });
  it('keeps 36 ordered favourites across reload and export, with empty MIDI slots ignored', async () => {
    const storage = createMemoryStorage(), store = createStore(defaultState()), presets = createPresets({store,storage}); await presets.ready;
    const id = presets.savePatch(0,'Favourite test');
    expect(presets.programPatch(0)).toBeTruthy();
    expect(presets.setFavorite(35,id)).toBe(true); expect(presets.setFavorite(36,id)).toBe(false);
    expect(presets.programPatch(35)?.name).toBe('Favourite test'); expect(presets.programPatch(0)).toBeNull();
    const reloaded = createPresets({store,storage}); await reloaded.ready;
    expect(reloaded.favorites()).toHaveLength(36); expect(reloaded.programPatch(35)?.id).toBe(id);
    const imported = createPresets({store,storage:createMemoryStorage()}); await imported.ready;
    await imported.importJSON(await presets.exportJSON('all').text());
    expect(imported.programPatch(35)?.name).toBe('Favourite test');
  });
  it('resamples imported PCM duration and pitch consistently for offline exports', () => {
    const wave = Float32Array.from({length:8000}, (_, i) => Math.sin(2*Math.PI*100*i/8000)*.6);
    const recording = encodeNoiseRecording(wave,8000);
    const samples = decodeNoiseRecording(recording,48000);
    expect(samples).toHaveLength(48000);
    expect(samples[120]).toBeCloseTo(.6,3);
    expect(samples[240]).toBeCloseTo(0,3);
  });
});

describe('expanded arp', () => {
  it('offers 28 different periodic trigger patterns', () => {
    const cycles = ARP_RHYTHMS.map(({ steps }) => {
      for (let size = 1; size <= steps.length; size++) {
        if (steps.length % size === 0 && steps.every((value, i) => value === steps[i % size])) return steps.slice(0, size).join('');
      }
    });
    expect(cycles).toHaveLength(28);
    expect(new Set(cycles).size).toBe(28);
  });
  it('offers at least 36 distinct sorted scale interval sets', () => {
    expect(SCALE_NAMES.length).toBeGreaterThanOrEqual(36);
    const sets = Object.values(SCALES).map(s => s.join(','));
    expect(new Set(sets).size).toBe(sets.length);
    for (const scale of Object.values(SCALES)) {
      expect(scale[0]).toBe(0); expect(scale.every((v,i) => Number.isInteger(v) && v < 12 && (i===0 || v>scale[i-1]))).toBe(true);
    }
  });
  it('rhythm rests advance clock steps without consuming notes', () => {
    const clock=createFakeClock({startSec:2}), engine=createFakeEngine(clock), state=defaultState(); state.global.tempo=120;
    state.parts[0].arp={...defaultPart().arp,mode:1,rate:3,rhythm:2};
    const store=createStore(state), music=createMusic({store,engine,timers:clock.timers,perfNow:clock.perfNow});
    music.router.noteOn(0,60,.8); music.router.noteOn(0,64,.8); music.router.noteOn(0,67,.8);
    clock.advance(.6);
    const notes=engine.ons(0);
    expect(notes.slice(0,3).map(e=>e.note)).toEqual([60,64,67]);
    expect(notes[1].time-notes[0].time).toBeCloseTo(.25,4);
    expect(ARP_RHYTHMS.length).toBeGreaterThanOrEqual(23); music.dispose();
  });
});
