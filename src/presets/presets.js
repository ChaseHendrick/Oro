// Patch and scene library: factory content plus the user's own presets, kept
// in localStorage. Patches change one part's sound; scenes replace the whole
// session (all four parts, sequences, mix, effects, tempo and key).

import {
  NUM_PARTS, PART_PARAMS, PART_PARAM_MAP, NOTE_NAMES, SCALE_NAMES, MOD_PARAM_IDS, PEDAL_PARAM_IDS, defaultPart,
} from '../core/params.js';
import { sanitizeParams, sanitizeMods, sanitizePart, sanitizeLinks, migrateState } from '../core/migrate.js';
import { createEmitter } from '../music/emitter.js';
import { FACTORY_PATCHES, CATEGORIES } from './factory-patches.js';
import { FACTORY_SCENES } from './factory-scenes.js';
import { partWithPatch, compactMods } from './apply.js';
import { randomPatch } from './random-patch.js';

export const STORAGE_KEY = 'orograph.presets.v1';
export const FORMAT = 'orograph-presets';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const FACTORY_PATCH_LIST = FACTORY_PATCHES.map(p => ({ ...p, id: 'f-' + slug(p.name), factory: true }));
const FACTORY_SCENE_LIST = FACTORY_SCENES.map(s => ({ ...s, id: 'f-' + slug(s.name), factory: true }));

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function newId() {
  return 'u-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/** Keep only known part parameters, clamped and rounded like a full migration would. */
function sanitizePatchParams(src) {
  if (!src || typeof src !== 'object') return {};
  const full = sanitizeParams(PART_PARAMS, src);
  const out = {};
  for (const id of Object.keys(src)) if (PART_PARAM_MAP[id] && id !== 'mute' && id !== 'solo' && !PEDAL_PARAM_IDS.includes(id)) out[id] = full[id];
  return out;
}

function sanitizePatchMods(src) {
  if (!src || typeof src !== 'object') return {};
  const full = sanitizeMods(src);
  const out = {};
  for (const id of Object.keys(src)) if (MOD_PARAM_IDS.includes(id)) out[id] = full[id];
  return compactMods(out);
}

export function sanitizePatch(src) {
  if (!src || typeof src !== 'object' || !src.params || typeof src.params !== 'object') return null;
  const clean = sanitizePart({ dot: src.dot, userTerrain: src.userTerrain }, 0);
  const patch = {
    name: String(src.name || 'Imported patch').slice(0, 60),
    category: typeof src.category === 'string' && src.category.trim() ? src.category.trim().slice(0, 30) : 'User',
    tags: Array.isArray(src.tags) ? src.tags.filter(t => typeof t === 'string').slice(0, 8) : [],
    params: sanitizePatchParams(src.params),
    mods: sanitizePatchMods(src.mods),
  };
  // Patches from before Links existed have none and load with the default routing.
  if (Array.isArray(src.links)) patch.links = sanitizeLinks(src.links);
  if (src.dot) patch.dot = clean.dot;
  if (clean.userTerrain.A || clean.userTerrain.B) patch.userTerrain = clean.userTerrain;
  return patch;
}

export function sanitizeScene(src) {
  if (!src || typeof src !== 'object' || !Array.isArray(src.parts)) return null;
  return {
    ...migrateState(src),
    name: String(src.name || 'Imported scene').slice(0, 60),
    description: typeof src.description === 'string' ? src.description.slice(0, 400) : '',
  };
}

export function createPresets({ store, storage = safeStorage(), random = Math.random } = {}) {
  if (!store) throw new Error('createPresets needs a store');
  const emitter = createEmitter();
  let user = { patches: [], scenes: [] };

  function load() {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      user.patches = (Array.isArray(data.patches) ? data.patches : [])
        .map(p => { const s = sanitizePatch(p); return s && { ...s, id: typeof p.id === 'string' ? p.id : newId() }; })
        .filter(Boolean);
      user.scenes = (Array.isArray(data.scenes) ? data.scenes : [])
        .map(s => { const c = sanitizeScene(s); return c && { ...c, id: typeof s.id === 'string' ? s.id : newId() }; })
        .filter(Boolean);
    } catch { user = { patches: [], scenes: [] }; }
  }

  function persist() {
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ format: FORMAT, version: 1, patches: user.patches, scenes: user.scenes }));
      return true;
    } catch { return false; }
  }

  load();

  const changed = (detail) => emitter.emit('change', detail);

  // ---------------------------------------------------------------- patches

  function allPatches() {
    return [...FACTORY_PATCH_LIST, ...user.patches.map(p => ({ ...p, factory: false }))];
  }

  function patches() {
    return allPatches().map(p => ({ id: p.id, name: p.name, category: p.category, factory: !!p.factory, tags: (p.tags || []).slice() }));
  }

  function categories() {
    const extra = new Set(user.patches.map(p => p.category).filter(c => !CATEGORIES.includes(c)));
    return [...CATEGORIES, ...extra];
  }

  function findPatch(idOrObj) {
    if (idOrObj && typeof idOrObj === 'object') return sanitizePatch(idOrObj);
    const list = allPatches();
    return list.find(p => p.id === idOrObj) || list.find(p => p.name === idOrObj) || null;
  }

  function partIndex(part) {
    const p = part === 'sel' || part == null ? store.get('ui.selectedPart') || 0 : Number(part);
    return Number.isInteger(p) && p >= 0 && p < NUM_PARTS ? p : null;
  }

  function applyToPart(p, patch, action) {
    const current = store.get(`parts.${p}`) || defaultPart(p);
    const next = sanitizePart(partWithPatch(current, patch), p);
    store.set(`parts.${p}`, next, { source: 'preset' });
    changed({ kind: 'patch', action, part: p, id: patch.id || null });
  }

  function loadPatch(part, idOrObj) {
    const p = partIndex(part);
    const patch = findPatch(idOrObj);
    if (p == null || !patch) return false;
    applyToPart(p, patch, 'load');
    return true;
  }

  function nextPatch(part, dir = 1) {
    const p = partIndex(part);
    if (p == null) return null;
    const list = allPatches();
    const name = store.get(`parts.${p}.patchName`);
    const idx = list.findIndex(x => x.name === name);
    const step = dir < 0 ? -1 : 1;
    const next = idx < 0 ? (step > 0 ? list[0] : list[list.length - 1]) : list[(idx + step + list.length) % list.length];
    applyToPart(p, next, 'load');
    return next.id;
  }

  function uniqueName(name, list, exceptId) {
    const base = String(name || 'Untitled').trim().slice(0, 60) || 'Untitled';
    const taken = new Set(list.filter(x => x.id !== exceptId).map(x => x.name));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) { const c = `${base.slice(0, 54)} ${n}`; if (!taken.has(c)) return c; }
    return base + ' ' + Date.now();
  }

  function savePatch(part, name, { category } = {}) {
    const p = partIndex(part);
    if (p == null) return null;
    const cur = store.get(`parts.${p}`);
    const clean = String(name || cur.patchName || 'My patch').trim().slice(0, 60) || 'My patch';
    // Saving under the name of one of your own patches updates it in place.
    const existing = user.patches.find(x => x.name === clean);
    const from = allPatches().find(x => x.name === cur.patchName);
    const params = { ...cur.params };
    delete params.mute;
    delete params.solo;
    for (const id of PEDAL_PARAM_IDS) delete params[id];
    const patch = {
      id: existing ? existing.id : newId(),
      name: existing ? clean : uniqueName(clean, FACTORY_PATCH_LIST),
      category: category && typeof category === 'string' ? category.slice(0, 30) : (from ? from.category : 'User'),
      tags: from ? (from.tags || []).slice() : [],
      params,
      mods: compactMods(cur.mods),
      links: sanitizeLinks(cur.links),
      // A deep copy: the dot holds arrays (waypoints) that later edits to the part must not reach.
      dot: JSON.parse(JSON.stringify(cur.dot || {})),
    };
    if (cur.userTerrain && (cur.userTerrain.A || cur.userTerrain.B)) patch.userTerrain = { ...cur.userTerrain };
    if (existing) user.patches[user.patches.indexOf(existing)] = patch;
    else user.patches.push(patch);
    persist();
    store.set(`parts.${p}.patchName`, patch.name, { source: 'preset' });
    changed({ kind: 'patch', action: 'save', id: patch.id });
    return patch.id;
  }

  function initPatch(part) {
    const p = partIndex(part);
    if (p == null) return;
    applyToPart(p, { name: 'Init', params: {} }, 'init');
  }

  function randomizePatch(part, { rng = random } = {}) {
    const p = partIndex(part);
    if (p == null) return null;
    const patch = randomPatch(rng);
    applyToPart(p, patch, 'random');
    return patch;
  }

  // ----------------------------------------------------------------- scenes

  function allScenes() {
    return [...FACTORY_SCENE_LIST, ...user.scenes.map(s => ({ ...s, factory: false }))];
  }

  function scenes() {
    return allScenes().map(s => ({
      id: s.id, name: s.name, factory: !!s.factory, description: s.description || '',
      tempo: s.global.tempo,
      key: `${NOTE_NAMES[s.global.scaleRoot] || 'C'} ${SCALE_NAMES[s.global.scaleType] || 'Major'}`,
    }));
  }

  function findScene(idOrIndex) {
    const list = allScenes();
    if (typeof idOrIndex === 'number') return list[idOrIndex] || null;
    if (idOrIndex && typeof idOrIndex === 'object') return sanitizeScene(idOrIndex);
    return list.find(s => s.id === idOrIndex) || list.find(s => s.name === idOrIndex) || null;
  }

  function loadScene(idOrIndex) {
    const scene = findScene(idOrIndex);
    if (!scene) return false;
    store.load(migrateState(scene), { source: 'scene' });
    changed({ kind: 'scene', action: 'load', id: scene.id || null });
    return true;
  }

  function saveScene(name, { description = '' } = {}) {
    const clean = String(name || 'My scene').trim().slice(0, 60) || 'My scene';
    const existing = user.scenes.find(s => s.name === clean);
    const scene = {
      ...migrateState(store.serialize()),
      id: existing ? existing.id : newId(),
      name: existing ? clean : uniqueName(clean, FACTORY_SCENE_LIST),
      description: String(description || '').slice(0, 400),
    };
    if (existing) user.scenes[user.scenes.indexOf(existing)] = scene;
    else user.scenes.push(scene);
    persist();
    changed({ kind: 'scene', action: 'save', id: scene.id });
    return scene.id;
  }

  function deleteUser(kind, id) {
    const key = kind === 'scene' ? 'scenes' : 'patches';
    const before = user[key].length;
    user[key] = user[key].filter(x => x.id !== id && x.name !== id);
    if (user[key].length === before) return false;
    persist();
    changed({ kind: kind === 'scene' ? 'scene' : 'patch', action: 'delete', id });
    return true;
  }

  // ---------------------------------------------------------- import/export

  const stripPatch = (p) => {
    const { id, factory, ...rest } = p;
    return rest;
  };
  const stripScene = (s) => {
    const { id, factory, ...rest } = s;
    return rest;
  };

  function exportJSON(kind = 'all', id) {
    let data;
    if (kind === 'patch') {
      const p = id != null ? findPatch(id) : null;
      data = { format: FORMAT, version: 1, patches: p ? [stripPatch(p)] : user.patches.map(stripPatch), scenes: [] };
    } else if (kind === 'scene') {
      const s = id != null ? findScene(id) : null;
      data = { format: FORMAT, version: 1, patches: [], scenes: s ? [stripScene(s)] : user.scenes.map(stripScene) };
    } else if (kind === 'current') {
      data = { format: FORMAT, version: 1, patches: [], scenes: [{ ...migrateState(store.serialize()), name: 'Current session', description: '' }] };
    } else {
      data = { format: FORMAT, version: 1, patches: user.patches.map(stripPatch), scenes: user.scenes.map(stripScene) };
    }
    return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  }

  async function importJSON(file) {
    const text = typeof file === 'string' ? file : await file.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
    const items = Array.isArray(data) ? data : data && data.format === FORMAT ? [...(data.patches || []), ...(data.scenes || [])] : [data];
    let patchCount = 0, sceneCount = 0;
    for (const item of items) {
      if (item && Array.isArray(item.parts)) {
        const s = sanitizeScene(item);
        if (!s) continue;
        s.name = uniqueName(s.name, allScenes());
        user.scenes.push({ ...s, id: newId() });
        sceneCount++;
      } else {
        const p = sanitizePatch(item);
        if (!p) continue;
        p.name = uniqueName(p.name, allPatches());
        user.patches.push({ ...p, id: newId() });
        patchCount++;
      }
    }
    if (!patchCount && !sceneCount) throw new Error('No Orograph patches or scenes were found in that file.');
    persist();
    changed({ kind: 'import', action: 'import', patches: patchCount, scenes: sceneCount });
    return { patches: patchCount, scenes: sceneCount };
  }

  return {
    patches, categories, loadPatch, nextPatch, savePatch, initPatch, randomizePatch,
    scenes, loadScene, saveScene, deleteUser, exportJSON, importJSON,
    getPatch: (id) => { const p = findPatch(id); return p ? JSON.parse(JSON.stringify(p)) : null; },
    getScene: (id) => { const s = findScene(id); return s ? JSON.parse(JSON.stringify(s)) : null; },
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
  };
}

export { CATEGORIES };
