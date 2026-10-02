// Realistic fakes of the engine, visuals, music, presets and MIDI modules so the
// UI can be developed and tested on its own. They implement the same APIs as
// the real modules (docs/ARCHITECTURE.md plus the shared UI contract).

import {
  NUM_PARTS, PART_PARAMS, PART_PARAM_MAP, MOD_PARAM_IDS, MOD_DEFAULT, SYNC_DIVS, SEQ_STEPS,
  toNorm, clamp, mtof, stepToMidi, defaultPart, defaultState, defaultStep, SCALES, SCALE_NAMES, NOTE_NAMES,
} from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { createFlatMap } from '../../src/ui/flat-map.js';
import { createTerrainSource } from '../../src/ui/terrain-source.js';

function emitter() {
  const map = new Map();
  return {
    on(type, fn) { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); return () => map.get(type)?.delete(fn); },
    off(type, fn) { map.get(type)?.delete(fn); },
    emit(type, d) { for (const fn of [...(map.get(type) || [])]) { try { fn(d); } catch (e) { console.warn(e); } } },
  };
}

function lfo(shape, ph) {
  const p = ph - Math.floor(ph);
  switch (shape) {
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);
    case 2: return 2 * p - 1;
    case 3: return p < 0.5 ? 1 : -1;
    case 4: { const x = Math.sin(Math.floor(ph) * 91.7) * 4375.85; return (x - Math.floor(x)) * 2 - 1; }
    default: return Math.sin(2 * Math.PI * p * 0.7) * 0.6 + Math.sin(2 * Math.PI * p * 1.9) * 0.4;
  }
}

// ---------------------------------------------------------------------------- engine
export function createFakeEngine({ store }) {
  const ev = emitter();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const context = new Ctx();
  const master = context.createGain();
  master.gain.value = 0.25;
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  master.connect(analyser);
  analyser.connect(context.destination);
  const voices = new Map(); // `${part}:${note}` -> {osc, gain}
  const active = new Array(NUM_PARTS).fill(0);
  const env2 = new Array(NUM_PARTS).fill(0);
  let wheel = 0;

  function noteOn(part, note, vel = 0.8, time = 0) {
    const key = `${part}:${note}`;
    if (voices.has(key)) noteOff(part, note);
    const p = store.get(`parts.${part}.params`) || {};
    const t = Math.max(context.currentTime, time || 0);
    const osc = context.createOscillator();
    osc.type = ['sine', 'triangle', 'sawtooth', 'square'][part % 4];
    osc.frequency.value = mtof(note + 12 * (p.octave || 0) + (p.tune || 0));
    const filt = context.createBiquadFilter();
    filt.frequency.value = clamp(p.cutoff || 9000, 60, 16000);
    const g = context.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * (p.level ?? 0.75) * 0.6, t + Math.max(0.005, p.attack || 0.005));
    g.gain.setTargetAtTime(vel * (p.level ?? 0.75) * 0.6 * (p.sustain ?? 0.75), t + (p.attack || 0.005), (p.decay || 0.3) / 3);
    osc.connect(filt).connect(g).connect(master);
    osc.start(t);
    voices.set(key, { osc, g, part });
    active[part] += 1;
    env2[part] = 1;
  }
  function noteOff(part, note, time = 0) {
    const key = `${part}:${note}`;
    const v = voices.get(key);
    if (!v) return;
    voices.delete(key);
    active[part] = Math.max(0, active[part] - 1);
    const t = Math.max(context.currentTime, time || 0);
    const rel = (store.get(`parts.${part}.params.release`) || 0.4);
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setTargetAtTime(0, t, rel / 4);
    v.osc.stop(t + rel * 2 + 0.05);
  }
  function allNotesOff(part) {
    for (const [key, v] of [...voices]) if (part == null || v.part === part) noteOff(v.part, Number(key.split(':')[1]));
  }

  // Terrain tables (generated from the DSP module; regenerated on change).
  const terrains = createTerrainSource({ store, engine: null });
  terrains.on((part, slot) => {
    const t = terrains.get(part, slot);
    if (t) ev.emit('terrain', { part, slot, size: t.size, data: t.data });
  });

  // Telemetry at ~60 Hz, like the worklet.
  const t0 = performance.now();
  const timeBuf = new Float32Array(1024);
  setInterval(() => {
    const part = Math.round(store.get('ui.selectedPart') || 0);
    const now = (performance.now() - t0) / 1000;
    const params = store.get(`parts.${part}.params`) || {};
    const mods = store.get(`parts.${part}.mods`) || {};
    const tempo = store.get('global.tempo') || 120;
    const n = {};
    env2[part] *= 0.97;
    for (const id of MOD_PARAM_IDS) {
      const m = { ...MOD_DEFAULT, ...(mods[id] || {}) };
      const hz = m.lfoSync ? (tempo / 60) / SYNC_DIVS[m.lfoDiv].beats : m.lfoRate;
      let v = toNorm(PART_PARAM_MAP[id], params[id] ?? PART_PARAM_MAP[id].default) + lfo(m.lfoShape, now * hz) * m.lfoDepth + env2[part] * m.envDepth;
      if (id === 'morph') v += wheel;
      n[id] = id === 'rotate' || id === 'centerX' || id === 'centerY' ? v - Math.floor(v) : clamp(v, 0, 1);
    }
    analyser.getFloatTimeDomainData(timeBuf);
    let pk = 0;
    for (let i = 0; i < timeBuf.length; i += 2) pk = Math.max(pk, Math.abs(timeBuf[i]));
    const A = terrains.get(part, 'A');
    let th = null;
    if (A && A.data) {
      const x = Math.floor(((n.centerX ?? 0.5) % 1) * A.size), y = Math.floor(((n.centerY ?? 0.5) % 1) * A.size);
      th = A.data[y * A.size + x];
    }
    ev.emit('tele', {
      t: 'tele', part, n, spinPhase: (now * (params.spin || 0)) % 1,
      voices: [], peak: [pk, pk * 0.96], activeVoices: [...active], terrainHeight: th,
    });
  }, 16);

  return {
    context, analyser, mode: 'worklet',
    async start() { await context.resume(); },
    noteOn, noteOff, allNotesOff,
    panic() { allNotesOff(); },
    bend() {},
    wheel(part, v) { wheel = v; },
    on: ev.on, off: ev.off,
    getTerrain: (part, slot) => terrains.get(part, slot),
    async importTerrainFile(part, slot, file) {
      if (!file) throw new Error('No file');
      if (/\.wav$/i.test(file.name) || file.type.startsWith('audio/')) throw new Error('Unsupported format: this demo engine only imports images');
      if (!file.type.startsWith('image/')) throw new Error('Unsupported format');
      const bmp = await createImageBitmap(file);
      const W = 64, H = 64;
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0, W, H);
      const img = g.getImageData(0, 0, W, H).data;
      const bytes = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) bytes[i] = Math.round(img[i * 4] * 0.3 + img[i * 4 + 1] * 0.59 + img[i * 4 + 2] * 0.11);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      store.batch(() => {
        store.set(`parts.${part}.userTerrain.${slot}`, { name: file.name.replace(/\.[^.]+$/, ''), kind: 'image', w: W, h: H, mirror: 1, data: btoa(bin) }, { source: 'engine' });
        store.set(`parts.${part}.params.terrain${slot}`, TERRAIN_INDEX.user, { source: 'engine' });
      });
    },
    async startRecording() { this._rec = performance.now(); },
    async stopRecording() {
      const secs = Math.max(0.1, (performance.now() - (this._rec || performance.now())) / 1000);
      const frames = Math.round(48000 * Math.min(secs, 2));
      const buf = new ArrayBuffer(44 + frames * 6);
      const dv = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); dv.setUint32(4, 36 + frames * 6, true); w(8, 'WAVE'); w(12, 'fmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 48000, true);
      dv.setUint32(28, 48000 * 6, true); dv.setUint16(32, 6, true); dv.setUint16(34, 24, true); w(36, 'data'); dv.setUint32(40, frames * 6, true);
      return new Blob([buf], { type: 'audio/wav' });
    },
    level() { return clamp(active.reduce((a, b) => a + b, 0) * 0.2, 0, 1); },
    setQuality(mode) { this.quality = mode; },
    async bounce({ bars = 4, stems = false } = {}) {
      for (let i = 1; i <= 8; i++) { await new Promise(r => setTimeout(r, 60)); ev.emit('bounce', { done: i, total: 8 }); }
      const mk = () => this.stopRecording();
      return { mix: await mk(), stems: stems ? await Promise.all([0, 1, 2, 3].map(mk)) : [], bars };
    },
    async listOutputDevices() { return [{ deviceId: 'default', label: 'System default' }, { deviceId: 'mpc', label: 'MPC XL (USB audio)' }]; },
    async setOutputDevice(id) { this.outputDeviceId = id; },
    outputDeviceId: 'default',
  };
}

// ---------------------------------------------------------------------------- visuals
export function createFakeVisuals(container, { store, engine }) {
  const terrains = createTerrainSource({ store, engine });
  const map = createFlatMap(container, { store, terrains, tele: null, source: 'visual' });
  map.el.classList.add('fake-visuals');
  let state = { view: 'orbit', quality: 'high', style: 'relief', rotate: true };
  return {
    palettes: ['Natural', 'Aurora', 'Ember', 'Mono'],
    setView(v) { state.view = v; },
    setQuality(q) { state.quality = q; },
    setRenderStyle(s) { state.style = s; },
    setAutoRotate(r) { state.rotate = r; },
    resize() {},
    dispose() { map.dispose(); },
    get state() { return state; },
  };
}

// ---------------------------------------------------------------------------- music
export function createFakeMusic({ store, engine }) {
  const rEv = emitter();
  const tEv = emitter();
  const held = Array.from({ length: NUM_PARTS }, () => new Set());
  const sustained = Array.from({ length: NUM_PARTS }, () => new Set());
  const sustainOn = new Array(NUM_PARTS).fill(false);
  const sel = () => Math.round(store.get('ui.selectedPart') || 0);
  const resolve = (part) => {
    if (part !== 'sel') return [part];
    if (store.get('global.keyMode') === 1) {
      const list = [];
      for (let p = 0; p < NUM_PARTS; p++) if (!store.get(`parts.${p}.params.mute`)) list.push(p);
      return list.length ? list : [sel()];
    }
    return [sel()];
  };
  const router = {
    noteOn(part, note, vel = 0.8, source = 'ui') {
      for (const p of resolve(part)) {
        engine?.noteOn(p, note, vel);
        held[p].add(note);
        sustained[p].delete(note);
        rEv.emit('note', { part: p, note, vel, on: true, source });
      }
    },
    noteOff(part, note, source = 'ui') {
      for (const p of resolve(part)) {
        if (sustainOn[p]) { sustained[p].add(note); continue; }
        engine?.noteOff(p, note);
        held[p].delete(note);
        rEv.emit('note', { part: p, note, vel: 0, on: false, source });
      }
    },
    sustain(part, on) {
      for (const p of resolve(part)) {
        sustainOn[p] = on;
        if (!on) for (const n of [...sustained[p]]) { sustained[p].delete(n); engine?.noteOff(p, n); held[p].delete(n); rEv.emit('note', { part: p, note: n, vel: 0, on: false }); }
      }
    },
    allNotesOff(part) {
      for (let p = 0; p < NUM_PARTS; p++) {
        if (part != null && p !== part) continue;
        for (const n of [...held[p]]) { engine?.noteOff(p, n); rEv.emit('note', { part: p, note: n, vel: 0, on: false }); }
        held[p].clear();
      }
    },
    heldNotes: (part) => new Set(held[part === 'sel' ? sel() : part]),
    resolve,
    on: rEv.on, off: rEv.off,
  };

  let playing = false, timer = 0, step = 0;
  function tick() {
    const tempo = store.get('global.tempo') || 120;
    for (let p = 0; p < NUM_PARTS; p++) {
      const seq = store.get(`parts.${p}.seq`);
      if (!seq || !seq.enabled) continue;
      const i = step % seq.length;
      tEv.emit('step', { part: p, step: i, time: engine ? engine.context.currentTime : 0 });
      const st = seq.steps[i];
      if (st && st.on && !store.get(`parts.${p}.params.mute`)) {
        const note = stepToMidi(st, seq.baseOctave, store.get('global.scaleRoot'), store.get('global.scaleType'));
        engine?.noteOn(p, note, st.accent ? 1 : st.vel);
        rEv.emit('note', { part: p, note, vel: st.vel, on: true, source: 'seq' });
        const dur = (60 / tempo / 4) * st.gate * 1000;
        setTimeout(() => { engine?.noteOff(p, note); rEv.emit('note', { part: p, note, vel: 0, on: false, source: 'seq' }); }, dur);
      }
    }
    step += 1;
    timer = setTimeout(tick, (60 / (store.get('global.tempo') || 120) / 4) * 1000);
  }
  const transport = {
    play() { if (playing) return; playing = true; step = 0; store.set('ui.playing', 1); tEv.emit('state', { playing: true, external: false }); tick(); },
    stop() { if (!playing) return; playing = false; clearTimeout(timer); store.set('ui.playing', 0); tEv.emit('state', { playing: false, external: false }); },
    toggle() { if (playing) this.stop(); else this.play(); return playing; },
    isPlaying: () => playing,
    position: () => ({ bar: Math.floor(step / 16), beat: Math.floor(step / 4) % 4, step: step % 16 }),
    on: tEv.on, off: tEv.off,
  };
  return {
    router, transport,
    preview(part = 'sel') {
      const p = part === 'sel' ? sel() : part;
      [0, 4, 7, 12].forEach((d, i) => setTimeout(() => { router.noteOn(p, 57 + d, 0.8, 'preview'); setTimeout(() => router.noteOff(p, 57 + d, 'preview'), 160); }, i * 180));
    },
    renderEvents(bars) { return Array.from({ length: bars * 4 }, (_, i) => ({ time: i * 0.5, msg: { t: 'noteOn', part: 0, note: 57, vel: 0.8 } })); },
    randomizePattern(part, { density = 0.6 } = {}) {
      const len = (SCALES[SCALE_NAMES[store.get('global.scaleType')]] || SCALES.Minor).length;
      store.set(`parts.${part}.seq.steps`, Array.from({ length: SEQ_STEPS }, (_, i) => ({ ...defaultStep(), on: Math.random() < (i % 4 ? density : 0.9) ? 1 : 0, degree: Math.floor(Math.random() * (len + 2)) - 1, vel: 0.5 + Math.random() * 0.5, gate: 0.3 + Math.random() * 0.6, accent: Math.random() < 0.15 ? 1 : 0, slide: Math.random() < 0.1 ? 1 : 0 })));
    },
    clearPattern(part) { store.set(`parts.${part}.seq.steps`, Array.from({ length: SEQ_STEPS }, defaultStep)); },
    shiftPattern(part, dir) {
      const s = store.get(`parts.${part}.seq.steps`);
      const out = dir > 0 ? [s[SEQ_STEPS - 1], ...s.slice(0, -1)] : [...s.slice(1), s[0]];
      store.set(`parts.${part}.seq.steps`, out.map(x => ({ ...x })));
    },
  };
}

// ---------------------------------------------------------------------------- presets
const FACTORY = [
  { name: 'Glass Orbit', category: 'Keys', tags: ['bell', 'clean'], params: { terrainA: 0, terrainB: 2, morph: 0.3, cutoff: 6000, pathShape: 0, size: 0.18 } },
  { name: 'Canyon Bass', category: 'Bass', tags: ['deep'], params: { terrainA: 9, terrainB: 5, morph: 0.4, cutoff: 900, resonance: 0.4, octave: -1, pathShape: 3 }, mods: { morph: { lfoDepth: 0.25, lfoRate: 0.3 } } },
  { name: 'Dune Walker', category: 'Bass', tags: ['moving'], params: { terrainA: 3, pathShape: 1, cutoff: 1400, drive: 0.4 } },
  { name: 'Ridge Lead', category: 'Lead', tags: ['bright', 'buzz'], params: { terrainA: 4, terrainB: 7, fold: 0.35, cutoff: 9000, glide: 0.06, polyMode: 1 } },
  { name: 'Vortex Sync', category: 'Lead', tags: ['spin'], params: { terrainA: 12, spin: 0.6, size: 0.3 }, mods: { size: { lfoDepth: 0.2, lfoRate: 2 } } },
  { name: 'Cloud Massif', category: 'Pad', tags: ['slow', 'wide'], params: { terrainA: 5, terrainB: 0, attack: 1.2, release: 2.5, unison: 3, detune: 18 }, mods: { morph: { lfoDepth: 0.4, lfoRate: 0.08 }, centerX: { lfoDepth: 0.15, lfoRate: 0.05, lfoShape: 5 } } },
  { name: 'Ripple Choir', category: 'Pad', tags: ['vocal'], params: { terrainA: 1, pathShape: 2, attack: 0.8, release: 2 } },
  { name: 'Lattice Pluck', category: 'Pluck', tags: ['short'], params: { terrainA: 11, decay: 0.2, sustain: 0, release: 0.2 } },
  { name: 'Crater Drops', category: 'Pluck', tags: ['percussive'], params: { terrainA: 6, decay: 0.15, sustain: 0, filterEnv: 0.6 } },
  { name: 'Terrace Grit', category: 'Texture', tags: ['noise'], params: { terrainA: 7, warp: 0.5, fold: 0.5 } },
  { name: 'Cell Breath', category: 'Texture', tags: ['airy'], params: { terrainA: 8, warp: 0.3, attack: 0.5 }, mods: { warp: { lfoDepth: 0.3, lfoRate: 0.2 } } },
  { name: 'Spectra Keys', category: 'Keys', tags: ['wavetable'], params: { terrainA: 10, pathShape: 6, size: 0.5 } },
];
const SCENES = [
  { name: 'Night Drive', description: 'Rolling bass, glassy keys and a slow pad under the stars.', tempo: 104, key: 'A Minor' },
  { name: 'Copper Morning', description: 'Warm plucks over a drifting texture.', tempo: 92, key: 'D Dorian' },
  { name: 'Ridge Runner', description: 'Fast arps and a biting lead.', tempo: 128, key: 'E Phrygian' },
];

export function createFakePresets({ store }) {
  const ev = emitter();
  let user = [];
  let userScenes = [];
  let nextId = 1;
  const factory = FACTORY.map((p, i) => ({ ...p, id: 'f' + i, factory: true }));
  const fscenes = SCENES.map((s, i) => ({ ...s, id: 's' + i, factory: true }));
  const all = () => [...factory, ...user];
  function apply(part, patch) {
    const cur = store.get(`parts.${part}`);
    const base = defaultPart(part);
    const mods = { ...base.mods };
    for (const [id, m] of Object.entries(patch.mods || {})) mods[id] = { ...MOD_DEFAULT, ...m };
    store.set(`parts.${part}`, { ...cur, params: { ...base.params, ...(patch.params || {}) }, mods, patchName: patch.name });
  }
  return {
    patches: () => all().map(({ id, name, category, factory: f, tags }) => ({ id, name, category, factory: !!f, tags: tags || [] })),
    categories: () => ['Bass', 'Lead', 'Pad', 'Keys', 'Pluck', 'Texture', 'User'],
    loadPatch(part, id) { const p = all().find(x => x.id === id); if (p) { apply(part, p); ev.emit('change'); } },
    nextPatch(part, dir) {
      const list = all();
      const i = list.findIndex(x => x.name === store.get(`parts.${part}.patchName`));
      const n = list[(i + dir + list.length) % list.length];
      apply(part, n);
      ev.emit('change');
    },
    savePatch(part, name) {
      const id = 'u' + nextId++;
      user.push({ id, name, category: 'User', factory: false, params: { ...store.get(`parts.${part}.params`) }, mods: store.get(`parts.${part}.mods`) });
      store.set(`parts.${part}.patchName`, name);
      ev.emit('change');
      return id;
    },
    initPatch(part) { apply(part, { name: 'Init', params: {} }); ev.emit('change'); },
    randomizePatch(part) {
      const params = {};
      for (const d of PART_PARAMS) {
        if (['level', 'pan', 'mute', 'solo', 'delaySend', 'reverbSend', 'octave', 'tune', 'bendRange', 'polyMode'].includes(d.id)) continue;
        if (d.id === 'terrainA' || d.id === 'terrainB') { params[d.id] = Math.floor(Math.random() * 13); continue; }
        params[d.id] = d.curve === 'int' || d.curve === 'enum' ? Math.round(d.min + Math.random() * (d.max - d.min)) : d.min + Math.random() * (d.max - d.min) * 0.8;
      }
      params.attack = 0.01 + Math.random() * 0.3; params.sustain = 0.6;
      apply(part, { name: 'Random ' + Math.floor(Math.random() * 900 + 100), params });
      ev.emit('change');
    },
    scenes: () => [...fscenes, ...userScenes].map(({ id, name, factory: f, description, tempo, key }) => ({ id, name, factory: !!f, description, tempo, key })),
    loadScene(idOrIndex) {
      const list = [...fscenes, ...userScenes];
      const sc = typeof idOrIndex === 'number' ? list[idOrIndex] : list.find(s => s.id === idOrIndex);
      if (!sc) return;
      if (sc.state) { store.load(migrateState(sc.state)); ev.emit('change'); return; }
      const st = defaultState();
      st.global.tempo = sc.tempo;
      const picks = [[1, 0], [0, 3], [5, 7], [2, 8]];
      for (let p = 0; p < NUM_PARTS; p++) {
        const pat = factory[picks[p][0] + (sc.id === 's1' ? 1 : 0)] || factory[p];
        const base = defaultPart(p);
        st.parts[p] = { ...base, params: { ...base.params, ...pat.params }, patchName: pat.name };
        st.parts[p].seq.enabled = p < 2 ? 1 : 0;
        st.parts[p].seq.steps = st.parts[p].seq.steps.map((s, i) => ({ ...s, on: (i * (p + 3)) % 5 === 0 ? 1 : 0, degree: (i * 3 + p) % 7 }));
      }
      store.load(migrateState(st));
      ev.emit('change');
    },
    saveScene(name) {
      const id = 'us' + nextId++;
      userScenes.push({ id, name, factory: false, description: 'Your scene', tempo: store.get('global.tempo'), key: NOTE_NAMES[store.get('global.scaleRoot')] + ' ' + SCALE_NAMES[store.get('global.scaleType')], state: store.serialize() });
      ev.emit('change');
      return id;
    },
    deleteUser(kind, id) {
      if (kind === 'patch') user = user.filter(p => p.id !== id); else userScenes = userScenes.filter(s => s.id !== id);
      ev.emit('change');
    },
    exportJSON() { return new Blob([JSON.stringify({ orograph: 1, patches: user, scenes: userScenes })], { type: 'application/json' }); },
    async importJSON(file) {
      const data = JSON.parse(await file.text());
      if (!data || !data.orograph) throw new Error('Not an Orograph file');
      for (const p of data.patches || []) user.push({ ...p, id: 'u' + nextId++ });
      for (const s of data.scenes || []) userScenes.push({ ...s, id: 'us' + nextId++ });
      ev.emit('change');
      return { patches: (data.patches || []).length, scenes: (data.scenes || []).length };
    },
    on: ev.on, off: ev.off,
  };
}

// ---------------------------------------------------------------------------- MIDI
export function createFakeMidi({ store, unsupported = false } = {}) {
  const ev = emitter();
  let settings = { channelMode: 'omni', omniTarget: 'sel', multiChannels: [1, 2, 3, 4], padMode: 'notes', padBaseNote: 36, velocityCurve: 'linear', outputId: null, sendNotes: false, outChannels: [1, 2, 3, 4], sendClock: false, followClock: false, programChange: false, mpe: false, outputAuto: true };
  let mappings = [];
  let inputs = [];
  let outputs = [];
  let pendingLearn = null;
  let activityTimer = 0;
  const midi = {
    supported: !unsupported,
    secure: true,
    status: unsupported ? 'unsupported' : 'idle',
    error: null,
    externalClock: { active: false, bpm: 0 },
    get output() { const o = outputs.find(x => x.id === settings.outputId); return o ? { id: o.id, name: o.name } : null; },
    learnPadBase() { return new Promise(r => setTimeout(() => { settings = { ...settings, padBaseNote: 37 }; ev.emit('change', { type: 'settings' }); r(37); }, 700)); },
    async connect() {
      if (unsupported) return;
      midi.status = 'connecting';
      ev.emit('change', { type: 'status' });
      await new Promise(r => setTimeout(r, 250));
      inputs = [
        { id: 'in-mpc', name: 'MPC MIDI 1', manufacturer: 'Akai Professional', state: 'connected', enabled: true, isMpc: true },
        { id: 'in-iac', name: 'IAC Driver Bus 1', manufacturer: 'Apple Inc.', state: 'connected', enabled: false, isMpc: false },
      ];
      outputs = [
        { id: 'out-mpc', name: 'MPC MIDI 1', manufacturer: 'Akai Professional', state: 'connected', isMpc: true },
        { id: 'out-iac', name: 'IAC Driver Bus 1', manufacturer: 'Apple Inc.', state: 'connected', isMpc: false },
      ];
      settings.outputId = 'out-mpc';
      midi.status = 'ready';
      ev.emit('change', { type: 'devices' });
      clearInterval(activityTimer);
      activityTimer = setInterval(() => ev.emit('activity', { dir: Math.random() < 0.8 ? 'in' : 'out', kind: 'clock', port: 'in-mpc' }), 450);
    },
    inputs: () => inputs.map(p => ({ ...p })),
    outputs: () => outputs.map(p => ({ ...p })),
    setInputEnabled(id, on) { const p = inputs.find(x => x.id === id); if (p) { p.enabled = !!on; ev.emit('change', { type: 'devices' }); } },
    getSettings: () => ({ ...settings, multiChannels: [...settings.multiChannels], outChannels: [...settings.outChannels] }),
    setSetting(key, value) {
      if (key === 'outputId') { settings = { ...settings, outputAuto: value === 'auto', outputId: value === 'auto' ? 'out-mpc' : value }; ev.emit('change', { type: 'settings' }); return; }
      settings = { ...settings, [key]: value };
      if (key === 'followClock') midi.externalClock = { active: !!value, bpm: value ? 120 : 0 };
      ev.emit('change', { type: 'settings' });
    },
    mappings: () => mappings.map(m => ({ ...m, target: { ...m.target } })),
    learn(target) {
      if (pendingLearn) pendingLearn.reject(new Error('cancelled'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingLearn = null;
          const cc = 16 + (mappings.length % 16);
          mappings = mappings.filter(m => !(m.target.scope === target.scope && m.target.id === target.id && String(m.target.part) === String(target.part)) && m.cc !== cc);
          const m = { cc, channel: null, target: { ...target } };
          mappings.push(m);
          ev.emit('learn', { target, cc, channel: 1 });
          ev.emit('change', { type: 'mappings' });
          resolve(m);
        }, 900);
        pendingLearn = { reject: (e) => { clearTimeout(timer); reject(e); } };
      });
    },
    cancelLearn() { if (pendingLearn) { pendingLearn.reject(new Error('cancelled')); pendingLearn = null; } },
    unmap(ccOrTarget) {
      mappings = mappings.filter(m => typeof ccOrTarget === 'number' ? m.cc !== ccOrTarget : !(m.target.scope === ccOrTarget.scope && m.target.id === ccOrTarget.id && String(m.target.part) === String(ccOrTarget.part)));
      ev.emit('change', { type: 'mappings' });
    },
    clearMappings() { mappings = []; ev.emit('change', { type: 'mappings' }); },
    qlinkTargets: () => ['centerX', 'centerY', 'size', 'rotate', 'morph', 'warp', 'fold', 'lift', 'pathParam', 'stretch', 'cutoff', 'resonance', 'drive', 'filterEnv', 'reverbSend', 'delaySend'].map(id => ({ scope: 'part', part: 'sel', id })),
    panic() {},
    on: ev.on, off: ev.off,
  };
  return midi;
}

