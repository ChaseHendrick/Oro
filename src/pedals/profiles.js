// MIDI profiles for the owner's pedals, taken from docs/PEDALS.md and nothing
// else: every CC and Program Change number below appears in that document.
// Where the document names a control but not its value meaning, the control is
// flagged `encodingVerified: false` so the UI can say "unconfirmed" instead of
// pretending to know. Never add CC numbers here that the doc does not list;
// add them to docs/PEDALS.md first, with a source.
//
// Control kinds:
//   continuous  0..1 maps to 0..127 (or the control's lo..hi)
//   switch      on/off; `inverted: true` means 0-63 = on (the Purr-ting's On/Off)
//   trigger     momentary (tap, looper transport); sends `value` (default 127)
// `role: 'engage'` marks the switch that turns the effect on (true) or bypasses it (false).
//
// MIDI channels here are 1-based like the pedals' manuals; bytes use channel - 1.

export const CONTROL_KINDS = Object.freeze(['continuous', 'switch', 'trigger']);

const C = (id, label, cc, extra = {}) => Object.freeze({ id, label, cc, kind: 'continuous', ...extra });
const S = (id, label, cc, extra = {}) => Object.freeze({ id, label, cc, kind: 'switch', ...extra });
const T = (id, label, cc, extra = {}) => Object.freeze({ id, label, cc, kind: 'trigger', value: 127, ...extra });

const UNCONFIRMED_VALUE = 'Value meaning not confirmed for this pedal yet';

function profile(p) {
  if (p.channelVerified == null) p = { ...p, channelVerified: true };
  const controls = Object.freeze(p.controls.slice());
  return Object.freeze({
    custom: false,
    unverified: false,
    notes: [],
    ...p,
    controls,
    programs: p.programs ? Object.freeze({ ...p.programs }) : null,
  });
}

export const PURRTING = profile({
  id: 'purrting',
  name: 'OBNE Purr-ting',
  maker: 'Old Blood Noise Endeavors',
  firmware: 'Parting (assumed)',
  channel: 1,
  connector: '3.5 mm TRS Type A in/out (out is thru)',
  route: 'mpcA',
  controls: [
    C('expression', 'Expression', 11),
    C('rate', 'Rate', 14),
    C('depth', 'Depth', 15),
    C('shape', 'Shape', 16),
    C('dissolve', 'Dissolve', 17),
    C('chance', 'Chance', 18),
    C('smear', 'Smear', 19),
    C('glitch', 'Glitch', 20),
    C('time', 'Time', 21),
    C('filter', 'Filter', 22),
    C('mix', 'Mix', 23),
    C('volume', 'Volume', 27),
    // The doc is explicit: 0-63 = on. Everything else on the board uses the usual direction.
    S('onOff', 'On/Off', 85, { inverted: true, role: 'engage' }),
    T('tap', 'Tap', 86, { tap: true }),
  ],
  programs: { min: 1, max: 127, label: 'Presets' },
  notes: ['Assumes the Parting firmware; check the pedal before relying on the CC map.'],
});

export const LOST_AND_FOUND = profile({
  id: 'lostAndFound',
  name: 'Chase Bliss Lost + Found',
  maker: 'Chase Bliss',
  channel: 2,
  connector: '1/4" TRS MIDI (5-pin needs the Chase Bliss MIDIBox)',
  route: 'mpcB',
  controls: [
    C('timeL', 'L Time', 14),
    C('mix', 'Mix', 15),
    C('timeR', 'R Time', 16),
    C('modifyL', 'L Modify', 17),
    C('blend', 'Blend', 18),
    C('modifyR', 'R Modify', 19),
    C('ramp', 'Ramp', 20),
    S('dryKill', 'Dry Kill', 57, { encodingVerified: false, note: UNCONFIRMED_VALUE }),
    T('tap', 'Tap', 93, { tap: true }),
    C('expression', 'Expression', 100),
    S('footswitch1', 'Footswitch 1', 102, { encodingVerified: false, note: 'What it does depends on the pedal; ' + UNCONFIRMED_VALUE.toLowerCase() }),
    S('footswitch2', 'Footswitch 2', 103, { encodingVerified: false, note: 'What it does depends on the pedal; ' + UNCONFIRMED_VALUE.toLowerCase() }),
  ],
  // Only PC 0 (live) is documented; other numbers recall presets the owner has saved.
  programs: { min: 0, max: 127, label: 'Presets', special: { 0: 'Live' }, documented: [0] },
  cv: { minVolts: 0, maxVolts: 5, note: 'The EXP/CV jack takes 0-5 V CV on a floating-ring cable. It is the only pedal here that documents CV.' },
});

export const NUCLEO = profile({
  id: 'nucleo',
  name: 'Cornerstone Nucleo',
  maker: 'Cornerstone',
  // Placeholder: the doc gives no default channel. Not 1, because the Purr-ting
  // sits on channel 1 of the same TRS chain.
  channel: 4,
  channelVerified: false,
  connector: '3.5 mm TRS Type A (also MIDI over USB-C)',
  route: 'mpcA',
  unverified: true,
  controls: [
    // CC 0 is Bank Select in most MIDI gear, so a host may not pass it through untouched.
    S('bypass', 'Bypass', 0, { role: 'engage', encodingVerified: false, note: 'CC 0 doubles as Bank Select on most MIDI gear; check that the MPC passes it through. ' + UNCONFIRMED_VALUE + '.' }),
    C('channel', 'Channel', 5, { encodingVerified: false, note: UNCONFIRMED_VALUE }),
  ],
  programs: { min: 0, max: 127, label: 'Presets' },
  notes: ['Only CC 0 (bypass) and CC 5 (channel) are known. The rest of the CC chart is unverified, so it is left out.'],
  defaultChannelNote: 'The doc does not give the Nucleo a default channel. Channel 4 is a placeholder: set the pedal to it, or change it here.',
});

export const XERO = profile({
  id: 'xero',
  name: 'Walrus Xero Polylooper',
  maker: 'Walrus Audio',
  // Placeholder: the doc gives no default channel. It must differ from the
  // Purr-ting's channel 1 on the same chain, or CC 20-24 would hit both pedals.
  channel: 3,
  channelVerified: false,
  connector: '1/8" TRS Type A in/thru',
  route: 'mpcA',
  followsClock: true,
  controls: [
    C('volume1', 'Volume 1', 2),
    C('volume2', 'Volume 2', 3),
    C('speed1', 'Speed 1', 4, { encodingVerified: false, note: UNCONFIRMED_VALUE }),
    C('speed2', 'Speed 2', 5, { encodingVerified: false, note: UNCONFIRMED_VALUE }),
    S('direction1', 'Direction 1', 6, { encodingVerified: false, note: UNCONFIRMED_VALUE }),
    S('direction2', 'Direction 2', 7, { encodingVerified: false, note: UNCONFIRMED_VALUE }),
    T('play', 'Play', 20, { transport: true }),
    T('stop', 'Stop', 21, { transport: true }),
    T('record', 'Record', 22, { transport: true }),
    T('stopRecord', 'Stop Rec', 23, { transport: true }),
    T('undo', 'Undo', 24, { transport: true }),
  ],
  programs: null,
  notes: ['Follows MIDI clock, so send clock down the MPC A chain to keep loops in time.', 'Maximum input level +7.5 dBu.'],
  defaultChannelNote: 'The doc does not give the Xero a default channel. Channel 3 is a placeholder: set the pedal to it, or change it here.',
});

/** The four MIDI pedals, keyed by id. */
export const PEDAL_PROFILES = Object.freeze({
  [PURRTING.id]: PURRTING,
  [LOST_AND_FOUND.id]: LOST_AND_FOUND,
  [NUCLEO.id]: NUCLEO,
  [XERO.id]: XERO,
});
export const PEDAL_IDS = Object.freeze(Object.keys(PEDAL_PROFILES));

/** MIDI routes from docs/PEDALS.md (MPC MIDI track outputs). */
export const MIDI_ROUTES = Object.freeze({
  mpcA: 'MPC MIDI out A, TRS Type A chain (Purr-ting, then Xero, then Nucleo)',
  mpcB: 'MPC MIDI out B, through the Chase Bliss MIDIBox to Lost + Found',
});

/** Pedals with no MIDI: they live in the audio loop only. */
export const AUDIO_ONLY_PEDALS = Object.freeze([
  Object.freeze({ id: 'cali76', name: 'Origin Effects Cali76 Stacked', note: 'Audio loop only.' }),
  Object.freeze({ id: 'hammerOn', name: 'DigiTech HammerOn', note: 'Audio loop only. Maximum input +5 dBu.' }),
  Object.freeze({ id: 'medusa', name: 'Lichtlaerm Medusa', note: 'Audio loop only. Has its own parallel effects loop.' }),
  Object.freeze({ id: 'nostalgia', name: 'Lichtlaerm Nostalgia', note: 'Audio loop only (tap footswitch, no MIDI).' }),
]);

// ---------------------------------------------------------------- encoding

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp7 = (v) => clamp(Math.round(v), 0, 127);

/** A control is "on" for any truthy value; numbers count as on from 0.5. */
export function isOn(value) {
  if (typeof value === 'number') return value >= 0.5;
  return !!value;
}

/** 0..1 -> 7-bit value inside the control's lo..hi (default 0..127). */
export function encodeContinuous(value, control = {}) {
  const lo = Number.isFinite(control.lo) ? control.lo : 0;
  const hi = Number.isFinite(control.hi) ? control.hi : 127;
  const v = clamp(Number(value) || 0, 0, 1);
  const n = control.inverted ? 1 - v : v;
  return clamp7(lo + n * (hi - lo));
}

/** On/off -> 7-bit value. Inverted controls (0-63 = on) send 0 for on and 127 for off. */
export function encodeSwitch(on, control = {}) {
  const high = control.inverted ? !isOn(on) : isOn(on);
  return high ? 127 : 0;
}

/** 7-bit value -> on/off, honouring inverted controls. Threshold is the MIDI convention of 64. */
export function decodeSwitch(value7, control = {}) {
  const high = value7 >= 64;
  return control.inverted ? !high : high;
}

/** 7-bit value -> 0..1 for a continuous control. */
export function decodeContinuous(value7, control = {}) {
  const lo = Number.isFinite(control.lo) ? control.lo : 0;
  const hi = Number.isFinite(control.hi) ? control.hi : 127;
  const n = hi === lo ? 0 : clamp((value7 - lo) / (hi - lo), 0, 1);
  return control.inverted ? 1 - n : n;
}

/** Any control kind: value (0..1 or boolean) -> 7-bit data byte. */
export function encodeControl(control, value) {
  if (!control) return null;
  if (control.kind === 'switch') return encodeSwitch(value, control);
  if (control.kind === 'trigger') return clamp7(Number.isFinite(control.value) ? control.value : 127);
  return encodeContinuous(value, control);
}

/** Control Change bytes. `channel` is 1..16. */
export function ccBytes(channel, cc, value7) {
  return [0xb0 | ((clamp(Math.round(channel), 1, 16) - 1) & 15), clamp7(cc), clamp7(value7)];
}

/** Program Change bytes. `channel` is 1..16, `program` the raw data byte 0..127. */
export function pcBytes(channel, program) {
  return [0xc0 | ((clamp(Math.round(channel), 1, 16) - 1) & 15), clamp7(program)];
}

// ---------------------------------------------------------------- lookups

/** Profile by id or the profile object itself; null when unknown. */
export function getProfile(idOrProfile) {
  if (idOrProfile && typeof idOrProfile === 'object') return idOrProfile;
  return PEDAL_PROFILES[idOrProfile] || null;
}

export function findControl(profile, controlId) {
  const p = getProfile(profile);
  if (!p) return null;
  return p.controls.find(c => c.id === controlId) || p.controls.find(c => c.cc === controlId && typeof controlId === 'number') || null;
}

/** The switch that engages / bypasses the effect, or null when the pedal documents none. */
export function engageControl(profile) {
  const p = getProfile(profile);
  return p ? p.controls.find(c => c.role === 'engage') || null : null;
}

/** The tap tempo trigger, or null. */
export function tapControl(profile) {
  const p = getProfile(profile);
  return p ? p.controls.find(c => c.tap) || null : null;
}

/** Is `program` a valid Program Change for this pedal? Returns a reason when not. */
export function checkProgram(profile, program) {
  const p = getProfile(profile);
  if (!p) return { ok: false, reason: 'That pedal is not set up.' };
  if (!p.programs) return { ok: false, reason: `${p.name} does not list Program Change presets.` };
  const n = Number(program);
  if (!Number.isInteger(n)) return { ok: false, reason: 'Preset numbers are whole numbers.' };
  if (n < p.programs.min || n > p.programs.max) {
    return { ok: false, reason: `${p.name} presets run from ${p.programs.min} to ${p.programs.max}.` };
  }
  return { ok: true, reason: null };
}

/** A copy of a profile on another MIDI channel (pedals can be re-addressed). */
export function withChannel(profile, channel) {
  const p = getProfile(profile);
  const ch = Math.round(Number(channel));
  if (!p || !(ch >= 1 && ch <= 16)) return p;
  return Object.freeze({ ...p, channel: ch });
}

/**
 * Pedals that share a MIDI cable and a channel hear each other's CCs. Returns
 * one plain-language warning per clash, e.g. the Purr-ting and the Xero both on
 * channel 1 of the MPC A chain, where CC 20 is Glitch on one and Play on the other.
 * @param {Array<object>} profiles profiles as configured (with their channels)
 */
export function channelConflicts(profiles) {
  const list = (profiles || []).map(getProfile).filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.channel !== b.channel) continue;
      // Different cables never clash; unknown routes (custom pedals) might.
      if (a.route && b.route && a.route !== b.route) continue;
      const shared = a.controls.filter(c => b.controls.some(d => d.cc === c.cc)).map(c => c.cc);
      const pcs = !!(a.programs && b.programs);
      if (!shared.length && !pcs) continue;
      const parts = [];
      if (shared.length) parts.push(`CC ${shared.join(', ')} would change both`);
      if (pcs) parts.push('a preset change would switch both');
      out.push({ a: a.id, b: b.id, channel: a.channel, ccs: shared,
        message: `${a.name} and ${b.name} are both on channel ${a.channel}, so ${parts.join(' and ')}. Give one of them its own channel.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- custom pedals

function slug(s, fallback) {
  const base = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^[^a-z]+/, '');
  return base || fallback;
}

/**
 * Validate a profile. Returns a list of plain-language problems (empty when fine).
 */
export function validateProfile(p) {
  const problems = [];
  if (!p || typeof p !== 'object') return ['The pedal profile is missing.'];
  if (!p.id) problems.push('The pedal needs an id.');
  if (!(Number.isInteger(p.channel) && p.channel >= 1 && p.channel <= 16)) problems.push('The MIDI channel must be between 1 and 16.');
  if (!Array.isArray(p.controls)) { problems.push('The pedal has no control list.'); return problems; }
  const ids = new Set(), ccs = new Map();
  for (const c of p.controls) {
    const label = c && (c.label || c.id) || 'A control';
    if (!c || !c.id) { problems.push('Every control needs a name.'); continue; }
    if (ids.has(c.id)) problems.push(`"${label}" appears twice.`);
    ids.add(c.id);
    if (!(Number.isInteger(c.cc) && c.cc >= 0 && c.cc <= 127)) problems.push(`"${label}" needs a CC number from 0 to 127.`);
    else if (ccs.has(c.cc)) problems.push(`"${label}" and "${ccs.get(c.cc)}" both use CC ${c.cc}.`);
    else ccs.set(c.cc, label);
    if (!CONTROL_KINDS.includes(c.kind)) problems.push(`"${label}" has an unknown kind.`);
  }
  if (p.programs) {
    const { min, max } = p.programs;
    if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max <= 127 && min <= max)) problems.push('Preset numbers must be a range inside 0 to 127.');
  }
  return problems;
}

/**
 * Build a "Custom pedal" profile from what the owner types in. Throws an Error
 * with every problem listed when the description does not make sense.
 * @param {{name?: string, id?: string, channel?: number, controls?: Array<{label?: string, id?: string, cc: number,
 *   kind?: 'continuous'|'switch'|'trigger', inverted?: boolean, engage?: boolean, tap?: boolean, value?: number}>,
 *   programs?: {min: number, max: number, label?: string} | null, notes?: string[]}} desc
 */
export function createCustomProfile(desc = {}) {
  const name = String(desc.name || 'Custom pedal').trim().slice(0, 60) || 'Custom pedal';
  const controls = (Array.isArray(desc.controls) ? desc.controls : []).map((c, i) => {
    const kind = CONTROL_KINDS.includes(c && c.kind) ? c.kind : 'continuous';
    const label = String((c && (c.label || c.id)) || `CC ${c && c.cc}`).trim().slice(0, 40);
    const out = { id: c && c.id ? String(c.id) : slug(label, `control${i + 1}`), label, cc: c ? Number(c.cc) : NaN, kind };
    if (c && c.inverted) out.inverted = true;
    if (kind === 'switch' && c && c.engage) out.role = 'engage';
    if (kind === 'trigger') { out.value = Number.isFinite(c && c.value) ? clamp7(c.value) : 127; if (c && c.tap) out.tap = true; }
    if (kind === 'continuous' && c) {
      if (Number.isFinite(c.lo)) out.lo = clamp7(c.lo);
      if (Number.isFinite(c.hi)) out.hi = clamp7(c.hi);
    }
    return Object.freeze(out);
  });
  const p = {
    id: desc.id ? String(desc.id) : 'custom-' + slug(name, 'pedal'),
    name,
    maker: '',
    channel: Number.isFinite(desc.channel) ? Math.round(desc.channel) : 1,
    connector: '',
    route: null,
    custom: true,
    unverified: false,
    controls,
    programs: desc.programs ? { min: Math.round(desc.programs.min), max: Math.round(desc.programs.max), label: desc.programs.label || 'Presets' } : null,
    notes: Array.isArray(desc.notes) ? desc.notes.map(String) : [],
  };
  const problems = validateProfile(p);
  if (problems.length) {
    const err = new Error(problems.join(' '));
    err.problems = problems;
    throw err;
  }
  return profile(p);
}
