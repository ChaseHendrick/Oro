// v1.4 voice input: constraints (Mic Cleanup on and off), Monitor: Auto for a
// laptop's built-in microphone and speakers, the meter, the voice host's graph
// on the recording fake AudioContext (never into itself, guard armed, Monitor
// gating, the looper feed), voice -> notes through the real pitch tracker with
// source 'voice', Capture from a sung note, the Voice Level Links source and
// the voice rig.
import { describe, it, expect, vi } from 'vitest';
import { fakeContext } from '../pedals/fake-audio.js';
import {
  voiceConstraints, settingsWarnings, classifyInput, classifyOutput, monitorDefault, resolveMonitor, meterReading, createClipLight,
  sanitizeVoicePrefs, defaultVoicePrefs, loadVoicePrefs, saveVoicePrefs, voiceErrorReason, VOICE_KEY, VOICE_SOURCE, VOICE_TRACKER, VOICE_GUARD,
  HEADPHONES_HINT, MIC_WHY,
} from '../../src/audio/voice-core.js';
import { createVoiceHost } from '../../src/audio/voice-host.js';
import { createVoiceRig, analyseVoice } from '../../src/ui/voice-rig.js';
import { createGuitarNotes } from '../../src/pedals/guitar-notes.js';
import { createPitchTracker } from '../../src/pedals/pitch.js';
import { createFeedbackDetector } from '../../src/pedals/pedal-loop.js';
import { makeRandom } from '../../src/pedals/signal.js';
import { LINK_SOURCES, MOD_PARAM_IDS, STATE_VERSION, defaultState } from '../../src/core/params.js';
import { sanitizeLinks, migrateState } from '../../src/core/migrate.js';
import { createStore } from '../../src/core/store.js';
import { makeDSP } from '../dsp/helpers.js';

const SR = 48000;

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

/** A sung vowel: harmonics with two formant bumps, gentle vibrato, breath noise, fade in and out. */
function sungNote(freq, { seconds = 2, lead = 0.25, vibratoCents = 15, amp = 0.4, seed = 3 } = {}) {
  const n = Math.round((lead + seconds + 0.25) * SR);
  const x = new Float32Array(n);
  const rnd = makeRandom(seed);
  const s0 = Math.round(lead * SR), s1 = s0 + Math.round(seconds * SR);
  let ph = 0;
  const formant = (f) => Math.exp(-(((f - 700) / 300) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 400) ** 2)) + 0.15;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (i >= s0 && i < s1) {
      const t = (i - s0) / SR;
      const f = freq * Math.pow(2, vibratoCents / 1200 * Math.sin(2 * Math.PI * 5.5 * t));
      ph += 2 * Math.PI * f / SR;
      for (let k = 1; k <= 12 && k * freq < SR / 2; k++) v += formant(k * freq) / k * Math.sin(k * ph);
      const env = Math.min(1, t / 0.05) * Math.min(1, (s1 - i) / (0.05 * SR));
      v *= amp * env;
    }
    x[i] = v + 2e-4 * (rnd() * 2 - 1);
  }
  return x;
}

/** Fake context plus the nodes the voice chain uses. */
function voiceContext() {
  const ctx = fakeContext({ maxChannelCount: 2 });
  const param = (v) => ({ value: v, setTargetAtTime(x) { this.value = x; }, setValueAtTime(x) { this.value = x; }, linearRampToValueAtTime(x) { this.value = x; }, cancelScheduledValues() {} });
  const mk = (kind, extra) => { const g = ctx.createGain(); g.kind = kind; delete g.gain; return Object.assign(g, extra); };
  ctx.createBiquadFilter = () => mk('biquad', { type: 'lowpass', frequency: param(350), Q: param(1) });
  ctx.createDynamicsCompressor = () => mk('compressor', { threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) });
  ctx.createStereoPanner = () => mk('panner', { pan: param(0) });
  ctx.createDelay = () => mk('delay', { delayTime: param(0) });
  return ctx;
}

function fakeStream({ label = 'MacBook Pro Microphone', settings = { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } } = {}) {
  const track = { label, getSettings: () => settings, stop: vi.fn(), onended: null };
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}

function setupHost({ openMic, capture = true, ...over } = {}) {
  const ctx = voiceContext();
  const stereo = () => { const g = ctx.createGain(); g.channelCount = 2; g.channelCountMode = 'explicit'; return g; };
  const masterIn = stereo(), delayIn = stereo(), reverbIn = stereo(), loopIn = stereo(), sendBus = stereo();
  const posted = [];
  const fx = { guard: null, trackers: [], asked: [], streams: [] };
  const deps = {
    hasGetUserMedia: () => capture,
    loadPedalWorklets: async () => ({ ok: true }),
    platform: () => ({ electron: false, mac: false }),
    openMic: openMic || (async (c) => { fx.asked.push(c); const s = fakeStream(); fx.streams.push(s); return s; }),
    attachFeedbackGuard: (c, o) => {
      fx.guard = { o, reset: vi.fn(), dispose: vi.fn(), status: () => ({ muted: false }) };
      return fx.guard;
    },
    createGuitarInput: (c, node, opts) => {
      const ls = {};
      const g = {
        node, opts, via: 'worklet', configure: vi.fn(), dispose: vi.fn(),
        on: (t, fn) => { (ls[t] ||= new Set()).add(fn); return () => ls[t].delete(fn); },
        emit: (t, e) => { for (const fn of ls[t] || []) fn(e); },
      };
      fx.trackers.push(g);
      return g;
    },
    ...over,
  };
  const host = createVoiceHost(ctx, { masterIn, delayIn, reverbIn, loopIn, post: (m) => posted.push(m), deps });
  return { ctx, host, posted, fx, masterIn, delayIn, reverbIn, loopIn, sendBus, deps };
}

function reach(ctx, from) {
  const seen = new Set([from]);
  const todo = [from];
  while (todo.length) {
    const n = todo.pop();
    for (const e of ctx.edges) if (e.from === n && !seen.has(e.to)) { seen.add(e.to); todo.push(e.to); }
  }
  return seen;
}

// ================================================================ pure

describe('voice constraints', () => {
  it('switches every voice-call process off by default and asks for the context rate, 24-bit, mono', () => {
    const c = voiceConstraints({ sampleRate: 48000 });
    expect(c.video).toBe(false);
    expect(c.audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(c.audio.sampleRate).toEqual({ ideal: 48000 });
    expect(c.audio.sampleSize).toEqual({ ideal: 24 });
    expect(c.audio.channelCount).toEqual({ ideal: 1 });
    expect(c.audio.latency).toEqual({ ideal: 0 });
    expect(c.audio.deviceId).toBeUndefined();
  });

  it('Mic Cleanup turns on noise suppression and echo cancellation, never auto gain', () => {
    const c = voiceConstraints({ cleanup: true });
    expect(c.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  });

  it('asks for 48 kHz when the context rate is unknown, matches 44.1 kHz contexts, and pins a chosen device', () => {
    expect(voiceConstraints({}).audio.sampleRate).toEqual({ ideal: 48000 });
    expect(voiceConstraints({ sampleRate: 44100 }).audio.sampleRate).toEqual({ ideal: 44100 });
    expect(voiceConstraints({ deviceId: 'abc', channels: 'stereo' }).audio).toMatchObject({ deviceId: { exact: 'abc' }, channelCount: { ideal: 2 } });
    expect(voiceConstraints({ deviceId: 'default' }).audio.deviceId).toBeUndefined();
  });

  it('warns when the browser kept processing on or resamples', () => {
    expect(settingsWarnings({ sampleRate: 48000, echoCancellation: false }, { sampleRate: 48000 })).toEqual([]);
    const w = settingsWarnings({ sampleRate: 44100, noiseSuppression: true, autoGainControl: true }, { sampleRate: 48000 });
    expect(w.join(' ')).toMatch(/noise suppression/);
    expect(w.join(' ')).toMatch(/auto gain/);
    expect(w.join(' ')).toMatch(/resamples/);
    // With Mic Cleanup the processing is wanted, not a warning.
    expect(settingsWarnings({ noiseSuppression: true, echoCancellation: true }, { cleanup: true })).toEqual([]);
  });
});

describe('Monitor: Auto', () => {
  it('recognises built-in microphones, speakers, headphones and interfaces', () => {
    expect(classifyInput('Default - MacBook Pro Microphone (Built-in)')).toBe('builtin');
    expect(classifyInput('Microphone Array (Realtek(R) Audio)')).toBe('builtin');
    expect(classifyInput('Scarlett 2i2 USB')).toBe('external');
    expect(classifyInput('AirPods Pro')).toBe('headset');
    expect(classifyInput('')).toBe('unknown');
    expect(classifyOutput('MacBook Air Speakers')).toBe('speakers');
    expect(classifyOutput('Speakers (Realtek(R) Audio)')).toBe('speakers');
    expect(classifyOutput('External Headphones')).toBe('headphones');
    expect(classifyOutput('Headphones (Realtek(R) Audio)')).toBe('headphones');
    expect(classifyOutput('Speakers (Focusrite USB Audio)')).toBe('interface');
    expect(classifyOutput('')).toBe('unknown');
  });

  it('is off for a laptop microphone with the laptop speakers, with the headphones hint', () => {
    const m = monitorDefault({ inputLabel: 'MacBook Pro Microphone', outputLabel: 'MacBook Pro Speakers' });
    expect(m).toMatchObject({ on: false, reason: 'speakers', input: 'builtin', output: 'speakers' });
    expect(m.hint).toMatch(/built-in microphone would hear the built-in speakers/);
    expect(m.hint).toContain(HEADPHONES_HINT);
    expect(HEADPHONES_HINT).toMatch(/Use headphones to avoid feedback/);
  });

  it('is on with headphones or an interface, off when the devices are unknown', () => {
    expect(monitorDefault({ inputLabel: 'MacBook Pro Microphone', outputLabel: 'External Headphones' }).on).toBe(true);
    expect(monitorDefault({ inputLabel: 'Scarlett 2i2 USB', outputLabel: 'Scarlett 2i2 USB' })).toMatchObject({ on: true, reason: 'interface' });
    expect(monitorDefault({})).toMatchObject({ on: false, reason: 'unknown' });
  });

  it('lets On and Off override Auto (On with speakers still carries the hint)', () => {
    const dev = { inputLabel: 'MacBook Pro Microphone', outputLabel: 'MacBook Pro Speakers' };
    expect(resolveMonitor('auto', dev)).toMatchObject({ on: false, auto: true });
    expect(resolveMonitor('on', dev)).toMatchObject({ on: true, auto: false, hint: HEADPHONES_HINT });
    expect(resolveMonitor('off', { outputLabel: 'AirPods' })).toMatchObject({ on: false, auto: false });
  });
});

describe('voice meter and settings', () => {
  it('reads the peak after the input gain and tells a clipping microphone from too much gain', () => {
    expect(meterReading(0.1, 0)).toMatchObject({ clip: null });
    expect(meterReading(0.1, 0).peakDb).toBeCloseTo(-20, 5);
    expect(meterReading(0.1, 0).pos).toBeCloseTo(40 / 60, 5);
    expect(meterReading(0.2, 20).clip).toBe('gain');
    expect(meterReading(1, -6).clip).toBe('input');
  });

  it('holds the clip light for a moment', () => {
    const light = createClipLight({ holdMs: 1000 });
    expect(light.update(meterReading(1, 0), 0)).toEqual({ on: true, kind: 'input' });
    expect(light.update(meterReading(0.1, 0), 500)).toEqual({ on: true, kind: 'input' });
    expect(light.update(meterReading(0.1, 0), 1200)).toEqual({ on: false, kind: null });
  });

  it('sanitises and stores the settings per computer, all processing off by default', () => {
    const d = defaultVoicePrefs();
    expect(d).toMatchObject({ enabled: 0, cleanup: 0, channels: 'mono', monitor: 'auto', highpass: 0, compressor: 0, deesser: 0, notes: 0 });
    const s = sanitizeVoicePrefs({ inputGainDb: 99, monitor: 'loud', channels: 'quad', target: 16, pan: -3, level: 5, cleanup: true });
    expect(s).toMatchObject({ inputGainDb: 36, monitor: 'auto', channels: 'mono', target: 'sel', pan: -1, level: 2, cleanup: 1 });
    const st = memStorage();
    saveVoicePrefs({ ...d, enabled: 1, target: 2 }, st);
    expect(JSON.parse(st.m.get(VOICE_KEY))).toMatchObject({ enabled: 1, target: 2 });
    expect(loadVoicePrefs(st)).toMatchObject({ enabled: 1, target: 2 });
    expect(loadVoicePrefs(memStorage({ [VOICE_KEY]: '{oops' }))).toEqual(d);
  });

  it('explains refused permissions and missing microphones in plain words', () => {
    expect(voiceErrorReason({ name: 'NotAllowedError' })).toMatch(/blocked for this page/);
    expect(voiceErrorReason({ name: 'NotAllowedError' }, { electron: true, mac: true })).toMatch(/Privacy & Security > Microphone/);
    expect(voiceErrorReason({ name: 'NotFoundError' })).toMatch(/No microphone was found/);
    expect(voiceErrorReason({ name: 'NotReadableError' })).toMatch(/Another app/);
    expect(MIC_WHY).toMatch(/only while Voice is enabled/);
    for (const s of [MIC_WHY, HEADPHONES_HINT, voiceErrorReason({ name: 'NotAllowedError' })]) expect(s).not.toMatch(/—/);
  });
});

describe('voice feedback guard tuning', () => {
  /** Run the detector over x the way attachFeedbackGuard polls it (2048-sample window every 25 ms). */
  function watch(x, opts) {
    const det = createFeedbackDetector({ sampleRate: SR, ...opts });
    const hop = Math.round(0.025 * SR);
    for (let i = 2048; i <= x.length; i += hop) {
      if (det.observe(x.subarray(i - 2048, i), i / SR * 1000).tripped) return det.state;
    }
    return det.state;
  }

  it('lets a loud held sung note through', () => {
    // Loud but below full scale (peaks at about -1 dBFS); a converter pinned at
    // full scale is the clipping case, which the guard mutes on purpose.
    const x = sungNote(220, { seconds: 4, amp: 0.9, vibratoCents: 20 });
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    for (let i = 0; i < x.length; i++) x[i] *= 0.89 / peak;
    expect(watch(x, VOICE_GUARD).tripped).toBe(false);
  });

  it('does not take a note starting out of silence for a runaway', () => {
    // A sung attack climbs 70 dB in 50 ms; feedback climbs out of sound that is already there.
    const x = sungNote(220, { seconds: 1, amp: 0.9, vibratoCents: 20 });
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    for (let i = 0; i < x.length; i++) x[i] *= 0.89 / peak;
    const st = watch(x, VOICE_GUARD);
    expect(st.tripped).toBe(false);
    expect(watch(x, { ...VOICE_GUARD, riseFloorDb: -Infinity }).kind).toBe('runaway');
  });

  it('still mutes a howl building up through the speakers', () => {
    const n = 3 * SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.min(0.9, 0.02 * Math.exp(i / SR * 2.2)) * Math.sin(2 * Math.PI * 1870 * i / SR);
    const st = watch(x, VOICE_GUARD);
    expect(st.tripped).toBe(true);
    expect(['howl', 'runaway']).toContain(st.kind);
  });
});

// ================================================================ host

describe('voice host: graph', () => {
  it('is silent and opens nothing until enabled', () => {
    const { host, fx, masterIn } = setupHost();
    expect(fx.asked).toHaveLength(0);
    expect(host.status()).toMatchObject({ enabled: false, open: false, guardArmed: false });
    expect(host.nodes.heard.gain.value).toBe(0);
    expect(host.nodes.loopOnly.gain.value).toBe(0);
    expect(masterIn).toBeTruthy();
  });

  it('opens the microphone with the constraints, Mic Cleanup reopening it with processing on', async () => {
    const { host, fx } = setupHost();
    await host.set({ enabled: true });
    expect(fx.asked[0].audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: { ideal: SR } });
    expect(host.status()).toMatchObject({ open: true, reason: null, label: 'MacBook Pro Microphone' });
    await host.set({ cleanup: true });
    expect(fx.asked).toHaveLength(2);
    expect(fx.streams[0].track.stop).toHaveBeenCalled();
    expect(fx.asked[1].audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: false });
    await host.set({ inputGainDb: 6, level: 0.5 });
    expect(fx.asked).toHaveLength(2);      // gains only
  });

  it('reaches the master, the effect sends and the looper, never itself or the pedal send', async () => {
    const { ctx, host, masterIn, delayIn, reverbIn, loopIn, sendBus } = setupHost();
    await host.set({ enabled: true, delay: 0.3, reverb: 0.2 });
    const source = ctx.edges.find(e => e.from.kind === 'mediaSource').from;
    const fromMic = reach(ctx, source);
    for (const n of [masterIn, delayIn, reverbIn, loopIn]) expect(fromMic.has(n)).toBe(true);
    expect(fromMic.has(sendBus)).toBe(false);
    // Nothing downstream of the input gain leads back to the microphone or the input gain.
    expect(ctx.edges.some(e => e.to === source)).toBe(false);
    for (const n of [host.nodes.level, host.nodes.panner, host.nodes.guardMute, host.nodes.heard, host.nodes.loopOnly]) {
      expect(reach(ctx, n).has(host.nodes.inGain)).toBe(false);
      expect(reach(ctx, n).has(source)).toBe(false);
    }
    // The master and the sends never feed the voice.
    for (const n of [masterIn, delayIn, reverbIn, loopIn]) expect(reach(ctx, n).has(host.nodes.inGain)).toBe(false);
    expect(host.nodes.delaySend.gain.value).toBe(0.3);
    expect(host.nodes.reverbSend.gain.value).toBe(0.2);
  });

  it('arms the feedback guard on the voice whenever the microphone is open, Monitor on or off', async () => {
    const { host, fx } = setupHost();
    await host.set({ enabled: true, monitor: false });
    expect(fx.guard).toBeTruthy();
    expect(fx.guard.o.input).toBe(host.nodes.panner);
    expect(fx.guard.o.gain).toBe(host.nodes.guardMute);
    expect(fx.guard.o).toMatchObject(VOICE_GUARD);
    expect(host.status().guardArmed).toBe(true);
    fx.guard.o.onTrip({ kind: 'howl' });
    expect(host.status()).toMatchObject({ muted: true });
    expect(host.status().muteReason).toMatch(/headphones/);
    host.resetGuard();
    expect(fx.guard.reset).toHaveBeenCalled();
    expect(host.status().muted).toBe(false);
    await host.set({ enabled: false });
    expect(fx.guard.dispose).toHaveBeenCalled();
    expect(host.status().guardArmed).toBe(false);
  });

  it('Monitor decides whether the voice is heard; unheard it still feeds the looper', async () => {
    const { host } = setupHost();
    await host.set({ enabled: true, monitor: false });
    expect(host.nodes.heard.gain.value).toBe(0);
    expect(host.nodes.loopOnly.gain.value).toBe(1);
    await host.set({ monitor: true });
    expect(host.nodes.heard.gain.value).toBe(1);
    expect(host.nodes.loopOnly.gain.value).toBe(0);
    await host.set({ enabled: false });
    expect(host.nodes.heard.gain.value).toBe(0);
    expect(host.nodes.loopOnly.gain.value).toBe(0);
  });

  it('switches the optional processing in and out, all off by default', async () => {
    const { host } = setupHost();
    await host.set({ enabled: true });
    for (const k of ['hp', 'comp', 'deess']) {
      expect(host.nodes[k].on).toBe(false);
      expect(host.nodes[k].dry.gain.value).toBe(1);
      expect(host.nodes[k].wet.gain.value).toBe(0);
    }
    await host.set({ highpass: true, compressor: true, deesser: true });
    for (const k of ['hp', 'comp', 'deess']) {
      expect(host.nodes[k].on).toBe(true);
      expect(host.nodes[k].wet.gain.value).toBe(1);
    }
    const hp = host.nodes.hp.nodes[0];
    expect(hp.type).toBe('highpass');
    expect(hp.frequency.value).toBe(80);
  });

  it('turns the tracker envelope into the Voice Level message and forwards notes', async () => {
    const { host, fx, posted } = setupHost();
    const notes = [];
    host.on('voiceNote', (e) => notes.push(e));
    await host.set({ enabled: true });
    const tr = fx.trackers[0];
    expect(tr.node).toBe(host.nodes.tap);
    expect(tr.opts.tracker).toMatchObject({ minFreq: VOICE_TRACKER.minFreq, maxFreq: VOICE_TRACKER.maxFreq });
    tr.emit('level', { value: 0.6, db: -12 });
    expect(posted.at(-1)).toEqual({ t: 'voiceLevel', v: 0.6 });
    tr.emit('noteOn', { note: 57, velocity: 0.7 });
    expect(notes.some(e => e.type === 'noteOn' && e.note === 57)).toBe(true);
    await host.set({ enabled: false });
    expect(posted.at(-1)).toEqual({ t: 'voiceLevel', v: 0 });
    expect(notes.at(-1)).toEqual({ type: 'stop' });
  });

  it('reports a refused permission, a missing microphone and a browser without capture', async () => {
    const denied = setupHost({ openMic: async () => { const e = new Error('no'); e.name = 'NotAllowedError'; throw e; } });
    await denied.host.set({ enabled: true });
    expect(denied.host.status()).toMatchObject({ open: false, error: 'NotAllowedError' });
    expect(denied.host.status().reason).toMatch(/blocked/);
    expect(denied.host.nodes.heard.gain.value).toBe(0);
    const none = setupHost({ openMic: async () => { const e = new Error('none'); e.name = 'NotFoundError'; throw e; } });
    await none.host.set({ enabled: true });
    expect(none.host.status().reason).toMatch(/No microphone was found/);
    const old = setupHost({ capture: false });
    await old.host.set({ enabled: true });
    expect(old.host.status().reason).toMatch(/secure page/);
  });

  it('closes cleanly when the microphone is unplugged', async () => {
    const { host, fx } = setupHost();
    await host.set({ enabled: true, monitor: true });
    fx.streams[0].track.onended();
    expect(host.status()).toMatchObject({ open: false });
    expect(host.status().reason).toMatch(/disconnected/);
    expect(host.nodes.heard.gain.value).toBe(0);
  });

  it('meters the raw input with the input gain and a clip light', async () => {
    const { host, ctx } = setupHost();
    expect(host.meter()).toMatchObject({ open: false, clip: false });
    await host.set({ enabled: true, inputGainDb: 12 });
    const an = ctx.edges.find(e => e.to.kind === 'analyser' && e.from.kind === 'splitter').to;
    an.getFloatTimeDomainData = (buf) => { buf.fill(0); buf[3] = 0.5; };
    const m = host.meter();
    expect(m.open).toBe(true);
    expect(m.peakDb).toBeCloseTo(-6.02 + 12, 1);
    expect(m.clip).toBe(true);
    expect(m.clipKind).toBe('gain');
  });

  it('captures the voice from the mono tap', async () => {
    const cap = { input: { kind: 'capture' }, start: vi.fn(async () => {}), stop: vi.fn(async () => [new Float32Array(100)]), dispose: vi.fn(), dropouts: 0 };
    const { host, ctx } = setupHost({ createCapture: () => cap, sleep: async () => {} });
    expect((await host.capture()).reason).toMatch(/Turn on Voice/);
    await host.set({ enabled: true });
    const res = await host.capture({ seconds: 1 });
    expect(res.ok).toBe(true);
    expect(res.sampleRate).toBe(SR);
    expect(ctx.out(host.nodes.tap, cap.input)).toHaveLength(0);   // disconnected after
    expect(cap.dispose).toHaveBeenCalled();
  });
});

// ================================================================ notes and capture

describe('voice plays notes', () => {
  it('a sung A3 through the pitch tracker plays A3 on the part with source voice', () => {
    const x = sungNote(220, { seconds: 1 });
    const tr = createPitchTracker({ sampleRate: SR, ...VOICE_TRACKER, gateDb: -45, bendRange: 2 });
    const router = { noteOn: vi.fn(), noteOff: vi.fn(), resolve: (t) => (t === 'sel' ? [0] : [t]) };
    const engine = { bend: vi.fn() };
    const store = createStore(defaultState());
    const notes = createGuitarNotes({ store, router, engine, source: VOICE_SOURCE });
    notes.configure({ enabled: true, target: 1, gateDb: -45, bends: true });
    for (let i = 0; i < x.length; i += 128) for (const e of tr.process(x.subarray(i, i + 128))) notes.handle(e);
    expect(router.noteOn).toHaveBeenCalled();
    const [target, note, vel, source] = router.noteOn.mock.calls[0];
    expect(target).toBe(1);
    expect(note).toBe(57);
    expect(vel).toBeGreaterThan(0);
    expect(source).toBe('voice');
    // Vibrato stays one note (bends), and the note ends when the singing stops.
    expect(new Set(router.noteOn.mock.calls.map(c => c[1]))).toEqual(new Set([57]));
    expect(router.noteOff).toHaveBeenCalledWith(1, 57, 'voice');
    expect(notes.source).toBe('voice');
  });
});

describe('Capture from voice', () => {
  it('turns a sung note into a wavetable terrain at its pitch', () => {
    const res = analyseVoice(sungNote(196, { seconds: 2 }), SR);
    expect(res.ok).toBe(true);
    expect(Math.round(res.note)).toBe(55);   // G3
    expect(res.userTerrain).toMatchObject({ kind: 'wavetable', w: 256, mirror: 1 });
    expect(res.userTerrain.h).toBeGreaterThan(8);
  });

  it('says so when there is nothing steady to capture', () => {
    const res = analyseVoice(new Float32Array(SR), SR);
    expect(res.ok).toBe(false);
  });
});

// ================================================================ links

describe('Voice Level link source', () => {
  it('is appended after Guitar Level, so saved links keep their meaning', () => {
    expect(LINK_SOURCES.indexOf('Guitar Level')).toBe(15);
    expect(LINK_SOURCES.indexOf('Voice Level')).toBe(16);
    expect(LINK_SOURCES.length).toBeGreaterThanOrEqual(20);   // later sources are appended (v2.1 science)
    expect(sanitizeLinks([{ src: 16, dst: 'cutoff', amt: 0.5, curve: 0 }])).toEqual([{ src: 16, dst: 'cutoff', amt: 0.5, curve: 0 }]);
  });

  it('loads older sessions unchanged and keeps Voice Level links (no format change)', () => {
    const s = JSON.parse(JSON.stringify(defaultState()));
    s.parts[0].links = [{ src: 15, dst: 'morph', amt: 0.4, curve: 0 }, { src: 16, dst: 'cutoff', amt: 1, curve: 1 }];
    const m = migrateState(s);
    expect(m.version).toBe(STATE_VERSION);
    expect(m.parts[0].links).toEqual(s.parts[0].links);
    const v1 = JSON.parse(JSON.stringify(defaultState()));
    v1.version = 1;
    expect(migrateState(v1).parts[0].links).toEqual(defaultState().parts[0].links);
  });

  it('moves the linked parameter with the voice envelope from the host', () => {
    const dsp = makeDSP({ terrainA: 0, params: { cutoff: 200 } });
    dsp.handleMessage({ t: 'links', part: 0, links: [{ src: 16, dst: 'cutoff', amt: 1, curve: 0 }] });
    const slot = MOD_PARAM_IDS.indexOf('cutoff');
    const b = Array.from({ length: 8 }, () => new Float32Array(128));
    const run = (sec) => { for (let i = 0; i < sec * SR; i += 128) dsp.process(b[0], b[1], b[2], b[3], b[4], b[5], 128, (dsp.t = (dsp.t || 0) + 128 / SR), b[6], b[7]); };
    run(0.05);
    expect(dsp.parts[0].partLink[slot]).toBe(0);
    dsp.handleMessage({ t: 'voiceLevel', v: 0.7 });
    run(0.3);
    expect(dsp.parts[0].partLink[slot]).toBeCloseTo(0.7, 3);
    // The Guitar Level source does not follow the voice.
    dsp.handleMessage({ t: 'links', part: 0, links: [{ src: 15, dst: 'cutoff', amt: 1, curve: 0 }] });
    run(0.05);
    expect(dsp.parts[0].partLink[slot]).toBe(0);
  });
});

// ================================================================ rig

function fakeVoiceHost() {
  const ls = {};
  const state = { open: false, label: '', enabled: false };
  const host = {
    calls: [],
    async set(o) {
      host.calls.push(o);
      if (o.enabled === true) { state.open = true; state.enabled = true; state.label = 'MacBook Pro Microphone'; }
      if (o.enabled === false) { state.open = false; state.enabled = false; }
      return host.status();
    },
    status: () => ({ open: state.open, label: state.label, enabled: state.enabled, reason: null }),
    listInputs: async () => [{ deviceId: 'default', label: 'Default - MacBook Pro Microphone' }],
    meter: () => ({ open: state.open, pos: 0, clip: false }),
    resetGuard: vi.fn(),
    capture: vi.fn(),
    on: (t, fn) => { (ls[t] ||= new Set()).add(fn); return () => ls[t].delete(fn); },
    emit: (t, e) => { for (const fn of ls[t] || []) fn(e); },
  };
  return host;
}

function setupRig({ output = 'MacBook Pro Speakers', permission = 'granted', saved = null } = {}) {
  const host = fakeVoiceHost();
  const engine = {
    voice: host, outputDeviceId: 'default', bend: vi.fn(),
    listOutputDevices: async () => [{ deviceId: 'default', label: output }],
    on: () => () => {},
  };
  const router = { noteOn: vi.fn(), noteOff: vi.fn(), resolve: (t) => (t === 'sel' ? [0] : [t]) };
  const store = createStore(defaultState());
  const storage = memStorage(saved ? { [VOICE_KEY]: JSON.stringify(saved) } : {});
  const rig = createVoiceRig({ store, engine, router, storage, micPermission: async () => permission, mediaDevices: null });
  return { rig, host, engine, router, store, storage };
}

describe('voice rig', () => {
  it('keeps Monitor off for a laptop microphone with laptop speakers, before and after the microphone opens', async () => {
    const { rig, host } = setupRig();
    await rig.set({ enabled: 1 });
    const opening = host.calls.find(c => c.enabled === true);
    expect(opening.monitor).toBe(false);
    expect(host.calls.every(c => c.monitor !== true)).toBe(true);
    expect(rig.status().monitor).toMatchObject({ on: false, reason: 'speakers', auto: true });
    expect(rig.status().permission).toBe('granted');
  });

  it('monitors with headphones, and Monitor: Off wins', async () => {
    const { rig, host } = setupRig({ output: 'External Headphones' });
    await rig.set({ enabled: 1 });
    expect(host.calls.at(-1).monitor).toBe(true);
    await rig.set({ monitor: 'off' });
    expect(host.calls.at(-1).monitor).toBe(false);
  });

  it('routes the tracker notes to the chosen part with source voice', async () => {
    const { rig, host, router } = setupRig();
    await rig.set({ enabled: 1, notes: 1, target: 2 });
    host.emit('voiceNote', { type: 'noteOn', note: 60, velocity: 0.8 });
    expect(router.noteOn).toHaveBeenCalledWith(2, 60, 0.8, 'voice');
    host.emit('voiceNote', { type: 'stop' });
    expect(router.noteOff).toHaveBeenCalledWith(2, 60, 'voice');
  });

  it('reopens the microphone at start only when permission was already given', async () => {
    const saved = { ...defaultVoicePrefs(), enabled: 1 };
    const asked = setupRig({ permission: 'prompt', saved });
    await asked.rig.restore();
    expect(asked.host.calls.some(c => c.enabled === true)).toBe(false);
    const ok = setupRig({ permission: 'granted', saved });
    await ok.rig.restore();
    expect(ok.host.calls.some(c => c.enabled === true)).toBe(true);
  });

  it('Capture stores the sung note as a terrain named after it', async () => {
    const { rig, host, store } = setupRig();
    store.set('ui.selectedPart', 1);
    host.capture.mockResolvedValue({ ok: true, samples: sungNote(220, { seconds: 2 }), sampleRate: SR });
    await rig.set({ enabled: 1, captureSlot: 'B' });
    const r = await rig.captureNote({ seconds: 2 });
    expect(r).toMatchObject({ ok: true, part: 1, slot: 'B', name: 'Voice A3' });
    expect(store.get('parts.1.userTerrain.B')).toMatchObject({ name: 'Voice A3', kind: 'wavetable' });
  });
});
