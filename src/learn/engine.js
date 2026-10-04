// Lesson checks and setup. Pure: nothing here writes the live session.

import { PART_PARAM_MAP, LINK_SOURCES } from '../core/params.js';
import { TERRAINS, PATHS } from '../dsp/catalog.js';
import { QUALITY_MODES } from '../dsp/dsp-core.js';

export const TABS = Object.freeze(['sound', 'mod', 'seq', 'mix', 'loop']);
export const LEVELS = Object.freeze(['Beginner', 'Intermediate', 'Deep dive']);

const TERRAIN_IDS = new Set(TERRAINS.map((t) => t.id));
const PATH_IDS = new Set(PATHS.map((p) => p.id));
const LINK_IDS = new Set((LINK_SOURCES || []).map((s) => (typeof s === 'string' ? s : s.id)));

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function validateLesson(lesson) {
  const errors = [];
  if (!lesson || typeof lesson.id !== 'string') errors.push('id');
  if (!LEVELS.includes(lesson && lesson.level)) errors.push('level');
  if (!(lesson && lesson.minutes > 0)) errors.push('minutes');
  if (!lesson || !Array.isArray(lesson.steps) || lesson.steps.length < 5 || lesson.steps.length > 12) errors.push('steps');
  for (const step of (lesson && lesson.steps) || []) {
    for (const action of step.setup || []) if (!knownAction(action)) errors.push(`setup ${step.id}`);
    if (step.check && !knownCheck(step.check)) errors.push(`check ${step.id}`);
  }
  for (const action of (lesson && lesson.setup) || []) if (!knownAction(action)) errors.push('lesson setup');
  return { ok: errors.length === 0, errors };
}

function knownAction(a) {
  if (!isObj(a) || typeof a.type !== 'string') return false;
  if (a.type === 'terrain') return TERRAIN_IDS.has(a.id);
  if (a.type === 'path') return PATH_IDS.has(a.id);
  if (a.type === 'param') return !!PART_PARAM_MAP[a.id];
  if (a.type === 'tab') return TABS.includes(a.id);
  if (a.type === 'quality') return QUALITY_MODES.includes(a.id);
  if (a.type === 'link') return LINK_IDS.has(a.id) || a.id === 'lfo1';
  return ['global', 'mod', 'dot', 'pattern', 'settings', 'note', 'tuning', 'stop'].includes(a.type);
}

function knownCheck(c) {
  if (!isObj(c)) return false;
  if (c.op === 'all' || c.op === 'any') return Array.isArray(c.of) && c.of.every(knownCheck);
  return ['eq', 'gte', 'lte', 'near', 'in', 'moved'].includes(c.op);
}

function read(state, path) {
  return String(path || '').split('.').reduce((n, k) => (n == null ? n : n[k]), state);
}

function near(a, b, tol, wrap) {
  const d = Math.abs(a - b);
  if (wrap) return Math.min(d, 1 - d) <= tol;
  return d <= tol;
}

export function runCheck(check, state, before = null) {
  if (!check) return true;
  if (check.op === 'all') return check.of.every((c) => runCheck(c, state, before));
  if (check.op === 'any') return check.of.some((c) => runCheck(c, state, before));
  const v = read(state, check.path);
  if (check.op === 'eq') return v === check.value;
  if (check.op === 'gte') return typeof v === 'number' && v >= check.value;
  if (check.op === 'lte') return typeof v === 'number' && v <= check.value;
  if (check.op === 'in') return Array.isArray(check.value) && check.value.includes(v);
  if (check.op === 'near') return typeof v === 'number' && near(v, check.value, check.tolerance ?? 0.02, !!check.wrap);
  if (check.op === 'moved') return before != null && read(before, check.path) !== v;
  return false;
}

export function applySetup(state, actions = []) {
  const next = JSON.parse(JSON.stringify(state));
  const part = next.parts && next.parts[0];
  for (const a of actions) {
    if (!part) break;
    if (a.type === 'param' || a.type === 'global') {
      const bag = a.type === 'global' ? next.global : part.params;
      if (bag) bag[a.id] = a.value;
    } else if (a.type === 'terrain') part.params.terrainA = TERRAINS.findIndex((t) => t.id === a.id);
    else if (a.type === 'path') part.params.pathShape = PATHS.findIndex((p) => p.id === a.id);
    else if (a.type === 'dot') part.dot = { ...(part.dot || {}), mode: a.value };
    else if (a.type === 'tab') next.ui = { ...(next.ui || {}), panel: a.id };
    else if (a.type === 'quality') next.ui = { ...(next.ui || {}), audioQuality: a.id };
    else if (a.type === 'pattern') part.patterns[0].steps[a.step || 0] = { ...part.patterns[0].steps[a.step || 0], ...a.value };
  }
  return next;
}
