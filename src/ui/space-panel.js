// 2.12 3D sound card (Mix tab) for the selected track: the mode (Off, Manual,
// Follow dot, Follow dot and distance), a top-down room pad (you in the
// middle, facing up; drag the source around you), Direction, Height,
// Distance and Air. The sound is made in the DSP (src/dsp/spatial.js), so
// bounces and stems include it. The pad only redraws when something changes.

import { h, createScope, setText } from './dom.js';
import { createKnob } from './knob.js';
import { createSelect, createToggle } from './controls.js';
import { schedule } from './frame.js';
import { PART_PARAM_MAP } from '../core/params.js';
import { dotToSpace, radiusToDistance, DIST_MIN, DIST_MAX } from '../dsp/spatial.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const LOG_SPAN = Math.log(DIST_MAX / DIST_MIN);
/** Distance (m) to pad radius 0..1 (log scale, 0.5 m at the head, 20 m at the edge). */
export const distToRadius = (d) => Math.max(0, Math.min(1, Math.log(Math.max(DIST_MIN, Math.min(DIST_MAX, d)) / DIST_MIN) / LOG_SPAN));
export const radiusToDist = (r) => DIST_MIN * Math.exp(Math.max(0, Math.min(1, r)) * LOG_SPAN);

/** "45 degrees right", "in front", "behind" for screen readers and the readout. */
export function directionText(az) {
  const a = Math.round(az);
  if (Math.abs(a) <= 2) return 'in front';
  if (Math.abs(a) >= 178) return 'behind';
  return `${Math.abs(a)} degrees ${a > 0 ? 'right' : 'left'}`;
}

export const SPACE_NOTE = 'Made for headphones. It uses a simple, generic head model, so the effect is stronger for some people than for others. Front and back can be hard to tell apart, and height is the weakest cue. Bounces and stems include it; listening modes do not change it.';

export function createSpacePanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const P = (id) => binder.partParam(id);
  const mode = createSelect(ctx, P('space'), { label: '3D mode', className: 'select--sm' });
  const knob = (id, label) => createKnob(ctx, P(id), { size: 'sm', caption: 'both', ariaLabel: (l) => `3D ${label || l}` });
  const az = knob('spaceAz', 'direction'), el = knob('spaceEl', 'height'), dist = knob('spaceDist', 'distance');
  const air = createToggle(ctx, P('spaceAir'), { label: 'Air', className: 'toggle--sm', ariaLabel: '3D air: far sounds lose a little treble' });
  for (const c of [mode, az, el, dist, air]) scope.add(c.dispose);

  // ---- the room pad
  const pad = svg('svg', { viewBox: '-110 -110 220 220', class: 'space-pad-svg', 'aria-hidden': 'true' });
  for (const d of [1, 4, 16]) pad.appendChild(svg('circle', { cx: 0, cy: 0, r: (100 * distToRadius(d)).toFixed(1), class: 'space-ring' }));
  pad.appendChild(svg('circle', { cx: 0, cy: 0, r: 100, class: 'space-edge' }));
  for (const [x1, y1, x2, y2] of [[0, -100, 0, 100], [-100, 0, 100, 0]]) pad.appendChild(svg('line', { x1, y1, x2, y2, class: 'space-axis' }));
  const head = svg('g', { class: 'space-head' });
  head.append(svg('circle', { cx: 0, cy: 0, r: 9 }), svg('path', { d: 'M-4 -8 L0 -15 L4 -8 Z' }));
  pad.appendChild(head);
  const ray = svg('line', { x1: 0, y1: 0, x2: 0, y2: 0, class: 'space-ray' });
  const src = svg('circle', { cx: 0, cy: -40, r: 8, class: 'space-src' });
  pad.append(ray, src);
  const labels = [['Front', 0, -104, 'middle'], ['Back', 0, 110, 'middle'], ['L', -106, 4, 'end'], ['R', 106, 4, 'start']];
  for (const [t, x, y, anchor] of labels) { const tx = svg('text', { x, y, 'text-anchor': anchor, class: 'space-label' }); tx.textContent = t; pad.appendChild(tx); }
  const padWrap = h('div', { class: 'space-pad', tabindex: '0', role: 'slider', 'aria-label': '3D position: arrow keys turn it round you, up and down move it nearer or further' });
  padWrap.appendChild(pad);
  const readout = h('p', { class: 'space-readout', 'aria-live': 'polite' });
  const follow = h('p', { class: 'space-follow' });

  const sel = () => binder.selected();
  const get = (id) => store.get(`parts.${sel()}.params.${id}`);
  const setP = (id, v) => store.set(`parts.${sel()}.params.${id}`, v, { source: 'ui' });
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  /** The position as drawn: the dot for Follow dot, the knobs otherwise. */
  const position = () => {
    const m = Math.round(get('space') || 0);
    let a = Number(get('spaceAz')) || 0, d = Number(get('spaceDist')) || 1;
    if (m >= 2) {
      const s = dotToSpace(Number(get('centerX') ?? 0.5), Number(get('centerY') ?? 0.5));
      if (s.r > 0.02) a = s.az;
      if (m === 3) d = radiusToDistance(s.r);
    }
    return { m, a, d };
  };

  let drag = null;
  const manual = () => Math.round(get('space') || 0) === 1;
  const fromPointer = (e) => {
    const r = padWrap.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 220 - 110, y = ((e.clientY - r.top) / r.height) * 220 - 110;
    const rad = Math.hypot(x, y) / 100;
    store.batch(() => {
      if (rad > 0.04) setP('spaceAz', Math.round(Math.atan2(x, -y) * 180 / Math.PI));
      setP('spaceDist', Math.round(radiusToDist(rad) * 100) / 100);
    });
  };
  scope.on(padWrap, 'pointerdown', (e) => {
    if ((e.button && e.pointerType === 'mouse') || !manual()) return;
    e.preventDefault(); drag = e.pointerId; padWrap.focus(); padWrap.setPointerCapture(e.pointerId); fromPointer(e);
  });
  scope.on(padWrap, 'pointermove', (e) => { if (drag === e.pointerId) fromPointer(e); });
  scope.on(padWrap, 'pointerup', () => { drag = null; });
  scope.on(padWrap, 'pointercancel', () => { drag = null; });
  scope.on(padWrap, 'keydown', (e) => {
    if (!manual()) return;
    const big = e.shiftKey;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      let a = (Number(get('spaceAz')) || 0) + (e.key === 'ArrowRight' ? 1 : -1) * (big ? 15 : 5);
      if (a > 180) a -= 360; if (a < -180) a += 360;
      setP('spaceAz', a);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      const r = distToRadius(Number(get('spaceDist')) || 1) + (e.key === 'ArrowUp' ? 1 : -1) * (big ? 0.1 : 0.03);
      setP('spaceDist', Math.round(radiusToDist(clamp(r, 0, 1)) * 100) / 100);
    }
  });

  const title = h('span', { class: 'section-aside' });
  const body = h('div', { class: 'space-body' },
    padWrap,
    h('div', { class: 'space-side' },
      h('label', { class: 'space-field' }, h('span', { class: 'mini-label' }, 'Mode'), mode.el),
      h('div', { class: 'knob-row space-knobs' }, az.el, el.el, dist.el),
      h('div', { class: 'space-row' }, air.el),
      readout, follow));
  const elRoot = h('section', { class: 'mix-space dock-card', 'aria-labelledby': 'sec-space' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-space' }, '3D sound'), title),
    body,
    h('p', { class: 'space-note' }, SPACE_NOTE));

  function render() {
    const i = sel();
    if (!store.get(`parts.${i}`)) return;
    setText(title, store.get(`parts.${i}.name`) || `Track ${i + 1}`);
    const { m, a, d } = position();
    const r = 100 * distToRadius(d);
    const x = Math.sin(a * Math.PI / 180) * r, y = -Math.cos(a * Math.PI / 180) * r;
    src.setAttribute('cx', x.toFixed(1)); src.setAttribute('cy', y.toFixed(1));
    ray.setAttribute('x2', x.toFixed(1)); ray.setAttribute('y2', y.toFixed(1));
    elRoot.classList.toggle('is-off', m === 0);
    elRoot.classList.toggle('is-follow', m >= 2);
    for (const k of [az, dist]) k.el.classList.toggle('is-dimmed', m >= 2 && (k === az || m === 3));
    const elv = Math.round(Number(get('spaceEl')) || 0);
    const txt = m === 0 ? 'Off: this track uses Pan.' : `${directionText(a)}, ${elv ? `${Math.abs(elv)} degrees ${elv > 0 ? 'up' : 'down'}, ` : ''}${d.toFixed(1)} m`;
    setText(readout, txt);
    padWrap.setAttribute('aria-valuetext', txt);
    padWrap.setAttribute('aria-disabled', String(m !== 1));
    setText(follow, m === 2 ? 'Follow dot: where the dot sits on the map, seen from the middle, sets the direction. Up the map is in front of you.'
      : m === 3 ? 'Follow dot and distance: the dot sets the direction, and how far it is from the middle of the map sets the distance.'
        : m === 1 ? 'Drag the dot round you, or use the arrow keys.' : 'Choose Manual or Follow dot to place this track around you.');
  }
  const inval = () => schedule(render);
  scope.add(store.subscribe('parts', inval));
  scope.add(store.subscribe('ui.selectedPart', inval));
  render();
  return { el: elRoot, dispose: scope.dispose };
}

/** True when the parameter set has 3D (so older builds without it can still load this UI module). */
export const hasSpace = () => !!PART_PARAM_MAP.space;
