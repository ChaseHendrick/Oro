import { describe, it, expect, vi } from 'vitest';
import { createBounceReminder, installBounceReminder, bounceReminderEnabled, setBounceReminderEnabled, REMIND_GAP_MS, REMIND_PLAY_MS, REMIND_TICK_MS, BOUNCE_REMINDER_KEY } from '../../src/ui/bounce-reminder.js';
import { createStrainWatch, createStrainSuggestion, strainMessage, STRAIN_NO_ASK_KEY } from '../../src/ui/audio-strain.js';
import { seedNewInstallDefaults, NEW_INSTALL_DEFAULTS } from '../../src/core/first-run.js';
import { suggestedBounceBars } from '../../src/ui/bounce.js';
import { SETTINGS_KEY, loadPrefs } from '../../src/ui/prefs.js';
import { RIG_KEY, loadRig, savedContextSampleRate } from '../../src/pedals/rig-settings.js';
import { createStore } from '../../src/core/store.js';

function memory(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m };
}
const MIN = 60 * 1000;

describe('bounce reminder timing', () => {
  function setup(on = true) {
    let t = 0; const notify = vi.fn(); let enabled = on;
    const r = createBounceReminder({ now: () => t, enabled: () => enabled, notify });
    return { r, notify, advance: ms => { t += ms; }, setEnabled: v => { enabled = v; } };
  }
  it('suggests a bounce after 20 minutes of playing with changes, counting only playing time', () => {
    const { r, notify, advance } = setup();
    r.markChanged(); r.setPlaying(true); advance(19 * MIN); r.tick(); expect(notify).not.toHaveBeenCalled();
    r.setPlaying(false); advance(60 * MIN); r.tick(); expect(notify).not.toHaveBeenCalled();
    r.setPlaying(true); advance(MIN); r.tick(); expect(notify).toHaveBeenCalledWith('long');
  });
  it('needs changes since the last bounce', () => {
    const { r, notify, advance } = setup();
    r.setPlaying(true); advance(REMIND_PLAY_MS + MIN); r.tick(); expect(notify).not.toHaveBeenCalled();
    r.markChanged(); r.markBounced(); advance(REMIND_PLAY_MS - MIN); r.tick(); expect(notify).not.toHaveBeenCalled();
    expect(r.pendingOnClose()).toBe(false); r.markChanged(); expect(r.pendingOnClose()).toBe(true);
  });
  it('shows at most one suggestion per 15 minutes', () => {
    const { r, notify, advance } = setup();
    r.markChanged(); r.setPlaying(true);
    expect(r.dropout()).toBe(true); advance(5 * MIN); expect(r.dropout()).toBe(false);
    advance(REMIND_GAP_MS); expect(r.dropout()).toBe(true); expect(notify).toHaveBeenCalledTimes(2);
  });
  it('suggests a bounce for dropouts only while the transport plays', () => {
    const { r, notify } = setup();
    expect(r.dropout()).toBe(false); r.setPlaying(true); expect(r.dropout()).toBe(true); expect(notify).toHaveBeenCalledWith('dropouts');
  });
  it('does nothing when the toggle is off, and the toggle is stored per computer (on by default)', () => {
    const { r, notify, advance } = setup(false);
    r.markChanged(); r.setPlaying(true); advance(2 * REMIND_PLAY_MS); r.tick(); r.dropout();
    expect(notify).not.toHaveBeenCalled(); expect(r.pendingOnClose()).toBe(false);
    const st = memory(); expect(bounceReminderEnabled(st)).toBe(true);
    setBounceReminderEnabled(false, st); expect(st.getItem(BOUNCE_REMINDER_KEY)).toBe('0'); expect(bounceReminderEnabled(st)).toBe(false);
  });
  it('wires history, finished bounces, the desktop close flag and a fake clock together', () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const store = createStore({ ui: { playing: 0 } });
      let historyFn, bounceFn; const toast = vi.fn(), openBounce = vi.fn();
      const desktop = { setUnbounced: vi.fn(), onOpenBounce: vi.fn(fn => { desktop.open = fn; return () => {}; }) };
      const ctx = { store, toast, history: { on: fn => { historyFn = fn; return () => {}; } }, bus: { on: (_e, fn) => { bounceFn = fn; return () => {}; } } };
      const wired = installBounceReminder(ctx, { openBounce, storage: memory(), desktop });
      historyFn(); expect(desktop.setUnbounced).toHaveBeenLastCalledWith(true);
      store.set('ui.playing', 1); vi.advanceTimersByTime(REMIND_PLAY_MS + REMIND_TICK_MS);
      expect(toast).toHaveBeenCalledOnce();
      const options = toast.mock.calls[0][1]; expect(options.actions.map(a => a.label)).toEqual(['Bounce now', 'Not now']);
      options.actions[0].onClick(); expect(openBounce).toHaveBeenCalledOnce();
      desktop.open(); expect(openBounce).toHaveBeenCalledTimes(2);
      bounceFn(); expect(desktop.setUnbounced).toHaveBeenLastCalledWith(false);
      wired.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe('Bounce now defaults to the whole pattern or song', () => {
  const part = (patterns, extra = {}) => ({ seqOn: 1, activePattern: 0, patterns, ...extra });
  it('covers the longest sequenced track, with song mode', () => {
    expect(suggestedBounceBars({ parts: [] })).toBe(4);
    expect(suggestedBounceBars({ parts: [part([{ length: 16, rate: 3 }])] })).toBe(1);
    expect(suggestedBounceBars({ parts: [part([{ length: 16, rate: 1 }]), part([{ length: 16, rate: 0 }])] })).toBe(4);
    const song = part([{ length: 16, rate: 3 }, { length: 16, rate: 3 }], { chain: { on: 1, entries: [{ pattern: 0, repeats: 4 }, { pattern: 1, repeats: 3 }] } });
    expect(suggestedBounceBars({ parts: [song] })).toBe(8);
    expect(suggestedBounceBars({ parts: [{ ...song, seqOn: 0 }] })).toBe(4);
  });
});

describe('Pristine, 96 kHz safety net', () => {
  it('detects more than 3 dropouts in 10 s, or 5 s above 90% load', () => {
    let t = 0; const w = createStrainWatch({ now: () => t });
    expect(w.push({ percent: 40, overruns: 2 })).toBe(null); t += 11000;
    expect(w.push({ percent: 40, overruns: 3 })).toBe(null); t += 1000;
    expect(w.push({ percent: 40, overruns: 1 })).toBe('dropouts');
    w.reset();
    for (let i = 0; i < 5; i++) { expect(w.push({ percent: 95, overruns: 0 })).toBe(null); t += 1000; }
    expect(w.push({ percent: 95, overruns: 0 })).toBe('load');
    expect(w.push({ percent: 50, overruns: 0 })).toBe(null);
  });
  it('offers to step down once per session, never silently, and remembers Don\'t ask again', () => {
    const store = createStore({ ui: { audioQuality: 'pristine' } }), toast = vi.fn(), storage = memory();
    const s = createStrainSuggestion({ store, engine: { sampleRate: 96000 }, toast, storage });
    expect(s.offer()).toBe(true); expect(s.offer()).toBe(false);
    expect(toast.mock.calls[0][0]).toBe('Audio is struggling at Pristine, 96 kHz. Step down to High?');
    expect(store.get('ui.audioQuality')).toBe('pristine');
    const [stepDown, keep, never] = toast.mock.calls[0][1].actions;
    expect([stepDown.label, keep.label, never.label]).toEqual(['Step down', 'Keep', "Don't ask again"]);
    stepDown.onClick(); expect(store.get('ui.audioQuality')).toBe('high');
    never.onClick(); expect(storage.getItem(STRAIN_NO_ASK_KEY)).toBe('1');
    const next = createStrainSuggestion({ store: createStore({ ui: { audioQuality: 'pristine' } }), engine: {}, toast, storage });
    expect(next.offer()).toBe(false);
    expect(createStrainSuggestion({ store: createStore({ ui: { audioQuality: 'high' } }), engine: {}, toast, storage: memory() }).offer()).toBe(false);
    expect(strainMessage('pristine', 48000)).toBe('Audio is struggling at Pristine, 48 kHz. Step down to High?');
  });
});

describe('new-install defaults', () => {
  it('seeds Pristine and 96 kHz only when nothing has been saved', () => {
    const fresh = memory();
    expect(seedNewInstallDefaults({ storage: fresh })).toBe(true);
    expect(loadPrefs(fresh).audioQuality).toBe(NEW_INSTALL_DEFAULTS.audioQuality);
    expect(loadRig(fresh).sampleRate).toBe(96000); expect(savedContextSampleRate(fresh)).toBe(96000);
    expect(seedNewInstallDefaults({ storage: fresh })).toBe(false);
  });
  it('keeps existing installs on their choices, including the old defaults', () => {
    const withSession = memory();
    expect(seedNewInstallDefaults({ storage: withSession, hasSession: true })).toBe(false);
    expect(loadPrefs(withSession).audioQuality).toBe('standard'); expect(savedContextSampleRate(withSession)).toBe(undefined);
    const withSettings = memory({ [SETTINGS_KEY]: JSON.stringify({ audioQuality: 'eco' }) });
    expect(seedNewInstallDefaults({ storage: withSettings })).toBe(false); expect(loadPrefs(withSettings).audioQuality).toBe('eco');
    const withRig = memory({ [RIG_KEY]: JSON.stringify({ sampleRate: 44100 }) });
    expect(seedNewInstallDefaults({ storage: withRig })).toBe(false); expect(savedContextSampleRate(withRig)).toBe(44100);
    expect(seedNewInstallDefaults({ storage: { getItem() { throw new Error('blocked'); } } })).toBe(false);
  });
});
