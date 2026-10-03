// Akai MPC XL setup guide. Uses the MIDI module's guide data when it ships one
// (src/midi/mpc.js); otherwise this built-in copy, written from the owner's
// notes. None of it has been validated on hardware, so it is phrased as
// guidance and ends with what to check if nothing arrives.

const mpcMod = Object.values(import.meta.glob('../midi/mpc.js', { eager: true }))[0] || null;

export const BUILTIN_GUIDE = [
  {
    title: 'Connect the MPC XL',
    steps: [
      'Use the MPC XL\'s USB-C port (the one meant for a computer) and a USB-C cable that carries data, not just power.',
      'Keep the MPC in Standalone mode. Controller mode is a different Akai workflow that needs the MPC desktop software and closes your standalone project.',
      'On Windows, install the MPC XL driver from the inMusic Software Center (My Hardware > MPC XL). macOS finds the MIDI ports by itself. Whether Windows works without the driver is not confirmed.',
      'Press Connect MIDI above and allow access when the browser asks.',
      'Pick the port that corresponds to Port 1. Akai describes Mac ports such as "MPC MIDI 1 & 2"; the name on your computer may differ.',
    ],
  },
  {
    title: 'Play the MPC from Oro',
    steps: [
      'On the MPC open Menu > Preferences > MIDI/Sync. Under Input Ports find "USB MIDI Port 1", enable Track and disable Global.',
      'On a plugin, keygroup or MIDI track, set the MIDI input to USB MIDI Port 1, choose a specific channel (not All) and set monitoring to In (or Merge).',
      'Here, choose the MPC as the output, turn on Send notes, and match each part\'s channel to the track you want it to play.',
    ],
  },
  {
    title: 'Control Oro from the MPC',
    steps: [
      'The MPC has to send MIDI to the computer: point the track\'s MIDI output (or MIDI Control mode) at the USB port.',
      'Q-Link CC numbers are not fixed, so use the Q-Link wizard below: twist each Q-Link when asked and Oro binds whatever CC arrives.',
      'Shift + Q-Links on the MPC is the MPC\'s own learn for its internal parameters. You do not need it for Oro.',
      'Pads: Notes plays the notes the pads send. Scale maps the pads to the global key\'s scale, starting at the base note.',
    ],
  },
  {
    title: 'Clock: keep one master',
    steps: [
      'Oro as master: turn on Send clock here, then on the MPC set Sync Receive to MIDI Clock. Akai notes that MPC audio recording is disabled while it receives MIDI clock.',
      'MPC as master: enable clock send for the USB port in the MPC\'s MIDI/Sync settings, then turn on Follow MPC clock here.',
      'Only one device should send clock. If both do, the tempo fights.',
    ],
  },
  {
    title: 'If nothing arrives',
    steps: [
      'Watch the activity lights next to each input. If they never blink, no MIDI is reaching the browser.',
      'Check the cable carries data, and that the MPC\'s MIDI/Sync output settings target the USB port.',
      'Stuck notes? Press Panic. It sends note-offs, then Sustain off (CC 64), All Sound Off (CC 120) and All Notes Off (CC 123) on the channels in use. On the MPC, leave "Filter All Notes Off CC" disabled so it accepts these.',
      'Web MIDI needs Chrome, Edge or Opera (or the Oro desktop app) on a secure page (https or localhost).',
    ],
  },
];

function toStep(step) {
  if (typeof step === 'string') return { text: step, detail: '' };
  if (step && typeof step === 'object') {
    const text = String(step.text || step.title || step.body || '');
    const detail = String(step.detail || step.note || (step.title && step.body ? step.body : '') || '');
    return text ? { text, detail: detail === text ? '' : detail } : null;
  }
  return null;
}

/** Normalise whatever shape the MIDI module exports into [{ title, steps: [{text, detail}], checks: [string] }]. */
export function adaptGuide(data) {
  if (!data) return null;
  let sections = data;
  if (!Array.isArray(sections)) sections = sections.sections || sections.steps || null;
  if (!Array.isArray(sections) || !sections.length) return null;
  const out = [];
  for (const sec of sections) {
    if (typeof sec === 'string') { out.push({ title: '', steps: [{ text: sec, detail: '' }], checks: [] }); continue; }
    if (!sec || typeof sec !== 'object') continue;
    const raw = Array.isArray(sec.steps) ? sec.steps : Array.isArray(sec.items) ? sec.items : [sec.text || sec.body];
    const steps = raw.map(toStep).filter(Boolean);
    const checks = (Array.isArray(sec.checks) ? sec.checks : []).map(c => (typeof c === 'string' ? c : (c && c.text) || '')).filter(Boolean);
    if (steps.length) out.push({ title: String(sec.title || sec.heading || ''), steps, checks });
  }
  return out.length ? out : null;
}

const BUILTIN_INTRO = 'Guidance from Akai\'s documentation and the notes we have for MPC firmware 3.9. It has not been checked on every setup, so if something does not match, the last section lists what to check.';

export function mpcGuide() {
  if (mpcMod) {
    const candidate = mpcMod.MPC_GUIDE || mpcMod.mpcGuide || mpcMod.GUIDE || mpcMod.guide || mpcMod.SETUP_GUIDE || mpcMod.default;
    const resolved = typeof candidate === 'function' ? safe(candidate) : candidate;
    const adapted = adaptGuide(resolved);
    if (adapted) {
      const intro = typeof mpcMod.MPC_GUIDE_INTRO === 'string' ? mpcMod.MPC_GUIDE_INTRO : BUILTIN_INTRO;
      return { sections: adapted, intro, source: 'midi' };
    }
  }
  return { sections: adaptGuide(BUILTIN_GUIDE), intro: BUILTIN_INTRO, source: 'builtin' };
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}
