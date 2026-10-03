// v2.9 Settings > Operator on a fake DOM: the tab is listed, the switches
// write the session's `operator` object, Drop it / Spill / Repair and the
// test tones become engine actions, and the MIDI monitor lists messages.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createEmitter } from '../../src/music/emitter.js';

let dom, createOperatorSettings, describeMidi, SETTINGS_TABS;
beforeAll(async () => {
  dom = installFakeDom();
  ({ createOperatorSettings, describeMidi } = await import('../../src/ui/operator.js'));
  ({ SETTINGS_TABS } = await import('../../src/ui/settings.js'));
});
afterAll(() => dom.restore());

function setup() {
  const store = createStore(defaultState());
  const actions = [];
  const events = createEmitter();
  const engine = { operator: (a, v) => actions.push([a, v]), operatorState: () => ({ dmg: 0.5, wet: 0 }), on: (t, fn) => events.on(t, fn), off: (t, fn) => events.off(t, fn) };
  const midiEvents = createEmitter();
  const midi = { on: (t, fn) => midiEvents.on(t, fn), off: (t, fn) => midiEvents.off(t, fn) };
  const ctx = { store, engine, midi, startAudio: async () => true, toast: () => {} };
  const pane = createOperatorSettings(ctx);
  const button = (text) => [...pane.el.querySelectorAll('button')].find(b => b.textContent.trim() === text || String(b.innerHTML || '').includes(`>${text}<`));
  return { store, actions, pane, button, midiEvents };
}
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe('Settings > Operator', () => {
  it('is a settings tab', () => {
    expect(SETTINGS_TABS.map(t => t.id)).toContain('operator');
  });

  it('starts all off, and the switches write the session', async () => {
    const { store, actions, button } = setup();
    expect(store.get('operator')).toBeUndefined();
    expect(button('Drop it').disabled).toBe(true);
    button('Drop damage').click();
    expect(store.get('operator').drop).toBe(1);
    expect(button('Drop it').disabled).toBe(false);
    button('Drop it').click();
    button('Repair').click();
    await settle();
    expect(actions).toEqual([['drop', 1], ['repair', 'drop']]);
    button('Drop damage').click();
    expect(store.get('operator')).toBeUndefined();
  });

  it('test tones toggle, one at a time', async () => {
    const { actions, button } = setup();
    button('Sine 1 kHz').click();
    await settle();
    expect(button('Sine 1 kHz').getAttribute('aria-pressed')).toBe('true');
    button('Sine 1 kHz').click();
    await settle();
    expect(actions.map(a => a[1])).toEqual(['sine', 'off']);
  });

  it('describes MIDI messages plainly', () => {
    expect(describeMidi([0x90, 60, 100])).toBe('Note on, ch 1, C4, velocity 100');
    expect(describeMidi([0xb1, 7, 64])).toBe('CC 7 = 64, ch 2');
    expect(describeMidi([0xe0, 0, 64])).toBe('Pitch bend 0, ch 1');
  });
});
