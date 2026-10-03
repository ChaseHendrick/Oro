// Akai MPC helpers: port detection and the setup guide shown in the MIDI
// panel. The guide is plain data (sections of steps) so the UI decides how to
// render it. It is written as guidance: menu names come from Akai's
// documentation for MPC firmware 3.9 and can differ on other versions.

export const MPC_NAME = /mpc/i;

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

export function isMpcPort(name) {
  return MPC_NAME.test(String(name || ''));
}

// Lowercase, spaces removed, and "MIDI One" spelled as "midi1" so a port
// called "... MIDI One" is treated like "... MIDI 1".
function compact(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(midi|port)\s*(one|two|three|four|five|six|seven|eight)\b/g, (m, kind, word) => kind + NUMBER_WORDS[word])
    .replace(/\s+/g, '');
}

/** Port family name: lowercase, no spaces, trailing "midi<n>" / "port<n>" removed. */
export function portStem(name) {
  return compact(name).replace(/(midi|port)\d+$/, '');
}

function isPortOne(name) {
  return /(midi1|port1)$/.test(compact(name));
}

/**
 * Pick the MPC port to use, or null when the choice is not clear.
 *   - candidates are ports whose name contains "MPC"
 *   - exactly one candidate: use it
 *   - several from the same device (same stem): use the "Port 1" / "MIDI 1" one
 *   - otherwise ask the user. Non-MPC devices are never picked automatically.
 */
export function detectMpcPort(ports) {
  const list = (ports || []).filter(p => p && p.state !== 'disconnected');
  const candidates = list.filter(p => isMpcPort(p.name));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const stems = new Set(candidates.map(p => portStem(p.name)));
    if (stems.size === 1) {
      const ones = candidates.filter(p => isPortOne(p.name));
      if (ones.length === 1) return ones[0];
    }
  }
  return null;
}

export const MPC_GUIDE_INTRO =
  'These steps follow Akai\'s documentation for the MPC XL on firmware 3.9. Menu names can change between firmware versions, so treat them as a guide, and use the checks at the end of each section if nothing arrives.';

export const MPC_GUIDE = [
  {
    id: 'connect',
    title: 'Connect',
    steps: [
      { text: 'Keep the MPC in Standalone mode.', detail: 'Controller mode is a different Akai workflow: it needs the MPC desktop software and closes your standalone project.' },
      { text: 'Connect the MPC\'s USB-C port to your computer with a USB data cable.', detail: 'Some USB-C cables only carry power. The USB-A ports on the MPC are for controllers and drives, not for the computer.' },
      { text: 'On Windows, install the MPC XL driver if the ports do not show up.', detail: 'It is in the inMusic Software Center under My Hardware > MPC XL. macOS sets up the MIDI ports by itself.' },
      { text: 'In Oro, press Connect MIDI and allow MIDI access when the browser asks.' },
      { text: 'Choose the MPC port.', detail: 'Oro picks a port with MPC in its name when the choice is clear. If there are several, choose the one for Port 1. Akai describes the Mac ports with names like "MPC MIDI 1 & 2", but your computer may show a different name.' },
    ],
    checks: [
      'No MPC in the list: try another cable or USB port, reconnect the MPC, then press Connect MIDI again.',
      'On Windows, install the driver and restart the browser.',
    ],
  },
  {
    id: 'pads',
    title: 'Play Oro from the MPC pads',
    steps: [
      { text: 'Make sure the MPC input is switched on in Oro\'s MIDI panel.' },
      { text: 'On the MPC, pick a MIDI track and point its MIDI output at the USB port.', detail: 'Choose a channel that matches how Oro listens: Omni plays one part (or the selected part) whatever the channel, Multi gives each part its own channel.' },
      { text: 'Hit a pad. The MIDI light in Oro should blink and the part should play.' },
      { text: 'For in-key pads, set Pad mode to Scale.', detail: 'Notes from the pad base note upward then play Oro\'s key and scale, one scale step per note. Pad note numbers depend on the MPC program, so set the pad base note to the note your lowest pad sends.' },
    ],
    checks: [
      'Nothing arrives: check the track\'s MIDI output on the MPC, and the output settings in Menu > Preferences > MIDI/Sync.',
      'The light blinks but there is no sound: check the part is not muted and that the channel matches in Multi mode.',
    ],
  },
  {
    id: 'qlinks',
    title: 'Twist Q-Links to control Oro',
    steps: [
      { text: 'Q-Link CC numbers are not fixed, so Oro learns them.', detail: 'Press Learn on a control (or start the Q-Link wizard), then twist a Q-Link. Oro binds whichever CC arrives.' },
      { text: 'The wizard walks through 16 useful controls for the selected part.', detail: 'Dot position, size, rotate, morph, warp, fold, lift, path shape, stretch, cutoff, resonance, drive, filter envelope, reverb and delay sends. Learned knobs follow whichever part is selected.' },
      { text: 'You do not need Shift + Q-Links on the MPC.', detail: 'That is the MPC\'s own learn feature for its internal parameters.' },
    ],
    checks: [
      'Twisting does nothing: the MPC has to send MIDI to the USB port. Check the track\'s MIDI output (or the MPC\'s MIDI Control mode) points at it.',
      'Also check the cable is a data cable and the input is switched on in Oro.',
    ],
  },
  {
    id: 'notes-out',
    title: 'Play the MPC from Oro',
    steps: [
      { text: 'In Oro, choose the MPC as the output and switch on Send notes.', detail: 'Each part sends on its own channel: Part 1 on channel 1, Part 2 on channel 2 and so on. You can change these.' },
      { text: 'On the MPC, open Menu > Preferences > MIDI/Sync.', detail: 'Under Input Ports find "USB MIDI Port 1", switch Track on and Global off.' },
      { text: 'On a plugin, keygroup or MIDI track, set the MIDI input to USB MIDI Port 1.', detail: 'Pick the channel that matches the Oro part (not All) and set monitoring to In, or Merge.' },
      { text: 'Press Play in Oro.', detail: 'Sequencer, arpeggiator and keyboard notes go out with timestamps so they line up with Oro\'s own sound. Mute a part in Oro to hear only the MPC sound while its notes still go out.' },
    ],
    checks: [
      'The MPC does not play: check the track\'s input port and channel, and that monitoring is on.',
      'Notes hang: press Panic in Oro. On the MPC, leave "Filter All Notes Off CC" disabled so it accepts the clean-up messages.',
    ],
  },
  {
    id: 'sync',
    title: 'Sync tempo',
    steps: [
      { text: 'Choose one clock master.', detail: 'If both Oro and the MPC send clock, the tempo fights. Switch clock sending on in one place only.' },
      { text: 'Oro as master: switch on Send clock in Oro, then set Sync Receive to MIDI Clock on the MPC.', detail: 'Oro sends 24 pulses per beat with Start and Stop. Akai notes that MPC audio recording is disabled while it receives MIDI Clock.' },
      { text: 'MPC as master: enable clock send for the USB port in the MPC\'s MIDI/Sync settings, then switch on Follow MPC clock in Oro.', detail: 'Start and stop from the MPC. Oro follows its tempo, Start, Stop, Continue and song position.' },
    ],
    checks: [
      'Oro does not start with the MPC: check clock send is enabled for the USB port, and that Follow MPC clock is on.',
      'Tempo wobbles or jumps: make sure only one device is sending clock.',
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    steps: [
      { text: 'No MIDI option at all.', detail: 'Web MIDI needs Chrome, Edge, Opera or the Oro desktop app, on a secure page (https or localhost). Safari does not offer Web MIDI, and Firefox may ask you to allow MIDI for the site first.' },
      { text: 'Permission was blocked.', detail: 'Open the site settings from the icon in the address bar, allow MIDI devices, then reload the page.' },
      { text: 'The MPC is missing from the list.', detail: 'Check the cable carries data, try another USB port, reconnect the MPC, and on Windows install the MPC XL driver from the inMusic Software Center.' },
      { text: 'Stuck notes.', detail: 'Press Panic. Oro sends note-offs for anything it is holding, then Sustain off, All Notes Off and All Sound Off on its channels.' },
      { text: 'The MPC was unplugged while playing.', detail: 'Oro stops sending to it and shows a message. Plug it back in and Oro picks the port up again.' },
    ],
    checks: [],
  },
];
