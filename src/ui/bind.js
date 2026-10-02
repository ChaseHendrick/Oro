// Bindings connect a control to one value in the store. A binding knows its
// parameter definition, resolves its store path at call time (so part
// parameters follow ui.selectedPart) and re-subscribes when the selected part
// changes. Every control in the UI is written against this interface:
//
//   binding.def          parameter definition (curve, min, max, default, ...)
//   binding.get()        current plain value
//   binding.set(v, meta) clamp/snap and write
//   binding.reset()      back to def.default
//   binding.subscribe(fn) -> off   fn() on value change or part switch
//   binding.part()       part index or null
//   binding.modPath()    store path of this parameter's mod settings, or null
//   binding.learnTarget() MIDI-learn target { scope, part, id } or null

import { PART_PARAM_MAP, GLOBAL_PARAM_MAP, NUM_PARTS, clamp } from '../core/params.js';

export function clampPart(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, 0, NUM_PARTS - 1) : 0;
}

export function snapValue(def, v) {
  if (!def) return v;
  let x = Number(v);
  if (!Number.isFinite(x)) return def.default;
  const lo = Math.min(def.curve === 'bipow' ? -def.max : def.min, def.max);
  const hi = Math.max(def.min, def.max);
  x = clamp(x, lo, hi);
  if (def.curve === 'int' || def.curve === 'enum' || def.curve === 'bool') x = Math.round(x);
  return x;
}

export function createBinder(store) {
  const selected = () => clampPart(store.get('ui.selectedPart'));

  function subscribeDynamic(pathFn, fn, followsSelection) {
    let current = pathFn();
    let off = store.subscribe(current, fn);
    if (!followsSelection) return () => off();
    const offSel = store.subscribe('ui.selectedPart', () => {
      const next = pathFn();
      if (next !== current) {
        off();
        current = next;
        off = store.subscribe(current, fn);
      }
      fn();
    });
    return () => { off(); offSel(); };
  }

  function make({ def, id, scope, pathFn, partFn, follows, modPathFn, learn }) {
    return {
      def, id, scope,
      part: partFn,
      path: pathFn,
      get() {
        const v = store.get(pathFn());
        return v === undefined ? def.default : v;
      },
      set(v, meta = { source: 'ui' }) {
        const x = snapValue(def, v);
        if (store.get(pathFn()) !== x) store.set(pathFn(), x, meta);
      },
      reset(meta = { source: 'ui' }) { this.set(def.default, meta); },
      subscribe(fn) { return subscribeDynamic(pathFn, fn, follows); },
      modPath: modPathFn || (() => null),
      learnTarget: learn || (() => null),
    };
  }

  /** A part parameter; part = 'sel' follows the selected part. */
  function partParam(id, { part = 'sel' } = {}) {
    const def = PART_PARAM_MAP[id];
    if (!def) throw new Error(`Unknown part parameter "${id}"`);
    const follows = part === 'sel';
    const partFn = follows ? selected : () => clampPart(part);
    return make({
      def, id, scope: 'part', follows, partFn,
      pathFn: () => `parts.${partFn()}.params.${id}`,
      modPathFn: def.mod ? () => `parts.${partFn()}.mods.${id}` : null,
      learn: () => ({ scope: 'part', part: follows ? 'sel' : partFn(), id }),
    });
  }

  function globalParam(id) {
    const def = GLOBAL_PARAM_MAP[id];
    if (!def) throw new Error(`Unknown global parameter "${id}"`);
    return make({
      def, id, scope: 'global', follows: false, partFn: () => null,
      pathFn: () => `global.${id}`,
      learn: () => ({ scope: 'global', part: null, id }),
    });
  }

  /** One field of a parameter's modulation settings (lfoDepth, lfoRate, ...). */
  function modField(paramId, field, def, { part = 'sel' } = {}) {
    const follows = part === 'sel';
    const partFn = follows ? selected : () => clampPart(part);
    return make({
      def: { id: field, ...def }, id: field, scope: 'mod', follows, partFn,
      pathFn: () => `parts.${partFn()}.mods.${paramId}.${field}`,
    });
  }

  /**
   * Any other numeric value (seq/arp/dot settings, steps). `rel` is the path
   * below `parts.N.` when part-scoped, or a full path when part is null.
   */
  function path(rel, def, { part = 'sel' } = {}) {
    if (part === null) {
      return make({ def, id: def.id || rel, scope: 'custom', follows: false, partFn: () => null, pathFn: () => rel });
    }
    const follows = part === 'sel';
    const partFn = follows ? selected : () => clampPart(part);
    return make({
      def, id: def.id || rel, scope: 'custom', follows, partFn,
      pathFn: () => `parts.${partFn()}.${rel}`,
    });
  }

  /** A string-valued ui setting such as ui.view or ui.renderStyle. */
  function uiValue(key, options, fallback) {
    const pathFn = () => `ui.${key}`;
    return {
      def: { id: key, options, default: fallback }, id: key, scope: 'ui',
      part: () => null, path: pathFn,
      get() { const v = store.get(pathFn()); return v === undefined ? fallback : v; },
      set(v, meta = { source: 'ui' }) { if (store.get(pathFn()) !== v) store.set(pathFn(), v, meta); },
      reset() { this.set(fallback); },
      subscribe(fn) { return store.subscribe(pathFn(), fn); },
      modPath: () => null,
      learnTarget: () => null,
    };
  }

  return { selected, partParam, globalParam, modField, path, uiValue };
}
