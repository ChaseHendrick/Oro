// Settings > MIDI & MPC: connection status, inputs with live activity, output,
// channel / pad / velocity options, clock (one master only), the Q-Link learn
// wizard, the mapping table and the Akai MPC XL setup guide.

import { NUM_PARTS, PART_PARAM_MAP, GLOBAL_PARAM_MAP, NOTE_NAMES } from '../core/params.js';
import { h, createScope, setText, listen, call } from './dom.js';
import { createSegmented, createToggle, createSelect } from './controls.js';
import { icon } from './icons.js';
import { mpcGuide } from './mpc-guide.js';

const STATUS_TEXT = {
  idle: ['Not connected yet', 'Press Connect MIDI and allow access when your browser asks.'],
  connecting: ['Connecting...', 'Waiting for the browser to grant MIDI access.'],
  ready: ['MIDI is ready', 'Devices plugged in now will appear below automatically.'],
  denied: ['MIDI access was blocked', 'Allow MIDI for this site in your browser\'s site settings, then press Connect MIDI again.'],
  error: ['MIDI could not start', 'Something went wrong while opening MIDI. Try Connect MIDI again, or reconnect the device.'],
  unsupported: ['MIDI is not available here', 'Web MIDI works in Chrome, Edge and Opera, and in the Orograph desktop app. Safari does not support it, and Firefox only with permission.'],
};

const CHANNELS = Array.from({ length: 16 }, (_, i) => ({ value: i + 1, label: `Ch ${i + 1}` }));

export function noteLabel(n) {
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1} (${n})`;
}

export function describeTarget(t, store) {
  if (!t) return 'Unknown';
  const def = t.scope === 'global' ? GLOBAL_PARAM_MAP[t.id] : PART_PARAM_MAP[t.id];
  const label = def ? def.label : t.id;
  if (t.scope === 'global') return `${label} (global)`;
  if (t.part === 'sel' || t.part == null) return `${label} (selected part)`;
  const name = store ? store.get(`parts.${t.part}.name`) : null;
  return `${label} (${name || `Part ${Number(t.part) + 1}`})`;
}

/** A binding (see bind.js) over one MIDI setting. */
function settingBinding(midi, key, def) {
  return {
    def: { id: key, ...def }, id: key, scope: 'midi',
    part: () => null, path: () => `midi.${key}`, modPath: () => null, learnTarget: () => null,
    get() { const s = call(midi, 'getSettings') || {}; return s[key] ?? def.default; },
    set(v) { call(midi, 'setSetting', key, v); },
    reset() { call(midi, 'setSetting', key, def.default); },
    subscribe(fn) { return listen(midi, 'change', fn); },
  };
}

/** Binding for one entry of an array setting (multiChannels[i], outChannels[i]). */
function arrayItemBinding(midi, key, index, def) {
  return {
    ...settingBinding(midi, key, def),
    get() { const s = call(midi, 'getSettings') || {}; const arr = s[key] || []; return arr[index] ?? index + 1; },
    set(v) {
      const s = call(midi, 'getSettings') || {};
      const arr = Array.isArray(s[key]) ? [...s[key]] : [1, 2, 3, 4];
      arr[index] = Number(v);
      call(midi, 'setSetting', key, arr);
    },
  };
}

export function createMidiSettings(ctx) {
  const scope = createScope();
  const { midi, store } = ctx;
  const root = h('div', { class: 'settings-midi' });

  // ------------------------------------------------------------ status card
  const statusTitle = h('div', { class: 'status-title' });
  const statusText = h('p', { class: 'status-text' });
  const facts = h('dl', { class: 'status-facts' });
  const connectBtn = h('button', { type: 'button', class: 'btn btn--primary', html: icon('midi') + '<span>Connect MIDI</span>' });
  const panicBtn = h('button', { type: 'button', class: 'btn btn--ghost', html: icon('panic') + '<span>Panic</span>', dataset: { tip: 'Stop every note here and on connected devices' } });
  const mpcBadge = h('span', { class: 'badge badge--mpc', hidden: true, html: icon('mpc') + '<span>Akai MPC detected</span>' });
  const statusCard = h('section', { class: 'status-card', 'aria-live': 'polite' },
    h('div', { class: 'status-icon', html: icon('midi') }),
    h('div', { class: 'status-main' }, h('div', { class: 'status-row' }, statusTitle, mpcBadge), statusText, facts),
    h('div', { class: 'status-actions' }, connectBtn, panicBtn));
  root.appendChild(statusCard);

  const supported = !!midi && midi.supported !== false;
  scope.on(connectBtn, 'click', async () => {
    if (!midi) return;
    connectBtn.disabled = true;
    try { await call(midi, 'connect'); } catch (err) { console.warn('[ui] MIDI connect failed', err); }
    connectBtn.disabled = false;
    renderAll();
  });
  scope.on(panicBtn, 'click', () => ctx.panic());

  // ------------------------------------------------------------ sections
  const body = h('div', { class: 'midi-sections' });
  root.appendChild(body);
  if (!supported) {
    body.appendChild(h('p', { class: 'settings-note' }, 'You can still play with the on-screen keyboard and your computer keyboard. MIDI settings will appear here when MIDI is available.'));
  }

  const devices = h('section', { class: 'settings-group', 'aria-labelledby': 'midi-devices' });
  const inputsList = h('ul', { class: 'device-list', 'aria-label': 'MIDI inputs' });
  const outputSelectWrap = h('div', { class: 'select' });
  const outputSelect = h('select', { class: 'select-native', 'aria-label': 'MIDI output' });
  outputSelectWrap.append(outputSelect, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  scope.on(outputSelect, 'change', () => call(midi, 'setSetting', 'outputId', outputSelect.value === 'auto' ? 'auto' : (outputSelect.value || null)));
  devices.append(
    h('h3', { class: 'group-title', id: 'midi-devices' }, 'Devices'),
    h('div', { class: 'mini-label' }, 'Inputs'), inputsList,
    h('div', { class: 'setting-row' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'Output'), h('div', { class: 'setting-hint' }, 'Where notes and clock are sent')), outputSelectWrap));

  // Routing
  const S = (key, def) => settingBinding(midi, key, def);
  const channelMode = createSegmented(ctx, S('channelMode', { label: 'Channels', default: 'omni' }), { label: 'Channel mode', options: [{ value: 'omni', label: 'Omni' }, { value: 'multi', label: 'Multi' }], size: 'sm' });
  const omniTarget = createSelect(ctx, S('omniTarget', { label: 'Plays', default: 'sel' }), {
    label: 'Omni target', className: 'select--sm',
    options: [{ value: 'sel', label: 'Selected part' }, ...Array.from({ length: NUM_PARTS }, (_, i) => ({ value: i, label: `Part ${i + 1}` }))],
  });
  const multiRow = h('div', { class: 'channel-grid' });
  const outRow = h('div', { class: 'channel-grid' });
  for (let i = 0; i < NUM_PARTS; i++) {
    const inSel = createSelect(ctx, arrayItemBinding(midi, 'multiChannels', i, { label: `Part ${i + 1} channel`, default: i + 1 }), { label: `Part ${i + 1} input channel`, options: CHANNELS, className: 'select--sm' });
    const outSel = createSelect(ctx, arrayItemBinding(midi, 'outChannels', i, { label: `Part ${i + 1} out`, default: i + 1 }), { label: `Part ${i + 1} output channel`, options: CHANNELS, className: 'select--sm' });
    scope.add(inSel.dispose); scope.add(outSel.dispose);
    multiRow.appendChild(h('div', { class: 'channel-cell' }, h('span', { class: 'mini-label' }, `Part ${i + 1}`), inSel.el));
    outRow.appendChild(h('div', { class: 'channel-cell' }, h('span', { class: 'mini-label' }, `Part ${i + 1}`), outSel.el));
  }
  const padMode = createSegmented(ctx, S('padMode', { label: 'Pads', default: 'notes' }), { label: 'Pad mode', options: [{ value: 'notes', label: 'Notes' }, { value: 'scale', label: 'Scale' }], size: 'sm' });
  const padBase = createSelect(ctx, S('padBaseNote', { label: 'Base note', default: 36 }), {
    label: 'Pad base note', className: 'select--sm', options: Array.from({ length: 128 }, (_, i) => ({ value: i, label: noteLabel(i) })),
  });
  const padLearn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('learn') + '<span>Learn</span>', dataset: { tip: 'Hit your lowest pad to set the base note' } });
  padLearn.hidden = typeof midi?.learnPadBase !== 'function';
  scope.on(padLearn, 'click', async () => {
    if (padLearn.classList.contains('is-learning')) return;
    padLearn.classList.add('is-learning');
    padLearn.querySelector('span').textContent = 'Hit a pad...';
    let note = null;
    try { note = await midi.learnPadBase(); } catch { note = null; }
    padLearn.classList.remove('is-learning');
    padLearn.querySelector('span').textContent = 'Learn';
    if (note != null) ctx.toast(`Pad base note set to ${noteLabel(note)}`, { kind: 'success' });
  });
  const velCurve = createSegmented(ctx, S('velocityCurve', { label: 'Velocity', default: 'linear' }), {
    label: 'Velocity curve', size: 'sm', options: [{ value: 'soft', label: 'Soft' }, { value: 'linear', label: 'Linear' }, { value: 'hard', label: 'Hard' }],
  });
  const sendNotes = createToggle(ctx, { ...S('sendNotes', { label: 'Send notes', default: false }), get: () => !!(call(midi, 'getSettings') || {}).sendNotes, set: v => call(midi, 'setSetting', 'sendNotes', !!v) }, { label: 'Send notes to the output', className: 'toggle--switch' });
  const progChange = createToggle(ctx, { ...S('programChange', { label: 'Program change', default: false }), get: () => !!(call(midi, 'getSettings') || {}).programChange, set: v => call(midi, 'setSetting', 'programChange', !!v) }, { label: 'Program change selects patches', className: 'toggle--switch' });
  const follow = createToggle(ctx, {
    ...S('followClock', { label: 'Follow clock', default: false }),
    get: () => !!(call(midi, 'getSettings') || {}).followClock,
    set: (v) => { if (v) call(midi, 'setSetting', 'sendClock', false); call(midi, 'setSetting', 'followClock', !!v); },
  }, { label: 'Follow MPC clock', className: 'toggle--switch' });
  const sendClock = createToggle(ctx, {
    ...S('sendClock', { label: 'Send clock', default: false }),
    get: () => !!(call(midi, 'getSettings') || {}).sendClock,
    set: (v) => { if (v) call(midi, 'setSetting', 'followClock', false); call(midi, 'setSetting', 'sendClock', !!v); },
  }, { label: 'Send clock to MPC', className: 'toggle--switch' });
  const clockStatus = h('p', { class: 'setting-hint clock-status' });
  const mpe = createToggle(ctx, { ...S('mpe', { label: 'MPE', default: false }), get: () => !!(call(midi, 'getSettings') || {}).mpe, set: v => call(midi, 'setSetting', 'mpe', !!v) }, { label: 'MPE', className: 'toggle--switch' });
  scope.add(mpe.dispose);
  const mpeRow = h('div', { class: 'setting-row' },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'MPE'), h('div', { class: 'setting-hint' }, 'For MPE controllers (lower zone): per-note bend, slide and pressure. Leave it off for an MPC.')), mpe.el);
  for (const c of [channelMode, omniTarget, padMode, padBase, velCurve, sendNotes, progChange, follow, sendClock]) scope.add(c.dispose);

  const row = (label, hint, control, cls = '') => h('div', { class: ['setting-row', cls] },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'setting-hint' }, hint) : null), control);

  const omniRow = row('Omni plays', 'Every channel goes to this part', omniTarget.el);
  const multiBlock = h('div', { class: 'setting-block' }, h('div', { class: 'setting-hint' }, 'Each part listens on its own channel'), multiRow);
  const routing = h('section', { class: 'settings-group', 'aria-labelledby': 'midi-routing' },
    h('h3', { class: 'group-title', id: 'midi-routing' }, 'Input'),
    row('Channels', 'Omni: any channel plays one part. Multi: one channel per part.', channelMode.el),
    omniRow, multiBlock,
    row('MPC pads', 'Notes plays what the pads send. Scale maps pads to the global key, from the base note.', padMode.el),
    row('Pad base note', 'The note your lowest pad sends', h('div', { class: 'inline-controls' }, padBase.el, padLearn)),
    row('Velocity curve', 'Soft makes gentle playing louder; Hard needs a firmer touch', velCurve.el),
    row('Program change', 'Program change messages step through patches', progChange.el),
    mpeRow);
  const outBlock = h('div', { class: 'setting-block' }, h('div', { class: 'setting-hint' }, 'Output channel per part (match your MPC tracks)'), outRow);
  const output = h('section', { class: 'settings-group', 'aria-labelledby': 'midi-output' },
    h('h3', { class: 'group-title', id: 'midi-output' }, 'Output'),
    row('Send notes', 'Play the MPC (or any synth) from Orograph\'s keyboard, sequencer and arp', sendNotes.el),
    outBlock);
  const clock = h('section', { class: 'settings-group', 'aria-labelledby': 'midi-clock' },
    h('h3', { class: 'group-title', id: 'midi-clock' }, 'Clock'),
    h('div', { class: 'callout' }, h('span', { html: icon('info') }), h('span', null, 'Only one device should be the clock master. If both send clock, the tempo fights, so turning one of these on turns the other off.')),
    row('Follow MPC clock', 'The MPC sets the tempo and starts / stops Orograph', follow.el),
    row('Send clock to MPC', 'Orograph sets the tempo. On the MPC set Sync Receive to MIDI Clock.', sendClock.el),
    clockStatus);

  // ------------------------------------------------------------ Q-Link wizard
  const wizard = h('section', { class: 'settings-group', 'aria-labelledby': 'midi-qlink' });
  const wizardBody = h('div', { class: 'wizard' });
  const startWizard = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('learn') + '<span>Start Q-Link learn</span>' });
  wizard.append(h('h3', { class: 'group-title', id: 'midi-qlink' }, 'Q-Link learn'),
    h('p', { class: 'setting-hint' }, 'Map the MPC\'s 16 Q-Link knobs to the selected part in one pass. Each step waits for whatever CC arrives. Any other knob in Orograph can be learned too: right-click it and choose MIDI Learn.'),
    startWizard, wizardBody);
  scope.on(startWizard, 'click', () => runWizard());

  let wizardState = null;
  function stopWizard() {
    if (!wizardState) return;
    wizardState.cancelled = true;
    call(midi, 'cancelLearn');
    wizardState = null;
    wizardBody.textContent = '';
    startWizard.hidden = false;
    renderMappings();
  }
  function runWizard() {
    const targets = call(midi, 'qlinkTargets') || [];
    if (!targets.length) { ctx.toast('No Q-Link targets are available', { kind: 'warn' }); return; }
    startWizard.hidden = true;
    wizardState = { i: 0, targets, cancelled: false, got: [] };
    step();
  }
  function step() {
    const st = wizardState;
    if (!st) return;
    if (st.i >= st.targets.length) { finish(); return; }
    const t = st.targets[st.i];
    const tgt = t.target || t;
    const label = describeTarget(tgt, store);
    const status = h('div', { class: 'wizard-status is-waiting' }, h('span', { class: 'learn-pulse', 'aria-hidden': 'true' }), 'Waiting for a knob...');
    const back = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', disabled: st.i === 0 }, 'Back');
    const skip = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Skip');
    const done = h('button', { type: 'button', class: 'btn btn--sm' }, 'Done');
    const dots = h('div', { class: 'wizard-dots', 'aria-hidden': 'true' }, st.targets.map((_, k) => h('span', { class: ['wizard-dot', k < st.i && 'is-done', k === st.i && 'is-current', st.got[k] === 'skip' && 'is-skipped'] })));
    wizardBody.textContent = '';
    wizardBody.append(
      h('div', { class: 'wizard-step', role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'wizard-count' }, `Q-Link ${st.i + 1} of ${st.targets.length}`),
        h('div', { class: 'wizard-prompt' }, `Twist Q-Link ${st.i + 1} now`),
        h('div', { class: 'wizard-target' }, h('span', { class: 'mini-label' }, 'Will control'), h('strong', null, label)),
        status),
      dots,
      h('div', { class: 'wizard-actions' }, back, skip, h('span', { class: 'spacer' }), done));
    const myIndex = st.i;
    back.addEventListener('click', () => { call(midi, 'cancelLearn'); st.i = Math.max(0, st.i - 1); step(); });
    skip.addEventListener('click', () => { call(midi, 'cancelLearn'); st.got[myIndex] = 'skip'; st.i += 1; step(); });
    done.addEventListener('click', () => finish());
    let p;
    try { p = midi.learn(tgt); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then((m) => {
      if (!wizardState || wizardState !== st || st.i !== myIndex || st.cancelled) return;
      st.got[myIndex] = m;
      status.className = 'wizard-status is-done';
      status.innerHTML = '';
      status.append(h('span', { html: icon('check') }), `Got CC ${m && m.cc != null ? m.cc : '?'}${m && m.channel ? ` on channel ${m.channel}` : ''}`);
      setTimeout(() => { if (wizardState === st && st.i === myIndex) { st.i += 1; step(); } }, 650);
    }).catch(() => { /* cancelled or skipped */ });
  }
  function finish() {
    const st = wizardState;
    const n = st ? st.got.filter(g => g && g !== 'skip').length : 0;
    stopWizard();
    ctx.toast(n ? `Mapped ${n} Q-Link${n === 1 ? '' : 's'}` : 'Q-Link learn finished', { kind: n ? 'success' : 'info' });
  }
  scope.add(stopWizard);

  // ------------------------------------------------------------ mappings
  const mapTable = h('div', { class: 'map-table', role: 'table', 'aria-label': 'MIDI mappings' });
  const clearAll = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', html: icon('trash') + '<span>Clear all</span>' });
  const mappings = h('section', { class: 'settings-group', 'aria-labelledby': 'midi-maps' },
    h('div', { class: 'group-head' }, h('h3', { class: 'group-title', id: 'midi-maps' }, 'Mappings'), clearAll),
    mapTable);
  scope.on(clearAll, 'click', () => {
    if (!clearAll.classList.contains('is-confirm')) {
      clearAll.classList.add('is-confirm');
      clearAll.innerHTML = '<span>Really clear all?</span>';
      setTimeout(() => { clearAll.classList.remove('is-confirm'); clearAll.innerHTML = icon('trash') + '<span>Clear all</span>'; }, 3000);
      return;
    }
    call(midi, 'clearMappings');
    ctx.bus.emit('mappings');
    renderMappings();
  });
  function renderMappings() {
    const list = call(midi, 'mappings') || [];
    mapTable.textContent = '';
    clearAll.disabled = !list.length;
    if (!list.length) {
      mapTable.appendChild(h('p', { class: 'settings-note' }, 'No mappings yet. Use the Q-Link wizard, or right-click any knob and choose MIDI Learn.'));
      return;
    }
    mapTable.appendChild(h('div', { class: 'map-row map-row--head', role: 'row' },
      h('span', { role: 'columnheader' }, 'CC'), h('span', { role: 'columnheader' }, 'Channel'), h('span', { role: 'columnheader' }, 'Controls'), h('span', { role: 'columnheader' }, h('span', { class: 'visually-hidden' }, 'Remove'))));
    for (const m of list) {
      const rm = h('button', { type: 'button', class: 'icon-btn icon-btn--xs', 'aria-label': `Remove mapping for CC ${m.cc}`, html: icon('close') });
      rm.addEventListener('click', () => { call(midi, 'unmap', m.target || m.cc); ctx.bus.emit('mappings'); renderMappings(); });
      mapTable.appendChild(h('div', { class: 'map-row', role: 'row' },
        h('span', { role: 'cell', class: 'mono' }, String(m.cc)), h('span', { role: 'cell' }, m.channel ? String(m.channel) : 'Any'),
        h('span', { role: 'cell' }, describeTarget(m.target, store)), h('span', { role: 'cell' }, rm)));
    }
  }

  // ------------------------------------------------------------ guide
  const guide = mpcGuide();
  const guideEl = h('section', { class: 'settings-group guide', 'aria-labelledby': 'midi-guide' },
    h('h3', { class: 'group-title', id: 'midi-guide' }, h('span', { html: icon('mpc') }), 'Akai MPC XL setup'),
    h('p', { class: 'setting-hint' }, guide.intro),
    ...guide.sections.map((sec, i) => h('details', { class: 'guide-step', open: i === 0 },
      h('summary', null, h('span', { class: 'guide-num' }, String(i + 1)), h('span', null, sec.title || `Step ${i + 1}`)),
      h('ol', { class: 'guide-list' }, sec.steps.map(st => h('li', null,
        h('span', { class: 'guide-text' }, st.text),
        st.detail ? h('span', { class: 'guide-detail' }, st.detail) : null))),
      sec.checks && sec.checks.length ? h('div', { class: 'guide-checks' },
        h('div', { class: 'mini-label' }, 'If nothing happens'),
        h('ul', null, sec.checks.map(c => h('li', null, c)))) : null)));

  if (supported) body.append(devices, routing, output, clock, wizard, mappings);
  body.appendChild(guideEl);

  // ------------------------------------------------------------ render
  const portLeds = new Map();
  function renderDevices() {
    const ins = call(midi, 'inputs') || [];
    const outs = call(midi, 'outputs') || [];
    inputsList.textContent = '';
    portLeds.clear();
    if (!ins.length) inputsList.appendChild(h('li', { class: 'device-empty' }, midi && midi.status === 'ready' ? 'No MIDI inputs found. Plug a device in; it will appear here.' : 'Connect MIDI to see your devices.'));
    for (const p of ins) {
      const led = h('span', { class: 'led port-led', 'aria-hidden': 'true' });
      portLeds.set(p.id, led);
      portLeds.set(p.name, led);
      const tg = h('button', { type: 'button', class: ['toggle', 'toggle--switch', p.enabled !== false && 'is-on'], 'aria-pressed': String(p.enabled !== false), 'aria-label': `Use input ${p.name}` }, h('span', { class: 'toggle-text' }, p.enabled !== false ? 'On' : 'Off'));
      tg.addEventListener('click', () => call(midi, 'setInputEnabled', p.id, p.enabled === false));
      inputsList.appendChild(h('li', { class: ['device', p.state === 'disconnected' && 'is-gone'] },
        led, h('span', { class: 'device-text' }, h('span', { class: 'device-name' }, p.name || 'Unnamed device'), h('span', { class: 'device-meta' }, [p.manufacturer, p.state === 'disconnected' ? 'disconnected' : ''].filter(Boolean).join(' · '))),
        p.isMpc ? h('span', { class: 'badge badge--mpc', html: icon('mpc') + '<span>MPC</span>' }) : null, tg));
    }
    const s = call(midi, 'getSettings') || {};
    outputSelect.textContent = '';
    const autoName = s.outputAuto && midi.output ? midi.output.name : '';
    if ('outputAuto' in s) outputSelect.appendChild(h('option', { value: 'auto' }, autoName ? `Automatic: ${autoName}` : 'Automatic (finds an MPC)'));
    outputSelect.appendChild(h('option', { value: '' }, 'None'));
    for (const o of outs) outputSelect.appendChild(h('option', { value: o.id }, `${o.name}${o.isMpc ? '  (MPC)' : ''}`));
    outputSelect.value = s.outputAuto ? 'auto' : (s.outputId && outs.some(o => o.id === s.outputId) ? s.outputId : '');
    outputSelect.disabled = !outs.length && !('outputAuto' in s);
    mpcBadge.hidden = ![...ins, ...outs].some(p => p.isMpc);
  }
  function renderStatus() {
    const st = !midi ? 'unsupported' : midi.supported === false ? 'unsupported' : (midi.status || 'idle');
    const [title, text] = STATUS_TEXT[st] || STATUS_TEXT.idle;
    setText(statusTitle, title);
    const moduleText = midi && typeof midi.statusText === 'function' ? call(midi, 'statusText') : '';
    statusText.textContent = (st === 'error' || st === 'denied') && moduleText ? moduleText
      : st === 'error' && midi && midi.error ? `${text} (${String(midi.error.message || midi.error).slice(0, 120)})` : text;
    if (midi && midi.secure === false) statusText.textContent = 'MIDI needs a secure page. Open Orograph over https, from localhost, or use the desktop app.';
    statusCard.dataset.status = st;
    const secure = midi ? midi.secure !== false : (typeof isSecureContext === 'boolean' ? isSecureContext : true);
    facts.textContent = '';
    const fact = (k, v, good) => facts.append(h('dt', null, k), h('dd', { class: good ? 'is-good' : 'is-bad' }, v));
    fact('Web MIDI', midi && midi.supported !== false ? 'Supported' : 'Not supported', midi && midi.supported !== false);
    fact('Secure page', secure ? 'Yes' : 'No (needs https or localhost)', secure);
    connectBtn.hidden = !midi || midi.supported === false || st === 'ready';
    connectBtn.querySelector('span').textContent = st === 'denied' || st === 'error' ? 'Try again' : 'Connect MIDI';
    panicBtn.disabled = !ctx.engine && !midi;
  }
  function renderRouting() {
    const s = call(midi, 'getSettings') || {};
    mpeRow.hidden = !('mpe' in s);
    const multi = s.channelMode === 'multi';
    omniRow.hidden = multi;
    multiBlock.hidden = !multi;
    outBlock.hidden = !s.sendNotes;
    const clockInfo = midi && midi.externalClock;
    clockStatus.textContent = s.followClock
      ? (clockInfo && clockInfo.active ? `Following external clock at ${Math.round(clockInfo.bpm || 0)} BPM` : 'Waiting for clock from the MPC. Press Play on the MPC.')
      : s.sendClock ? 'Sending clock to the selected output.' : 'Clock is off. Orograph runs on its own tempo.';
  }
  function renderAll() {
    renderStatus();
    if (supported) { renderDevices(); renderRouting(); renderMappings(); }
  }
  if (midi) {
    scope.add(listen(midi, 'change', () => { if (root.isConnected) renderAll(); }));
    scope.add(listen(midi, 'clock', () => { if (root.isConnected) renderRouting(); }));
    scope.add(listen(midi, 'activity', (a) => {
      const led = a && (portLeds.get(a.port) || portLeds.get(a.portId) || (a.dir === 'in' && portLeds.size === 2 ? [...portLeds.values()][0] : null));
      if (!led) return;
      led.classList.add('is-on');
      clearTimeout(led._t);
      led._t = setTimeout(() => led.classList.remove('is-on'), 90);
    }));
  }
  renderAll();

  return { el: root, dispose: scope.dispose };
}

