// Tracks (v1.3): the variable-length track list, its operations, the slot
// permutation every per-track module follows, patterns, and migration of
// sessions and scenes saved with four fixed parts.
import { describe, it, expect } from 'vitest';
import {
  MAX_PARTS, DEFAULT_PARTS, MAX_PATTERNS, PART_COLORS, STATE_VERSION, defaultState, defaultPart, activeSeq, patternPath,
} from '../../src/core/params.js';
import { migrateState, migrateScene } from '../../src/core/migrate.js';
import { createStore } from '../../src/core/store.js';
import {
  partCount, isTrack, selectedIndex, trackIds, trackPerm, permute, inversePerm, watchTracks,
  addTrack, removeTrack, duplicateTrack, moveTrack, renameTrack, setTracks, newTrackId,
  addPattern, selectPattern, removePattern, REPLACE_TRACKS,
} from '../../src/core/tracks.js';

const ids = (store) => store.get('parts').map(p => p.id);

describe('track list defaults', () => {
  it('starts with four tracks with unique ids, names and colours, one pattern each', () => {
    const s = defaultState();
    expect(s.version).toBe(STATE_VERSION);
    expect(s.parts).toHaveLength(DEFAULT_PARTS);
    expect(s.parts.map(p => p.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(s.parts.map(p => p.name)).toEqual(['Track 1', 'Track 2', 'Track 3', 'Track 4']);
    expect(new Set(s.parts.map(p => p.color)).size).toBe(4);
    for (const p of s.parts) {
      expect(p.seqOn).toBe(0);
      expect(p.patterns).toHaveLength(1);
      expect(p.patterns[0]).toMatchObject({ id: 'p1', name: 'Pattern 1', rate: 3, length: 16 });
      expect(p.activePattern).toBe(0);
      expect(p.seq).toBeUndefined();
    }
    expect(defaultState(1).parts).toHaveLength(1);
    expect(defaultState(99).parts).toHaveLength(MAX_PARTS);
  });

  it('has a distinct colour for every slot', () => {
    expect(PART_COLORS).toHaveLength(MAX_PARTS);
    expect(new Set(PART_COLORS.map(c => c.toLowerCase())).size).toBe(MAX_PARTS);
    for (const c of PART_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('slot permutation', () => {
  it('is null when nothing moves and a bijection otherwise', () => {
    expect(trackPerm(['a', 'b'], ['a', 'b'])).toBeNull();
    const ch = trackPerm(['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'd']);
    expect(ch.perm.slice(0, 4)).toEqual([1, 0, 2, 3]);
    expect([...ch.perm].sort((x, y) => x - y)).toEqual(Array.from({ length: MAX_PARTS }, (_, i) => i));
    expect(ch.fresh).toEqual([]);
    expect(ch.count).toBe(4);
  });

  it('gives a new track the slot that has been free longest and parks a removed one last', () => {
    // remove 'b' from four tracks: its slot (1) goes to the very end, where it can fade out
    const rm = trackPerm(['a', 'b', 'c', 'd'], ['a', 'c', 'd']);
    expect(rm.perm.slice(0, 3)).toEqual([0, 2, 3]);
    expect(rm.perm[MAX_PARTS - 1]).toBe(1);
    expect(rm.count).toBe(3);
    // a track added next takes slot 4 (never used), not the one still fading
    const add = trackPerm(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e']);
    expect(add.perm.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(add.fresh).toEqual([4]);
  });

  it('treats every track as new on a replace (scene load), so old slots fade while new ones start', () => {
    const ch = trackPerm(['t1', 't2', 't3', 't4'], ['t1', 't2', 't3', 't4'], MAX_PARTS, true);
    expect(ch.fresh).toEqual([0, 1, 2, 3]);
    expect(ch.perm.slice(0, 4)).toEqual([4, 5, 6, 7]);
    expect(ch.perm.slice(MAX_PARTS - 4)).toEqual([0, 1, 2, 3]);
  });

  it('permutes per-slot lists and inverts', () => {
    const ch = trackPerm(['a', 'b', 'c'], ['c', 'a']);
    const list = Array.from({ length: MAX_PARTS }, (_, i) => `s${i}`);
    const out = permute(list, ch.perm);
    expect(out.slice(0, 2)).toEqual(['s2', 's0']);
    const inv = inversePerm(ch.perm);
    expect(inv[2]).toBe(0);
    expect(inv[0]).toBe(1);
    expect(permute(list, ch.perm, [1], () => 'new')[1]).toBe('new');
  });

  it('tells watchers after the store changed shape, with the store meta', () => {
    const store = createStore(defaultState());
    const seen = [];
    watchTracks(store, (ch, meta) => seen.push({ ch, meta, count: store.get('parts').length }));
    store.set('parts.0.params.cutoff', 500);            // not a shape change
    moveTrack(store, 0, 2);
    expect(seen).toHaveLength(1);
    expect(seen[0].ch.perm.slice(0, 4)).toEqual([1, 2, 0, 3]);
    expect(seen[0].meta).toMatchObject({ source: 'tracks' });
    store.load(defaultState(), { source: 'scene', [REPLACE_TRACKS]: true });
    expect(seen[1].ch.fresh).toEqual([0, 1, 2, 3]);
  });
});

describe('track operations', () => {
  it('adds tracks up to MAX_PARTS, each with a new id, name and colour, and selects them', () => {
    const store = createStore(defaultState());
    expect(addTrack(store)).toBe(4);
    expect(partCount(store)).toBe(5);
    const t = store.get('parts.4');
    expect(t.id).toBe('t5');
    expect(t.name).toBe('Track 5');
    expect(t.color).toBe(PART_COLORS[4]);
    expect(store.get('ui.selectedPart')).toBe(4);
    while (addTrack(store) >= 0);
    expect(partCount(store)).toBe(MAX_PARTS);
    expect(new Set(ids(store)).size).toBe(MAX_PARTS);
    expect(addTrack(store)).toBe(-1);
    expect(duplicateTrack(store, 0)).toBe(-1);
  });

  it('removes a track (never the last), keeping the selected track selected', () => {
    const store = createStore(defaultState());
    store.set('ui.selectedPart', 3);
    expect(removeTrack(store, 1)).toBe(true);
    expect(ids(store)).toEqual(['t1', 't3', 't4']);
    expect(store.get('ui.selectedPart')).toBe(2);           // still t4
    removeTrack(store, 0); removeTrack(store, 0);
    expect(removeTrack(store, 0)).toBe(false);
    expect(partCount(store)).toBe(1);
    // ids are never reused while the list exists: the next track is t5, not t1
    addTrack(store);
    expect(ids(store)).toEqual(['t4', 't5']);
  });

  it('duplicates a track right after it with its sound and patterns, unsoloed', () => {
    const store = createStore(defaultState());
    store.set('parts.1.name', 'Bass');
    store.set('parts.1.params.cutoff', 432);
    store.set('parts.1.params.solo', 1);
    store.set('parts.1.patterns.0.steps.2.on', 1);
    expect(duplicateTrack(store, 1)).toBe(2);
    const a = store.get('parts.1'), b = store.get('parts.2');
    expect(b.name).toBe('Bass 2');
    expect(b.id).not.toBe(a.id);
    expect(b.params.cutoff).toBe(432);
    expect(b.params.solo).toBe(0);
    expect(b.patterns).toEqual(a.patterns);
    b.patterns[0].steps[2].on = 0;                           // deep copy, not shared
    expect(store.get('parts.1.patterns.0.steps.2.on')).toBe(1);
  });

  it('moves a track and the selection follows it; renames with trimming', () => {
    const store = createStore(defaultState());
    store.set('ui.selectedPart', 0);
    expect(moveTrack(store, 0, 3)).toBe(true);
    expect(ids(store)).toEqual(['t2', 't3', 't4', 't1']);
    expect(store.get('ui.selectedPart')).toBe(3);
    expect(moveTrack(store, 2, 2)).toBe(false);
    expect(renameTrack(store, 0, '  Pad  ')).toBe(true);
    expect(store.get('parts.0.name')).toBe('Pad');
    expect(renameTrack(store, 0, '   ')).toBe(false);
    expect(renameTrack(store, 9, 'x')).toBe(false);
  });

  it('brings a removed track back with its id (undo)', () => {
    const store = createStore(defaultState());
    const part = store.get('parts.2');
    removeTrack(store, 2);
    expect(addTrack(store, { index: 2, part })).toBe(2);
    expect(ids(store)).toEqual(['t1', 't2', 't3', 't4']);
    expect(newTrackId(store.get('parts'))).toBe('t5');
  });

  it('ignores writes to tracks that do not exist instead of growing the list', () => {
    const store = createStore(defaultState());
    store.set('parts.7.params.cutoff', 100);
    expect(store.get('parts')).toHaveLength(4);
    expect(isTrack(store, 3)).toBe(true);
    expect(isTrack(store, 4)).toBe(false);
    store.set('ui.selectedPart', 9);
    expect(selectedIndex(store)).toBe(3);
  });

  it('replaces the list with unique ids', () => {
    const store = createStore(defaultState());
    setTracks(store, [defaultPart(0), defaultPart(0), { ...defaultPart(2), id: 'bad id!' }]);
    expect(new Set(ids(store)).size).toBe(3);
    expect(trackIds(store.get('parts'))).toEqual(ids(store));
  });
});

describe('patterns', () => {
  it('adds a copy, switches, plays the active one and removes (keeping one)', () => {
    const store = createStore(defaultState());
    store.set('parts.0.patterns.0.steps.0.on', 1);
    store.set('parts.0.seqOn', 1);
    expect(addPattern(store, 0)).toBe(1);
    const part = store.get('parts.0');
    expect(part.patterns.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(part.patterns[1].name).toBe('Pattern 2');
    expect(part.patterns[1].steps[0].on).toBe(1);           // a copy of the one that played
    expect(part.activePattern).toBe(1);
    expect(patternPath(store, 0)).toBe('parts.0.patterns.1');
    store.set('parts.0.patterns.1.steps.0.on', 0);
    expect(activeSeq(store.get('parts.0'))).toMatchObject({ id: 'p2', enabled: 1 });
    expect(selectPattern(store, 0, 0)).toBe(true);
    expect(activeSeq(store.get('parts.0')).steps[0].on).toBe(1);
    expect(selectPattern(store, 0, 5)).toBe(false);
    expect(removePattern(store, 0, 0)).toBe(true);
    expect(store.get('parts.0.patterns').map(p => p.id)).toEqual(['p2']);
    expect(store.get('parts.0.activePattern')).toBe(0);
    expect(removePattern(store, 0, 0)).toBe(false);
    for (let k = 1; k < MAX_PATTERNS; k++) addPattern(store, 0, { copy: false });
    expect(addPattern(store, 0)).toBe(-1);
  });
});

describe('migration', () => {
  /** A v1.1 (STATE_VERSION 3) session: four parts, one `seq` each. */
  function oldSession() {
    const s = JSON.parse(JSON.stringify(defaultState()));
    s.version = 3;
    s.parts.forEach((p, i) => {
      delete p.id; delete p.patterns; delete p.activePattern; delete p.seqOn;
      p.name = `Part ${i + 1}`;
      p.seq = { enabled: i === 1 ? 1 : 0, rate: 1, length: 8, baseOctave: 2, lockGlide: 0.25,
        steps: Array.from({ length: 16 }, (_, k) => ({ on: k % 3 === 0 ? 1 : 0, degree: k, octave: 0, vel: 0.8, gate: 0.5, slide: 0, accent: 0, lock: k === 2 ? 1 : 0, lx: 0.25, ly: 0.75 })) };
    });
    return s;
  }

  it('turns a four-part session into four tracks, each seq becoming pattern 1', () => {
    const old = oldSession();
    const m = migrateState(old);
    expect(m.version).toBe(STATE_VERSION);
    expect(m.parts).toHaveLength(4);
    expect(m.parts.map(p => p.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(m.parts.map(p => p.name)).toEqual(['Part 1', 'Part 2', 'Part 3', 'Part 4']);
    expect(m.parts.map(p => p.seqOn)).toEqual([0, 1, 0, 0]);
    for (const [i, p] of m.parts.entries()) {
      const { enabled, ...pattern } = old.parts[i].seq;
      expect(p.patterns).toEqual([{ id: 'p1', name: 'Pattern 1', ...pattern }]);
      expect(p.activePattern).toBe(0);
      expect(p.seq).toBeUndefined();
    }
    // and the result is a fixed point
    expect(migrateState(m)).toEqual(m);
  });

  it('loads an old scene with fewer parts saved as four tracks, and keeps its pedal presets', () => {
    const old = oldSession();
    old.parts = old.parts.slice(0, 2);
    old.pedalPresets = { purrting: 3 };
    const m = migrateScene(old);
    expect(m.parts).toHaveLength(4);
    expect(m.parts[1].seqOn).toBe(1);
    expect(m.parts[3]).toEqual(migrateState(defaultState()).parts[3]);
    expect(m.pedalPresets).toEqual({ purrting: 3 });
  });

  it('keeps a saved list of 1 to 16 tracks and caps longer ones', () => {
    const s = defaultState(6);
    s.parts[5].name = 'Six';
    s.parts[5].patterns.push({ ...s.parts[5].patterns[0], id: 'p7', name: 'Fill' });
    s.parts[5].activePattern = 1;
    const m = migrateState(JSON.parse(JSON.stringify(s)));
    expect(m.parts).toHaveLength(6);
    expect(m.parts[5].name).toBe('Six');
    expect(m.parts[5].patterns.map(p => p.id)).toEqual(['p1', 'p7']);
    expect(m.parts[5].activePattern).toBe(1);
    expect(migrateState({ ...defaultState(1), version: STATE_VERSION }).parts).toHaveLength(1);
    const many = { ...defaultState(), parts: Array.from({ length: 30 }, (_, i) => defaultPart(i % 16)), version: STATE_VERSION };
    const capped = migrateState(many);
    expect(capped.parts).toHaveLength(MAX_PARTS);
    expect(new Set(capped.parts.map(p => p.id)).size).toBe(MAX_PARTS);
  });

  it('repairs duplicate and broken ids, active patterns out of range and duplicate pattern ids', () => {
    const s = defaultState(3);
    s.parts[1].id = 't1';
    s.parts[2].id = '';
    s.parts[0].activePattern = 7;
    s.parts[0].patterns = [s.parts[0].patterns[0], { ...s.parts[0].patterns[0] }];
    const m = migrateState(s);
    expect(new Set(m.parts.map(p => p.id)).size).toBe(3);
    expect(m.parts[0].activePattern).toBe(1);
    expect(new Set(m.parts[0].patterns.map(p => p.id)).size).toBe(2);
  });
});
