// Settings > Pedals ("Audio and pedals", v1.1, docs/PEDALS.md): the output
// device and channel map for the pedal send, the send ceiling, the pedal
// return (input, layout, levels, feedback guard), the guitar on the return
// (Guitar plays notes, Capture to a wavetable terrain), the latency ping, and the
// MIDI pedal profiles (Purr-ting, Lost + Found, Nucleo, Xero) with up to
// MOD_SLOTS modulated controls per pedal (Macro, Guitar level or an LFO), and
// whether patches may recall pedal presets. Everything goes through ctx.pedals
// (src/ui/pedal-rig.js); without it the pane explains why.

import { h, createScope, setText, call } from './dom.js';
import { createSegmented, createToggle, createSelect, createMiniSlider } from './controls.js';
import { schedule } from './frame.js';
import { icon } from './icons.js';
import { PEDAL_IDS, PEDAL_PROFILES, AUDIO_ONLY_PEDALS, MIDI_ROUTES, engageControl, tapControl } from '../pedals/profiles.js';
import { programHint } from '../pedals/pedal-presets.js';
import {
  OUTPUT_PAIRS, SEND_CEILINGS, RETURN_LAYOUT_OPTIONS, MOD_SOURCES, MOD_SLOTS, LFO_SHAPES, MAP_CURVES,
  LFO_RATE_MIN, LFO_RATE_MAX, LFO_BEAT_OPTIONS, SAMPLE_RATE_OPTIONS, COMP_OFFSET_RANGE,
  GUITAR_TARGETS, GUITAR_MODE_OPTIONS, CAPTURE_SLOTS, GUITAR_GATE_MIN_DB, GUITAR_GATE_MAX_DB, guitarChannelOptions,
} from '../pedals/rig-settings.js';
import { DEFAULT_GATE_DB } from '../pedals/guitar-notes.js';
import { noteLabel } from './pedal-rig.js';
import { partCount } from '../core/tracks.js';

const CHANNELS = Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `Ch ${i + 1}` }));

const row = (label, hint, control, cls = '') => h('div', { class: ['setting-row', cls] },
  h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'setting-hint' }, hint) : null), control);

/** A binding (see bind.js) over one rig setting. */
function rigBinding(rig, key, def, { get, set } = {}) {
  const read = get || (() => rig.prefs[key]);
  return {
    def: { id: key, label: def.label, default: def.default, curve: def.curve || 'lin', min: def.min ?? 0, max: def.max ?? 1, options: def.options, hint: def.hint },
    id: key, scope: 'pedals', part: () => null, path: () => `pedals.${key}`, modPath: () => null, learnTarget: () => null,
    get: read,
    set: set || ((v) => { rig.set({ [key]: v }); }),
    reset() { (set || ((v) => rig.set({ [key]: v })))(def.default); },
    subscribe: (fn) => rig.on('change', fn),
  };
}

function pedalBinding(rig, id, key, def) {
  return rigBinding(rig, `${id}.${key}`, def, {
    get: () => rig.prefs.pedals[id][key],
    set: (v) => { rig.setPedal(id, { [key]: v }); },
  });
}

/** A binding over one field of one modulation slot of a pedal. */
function modBinding(rig, id, slot, key, def) {
  return rigBinding(rig, `${id}.mod${slot}.${key}`, def, {
    get: () => rig.prefs.pedals[id].mods[slot][key],
    set: (v) => { rig.setPedalMod(id, slot, { [key]: v }); },
  });
}

const fmtMs = (ms) => `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtHz = (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function createPedalSettings(ctx) {
  const scope = createScope();
  const rig = ctx.pedals || null;
  const root = h('div', { class: 'settings-pedals' });
  const dispose = () => scope.dispose();
  const own = (c) => { scope.add(c.dispose); return c; };

  root.appendChild(h('div', { class: 'callout' }, h('span', { html: icon('info') }),
    h('span', null, 'Run parts of Oro through real guitar pedals: a pedal send per part on extra outputs, the pedals coming back on an input, and MIDI for the pedals that have it. This follows the MPC XL and pedal manuals but has not been tested with the real hardware yet, so start with the send low.')));

  if (!rig || !rig.supported) {
    root.appendChild(h('p', { class: 'settings-note' }, 'The pedal loop needs Web Audio, which is not running in this browser. Everything else in Oro works as usual.'));
    if (rig) appendMidi();
    return { el: root, dispose };
  }

  // ================================================================ send
  const sendOn = own(createToggle(ctx, rigBinding(rig, 'enabled', { label: 'Pedal send', default: 0 }), { label: 'Pedal send', className: 'toggle--switch' }));
  const deviceSel = h('select', { class: 'select-native', 'aria-label': 'Output device for the pedal rig' });
  const deviceWrap = h('div', { class: 'select' }, deviceSel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  const refreshOut = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', html: icon('rotate') + '<span>Refresh</span>', dataset: { tip: 'List the output devices again' } });
  scope.on(deviceSel, 'change', () => rig.set({ outputDeviceId: deviceSel.value || 'default' }));
  scope.on(refreshOut, 'click', () => fillOutputs());
  async function fillOutputs() {
    let list = [];
    try { list = (await rig.listOutputs()) || []; } catch { list = []; }
    deviceSel.textContent = '';
    if (!list.length) list = [{ deviceId: 'default', label: 'System default' }];
    for (const d of list) deviceSel.appendChild(h('option', { value: d.deviceId || 'default' }, d.label || 'Output'));
    const want = rig.prefs.outputDeviceId || 'default';
    if (![...deviceSel.options].some(o => o.value === want)) deviceSel.appendChild(h('option', { value: want }, 'Saved device (not connected)'));
    deviceSel.value = want;
  }
  fillOutputs();
  const mainPair = own(createSelect(ctx, rigBinding(rig, 'mainPair', { label: 'Main mix outputs', default: 0 }), { label: 'Main mix outputs', options: OUTPUT_PAIRS }));
  const sendPair = own(createSelect(ctx, rigBinding(rig, 'sendPair', { label: 'Pedal send outputs', default: 2 }), { label: 'Pedal send outputs', options: OUTPUT_PAIRS }));
  const ceiling = own(createSegmented(ctx, rigBinding(rig, 'ceilingDb', { label: 'Send ceiling', default: -18 }), {
    label: 'Send ceiling', size: 'sm', options: SEND_CEILINGS.map(v => ({ value: v, label: `${v} dB` })),
  }));
  const routeFacts = h('dl', { class: 'status-facts status-facts--wide' });
  const routeWarn = h('p', { class: 'status-warn', hidden: true }, h('span', { html: icon('warn'), 'aria-hidden': 'true' }), h('span'));

  const sendGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'pedals-send' },
    h('h3', { class: 'group-title', id: 'pedals-send' }, 'Pedal send'),
    row('Pedal send', 'Main mix on one pair of outputs, the parts\' Pedal sends on another. Set each part\'s send in Mix.', sendOn.el),
    row('Output device', 'Pick a device with four or more outputs, such as the MPC XL over USB', h('div', { class: 'inline-controls' }, deviceWrap, refreshOut), 'setting-row--stack'),
    row('Main mix', 'Where you listen', mainPair.el),
    row('Send', 'Cable these outputs to the first pedal', sendPair.el),
    row('Send ceiling', 'A safety limiter on the send. About -18 dB keeps hot outputs under what most pedals accept.', ceiling.el),
    routeWarn, routeFacts);

  // ================================================================ return
  const retOn = own(createToggle(ctx, rigBinding(rig, 'returnEnabled', { label: 'Pedal return', default: 0 }), { label: 'Pedal return', className: 'toggle--switch' }));
  const inputSel = h('select', { class: 'select-native', 'aria-label': 'Pedal return input' });
  const inputWrap = h('div', { class: 'select' }, inputSel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  const refreshIn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', html: icon('rotate') + '<span>Refresh</span>', dataset: { tip: 'List the inputs again (names appear once the browser may use an input)' } });
  scope.on(inputSel, 'change', () => rig.set({ returnDeviceId: inputSel.value }));
  scope.on(refreshIn, 'click', () => fillInputs());
  async function fillInputs() {
    let list = [];
    try { list = (await rig.listInputs()) || []; } catch { list = []; }
    inputSel.textContent = '';
    inputSel.appendChild(h('option', { value: '' }, 'System default input'));
    for (const d of list) if (d.deviceId && d.deviceId !== 'default') inputSel.appendChild(h('option', { value: d.deviceId }, d.label || 'Input'));
    const want = rig.prefs.returnDeviceId || '';
    if (![...inputSel.options].some(o => o.value === want)) inputSel.appendChild(h('option', { value: want }, 'Saved input (not connected)'));
    inputSel.value = want;
  }
  fillInputs();
  const layout = own(createSegmented(ctx, rigBinding(rig, 'returnLayout', { label: 'Input layout', default: 'stereo' }), { label: 'Input layout', size: 'sm', options: RETURN_LAYOUT_OPTIONS }));
  const slider = (key, label, max, def) => own(createMiniSlider(ctx, rigBinding(rig, key, { label, default: def, min: 0, max }), { ariaLabel: label, className: 'pedal-slider' }));
  const retLevel = slider('returnLevel', 'Return level', 2, 1);
  const retDelay = slider('returnDelay', 'Return to delay', 1, 0);
  const retReverb = slider('returnReverb', 'Return to reverb', 1, 0);
  const retFacts = h('dl', { class: 'status-facts status-facts--wide' });
  const retWarn = h('p', { class: 'status-warn', hidden: true }, h('span', { html: icon('warn'), 'aria-hidden': 'true' }), h('span'));
  const unmuteBtn = h('button', { type: 'button', class: 'btn btn--sm', hidden: true, html: icon('speaker') + '<span>Unmute return</span>' });
  const reconnectBtn = h('button', { type: 'button', class: 'btn btn--sm', hidden: true, html: icon('rotate') + '<span>Reconnect</span>' });
  scope.on(unmuteBtn, 'click', () => { if (rig.host) rig.host.resetGuard(); });
  scope.on(reconnectBtn, 'click', async () => { reconnectBtn.disabled = true; await rig.reconnectReturn(); reconnectBtn.disabled = false; fillInputs(); });
  const guitarMeter = h('span', { class: 'pedal-meter-fill' });
  const guitarRow = row('Guitar level', 'Envelope of the guitar on input channel 2, a Links source in every part', h('span', { class: 'pedal-meter', role: 'presentation' }, guitarMeter));
  guitarRow.hidden = true;
  if (rig.host) {
    scope.add(rig.host.on('guitar', (e) => schedule(() => { guitarMeter.style.transform = `scaleX(${Math.max(0, Math.min(1, e.level)).toFixed(3)})`; })));
  }

  const retGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'pedals-return' },
    h('h3', { class: 'group-title', id: 'pedals-return' }, 'Pedal return'),
    row('Pedal return', 'Hear the pedals: their output comes back on an audio input and joins the master and the effects, never the send', retOn.el),
    row('Input', 'Echo cancellation, noise suppression and auto gain are switched off', h('div', { class: 'inline-controls' }, inputWrap, refreshIn), 'setting-row--stack'),
    row('Input layout', 'Mono return + guitar: channel 1 is the pedals, channel 2 the guitar for the Guitar Level source', layout.el),
    row('Return level', null, retLevel.el),
    row('Return to delay', null, retDelay.el),
    row('Return to reverb', null, retReverb.el),
    guitarRow,
    retWarn, retFacts, h('div', { class: 'btn-row' }, unmuteBtn, reconnectBtn));

  // ================================================================ guitar
  const gNotes = own(createToggle(ctx, rigBinding(rig, 'guitarNotes', { label: 'Guitar plays notes', default: 0 }), { label: 'Guitar plays notes', className: 'toggle--switch' }));
  const gMode = own(createSegmented(ctx, rigBinding(rig, 'guitarMode', { label: 'Guitar note mode', default: 'single' }), {
    label: 'Guitar note mode', size: 'sm', options: GUITAR_MODE_OPTIONS,
  }));
  const gModeHint = h('p', { class: 'setting-hint guitar-mode-hint' });
  const gTarget = own(createSelect(ctx, rigBinding(rig, 'guitarTarget', { label: 'Guitar track', default: 'sel' }), { label: 'Track the guitar plays', options: GUITAR_TARGETS }));
  // Only tracks that exist can be picked.
  const renderGTargets = () => {
    const n = partCount(ctx.store);
    for (const o of gTarget.select.options) { const i = Number(o.value); if (Number.isInteger(i)) { o.hidden = i >= n; o.disabled = i >= n; } }
  };
  if (ctx.store) {
    scope.add(ctx.store.subscribe('parts', (path) => { if (path === '' || path === 'parts') renderGTargets(); }));
    renderGTargets();
  }
  // The channel labels depend on the return layout, so this one is rebuilt when the layout changes.
  const gChanWrap = h('div', { class: 'guitar-channel' });
  let gChan = null, gChanLayout = null;
  function buildChannel() {
    const lay = rig.prefs.returnLayout;
    if (gChan && gChanLayout === lay) return;
    if (gChan) gChan.dispose();
    gChanLayout = lay;
    gChan = createSegmented(ctx, rigBinding(rig, 'guitarChannel', { label: 'Guitar input channel', default: 2 }), { label: 'Guitar input channel', size: 'sm', options: guitarChannelOptions(lay) });
    gChanWrap.textContent = '';
    gChanWrap.appendChild(gChan.el);
  }
  buildChannel();
  scope.add(() => { if (gChan) gChan.dispose(); });
  const gGate = own(createMiniSlider(ctx, rigBinding(rig, 'guitarGateDb', { label: 'Gate', default: DEFAULT_GATE_DB, min: GUITAR_GATE_MIN_DB, max: GUITAR_GATE_MAX_DB }), {
    ariaLabel: 'Guitar gate', className: 'pedal-slider', format: (v) => `${Math.round(v)} dB`,
  }));
  const gBends = own(createToggle(ctx, rigBinding(rig, 'guitarBends', { label: 'Bends as pitch bend', default: 1 }), { label: 'Bends as pitch bend', className: 'toggle--switch' }));
  const gPitch = h('p', { class: 'setting-hint guitar-pitch', 'aria-live': 'off' });
  const capSlot = own(createSegmented(ctx, rigBinding(rig, 'captureSlot', { label: 'Capture into', default: 'A' }), { label: 'Capture into terrain slot', size: 'sm', options: CAPTURE_SLOTS }));
  const capBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('wave') + '<span>Capture</span>' });
  const capFill = h('span', { class: 'pedal-meter-fill' });
  const capMeter = h('span', { class: 'pedal-meter', role: 'progressbar', 'aria-label': 'Capture progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, capFill);
  const capOut = h('p', { class: 'setting-hint guitar-capture', 'aria-live': 'polite' });
  scope.on(capBtn, 'click', async () => {
    capBtn.disabled = true;
    try {
      await ctx.startAudio();
      const r = await rig.captureNote();
      if (r && r.ok) ctx.toast(`Captured ${r.name} into part ${r.part + 1}, slot ${r.slot}`, { kind: 'info' });
    } finally {
      renderCapture();
      invalidate();
    }
  });
  function renderCapture() {
    const g = rig.status().guitar;
    const c = g ? g.capture : null;
    const busy = !!c && (c.stage === 'recording' || c.stage === 'analysing');
    capMeter.hidden = !busy;
    const pct = c ? Math.round((c.progress || 0) * 100) : 0;
    capFill.style.transform = `scaleX(${busy ? (c.progress || 0).toFixed(3) : 0})`;
    capMeter.setAttribute('aria-valuenow', String(pct));
    if (!c) setText(capOut, 'Press Capture, then pick one note and let it ring for about three seconds.');
    else if (c.stage === 'recording') setText(capOut, `Recording: play and hold one note (${pct}%)...`);
    else if (c.stage === 'analysing') setText(capOut, 'Finding the pitch and building the terrain...');
    else if (c.stage === 'done') setText(capOut, `Captured ${noteLabel(c.note)} (${c.freq.toFixed(1)} Hz), ${c.frames} frames, now on part ${c.part + 1}, slot ${c.slot}.`);
    else setText(capOut, c.reason || 'The capture did not work.');
    capOut.classList.toggle('is-bad', !!c && c.stage === 'error');
  }
  scope.add(rig.on('capture', () => schedule(renderCapture)));
  function renderGuitarPitch(st = rig.status()) {
    const p = st.prefs;
    const a = st.audio;
    const g = a && a.guitar || {};
    const open = !!(a && a.ret && a.ret.open && p.returnEnabled);
    const pitch = st.guitar && st.guitar.pitch;
    if (!p.guitarNotes) setText(gPitch, '');
    else if (!open) setText(gPitch, 'Waiting for the pedal return to open.');
    else if (!g.tracking) setText(gPitch, 'Starting the pitch tracker...');
    else if (p.guitarMode === 'chords') {
      const heard = pitch && pitch.mode === 'chords' && (pitch.notes || pitch.heard);
      const notes = Array.isArray(heard) ? heard.filter(Number.isFinite) : [];
      setText(gPitch, notes.length ? `Hearing ${notes.map(noteLabel).join(', ')}` : 'Hearing no clear chord notes');
    } else if (pitch && Number.isFinite(pitch.midi) && Number.isFinite(pitch.freq)) {
      setText(gPitch, `Hearing ${noteLabel(pitch.midi)} (${pitch.freq.toFixed(1)} Hz)`);
    } else setText(gPitch, 'Hearing no clear pitch');
  }
  const refreshGuitarPitch = () => renderGuitarPitch();
  scope.add(rig.on('pitch', () => schedule(refreshGuitarPitch)));
  renderCapture();

  const guitarGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'pedals-guitar' },
    h('h3', { class: 'group-title', id: 'pedals-guitar' }, 'Guitar'),
    h('p', { class: 'setting-hint' }, 'Uses one channel of the pedal return, so it only runs while the return is open. Track the clean DI (before any drive) for steady notes. Not tested with a real guitar yet.'),
    row('Input channel', 'Mono return + guitar: channel 2 is the clean DI. Stereo return: pick the side the guitar is on.', gChanWrap),
    row('Guitar plays notes', 'Notes from the guitar play a part, like a keyboard (MIDI out too)', gNotes.el),
    row('Note mode', 'Single follows one melody note. Chords can play several held notes together.', gMode.el),
    gModeHint,
    row('Part', 'The part the guitar plays and Capture fills. Selected part follows the part you are editing (and Layer key mode).', gTarget.el),
    row('Gate', 'Notes start above this level and stop below it. Lower is more sensitive; raise it if hum or string noise plays notes.', gGate.el),
    row('Bends as pitch bend', 'Single mode only. Bends and vibrato move the part\'s pitch bend within its Bend range (Sound panel). Off, or with Bend at 0: a bend steps to the next note.', gBends.el),
    gPitch,
    row('Capture', 'Records one held note in either mode and turns it into a wavetable terrain, attack to decay, on the guitar\'s part. Capture does not record chords.', h('div', { class: 'inline-controls' }, capSlot.el, capBtn), 'setting-row--stack'),
    capMeter, capOut);

  // ================================================================ ping
  const pingBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('wave') + '<span>Ping</span>' });
  const pingOut = h('p', { class: 'setting-hint pedal-ping', 'aria-live': 'polite' });
  scope.on(pingBtn, 'click', async () => {
    pingBtn.disabled = true;
    setText(pingOut, 'Listening for the ping...');
    await ctx.startAudio();
    const r = await rig.ping();
    pingBtn.disabled = false;
    renderPing(r);
  });
  function renderPing(r) {
    if (!r) {
      const last = rig.prefs.lastLatencyMs;
      setText(pingOut, last != null ? `Last round trip: ${fmtMs(last)}.` : 'Not measured yet.');
      return;
    }
    if (r.ok) setText(pingOut, `Round trip ${fmtMs(r.latencyMs)} (${Math.round(r.confidence * 100)}% confidence${r.inverted ? ', the return is polarity inverted' : ''}).`);
    else setText(pingOut, r.reason || 'No clear ping came back.');
  }
  renderPing(null);

  // Latency compensation: the round trip (plus a manual offset) moves
  // sequenced notes of parts through the pedals earlier, and delays the dry
  // sound of Send mode parts (src/pedals/latency-comp.js).
  const compOn = own(createToggle(ctx, rigBinding(rig, 'compensate', { label: 'Compensate', default: 0 }), { label: 'Compensate', className: 'toggle--switch' }));
  const offsetIn = h('input', {
    type: 'number', class: 'field pedal-offset', min: String(COMP_OFFSET_RANGE.min), max: String(COMP_OFFSET_RANGE.max), step: '0.5',
    value: String(rig.prefs.compOffsetMs), 'aria-label': 'Latency offset in milliseconds',
  });
  scope.on(offsetIn, 'change', () => {
    const v = Number(offsetIn.value);
    rig.set({ compOffsetMs: Number.isFinite(v) ? v : 0 });
  });
  const compOut = h('p', { class: 'setting-hint pedal-comp', 'aria-live': 'polite' });

  // Sample rate: applies on the next start (the audio context cannot change rate).
  const rateSeg = own(createSegmented(ctx, rigBinding(rig, 'sampleRate', { label: 'Sample rate', default: 'auto' }), {
    label: 'Sample rate', size: 'sm', options: SAMPLE_RATE_OPTIONS,
  }));
  const rateOut = h('p', { class: 'setting-hint pedal-rate', 'aria-live': 'polite' });
  const reloadBtn = h('button', { type: 'button', class: 'btn btn--sm', hidden: true, html: icon('rotate') + '<span>Reload now</span>', dataset: { tip: 'Restart Oro with the new sample rate. The session is saved first.' } });
  scope.on(reloadBtn, 'click', () => rig.reload());

  const pingGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'pedals-ping' },
    h('h3', { class: 'group-title', id: 'pedals-ping' }, 'Latency'),
    row('Ping', 'Plays a short chirp on the send with the music muted and times how long it takes to come back. Bypass delay, reverb and looper pedals first.', pingBtn),
    pingOut,
    row('Compensate', 'Sequencer and arp notes of parts through the pedals go out early by the round trip, so the pedal return lands on the grid. Send parts also delay their dry sound to match. Notes you play live cannot go out early.', compOn.el),
    row('Offset', 'Added to the measured round trip, in ms (use it alone if you cannot ping)', offsetIn),
    compOut,
    row('Sample rate', 'Match the audio device. The MPC XL runs at 44.1 kHz. Auto lets the browser choose. Applies after a restart.', rateSeg.el),
    rateOut, h('div', { class: 'btn-row' }, reloadBtn));

  root.append(sendGroup, retGroup, guitarGroup, pingGroup);
  appendMidi();

  // ================================================================ render
  function render() {
    const st = rig.status();
    const a = st.audio;
    const p = st.prefs;
    routeFacts.textContent = '';
    retFacts.textContent = '';
    const fact = (dl, k, v, good = true) => dl.append(h('dt', null, k), h('dd', { class: good ? 'is-good' : 'is-bad' }, v));
    if (a) {
      fact(routeFacts, 'Device outputs', String(a.supported.maxChannels || 2), (a.supported.maxChannels || 2) >= 4);
      if (!p.enabled) fact(routeFacts, 'Send', 'Off');
      else if (a.active) fact(routeFacts, 'Send', `Running on outputs ${a.sendChannels.map(c => c + 1).join(' and ')}`);
      else fact(routeFacts, 'Send', 'Switched off for now', false);
      const warn = !a.supported.chooseOutput ? 'This browser cannot choose an output device, so Oro uses the system default. Chrome, Edge and the desktop app can.' : (p.enabled && a.routing.reason) || st.lastError;
      routeWarn.hidden = !warn;
      routeWarn.lastChild.textContent = warn || '';
      const r = a.ret;
      if (!p.returnEnabled) fact(retFacts, 'Return', 'Off');
      else if (r.open) fact(retFacts, 'Return', r.muted ? 'Muted by the feedback guard' : 'Listening', !r.muted);
      else fact(retFacts, 'Return', r.reason ? 'Not open' : 'Waiting', false);
      if (r.settings && r.settings.sampleRate) fact(retFacts, 'Input rate', `${Math.round(r.settings.sampleRate / 100) / 10} kHz`);
      const msgs = [r.reason, r.muteReason, r.outsideReason, ...(r.warnings || [])].filter(Boolean);
      if (p.returnEnabled && !r.open && !r.reason) msgs.push('Press Reconnect to open the input (the browser may ask for permission).');
      if (!a.supported.capture) msgs.unshift('This browser cannot capture audio here.');
      retWarn.hidden = !msgs.length;
      retWarn.lastChild.textContent = msgs.join(' ');
      unmuteBtn.hidden = !r.muted;
      reconnectBtn.hidden = !p.returnEnabled || (r.open && !r.reason);
      guitarRow.hidden = !(a.guitar && a.guitar.on);
      pingBtn.disabled = !!a.pinging;
      for (const c of [mainPair, sendPair, ceiling]) c.setDisabled(!p.enabled, 'Turn on the pedal send first');
      deviceSel.disabled = !a.supported.chooseOutput;
      for (const c of [layout, retLevel, retDelay, retReverb]) c.setDisabled(!p.returnEnabled, 'Turn on the pedal return first');
      if (!a.supported.capture) retOn.setDisabled(!p.returnEnabled, 'This browser cannot capture audio here');
      buildChannel();
      const g = a.guitar || {};
      const open = !!(r.open && p.returnEnabled);
      for (const c of [gMode, gGate]) c.setDisabled(!p.guitarNotes, 'Turn on Guitar plays notes first');
      const chords = p.guitarMode === 'chords';
      gBends.setDisabled(!p.guitarNotes || chords, chords ? 'Bends are available in Single mode' : 'Turn on Guitar plays notes first');
      setText(gModeHint, chords
        ? 'Chords are experimental and respond more slowly than Single. Low notes may take longer. Not tested with a real guitar yet.'
        : 'Single follows one note with bends and vibrato. Chords is an experimental option for several notes at once.');
      const capBusy = !!g.capturing;
      capBtn.disabled = !open || capBusy;
      capBtn.dataset.tip = open ? 'Record one held note' : 'Turn on the pedal return first';
      renderGuitarPitch(st);
    }
    renderComp(st);
  }
  function renderComp(st) {
    const p = st.prefs;
    const c = st.compensation;
    const sr = st.sampleRate;
    if (document.activeElement !== offsetIn) offsetIn.value = String(p.compOffsetMs);
    offsetIn.disabled = !p.compensate;
    if (!c || !c.on) setText(compOut, 'Compensation is off: parts through the pedals are heard a round trip late.');
    else if (!(c.ms > 0)) setText(compOut, 'Compensating 0 ms. Press Ping, or type an offset.');
    else if (!c.applied) setText(compOut, `Compensating ${fmtMs(c.ms)} once the pedal send is running.`);
    else setText(compOut, `Compensating ${fmtMs(c.ms)}: Insert and Send parts' sequenced notes go out ${fmtMs(c.ms)} early, and Send parts' dry sound waits ${fmtMs(c.ms)}.`);
    if (sr) {
      const khz = (hz) => `${Math.round(hz / 100) / 10} kHz`;
      const now = sr.running ? `Running at ${khz(sr.running)}.` : 'Audio is not running.';
      let msg = now;
      if (sr.pending) msg = `${now} The new setting (${sr.want ? khz(sr.want) : 'Auto'}) applies after a restart.`;
      else if (sr.refused) msg = `${now} The browser did not accept ${khz(sr.want)}.`;
      setText(rateOut, msg);
      reloadBtn.hidden = !sr.pending;
    }
  }
  const invalidate = () => schedule(render);
  scope.add(rig.on('change', invalidate));
  render();

  // ================================================================ MIDI pedals
  function appendMidi() {
    const midi = ctx.midi;
    const outSel = h('select', { class: 'select-native', 'aria-label': 'MIDI output for the pedals' });
    const outWrap = h('div', { class: 'select' }, outSel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
    function fillMidiOuts() {
      outSel.textContent = '';
      outSel.appendChild(h('option', { value: '' }, 'Same as MIDI & MPC output'));
      for (const o of (call(midi, 'outputs') || [])) outSel.appendChild(h('option', { value: o.id }, o.name || 'MIDI output'));
      const want = rig.prefs.midiOutputId || '';
      if (![...outSel.options].some(o => o.value === want)) outSel.appendChild(h('option', { value: want }, 'Saved output (not connected)'));
      outSel.value = want;
    }
    fillMidiOuts();
    if (midi && typeof midi.on === 'function') {
      const off = midi.on('change', () => schedule(fillMidiOuts));
      if (typeof off === 'function') scope.add(off);
    }
    scope.on(outSel, 'change', () => rig.set({ midiOutputId: outSel.value }));
    const recallPatches = own(createToggle(ctx, rigBinding(rig, 'patchesRecallPedals', { label: 'Patches recall pedal presets', default: 0 }), {
      label: 'Patches recall pedal presets', className: 'toggle--switch',
    }));
    const midiWarn = h('p', { class: 'status-warn', hidden: true }, h('span', { html: icon('warn'), 'aria-hidden': 'true' }), h('span'));
    const cards = h('div', { class: 'pedal-cards' });
    const group = h('section', { class: 'settings-group', 'aria-labelledby': 'pedals-midi' },
      h('h3', { class: 'group-title', id: 'pedals-midi' }, 'Pedal MIDI'),
      h('p', { class: 'setting-hint' }, h('strong', null, 'Why these pedals?'), ' These are the ones I have.'),
      h('p', { class: 'setting-hint' }, `Profiles for the pedals that take MIDI. Suggested route: ${MIDI_ROUTES.mpcA}; ${MIDI_ROUTES.mpcB}.`),
      row('MIDI output', 'Connect MIDI in MIDI & MPC first', outWrap),
      row('Patches recall pedal presets', 'Off by default, so loading a patch someone shared never changes your pedals. Scenes always send their pedal presets to the pedals switched on here.', recallPatches.el),
      midiWarn, cards,
      h('p', { class: 'setting-hint' }, `Audio loop only (no MIDI): ${AUDIO_ONLY_PEDALS.map(p => p.name).join(', ')}.`));
    root.appendChild(group);

    const renders = [];
    for (const id of PEDAL_IDS) renders.push(pedalCard(id, cards));
    function renderMidi() {
      const st = rig.status();
      const msgs = [];
      if (!st.midi.available) msgs.push('MIDI is not available here, so pedal profiles cannot send anything.');
      else if (st.midi.status !== 'ready') msgs.push('MIDI is not connected yet. Press Connect MIDI in Settings > MIDI & MPC.');
      for (const c of st.conflicts) msgs.push(c.message);
      if (st.midi.lastError) msgs.push(`Last MIDI problem: ${st.midi.lastError}.`);
      midiWarn.hidden = !msgs.length;
      midiWarn.lastChild.textContent = msgs.join(' ');
      for (const r of renders) r();
    }
    scope.add(rig.on('change', () => schedule(renderMidi)));
    renderMidi();
  }

  function pedalCard(id, parent) {
    const p = PEDAL_PROFILES[id];
    const use = own(createToggle(ctx, pedalBinding(rig, id, 'enabled', { label: `Use ${p.name}`, default: 0 }), { label: `Use ${p.name}`, className: 'toggle--switch' }));
    const chan = own(createSelect(ctx, pedalBinding(rig, id, 'channel', { label: 'MIDI channel', default: p.channel }), { label: `${p.name} MIDI channel`, options: CHANNELS, className: 'select--sm' }));
    const btn = (label, iconName, fn, tip) => {
      const b = h('button', { type: 'button', class: 'btn btn--sm', html: icon(iconName) + `<span>${label}</span>`, dataset: tip ? { tip } : undefined });
      scope.on(b, 'click', () => {
        const r = fn();
        if (r && !r.ok) ctx.toast(r.reason || 'Could not send that to the pedal', { kind: 'error' });
        else if (r && r.unconfirmed) ctx.toast(`Sent. ${p.name}'s value meaning for this switch is not confirmed yet.`, { kind: 'info' });
      });
      return b;
    };
    const actions = h('div', { class: 'pedal-actions' });
    const actionBtns = [];
    if (engageControl(p)) {
      actionBtns.push(btn('Effect on', 'check', () => rig.pedalAction(id, 'on')), btn('Bypass', 'close', () => rig.pedalAction(id, 'bypass')));
    }
    if (tapControl(p)) actionBtns.push(btn('Tap tempo', 'bolt', () => rig.pedalAction(id, 'tap'), 'Four taps at the current tempo'));
    let progInput = null;
    if (p.programs) {
      progInput = h('input', { type: 'number', class: 'field pedal-program', min: String(p.programs.min), max: String(p.programs.max), step: '1', value: String(p.programs.min), 'aria-label': `${p.name} preset number` });
      actionBtns.push(progInput, btn('Send preset', 'scene', () => rig.pedalAction(id, 'program', Number(progInput.value)), `Program Change: ${programHint(id)}`));
    }
    actions.append(...actionBtns);
    const mods = Array.from({ length: MOD_SLOTS }, (_, slot) => modSlot(id, slot, p));
    const notes = [...(p.notes || [])];
    if (p.defaultChannelNote) notes.push(p.defaultChannelNote);
    const unconfirmed = p.controls.filter(c => c.encodingVerified === false).map(c => c.label);
    if (unconfirmed.length) notes.push(`Value meaning not confirmed yet: ${unconfirmed.join(', ')}.`);
    if (p.cv) notes.push(p.cv.note);
    const body = h('div', { class: 'pedal-body' },
      h('div', { class: 'pedal-line' }, h('span', { class: 'mini-label' }, 'Channel'), chan.el),
      ...mods.map(m => m.el),
      actions,
      notes.length ? h('ul', { class: 'pedal-notes' }, notes.map(n => h('li', null, n))) : null);
    const card = h('article', { class: 'pedal-card', 'aria-label': p.name },
      h('header', { class: 'pedal-head' },
        h('span', { class: 'pedal-icon', html: icon('pedal'), 'aria-hidden': 'true' }),
        h('div', { class: 'pedal-titles' }, h('div', { class: 'pedal-name' }, p.name), h('div', { class: 'setting-hint' }, p.connector)),
        use.el),
      body);
    parent.appendChild(card);
    return () => {
      const on = !!rig.prefs.pedals[id].enabled;
      card.classList.toggle('is-off', !on);
      chan.setDisabled(!on, `Turn on ${p.name} first`);
      for (const m of mods) m.render(on);
      for (const b of actionBtns) b.disabled = !on;
    };
  }

  /**
   * One modulated control: Source (Off / Macro 1-4 / Guitar level / LFO) and
   * the control it moves, its range and curve, and for LFO the shape, rate
   * (Hz or tempo-synced) and depth. CCs go out only on change, at most about
   * 100 a second per pedal.
   */
  function modSlot(id, slot, p) {
    const b = (key, def) => modBinding(rig, id, slot, key, def);
    const name = `${p.name} modulation ${slot + 1}`;
    const src = own(createSelect(ctx, b('source', { label: 'Source', default: '' }), {
      label: `${name} source`, className: 'select--sm', options: MOD_SOURCES.map(m => ({ value: m.id, label: m.label })),
    }));
    const ctrlOptions = p.controls.filter(c => c.kind !== 'trigger').map(c => ({ value: c.id, label: `${c.label} (CC ${c.cc})` }));
    const ctl = own(createSelect(ctx, b('control', { label: 'Control', default: '' }), {
      label: `${name} control to move`, className: 'select--sm', options: [{ value: '', label: 'Choose a control' }, ...ctrlOptions],
    }));
    const slider = (key, label, def, extra = {}) => own(createMiniSlider(ctx, b(key, { label, default: def, min: extra.min ?? 0, max: extra.max ?? 1, curve: extra.curve, hint: extra.hint }), {
      ariaLabel: `${name} ${label.toLowerCase()}`, className: 'pedal-mod-slider', format: extra.format || fmtPct,
    }));
    const min = slider('min', 'Min', 0, { hint: 'Value sent when the source is at its lowest. Set it above Max to invert.' });
    const max = slider('max', 'Max', 1, { hint: 'Value sent when the source is at its highest' });
    const curve = own(createSelect(ctx, b('curve', { label: 'Curve', default: 0 }), {
      label: `${name} curve`, className: 'select--sm pedal-mod-curve', options: MAP_CURVES.map((n, i) => ({ value: i, label: n })),
    }));
    const shape = own(createSelect(ctx, b('lfoShape', { label: 'Shape', default: 'sine' }), {
      label: `${name} LFO shape`, className: 'select--sm', options: LFO_SHAPES.map(s => ({ value: s, label: cap(s) })),
    }));
    const sync = own(createSegmented(ctx, b('lfoSync', { label: 'Rate mode', default: 0 }), {
      label: `${name} LFO rate in Hz or synced to the tempo`, size: 'sm', options: [{ value: 0, label: 'Hz' }, { value: 1, label: 'Tempo' }],
    }));
    const rate = slider('lfoRate', 'Rate', 0.5, { min: LFO_RATE_MIN, max: LFO_RATE_MAX, curve: 'exp', format: fmtHz, hint: 'LFO speed in cycles per second' });
    const rateOut = h('span', { class: 'mini-label pedal-mod-value', 'aria-hidden': 'true' });
    const beats = own(createSelect(ctx, b('lfoBeats', { label: 'Length', default: 4 }), {
      label: `${name} LFO length`, className: 'select--sm', options: LFO_BEAT_OPTIONS,
    }));
    const depth = slider('lfoDepth', 'Depth', 1, { hint: 'How much of the range the LFO sweeps, around the middle' });
    const label = (t) => h('span', { class: 'mini-label' }, t);
    const rangeLine = h('div', { class: 'pedal-line' }, label('Range'), min.el, max.el, curve.el);
    const lfoLine = h('div', { class: 'pedal-line' }, label('LFO'), shape.el, sync.el);
    const rateLine = h('div', { class: 'pedal-line' }, label('Rate'), rate.el, rateOut, beats.el, label('Depth'), depth.el);
    const warn = h('p', { class: 'pedal-mod-warn', hidden: true });
    const el = h('div', { class: 'pedal-mod', role: 'group', 'aria-label': name },
      h('div', { class: 'pedal-line' }, label(`Mod ${slot + 1}`), src.el, ctl.el),
      rangeLine, lfoLine, rateLine, warn);
    const all = [src, ctl, min, max, curve, shape, sync, rate, beats, depth];
    function render(on) {
      const m = rig.prefs.pedals[id].mods[slot];
      const isLfo = m.source === 'lfo';
      rangeLine.hidden = !m.source;
      lfoLine.hidden = !isLfo;
      rateLine.hidden = !isLfo;
      rate.el.hidden = !!m.lfoSync;
      rateOut.hidden = !!m.lfoSync;
      setText(rateOut, fmtHz(m.lfoRate));
      beats.el.hidden = !m.lfoSync;
      for (const c of all) c.setDisabled(!on, `Turn on ${p.name} first`);
      const earlier = rig.prefs.pedals[id].mods.slice(0, slot).some(o => o.source && o.control && o.control === m.control);
      let msg = '';
      if (m.source && !m.control) msg = 'Choose the control to move.';
      else if (m.source && earlier) msg = 'An earlier Mod already moves this control, so this one is ignored.';
      warn.hidden = !msg;
      warn.textContent = msg;
    }
    return { el, render };
  }

  return { el: root, dispose };
}
