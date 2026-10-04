// Highlight names the lesson card can ask for. `snippet` is text that exists in `file`.

export const TARGETS = Object.freeze({
  'knob:cutoff': { selector: '.knob[data-param=cutoff]', file: 'src/ui/knob.js', snippet: 'dataset: { param: def.id }' },
  'knob:resonance': { selector: '.knob[data-param=resonance]', file: 'src/ui/knob.js', snippet: 'dataset: { param: def.id }' },
  'knob:size': { selector: '.knob[data-param=size]', file: 'src/ui/knob.js', snippet: 'dataset: { param: def.id }' },
  viewport: { selector: '[data-viewport]', file: 'src/ui/app.js', snippet: '[data-viewport]' },
  scope: { selector: '.scope-card', file: 'src/ui/scope.js', snippet: 'scope-card' },
  path: { selector: '.path-picker', file: 'src/ui/map-panel.js', snippet: 'path-picker' },
  terrainA: { selector: 'button[aria-label="Choose terrain A"]', file: 'src/ui/map-panel.js', snippet: 'Choose terrain' },
  dotmode: { selector: '.seg--dot', file: 'src/ui/viewport-overlay.js', snippet: 'seg--dot' },
  seq: { selector: '.seq-grid', file: 'src/ui/seq-panel.js', snippet: 'seq-grid' },
  chain: { selector: '.seq-chain-box', file: 'src/ui/seq-panel.js', snippet: 'seq-chain-box' },
  links: { selector: '.links-list', file: 'src/ui/links-panel.js', snippet: 'links-list' },
  filter: { selector: 'select[aria-label="Filter type"]', file: 'src/ui/sound-panel.js', snippet: 'Filter type' },
  resonator: { selector: 'select[aria-label="Resonator mode"]', file: 'src/ui/sound-panel.js', snippet: 'Resonator mode' },
  tuning: { selector: '#tuning-preset', file: 'src/ui/tuning-settings.js', snippet: 'tuning-preset' },
  quality: { selector: '[aria-label="Audio quality"]', file: 'src/ui/settings.js', snippet: 'Audio quality' },
});

export function highlightSelector(name) {
  return (TARGETS[name] && TARGETS[name].selector) || null;
}
