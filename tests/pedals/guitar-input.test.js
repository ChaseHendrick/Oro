import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGuitarInput } from '../../src/pedals/guitar.js';
import { fakeContext } from './fake-audio.js';
import { strum, pluck, midiToHz } from './signals.js';

afterEach(() => vi.unstubAllGlobals());

function scriptSetup(options = {}) {
  vi.stubGlobal('AudioWorkletNode', class { constructor() { throw new Error('fallback'); } });
  const ctx = fakeContext();
  let node;
  ctx.createScriptProcessor = () => { node = ctx.createGain(); return node; };
  const source = ctx.createGain();
  const input = createGuitarInput(ctx, source, options);
  const heard = [];
  for (const type of ['noteOn', 'noteOff', 'bend', 'pitch']) input.on(type, event => heard.push({ type, ...event }));
  function run(signal, startTime = 2) {
    const size = 2048;
    // Stop at the last full block while the strings still ring; adding a
    // partially empty block would be a mute and legitimately release them.
    for (let i = 0; i + size <= signal.length; i += size) {
      const block = new Float32Array(size);
      block.set(signal.subarray(i, i + size));
      const playbackTime = startTime + (i + 2 * size) / ctx.sampleRate;
      ctx.currentTime = playbackTime;
      node.onaudioprocess({ playbackTime, inputBuffer: { numberOfChannels: 1, getChannelData: () => block } });
    }
  }
  return { ctx, input, node, heard, run };
}

describe('live guitar input', () => {
  it('runs Chords in the ScriptProcessor fallback and releases every note on switch', () => {
    const { input, heard, run } = scriptSetup({ guitarMode: 'chords' });
    run(strum([52, 55, 59], { duration: 0.5 }));
    expect(input.via).toBe('script');
    expect(input.notes).toEqual([52, 55, 59]);
    expect(heard.filter(event => event.type === 'noteOn').every(event => event.time > 2.1 && event.time < 2.4)).toBe(true);
    expect(heard.find(event => event.type === 'pitch' && event.notes?.length === 3)).toMatchObject({ mode: 'chords', notes: [52, 55, 59] });
    const before = heard.length;
    input.configure({ guitarMode: 'single' });
    expect(input.notes).toEqual([]);
    expect(heard.slice(before).filter(event => event.type === 'noteOff').map(event => event.note).sort((a, b) => a - b)).toEqual([52, 55, 59]);
    run(pluck({ freq: midiToHz(45), duration: 0.5 }), 3);
    expect(heard.filter(event => event.type === 'noteOn').at(-1).note).toBe(45);
    input.dispose();
  });

  it('disposes fallback callbacks and releases a chord without later events', () => {
    const { input, node, heard, run } = scriptSetup({ guitarMode: 'chords' });
    run(strum([52, 55, 59], { duration: 0.5 }));
    const before = heard.length;
    input.dispose();
    expect(heard.slice(before).filter(event => event.type === 'noteOff').map(event => event.note).sort((a, b) => a - b)).toEqual([52, 55, 59]);
    expect(node.onaudioprocess).toBe(null);
    const after = heard.length;
    input.configure({ guitarMode: 'chords' });
    input.dispose();
    expect(heard).toHaveLength(after);
  });

  it('keeps queued messages from a prior worklet mode from restarting or releasing notes', () => {
    const ctx = fakeContext();
    let node;
    vi.stubGlobal('AudioWorkletNode', class {
      constructor(context, name, options) {
        node = context.createGain();
        node.options = options;
        node.port = { postMessage: vi.fn(), onmessage: null };
        return node;
      }
    });
    const input = createGuitarInput(ctx, ctx.createGain(), { guitarMode: 'chords' });
    const off = vi.fn();
    input.on('noteOff', off);
    const send = data => node.port.onmessage({ data });
    for (const note of [52, 55, 59]) send({ t: 'noteOn', mode: 'chords', note });
    input.configure({ guitarMode: 'single' });
    expect(off).toHaveBeenCalledTimes(3);
    send({ t: 'noteOn', mode: 'chords', note: 55 });
    expect(input.notes).toEqual([]);
    send({ t: 'noteOn', mode: 'single', note: 52 });
    send({ t: 'noteOff', mode: 'chords', note: 52 });
    expect(input.notes).toEqual([52]);
    expect(off).toHaveBeenCalledTimes(3);
    input.dispose();
    expect(off).toHaveBeenCalledTimes(4);
  });
});
