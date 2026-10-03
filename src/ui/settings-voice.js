// Settings > Voice (v1.4): the microphone (which input, Enable, Mic Cleanup,
// mono or stereo, input gain with a meter and clip light, Monitor with the
// headphones hint), the optional processing (high-pass, compressor,
// de-esser), a compact voice strip (level, pan, delay and reverb sends), and
// the musical uses: Voice plays notes, Capture to a wavetable terrain and the
// Voice Level meter. Everything goes through ctx.voice (src/ui/voice-rig.js);
// without it the pane explains why.

import { h, createScope, setText } from './dom.js';
import { createSegmented, createToggle, createSelect, createMiniSlider } from './controls.js';
import { schedule, addLoop } from './frame.js';
import { icon } from './icons.js';
import {
  MONITOR_OPTIONS, CHANNEL_OPTIONS, VOICE_CAPTURE_SLOTS, INPUT_GAIN_MIN_DB, INPUT_GAIN_MAX_DB, VOICE_LEVEL_MAX,
  VOICE_GATE_DB, VOICE_GATE_MIN_DB, VOICE_GATE_MAX_DB, voiceTargets, MIC_WHY, HEADPHONES_HINT,
} from '../audio/voice-core.js';
import { MAX_PARTS } from '../core/params.js';
import { partCount } from '../core/tracks.js';
import { noteLabel } from './pedal-rig.js';

const row = (label, hint, control, cls = '') => h('div', { class: ['setting-row', cls] },
  h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'setting-hint' }, hint) : null), control);

/** A binding (see bind.js) over one voice setting. */
function voiceBinding(rig, key, def) {
  return {
    def: { id: key, label: def.label, default: def.default, curve: def.curve || 'lin', min: def.min ?? 0, max: def.max ?? 1, options: def.options, hint: def.hint },
    id: key, scope: 'voice', part: () => null, path: () => `voice.${key}`, modPath: () => null, learnTarget: () => null,
    get: () => rig.prefs[key],
    set: (v) => { rig.set({ [key]: v }); },
    reset() { rig.set({ [key]: def.default }); },
    subscribe: (fn) => rig.on('change', fn),
  };
}

const fmtDb = (v) => `${v > 0 ? '+' : ''}${(Math.round(v * 2) / 2).toFixed(1)} dB`;
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtPan = (v) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`);

export function createVoiceSettings(ctx) {
  const scope = createScope();
  const rig = ctx.voice || null;
  const root = h('div', { class: 'settings-voice' });
  const dispose = () => scope.dispose();
  const own = (c) => { scope.add(c.dispose); return c; };
  const bind = (key, label, def, extra = {}) => voiceBinding(rig, key, { label, default: def, ...extra });

  root.appendChild(h('div', { class: 'callout' }, h('span', { html: icon('info') }), h('span', null, MIC_WHY)));

  if (!rig || !rig.supported) {
    root.appendChild(h('p', { class: 'settings-note' }, 'Voice input needs Web Audio, which is not running in this browser. Everything else in Oro works as usual.'));
    return { el: root, dispose };
  }

  // ================================================================ microphone
  const enable = own(createToggle(ctx, bind('enabled', 'Voice', 0), { label: 'Voice', className: 'toggle--switch' }));
  const inputSel = h('select', { class: 'select-native', 'aria-label': 'Microphone' });
  const inputWrap = h('div', { class: 'select' }, inputSel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  const refreshIn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', html: icon('rotate') + '<span>Refresh</span>', dataset: { tip: 'List the microphones again (names appear once the browser may use the microphone)' } });
  scope.on(inputSel, 'change', () => rig.set({ deviceId: inputSel.value }));
  scope.on(refreshIn, 'click', () => fillInputs());
  async function fillInputs() {
    let list = [];
    try { list = (await rig.listInputs()) || []; } catch { list = []; }
    inputSel.textContent = '';
    inputSel.appendChild(h('option', { value: '' }, 'System default microphone'));
    for (const d of list) if (d.deviceId && d.deviceId !== 'default') inputSel.appendChild(h('option', { value: d.deviceId }, d.label || 'Microphone'));
    const want = rig.prefs.deviceId || '';
    if (![...inputSel.options].some(o => o.value === want)) inputSel.appendChild(h('option', { value: want }, 'Saved microphone (not connected)'));
    inputSel.value = want;
  }
  fillInputs();
  const cleanup = own(createToggle(ctx, bind('cleanup', 'Mic Cleanup', 0), { label: 'Mic Cleanup', ariaLabel: 'Mic Cleanup', className: 'toggle--switch' }));
  const channels = own(createSegmented(ctx, bind('channels', 'Channels', 'mono'), { label: 'Microphone channels', size: 'sm', options: CHANNEL_OPTIONS }));
  const gainSl = own(createMiniSlider(ctx, bind('inputGainDb', 'Input gain', 0, { min: INPUT_GAIN_MIN_DB, max: INPUT_GAIN_MAX_DB }), {
    ariaLabel: 'Input gain', className: 'pedal-slider', format: fmtDb, bipolar: false,
  }));
  const meterFill = h('span', { class: 'pedal-meter-fill' });
  const meter = h('span', { class: 'pedal-meter voice-meter', role: 'presentation' }, meterFill);
  const clipLight = h('span', { class: 'voice-clip', role: 'status', 'aria-label': 'Clip light: off', dataset: { tip: 'Lights when the input clips' } }, 'Clip');
  const monitorSeg = own(createSegmented(ctx, bind('monitor', 'Monitor', 'auto'), { label: 'Monitor', size: 'sm', options: MONITOR_OPTIONS }));
  const monitorOut = h('p', { class: 'setting-hint voice-monitor', 'aria-live': 'polite' });
  const warn = h('p', { class: 'status-warn', hidden: true }, h('span', { html: icon('warn'), 'aria-hidden': 'true' }), h('span'));
  const facts = h('dl', { class: 'status-facts status-facts--wide' });
  const unmuteBtn = h('button', { type: 'button', class: 'btn btn--sm', hidden: true, html: icon('speaker') + '<span>Unmute</span>' });
  const retryBtn = h('button', { type: 'button', class: 'btn btn--sm', hidden: true, html: icon('rotate') + '<span>Try again</span>' });
  scope.on(unmuteBtn, 'click', () => rig.resetGuard());
  scope.on(retryBtn, 'click', async () => {
    retryBtn.disabled = true;
    try { await ctx.startAudio?.(); await rig.reconnect(); } finally { retryBtn.disabled = false; fillInputs(); }
  });
  // Turning Voice on is the gesture the browser's permission prompt needs; start the audio with it.
  scope.on(enable.el, 'click', () => { if (ctx.startAudio) ctx.startAudio().catch?.(() => {}); }, { capture: true });

  const micGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'voice-mic' },
    h('h3', { class: 'group-title', id: 'voice-mic' }, 'Microphone'),
    h('p', { class: 'setting-hint' }, 'Not tested with a real microphone yet.'),
    row('Voice', 'Hear a microphone (a laptop\'s own is fine) in the master with the synth. The browser asks for permission the first time.', enable.el),
    row('Input', 'Echo cancellation, noise suppression and auto gain are off for the best sound', h('div', { class: 'inline-controls' }, inputWrap, refreshIn), 'setting-row--stack'),
    row('Mic Cleanup', 'Turns on the browser\'s noise suppression and echo cancellation. Helps a laptop mic with the laptop speakers playing, but dulls the sound: leave it off with headphones or a good microphone.', cleanup.el),
    row('Channels', 'Mono uses input 1 (where interfaces put the first microphone). Stereo keeps both sides.', channels.el),
    row('Input gain', 'Sing your loudest: the meter should stay out of the clip light', h('div', { class: 'inline-controls voice-gain' }, gainSl.el, meter, clipLight), 'setting-row--stack'),
    row('Monitor', `Hear yourself. Auto turns it on only with headphones or an audio interface. ${HEADPHONES_HINT}`, monitorSeg.el),
    monitorOut, warn, facts, h('div', { class: 'btn-row' }, unmuteBtn, retryBtn));

  // ================================================================ processing
  const hp = own(createToggle(ctx, bind('highpass', 'High-pass 80 Hz', 0), { label: 'High-pass 80 Hz', className: 'toggle--switch' }));
  const comp = own(createToggle(ctx, bind('compressor', 'Compressor', 0), { label: 'Compressor', className: 'toggle--switch' }));
  const deess = own(createToggle(ctx, bind('deesser', 'De-esser', 0), { label: 'De-esser', className: 'toggle--switch' }));
  const procGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'voice-proc' },
    h('h3', { class: 'group-title', id: 'voice-proc' }, 'Processing'),
    h('p', { class: 'setting-hint' }, 'All off by default, so the voice is exactly what the microphone hears.'),
    row('High-pass 80 Hz', 'Removes rumble, handling noise and pops below the voice', hp.el),
    row('Compressor', 'Gentle (2.5:1): evens out loud and quiet words', comp.el),
    row('De-esser', 'Tames sharp "s" and "t" sounds above about 5.5 kHz', deess.el));

  // ================================================================ strip
  const slider = (key, label, max, def, format, extra = {}) => own(createMiniSlider(ctx, bind(key, label, def, { min: extra.min ?? 0, max }), { ariaLabel: label, className: 'pedal-slider', format, ...extra.opts }));
  const levelSl = slider('level', 'Voice level', VOICE_LEVEL_MAX, 1, (v) => (v > 0 ? fmtDb(20 * Math.log10(v)) : 'Off'));
  const panSl = slider('pan', 'Voice pan', 1, 0, fmtPan, { min: -1, opts: { bipolar: true } });
  const delaySl = slider('delay', 'Voice to delay', 1, 0, fmtPct);
  const reverbSl = slider('reverb', 'Voice to reverb', 1, 0, fmtPct);
  const stripGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'voice-strip' },
    h('h3', { class: 'group-title', id: 'voice-strip' }, 'Voice strip'),
    h('p', { class: 'setting-hint' }, 'The voice joins the master like a track, so the looper records and overdubs it and Resample can turn a vocal loop into a terrain. With Monitor off you do not hear it, but the looper still records it.'),
    row('Level', null, levelSl.el),
    row('Pan', null, panSl.el),
    row('Delay send', null, delaySl.el),
    row('Reverb send', null, reverbSl.el));

  // ================================================================ musical
  const notesOn = own(createToggle(ctx, bind('notes', 'Voice plays notes', 0), { label: 'Voice plays notes', className: 'toggle--switch' }));
  const target = own(createSelect(ctx, bind('target', 'Voice track', 'sel'), { label: 'Track the voice plays', options: voiceTargets(MAX_PARTS) }));
  // Only tracks that exist can be picked.
  const renderTargets = () => {
    const n = partCount(ctx.store);
    for (const o of target.select.options) { const i = Number(o.value); if (Number.isInteger(i)) { o.hidden = i >= n; o.disabled = i >= n; } }
  };
  if (ctx.store) {
    scope.add(ctx.store.subscribe('parts', (path) => { if (path === '' || path === 'parts') renderTargets(); }));
    renderTargets();
  }
  const gate = own(createMiniSlider(ctx, bind('gateDb', 'Gate', VOICE_GATE_DB, { min: VOICE_GATE_MIN_DB, max: VOICE_GATE_MAX_DB }), {
    ariaLabel: 'Voice gate', className: 'pedal-slider', format: (v) => `${Math.round(v)} dB`,
  }));
  const bends = own(createToggle(ctx, bind('bends', 'Bends as pitch bend', 1), { label: 'Bends as pitch bend', className: 'toggle--switch' }));
  const pitchOut = h('p', { class: 'setting-hint guitar-pitch', 'aria-live': 'off' });
  const capSlot = own(createSegmented(ctx, bind('captureSlot', 'Capture into', 'A'), { label: 'Capture into terrain slot', size: 'sm', options: VOICE_CAPTURE_SLOTS }));
  const capBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('wave') + '<span>Capture</span>' });
  const capFill = h('span', { class: 'pedal-meter-fill' });
  const capMeter = h('span', { class: 'pedal-meter', role: 'progressbar', 'aria-label': 'Capture progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, capFill);
  const capOut = h('p', { class: 'setting-hint guitar-capture', 'aria-live': 'polite' });
  scope.on(capBtn, 'click', async () => {
    capBtn.disabled = true;
    try {
      await ctx.startAudio?.();
      const r = await rig.captureNote();
      if (r && r.ok && ctx.toast) ctx.toast(`Captured ${r.name} into track ${r.part + 1}, slot ${r.slot}`, { kind: 'info' });
    } finally {
      renderCapture();
      invalidate();
    }
  });
  function renderCapture() {
    const c = rig.status().capture;
    const busy = !!c && (c.stage === 'recording' || c.stage === 'analysing');
    capMeter.hidden = !busy;
    const pct = c ? Math.round((c.progress || 0) * 100) : 0;
    capFill.style.transform = `scaleX(${busy ? (c.progress || 0).toFixed(3) : 0})`;
    capMeter.setAttribute('aria-valuenow', String(pct));
    if (!c) setText(capOut, 'Press Capture, then sing or hum one steady note (little vibrato) for about three seconds.');
    else if (c.stage === 'recording') setText(capOut, `Recording: hold one note (${pct}%)...`);
    else if (c.stage === 'analysing') setText(capOut, 'Finding the pitch and building the terrain...');
    else if (c.stage === 'done') setText(capOut, `Captured ${noteLabel(c.note)} (${c.freq.toFixed(1)} Hz), ${c.frames} frames, now on track ${c.part + 1}, slot ${c.slot}.`);
    else setText(capOut, c.reason || 'The capture did not work.');
    capOut.classList.toggle('is-bad', !!c && c.stage === 'error');
  }
  scope.add(rig.on('capture', () => schedule(renderCapture)));
  scope.add(rig.on('pitch', (p) => schedule(() => { if (rig.prefs.notes) setText(pitchOut, p ? `Hearing ${noteLabel(p.midi)} (${p.freq.toFixed(1)} Hz)` : 'Hearing no clear pitch'); })));
  renderCapture();
  const levelFill = h('span', { class: 'pedal-meter-fill' });
  const levelMeter = h('span', { class: 'pedal-meter', role: 'presentation' }, levelFill);
  scope.add(rig.on('level', (e) => schedule(() => { levelFill.style.transform = `scaleX(${Math.max(0, Math.min(1, (e && e.level) || 0)).toFixed(3)})`; })));

  const musicGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'voice-music' },
    h('h3', { class: 'group-title', id: 'voice-music' }, 'Sing to play'),
    row('Voice plays notes', 'Sing or hum single notes to play a track, like a keyboard (MIDI out too). Works best with Monitor off or headphones.', notesOn.el),
    row('Track', 'The track the voice plays and Capture fills. Selected track follows the track you are editing.', target.el),
    row('Gate', 'Notes start above this level and stop below it. Raise it if room noise or breaths play notes.', gate.el),
    row('Bends as pitch bend', 'Slides and vibrato move the track\'s pitch bend within its Bend range. Off: a slide steps to the next note.', bends.el),
    pitchOut,
    row('Capture', 'Records one sung note and turns it into a wavetable terrain on the voice\'s track', h('div', { class: 'inline-controls' }, capSlot.el, capBtn), 'setting-row--stack'),
    capMeter, capOut,
    row('Voice level', 'How loud you sing, as the Voice Level source in every track\'s Links (for example Voice Level to Morph)', levelMeter));

  root.append(micGroup, procGroup, stripGroup, musicGroup);

  // ================================================================ meter
  let clipOn = null;
  scope.add(addLoop(() => {
    const m = rig.meter();
    meterFill.style.transform = `scaleX(${(m.pos || 0).toFixed(3)})`;
    const on = !!m.clip;
    if (on !== clipOn || (on && clipLight.dataset.kind !== m.clipKind)) {
      clipOn = on;
      clipLight.classList.toggle('is-on', on);
      clipLight.dataset.kind = m.clipKind || '';
      clipLight.setAttribute('aria-label', on ? (m.clipKind === 'input' ? 'Clip light: the microphone is clipping, lower its level in the system sound settings' : 'Clip light: turn the input gain down') : 'Clip light: off');
      clipLight.dataset.tip = on && m.clipKind === 'input' ? 'The microphone itself is clipping: lower its level in the system sound settings or on the interface' : on ? 'Turn the input gain down' : 'Lights when the input clips';
    }
  }));

  // ================================================================ render
  function render() {
    const st = rig.status();
    const a = st.audio || {};
    const p = st.prefs;
    facts.textContent = '';
    const fact = (k, v, good = true) => facts.append(h('dt', null, k), h('dd', { class: good ? 'is-good' : 'is-bad' }, v));
    if (!p.enabled) fact('Voice', 'Off');
    else if (a.open) fact('Voice', a.muted ? 'Muted by the feedback guard' : (st.monitor.on ? 'Listening, monitored' : 'Listening, not monitored'), !a.muted);
    else fact('Voice', a.reason ? 'Not open' : 'Opening...', false);
    if (a.open && a.settings) {
      const s = a.settings;
      if (s.sampleRate) fact('Rate', `${Math.round(s.sampleRate / 100) / 10} kHz`);
      if (s.sampleSize) fact('Bits', String(s.sampleSize));
      if (s.channelCount) fact('Channels', String(s.channelCount));
      if (a.label) fact('Microphone', a.label);
    }
    const msgs = [a.reason, a.muteReason, ...(a.warnings || [])].filter(Boolean);
    if (p.enabled && !a.open && !a.reason) msgs.push('Waiting for the microphone (the browser may be asking for permission).');
    if (!p.enabled && st.permission === 'denied') msgs.push('Microphone access is blocked for this page. Allow it in the browser or system settings, then turn Voice on.');
    if (a.supported && !a.supported.capture) msgs.unshift('This browser cannot use a microphone here.');
    warn.hidden = !msgs.length;
    warn.lastChild.textContent = msgs.join(' ');
    unmuteBtn.hidden = !a.muted;
    retryBtn.hidden = !p.enabled || (a.open && !a.reason);
    const m = st.monitor;
    if (!p.enabled) setText(monitorOut, m.on ? 'The voice will be monitored.' : (m.hint || 'The voice will not be monitored.'));
    else setText(monitorOut, m.on ? (m.hint || 'Monitoring: you hear yourself with the synth.') : (m.hint || 'Not monitored: the looper still records the voice.'));
    monitorOut.classList.toggle('is-bad', !!(m.on && m.hint));
    const open = !!(a.open && p.enabled);
    for (const c of [gate, bends]) c.setDisabled(!p.notes, 'Turn on Voice plays notes first');
    capBtn.disabled = !open || !!a.capturing;
    capBtn.dataset.tip = open ? 'Record one sung note' : 'Turn on Voice first';
    if (!p.notes) setText(pitchOut, '');
    else if (!open) setText(pitchOut, 'Waiting for the microphone.');
    else if (!a.tracking) setText(pitchOut, 'Starting the pitch tracker...');
    else if (!pitchOut.textContent || /Waiting|Starting/.test(pitchOut.textContent)) setText(pitchOut, 'Listening to your voice.');
    if (!open) meterFill.style.transform = 'scaleX(0)';
  }
  const invalidate = () => schedule(render);
  scope.add(rig.on('change', invalidate));
  render();
  // Device names (and Monitor: Auto) may have changed since the pane was last open.
  rig.refresh().then(() => { fillInputs(); invalidate(); }).catch(() => {});

  return { el: root, dispose };
}
