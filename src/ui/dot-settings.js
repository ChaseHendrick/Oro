// Dot settings popover: the controls for whichever behaviour the dot has.
//   Pin      nothing to set (explains how to move it)
//   Roll     gravity, friction, bounce, flick, world tilt
//   Drift    wander speed
//   Explore  marble physics plus note density, range and whether it plays notes
//   Tour     loop mode, waypoint editing on the map, per-waypoint travel time

import { DOT_MODES, TOUR_MODES, MAX_WAYPOINTS } from '../core/params.js';
import { h, createScope, setText, has } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createSegmented, createToggle, createStepper } from './controls.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';

const pct = (v) => Math.round(v * 100) + '%';

export const DOT_DEFS = {
  gravity: { id: 'gravity', label: 'Gravity', curve: 'lin', min: 0, max: 1, default: 0.5, hint: 'How strongly the slopes pull the marble (up to 2 g)' },
  friction: { id: 'friction', label: 'Friction', curve: 'lin', min: 0, max: 1, default: 0.25, hint: 'How quickly the marble slows down' },
  bounce: { id: 'bounce', label: 'Bounce', curve: 'lin', min: 0, max: 0.95, default: 0.25, hint: 'How lively the marble is when it lands' },
  flick: { id: 'flick', label: 'Flick', curve: 'lin', min: 0, max: 1, default: 0.5, hint: 'How hard a flick of the dot throws the marble' },
  tiltX: { id: 'tiltX', label: 'Tilt X', curve: 'lin', min: -1, max: 1, default: 0, hint: 'Lean the world east or west' },
  tiltY: { id: 'tiltY', label: 'Tilt Y', curve: 'lin', min: -1, max: 1, default: 0, hint: 'Lean the world north or south' },
  driftSpeed: { id: 'driftSpeed', label: 'Speed', curve: 'lin', min: 0, max: 1, default: 0.3, hint: 'How fast the dot wanders' },
  exploreRate: { id: 'exploreRate', label: 'Density', curve: 'lin', min: 0, max: 1, default: 0.5, hint: 'How often Explore plays a note at a peak or a valley' },
  exploreRange: { id: 'exploreRange', label: 'Range', curve: 'int', min: 1, max: 4, default: 2, hint: 'How many octaves the height of the land spans' },
  exploreNotes: { id: 'exploreNotes', label: 'Play notes', curve: 'bool', min: 0, max: 1, default: 1, hint: 'Play in-key notes at peaks and valleys' },
  tourMode: { id: 'tourMode', label: 'Tour', curve: 'enum', min: 0, max: TOUR_MODES.length - 1, default: 0, options: TOUR_MODES },
};

const MODE_NOTES = [
  'Pin keeps the dot exactly where you put it. Click or drag on the map to move it.',
  'Roll turns the dot into a marble. Drag it and let go to flick it.',
  'Drift lets the dot wander smoothly on its own.',
  'Explore lets the marble roam under slowly turning gravity and play in-key notes at peaks and valleys.',
  'Tour moves the dot through your waypoints in time with the tempo.',
];
export const BEAT_CHOICES = [0.25, 0.5, 1, 2, 4, 8, 16];

export function openDotSettings(ctx, anchor) {
  const scope = createScope();
  const { binder, store } = ctx;
  const P = (key) => binder.path(`dot.${key}`, DOT_DEFS[key]);
  const knob = (key, opts = {}) => {
    const k = createKnob(ctx, P(key), { size: 'sm', caption: 'both', ...opts });
    scope.add(k.dispose);
    return k.el;
  };
  const title = h('div', { class: 'popover-title' });
  const note = h('p', { class: 'popover-note dot-note' });

  const physics = h('div', { class: 'dot-group', dataset: { modes: '1,3' } },
    h('div', { class: 'mini-label' }, 'Marble'),
    h('div', { class: 'knob-row' }, knob('gravity', { format: pct }), knob('friction', { format: pct }), knob('bounce', { format: pct }), knob('flick', { format: pct })),
    h('div', { class: 'knob-row' }, knob('tiltX'), knob('tiltY')));
  const drift = h('div', { class: 'dot-group', dataset: { modes: '2' } },
    h('div', { class: 'mini-label' }, 'Drift'),
    h('div', { class: 'knob-row' }, knob('driftSpeed', { format: pct })));

  const notesToggle = createToggle(ctx, P('exploreNotes'), { label: 'Play notes', className: 'toggle--sm' });
  const range = createStepper(ctx, P('exploreRange'), { label: 'Explore range in octaves', format: v => `${v} oct` });
  scope.add(notesToggle.dispose);
  scope.add(range.dispose);
  // Explore notes come from the music module; without it the marble still roams.
  if (!has(ctx.music, 'exploreNote')) {
    notesToggle.setDisabled(true, 'Playing notes needs the music engine, which is not available');
    range.setDisabled(true, 'Playing notes needs the music engine, which is not available');
  }
  const explore = h('div', { class: 'dot-group', dataset: { modes: '3' } },
    h('div', { class: 'mini-label' }, 'Explore'),
    h('div', { class: 'dot-line' }, knob('exploreRate', { format: pct }), h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Range'), range.el), notesToggle.el));

  const tourSeg = createSegmented(ctx, P('tourMode'), { label: 'Tour mode', size: 'sm' });
  const editToggle = createToggle(ctx, { ...binder.uiValue('editWaypoints', [0, 1], 0), def: { id: 'editWaypoints', label: 'Edit on map', default: 0 } }, {
    label: 'Edit on map', iconName: 'waypoint', className: 'toggle--sm', tip: 'While on, clicking the map adds a waypoint, dragging moves one and right-click deletes it',
  });
  scope.add(tourSeg.dispose);
  scope.add(editToggle.dispose);
  // Waypoints are placed on the 3D map; the flat stand-in map only moves the dot.
  if (!ctx.visuals) editToggle.setDisabled(true, 'Placing waypoints needs the 3D map, which is not running');
  const list = h('ol', { class: 'waypoint-list', 'aria-label': 'Waypoints' });
  const clearBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--xs', html: icon('trash') + '<span>Clear</span>' });
  const tour = h('div', { class: 'dot-group', dataset: { modes: '4' } },
    h('div', { class: 'mini-label' }, 'Tour'),
    h('div', { class: 'dot-line' }, tourSeg.el, editToggle.el),
    list,
    h('div', { class: 'dot-line dot-line--end' }, h('span', { class: 'waypoint-count' }), clearBtn));

  const body = h('div', { class: 'dot-pop' }, title, note, physics, drift, explore, tour);
  const wpPath = () => `parts.${binder.selected()}.dot.waypoints`;

  function renderWaypoints() {
    const wps = store.get(wpPath()) || [];
    list.textContent = '';
    setText(tour.querySelector('.waypoint-count'), wps.length ? `${wps.length} of ${MAX_WAYPOINTS} waypoints` : 'No waypoints yet. Turn on Edit on map and click the map.');
    clearBtn.disabled = !wps.length;
    wps.forEach((wp, i) => {
      const sel = h('select', { class: 'select-native', 'aria-label': `Waypoint ${i + 1} travel time` },
        BEAT_CHOICES.map(b => h('option', { value: String(b) }, b < 1 ? `${b} beat` : `${b} beat${b === 1 ? '' : 's'}`)));
      const nearest = BEAT_CHOICES.reduce((a, b) => (Math.abs(b - wp.beats) < Math.abs(a - wp.beats) ? b : a), BEAT_CHOICES[0]);
      sel.value = String(nearest);
      sel.addEventListener('change', () => store.set(`${wpPath()}.${i}.beats`, Number(sel.value), { source: 'ui' }));
      const del = h('button', { type: 'button', class: 'icon-btn icon-btn--xs', 'aria-label': `Delete waypoint ${i + 1}`, html: icon('close') });
      del.addEventListener('click', () => {
        const next = (store.get(wpPath()) || []).filter((_, k) => k !== i);
        store.set(wpPath(), next, { source: 'ui' });
      });
      list.appendChild(h('li', { class: 'waypoint' },
        h('span', { class: 'waypoint-num' }, String(i + 1)),
        h('span', { class: 'waypoint-pos mono' }, `${(wp.x ?? 0).toFixed(2)}, ${(wp.y ?? 0).toFixed(2)}`),
        h('div', { class: 'select select--xs' }, sel, h('span', { class: 'select-caret', html: icon('chevron-down') })),
        del));
    });
  }
  scope.on(clearBtn, 'click', () => store.set(wpPath(), [], { source: 'ui' }));

  function render() {
    const mode = store.get(`parts.${binder.selected()}.dot.mode`) || 0;
    setText(title, `Dot: ${DOT_MODES[mode] || 'Pin'}`);
    setText(note, MODE_NOTES[mode] || '');
    for (const g of body.querySelectorAll('.dot-group')) g.hidden = !g.dataset.modes.split(',').includes(String(mode));
    if (mode === 4) renderWaypoints();
    pop && pop.reposition();
  }
  let pop = null;
  scope.add(binder.path('dot.mode', { id: 'dotMode', curve: 'enum', min: 0, max: DOT_MODES.length - 1, default: 0 }).subscribe(() => schedule(render)));
  scope.add(store.subscribe('parts', (path) => { if (/\.dot\.waypoints/.test(path) || /^parts\.\d+\.dot$/.test(path)) schedule(render); }));
  render();
  pop = openPopover(ctx.layers, anchor, body, {
    className: 'popover--dot', label: 'Dot settings', placement: 'bottom-end',
    // Switching the dot mode in the same toolbar keeps the settings open and shows the new mode's controls.
    within: anchor && anchor.closest ? anchor.closest('.vp-toolbar') : null,
    onClose: () => scope.dispose(),
  });
  return pop;
}
