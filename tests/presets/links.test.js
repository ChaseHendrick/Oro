// Links and Steps LFOs in patches: factory content, load, save, import, random.

import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, defaultPart, defaultLinks, LINK_SOURCES, LINK_CURVES, PART_PARAM_MAP, MAX_LINKS, LFO_SHAPES, LFO_STEP_COUNT } from '../../src/core/params.js';
import { sanitizePart, migrateState } from '../../src/core/migrate.js';
import { createPresets, sanitizePatch } from '../../src/presets/presets.js';
import { FACTORY_PATCHES } from '../../src/presets/factory-patches.js';
import { FACTORY_SCENES } from '../../src/presets/factory-scenes.js';
import { partWithPatch, patchLinks } from '../../src/presets/apply.js';
import { randomPatch } from '../../src/presets/random-patch.js';
import { makeRng } from '../../src/music/patterns.js';
import { createMemoryStorage } from '../music/fakes.js';

const STEPS = LFO_SHAPES.indexOf('Steps');
const withLinks = FACTORY_PATCHES.filter(p => Array.isArray(p.links));

describe('factory Links and Steps', () => {
  it('gives six patches valid, tasteful Links that keep the wheel on Morph', () => {
    expect(withLinks.length).toBeGreaterThanOrEqual(6);
    const used = new Set();
    for (const p of withLinks) {
      expect(p.links.length, p.name).toBeLessThanOrEqual(MAX_LINKS);
      expect(p.links[0], p.name).toEqual({ src: 1, dst: 'morph', amt: 1, curve: 0 });
      for (const l of p.links) {
        expect(PART_PARAM_MAP[l.dst] && PART_PARAM_MAP[l.dst].mod, `${p.name} -> ${l.dst}`).toBe(true);
        expect(l.src).toBeGreaterThanOrEqual(0);
        expect(l.src).toBeLessThan(LINK_SOURCES.length);
        expect(l.curve).toBeLessThan(LINK_CURVES.length);
        // Expression, not a takeover: no single link moves a knob more than 60%.
        if (l.src !== 1) expect(Math.abs(l.amt), `${p.name} ${LINK_SOURCES[l.src]} -> ${l.dst}`).toBeLessThanOrEqual(0.6);
        used.add(`${LINK_SOURCES[l.src]}>${l.dst}`);
      }
    }
    for (const want of ['Velocity>size', 'Key>cutoff', 'Macro 1>morph']) expect(used.has(want), want).toBe(true);
  });

  it('uses Steps LFOs with a full, in-range pattern', () => {
    const stepped = FACTORY_PATCHES.filter(p => Object.values(p.mods || {}).some(m => m.lfoShape === STEPS));
    expect(stepped.length).toBeGreaterThanOrEqual(3);
    for (const p of stepped) {
      for (const m of Object.values(p.mods)) {
        if (m.lfoShape !== STEPS) continue;
        expect(m.steps).toHaveLength(LFO_STEP_COUNT);
        for (const v of m.steps) { expect(v).toBeGreaterThanOrEqual(-1); expect(v).toBeLessThanOrEqual(1); }
        expect(m.lfoSync).toBe(1);
      }
    }
  });

  it('survives migration unchanged and reaches the scenes that use the patches', () => {
    for (const p of withLinks) {
      const part = partWithPatch(defaultPart(0), p);
      expect(part.links).toEqual(p.links);
      expect(part.links).not.toBe(p.links);
      expect(sanitizePart(part, 0)).toEqual(part);
    }
    const survey = FACTORY_PATCHES.find(p => p.name === 'Survey Arp');
    const scene = FACTORY_SCENES.find(s => s.parts.some(pt => pt.patchName === 'Survey Arp'));
    const part = scene.parts.find(pt => pt.patchName === 'Survey Arp');
    expect(part.links).toEqual(survey.links);
    expect(migrateState(scene).parts.find(pt => pt.patchName === 'Survey Arp').links).toEqual(survey.links);
  });
});

describe('Links in the preset library', () => {
  function setup(storage = createMemoryStorage()) {
    const store = createStore(defaultState());
    return { store, presets: createPresets({ store, storage, random: makeRng(5) }), storage };
  }

  it('loading a patch replaces the part Links; older patches get the default routing', () => {
    const { store, presets } = setup();
    presets.loadPatch(0, 'Ridgeline Lead');
    expect(store.get('parts.0.links')).toEqual(FACTORY_PATCHES.find(p => p.name === 'Ridgeline Lead').links);
    presets.loadPatch(0, 'Basalt Bass');
    expect(store.get('parts.0.links')).toEqual(defaultLinks());
    expect(patchLinks({ params: {} })).toEqual(defaultLinks());
  });

  it('saves, exports and re-imports a part Links', async () => {
    const { store, presets, storage } = setup();
    const links = [{ src: 0, dst: 'size', amt: 0.3, curve: 1 }, { src: 6, dst: 'warp', amt: -0.5, curve: 0 }];
    store.set('parts.1.links', JSON.parse(JSON.stringify(links)));
    const id = presets.savePatch(1, 'Expressive');
    expect(presets.getPatch(id).links).toEqual(links);
    // Saved links are a copy: editing the part later does not change the patch.
    store.set('parts.1.links.0.amt', 0.9);
    expect(presets.getPatch(id).links[0].amt).toBe(0.3);
    const again = setup(storage);
    again.presets.loadPatch(2, 'Expressive');
    expect(again.store.get('parts.2.links')).toEqual(links);
    const blob = again.presets.exportJSON('patch', id);
    const third = setup();
    await third.presets.importJSON(await blob.text());
    third.presets.loadPatch(0, 'Expressive');
    expect(third.store.get('parts.0.links')).toEqual(links);
  });

  it('sanitises imported Links', () => {
    const p = sanitizePatch({ name: 'x', params: { cutoff: 1000 }, links: [{ src: 99, dst: 'cutoff', amt: 5 }, { src: 0, dst: 'octave', amt: 0.2 }, 'junk'] });
    expect(p.links).toEqual([{ src: LINK_SOURCES.length - 1, dst: 'cutoff', amt: 1, curve: 0 }]);
    expect(sanitizePatch({ name: 'y', params: {} }).links).toBeUndefined();
  });

  it('random patches come with valid Links', () => {
    for (let seed = 1; seed < 40; seed++) {
      const patch = randomPatch(makeRng(seed));
      expect(patch.links[0]).toEqual({ src: 1, dst: 'morph', amt: 1, curve: 0 });
      const part = partWithPatch(defaultPart(0), patch);
      expect(sanitizePart(part, 0).links).toEqual(part.links);
    }
  });
});
