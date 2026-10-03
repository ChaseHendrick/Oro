// Makes any saved session / scene / patch safe to load: fills in parameters
// added since it was saved, drops unknown keys, clamps values into range.

import {
  MAX_PARTS, MIN_PARTS, DEFAULT_PARTS, MAX_PATTERNS, PART_PARAMS, GLOBAL_PARAMS, MOD_PARAM_IDS, MOD_DEFAULT, SEQ_STEPS,
  ARP_RHYTHMS, ENV_MODES, MOD_FIELDS, LFO_SHAPES, LFO_STEP_COUNT, DEFAULT_LFO_STEPS, LINK_SOURCES, LINK_CURVES, MAX_LINKS, PART_PARAM_MAP,
  DOT_MODES, TOUR_MODES, MAX_WAYPOINTS, STATE_VERSION, RATCHET_MAX,
  defaultState, defaultPart, defaultPattern, defaultStep, defaultLinks, clamp,
} from './params.js';
import { sanitizeUserTerrain } from '../dsp/user-terrain.js';
import { sanitizeFuncPoints } from '../dsp/function-gen.js';
import { sanitizeDrum, sanitizeLanes } from '../dsp/drum-kit.js';
import { sanitizeTrackFx } from '../dsp/track-fx-config.js';
import { sanitizeNoiseRecording } from '../dsp/noise-recording.js';
import { uniqueIds } from './tracks.js';
import { sanitizePedalPresets } from '../pedals/pedal-presets.js';
import { sanitizeChord } from '../music/chord-trigger.js';

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
    const m = {};
    for (const field of MOD_FIELDS) {
      if (field === 'steps') { m.steps = sanitizeSteps(s.steps, b.steps); continue; }
      let v = num(s[field], num(b[field], MOD_DEFAULT[field]));
      let lo = -1, hi = 1, integer = false;
      if (field === 'lfoShape') { lo = 0; hi = LFO_SHAPES.length - 1; integer = true; }
      else if (field === 'lfoRate') { lo = 0.01; hi = 30; }
      else if (field === 'lfoDiv') { lo = 0; hi = 12; integer = true; }
      else if (['lfoSync', 'retrig', 'envOwn'].includes(field)) { v = v ? 1 : 0; lo = 0; }
      else if (field === 'lfoCount') { lo = 0; hi = 32; integer = true; }
      else if (field === 'envMode') { lo = 0; hi = ENV_MODES.length - 1; integer = true; }
      else if (field.endsWith('Source')) { lo = 0; hi = LINK_SOURCES.length - 1; integer = true; }
      else if (field.endsWith('Curve')) { lo = 0; hi = LINK_CURVES.length - 1; integer = true; }
      else if (['lfoDelay','lfoAttack','envDelay','envHold'].includes(field)) { lo = 0; hi = 8; }
      else if (['envAttack','envDecay','envRelease'].includes(field)) { lo = 0.001; hi = field === 'envRelease' ? 10 : 8; }
      else if (['envSustain','lfoPhase','stepGlide','stepSmooth'].includes(field)) { lo = 0; }
      m[field] = integer ? Math.round(clamp(v, lo, hi)) : clamp(v, lo, hi);
    }
    out[id] = m;
  }
  return out;
}

function sanitizeSteps(src, base) {
  if (Array.isArray(src) && src.length === 16 && LFO_STEP_COUNT === 32) src = src.flatMap(v => [v, v]);
  if (Array.isArray(base) && base.length === 16 && LFO_STEP_COUNT === 32) base = base.flatMap(v => [v, v]);
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
      // v2.4 Via: a second source that scales the link (absent = none)
      ...(Number.isFinite(l.via) && l.via >= 0 && l.via < LINK_SOURCES.length ? { via: Math.round(l.via) } : {}),
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

/** One sequencer pattern (`n` = its number, for the default id and name). */
export function sanitizePattern(src, n = 1) {
  const s = src || {};
  const base = defaultPattern(n);
  const id = typeof s.id === 'string' && /^[\w-]{1,24}$/.test(s.id) ? s.id : base.id;
  const out = {
    id,
    name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 40) : base.name,
    rate: Math.round(clamp(num(s.rate, base.rate), 0, 5)),
    length: Math.round(clamp(num(s.length, base.length), 1, SEQ_STEPS)),
    baseOctave: Math.round(clamp(num(s.baseOctave, base.baseOctave), 0, 7)),
    lockGlide: clamp(num(s.lockGlide, base.lockGlide), 0, 1),
    // v2.6 humanize, absent unless set
    ...(num(s.humanTime, 0) > 0 ? { humanTime: clamp(num(s.humanTime, 0), 0, 1) } : {}),
    ...(num(s.humanVel, 0) > 0 ? { humanVel: clamp(num(s.humanVel, 0), 0, 1) } : {}),
    // v2.7 drum lanes, absent until a cell is set
    ...(sanitizeLanes(s.drumLanes, SEQ_STEPS) ? { drumLanes: sanitizeLanes(s.drumLanes, SEQ_STEPS) } : {}),
    steps: [],
  };
  for (let i = 0; i < SEQ_STEPS; i++) {
    const st = (Array.isArray(s.steps) && s.steps[i]) || {};
    const d = defaultStep();
    const step = {
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
    };
    // Probability and ratchet are stored only when they differ from the default (1).
    const prob = clamp(num(st.prob, 1), 0, 1);
    const ratchet = Math.round(clamp(num(st.ratchet, 1), 1, RATCHET_MAX));
    if (prob < 1) step.prob = prob;
    if (ratchet > 1) step.ratchet = ratchet;
    out.steps.push(step);
  }
  return out;
}

/**
 * A track's patterns: `patterns` (1..MAX_PATTERNS, unique ids) when present,
 * otherwise the single `seq` of a pre-v1.3 part as pattern 1.
 */
function sanitizePatterns(p) {
  const src = Array.isArray(p.patterns) && p.patterns.length ? p.patterns.slice(0, MAX_PATTERNS) : [p.seq || {}];
  const out = src.map((s, i) => sanitizePattern(s && typeof s === 'object' ? s : {}, i + 1));
  const seen = new Set();
  out.forEach((pat, i) => {
    if (seen.has(pat.id)) {
      let n = i + 1;
      while (seen.has(`p${n}`) || out.some(q => q.id === `p${n}`)) n++;
      pat.id = `p${n}`;
    }
    seen.add(pat.id);
  });
  return out;
}

export function sanitizePart(src, i) {
  const base = defaultPart(i);
  const p = src || {};
  const patterns = sanitizePatterns(p);
  return {
    id: typeof p.id === 'string' && /^[\w-]{1,24}$/.test(p.id) ? p.id : base.id,
    name: typeof p.name === 'string' ? p.name.slice(0, 40) : base.name,
    color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : base.color,
    patchName: typeof p.patchName === 'string' ? p.patchName.slice(0, 60) : base.patchName,
    params: sanitizeParams(PART_PARAMS, p.params),
    mods: sanitizeMods(p.mods),
    // Older parts kept the on switch inside their one pattern (seq.enabled).
    seqOn: num(p.seqOn, num(p.seq?.enabled, base.seqOn)) ? 1 : 0,
    patterns,
    activePattern: Math.round(clamp(num(p.activePattern, 0), 0, patterns.length - 1)),
    arp: {
      mode: Math.round(clamp(num(p.arp?.mode, base.arp.mode), 0, 6)),
      rate: Math.round(clamp(num(p.arp?.rate, base.arp.rate), 0, 5)),
      octaves: Math.round(clamp(num(p.arp?.octaves, base.arp.octaves), 1, 4)),
      gate: clamp(num(p.arp?.gate, base.arp.gate), 0.05, 1),
      hold: num(p.arp?.hold, base.arp.hold) ? 1 : 0,
      rhythm: Math.round(clamp(num(p.arp?.rhythm, 0), 0, ARP_RHYTHMS.length - 1)),
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
      pendEnergy: clamp(num(p.dot?.pendEnergy, base.dot.pendEnergy), -2.95, 4),
      pendReach: clamp(num(p.dot?.pendReach, base.dot.pendReach), 0, 1),
      pendRate: clamp(num(p.dot?.pendRate, base.dot.pendRate), 0, 1),
    },
    links: p.links === undefined ? defaultLinks() : sanitizeLinks(p.links),
    funcPoints: sanitizeFuncPoints(p.funcPoints),
    drum: sanitizeDrum(p.drum),
    userTerrain: { A: sanitizeUserTerrain(p.userTerrain?.A), B: sanitizeUserTerrain(p.userTerrain?.B) },
    trackFx: sanitizeTrackFx(p.trackFx),
    noiseRecording: sanitizeNoiseRecording(p.noiseRecording),
    // v2.8 chord trigger, absent until it is set (absent = off)
    ...(p.chord && typeof p.chord === 'object' ? { chord: sanitizeChord(p.chord) } : {}),
  };
}

/**
 * Any saved session or scene -> the current format (STATE_VERSION). Version 1
 * (before v1.1) has no pedal params: sanitizeParams fills them with their
 * defaults, so an old session loads with the pedal send, Pre and Insert off.
 * Links already using a source index this build does not know are clamped by
 * sanitizeLinks. Version 2 sessions are already in the version 3 shape (3 only
 * adds optional pedal presets to scenes, see migrateScene). Version 4 (v1.3)
 * keeps the track list as saved (1..MAX_PARTS tracks); older sessions and
 * scenes have four parts and come back as four tracks with ids t1..t4, each
 * part's `seq` becoming its pattern 1.
 */
export function migrateState(src) {
  const base = defaultState();
  if (!src || typeof src !== 'object') return base;
  const list = Array.isArray(src.parts) ? src.parts.slice(0, MAX_PARTS) : [];
  // Before v1.3 a session always had four parts (missing ones were defaults).
  const count = list.length >= MIN_PARTS && (num(src.version, 0) >= 4 || list.length > DEFAULT_PARTS) ? list.length : DEFAULT_PARTS;
  const parts = Array.from({ length: count }, (_, i) => sanitizePart(list[i] || null, i));
  uniqueIds(parts);
  return {
    version: STATE_VERSION,
    global: sanitizeParams(GLOBAL_PARAMS, src.global),
    parts,
  };
}

/**
 * A saved scene -> the current format: its state through migrateState, plus
 * the optional per-pedal presets (version 3). Scenes saved before version 3
 * have none and come back exactly as migrateState makes them, with no
 * `pedalPresets` key. Name, description and id are the caller's business.
 */
export function migrateScene(src) {
  const out = migrateState(src);
  const pedalPresets = src && typeof src === 'object' ? sanitizePedalPresets(src.pedalPresets) : null;
  if (pedalPresets) out.pedalPresets = pedalPresets;
  return out;
}
