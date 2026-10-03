// v1.1 engine routing for the pedal loop (src/audio/pedal-host.js), on the
// recording fake AudioContext: output map, send limiter, return mixed into
// the master and the effects but never into the send, feedback guard, guitar
// level, ping, and falling back to the plain stereo graph.
import { describe, it, expect, vi } from 'vitest';
import { fakeContext } from './fake-audio.js';
import { createPedalHost, DEFAULT_SEND_CEILING_DB } from '../../src/audio/pedal-host.js';
import { limiterGains } from '../../src/pedals/pedal-loop.js';

function setup({ maxChannelCount = 4, capture = true, openReturn, ...over } = {}) {
  const ctx = fakeContext({ maxChannelCount });
  const stereo = () => { const g = ctx.createGain(); g.channelCount = 2; g.channelCountMode = 'explicit'; return g; };
  const sendBus = stereo(), mainOut = stereo(), masterIn = stereo(), delayIn = stereo(), reverbIn = stereo();
  mainOut.connect(ctx.destination);   // what the engine does
  const posted = [];
  const fx = { guard: null, guitar: null, guitars: [], opened: [] };
  const deps = {
    hasGetUserMedia: () => capture,
    loadPedalWorklets: async () => ({ ok: true }),
    openReturn: openReturn || (async (c, deviceId, opts) => {
      const output = c.createGain();
      const guitar = opts.layout === 'mono+guitar' ? c.createGain() : null;
      const r = { ok: true, output, guitar, warnings: [], settings: { sampleRate: 48000 }, close: vi.fn() };
      fx.opened.push({ deviceId, opts, r });
      return r;
    }),
    attachFeedbackGuard: (c, o) => {
      fx.guard = { o, reset: vi.fn(), dispose: vi.fn(), status: () => ({ muted: false, outside: false }) };
      return fx.guard;
    },
    createGuitarInput: (c, node, opts) => {
      const ls = {};
      const g = {
        node, opts, via: 'worklet', configure: vi.fn(), dispose: vi.fn(),
        on: (t, fn) => { (ls[t] ||= new Set()).add(fn); return () => ls[t].delete(fn); },
        emit: (t, e) => { for (const fn of ls[t] || []) fn(e); },
      };
      fx.guitars.push(g);
      if (!fx.guitar) fx.guitar = g;
      return g;
    },
    measureRoundTrip: vi.fn(async (c, o) => {
      const undo = o.mute();
      fx.mutedDuring = { gate: host.nodes.musicGate.gain.value, ret: host.nodes.retLevel.gain.value };
      undo();
      return { ok: true, latencyMs: 41.5, latencySamples: 1992, confidence: 0.9, inverted: false };
    }),
    ...over,
  };
  const host = createPedalHost(ctx, { sendBus, mainOut, masterIn, delayIn, reverbIn, post: (m) => posted.push(m), deps });
  return { ctx, host, posted, fx, sendBus, mainOut, masterIn, delayIn, reverbIn, deps };
}

/** Every node reachable from `from` along the recorded connections. */
function reach(ctx, from) {
  const seen = new Set([from]);
  const todo = [from];
  while (todo.length) {
    const n = todo.pop();
    for (const e of ctx.edges) if (e.from === n && !seen.has(e.to)) { seen.add(e.to); todo.push(e.to); }
  }
  return seen;
}

describe('pedal host: output map', () => {
  it('leaves the pre-v1.1 graph alone until it is switched on', () => {
    const { ctx, host, posted, mainOut, sendBus } = setup();
    expect(ctx.out(mainOut, ctx.destination)).toHaveLength(1);
    expect(posted).toEqual([]);
    expect(host.status()).toMatchObject({ enabled: false, active: false, ceilingDb: DEFAULT_SEND_CEILING_DB });
    // The send bus goes through the limiter, which is not connected to anything yet.
    expect(reach(ctx, sendBus).has(host.nodes.limiter.input)).toBe(true);
    expect(reach(ctx, sendBus).has(ctx.destination)).toBe(false);
  });

  it('puts the main mix on outputs 1/2 and the limited send on 3/4 of a 4-channel device', () => {
    const { ctx, host, posted, mainOut, sendBus } = setup({ maxChannelCount: 4 });
    const st = host.configure({ enabled: true });
    expect(st.active).toBe(true);
    expect(st.routing).toMatchObject({ mode: 'multichannel', channelCount: 4, reason: null });
    expect(posted).toEqual([{ t: 'pedal', active: true }]);
    expect(ctx.destination).toMatchObject({ channelCount: 4, channelInterpretation: 'discrete' });
    expect(ctx.out(mainOut, ctx.destination)).toHaveLength(0);
    const merger = ctx.edges.find(e => e.to === ctx.destination).from;
    expect(merger.kind).toBe('merger');
    const into = (node) => ctx.edges.filter(e => e.to === merger && reach(ctx, node).has(e.from)).map(e => e.inp).sort();
    expect(into(mainOut)).toEqual([0, 1]);
    expect(into(sendBus)).toEqual([2, 3]);
    // The send reaches the merger only through the limiter's shaper.
    const path = reach(ctx, sendBus);
    expect(path.has(host.nodes.limiter.output)).toBe(true);
  });

  it('honours another channel map and the ceiling', () => {
    const { ctx, host, sendBus } = setup({ maxChannelCount: 8 });
    const st = host.configure({ enabled: true, sendChannels: [4, 5], ceilingDb: -24 });
    expect(st.sendChannels).toEqual([4, 5]);
    expect(ctx.destination.channelCount).toBe(6);
    const merger = ctx.edges.find(e => e.to === ctx.destination).from;
    expect(ctx.edges.filter(e => e.to === merger && reach(ctx, sendBus).has(e.from)).map(e => e.inp).sort()).toEqual([4, 5]);
    expect(host.nodes.limiter.ceilingDb).toBe(-24);
    expect(host.nodes.limiter.input.gain.value).toBeCloseTo(limiterGains(-24).pre, 9);
  });

  it('keeps playing in stereo with the send off when the device has two outputs', () => {
    const { ctx, host, posted, mainOut } = setup({ maxChannelCount: 2 });
    const st = host.configure({ enabled: true });
    expect(st.active).toBe(false);
    expect(st.routing.mode).toBe('stereo');
    expect(st.routing.reason).toMatch(/send is switched off/);
    expect(posted).toEqual([]);   // never told the DSP to start the send
    expect(reach(ctx, mainOut).has(ctx.destination)).toBe(true);
  });

  it('rebuilds when the device changes, and restores everything when switched off', () => {
    const { ctx, host, posted, mainOut } = setup({ maxChannelCount: 4 });
    host.configure({ enabled: true });
    ctx.destination.maxChannelCount = 2;
    expect(host.refresh().active).toBe(false);
    ctx.destination.maxChannelCount = 4;
    expect(host.refresh().active).toBe(true);
    host.configure({ enabled: false });
    expect(posted.map(m => m.active)).toEqual([true, false, true, false]);
    expect(ctx.out(mainOut, ctx.destination)).toHaveLength(1);
    expect(ctx.destination.channelCount).toBe(2);
    expect(ctx.edges.some(e => e.to === ctx.destination && e.from.kind === 'merger')).toBe(false);
  });
});

describe('pedal host: return', () => {
  it('mixes the return into the master and the effects, never into the send', async () => {
    const { ctx, host, fx, masterIn, delayIn, reverbIn, sendBus } = setup();
    host.configure({ enabled: true });
    const st = await host.setReturn({ enabled: true, deviceId: 'mpc', level: 0.8, delay: 0.25, reverb: 0.5 });
    expect(st.ret).toMatchObject({ open: true, enabled: true, deviceId: 'mpc', level: 0.8, delay: 0.25, reverb: 0.5 });
    const out = fx.opened[0].r.output;
    const reached = reach(ctx, out);
    for (const n of [masterIn, delayIn, reverbIn]) expect(reached.has(n)).toBe(true);
    expect(reached.has(sendBus)).toBe(false);
    expect(reached.has(host.nodes.limiter.input)).toBe(false);
    expect(host.nodes.retLevel.gain.value).toBe(0.8);
    expect(host.nodes.retDelay.gain.value).toBe(0.25);
    expect(host.nodes.retReverb.gain.value).toBe(0.5);
    // The guard watches the return before its mute and ramps the mute.
    expect(fx.guard.o.input).toBe(out);
    expect(fx.guard.o.gain).toBe(host.nodes.retMute);
  });

  it('reopens only when the input changes, and closes cleanly', async () => {
    const { host, fx } = setup();
    await host.setReturn({ enabled: true, deviceId: 'a' });
    await host.setReturn({ level: 0.5 });
    expect(fx.opened).toHaveLength(1);
    await host.setReturn({ deviceId: 'b' });
    expect(fx.opened).toHaveLength(2);
    expect(fx.opened[0].r.close).toHaveBeenCalled();
    await host.setReturn({ enabled: false });
    expect(fx.opened[1].r.close).toHaveBeenCalled();
    expect(host.status().ret.open).toBe(false);
  });

  it('reports a refused input or a browser without capture instead of throwing', async () => {
    const a = setup({ openReturn: async () => ({ ok: false, reason: 'Oro needs permission to hear the pedal return.' }) });
    const st = await a.host.setReturn({ enabled: true });
    expect(st.ret).toMatchObject({ open: false, reason: expect.stringMatching(/permission/) });
    const b = setup({ capture: false });
    const st2 = await b.host.setReturn({ enabled: true });
    expect(st2.ret.reason).toMatch(/cannot capture audio/);
    expect(b.fx.opened).toHaveLength(0);
    expect(st2.supported.capture).toBe(false);
  });

  it('shows the feedback guard muting the return and unmutes on request', async () => {
    const { host, fx } = setup();
    await host.setReturn({ enabled: true });
    const seen = [];
    host.on('change', s => seen.push(s.ret.muted));
    fx.guard.o.onTrip({ kind: 'howl', reason: 'The pedal return started feeding back, so Oro muted it.' });
    expect(host.status().ret).toMatchObject({ muted: true, muteReason: expect.stringMatching(/feeding back/) });
    host.resetGuard();
    expect(fx.guard.reset).toHaveBeenCalled();
    expect(host.status().ret.muted).toBe(false);
    expect(seen).toContain(true);
  });

  it('turns the guitar on input 2 into the Guitar Level source', async () => {
    const { host, fx, posted } = setup();
    await host.setReturn({ enabled: true, layout: 'mono+guitar' });
    expect(fx.guitar.node).toBe(fx.opened[0].r.guitar);
    const levels = [];
    host.on('guitar', e => levels.push(e.level));
    fx.guitar.emit('level', { value: 0.42, db: -12 });
    fx.guitar.emit('level', { value: 0.4205, db: -12 });   // below the change threshold
    fx.guitar.emit('level', { value: 3, db: 0 });
    expect(posted.filter(m => m.t === 'guitar').map(m => m.v)).toEqual([0.42, 1]);
    expect(levels).toEqual([0.42, 0.4205, 1]);
    await host.setReturn({ enabled: false });
    expect(fx.guitar.dispose).toHaveBeenCalled();
    expect(posted[posted.length - 1]).toEqual({ t: 'guitar', v: 0 });
  });
});

describe('pedal host: ping', () => {
  it('needs the send on its own outputs and an open return', async () => {
    const { host, deps } = setup({ maxChannelCount: 2 });
    expect((await host.ping()).reason).toMatch(/Turn on the pedal send/);
    host.configure({ enabled: true });
    expect((await host.ping()).reason).toMatch(/switched off/);
    expect(deps.measureRoundTrip).not.toHaveBeenCalled();
  });

  it('pings through the limiter with the music and the return monitor muted', async () => {
    const { host, fx, deps } = setup();
    host.configure({ enabled: true });
    await host.setReturn({ enabled: true, level: 0.9 });
    const r = await host.ping();
    expect(r).toMatchObject({ ok: true, latencyMs: 41.5 });
    const o = deps.measureRoundTrip.mock.calls[0][1];
    expect(o.sendNode).toBe(host.nodes.limiter.input);
    expect(o.returnNode).toBe(fx.opened[0].r.output);
    expect(fx.mutedDuring).toEqual({ gate: 0, ret: 0 });
    expect(host.nodes.musicGate.gain.value).toBe(1);
    expect(host.nodes.retLevel.gain.value).toBe(0.9);
    expect(host.status().ping).toMatchObject({ ok: true, latencyMs: 41.5 });
  });
});

describe('pedal host: dispose', () => {
  it('puts the main output back on the destination', () => {
    const { ctx, host, posted, mainOut } = setup();
    host.configure({ enabled: true });
    host.dispose();
    expect(ctx.out(mainOut, ctx.destination)).toHaveLength(1);
    expect(posted[posted.length - 1]).toEqual({ t: 'pedal', active: false });
    expect(ctx.destination.channelCount).toBe(2);
  });
});

describe('pedal host: guitar notes', () => {
  const withSource = async (c, deviceId, opts) => {
    const output = c.createGain();
    const guitar = opts.layout === 'mono+guitar' ? c.createGain() : null;
    return { ok: true, output, guitar, source: c.createMediaStreamSource({}), warnings: [], settings: null, close: vi.fn() };
  };

  it('tracks the clean DI (channel 2) with the Guitar Level input in "Mono return + guitar"', async () => {
    const { host, fx } = setup({ openReturn: withSource });
    const seen = [];
    host.on('guitarNote', e => seen.push(e));
    await host.setGuitar({ notes: true, gateDb: -44, bendRange: 5 });
    expect(host.status().guitar).toMatchObject({ notes: true, tracking: false, channel: 1 });   // waits for the return
    await host.setReturn({ enabled: true, layout: 'mono+guitar' });
    expect(fx.guitars).toHaveLength(1);                     // shared, no second tracker
    expect(host.status().guitar).toMatchObject({ tracking: true, gateDb: -44, bendRange: 5 });
    expect(fx.guitar.configure).toHaveBeenLastCalledWith({ guitarMode: 'single', tracker: { gateDb: -44, bendRange: 5 } });
    fx.guitar.emit('noteOn', { note: 45, velocity: 0.7, time: 1 });
    fx.guitar.emit('bend', { semitones: 0.5, time: 1.1 });
    fx.guitar.emit('noteOff', { note: 45, time: 1.2 });
    expect(seen.map(e => e.type)).toEqual(['noteOn', 'bend', 'noteOff']);
    expect(seen[0]).toMatchObject({ note: 45, velocity: 0.7 });
    // Closing the return releases whatever the guitar was holding.
    await host.setReturn({ enabled: false });
    expect(seen[seen.length - 1]).toEqual({ type: 'stop' });
    expect(host.status().guitar.tracking).toBe(false);
  });

  it('taps one channel of a stereo return through a splitter, and rebuilds on a channel change', async () => {
    const { ctx, host, fx } = setup({ openReturn: withSource });
    await host.setReturn({ enabled: true });
    await host.setGuitar({ notes: true, channel: 0 });
    expect(fx.guitars).toHaveLength(1);
    const g1 = fx.guitars[0];
    const split = ctx.edges.find(e => e.to === g1.node).from;   // tap gain <- splitter output 0
    expect(ctx.edges.find(e => e.from === split && e.to === g1.node).out).toBe(0);
    expect(g1.node.channelCount).toBe(1);
    await host.setGuitar({ channel: 1 });
    expect(g1.dispose).toHaveBeenCalled();
    const g2 = fx.guitars[1];
    const split2 = ctx.edges.find(e => e.to === g2.node).from;
    expect(ctx.edges.find(e => e.from === split2 && e.to === g2.node).out).toBe(1);
    await host.setGuitar({ notes: false });
    expect(g2.dispose).toHaveBeenCalled();
    expect(host.status().guitar.tracking).toBe(false);
  });

  it('is off by default and never tracks without an open return', async () => {
    const { host, fx } = setup({ openReturn: withSource });
    await host.setReturn({ enabled: true });
    expect(host.status().guitar).toMatchObject({ notes: false, tracking: false });
    expect(fx.guitars).toHaveLength(0);
    await host.setReturn({ enabled: false });
    await host.setGuitar({ notes: true });
    expect(fx.guitars).toHaveLength(0);
  });

  it('passes Chords mode to both dedicated and shared trackers and stops old notes before switching', async () => {
    const { host, fx } = setup({ openReturn: withSource });
    const seen = [];
    host.on('guitarNote', event => seen.push(event));
    await host.setGuitar({ notes: true, guitarMode: 'chords' });
    await host.setReturn({ enabled: true });
    expect(fx.guitars[0].opts.guitarMode).toBe('chords');
    expect(host.status().guitar.guitarMode).toBe('chords');
    fx.guitars[0].emit('pitch', { mode: 'chords', notes: [52, 55, 59], heard: [52, 55, 59], voiced: true });
    expect(seen.at(-1)).toMatchObject({ type: 'pitch', notes: [52, 55, 59] });
    await host.setGuitar({ guitarMode: 'single' });
    expect(seen.at(-1)).toEqual({ type: 'stop' });
    expect(fx.guitars[0].configure).toHaveBeenLastCalledWith({ guitarMode: 'single', tracker: { gateDb: -50, bendRange: 2 } });
    await host.setReturn({ layout: 'mono+guitar' });
    await host.setGuitar({ guitarMode: 'chords' });
    const shared = fx.guitars.at(-1);
    expect(shared.configure).toHaveBeenLastCalledWith({ guitarMode: 'chords', tracker: { gateDb: -50, bendRange: 2 } });
    await host.setGuitar({ notes: false });
    expect(shared.configure).toHaveBeenLastCalledWith({ guitarMode: 'single' });
    expect(shared.dispose).not.toHaveBeenCalled();
  });
});

describe('pedal host: capture', () => {
  function fakeCapture(samples) {
    return vi.fn((c, o) => {
      const cap = { o, input: c.createGain(), dropouts: 0, stop: vi.fn(async () => [samples]), dispose: vi.fn() };
      cap.start = vi.fn(async () => { cap.heard = c.edges.filter(e => e.to === cap.input).map(e => e.from); });
      fakeCapture.last = cap;
      return cap;
    });
  }

  it('needs an open return', async () => {
    const { host } = setup({ createCapture: fakeCapture(new Float32Array(10)), sleep: async () => {} });
    expect((await host.captureGuitar()).reason).toMatch(/pedal return/);
  });

  it('records the guitar channel with progress and hands back the samples', async () => {
    const x = new Float32Array(4800).fill(0.25);
    const createCapture = fakeCapture(x);
    const { ctx, host, fx } = setup({ createCapture, sleep: async () => {} });
    await host.setReturn({ enabled: true, layout: 'mono+guitar' });
    const progress = [];
    const r = await host.captureGuitar({ seconds: 1, onProgress: p => progress.push(p) });
    expect(r).toMatchObject({ ok: true, sampleRate: 48000 });
    expect(r.samples).toBe(x);
    expect(createCapture.mock.calls[0][1]).toMatchObject({ channels: 1 });
    expect(progress).toHaveLength(10);
    expect(progress[9]).toBe(1);
    // It listened to the guitar channel and let go afterwards.
    const cap = fakeCapture.last;
    expect(cap.heard).toEqual([fx.opened[0].r.guitar]);
    expect(ctx.out(fx.opened[0].r.guitar, cap.input)).toHaveLength(0);
    expect(cap.dispose).toHaveBeenCalled();
    expect(host.status().guitar.capturing).toBe(false);
  });

  it('reports an empty or busy recording', async () => {
    const { host } = setup({ createCapture: fakeCapture(new Float32Array(0)), sleep: async () => {} });
    await host.setReturn({ enabled: true, layout: 'mono+guitar' });
    expect((await host.captureGuitar({ seconds: 0.5 })).reason).toMatch(/Nothing was recorded/);
  });
});
