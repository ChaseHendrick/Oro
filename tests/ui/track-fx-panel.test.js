import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { createTrackFxPanel } from '../../src/ui/track-fx-panel.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { FX_TYPES, FX_ROUTINGS, defaultFxSlot } from '../../src/dsp/track-fx-config.js';
import { parseTyped } from '../../src/ui/knob.js';
import { fxParamScale } from '../../src/dsp/track-fx-config.js';
let dom;
beforeEach(() => { dom = installFakeDom(); document.body = document.createElement('body'); });
afterEach(() => { dom.flush(); dom.restore(); });
const choose = (select, value) => { select.value = String(value); select.dispatchEvent({ type: 'change' }); };
function setup() { const store = createStore(defaultState()), panel = createTrackFxPanel({ store }); return { store, panel }; }
describe('selected track effects controls', () => {
  it('offers the complete catalogue, routing choices and stable sidechain sources', () => {
    const { store, panel } = setup();
    const types = panel.el.querySelector('[aria-label="Slot A effect"]'); expect(types.options).toHaveLength(FX_TYPES.length);
    expect(panel.el.querySelector('[aria-label="Track effects routing"]').options).toHaveLength(FX_ROUTINGS.length);
    const sc = panel.el.querySelector('[aria-label="Track effects sidechain"]');
    expect(sc.options.map(o => o.value)).toContain(store.get('parts.1.id')); expect(sc.options.map(o => o.value)).not.toContain(store.get('parts.0.id'));
    expect(panel.el.querySelectorAll('[role="slider"]').every(slider => slider.getAttribute('aria-disabled') === 'true')).toBe(true);
    panel.dispose();
  });
  it('writes type defaults, normalized knob values and routing to the selected track', () => {
    const { store, panel } = setup(), types = panel.el.querySelector('[aria-label="Slot A effect"]');
    choose(types, 'shimmer'); expect(store.get('parts.0.trackFx.slots.0')).toEqual(defaultFxSlot('shimmer'));
    const knob = panel.el.querySelector('[aria-label="Slot A Shimmer reverb Shimmer"]');
    knob.dispatchEvent({ type: 'keydown', key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
    expect(store.get('parts.0.trackFx.slots.0.p4')).toBeCloseTo(.61);
    choose(panel.el.querySelector('[aria-label="Track effects routing"]'), 7); expect(store.get('parts.0.trackFx.routing')).toBe(7);
    store.set('ui.selectedPart', 1); choose(types, 'duck');
    expect(store.get('parts.1.trackFx.slots.0.type')).toBe('duck'); expect(store.get('parts.0.trackFx.slots.0.type')).toBe('shimmer');
    panel.dispose();
  });
  it('keeps controls attached to track selection and disposes subscriptions and DOM actions', () => {
    const { store, panel } = setup(), select = panel.el.querySelector('[aria-label="Slot A effect"]');
    choose(select, 'eq4'); store.set('parts.0.name', 'Keys'); expect(panel.el.textContent).toContain('Keys effects');
    panel.dispose(); const old = panel.el.textContent;
    store.set('parts.0.name', 'Changed'); choose(select, 'delay');
    expect(panel.el.textContent).toBe(old); expect(store.get('parts.0.trackFx.slots.0.type')).toBe('eq4');
  });
  it('shows actual pitch and time units and accepts typed values in those units', () => {
    const { store, panel } = setup(), select = panel.el.querySelector('[aria-label="Slot A effect"]');
    choose(select, 'granular'); const pitch = panel.el.querySelector('[aria-label="Slot A Granular pitch shift Pitch"]');
    expect(pitch.getAttribute('aria-valuenow')).toBe('12'); expect(pitch.getAttribute('aria-valuetext')).toBe('12.0 st');
    pitch.dispatchEvent({ type: 'keydown', key: 'Home', preventDefault() {}, stopPropagation() {} }); dom.flush();
    expect(store.get('parts.0.trackFx.slots.0.p1')).toBe(0); expect(pitch.getAttribute('aria-valuenow')).toBe('-24');
    expect(parseTyped(fxParamScale('granular', 0), '12 st')).toBe(12);
    expect(parseTyped(fxParamScale('delay', 0), '250ms')).toBe(.25);
    panel.dispose();
  });
  it('offers a vocoder modulator of the microphone or another track, not this one', () => {
    const { store, panel } = setup();
    choose(panel.el.querySelector('[aria-label="Slot A effect"]'), 'vocoder');
    expect(store.get('parts.0.trackFx.slots.0')).toEqual(defaultFxSlot('vocoder'));
    const mod = panel.el.querySelector('[aria-label="Slot A modulator"]');
    expect(mod.options[0].textContent).toBe('Microphone');
    expect(Array.from(mod.options).map(o => o.value)).toContain(store.get('parts.1.id'));
    expect(Array.from(mod.options).map(o => o.value)).not.toContain(store.get('parts.0.id'));
    const voice = panel.el.querySelector('.tfx-voice');
    expect(voice.hidden).toBe(false);
    expect(voice.textContent).toContain('Turn Voice on to use the microphone');
    expect(panel.el.querySelector('[aria-label="Slot A Vocoder "]')).toBeNull();
    choose(mod, store.get('parts.1.id'));
    expect(store.get('parts.0.trackFx.slots.0.mod')).toBe(store.get('parts.1.id'));
    expect(voice.hidden).toBe(true);
    panel.dispose();
  });
});
