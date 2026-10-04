import { describe, it, expect } from 'vitest';
import { createLink } from '../../src/link/link.js';
import { hostOutputs, hostParamList, applyHostParam } from '../../src/plugin/host.js';

describe('link and plugin host contract', () => {
  it('hides status until Link is on, then says what it can', () => {
    const link = createLink();
    expect(link.status()).toBe('');
    link.setOn(true);
    expect(link.status()).toBe('Not in this build');
    link.setAvailable(true);
    expect(link.status()).toBe('Looking');
    link.setPeers(2);
    expect(link.status()).toBe('2 peers');
    link.setStartStop(true);
    link.setPlaying(true);
    expect(link.status()).toBe('2 peers, playing');
    link.setPlaying(false);
    expect(link.status()).toBe('2 peers, stopped');
    link.setOn(false);
    expect(link.status()).toBe('');
  });

  it('numbers the mix as output 1 and maps the first host parameters', () => {
    const outs = hostOutputs(2);
    expect(outs[0]).toEqual({ index: 1, name: 'Mix', left: 0, right: 1 });
    expect(outs[1].name).toBe('Track 1');
    expect(outs[2].left).toBe(4);
    const list = hostParamList(4);
    expect(list[0].id).toBe('volume');
    expect(list.filter((p) => p.track === 0).map((p) => p.id)).toEqual(['level', 'mute', 'morph', 'cutoff', 'resonance', 'attack', 'release']);
    const sets = [];
    const store = { set(path, value, meta) { sets.push({ path, value, meta }); } };
    expect(applyHostParam(store, list[0], 0.4)).toBe('global.masterVolume');
    expect(sets[0].meta.source).toBe('plugin');
    expect(applyHostParam(store, list[1], 0.5)).toBe('parts.0.params.level');
  });
});
