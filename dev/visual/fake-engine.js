// A stand-in for the audio engine (src/audio/engine.js) that the 3D map can
// run against on its own. It honours the parts of the engine API the visuals
// use: on('terrain' | 'tele'), getTerrain(part, slot), level(), marble() (it
// keeps the latest values per part and a count in `marbles`), plus a few
// note helpers for the harness. Terrains are the real DSP tables; telemetry is
// computed the way the worklet does it (normalised values, LFOs in normalised
// space, wrap for rotate and the dot), with a little arpeggio of voices.

import { MAX_PARTS, PART_PARAM_MAP, MOD_PARAM_IDS, MOD_DEFAULT, SYNC_DIVS, toNorm } from '../../src/core/params.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { generateTerrain, decodeUserTerrain } from '../../src/dsp/terrains.js';

function emitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    off(type, fn) { map.get(type)?.delete(fn); },
    emit(type, data) {
      for (const fn of [...(map.get(type) || [])]) {
        try { fn(data); } catch (err) { console.error(err); }
      }
    },
  };
}

function lfoValue(shape, phase, seed) {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return 1 - 4 * Math.abs(p - 0.5);
    case 2: return 2 * p - 1;
    case 3: return p < 0.5 ? 1 : -1;
    case 4: { const x = Math.sin((Math.floor(phase) + seed) * 91.7) * 4375.85; return (x - Math.floor(x)) * 2 - 1; }
    default: return 0.6 * Math.sin(2 * Math.PI * phase * 0.31 + seed) + 0.4 * Math.sin(2 * Math.PI * phase * 0.73);
  }
}

/**
 * createFakeEngine({ store, tele = true, play = true })
 *   tele: emit telemetry (false simulates "audio not started yet")
 *   play: run a gentle arpeggio so voices and level move
 */
export function createFakeEngine({ store, tele = true, play = true } = {}) {
  const ev = emitter();
  const tables = Array.from({ length: MAX_PARTS }, () => ({ A: null, B: null }));
  const keys = Array.from({ length: MAX_PARTS }, () => ({ A: '', B: '' }));
  const timers = new Array(MAX_PARTS).fill(0);
  const env2 = new Array(MAX_PARTS).fill(0);
  const spin = new Array(MAX_PARTS).fill(0);
  const voices = Array.from({ length: MAX_PARTS }, () => []); // {id, note, amp, gate, t}
  let wheel = 0;
  let playing = play;
  let teleOn = tele;
  let lvl = 0;
  const started = performance.now();

  function keyFor(part, slot) {
    const p = store.get(`parts.${part}.params`) || {};
    const idx = p['terrain' + slot];
    if (idx === TERRAIN_INDEX.user) {
      const ut = store.get(`parts.${part}.userTerrain.${slot}`);
      return 'user|' + (ut ? ut.data.length + ut.name : 'none');
    }
    return `${idx}|${p.seed}|${p.detail}`;
  }

  function build(part, slot) {
    const p = store.get(`parts.${part}.params`) || {};
    const idx = p['terrain' + slot];
    const data = idx === TERRAIN_INDEX.user
      ? decodeUserTerrain(store.get(`parts.${part}.userTerrain.${slot}`), 512)
      : generateTerrain(idx, { size: 512, seed: p.seed ?? 7, detail: p.detail ?? 0.5 });
    tables[part][slot] = { size: 512, data: data || new Float32Array(512 * 512) };
    keys[part][slot] = keyFor(part, slot);
    return tables[part][slot];
  }

  function getTerrain(part, slot) {
    const s = slot === 1 || slot === 'B' ? 'B' : 'A';
    if (!tables[part]) return null;
    if (!tables[part][s]) build(part, s);
    return tables[part][s];
  }

  // Regenerate (debounced, like the real engine) and announce.
  store.subscribe('', (path) => {
    const m = /^parts\.(\d)(?:\.(params\.(terrainA|terrainB|seed|detail)|userTerrain))?/.exec(path);
    if (!m && path !== '' && path !== 'parts') return;
    const parts = m && m[2] ? [Number(m[1])] : m ? [Number(m[1])] : [0, 1, 2, 3];
    for (const part of parts) {
      clearTimeout(timers[part]);
      timers[part] = setTimeout(() => {
        for (const slot of ['A', 'B']) {
          if (keys[part][slot] === keyFor(part, slot) && tables[part][slot]) continue;
          const t = build(part, slot);
          ev.emit('terrain', { part, slot, size: t.size, data: t.data });
        }
      }, 120);
    }
  });

  function noteOn(part, note, vel = 0.8) {
    const list = voices[part];
    if (list.length >= 8) list.shift();
    list.push({ id: 0, note, amp: 0, gate: true, vel, t: performance.now() });
    list.forEach((v, i) => { v.id = i; });
    env2[part] = 1;
  }

  function noteOff(part, note) {
    for (const v of voices[part]) if (v.note === note) v.gate = false;
  }

  // Arpeggio for the selected part.
  const ARP = [57, 64, 60, 67, 72, 67, 64, 60];
  let step = 0, lastStep = 0;

  const tick = () => {
    const nowMs = performance.now();
    const now = (nowMs - started) / 1000;
    const part = Math.round(store.get('ui.selectedPart') || 0);
    const dt = 1 / 60;

    if (playing && nowMs - lastStep > 420) {
      lastStep = nowMs;
      for (const v of voices[part]) v.gate = false;
      noteOn(part, ARP[step % ARP.length], 0.8);
      if (step % 4 === 0) noteOn(part, ARP[step % ARP.length] - 12, 0.6);
      step++;
    }
    let sum = 0;
    for (let p = 0; p < MAX_PARTS; p++) {
      const list = voices[p];
      for (const v of list) {
        if (v.gate) v.amp += (0.7 * v.vel - v.amp) * 0.25;
        else v.amp *= 0.9;
        sum += v.amp;
      }
      voices[p] = list.filter(v => v.gate || v.amp > 0.004);
      voices[p].forEach((v, i) => { v.id = i; });
      env2[p] *= 0.97;
      const sp = store.get(`parts.${p}.params.spin`) || 0;
      spin[p] = (spin[p] + sp * dt) % 1;
      if (spin[p] < 0) spin[p] += 1;
    }
    lvl += (Math.min(1, sum * 0.6) - lvl) * 0.2;

    if (!teleOn) return;
    const params = store.get(`parts.${part}.params`) || {};
    const mods = store.get(`parts.${part}.mods`) || {};
    const tempo = store.get('global.tempo') || 112;
    const n = {};
    for (const id of MOD_PARAM_IDS) {
      const m = { ...MOD_DEFAULT, ...(mods[id] || {}) };
      const hz = m.lfoSync ? (tempo / 60) / SYNC_DIVS[m.lfoDiv].beats : m.lfoRate;
      let v = toNorm(PART_PARAM_MAP[id], params[id] ?? PART_PARAM_MAP[id].default)
        + lfoValue(m.lfoShape, now * hz, id.length) * m.lfoDepth + env2[part] * m.envDepth;
      if (id === 'morph') v += wheel;
      n[id] = id === 'rotate' || id === 'centerX' || id === 'centerY' ? v - Math.floor(v) : Math.min(1, Math.max(0, v));
    }
    const list = voices[part].map(v => ({ id: v.id, note: v.note, amp: v.amp }));
    ev.emit('tele', {
      t: 'tele', part, n, spinPhase: spin[part], voices: list,
      peak: [lvl * 0.8, lvl * 0.75], activeVoices: voices.map(l => l.filter(v => v.gate).length),
    });
  };
  const timer = setInterval(tick, 1000 / 60);

  return {
    mode: 'fake',
    context: null,
    on: ev.on,
    off: ev.off,
    getTerrain,
    level: () => lvl,
    noteOn, noteOff,
    allNotesOff(part) { for (let p = 0; p < MAX_PARTS; p++) if (part == null || p === part) for (const v of voices[p]) v.gate = false; },
    panic() { for (const l of voices) l.length = 0; },
    bend() {},
    wheel(part, v) { wheel = v; },
    // Round D: the visuals report each marble about 30 times a second.
    marbles: Array.from({ length: MAX_PARTS }, () => ({ n: 0, speed: 0, height: 0 })),
    marble(part, speed, height) {
      const m = this.marbles[part];
      if (!m) return;
      m.n++; m.speed = speed; m.height = height;
    },
    setPlaying(on) { playing = !!on; if (!on) this.allNotesOff(); },
    get playing() { return playing; },
    setTele(on) { teleOn = !!on; },
    dispose() { clearInterval(timer); timers.forEach(clearTimeout); },
  };
}
