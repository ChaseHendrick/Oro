// Makes any saved session / scene / patch safe to load: fills in parameters
// added since it was saved, drops unknown keys, clamps values into range.

import {
  NUM_PARTS, PART_PARAMS, GLOBAL_PARAMS, MOD_PARAM_IDS, MOD_DEFAULT, SEQ_STEPS,
  LFO_SHAPES, LFO_STEP_COUNT, DEFAULT_LFO_STEPS, LINK_SOURCES, LINK_CURVES, MAX_LINKS, PART_PARAM_MAP,
  DOT_MODES, TOUR_MODES, MAX_WAYPOINTS,
  defaultState, defaultPart, defaultStep, defaultLinks, clamp,
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
      lfoShape: Math.round(clamp(num(s.lfoShape, b.lfoShape), 0, LFO_SHAPES.length - 1)),
      lfoRate: clamp(num(s.lfoRate, b.lfoRate), 0.01, 30),
      lfoSync: num(s.lfoSync, b.lfoSync) ? 1 : 0,
      lfoDiv: Math.round(clamp(num(s.lfoDiv, b.lfoDiv), 0, 12)),
      lfoDepth: clamp(num(s.lfoDepth, b.lfoDepth), -1, 1),
      envDepth: clamp(num(s.envDepth, b.envDepth), -1, 1),
      retrig: num(s.retrig, b.retrig) ? 1 : 0,
      steps: sanitizeSteps(s.steps, b.steps),
    };
  }
  return out;
}

function sanitizeSteps(src, base) {
  const fallback = Array.isArray(base) && base.length === LFO_STEP_COUNT ? base : DEFAULT_LFO_STEPS;
  const out = [];
  for (let i = 0; i < LFO_STEP_COUNT; i++) out.push(clamp(num(Array.isArray(src) ? src[i] : undefined, fallback[i]), -1, 1));
  return out;
}

export function sanitizeLinks(src) {
  if (!Array.isArray(src)) return defaultLinks();
  const out = [];
  for (const l of src) {
    if (out.length >= MAX_LINKS) break;
    if (!l || typeof l !== 'object' || !PART_PARAM_MAP[l.dst] || !PART_PARAM_MAP[l.dst].mod) continue;
    out.push({
      src: Math.round(clamp(num(l.src, 0), 0, LINK_SOURCES.length - 1)),
      dst: l.dst,
      amt: clamp(num(l.amt, 0), -1, 1),
      curve: Math.round(clamp(num(l.curve, 0), 0, LINK_CURVES.length - 1)),
    });
  }
  return out;
}

function sanitizeWaypoints(src) {
  if (!Array.isArray(src)) return [];
  return src.slice(0, MAX_WAYPOINTS).filter(w => w && typeof w === 'object').map(w => ({
    x: clamp(num(w.x, 0.5), 0, 1),
    y: clamp(num(w.y, 0.5), 0, 1),
    beats: clamp(num(w.beats, 2), 0.25, 16),
  }));
}

function sanitizeSeq(src, base) {
  const s = src || {};
  const out = {
    enabled: num(s.enabled, base.enabled) ? 1 : 0,
    rate: Math.round(clamp(num(s.rate, base.rate), 0, 5)),
    length: Math.round(clamp(num(s.length, base.length), 1, SEQ_STEPS)),
    baseOctave: Math.round(clamp(num(s.baseOctave, base.baseOctave), 0, 7)),
    lockGlide: clamp(num(s.lockGlide, base.lockGlide), 0, 1),
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
      lock: num(st.lock, d.lock) ? 1 : 0,
      lx: clamp(num(st.lx, d.lx), 0, 1),
      ly: clamp(num(st.ly, d.ly), 0, 1),
    });
  }
  return out;
}

function sanitizeUserTerrain(t) {
  if (!t || typeof t !== 'object' || typeof t.data !== 'string') return null;
  const w = Math.round(num(t.w, 0)), h = Math.round(num(t.h, 0));
  if (w < 2 || h < 2 || w > 1024 || h > 1024) return null;
  const out = { name: String(t.name || 'Imported').slice(0, 80), kind: t.kind === 'wavetable' ? 'wavetable' : 'image', w, h, mirror: t.mirror ? 1 : 0, data: t.data };
  // Optional low byte plane of a 16-bit height map (data holds the high bytes).
  // Kept only when it is a non-empty string; anything else falls back to 8 bits.
  if (typeof t.lo === 'string' && t.lo.length > 0) out.lo = t.lo;
  return out;
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
      mode: Math.round(clamp(num(p.dot?.mode, base.dot.mode), 0, DOT_MODES.length - 1)),
      gravity: clamp(num(p.dot?.gravity, base.dot.gravity), 0, 1),
      friction: clamp(num(p.dot?.friction, base.dot.friction), 0, 1),
      driftSpeed: clamp(num(p.dot?.driftSpeed, base.dot.driftSpeed), 0, 1),
      bounce: clamp(num(p.dot?.bounce, base.dot.bounce), 0, 0.95),
      tiltX: clamp(num(p.dot?.tiltX, base.dot.tiltX), -1, 1),
      tiltY: clamp(num(p.dot?.tiltY, base.dot.tiltY), -1, 1),
      flick: clamp(num(p.dot?.flick, base.dot.flick), 0, 1),
      exploreRate: clamp(num(p.dot?.exploreRate, base.dot.exploreRate), 0, 1),
      exploreRange: Math.round(clamp(num(p.dot?.exploreRange, base.dot.exploreRange), 1, 4)),
      exploreNotes: num(p.dot?.exploreNotes, base.dot.exploreNotes) ? 1 : 0,
      waypoints: sanitizeWaypoints(p.dot?.waypoints),
      tourMode: Math.round(clamp(num(p.dot?.tourMode, base.dot.tourMode), 0, TOUR_MODES.length - 1)),
    },
    links: p.links === undefined ? defaultLinks() : sanitizeLinks(p.links),
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
