// Operator panel (v2.9): Settings > Operator, plus the parts that keep
// running while Settings is closed (Real drops on motion sensors, the slow
// on-screen damage hint and Bookkeeping).
//
// The switches live in the session as `operator` (src/dsp/damage.js has the
// clean form and the DSP); Drop it, Spill, Repair and the test tones are
// engine actions. Everything starts off, and while it is off nothing runs.

import { h, createScope, listen, has, call } from './dom.js';
import { createToggle, createMiniSlider, createSegmented } from './controls.js';
import { OPERATOR_DEFAULTS, sanitizeOperator } from '../dsp/damage.js';
import { createBookkeeping, formatPlayTime } from '../core/bookkeeping.js';

const JOLT = 25;            // m/s^2 beyond gravity that counts as a drop
const JOLT_COOLDOWN = 2000; // ms between two detected drops
const pct = (v) => `${Math.round(v * 100)}%`;

export const SERVICE_TONE_BUTTONS = [
  { id: 'sine', label: 'Sine 1 kHz', hint: '1 kHz sine at -18 dBFS on both speakers' },
  { id: 'pink', label: 'Pink noise', hint: 'Pink noise at about -20 dBFS on both speakers' },
  { id: 'left', label: 'Left only', hint: 'Pink noise on the left speaker only' },
  { id: 'right', label: 'Right only', hint: 'Pink noise on the right speaker only' },
  { id: 'polarity', label: 'Polarity pulse', hint: 'A short positive pulse twice a second on both speakers' },
];

const readOp = (store) => sanitizeOperator(store.get('operator')) || OPERATOR_DEFAULTS;
function writeOp(store, patch) {
  store.set('operator', sanitizeOperator({ ...readOp(store), ...patch }) || undefined, { source: 'ui' });
}
function onOp(store, fn) {
  const a = store.subscribe('operator', fn);
  const b = store.subscribe('', (path) => { if (path === '') fn(); });
  return () => { a(); b(); };
}

function opBinding(ctx, key, label, extra = {}) {
  const { store } = ctx;
  return {
    def: { id: key, label, default: OPERATOR_DEFAULTS[key], min: 0, max: 1, ...extra },
    id: key, scope: 'operator', part: () => null, path: () => `operator.${key}`,
    get: () => readOp(store)[key],
    set: (v) => writeOp(store, { [key]: v }),
    reset: () => writeOp(store, { [key]: OPERATOR_DEFAULTS[key] }),
    subscribe: (fn) => onOp(store, fn),
    modPath: () => null, learnTarget: () => null,
  };
}

/** One MIDI message -> a short plain description. */
export function describeMidi(bytes) {
  const [st = 0, d1 = 0, d2 = 0] = bytes || [];
  const ch = (st & 0x0f) + 1;
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const note = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
  switch (st & 0xf0) {
    case 0x90: return d2 > 0 ? `Note on, ch ${ch}, ${note(d1)}, velocity ${d2}` : `Note off, ch ${ch}, ${note(d1)}`;
    case 0x80: return `Note off, ch ${ch}, ${note(d1)}`;
    case 0xb0: return `CC ${d1} = ${d2}, ch ${ch}`;
    case 0xe0: return `Pitch bend ${((d2 << 7) | d1) - 8192}, ch ${ch}`;
    case 0xd0: return `Channel pressure ${d1}, ch ${ch}`;
    case 0xa0: return `Poly pressure ${note(d1)} ${d2}, ch ${ch}`;
    case 0xc0: return `Program ${d1 + 1}, ch ${ch}`;
    default:
      if (st === 0xfa) return 'Start';
      if (st === 0xfb) return 'Continue';
      if (st === 0xfc) return 'Stop';
      if (st === 0xf0) return `System exclusive, ${(bytes || []).length} bytes`;
      return 'System message';
  }
}
const hex = (bytes) => (bytes || []).slice(0, 6).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') + ((bytes || []).length > 6 ? ' ...' : '');

// ---- background host ---------------------------------------------------------

const CRACKS = [
  'M0 120 L70 150 L95 210 L160 230 L190 300', 'M95 210 L60 260 L72 330', 'M160 230 L230 215 L290 250',
  'M1000 40 L930 90 L910 160 L850 190', 'M910 160 L950 230 L940 300', 'M930 90 L870 70',
];
const DROPS = [[120, 80, 14], [300, 160, 9], [520, 60, 18], [700, 140, 11], [860, 300, 15], [210, 420, 12], [640, 380, 20], [420, 520, 10], [900, 520, 13], [80, 560, 16]];

/**
 * Starts the parts of the Operator panel that run with Settings closed.
 * Returns { bookkeeping, motion, dispose }.
 */
export function startOperatorHost(ctx) {
  const { store, engine, root } = ctx;
  const scope = createScope();
  const book = createBookkeeping();
  book.add('sessions', 1);
  book.flush();

  // Bookkeeping: time with audio running, notes started, patches saved
  let lastNotes = engine ? engine.notesPlayed || 0 : 0;
  let ticks = 0;
  const tick = setInterval(() => {
    const running = !!(engine && engine.context && engine.context.state === 'running');
    if (running) book.add('seconds', 1);
    const n = engine ? engine.notesPlayed || 0 : 0;
    if (n > lastNotes) book.add('notes', n - lastNotes);
    lastNotes = n;
    if (++ticks % 15 === 0) book.flush();
  }, 1000);
  scope.add(() => clearInterval(tick));
  const flush = () => book.flush();
  if (typeof window !== 'undefined') {
    scope.on(window, 'pagehide', flush);
    scope.on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  }
  if (ctx.presets && has(ctx.presets, 'on')) {
    scope.add(ctx.presets.on('change', (d) => { if (d && d.kind === 'patch' && d.action === 'save') { book.add('patches', 1); book.flush(); } }));
  }
  scope.add(flush);

  // A slow, static damage hint over the screen (never flashes)
  let overlay = null;
  if (root && typeof document !== 'undefined') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = (cls, kids) => {
      const s = document.createElementNS(ns, 'svg');
      s.setAttribute('class', cls); s.setAttribute('viewBox', '0 0 1000 600'); s.setAttribute('preserveAspectRatio', 'none');
      for (const k of kids) s.appendChild(k);
      return s;
    };
    const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const cracks = svg('op-cracks', CRACKS.map(d => el('path', { d, 'vector-effect': 'non-scaling-stroke' })));
    const drops = svg('op-drops', DROPS.map(([cx, cy, r]) => el('ellipse', { cx, cy, rx: r, ry: r * 1.25 })));
    overlay = h('div', { class: 'op-overlay', 'aria-hidden': 'true' }, cracks, drops);
    root.appendChild(overlay);
    scope.add(() => overlay.remove());
  }
  let lastShown = 0;
  const show = (force = false) => {
    if (!overlay) return;
    const t = Date.now();
    if (!force && t - lastShown < 1000) return;
    lastShown = t;
    const o = readOp(store);
    const st = (engine && call(engine, 'operatorState')) || { dmg: 0, wet: 0 };
    const crack = o.visual && o.drop ? Math.min(0.45, st.dmg * 0.6) : 0;
    const wet = o.visual && o.water ? Math.min(0.4, st.wet * 0.5) : 0;
    overlay.style.setProperty('--op-crack', crack.toFixed(2));
    overlay.style.setProperty('--op-wet', wet.toFixed(2));
    overlay.hidden = crack === 0 && wet === 0;
  };
  if (engine) scope.add(listen(engine, 'tele', () => show()));
  scope.add(onOp(store, () => { syncMotion(); show(true); }));

  // Real drops: a hard jolt on a device with motion sensors counts as a drop
  const MotionEvt = typeof window !== 'undefined' ? window.DeviceMotionEvent : undefined;
  const motion = {
    supported: typeof MotionEvt === 'function',
    needsPermission: typeof MotionEvt === 'function' && typeof MotionEvt.requestPermission === 'function',
    granted: !(typeof MotionEvt === 'function' && typeof MotionEvt.requestPermission === 'function'),
    listening: false,
    readings: 0,
    async request() {
      if (!motion.needsPermission) return motion.granted;
      try { motion.granted = (await MotionEvt.requestPermission()) === 'granted'; } catch { motion.granted = false; }
      syncMotion();
      return motion.granted;
    },
  };
  let lastJolt = 0;
  const onMotion = (e) => {
    const a = e.acceleration, g = e.accelerationIncludingGravity;
    let mag = 0;
    if (a && Number.isFinite(a.x)) mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    else if (g && Number.isFinite(g.x)) mag = Math.abs(Math.hypot(g.x || 0, g.y || 0, g.z || 0) - 9.81);
    else return;
    motion.readings++;
    const t = Date.now();
    if (mag < JOLT || t - lastJolt < JOLT_COOLDOWN) return;
    lastJolt = t;
    call(engine, 'operator', 'drop', Math.min(1, 0.5 + (mag - JOLT) / 30));
    if (ctx.toast) ctx.toast('Drop detected', { kind: 'warn' });
  };
  function syncMotion() {
    const o = readOp(store);
    const want = motion.supported && motion.granted && o.drop === 1 && o.realDrops === 1;
    if (want && !motion.listening) { window.addEventListener('devicemotion', onMotion); motion.listening = true; }
    else if (!want && motion.listening) { window.removeEventListener('devicemotion', onMotion); motion.listening = false; }
  }
  syncMotion();
  scope.add(() => { if (motion.listening) window.removeEventListener('devicemotion', onMotion); motion.listening = false; });
  show(true);

  return { bookkeeping: book, motion, refresh: () => show(true), dispose: () => scope.dispose() };
}

// ---- Settings > Operator --------------------------------------------------------

export function createOperatorSettings(ctx) {
  const { store, engine } = ctx;
  const scope = createScope();
  const host = ctx.operator || null;
  const row = (label, hint, ...controls) => h('div', { class: 'setting-row' },
    h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'setting-hint' }, hint) : null),
    controls.length > 1 ? h('div', { class: 'btn-row op-controls' }, controls) : controls[0]);
  const toggle = (key, label, hint) => { const c = createToggle(ctx, opBinding(ctx, key, label, { hint }), { label, className: 'toggle--switch' }); scope.add(c.dispose); return c; };
  const slider = (key, label) => { const c = createMiniSlider(ctx, opBinding(ctx, key, label), { label, format: pct, className: 'op-slider' }); scope.add(c.dispose); return c; };
  const button = (label, aria) => h('button', { type: 'button', class: 'btn btn--sm', 'aria-label': aria || null }, label);
  const act = async (action, value) => { await ctx.startAudio?.(); call(engine, 'operator', action, value); setTimeout(() => { renderMeters(); host?.refresh?.(); }, 120); };
  const meter = (label) => {
    const fill = h('span', { class: 'op-meter-fill' });
    const text = h('span', { class: 'op-meter-text' }, '0%');
    const bar = h('div', { class: 'op-meter', role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
    return { el: h('div', { class: 'op-meter-row' }, bar, text), set(v) { const p = Math.round(v * 100); fill.style.width = `${p}%`; text.textContent = `${p}%`; bar.setAttribute('aria-valuenow', String(p)); } };
  };

  // Damage: drops
  const dropOn = toggle('drop', 'Drop damage', 'As if the synth fell on the floor');
  const dropSev = slider('dropSeverity', 'Drop severity');
  const dropBtn = button('Drop it', 'Drop the synth once');
  const dropFix = button('Repair', 'Repair the drop damage');
  const realOn = toggle('realDrops', 'Real drops');
  const realHint = h('div', { class: 'setting-hint', 'aria-live': 'polite' });
  const allowBtn = button('Allow motion sensor');
  allowBtn.hidden = true;
  const dmgMeter = meter('Drop damage');
  scope.on(dropBtn, 'click', () => act('drop', 1));
  scope.on(dropFix, 'click', () => act('repair', 'drop'));
  scope.on(allowBtn, 'click', async () => { if (host) await host.motion.request(); render(); });

  // Damage: water
  const waterOn = toggle('water', 'Water damage', 'As if a drink was spilled on it');
  const waterSev = slider('waterSeverity', 'Water severity');
  const spillBtn = button('Spill', 'Spill water on the synth once');
  const waterFix = button('Repair', 'Dry out and repair the water damage');
  const stays = toggle('staysWet', 'Stays wet');
  const hum = createSegmented(ctx, { ...opBinding(ctx, 'hum', 'Mains hum'), def: { id: 'hum', label: 'Mains hum', default: 50 } }, {
    label: 'Mains hum', size: 'sm', options: [{ value: 50, label: '50 Hz' }, { value: 60, label: '60 Hz' }],
  });
  scope.add(hum.dispose);
  const wetMeter = meter('Wetness');
  const visual = toggle('visual', 'Show on screen');
  scope.on(spillBtn, 'click', () => act('spill', 1));
  scope.on(waterFix, 'click', () => act('repair', 'water'));

  // Quirks and Vintage
  const glitch = toggle('glitch', 'Glitch');
  const glitchAmt = slider('glitchAmount', 'Glitch amount');
  const slow = toggle('slowdown', 'Slowdown');
  const slowAmt = slider('slowAmount', 'Slowdown amount');
  const vintage = toggle('vintage', 'Vintage sampler');

  // Service: test tones
  let tone = 'off';
  const toneBtns = SERVICE_TONE_BUTTONS.map(t => {
    const b = h('button', { type: 'button', class: 'btn btn--sm op-tone', 'aria-pressed': 'false', dataset: { tone: t.id, tip: t.hint } }, t.label);
    scope.on(b, 'click', () => setTone(tone === t.id ? 'off' : t.id));
    return b;
  });
  const stopBtn = button('Stop tone');
  scope.on(stopBtn, 'click', () => setTone('off'));
  function setTone(id) {
    tone = id;
    act('tone', id);
    for (const b of toneBtns) { const on = b.dataset.tone === id; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-on', on); }
    stopBtn.disabled = id === 'off';
  }
  stopBtn.disabled = true;
  scope.add(() => { if (tone !== 'off') call(engine, 'operator', 'tone', 'off'); });

  // Service: MIDI monitor
  const monList = h('ol', { class: 'op-monitor', 'aria-label': 'Last incoming MIDI messages, newest first' });
  const monEmpty = h('p', { class: 'setting-hint' });
  const midi = ctx.midi;
  const monitorOk = !!(midi && has(midi, 'on'));
  monEmpty.textContent = monitorOk ? 'Waiting for MIDI. Clock and active sensing are not listed.' : 'MIDI is not available in this browser.';
  const msgs = [];
  let monTimer = 0;
  const drawMonitor = () => {
    monTimer = 0;
    monList.textContent = '';
    for (const m of msgs) monList.append(h('li', null, h('span', { class: 'op-mon-text' }, m.text), h('span', { class: 'op-mon-hex' }, `${m.hex}${m.port ? `, ${m.port}` : ''}`)));
    monEmpty.hidden = msgs.length > 0;
  };
  if (monitorOk) {
    scope.add(listen(midi, 'monitor', (e) => {
      const b = e && e.bytes;
      if (!b || !b.length || b[0] === 0xf8 || b[0] === 0xfe) return;
      msgs.unshift({ text: describeMidi(b), hex: hex(b), port: e.port || '' });
      if (msgs.length > 20) msgs.length = 20;
      if (!monTimer) monTimer = setTimeout(drawMonitor, 100);
    }));
    scope.add(() => clearTimeout(monTimer));
  }

  // Bookkeeping
  const facts = h('dl', { class: 'status-facts status-facts--wide' });
  const resetBook = button('Reset counters');
  const renderBook = () => {
    facts.textContent = '';
    const b = host ? host.bookkeeping.get() : null;
    if (!b) { facts.append(h('dt', null, 'Counters'), h('dd', null, 'Not available')); return; }
    const fact = (k, v) => facts.append(h('dt', null, k), h('dd', null, v));
    fact('Time played', formatPlayTime(b.seconds));
    fact('Notes played', String(b.notes));
    fact('Sessions started', String(b.sessions));
    fact('Patches saved', String(b.patches));
    if (b.since) fact('Counting since', new Date(b.since).toLocaleDateString());
  };
  scope.on(resetBook, 'click', () => { if (!host) return; host.bookkeeping.reset(); renderBook(); ctx.toast?.('Counters reset', { kind: 'info' }); });
  resetBook.disabled = !host;
  const bookTimer = setInterval(renderBook, 5000);
  scope.add(() => clearInterval(bookTimer));

  function renderMeters() {
    const st = (engine && call(engine, 'operatorState')) || { dmg: 0, wet: 0 };
    dmgMeter.set(st.dmg || 0);
    wetMeter.set(st.wet || 0);
  }
  function render() {
    const o = readOp(store);
    const noEngine = !engine;
    for (const c of [dropSev, realOn]) c.setDisabled(!o.drop, 'Turn on Drop damage first');
    for (const c of [waterSev, stays, hum]) c.setDisabled(!o.water, 'Turn on Water damage first');
    glitchAmt.setDisabled(!o.glitch, 'Turn on Glitch first');
    slowAmt.setDisabled(!o.slowdown, 'Turn on Slowdown first');
    dropBtn.disabled = dropFix.disabled = !o.drop || noEngine;
    spillBtn.disabled = waterFix.disabled = !o.water || noEngine;
    const m = host && host.motion;
    allowBtn.hidden = !(m && m.supported && m.needsPermission && !m.granted && o.drop && o.realDrops);
    if (!m || !m.supported) realHint.textContent = 'Not available: this device or browser has no motion sensor, so use Drop it.';
    else if (m.needsPermission && !m.granted) realHint.textContent = 'This browser asks before sharing motion. Turn on Real drops, then Allow motion sensor.';
    else if (m.listening && m.readings === 0) realHint.textContent = 'Listening for a hard jolt. No motion readings yet: desktop computers usually have no motion sensor.';
    else realHint.textContent = 'A hard jolt of a phone or tablet counts as a drop.';
    renderMeters();
  }
  scope.add(onOp(store, render));
  if (engine) {
    let last = 0;
    scope.add(listen(engine, 'tele', () => { const t = Date.now(); if (t - last > 250) { last = t; renderMeters(); } }));
  }
  render();
  renderBook();
  drawMonitor();

  const group = (title, ...kids) => h('section', { class: 'settings-group' }, h('h3', { class: 'group-title' }, title), ...kids);
  const el = h('div', { class: 'settings-pane settings-operator' },
    h('p', { class: 'setting-hint op-intro' }, 'Hardware faults and quirks for the master output, saved with the session. Everything is off until you turn it on.'),
    group('Damage',
      row('Drop damage', 'Crackle, brief cutouts, one side dropping out, a scratchy control and a detuned, wobbly pitch. It builds up with every drop and stays until Repair.', dropOn.el),
      row('Severity', null, dropSev.el),
      row('Drop', null, dropBtn, dropFix),
      row('Damage', null, dmgMeter.el),
      h('div', { class: 'setting-row' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'Real drops'), realHint), h('div', { class: 'btn-row op-controls' }, realOn.el, allowBtn)),
      row('Water damage', 'A muffled tone, fizz and crackle, mains hum, short-outs and rare bursts of digital errors. It dries out over a few minutes.', waterOn.el),
      row('Severity', null, waterSev.el),
      row('Water', null, spillBtn, waterFix),
      row('Stays wet', 'On: it never dries out until you Repair it', stays.el),
      row('Mains hum', 'Match the mains frequency where you live', hum.el),
      row('Wetness', null, wetMeter.el),
      row('Show on screen', 'Faint cracks after a drop and droplets while wet. Nothing moves or flashes.', visual.el)),
    group('Quirks',
      row('Glitch', 'Now and then the output stutters, repeating a short slice', glitch.el),
      row('Amount', null, glitchAmt.el),
      row('Slowdown', 'Pitch sags when many notes sound, like an overloaded old machine', slow.el),
      row('Amount', null, slowAmt.el)),
    group('Vintage',
      row('Vintage sampler', 'An early sampler sound: 12-bit and about 26 kHz, with gentle filtering', vintage.el)),
    group('Service',
      h('p', { class: 'op-warn', role: 'note' }, 'Test tones play at -18 dBFS (sine) or about -20 dBFS (noise) before the master volume. Turn your speakers or headphones down before you start.'),
      h('div', { class: 'btn-row op-tones', role: 'group', 'aria-label': 'Test tones' }, toneBtns, stopBtn),
      h('h4', { class: 'op-subtitle' }, 'MIDI monitor'),
      monEmpty, monList),
    group('Bookkeeping',
      h('p', { class: 'setting-hint' }, 'Stored only in this browser. Nothing is sent anywhere.'),
      facts, h('div', { class: 'btn-row' }, resetBook)));
  return { el, dispose: () => scope.dispose() };
}
