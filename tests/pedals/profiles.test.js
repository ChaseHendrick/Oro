import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PEDAL_PROFILES, PEDAL_IDS, PURRTING, LOST_AND_FOUND, NUCLEO, XERO, AUDIO_ONLY_PEDALS,
  encodeContinuous, encodeSwitch, decodeSwitch, decodeContinuous, encodeControl, ccBytes, pcBytes,
  findControl, engageControl, tapControl, checkProgram, withChannel, validateProfile,
  createCustomProfile, channelConflicts,
} from '../../src/pedals/profiles.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOC = fs.readFileSync(path.resolve(here, '../../docs/PEDALS.md'), 'utf8');

// The CC numbers each pedal's row of the docs/PEDALS.md table lists: the leading
// number(s) of each comma-separated item before the first ';' ("2/3 volume 1/2" -> 2, 3).
function docCCs(rowStart) {
  const row = DOC.split('\n').find(l => l.startsWith('| ' + rowStart));
  expect(row, `docs/PEDALS.md has a row for ${rowStart}`).toBeTruthy();
  const cols = row.split('|').map(s => s.trim());
  const midi = cols[3].split(';')[0];
  const out = [];
  for (const item of midi.split(',')) {
    const m = /^(?:CC\s*)?(\d+(?:\/\d+)*)/.exec(item.trim());
    if (m) out.push(...m[1].split('/').map(Number));
  }
  return { ccs: out.sort((a, b) => a - b), row: cols };
}
const ccsOf = (p) => p.controls.map(c => c.cc).sort((a, b) => a - b);

describe('pedal profiles match docs/PEDALS.md exactly', () => {
  it.each([
    ['OBNE Purr-ting', PURRTING, [11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 27, 85, 86]],
    ['Chase Bliss Lost + Found', LOST_AND_FOUND, [14, 15, 16, 17, 18, 19, 20, 57, 93, 100, 102, 103]],
    ['Cornerstone Nucleo', NUCLEO, [0, 5]],
    ['Walrus Xero', XERO, [2, 3, 4, 5, 6, 7, 20, 21, 22, 23, 24]],
  ])('%s: no CC missing and none invented', (rowStart, profile, expected) => {
    const { ccs } = docCCs(rowStart);
    expect(ccs).toEqual(expected);
    expect(ccsOf(profile)).toEqual(expected);
  });

  it('uses the documented default channels and connectors', () => {
    expect(docCCs('OBNE Purr-ting').row[2]).toMatch(/default ch 1/);
    expect(PURRTING.channel).toBe(1);
    expect(docCCs('Chase Bliss Lost + Found').row[2]).toMatch(/default ch 2/);
    expect(LOST_AND_FOUND.channel).toBe(2);
    // No default channel in the doc: placeholders, flagged, and away from the Purr-ting's channel 1.
    for (const p of [NUCLEO, XERO]) {
      expect(p.channelVerified).toBe(false);
      expect(p.channel).not.toBe(1);
    }
    expect(PURRTING.channelVerified).toBe(true);
  });

  it('marks the Purr-ting On/Off as inverted (0-63 = on) and the Nucleo chart as unverified', () => {
    expect(DOC).toMatch(/85 on\/off \(\*\*inverted\*\*: 0-63 on\)/);
    const onOff = findControl(PURRTING, 'onOff');
    expect(onOff).toMatchObject({ cc: 85, kind: 'switch', inverted: true, role: 'engage' });
    expect(findControl(PURRTING, 'tap')).toMatchObject({ cc: 86, kind: 'trigger' });
    expect(NUCLEO.unverified).toBe(true);
    expect(findControl(NUCLEO, 'bypass').encodingVerified).toBe(false);
    expect(NUCLEO.notes.join(' ')).toMatch(/unverified/);
  });

  it('documents Program Change meanings: Purr-ting 1-127, Lost + Found PC 0 = live, Nucleo 128 presets, Xero none', () => {
    expect(PURRTING.programs).toMatchObject({ min: 1, max: 127 });
    expect(LOST_AND_FOUND.programs.special[0]).toBe('Live');
    expect(NUCLEO.programs.max - NUCLEO.programs.min + 1).toBe(128);
    expect(XERO.programs).toBeNull();
    expect(checkProgram(PURRTING, 0).ok).toBe(false);
    expect(checkProgram(PURRTING, 1).ok).toBe(true);
    expect(checkProgram(LOST_AND_FOUND, 0).ok).toBe(true);
    expect(checkProgram(XERO, 1).reason).toMatch(/does not list/);
    expect(checkProgram(PURRTING, 2.5).ok).toBe(false);
  });

  it('keeps the Lost + Found CV range, the Xero clock note and the audio-only pedals', () => {
    expect(LOST_AND_FOUND.cv).toMatchObject({ minVolts: 0, maxVolts: 5 });
    expect(XERO.followsClock).toBe(true);
    expect(AUDIO_ONLY_PEDALS.map(p => p.id)).toEqual(['cali76', 'hammerOn', 'medusa', 'nostalgia']);
    expect(AUDIO_ONLY_PEDALS.find(p => p.id === 'hammerOn').note).toMatch(/\+5 dBu/);
  });

  it('every built-in profile validates, has unique ids/CCs and uses plain text without em dashes', () => {
    expect(PEDAL_IDS).toEqual(['purrting', 'lostAndFound', 'nucleo', 'xero']);
    for (const p of Object.values(PEDAL_PROFILES)) {
      expect(validateProfile(p)).toEqual([]);
      const text = JSON.stringify(p);
      expect(text).not.toMatch(/\u2014/);
    }
  });
});

describe('value encodings', () => {
  it('continuous 0..1 -> 0..127, clamped, optional lo/hi', () => {
    expect(encodeContinuous(0)).toBe(0);
    expect(encodeContinuous(1)).toBe(127);
    expect(encodeContinuous(0.5)).toBe(64);
    expect(encodeContinuous(-3)).toBe(0);
    expect(encodeContinuous(7)).toBe(127);
    expect(encodeContinuous(1, { lo: 10, hi: 20 })).toBe(20);
    expect(encodeContinuous(0, { inverted: true })).toBe(127);
    for (let v = 0; v <= 127; v++) expect(encodeContinuous(decodeContinuous(v))).toBe(v);
  });

  it('switches honour inverted encodings both ways', () => {
    const onOff = findControl(PURRTING, 'onOff');
    expect(encodeSwitch(true, onOff)).toBe(0);    // 0-63 = on
    expect(encodeSwitch(false, onOff)).toBe(127);
    expect(decodeSwitch(0, onOff)).toBe(true);
    expect(decodeSwitch(63, onOff)).toBe(true);
    expect(decodeSwitch(64, onOff)).toBe(false);
    const plain = findControl(NUCLEO, 'bypass');
    expect(encodeSwitch(true, plain)).toBe(127);
    expect(encodeSwitch(false, plain)).toBe(0);
    expect(decodeSwitch(64, plain)).toBe(true);
    expect(encodeControl(onOff, 1)).toBe(0);
    expect(encodeControl(findControl(XERO, 'play'), 0)).toBe(127);
  });

  it('builds CC and PC bytes on 1-based channels', () => {
    expect(ccBytes(1, 85, 0)).toEqual([0xb0, 85, 0]);
    expect(ccBytes(2, 93, 127)).toEqual([0xb1, 93, 127]);
    expect(ccBytes(16, 0, 200)).toEqual([0xbf, 0, 127]);
    expect(pcBytes(2, 0)).toEqual([0xc1, 0]);
    expect(pcBytes(1, 127)).toEqual([0xc0, 127]);
  });

  it('finds the engage switch and tap control, or reports none', () => {
    expect(engageControl(PURRTING).cc).toBe(85);
    expect(engageControl(NUCLEO).cc).toBe(0);
    expect(engageControl(LOST_AND_FOUND)).toBeNull();
    expect(engageControl(XERO)).toBeNull();
    expect(tapControl(PURRTING).cc).toBe(86);
    expect(tapControl(LOST_AND_FOUND).cc).toBe(93);
    expect(tapControl(XERO)).toBeNull();
  });

  it('withChannel re-addresses a profile without touching the original', () => {
    const p = withChannel(PURRTING, 7);
    expect(p.channel).toBe(7);
    expect(PURRTING.channel).toBe(1);
    expect(withChannel(PURRTING, 0)).toBe(PURRTING);
  });
});

describe('channel conflicts', () => {
  it('warns when two pedals on one cable share a channel and overlapping CCs', () => {
    const clash = channelConflicts([PURRTING, withChannel(XERO, 1)]);
    expect(clash).toHaveLength(1);
    expect(clash[0].ccs).toEqual([20, 21, 22, 23]);
    expect(clash[0].message).toMatch(/both on channel 1/);
    expect(clash[0].message).toMatch(/CC 20, 21, 22, 23/);
    expect(clash[0].message).not.toMatch(/\u2014/);
  });

  it('is quiet for the default setup and for pedals on different cables', () => {
    expect(channelConflicts(Object.values(PEDAL_PROFILES))).toEqual([]);
    // Lost + Found is on MPC B: same channel as a Purr-ting on MPC A is fine.
    expect(channelConflicts([PURRTING, withChannel(LOST_AND_FOUND, 1)])).toEqual([]);
  });
});

describe('custom pedal builder', () => {
  it('builds a frozen, valid profile from a plain description', () => {
    const p = createCustomProfile({
      name: 'My Fuzz', channel: 9,
      controls: [
        { label: 'Gain', cc: 30 },
        { label: 'On', cc: 31, kind: 'switch', inverted: true, engage: true },
        { label: 'Tap', cc: 32, kind: 'trigger', tap: true, value: 100 },
      ],
      programs: { min: 0, max: 9 },
    });
    expect(p.custom).toBe(true);
    expect(p.id).toBe('custom-myFuzz');
    expect(p.controls.map(c => c.id)).toEqual(['gain', 'on', 'tap']);
    expect(engageControl(p).inverted).toBe(true);
    expect(tapControl(p).value).toBe(100);
    expect(Object.isFrozen(p)).toBe(true);
    expect(checkProgram(p, 9).ok).toBe(true);
    expect(checkProgram(p, 10).ok).toBe(false);
  });

  it('rejects bad descriptions with every problem in plain words', () => {
    let err = null;
    try {
      createCustomProfile({ name: 'Bad', channel: 17, controls: [{ label: 'A', cc: 5 }, { label: 'B', cc: 5 }, { label: 'C', cc: 300 }] });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.problems).toEqual(expect.arrayContaining([
      'The MIDI channel must be between 1 and 16.',
      '"B" and "A" both use CC 5.',
      '"C" needs a CC number from 0 to 127.',
    ]));
    expect(err.message).not.toMatch(/\u2014/);
  });
});
