// Original line icons, drawn for Orograph on a 24 px grid. Static markup only
// (no user data is ever interpolated), returned as strings for innerHTML.

function gearPath() {
  // Eight rounded-trapezoid teeth around a ring.
  const teeth = 8, ro = 9.6, ri = 7.4, cx = 12, cy = 12;
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const w = (Math.PI * 2) / teeth;
    const angles = [a - w * 0.5, a - w * 0.2, a - w * 0.12, a + w * 0.12, a + w * 0.2];
    const radii = [ri, ri, ro, ro, ri];
    for (let k = 0; k < angles.length; k++) {
      pts.push([cx + radii[k] * Math.sin(angles[k]), cy - radii[k] * Math.cos(angles[k])]);
    }
  }
  return 'M' + pts.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z';
}

const P = {
  play: '<path d="M8.4 6.3v11.4c0 .8.9 1.3 1.6.9l9-5.7c.6-.4.6-1.3 0-1.7l-9-5.7c-.7-.5-1.6 0-1.6.8z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2.2" fill="currentColor" stroke="none"/>',
  record: '<circle cx="12" cy="12" r="5.6" fill="currentColor" stroke="none"/>',
  settings: `<path d="${gearPath()}"/><circle cx="12" cy="12" r="3.1"/>`,
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.2-2.5 3.8"/><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none"/>',
  'theme-system': '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 0 16.4z" fill="currentColor" stroke="none"/>',
  'theme-dark': '<path d="M19.6 14.6A8.2 8.2 0 0 1 9.4 4.4a8.2 8.2 0 1 0 10.2 10.2z"/>',
  'theme-light': '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  'chevron-left': '<path d="M14.5 6l-6 6 6 6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  'chevron-up': '<path d="M6.5 14.5L12 9l5.5 5.5"/>',
  close: '<path d="M6.8 6.8l10.4 10.4M17.2 6.8L6.8 17.2"/>',
  check: '<path d="M5.2 12.6l4.3 4.2L18.8 7.4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.6" r=".9" fill="currentColor" stroke="none"/>',
  warn: '<path d="M10.3 4.6L3.2 17.2A2 2 0 0 0 5 20.1h14a2 2 0 0 0 1.8-2.9L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.2"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.4v5.8"/><circle cx="12" cy="16.4" r=".9" fill="currentColor" stroke="none"/>',
  save: '<path d="M5 5.6A1.1 1.1 0 0 1 6.1 4.5h9.6l3.3 3.3v10.1a1.1 1.1 0 0 1-1.1 1.1H6.1A1.1 1.1 0 0 1 5 17.9z"/><path d="M8.3 4.5v4.2h6.4V4.5M8.3 19v-4.8h7.4V19"/>',
  dice: '<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="3.6"/><g fill="currentColor" stroke="none"><circle cx="8.6" cy="8.6" r="1.25"/><circle cx="15.4" cy="8.6" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="8.6" cy="15.4" r="1.25"/><circle cx="15.4" cy="15.4" r="1.25"/></g>',
  init: '<path d="M5.2 12a6.8 6.8 0 1 0 2.2-5"/><path d="M5.2 4.6v3.6h3.6"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="M15.5 15.5l4.3 4.3"/>',
  midi: '<circle cx="12" cy="12" r="8.6"/><g fill="currentColor" stroke="none"><circle cx="7.6" cy="12" r="1.1"/><circle cx="16.4" cy="12" r="1.1"/><circle cx="8.9" cy="8.9" r="1.1"/><circle cx="15.1" cy="8.9" r="1.1"/><circle cx="12" cy="7.6" r="1.1"/></g><path d="M10.6 17.4h2.8"/>',
  'view-orbit': '<path d="M3.4 13.2L12 8.6l8.6 4.6L12 17.8z"/><path d="M6.8 13.4l2.6-2.3 2.4 1.4 3.4-2.6 2.6 2.1"/>',
  'view-top': '<rect x="4" y="4" width="16" height="16" rx="2.4"/><path d="M12 8.2c2.4 0 3.9 1.6 3.9 3.6S14.4 15.8 12 15.8s-3.8-1.7-3.8-3.9S9.7 8.2 12 8.2z"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  'view-low': '<path d="M3 18h18"/><path d="M4 18l4.8-7.2 3.4 4.4 2.6-3.2 5.2 6"/><circle cx="17.2" cy="6.8" r="1.6"/>',
  rotate: '<ellipse cx="12" cy="12.6" rx="8.6" ry="4.3"/><path d="M16.2 6.2l3.1 2.5-3.3 2"/><circle cx="12" cy="12.6" r="1.4" fill="currentColor" stroke="none"/>',
  relief: '<path d="M3 18.5l5.8-8.6 3.6 4.6 2.8-3.4 5.8 7.4z" fill="currentColor" fill-opacity=".28"/><path d="M8.8 9.9l1.4 4.2"/>',
  wire: '<path d="M3.2 17l8.8-4 8.8 4-8.8 3.6z"/><path d="M7.6 15l8.8 3.8M16.4 15l-8.8 3.8"/><path d="M12 13V5.2M8 7.6l4-2.4 4 2.4"/>',
  contour: '<path d="M3.2 17.2c3.2-2.4 5.4.8 8.8-1.2s5.8-3 8.8-.8"/><path d="M5.6 12.6c2.2-2 4.4.2 7-1.3s4.2-1.8 6 0"/><path d="M8.6 8.2c1.6-1 2.9.3 4.6-.6s2.6-.9 3.6.1"/>',
  heat: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="3"/><path d="M4.2 9.4h15.6M4.2 14.6h15.6"/><path d="M4.4 4.6h15.2v4.8H4.4z" fill="currentColor" fill-opacity=".85" stroke="none"/><path d="M4.4 9.4h15.2v5.2H4.4z" fill="currentColor" fill-opacity=".4" stroke="none"/>',
  pin: '<path d="M12 20.6s-6.2-5.6-6.2-10.2a6.2 6.2 0 0 1 12.4 0c0 4.6-6.2 10.2-6.2 10.2z"/><circle cx="12" cy="10.4" r="2.2"/>',
  roll: '<circle cx="14.2" cy="11.8" r="5.4"/><path d="M11.4 9.6a3.4 3.4 0 0 1 2.4-1.3"/><path d="M2.8 9.4h4M2.2 13h4.6M3.6 16.6h5"/><path d="M3 20h18"/>',
  drift: '<path d="M3 15.4c2.4-4.4 5-4.4 7.2 0s5 4.4 7.2 0c.9-1.8 2-2.6 3.6-2.2"/><circle cx="20.4" cy="9.4" r="1.6" fill="currentColor" stroke="none"/>',
  sliders: '<path d="M4.5 7.5h8.6M17.4 7.5h2.1M4.5 16.5h2.6M11.4 16.5h8.1"/><circle cx="15.2" cy="7.5" r="2.1"/><circle cx="9.2" cy="16.5" r="2.1"/>',
  import: '<path d="M12 15.2V4.6M7.6 8.8L12 4.4l4.4 4.4"/><path d="M4.8 14.6v4a1.2 1.2 0 0 0 1.2 1.2h12a1.2 1.2 0 0 0 1.2-1.2v-4"/>',
  export: '<path d="M12 4.6v10.6M7.6 11L12 15.4l4.4-4.4"/><path d="M4.8 14.6v4a1.2 1.2 0 0 0 1.2 1.2h12a1.2 1.2 0 0 0 1.2-1.2v-4"/>',
  trash: '<path d="M4.8 7h14.4M9.6 7V5.2h4.8V7M6.6 7l.9 12a1.2 1.2 0 0 0 1.2 1.1h6.6a1.2 1.2 0 0 0 1.2-1.1l.9-12"/><path d="M10.2 10.6v5.8M13.8 10.6v5.8"/>',
  keyboard: '<rect x="3" y="5.4" width="18" height="13.2" rx="2"/><path d="M8.6 12.6v6M15.4 12.6v6"/><path d="M7.2 5.6v7h2.8v-7M14 5.6v7h2.8v-7" fill="currentColor" stroke="none"/>',
  sound: '<path d="M2.8 12h2.4l2.2-5.6 3.2 11.4 3-8.6 2.2 5.4 1.8-2.6h3.6"/>',
  mod: '<path d="M2.8 12c2.4-6.4 5-6.4 7.4 0s5 6.4 7.4 0"/><path d="M20.4 7.2v9.6" stroke-dasharray="1.6 2.2"/>',
  seq: '<rect x="3.4" y="6" width="3.8" height="5" rx="1" fill="currentColor" stroke="none"/><rect x="8.1" y="6" width="3.8" height="5" rx="1"/><rect x="12.8" y="6" width="3.8" height="5" rx="1" fill="currentColor" stroke="none"/><rect x="17.5" y="6" width="3.2" height="5" rx="1"/><path d="M3.6 15.4h17M3.6 18.6h9"/>',
  mix: '<path d="M6 4.4v15.2M12 4.4v15.2M18 4.4v15.2"/><rect x="4" y="12.4" width="4" height="3" rx="1" fill="currentColor"/><rect x="10" y="7.2" width="4" height="3" rx="1" fill="currentColor"/><rect x="16" y="14.6" width="4" height="3" rx="1" fill="currentColor"/>',
  map: '<path d="M3.6 6.6l5.4-2.2 6 2.2 5.4-2.2v13l-5.4 2.2-6-2.2-5.4 2.2z"/><path d="M9 4.4v13M15 6.6v13"/>',
  plus: '<path d="M12 5.6v12.8M5.6 12h12.8"/>',
  minus: '<path d="M5.6 12h12.8"/>',
  'arrow-left': '<path d="M19 12H5.4M10.6 6.6L5.2 12l5.4 5.4"/>',
  'arrow-right': '<path d="M5 12h13.6M13.4 6.6l5.4 5.4-5.4 5.4"/>',
  hold: '<path d="M7 19.4h10"/><path d="M8.6 19.2l1.8-9.6h5.4l-1 9.6"/><path d="M10.4 9.6L9.2 4.6"/>',
  learn: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3"/>',
  link: '<path d="M14 4.8h5.2V10M19.2 4.8l-8.4 8.4"/><path d="M17.2 13.6v4.6a1.2 1.2 0 0 1-1.2 1.2H5.8a1.2 1.2 0 0 1-1.2-1.2V8a1.2 1.2 0 0 1 1.2-1.2h4.6"/>',
  speaker: '<path d="M4.6 9.6h3.2l4.4-3.8v12.4l-4.4-3.8H4.6z"/><path d="M15.6 9.2a4 4 0 0 1 0 5.6M18 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  panic: '<path d="M8.4 3.6h7.2l5 5v7l-5 5H8.4l-5-5v-7z"/><path d="M12 8v5"/><circle cx="12" cy="16.2" r=".9" fill="currentColor" stroke="none"/>',
  wave: '<path d="M3 12c2-5 4-5 6 0s4 5 6 0 4-5 6 0"/>',
  mpc: '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.2"/><g fill="currentColor" stroke="none"><rect x="6" y="11" width="2.6" height="2.6" rx=".6"/><rect x="9.6" y="11" width="2.6" height="2.6" rx=".6"/><rect x="6" y="14.6" width="2.6" height="2.6" rx=".6"/><rect x="9.6" y="14.6" width="2.6" height="2.6" rx=".6"/></g><circle cx="16.4" cy="8.4" r="1.4"/><circle cx="16.4" cy="14" r="1.4"/><path d="M6 7.6h6.2"/>',
  usb: '<path d="M12 3.6v13.2"/><path d="M9.6 6L12 3.4 14.4 6"/><path d="M12 12.2L7.6 10V8.2M12 14.4l4.4-2.2V9.6"/><circle cx="12" cy="18.6" r="1.8"/><rect x="6.4" y="6.6" width="2.4" height="1.8" rx=".3"/><circle cx="16.4" cy="8.4" r="1.2"/>',
  edit: '<path d="M5 19l1-4.2L15.6 5.2a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L9.2 18z"/><path d="M13.8 7l3.2 3.2"/>',
  scene: '<rect x="3.6" y="6.6" width="12.4" height="12.4" rx="2"/><path d="M7.4 6.6V4.8a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H16"/>',
  'lfo-0': '<path d="M3 12c1.6-5.6 3.4-8 4.5-8S10.4 6.4 12 12s3.4 8 4.5 8 2.9-2.4 4.5-8"/>',
  'lfo-1': '<path d="M3 12l4.5-7.5 9 15L21 12"/>',
  'lfo-2': '<path d="M3 18L12 6v12l9-12"/>',
  'lfo-3': '<path d="M3 17.5V6.5h9v11h9V6.5"/>',
  'lfo-4': '<path d="M3 14h3.6V7.6h3.6v8.8h3.6v-6.4h3.6v4.6H21"/>',
  'lfo-5': '<path d="M3 13.6c2-3.8 3.6-4.6 5.4-2.6s2.6 4.6 4.8 3.4 2.4-6.2 4.6-6.6S20 9.6 21 11"/>',
  'lfo-6': '<path d="M3 15h3V8h3v9h3v-6h3v3h3V7h3"/>',
  explore: '<circle cx="12" cy="12" r="8.6"/><path d="M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1z"/>',
  tour: '<circle cx="5.6" cy="17.6" r="1.8"/><circle cx="18.4" cy="6.4" r="1.8"/><path d="M7.2 16.6c3.2-1.6 1.4-5 4.8-6.2s3.2-2 4.8-3"/><path d="M18.4 4.6V2.8"/>',
  points: '<g fill="currentColor" stroke="none"><circle cx="6" cy="16" r="1.3"/><circle cx="10" cy="14" r="1.3"/><circle cx="14" cy="15" r="1.3"/><circle cx="18" cy="13" r="1.3"/><circle cx="8" cy="10.5" r="1.3"/><circle cx="12" cy="9" r="1.3"/><circle cx="16" cy="9.5" r="1.3"/><circle cx="11" cy="5.5" r="1.3"/></g>',
  chain: '<path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"/><path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>',
  macro: '<circle cx="12" cy="13" r="6.8"/><path d="M12 13l3.2-3.2"/><path d="M5.2 6.2l1.4 1.4M18.8 6.2l-1.4 1.4M12 3.6v2"/>',
  bounce: '<path d="M3.6 12h2.2l1.8-4.6 2.6 9.2 2.6-7 1.8 4.4H16"/><path d="M17.8 8.4v8M15.2 13.8l2.6 2.6 2.6-2.6"/>',
  waypoint: '<path d="M12 20.6s-5.6-5-5.6-9.2a5.6 5.6 0 0 1 11.2 0c0 4.2-5.6 9.2-5.6 9.2z"/><path d="M12 8.6v5.6M9.2 11.4h5.6"/>',
  bolt: '<path d="M13.2 3.6L5.8 13.2h5.4l-1.2 7.2 7.4-9.6H12z"/>',
};

export function icon(name, { size, cls = '' } = {}) {
  const body = P[name] || P.info;
  const dim = size ? ` width="${size}" height="${size}"` : '';
  return `<svg class="icon ${cls}" viewBox="0 0 24 24"${dim} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/**
 * The Orograph glyph: stacked contour rings rising to a peak, with the orbit
 * dot circling the summit. Lines use currentColor, the dot uses --accent.
 */
export function brandGlyph(size = 26) {
  return `<svg class="brand-glyph" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.4 24.6c2.1-2.6 6.4-3.6 12.4-3.5 6 .1 10.5 1.2 12.4 3.4-2.4 2.3-7.1 3.4-12.6 3.3-5.6-.1-10.2-1.2-12.2-3.2z" stroke-width="1.5" opacity=".55"/>
    <path d="M7.2 19.4c1.6-2.2 4.6-3.2 8.8-3.1 4.3.1 7.4 1.1 8.7 3-1.7 1.8-5 2.7-8.9 2.6-3.9-.1-7.2-.9-8.6-2.5z" stroke-width="1.5" opacity=".75"/>
    <path d="M10.6 14.6c1.2-1.7 3-2.5 5.6-2.4 2.6.1 4.4.9 5.3 2.3-1.1 1.4-3.1 2-5.5 2-2.4-.1-4.4-.7-5.4-1.9z" stroke-width="1.5"/>
    <path d="M13.6 10.4c.7-1 1.5-1.4 2.6-1.4 1.1 0 1.9.5 2.4 1.3-.6.8-1.5 1.2-2.6 1.2-1.1 0-1.9-.4-2.4-1.1z" stroke-width="1.5"/>
    <ellipse cx="16.1" cy="6.2" rx="6.6" ry="2.1" stroke-width="1" opacity=".5" stroke-dasharray="1.4 1.8"/>
    <circle cx="21.9" cy="5.3" r="1.9" fill="var(--accent, currentColor)" stroke="none"/>
  </svg>`;
}
