// Settings > Pedals on a fake DOM: the Mod slots on the pedal cards (source,
// control, LFO settings), the "Patches recall pedal presets" switch, and the
// "Pedal presets" fields used by the scene and patch save forms.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createPedalRig } from '../../src/ui/pedal-rig.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';

let dom, createPedalSettings, createPedalPresetFields;
beforeAll(async () => {
  dom = installFakeDom();
  ({ createPedalSettings } = await import('../../src/ui/settings-pedals.js'));
  ({ createPedalPresetFields } = await import('../../src/ui/pedal-presets-form.js'));
});
afterAll(() => dom.restore());

function setup() {
  const store = createStore(defaultState());
  const storage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, v); } };
  const midi = { status: 'ready', sendRaw: vi.fn(() => true) };
  // No engine: the audio groups are replaced by a note, the MIDI group is still there.
  const rig = createPedalRig({ store, midi, storage });
  const uiCtx = { pedals: rig, midi: null, startAudio: async () => {}, toast: vi.fn() };
  return { rig, uiCtx, store };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); dom.flush(); };
const byLabel = (root, label) => root.querySelectorAll('select').find(s => s.getAttribute('aria-label') === label);
const choose = (sel, value) => { sel.value = value; sel.dispatchEvent({ type: 'change' }); };

describe('Settings > Pedals > Pedal MIDI', () => {
  it('each pedal card has two Mod slots that set a source, a control and an LFO', async () => {
    const { rig, uiCtx } = setup();
    const pane = createPedalSettings(uiCtx);
    dom.flush();
    const card = pane.el.querySelectorAll('article').find(a => a.getAttribute('aria-label') === 'OBNE Purr-ting');
    expect(card.querySelectorAll('div.pedal-mod')).toHaveLength(2);
    const src = byLabel(card, 'OBNE Purr-ting modulation 2 source');
    expect(src.options.map(o => o.textContent)).toEqual(['Off', 'Macro 1', 'Macro 2', 'Macro 3', 'Macro 4', 'Guitar level', 'LFO']);
    await rig.setPedal('purrting', { enabled: 1 });
    choose(src, 'lfo');
    choose(byLabel(card, 'OBNE Purr-ting modulation 2 control to move'), 'filter');
    choose(byLabel(card, 'OBNE Purr-ting modulation 2 LFO shape'), 'triangle');
    await settle();
    expect(rig.prefs.pedals.purrting.mods[1]).toMatchObject({ source: 'lfo', control: 'filter', lfoShape: 'triangle' });
    expect(rig.pedalMidi.mappings()).toEqual([expect.objectContaining({ pedal: 'purrting', control: 'filter', source: 'lfo:purrting:1' })]);
    // The LFO rows show only for an LFO source; the rate becomes a length when synced.
    const mod2 = card.querySelectorAll('div.pedal-mod')[1];
    const lines = mod2.querySelectorAll('div.pedal-line');
    expect(lines.map(l => l.hidden)).toEqual([false, false, false, false]);
    const tempoBtn = mod2.querySelectorAll('button').find(b => b.textContent === 'Tempo');
    tempoBtn.click();
    await settle();
    expect(rig.prefs.pedals.purrting.mods[1].lfoSync).toBe(1);
    expect(byLabel(mod2, 'OBNE Purr-ting modulation 2 LFO length').parentNode.hidden).toBe(false);
    choose(src, 'macro1');
    await settle();
    expect(lines.map(l => l.hidden)).toEqual([false, false, true, true]);
    await rig.setPedalMod('purrting', 1, { source: '' });
    await settle();
    expect(lines.map(l => l.hidden)).toEqual([false, true, true, true]);
    expect(rig.pedalMidi.mappings()).toEqual([]);
    pane.dispose();
    rig.dispose();
  });

  it('has the "Patches recall pedal presets" switch, off by default', async () => {
    const { rig, uiCtx } = setup();
    const pane = createPedalSettings(uiCtx);
    dom.flush();
    const btn = pane.el.querySelectorAll('button').find(b => /Patches recall pedal presets/.test(b.textContent) || /Patches recall pedal presets/.test(b.innerHTML));
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    await settle();
    expect(rig.prefs.patchesRecallPedals).toBe(1);
    pane.dispose();
    rig.dispose();
  });
});

describe('Pedal presets fields (save scene / save patch)', () => {
  it('show only when a pedal that takes presets is on, and check each profile\'s range', async () => {
    const { rig, uiCtx } = setup();
    expect(createPedalPresetFields(uiCtx, { kind: 'scene' })).toBe(null);
    expect(createPedalPresetFields({ pedals: null })).toBe(null);
    await rig.setPedal('purrting', { enabled: 1 });
    await rig.setPedal('lostAndFound', { enabled: 1 });
    await rig.setPedal('xero', { enabled: 1 }); // no presets: no box
    const f = createPedalPresetFields(uiCtx, { kind: 'scene', initial: { nucleo: 4 } });
    const inputs = f.el.querySelectorAll('input');
    // Purr-ting, Lost + Found, and the Nucleo because the stored set mentions it.
    expect(inputs.map(i => i.getAttribute('aria-label').split(' preset')[0])).toEqual(['OBNE Purr-ting', 'Chase Bliss Lost + Found', 'Cornerstone Nucleo']);
    expect(f.el.textContent).toContain('0 = Live, 1-127 saved presets');
    expect(f.read()).toEqual({ ok: true, value: { nucleo: 4 } });
    inputs[0].value = '0';
    expect(f.read()).toMatchObject({ ok: false, reason: expect.stringMatching(/presets run from 1 to 127/) });
    expect(inputs[0].getAttribute('aria-invalid')).toBe('true');
    inputs[0].value = '12';
    inputs[1].value = '0';
    inputs[2].value = '';
    expect(f.read()).toEqual({ ok: true, value: { purrting: 12, lostAndFound: 0 } });
    inputs[0].value = '';
    inputs[1].value = '';
    expect(f.read()).toEqual({ ok: true, value: null });
    f.fill({ purrting: 3 });
    expect(inputs[0].value).toBe('3');
    rig.dispose();
  });

  it('keeps stored presets of pedals not shown here', async () => {
    const { rig, uiCtx } = setup();
    await rig.setPedal('purrting', { enabled: 1 });
    const f = createPedalPresetFields(uiCtx, { kind: 'patch' });
    f.fill({ purrting: 2, lostAndFound: 5 }); // the Lost + Found is off and has no box
    expect(f.el.querySelectorAll('input')).toHaveLength(1);
    expect(f.read()).toEqual({ ok: true, value: { lostAndFound: 5, purrting: 2 } });
    expect(f.el.textContent).toMatch(/Patches recall pedal presets is on/);
    rig.dispose();
  });
});
