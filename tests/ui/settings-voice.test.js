// Settings > Voice on a fake DOM: the real pane, voice rig and voice host
// (fake AudioContext, fake microphone). Checks the controls are there with
// plain wording, Enable opens the microphone without monitoring on a laptop's
// speakers, Mic Cleanup reopens it with the browser's processing, and a refused
// permission shows what to do.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { fakeContext } from '../pedals/fake-audio.js';
import { createVoiceHost } from '../../src/audio/voice-host.js';
import { createVoiceRig } from '../../src/ui/voice-rig.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';

let dom, createVoiceSettings, SETTINGS_TABS;
beforeAll(async () => {
  dom = installFakeDom();
  ({ createVoiceSettings } = await import('../../src/ui/settings-voice.js'));
  ({ SETTINGS_TABS } = await import('../../src/ui/settings.js'));
});
afterAll(() => dom.restore());

function voiceContext() {
  const ctx = fakeContext();
  const param = (v) => ({ value: v, setTargetAtTime(x) { this.value = x; }, setValueAtTime(x) { this.value = x; }, linearRampToValueAtTime(x) { this.value = x; }, cancelScheduledValues() {} });
  const mk = (kind, extra) => { const g = ctx.createGain(); g.kind = kind; delete g.gain; return Object.assign(g, extra); };
  ctx.createBiquadFilter = () => mk('biquad', { type: 'lowpass', frequency: param(350), Q: param(1) });
  ctx.createDynamicsCompressor = () => mk('compressor', { threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) });
  ctx.createStereoPanner = () => mk('panner', { pan: param(0) });
  ctx.createDelay = () => mk('delay', { delayTime: param(0) });
  return ctx;
}

function setup({ deny = false, output = 'MacBook Pro Speakers' } = {}) {
  const ctx = voiceContext();
  const g = () => ctx.createGain();
  const asked = [];
  const host = createVoiceHost(ctx, {
    masterIn: g(), delayIn: g(), reverbIn: g(), loopIn: g(),
    deps: {
      hasGetUserMedia: () => true,
      loadPedalWorklets: async () => ({ ok: true }),
      platform: () => ({ electron: false, mac: false }),
      listAudioInputs: async () => [{ deviceId: 'default', label: 'Default - MacBook Pro Microphone' }],
      openMic: async (c) => {
        asked.push(c);
        if (deny) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
        const track = { label: 'MacBook Pro Microphone', getSettings: () => ({ sampleRate: 48000, sampleSize: 24, channelCount: 1 }), stop() {} };
        return { getAudioTracks: () => [track], getTracks: () => [track] };
      },
      attachFeedbackGuard: () => ({ reset() {}, dispose() {}, status: () => ({ muted: false }) }),
      createGuitarInput: () => ({ via: 'worklet', configure() {}, dispose() {}, on: () => () => {} }),
    },
  });
  const engine = { voice: host, outputDeviceId: 'default', listOutputDevices: async () => [{ deviceId: 'default', label: output }], on: () => () => {} };
  const store = createStore(defaultState());
  const storage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, v); } };
  const rig = createVoiceRig({ store, engine, router: null, storage, micPermission: async () => 'prompt', mediaDevices: null });
  const uiCtx = { voice: rig, startAudio: vi.fn(async () => {}), toast: vi.fn() };
  const pane = createVoiceSettings(uiCtx);
  dom.flush();
  const label = (b) => (b.textContent || (b.innerHTML || '').replace(/<[^>]*>/g, '')).trim();
  const button = (re) => pane.el.querySelectorAll('button').find(b => re.test(label(b)) || re.test(b.getAttribute('aria-label') || ''));
  return { host, rig, pane, button, asked, uiCtx };
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); dom.flush(); };

describe('Settings > Voice', () => {
  it('has its own tab, before Pedals', () => {
    const ids = SETTINGS_TABS.map(t => t.id);
    expect(ids).toContain('voice');
    expect(ids.indexOf('voice')).toBeLessThan(ids.indexOf('pedals'));
  });

  it('explains the microphone and shows every control, all off, in plain words', () => {
    const { pane, asked } = setup();
    const text = pane.el.textContent;
    for (const label of ['Microphone', 'Mic Cleanup', 'Input gain', 'Clip', 'Monitor', 'Use headphones to avoid feedback', 'High-pass 80 Hz', 'Compressor', 'De-esser',
      'Voice strip', 'Pan', 'Delay send', 'Reverb send', 'Voice plays notes', 'Capture', 'Voice level']) expect(text).toContain(label);
    expect(text).toMatch(/uses the microphone only while Voice is enabled/);
    expect(text).not.toMatch(/Laptop mic cleanup/i);
    expect(text).not.toMatch(/—/);
    expect(asked).toHaveLength(0);
    const btns = pane.el.querySelectorAll('button');
    const cleanup = btns.find(b => /Mic Cleanup/.test(b.innerHTML || b.textContent));
    expect(cleanup.getAttribute('aria-label')).toBe('Mic Cleanup');
    expect(cleanup.getAttribute('aria-pressed')).toBe('false');
  });

  it('Enable opens the microphone, unmonitored on laptop speakers, and Mic Cleanup reopens it', async () => {
    const { pane, button, asked, host, uiCtx } = setup();
    button(/^Voice$/).click();
    await settle();
    expect(uiCtx.startAudio).toHaveBeenCalled();
    expect(asked).toHaveLength(1);
    expect(asked[0].audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(host.status()).toMatchObject({ open: true, monitor: false });
    expect(pane.el.textContent).toMatch(/Listening, not monitored/);
    expect(pane.el.textContent).toMatch(/built-in microphone would hear the built-in speakers/);
    button(/Mic Cleanup/).click();
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1].audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  });

  it('monitors with headphones', async () => {
    const { button, host } = setup({ output: 'External Headphones' });
    button(/^Voice$/).click();
    await settle();
    expect(host.status()).toMatchObject({ open: true, monitor: true });
  });

  it('shows what to do when permission is refused, with Try again', async () => {
    const { pane, button, rig } = setup({ deny: true });
    button(/^Voice$/).click();
    await settle();
    expect(pane.el.textContent).toMatch(/Microphone access is blocked for this page/);
    expect(button(/Try again/).hidden).toBe(false);
    expect(rig.status().permission).toBe('denied');
  });
});
