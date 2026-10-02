// Makes any saved session / scene / patch safe to load: fills in parameters
// added since it was saved, drops unknown keys, clamps values into range.

import {
  NUM_PARTS, PART_PARAMS, GLOBAL_PARAMS, MOD_PARAM_IDS, MOD_DEFAULT, SEQ_STEPS,
  defaultState, defaultPart, defaultStep, clamp,
} from './params.js';

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function sanitizeParams(defs, src = {}, base = {}) {
  const out = {};
  for (const d of defs) {
    let v = num(src[d.id], num(base[d.id], d.default));
    v = clamp(v, Math.min(d.min, d.max), Math.max(d.min, d.max));
    if (d.curve === 'int' || d.curve === 'enum' || d.curve === 'bool') v = Math.round(v);
    out[d.id] = v;
  }
  return out;
}

export function sanitizeMods(src = {}, base = {}) {
  const out = {};
  for (const id of MOD_PARAM_IDS) {
    const s = (src && src[id]) || {};
    const b = (base && base[id]) || MOD_DEFAULT;
    out[id] = {
      lfoShape: Math.round(clamp(num(s.lfoShape, b.lfoShape), 0, 5)),
      lfoRate: clamp(num(s.lfoRate, b.lfoRate), 0.01, 30),
      lfoSync: num(s.lfoSync, b.lfoSync) ? 1 : 0,
      lfoDiv: Math.round(clamp(num(s.lfoDiv, b.lfoDiv), 0, 12)),
      lfoDepth: clamp(num(s.lfoDepth, b.lfoDepth), -1, 1),
      envDepth: clamp(num(s.envDepth, b.envDepth), -1, 1),
      retrig: num(s.retrig, b.retrig) ? 1 : 0,
    };
  }
  return out;
}

function sanitizeSeq(src, base) {
  const s = src || {};
  const out = {
    enabled: num(s.enabled, base.enabled) ? 1 : 0,
    rate: Math.round(clamp(num(s.rate, base.rate), 0, 5)),
    length: Math.round(clamp(num(s.length, base.length), 1, SEQ_STEPS)),
    baseOctave: Math.round(clamp(num(s.baseOctave, base.baseOctave), 0, 7)),
    steps: [],
  };
  for (let i = 0; i < SEQ_STEPS; i++) {
    const st = (Array.isArray(s.steps) && s.steps[i]) || {};
    const d = defaultStep();
    out.steps.push({
      on: num(st.on, d.on) ? 1 : 0,
      degree: Math.round(clamp(num(st.degree, d.degree), -21, 28)),
      octave: Math.round(clamp(num(st.octave, d.octave), -2, 2)),
      vel: clamp(num(st.vel, d.vel), 0, 1),
      gate: clamp(num(st.gate, d.gate), 0.05, 1),
      slide: num(st.slide, d.slide) ? 1 : 0,
      accent: num(st.accent, d.accent) ? 1 : 0,
    });
  }
  return out;
}

function sanitizeUserTerrain(t) {
  if (!t || typeof t !== 'object' || typeof t.data !== 'string') return null;
  const w = Math.round(num(t.w, 0)), h = Math.round(num(t.h, 0));
  if (w < 2 || h < 2 || w > 1024 || h > 1024) return null;
  return { name: String(t.name || 'Imported').slice(0, 80), kind: t.kind === 'wavetable' ? 'wavetable' : 'image', w, h, mirror: t.mirror ? 1 : 0, data: t.data };
}

export function sanitizePart(src, i) {
  const base = defaultPart(i);
  const p = src || {};
  return {
    name: typeof p.name === 'string' ? p.name.slice(0, 40) : base.name,
    color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : base.color,
    patchName: typeof p.patchName === 'string' ? p.patchName.slice(0, 60) : base.patchName,
    params: sanitizeParams(PART_PARAMS, p.params),
    mods: sanitizeMods(p.mods),
    seq: sanitizeSeq(p.seq, base.seq),
    arp: {
      mode: Math.round(clamp(num(p.arp?.mode, base.arp.mode), 0, 6)),
      rate: Math.round(clamp(num(p.arp?.rate, base.arp.rate), 0, 5)),
      octaves: Math.round(clamp(num(p.arp?.octaves, base.arp.octaves), 1, 4)),
      gate: clamp(num(p.arp?.gate, base.arp.gate), 0.05, 1),
      hold: num(p.arp?.hold, base.arp.hold) ? 1 : 0,
    },
    dot: {
      mode: Math.round(clamp(num(p.dot?.mode, base.dot.mode), 0, 2)),
      gravity: clamp(num(p.dot?.gravity, base.dot.gravity), 0, 1),
      friction: clamp(num(p.dot?.friction, base.dot.friction), 0, 1),
      driftSpeed: clamp(num(p.dot?.driftSpeed, base.dot.driftSpeed), 0, 1),
    },
    userTerrain: { A: sanitizeUserTerrain(p.userTerrain?.A), B: sanitizeUserTerrain(p.userTerrain?.B) },
  };
}

export function migrateState(src) {
  const base = defaultState();
  if (!src || typeof src !== 'object') return base;
  return {
    version: 1,
    global: sanitizeParams(GLOBAL_PARAMS, src.global),
    parts: Array.from({ length: NUM_PARTS }, (_, i) => sanitizePart(Array.isArray(src.parts) ? src.parts[i] : null, i)),
  };
}
