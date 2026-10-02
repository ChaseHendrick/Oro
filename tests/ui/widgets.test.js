import { describe, it, expect } from 'vitest';
import { qwertyNote, isBlack, layoutKeys, velocityFromY, noteName, QWERTY } from '../../src/ui/piano.js';
import { recordingName, formatElapsed } from '../../src/ui/record.js';
import { matchesQuery, groupByCategory } from '../../src/ui/patch-browser.js';
import { lfoValue, lfoHz, formatDepth } from '../../src/ui/mod-popover.js';
import { envGeometry, envAt } from '../../src/ui/env-graph.js';
import { meterPos, dbFromPeak } from '../../src/ui/mix-panel.js';
import { midiName } from '../../src/ui/seq-panel.js';
import { friendlyImportError } from '../../src/ui/map-panel.js';
import { SHORTCUTS } from '../../src/ui/shortcuts.js';
import { PART_PARAM_MAP, SYNC_DIVS } from '../../src/core/params.js';

describe('keyboard', () => {
  it('maps the QWERTY row to semitones from C', () => {
    expect(qwertyNote('KeyA', 4)).toBe(60);
    expect(qwertyNote('KeyW', 4)).toBe(61);
    expect(qwertyNote('KeyK', 4)).toBe(72);
    expect(qwertyNote('Quote', 4)).toBe(77);
    expect(qwertyNote('KeyA', 3)).toBe(48);
    expect(qwertyNote('KeyQ', 4)).toBeNull();
    expect(QWERTY.length).toBe(18);
  });
  it('lays out keys that tile the width', () => {
    const keys = layoutKeys(48, 84);
    const whites = keys.filter(k => !k.black);
    expect(whites.length).toBe(22);
    const total = whites.reduce((a, k) => a + k.width, 0);
    expect(total).toBeCloseTo(100, 5);
    expect(keys.filter(k => k.black).length).toBe(15);
    for (const k of keys) { expect(k.left).toBeGreaterThan(-3); expect(k.left + k.width).toBeLessThan(103); }
  });
  it('knows black keys, names and strike velocity', () => {
    expect(isBlack(61)).toBe(true);
    expect(isBlack(60)).toBe(false);
    expect(noteName(60)).toBe('C4');
    expect(velocityFromY(1)).toBe(1);
    expect(velocityFromY(0)).toBeCloseTo(0.3);
    expect(velocityFromY(5)).toBe(1);
  });
});

describe('recording', () => {
  it('names files orograph-YYYYMMDD-HHMMSS.wav', () => {
    expect(recordingName(new Date(2026, 9, 2, 7, 5, 9))).toBe('orograph-20261002-070509.wav');
  });
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });
});

describe('patch browser', () => {
  const items = [
    { name: 'Glass Orbit', category: 'Keys', tags: ['bell'] },
    { name: 'Canyon Bass', category: 'Bass', tags: [] },
    { name: 'Odd', category: 'Weird' },
  ];
  it('searches names, categories and tags', () => {
    expect(matchesQuery(items[0], 'bell')).toBe(true);
    expect(matchesQuery(items[0], 'glass keys')).toBe(true);
    expect(matchesQuery(items[1], 'glass')).toBe(false);
    expect(matchesQuery(items[1], '')).toBe(true);
  });
  it('groups by category in the given order, unknown last', () => {
    const g = groupByCategory(items, ['Bass', 'Keys', 'Pad']);
    expect(g.map(([c]) => c)).toEqual(['Bass', 'Keys', 'Weird']);
  });
});

describe('modulation helpers', () => {
  it('LFO shapes stay within -1..1', () => {
    for (let s = 0; s < 6; s++) for (let i = 0; i < 200; i++) {
      const v = lfoValue(s, i / 37);
      expect(v).toBeGreaterThanOrEqual(-1.0001);
      expect(v).toBeLessThanOrEqual(1.0001);
    }
  });
  it('converts synced divisions to Hz', () => {
    const quarter = SYNC_DIVS.findIndex(d => d.name === '1/4');
    expect(lfoHz({ lfoSync: 1, lfoDiv: quarter }, 120)).toBeCloseTo(2);
    expect(lfoHz({ lfoSync: 0, lfoRate: 3.5, lfoDiv: 0 }, 120)).toBe(3.5);
    expect(formatDepth(0.25)).toBe('+25%');
    expect(formatDepth(-0.5)).toBe('-50%');
  });
});

describe('envelope graph', () => {
  const defs = { a: PART_PARAM_MAP.attack, d: PART_PARAM_MAP.decay, s: PART_PARAM_MAP.sustain, r: PART_PARAM_MAP.release };
  it('places corners left to right inside the box', () => {
    const g = envGeometry({ a: 0.01, d: 0.3, s: 0.5, r: 1 }, defs);
    expect(g.x0).toBeLessThan(g.x1);
    expect(g.x1).toBeLessThan(g.x2);
    expect(g.x2).toBeLessThan(g.x3);
    expect(g.x3).toBeLessThan(g.x4);
    expect(g.x4).toBeLessThanOrEqual(220);
    expect(g.ys).toBeGreaterThan(g.top);
  });
  it('follows attack, decay, sustain and release', () => {
    const v = { a: 0.1, d: 0.2, s: 0.5, r: 0.4 };
    expect(envAt(v, 0.05, null, 0).stage).toBe('a');
    expect(envAt(v, 0.2, null, 0).stage).toBe('d');
    expect(envAt(v, 2, null, 0)).toMatchObject({ stage: 's', level: 0.5 });
    expect(envAt(v, 2, 0.1, 0.5).stage).toBe('r');
    expect(envAt(v, 2, 1, 0.5).stage).toBe('off');
  });
});

describe('small formatters', () => {
  it('meters use a dB scale', () => {
    expect(meterPos(1)).toBeCloseTo(60 / 63, 3);
    expect(meterPos(0)).toBe(0);
    expect(dbFromPeak(0.5)).toBeCloseTo(-6.02, 1);
  });
  it('names MIDI notes', () => {
    expect(midiName(57)).toBe('A3');
    expect(midiName(60)).toBe('C4');
  });
  it('turns import errors into friendly text', () => {
    expect(friendlyImportError(new Error('Unsupported format'))).toMatch(/PNG or JPEG/);
    expect(friendlyImportError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toMatch(/could not be used/);
    expect(friendlyImportError(new Error('The image is empty.'))).toBe('The image is empty.');
  });
  it('documents every shortcut once', () => {
    const keys = SHORTCUTS.flatMap(g => g.items.map(i => g.group + ':' + i.keys.join('+')));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some(k => k.includes('Space'))).toBe(true);
  });
});
