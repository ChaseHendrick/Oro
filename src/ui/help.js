// Help overlay: a short visual guide to wave terrain synthesis and the controls.

import { h, fromHTML } from './dom.js';
import { openModal } from './modal.js';
import { shortcutsList } from './settings.js';
import { icon } from './icons.js';

// An original diagram: contour rings (the land), an orbit with its dot (the
// path), and the waveform read off along the way (the sound).
const DIAGRAM = `
<svg class="help-diagram" viewBox="0 0 560 170" role="img" aria-label="A path circling over contour lines produces a waveform">
  <g class="hd-land" fill="none" stroke-width="1.4">
    <path d="M40 92c10-38 62-58 104-50 40 8 76 34 72 66-4 34-56 50-100 44-48-6-86-24-76-60z" opacity=".35"/>
    <path d="M62 94c8-26 46-40 78-34 30 6 54 24 50 46-4 24-40 34-72 30-34-4-62-16-56-42z" opacity=".55"/>
    <path d="M86 96c6-16 28-24 50-20 20 4 34 14 32 28-2 16-26 22-46 20-22-2-40-10-36-28z" opacity=".75"/>
    <path d="M108 98c4-8 14-12 26-10 10 2 16 8 14 14-2 8-12 10-22 9-10-1-20-5-18-13z"/>
  </g>
  <ellipse class="hd-orbit" cx="128" cy="100" rx="66" ry="34" fill="none" stroke-width="2.2" stroke-dasharray="5 5"/>
  <circle class="hd-center" cx="128" cy="100" r="4"/>
  <circle class="hd-point" cx="194" cy="100" r="6"/>
  <g class="hd-labels" font-size="12">
    <text x="40" y="160">1  The land</text>
    <text x="150" y="30">2  The path</text>
    <text x="350" y="160">3  The sound</text>
  </g>
  <path class="hd-arrow" d="M238 100h66" fill="none" stroke-width="1.6"/>
  <path class="hd-arrow" d="M298 94l8 6-8 6" fill="none" stroke-width="1.6"/>
  <path class="hd-axis" d="M330 100h200" fill="none" stroke-width="1"/>
  <path class="hd-wave" d="M330 100c12-40 26-52 40-44s18 34 30 36 18-30 30-34 22 22 30 40 18 30 30 26 20-30 40-24" fill="none" stroke-width="2.4"/>
</svg>`;

const CARDS = [
  { icon: 'pin', title: 'Move the dot', text: 'Click or drag on the map to place the dot, the centre of the orbit. Pin keeps it still, Roll makes it a marble, Drift lets it wander, Explore plays notes at peaks and valleys, and Tour follows your waypoints.' },
  { icon: 'relief', title: 'Shape the land', text: 'Pick Terrain A and B and Morph between them. Warp ripples the map, Lift drives it harder and Fold adds bright harmonics. Import an image or a WAV to play your own land.' },
  { icon: 'view-top', title: 'Shape the path', text: 'Choose a path shape. Size makes the tone brighter, Laps adds sync-style harmonics and Pace bends the speed along the way. On the map, Shift-drag changes Size and Alt-drag rotates.' },
  { icon: 'sliders', title: 'Twist the knobs', text: 'Drag up or down (Shift for fine), double-click to reset, and right-click to modulate or MIDI-learn. The bright bead shows the live value. Links route velocity, the marble or a Macro to anything.' },
  { icon: 'keyboard', title: 'Make music', text: 'Play the on-screen keys or your computer keyboard (A, W, S, E, D...). Program the 16-step sequencer, lock the dot to steps, or turn on the arpeggiator. Space plays and stops.' },
  { icon: 'mpc', title: 'Connect an MPC', text: 'Settings > MIDI & MPC connects your controller, learns your Q-Links and walks through the Akai MPC XL setup step by step.' },
];

export function openHelp(ctx, { onClose } = {}) {
  const content = h('div', { class: 'help' },
    h('div', { class: 'help-hero' },
      fromHTML(DIAGRAM),
      h('p', { class: 'help-lede' }, 'A closed path circles across a landscape once per cycle. The height of the land under the moving point is the sound: how fast the path is traced sets the pitch, and the shape of the land sets the tone.')),
    h('div', { class: 'help-cards' }, CARDS.map(c => h('article', { class: 'help-card' },
      h('span', { class: 'help-icon', html: icon(c.icon) }),
      h('h3', null, c.title),
      h('p', null, c.text)))),
    h('details', { class: 'help-shortcuts' }, h('summary', null, 'Keyboard shortcuts'), shortcutsList()));
  const modal = openModal(ctx.layers, ctx.root, {
    title: 'How Orograph works', content, wide: true, className: 'modal--help',
    onClose,
  });
  return modal;
}
