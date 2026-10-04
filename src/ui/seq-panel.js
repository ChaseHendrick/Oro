// SEQ tab: 16-step sequencer for the selected track plus its arpeggiator and the
// global key, scale, swing and keyboard mode. A track holds several patterns
// (the picker in the Pattern block adds, chooses and removes them); the grid
// edits the one the track plays (its activePattern). Steps store scale degrees, so the
// note names shown here follow the global key and scale. On phones and touch
// screens the CSS gives every step cell a 44px target and lets the grid scroll
// sideways with the row names pinned; the code below works either way.
//
// v2.9: the Pattern block holds the track's song-mode chain (Chain on/off and
// the list of entries, the one playing highlighted) and Capture; the grid has
// a Lock row that edits one chosen parameter's lock on each step.

import {
  SEQ_STEPS, SEQ_RATES, ARP_MODES, ARP_RHYTHMS, NOTE_NAMES, SCALES, SCALE_NAMES, MAX_PATTERNS, RATCHET_MAX, stepToMidi, stepSlice, clamp, defaultStep,
  activePatternIndex, patternPath, stepProb, stepRatchet,
  PLOCK_IDS, PLOCK_MAX, PART_PARAM_MAP, CHAIN_MAX, CHAIN_REPEATS_MAX, toNorm, fromNorm, formatValue,
} from '../core/params.js';
import { EVEN_SLICES, sanitizeSampler } from '../dsp/sampler.js';
import { addPattern, selectPattern, removePattern } from '../core/tracks.js';
import { createGhostBar } from './ghost-ui.js';
import { h, createScope, setText, setAttr, listen, call, has } from './dom.js';
import { schedule } from './frame.js';
import { createToggle, createSelect, createStepper, createMiniSlider, createSegmented } from './controls.js';
import { icon } from './icons.js';
import { createDrumPanel } from './drum-panel.js';
import { createMidiFileTools } from './midi-file-tools.js';
import { createPianoRoll } from './piano-roll.js';
import { CHORD_PRESET_NAMES, CHORD_LEARNED, sanitizeChord, chordNotes, learnChord } from '../music/chord-trigger.js';

export function midiName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

const ROWS = ['on', 'degree', 'octave', 'vel', 'gate', 'prob', 'ratchet', 'accent', 'slide', 'lock', 'plock'];
const LABELS = ['Step', 'Note', 'Oct', 'Vel', 'Gate', 'Prob', 'Ratch', 'Accent', 'Slide', 'Dot', 'Lock'];
const LABEL_TIPS = { Prob: 'Probability', Ratch: 'Ratchet', Lock: 'Parameter lock' };
const GROUP_NAMES = { terrain: 'Terrain', path: 'Path', voice: 'Voice', filter: 'Filter', filter2: 'Filter 2', mix: 'Mix', sampler: 'Sampler' };
/** Parameter locks are kept tidy: five significant digits. */
const tidyValue = (v) => Number(v.toPrecision(5));

// Local pattern tools so editing still works if the music module is missing.
function localClear(store, part) {
  store.set(`${patternPath(store, part)}.steps`, Array.from({ length: SEQ_STEPS }, defaultStep), { source: 'ui' });
}
function localShift(store, part, dir) {
  const path = patternPath(store, part);
  const steps = store.get(`${path}.steps`) || [];
  const len = clamp(store.get(`${path}.length`) || SEQ_STEPS, 1, SEQ_STEPS);
  const head = steps.slice(0, len), tail = steps.slice(len);
  const rotated = dir > 0 ? [head[len - 1], ...head.slice(0, len - 1)] : [...head.slice(1), head[0]];
  store.set(`${path}.steps`, [...rotated, ...tail].map(s => ({ ...s })), { source: 'ui' });
}
function localRandom(store, part, density = 0.6) {
  const scaleLen = (SCALES[SCALE_NAMES[store.get('global.scaleType')]] || SCALES.Minor).length;
  const steps = Array.from({ length: SEQ_STEPS }, (_, i) => ({
    ...defaultStep(),
    on: Math.random() < (i % 4 === 0 ? density + 0.25 : density) ? 1 : 0,
    degree: Math.floor(Math.random() * (scaleLen + 3)) - 2,
    vel: 0.55 + Math.random() * 0.4,
    gate: 0.3 + Math.random() * 0.5,
    accent: Math.random() < 0.15 ? 1 : 0,
    slide: Math.random() < 0.1 ? 1 : 0,
  }));
  store.set(`${patternPath(store, part)}.steps`, steps, { source: 'ui' });
}

export function createSeqPanel(ctx) {
  const scope = createScope();
  const { store, binder, music } = ctx;
  const hasMusic = !!(music && music.transport);
  const sel = () => binder.selected();
  const seqPath = () => patternPath(store, sel());

  // ---------------------------------------------------------------- side controls
  const P = (rel, def) => binder.path(rel, def);
  // A field of the pattern the track plays (follows the track and its active pattern).
  const PAT = (field, def) => binder.path((p, part) => `patterns.${activePatternIndex(part)}.${field}`, def);
  const seqOn = createToggle(ctx, P('seqOn', { id: 'seqEnabled', label: 'Sequencer', curve: 'bool', min: 0, max: 1, default: 0 }), {
    label: 'Seq on', iconName: 'seq', className: 'toggle--seq', tip: 'Play this track\'s pattern when the transport runs',
  });
  const seqRate = createSelect(ctx, PAT('rate', { id: 'seqRate', label: 'Step rate', curve: 'enum', min: 0, max: 5, default: 3, options: SEQ_RATES.map(r => r.name) }), { label: 'Step rate', className: 'select--sm' });
  const seqLen = createStepper(ctx, PAT('length', { id: 'seqLength', label: 'Length', curve: 'int', min: 1, max: 16, default: 16 }), { label: 'Pattern length', format: v => String(v) });
  const seqOct = createStepper(ctx, PAT('baseOctave', { id: 'seqOct', label: 'Octave', curve: 'int', min: 0, max: 7, default: 3 }), { label: 'Base octave', format: v => 'C' + v });
  // Pattern picker: which of the track's patterns plays, plus new (a copy) and remove.
  const patSelect = h('select', { class: 'select-native', 'aria-label': 'Pattern the track plays' });
  const patPick = h('div', { class: 'select select--sm seq-pattern-pick' }, patSelect, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  scope.on(patSelect, 'change', () => selectPattern(store, sel(), Number(patSelect.value)));
  const patAdd = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'New pattern (a copy of this one)', dataset: { tip: 'New pattern: a copy of this one' }, html: icon('plus') });
  scope.on(patAdd, 'click', () => addPattern(store, sel(), { copy: true }));
  const patDel = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Remove this pattern', dataset: { tip: 'Remove this pattern (a track keeps at least one)' }, html: icon('minus') });
  scope.on(patDel, 'click', () => {
    const p = sel();
    removePattern(store, p, activePatternIndex(store.get(`parts.${p}`)));
  });
  function renderPatterns() {
    const part = store.get(`parts.${sel()}`) || {};
    const list = Array.isArray(part.patterns) ? part.patterns : [];
    const active = activePatternIndex(part);
    const names = list.map(x => x.name || 'Pattern');
    if (patSelect.options.length !== names.length || names.some((nm, k) => patSelect.options[k].textContent !== nm)) {
      patSelect.replaceChildren(...names.map((nm, k) => h('option', { value: String(k) }, nm)));
    }
    patSelect.value = String(active);
    patAdd.disabled = list.length >= MAX_PATTERNS;
    patDel.disabled = list.length <= 1;
  }
  // v2.9 song mode: the chain of patterns the track plays while Chain is on.
  const chainOn = createToggle(ctx, P('chain.on', { id: 'chainOn', label: 'Chain', curve: 'bool', min: 0, max: 1, default: 0, hint: 'Song mode: play the patterns in the list in order, then loop the list' }), {
    label: 'Chain', iconName: 'chain', className: 'toggle--sm', tip: 'Song mode: play the patterns in the list in order, then loop the list',
  });
  scope.add(chainOn.dispose);
  const chainAdd = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Add this pattern to the chain', dataset: { tip: 'Add the pattern shown above to the end of the chain' }, html: icon('plus') });
  const chainList = h('ol', { class: 'seq-chain', 'aria-label': 'Chain entries' });
  const chainEmpty = h('p', { class: 'seq-chain-empty' }, 'No entries yet. Add patterns to play them in order.');
  const chainBox = h('div', { class: 'seq-chain-box', role: 'group', 'aria-label': 'Song mode chain' },
    h('div', { class: 'seq-line' }, chainOn.el, h('span', { class: 'mini-label seq-chain-title' }, 'Song'), chainAdd), chainList, chainEmpty);
  const chainPath = () => `parts.${sel()}.chain`;
  const chainEntries = () => {
    const c = store.get(chainPath());
    return c && Array.isArray(c.entries) ? c.entries.map(e => ({ ...e })) : [];
  };
  let chainFocus = null;   // { i, act } to focus again after the list is rebuilt
  function writeChain(entries, focus = null) {
    const c = store.get(chainPath());
    chainFocus = focus;
    store.set(chainPath(), { on: c && c.on ? 1 : 0, entries }, { source: 'ui' });
  }
  scope.on(chainAdd, 'click', () => {
    const list = chainEntries();
    if (list.length >= CHAIN_MAX) return;
    list.push({ pattern: activePatternIndex(store.get(`parts.${sel()}`)), repeats: 1 });
    writeChain(list);
  });
  scope.on(chainList, 'click', (e) => {
    const b = e.target.closest && e.target.closest('button[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i), act = b.dataset.act;
    const list = chainEntries();
    if (!list[i]) return;
    if (act === 'edit') { selectPattern(store, sel(), list[i].pattern); return; }
    if (act === 'remove') { list.splice(i, 1); writeChain(list, list.length ? { i: Math.min(i, list.length - 1), act: 'remove' } : null); return; }
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    writeChain(list, { i: j, act });
  });
  scope.on(chainList, 'change', (e) => {
    const t = e.target;
    if (!t || t.dataset.act !== 'repeats') return;
    const i = Number(t.dataset.i);
    const list = chainEntries();
    if (!list[i]) return;
    list[i].repeats = clamp(Math.round(Number(t.value) || 1), 1, CHAIN_REPEATS_MAX);
    writeChain(list, { i, act: 'repeats' });
  });
  let chainPlaying = -1;
  function markChain(i) {
    chainPlaying = i;
    [...chainList.children].forEach((li, k) => { li.classList.toggle('is-play', k === i); setAttr(li, 'aria-current', k === i ? 'step' : null); });
  }
  function renderChain() {
    const part = store.get(`parts.${sel()}`) || {};
    const pats = Array.isArray(part.patterns) ? part.patterns : [];
    const list = chainEntries();
    const btn = (act, i, label, iconName, disabled = false) => h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': label, dataset: { act, i: String(i), tip: label }, html: icon(iconName), disabled });
    chainList.replaceChildren(...list.map((e, i) => {
      const name = (pats[e.pattern] && pats[e.pattern].name) || `Pattern ${e.pattern + 1}`;
      const reps = h('select', { class: 'select-native', 'aria-label': `Entry ${i + 1} repeats`, dataset: { act: 'repeats', i: String(i) } },
        ...Array.from({ length: CHAIN_REPEATS_MAX }, (_, k) => h('option', { value: String(k + 1) }, `x${k + 1}`)));
      reps.value = String(clamp(Math.round(e.repeats) || 1, 1, CHAIN_REPEATS_MAX));
      return h('li', { class: 'seq-chain-item' },
        h('span', { class: 'seq-chain-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('button', { type: 'button', class: 'seq-chain-name', 'aria-label': `Entry ${i + 1}: ${name}. Edit this pattern`, dataset: { act: 'edit', i: String(i), tip: 'Edit this pattern' } }, name),
        h('span', { class: 'select select--xs seq-chain-reps' }, reps),
        btn('up', i, `Move entry ${i + 1} earlier`, 'chevron-up', i === 0),
        btn('down', i, `Move entry ${i + 1} later`, 'chevron-down', i === list.length - 1),
        btn('remove', i, `Remove entry ${i + 1}`, 'close'));
    }));
    chainEmpty.hidden = list.length > 0;
    chainAdd.disabled = list.length >= CHAIN_MAX;
    markChain(chainPlaying);
    if (chainFocus) {
      const f = chainFocus;
      chainFocus = null;
      const li = chainList.children[f.i];
      const target = li && (li.querySelector(`[data-act="${f.act}"]:not([disabled])`) || li.querySelector('.seq-chain-name'));
      if (target) target.focus();
    }
  }

  // v2.9 Capture: the phrase just played on this track becomes the pattern.
  const captureBtn = h('button', {
    type: 'button', class: 'toggle toggle--sm has-icon seq-capture-btn', 'aria-label': 'Capture: turn the notes you just played on this track into this pattern',
    dataset: { tip: 'Turn the notes you just played on this track (keys or MIDI) into this pattern' }, html: icon('resample') + '<span class="toggle-text">Capture</span>',
  });
  const captureStatus = h('p', { class: 'seq-capture-status', role: 'status' });
  const roll = createPianoRoll(ctx);
  scope.add(roll.dispose);
  scope.on(captureBtn, 'click', () => {
    const res = has(music, 'capture') ? call(music, 'capture', sel()) : { ok: false, message: 'Capture needs the music engine, which is not available here.' };
    setText(captureStatus, (res && res.message) || '');
  });
  scope.add(store.subscribe('ui.selectedPart', () => setText(captureStatus, '')));
  // v2.9 Ghost replay
  const ghostBar = createGhostBar(ctx);
  scope.add(ghostBar.dispose);

  const tool = (name, label, fn) => {
    const b = h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': label, dataset: { tip: label }, html: icon(name) });
    scope.on(b, 'click', fn);
    return b;
  };
  const lockGlide = createMiniSlider(ctx, PAT('lockGlide', { id: 'lockGlide', label: 'Dot glide', curve: 'lin', min: 0, max: 1, default: 0.5, hint: 'How long the dot takes to reach a step\'s locked spot (0 jumps)' }), {
    ariaLabel: 'Dot lock glide time', format: v => (v < 0.005 ? 'Jump' : Math.round(v * 100) + '% of a step'),
  });
  // v2.6 humanize
  const humanTime = createMiniSlider(ctx, PAT('humanTime', { id: 'humanTime', label: 'Humanize time', curve: 'lin', min: 0, max: 1, default: 0, hint: 'Play each note up to 20 ms late, a little differently every pass' }), {
    ariaLabel: 'Humanize timing', format: v => (v < 0.005 ? 'Off' : `${Math.round(v * 20)} ms`),
  });
  const humanVel = createMiniSlider(ctx, PAT('humanVel', { id: 'humanVel', label: 'Humanize velocity', curve: 'lin', min: 0, max: 1, default: 0, hint: 'Vary each note\'s velocity by up to 30% either way' }), {
    ariaLabel: 'Humanize velocity', format: v => (v < 0.005 ? 'Off' : `±${Math.round(v * 30)}%`),
  });
  // Lock Record goes through the music module when it has one (it owns the
  // recording logic); the store flag alone is the fallback it also reads.
  const lockRecBinding = { ...binder.uiValue('lockRecord', [0, 1], 0), def: { id: 'lockRecord', label: 'Rec dot', default: 0 } };
  const setLockFlag = lockRecBinding.set;
  lockRecBinding.set = (v, meta) => {
    if (has(music, 'setLockRecord')) call(music, 'setLockRecord', !!v);
    if ((store.get('ui.lockRecord') ? 1 : 0) !== (v ? 1 : 0)) setLockFlag(v ? 1 : 0, meta);
  };
  const lockRec = createToggle(ctx, lockRecBinding, {
    label: 'Rec dot', iconName: 'record', className: 'toggle--sm toggle--rec',
    tip: 'While playing, moving the dot records it into the step that is sounding',
  });
  // v2.9 MIDI file export / import
  const midiTools = createMidiFileTools(ctx, sel);
  scope.add(midiTools.dispose);
  const tools = h('div', { class: 'seq-tools' },
    tool('dice', 'Randomise pattern', () => {
      if (has(music, 'randomizePattern')) call(music, 'randomizePattern', sel(), { density: 0.6 }); else localRandom(store, sel());
    }),
    tool('trash', 'Clear pattern', () => {
      if (has(music, 'clearPattern')) call(music, 'clearPattern', sel()); else localClear(store, sel());
    }),
    tool('arrow-left', 'Shift pattern left', () => {
      if (has(music, 'shiftPattern')) call(music, 'shiftPattern', sel(), -1); else localShift(store, sel(), -1);
    }),
    tool('arrow-right', 'Shift pattern right', () => {
      if (has(music, 'shiftPattern')) call(music, 'shiftPattern', sel(), 1); else localShift(store, sel(), 1);
    }));

  const arpMode = createSelect(ctx, P('arp.mode', { id: 'arpMode', label: 'Arp mode', curve: 'enum', min: 0, max: ARP_MODES.length - 1, default: 0, options: ARP_MODES }), { label: 'Arpeggiator mode', className: 'select--sm' });
  const arpRhythm = createSelect(ctx, P('arp.rhythm', { id: 'arpRhythm', label: 'Rhythm', curve: 'enum', min: 0, max: ARP_RHYTHMS.length - 1, default: 0, options: ARP_RHYTHMS.map(r => r.name) }), { label: 'Arpeggiator rhythm', className: 'select--sm' });
  const arpRate = createSelect(ctx, P('arp.rate', { id: 'arpRate', label: 'Arp rate', curve: 'enum', min: 0, max: 5, default: 3, options: SEQ_RATES.map(r => r.name) }), { label: 'Arpeggiator rate', className: 'select--sm' });
  const arpOct = createSegmented(ctx, P('arp.octaves', { id: 'arpOct', label: 'Octaves', curve: 'int', min: 1, max: 4, default: 1 }), {
    label: 'Arpeggiator octaves', size: 'sm', options: [1, 2, 3, 4].map(v => ({ value: v, label: String(v), aria: `${v} octave${v > 1 ? 's' : ''}` })),
  });
  const arpGate = createMiniSlider(ctx, P('arp.gate', { id: 'arpGate', label: 'Gate', curve: 'lin', min: 0.05, max: 1, default: 0.6 }), { ariaLabel: 'Arpeggiator gate length', format: v => Math.round(v * 100) + '%' });
  const arpHold = createToggle(ctx, P('arp.hold', { id: 'arpHold', label: 'Hold', curve: 'bool', min: 0, max: 1, default: 0, hint: 'Latch: notes keep arpeggiating after you let go' }), { label: 'Hold', iconName: 'hold', className: 'toggle--sm' });

  // v2.8 chord trigger (src/music/chord-trigger.js), stored in parts.N.chord
  const chordOn = createToggle(ctx, P('chord.on', { id: 'chordOn', label: 'Chord', curve: 'bool', min: 0, max: 1, default: 0, hint: 'Chord trigger: every note this track gets (keys, MIDI, the sequencer, the arp\'s input) plays a chord built on it' }), { label: 'Chord', iconName: 'chord', className: 'toggle--sm' });
  const chordPreset = createSelect(ctx, P('chord.preset', { id: 'chordPreset', label: 'Chord type', curve: 'enum', min: 0, max: CHORD_LEARNED, default: 0, options: CHORD_PRESET_NAMES }), { label: 'Chord type', className: 'select--sm' });
  const chordKey = createToggle(ctx, P('chord.inKey', { id: 'chordInKey', label: 'In key', curve: 'bool', min: 0, max: 1, default: 0, hint: 'Build the chord from the global key and scale, so it changes with the note (in C major, D plays D minor)' }), { label: 'In key', className: 'toggle--sm' });
  const learnBtn = h('button', { type: 'button', class: 'toggle toggle--sm has-icon', 'aria-label': 'Learn a chord from the keys held now', dataset: { tip: 'Hold a chord on the keyboard or a MIDI controller, then press Learn' }, html: icon('learn') + '<span class="toggle-text">Learn</span>' });
  const chordShow = h('span', { class: 'chord-readout', 'aria-live': 'polite' });
  scope.on(learnBtn, 'click', () => {
    const p = sel();
    const held = music && music.router && typeof music.router.rawHeld === 'function' ? music.router.rawHeld(p) : [];
    const notes = learnChord(held);
    if (!notes || notes.length < 2) { if (ctx.toast) ctx.toast('Hold two or more keys, then press Learn', { kind: 'info' }); return; }
    store.batch(() => {
      const cur = sanitizeChord(store.get(`parts.${p}.chord`));
      store.set(`parts.${p}.chord`, { ...cur, on: 1, preset: CHORD_LEARNED, notes }, { source: 'ui' });
    });
    if (ctx.toast) ctx.toast(`Learned ${notes.map(n => midiName(held[0] + n)).join(' ')}`, { kind: 'success' });
  });
  function renderChord() {
    const c = sanitizeChord(store.get(`parts.${sel()}.chord`));
    const root = store.get('global.scaleRoot') ?? 9, scaleType = store.get('global.scaleType') ?? 1;
    const from = 60 + root;
    const names = chordNotes(from, c, { root, scaleType }).map(midiName).join(' ');
    setText(chordShow, `${c.on ? '' : 'Off. '}${midiName(from).replace(/-?\d+$/, '')} plays ${names}`);
  }
  scope.add(store.subscribe('parts', (path) => { if (path === '' || path === 'parts' || /^parts\.\d+(\.chord.*)?$/.test(path)) schedule(renderChord); }));
  scope.add(store.subscribe('ui.selectedPart', () => schedule(renderChord)));
  scope.add(store.subscribe('global', () => schedule(renderChord)));
  renderChord();

  const key = createSelect(ctx, binder.globalParam('scaleRoot'), { label: 'Key', className: 'select--sm' });
  const scale = createSelect(ctx, binder.globalParam('scaleType'), { label: 'Scale', className: 'select--sm' });
  const swing = createMiniSlider(ctx, binder.globalParam('swing'), { ariaLabel: 'Swing', format: v => Math.round(v * 100) + '%' });
  const keyMode = createSegmented(ctx, binder.globalParam('keyMode'), { label: 'Keyboard plays', size: 'sm' });
  for (const c of [chordOn, chordPreset, chordKey]) scope.add(c.dispose);
  for (const c of [seqOn, seqRate, seqLen, seqOct, arpMode, arpRate, arpRhythm, arpOct, arpGate, arpHold, key, scale, swing, keyMode, lockGlide, lockRec, humanTime, humanVel]) scope.add(c.dispose);

  const field = (label, control, cls = '') => h('div', { class: ['field-row', cls] }, h('span', { class: 'mini-label' }, label), control);
  const side = h('div', { class: 'seq-side' },
    h('section', { class: 'seq-block', 'aria-label': 'Pattern' },
      h('header', { class: 'section-head' }, h('h3', { class: 'section-title' }, 'Pattern')),
      h('div', { class: 'seq-line seq-patterns' }, patPick, patAdd, patDel),
      chainBox,
      h('div', { class: 'seq-line seq-capture' }, captureBtn, roll.button),
      captureStatus,
      ghostBar.el,
      h('div', { class: 'seq-line' }, seqOn.el, seqRate.el),
      h('div', { class: 'seq-pair' },
        h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Length'), seqLen.el),
        h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Octave'), seqOct.el)),
      h('div', { class: 'seq-line seq-dotline' }, lockRec.el, h('div', { class: 'field-col field-col--grow' }, h('span', { class: 'mini-label' }, 'Dot glide'), lockGlide.el)),
      h('span', { class: 'mini-label seq-human-label' }, 'Humanize'),
      h('div', { class: 'seq-pair' },
        h('div', { class: 'field-col field-col--grow' }, h('span', { class: 'mini-label' }, 'Time'), humanTime.el),
        h('div', { class: 'field-col field-col--grow' }, h('span', { class: 'mini-label' }, 'Velocity'), humanVel.el)),
      tools,
      midiTools.el));

  // v2.11 Match a song: its code loads the first time the button is used
  const matchBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm seq-match', dataset: { action: 'match-song' } }, 'Match a song');
  const soundBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm seq-sound', dataset: { action: 'match-sound' } }, 'Match a sound');
  let matchPop = null;
  let soundMatch = null;
  scope.on(matchBtn, 'click', () => {
    if (matchPop && matchPop.isOpen?.()) { matchPop.close(); return; }
    import('./match-song.js').then((m) => { matchPop = m.openMatchSong(ctx, matchBtn); })
      .catch(() => ctx.toast?.('Match a song could not load', { kind: 'error' }));
  });
  scope.on(soundBtn, 'click', () => {
    import('./sound-match.js').then((m) => {
      if (!soundMatch) {
        soundMatch = m.createSoundMatch(ctx);
        soundBtn.after(soundMatch.panel);
        scope.add(soundMatch.dispose);
      }
      soundMatch.open();
    }).catch(() => ctx.toast?.('Match a sound could not load', { kind: 'error' }));
  });
  const globalBar = h('div', { class: 'seq-global', role: 'group', 'aria-label': 'Key and feel (all tracks)' },
    field('Key', key.el), field('Scale', scale.el), field('Swing', swing.el, 'field-row--swing'), field('Keys play', keyMode.el), matchBtn, soundBtn,
    h('span', { class: 'seq-global-note' }, 'All tracks'));
  const arpBar = h('div', { class: 'seq-arp', role: 'group', 'aria-label': 'Arpeggiator for this track' },
    h('span', { class: 'section-title' }, 'Arp'), arpMode.el, arpRate.el, arpRhythm.el, field('Octaves', arpOct.el), field('Gate', arpGate.el, 'field-row--gate'), arpHold.el);
  const chordBar = h('div', { class: 'seq-arp seq-chord', role: 'group', 'aria-label': 'Chord trigger for this track' },
    h('span', { class: 'section-title' }, 'Chord'), chordOn.el, chordPreset.el, chordKey.el, learnBtn, chordShow);

  // ---------------------------------------------------------------- grid
  const cells = {};
  for (const r of ROWS) cells[r] = [];
  const nums = [];
  const cols = [];
  for (let i = 0; i < SEQ_STEPS; i++) {
    const num = h('span', { class: 'seq-num', 'aria-hidden': 'true' }, String(i + 1));
    nums.push(num);
    const pad = h('button', { type: 'button', class: 'seq-pad', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1}` });
    const note = h('span', { class: 'seq-note', role: 'spinbutton', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} note` });
    const oct = h('span', { class: 'seq-oct', role: 'spinbutton', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} octave`, 'aria-valuemin': '-2', 'aria-valuemax': '2' });
    const vel = h('span', { class: 'seq-bar seq-bar--vel', role: 'slider', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} velocity`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { class: 'seq-bar-fill' }));
    const gate = h('span', { class: 'seq-bar seq-bar--gate', role: 'slider', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} gate`, 'aria-valuemin': '5', 'aria-valuemax': '100' }, h('span', { class: 'seq-bar-fill' }));
    const prob = h('span', {
      class: 'seq-bar seq-bar--prob', role: 'slider', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} probability`, 'aria-valuemin': '0', 'aria-valuemax': '100',
      dataset: { tip: 'Probability: the chance this step plays each time it comes round' },
    }, h('span', { class: 'seq-bar-fill' }));
    const rat = h('span', {
      class: 'seq-oct seq-rat', role: 'spinbutton', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1} ratchet`, 'aria-valuemin': '1', 'aria-valuemax': String(RATCHET_MAX),
      dataset: { tip: 'Ratchet: play the step 1 to 4 times, evenly spaced. Click to cycle, drag up or down to set.' },
    });
    const acc = h('button', { type: 'button', class: 'seq-flag seq-flag--acc', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1} accent` });
    const slide = h('button', { type: 'button', class: 'seq-flag seq-flag--slide', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1} slide` });
    const lock = h('button', {
      type: 'button', class: 'seq-lock', tabindex: i === 0 ? '0' : '-1', 'aria-pressed': 'false', 'aria-label': `Step ${i + 1} dot lock`,
      dataset: { tip: 'Dot lock: the dot glides here when this step plays. Click to lock it to where the dot is now, Shift-click, right-click or long-press to move the lock there, click again to clear.' },
    }, h('span', { class: 'seq-lock-dot' }));
    const plock = h('span', {
      class: 'seq-bar seq-plock', role: 'slider', tabindex: i === 0 ? '0' : '-1', 'aria-valuemin': '0', 'aria-valuemax': '100',
      dataset: { tip: 'Parameter lock: click to lock the chosen parameter to its knob value for this step, drag up or down to change it, right-click or Delete to clear' },
    }, h('span', { class: 'seq-bar-fill' }), h('span', { class: 'seq-plock-mark', 'aria-hidden': 'true' }));
    cells.on.push(pad); cells.degree.push(note); cells.octave.push(oct); cells.vel.push(vel); cells.gate.push(gate); cells.prob.push(prob); cells.ratchet.push(rat); cells.accent.push(acc); cells.slide.push(slide); cells.lock.push(lock); cells.plock.push(plock);
    const col = h('div', { class: ['seq-col', i % 4 === 0 && 'is-beat'], dataset: { step: String(i) } }, num, pad, note, oct, vel, gate, prob, rat, acc, slide, lock, plock);
    cols.push(col);
  }
  const labels = h('div', { class: 'seq-labels', 'aria-hidden': 'true' },
    h('span', { class: 'seq-num' }, ''), ...LABELS.map(t => h('span', { class: `seq-label seq-label--${t.toLowerCase()}`, title: LABEL_TIPS[t] }, t)));
  const grid = h('div', { class: 'seq-grid', role: 'group', 'aria-label': 'Steps. Use the arrow keys to move along a row and up or down to change a value.' }, labels, ...cols);
  // v2.9 the parameter the Lock row edits (a view setting, not saved)
  let plockId = 'cutoff';
  const groups = {};
  for (const id of PLOCK_IDS) (groups[PART_PARAM_MAP[id].group] = groups[PART_PARAM_MAP[id].group] || []).push(id);
  const plockSelect = h('select', { class: 'select-native', 'aria-label': 'Parameter the Lock row edits' },
    ...Object.keys(groups).map(g => h('optgroup', { label: GROUP_NAMES[g] || g }, ...groups[g].map(id => h('option', { value: id }, PART_PARAM_MAP[id].label)))));
  plockSelect.value = plockId;
  const plockHint = h('span', { class: 'seq-plock-hint' });
  const plockBar = h('div', { class: 'seq-plock-bar', role: 'group', 'aria-label': 'Parameter locks' },
    h('span', { class: 'mini-label' }, 'Lock row'),
    h('span', { class: 'select select--sm seq-plock-pick' }, plockSelect, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' })),
    plockHint);
  scope.on(plockSelect, 'change', () => { plockId = PLOCK_IDS.includes(plockSelect.value) ? plockSelect.value : 'cutoff'; invalidate(); });
  const playNote = h('span', { class: 'seq-status', 'aria-live': 'off' });
  // v2.7 a drum kit track swaps the melodic grid for the kit's lanes
  const drums = createDrumPanel(ctx);
  scope.add(drums.dispose);
  const syncDrum = () => { grid.hidden = drums.isOn(); plockBar.hidden = drums.isOn(); };
  scope.add(store.subscribe('parts', (p) => { if (!/^parts\.\d+\.(params|mods|dot)\./.test(p)) syncDrum(); }));
  scope.add(store.subscribe('ui.selectedPart', syncDrum));
  syncDrum();
  const rollEl = roll.el;
  const main = h('div', { class: 'seq-main' }, globalBar, drums.el, grid, rollEl, plockBar, arpBar, chordBar, playNote);
  const el = h('div', { class: 'dock-pane dock-pane--seq' }, side, main);
  if (!hasMusic) {
    playNote.textContent = 'Playback is unavailable here (the music engine did not start). You can still edit patterns.';
    el.classList.add('no-music');
    seqOn.setDisabled(true, 'The music engine is not available');
    arpMode.setDisabled(true, 'The music engine is not available');
  }

  // ---------------------------------------------------------------- state
  const steps = () => store.get(`${seqPath()}.steps`) || [];
  const setStep = (i, field, value) => {
    const path = `${seqPath()}.steps.${i}`;
    const cur = store.get(path);
    if (!cur || cur[field] === value) return;
    store.set(`${path}.${field}`, value, { source: 'ui' });
  };
  /** Slices playback on this track: how many slices, and the sample's root. Null otherwise. */
  function sliceView() {
    const s = sanitizeSampler(store.get(`parts.${sel()}.sampler`));
    if (!s || !s.on || s.mode !== 3) return null;
    const count = s.slices && s.slices.length ? s.slices.length : EVEN_SLICES;
    return { count, root: s.root };
  }
  /** The slice this step will play, 0-based. A stored slice wins. Otherwise the note picks one. */
  function heardSlice(step, view, baseOct, scaleRoot, scaleType) {
    const named = stepSlice(step);
    if (named != null) return Math.min(view.count - 1, named);
    const midi = stepToMidi(step, baseOct, scaleRoot, scaleType);
    const n = view.count;
    return ((Math.round(midi) - view.root) % n + n) % n;
  }

  function render() {
    renderPatterns();
    renderChain();
    const st = steps();
    const path = seqPath();
    const len = clamp(store.get(`${path}.length`) || 16, 1, 16);
    const baseOct = store.get(`${path}.baseOctave`) ?? 3;
    const root = store.get('global.scaleRoot') ?? 9, scaleType = store.get('global.scaleType') ?? 1;
    const slices = sliceView();
    const noteLabel = labels.children[2];
    if (noteLabel) {
      setText(noteLabel, slices ? 'Slice' : 'Note');
      noteLabel.title = slices ? 'Which slice this step plays' : '';
    }
    for (let i = 0; i < SEQ_STEPS; i++) {
      const s = st[i] || defaultStep();
      const midi = stepToMidi(s, baseOct, root, scaleType);
      const name = midiName(midi);
      cols[i].classList.toggle('is-out', i >= len);
      cols[i].classList.toggle('is-on', !!s.on);
      setAttr(cells.on[i], 'aria-pressed', String(!!s.on));
      cells.on[i].classList.toggle('is-accent', !!s.accent);
      if (slices) {
        const k = heardSlice(s, slices, baseOct, root, scaleType);
        setText(cells.degree[i], String(k + 1));
        setAttr(cells.degree[i], 'aria-label', `Step ${i + 1} slice`);
        setAttr(cells.degree[i], 'aria-valuenow', String(k + 1));
        setAttr(cells.degree[i], 'aria-valuemin', '1');
        setAttr(cells.degree[i], 'aria-valuemax', String(slices.count));
        setAttr(cells.degree[i], 'aria-valuetext', `Slice ${k + 1} of ${slices.count}`);
      } else {
        setText(cells.degree[i], name);
        setAttr(cells.degree[i], 'aria-label', `Step ${i + 1} note`);
        setAttr(cells.degree[i], 'aria-valuenow', String(s.degree));
        setAttr(cells.degree[i], 'aria-valuemin', null);
        setAttr(cells.degree[i], 'aria-valuemax', null);
        setAttr(cells.degree[i], 'aria-valuetext', `${name}, scale degree ${s.degree + 1}`);
      }
      setText(cells.octave[i], s.octave > 0 ? '+' + s.octave : String(s.octave));
      cells.octave[i].classList.toggle('is-zero', !s.octave);
      cells.octave[i].classList.toggle('is-dim', !!slices);
      setAttr(cells.octave[i], 'aria-disabled', slices ? 'true' : null);
      setAttr(cells.octave[i], 'aria-valuenow', String(s.octave));
      cells.vel[i].firstChild.style.transform = `scaleY(${s.vel})`;
      setAttr(cells.vel[i], 'aria-valuenow', String(Math.round(s.vel * 100)));
      cells.gate[i].firstChild.style.transform = `scaleX(${s.gate})`;
      setAttr(cells.gate[i], 'aria-valuenow', String(Math.round(s.gate * 100)));
      const pr = stepProb(s), rt = stepRatchet(s);
      cells.prob[i].firstChild.style.transform = `scaleX(${pr})`;
      setAttr(cells.prob[i], 'aria-valuenow', String(Math.round(pr * 100)));
      setAttr(cells.prob[i], 'aria-valuetext', `${Math.round(pr * 100)}%`);
      setText(cells.ratchet[i], String(rt));
      cells.ratchet[i].classList.toggle('is-zero', rt === 1);
      setAttr(cells.ratchet[i], 'aria-valuenow', String(rt));
      setAttr(cells.ratchet[i], 'aria-valuetext', rt === 1 ? '1 hit' : `${rt} hits`);
      setAttr(cells.accent[i], 'aria-pressed', String(!!s.accent));
      setAttr(cells.slide[i], 'aria-pressed', String(!!s.slide));
      const locked = !!s.lock;
      setAttr(cells.lock[i], 'aria-pressed', String(locked));
      setAttr(cells.lock[i], 'aria-description', locked ? `Dot at ${(s.lx ?? 0.5).toFixed(2)}, ${(s.ly ?? 0.5).toFixed(2)}` : null);
      const dot = cells.lock[i].firstChild;
      dot.style.left = ((s.lx ?? 0.5) * 100).toFixed(1) + '%';
      dot.style.top = ((s.ly ?? 0.5) * 100).toFixed(1) + '%';
      const def = PART_PARAM_MAP[plockId];
      const pl = s.plocks && typeof s.plocks === 'object' ? s.plocks : null;
      const pLocked = !!pl && typeof pl[plockId] === 'number';
      const cell = cells.plock[i];
      cell.classList.toggle('is-set', pLocked);
      cell.classList.toggle('has-locks', !!pl && Object.keys(pl).length > 0);
      cell.firstChild.style.transform = `scaleY(${pLocked ? toNorm(def, pl[plockId]) : 0})`;
      setAttr(cell, 'aria-label', `Step ${i + 1} ${def.label} lock`);
      setAttr(cell, 'aria-valuenow', String(pLocked ? Math.round(toNorm(def, pl[plockId]) * 100) : 0));
      const others = pl ? Object.keys(pl).filter(k => k !== plockId).map(k => PART_PARAM_MAP[k] ? PART_PARAM_MAP[k].label : k) : [];
      setAttr(cell, 'aria-valuetext', (pLocked ? formatValue(def, pl[plockId]) : 'No lock') + (others.length ? `. Also locks ${others.join(', ')}` : ''));
    }
    const kv = knobValue(sel(), plockId);
    setText(plockHint, `Click a cell to lock ${PART_PARAM_MAP[plockId].label} to the knob (${formatValue(PART_PARAM_MAP[plockId], kv)}). Drag or use the arrow keys to change it, right-click or Delete clears.`);
  }
  /** The track's own (knob) value of part parameter `id`. */
  function knobValue(p, id) {
    const v = store.get(`parts.${p}.params.${id}`);
    return typeof v === 'number' && Number.isFinite(v) ? v : PART_PARAM_MAP[id].default;
  }
  /** Set (or clear, value null) step i's lock on parameter `id`. */
  function setPlock(i, id, value) {
    const path = `${seqPath()}.steps.${i}`;
    const cur = store.get(path);
    if (!cur) return;
    const pl = { ...(cur.plocks && typeof cur.plocks === 'object' ? cur.plocks : {}) };
    if (value == null) {
      if (!(id in pl)) return;
      delete pl[id];
    } else {
      if (!(id in pl) && Object.keys(pl).length >= PLOCK_MAX) { setText(playNote, `A step holds at most ${PLOCK_MAX} parameter locks.`); return; }
      const def = PART_PARAM_MAP[id];
      const v = tidyValue(clamp(value, Math.min(def.min, def.max), Math.max(def.min, def.max)));
      if (pl[id] === v) return;
      pl[id] = v;
    }
    const { plocks: _old, ...rest } = cur;
    store.set(path, Object.keys(pl).length ? { ...rest, plocks: pl } : rest, { source: 'ui' });
  }
  /** Step i's lock on the chosen parameter as a 0..1 knob position (the knob's own when it has none). */
  function plockNorm(i) {
    const s = steps()[i] || {};
    const def = PART_PARAM_MAP[plockId];
    const v = s.plocks && typeof s.plocks[plockId] === 'number' ? s.plocks[plockId] : knobValue(sel(), plockId);
    return toNorm(def, v);
  }
  const invalidate = () => schedule(render);
  scope.add(store.subscribe('parts', (path) => { if (path === 'parts' || /^parts\.\d+(\.(patterns|activePattern|seqOn|chain|sampler).*)?$/.test(path)) invalidate(); }));
  scope.add(store.subscribe('global.scaleRoot', invalidate));
  scope.add(store.subscribe('global.scaleType', invalidate));
  scope.add(store.subscribe('parts', (path) => { if (/^parts\.\d+\.params\./.test(path) && path.endsWith('.' + plockId)) invalidate(); }));
  scope.add(store.subscribe('ui.selectedPart', () => { clearPlayhead(); chainPlaying = -1; invalidate(); }));
  scope.add(store.subscribe('', (path) => { if (path === '') invalidate(); }));

  // ---------------------------------------------------------------- interaction
  // Pads: click toggles; dragging across paints the same state.
  let paint = null;
  // The click that follows a press was already handled on pointerdown. Some
  // touch browsers report that click with detail 0, so also skip clicks that
  // name a pointer or follow a press; a click from a screen reader (no press,
  // no pointer type) still toggles.
  let pressed = false;
  cells.on.forEach((pad, i) => {
    scope.on(pad, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pressed = true;
      e.preventDefault();
      pad.focus({ preventScroll: true });
      const st = steps()[i];
      const next = st && st.on ? 0 : 1;
      paint = { value: next, id: e.pointerId };
      setStep(i, 'on', next);
      if (next) previewStep(i);
    });
    scope.on(pad, 'click', (e) => {
      if (pressed || e.pointerType) { pressed = false; return; }
      if (e.detail === 0) { const st = steps()[i]; setStep(i, 'on', st && st.on ? 0 : 1); }
    });
  });
  scope.on(grid, 'pointermove', (e) => {
    if (!paint || e.pointerId !== paint.id) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const i = target ? cells.on.indexOf(target.closest?.('.seq-pad')) : -1;
    if (i >= 0) setStep(i, 'on', paint.value);
  });
  scope.on(window, 'pointerup', () => { paint = null; if (pressed) setTimeout(() => { pressed = false; }, 400); });
  scope.on(window, 'pointercancel', () => { paint = null; pressed = false; });

  // Bars: set from the pointer's position, painting across steps while dragging.
  function barDrag(kind, field, min) {
    let active = null;
    const valueAt = (bar, e) => {
      const r = bar.getBoundingClientRect();
      return kind === 'vel' ? clamp((r.bottom - e.clientY) / r.height, min, 1) : clamp((e.clientX - r.left) / r.width, min, 1);
    };
    cells[field].forEach((bar, i) => {
      scope.on(bar, 'pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        bar.focus({ preventScroll: true });
        active = e.pointerId;
        setStep(i, field, Math.round(valueAt(bar, e) * 100) / 100);
      });
    });
    scope.on(grid, 'pointermove', (e) => {
      if (active !== e.pointerId) return;
      // On phones the grid scrolls sideways under pinned row names: only paint
      // steps that are actually visible (not under the names or scrolled off).
      const g = grid.getBoundingClientRect();
      if (e.clientX < labels.getBoundingClientRect().right || e.clientX > g.right) return;
      for (let i = 0; i < SEQ_STEPS; i++) {
        const r = cells[field][i].getBoundingClientRect();
        if (e.clientX >= r.left - 1 && e.clientX <= r.right + 1) { setStep(i, field, Math.round(valueAt(cells[field][i], e) * 100) / 100); break; }
      }
    });
    scope.on(window, 'pointerup', () => { active = null; });
  }
  barDrag('vel', 'vel', 0);
  barDrag('gate', 'gate', 0.05);
  barDrag('prob', 'prob', 0);

  // Note cells: vertical drag, wheel.
  cells.degree.forEach((cell, i) => {
    let st = null;
    scope.on(cell, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      cell.focus({ preventScroll: true });
      st = { id: e.pointerId, y: e.clientY, v: (steps()[i] || {}).degree || 0, moved: false, slice: false };
      const view = sliceView();
      if (view) {
        const baseOct = store.get(`${seqPath()}.baseOctave`) ?? 3;
        const root = store.get('global.scaleRoot') ?? 9;
        const scaleType = store.get('global.scaleType') ?? 1;
        st.slice = true;
        st.v = heardSlice(steps()[i] || {}, view, baseOct, root, scaleType);
        st.count = view.count;
      }
      try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      cell.classList.add('is-active');
    });
    scope.on(cell, 'pointermove', (e) => {
      if (!st || st.id !== e.pointerId) return;
      const d = Math.round((st.y - e.clientY) / 9);
      if (d !== 0 || st.moved) {
        st.moved = true;
        if (st.slice) {
          const next = clamp(st.v + d, 0, (st.count || 1) - 1);
          if (next !== stepSlice(steps()[i])) { setStep(i, 'slice', next); previewStep(i); }
        } else {
          const next = clamp(st.v + d, -21, 28);
          if (next !== (steps()[i] || {}).degree) { setStep(i, 'degree', next); previewStep(i); }
        }
      }
    });
    const end = () => { if (st && !st.moved) previewStep(i); st = null; cell.classList.remove('is-active'); };
    scope.on(cell, 'pointerup', end);
    scope.on(cell, 'pointercancel', end);
    let acc = 0;
    scope.on(cell, 'wheel', (e) => {
      e.preventDefault();
      acc += e.deltaY || e.deltaX;
      if (Math.abs(acc) < 30) return;
      const dir = acc < 0 ? 1 : -1;
      acc = 0;
      const view = sliceView();
      if (view) {
        const baseOct = store.get(`${seqPath()}.baseOctave`) ?? 3;
        const root = store.get('global.scaleRoot') ?? 9;
        const scaleType = store.get('global.scaleType') ?? 1;
        const cur = heardSlice(steps()[i] || {}, view, baseOct, root, scaleType);
        setStep(i, 'slice', clamp(cur + dir, 0, view.count - 1));
        return;
      }
      setStep(i, 'degree', clamp(((steps()[i] || {}).degree || 0) + dir, -21, 28));
    }, { passive: false });
  });
  cells.octave.forEach((cell, i) => {
    let st = null;
    scope.on(cell, 'pointerdown', (e) => {
      if (sliceView()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      cell.focus({ preventScroll: true });
      st = { id: e.pointerId, y: e.clientY, v: (steps()[i] || {}).octave || 0, moved: false };
      try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    scope.on(cell, 'pointermove', (e) => {
      if (sliceView() || !st || st.id !== e.pointerId) return;
      const d = Math.round((st.y - e.clientY) / 14);
      if (d !== 0) st.moved = true;
      setStep(i, 'octave', clamp(st.v + d, -2, 2));
    });
    const end = () => {
      if (sliceView()) { st = null; return; }
      if (st && !st.moved) {
        // A plain click cycles 0 -> +1 -> +2 -> -2 -> -1 -> 0.
        const v = (steps()[i] || {}).octave || 0;
        setStep(i, 'octave', v >= 2 ? -2 : v + 1);
      }
      st = null;
    };
    scope.on(cell, 'pointerup', end);
    scope.on(cell, 'pointercancel', () => { st = null; });
  });
  // Ratchet cells: vertical drag sets 1..RATCHET_MAX, a plain click cycles 1 -> 2 -> 3 -> 4 -> 1.
  cells.ratchet.forEach((cell, i) => {
    let st = null;
    scope.on(cell, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      cell.focus({ preventScroll: true });
      st = { id: e.pointerId, y: e.clientY, v: stepRatchet(steps()[i]), moved: false };
      try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    scope.on(cell, 'pointermove', (e) => {
      if (!st || st.id !== e.pointerId) return;
      const d = Math.round((st.y - e.clientY) / 14);
      if (d !== 0) st.moved = true;
      if (st.moved) setStep(i, 'ratchet', clamp(st.v + d, 1, RATCHET_MAX));
    });
    const end = () => {
      if (st && !st.moved) {
        const v = stepRatchet(steps()[i]);
        setStep(i, 'ratchet', v >= RATCHET_MAX ? 1 : v + 1);
      }
      st = null;
    };
    scope.on(cell, 'pointerup', end);
    scope.on(cell, 'pointercancel', () => { st = null; });
  });
  for (const field of ['accent', 'slide']) {
    cells[field].forEach((b, i) => scope.on(b, 'click', () => setStep(i, field, (steps()[i] || {})[field] ? 0 : 1)));
  }
  function toggleLock(i, recapture) {
    const p = sel();
    const st = (store.get(`${seqPath()}.steps.${i}`)) || defaultStep();
    if (st.lock && !recapture) {
      if (has(music, 'clearStepLock')) call(music, 'clearStepLock', p, i); else setStep(i, 'lock', 0);
      return;
    }
    const x = store.get(`parts.${p}.params.centerX`) ?? 0.5, y = store.get(`parts.${p}.params.centerY`) ?? 0.5;
    const wx = clamp(x - Math.floor(x), 0, 1), wy = clamp(y - Math.floor(y), 0, 1);
    if (has(music, 'setStepLock') && call(music, 'setStepLock', p, i, wx, wy) != null) return;
    const sp = `${seqPath()}.steps.${i}`;
    store.batch(() => {
      store.set(`${sp}.lx`, wx, { source: 'ui' });
      store.set(`${sp}.ly`, wy, { source: 'ui' });
      store.set(`${sp}.lock`, 1, { source: 'ui' });
    });
  }
  cells.lock.forEach((b, i) => {
    scope.on(b, 'click', (e) => toggleLock(i, e.shiftKey));
    // Right-click, or a long-press on touch screens (no Shift there), moves the lock to the dot.
    scope.on(b, 'contextmenu', (e) => { e.preventDefault(); toggleLock(i, true); });
  });

  // Lock row: click sets the knob value, a vertical drag changes it, right-click clears.
  cells.plock.forEach((cell, i) => {
    let st = null;
    scope.on(cell, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      cell.focus({ preventScroll: true });
      st = { id: e.pointerId, y: e.clientY, v: plockNorm(i), moved: false };
      try { cell.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    scope.on(cell, 'pointermove', (e) => {
      if (!st || st.id !== e.pointerId) return;
      const dy = st.y - e.clientY;
      if (Math.abs(dy) > 3) st.moved = true;
      if (st.moved) setPlock(i, plockId, fromNorm(PART_PARAM_MAP[plockId], clamp(st.v + dy / 80, 0, 1)));
    });
    scope.on(cell, 'pointerup', () => { if (st && !st.moved) setPlock(i, plockId, knobValue(sel(), plockId)); st = null; });
    scope.on(cell, 'pointercancel', () => { st = null; });
    scope.on(cell, 'contextmenu', (e) => { e.preventDefault(); st = null; setPlock(i, plockId, null); });
  });

  // Keyboard: roving focus within each row.
  for (const row of ROWS) {
    const list = cells[row];
    list.forEach((cell, i) => {
      scope.on(cell, 'keydown', (e) => {
        const s = steps()[i] || defaultStep();
        let move = 0, handled = true;
        switch (e.key) {
          case 'ArrowLeft': move = -1; break;
          case 'ArrowRight': move = 1; break;
          case 'Home': move = -i; break;
          case 'End': move = SEQ_STEPS - 1 - i; break;
          case 'ArrowUp': case 'ArrowDown': case 'PageUp': case 'PageDown': {
            const dir = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : -1;
            const big = e.key.startsWith('Page');
            if (row === 'degree') {
              const view = sliceView();
              if (view) {
                const baseOct = store.get(`${seqPath()}.baseOctave`) ?? 3;
                const root = store.get('global.scaleRoot') ?? 9;
                const scaleType = store.get('global.scaleType') ?? 1;
                const cur = heardSlice(s, view, baseOct, root, scaleType);
                setStep(i, 'slice', clamp(cur + dir * (big ? 4 : 1), 0, view.count - 1));
              } else setStep(i, 'degree', clamp(s.degree + dir * (big ? 7 : 1), -21, 28));
              previewStep(i);
            }
            else if (row === 'octave') { if (!sliceView()) setStep(i, 'octave', clamp(s.octave + dir, -2, 2)); }
            else if (row === 'vel') setStep(i, 'vel', clamp(Math.round((s.vel + dir * (big ? 0.2 : 0.05)) * 100) / 100, 0, 1));
            else if (row === 'gate') setStep(i, 'gate', clamp(Math.round((s.gate + dir * (big ? 0.2 : 0.05)) * 100) / 100, 0.05, 1));
            else if (row === 'prob') setStep(i, 'prob', clamp(Math.round((stepProb(s) + dir * (big ? 0.2 : 0.05)) * 100) / 100, 0, 1));
            else if (row === 'ratchet') setStep(i, 'ratchet', clamp(stepRatchet(s) + (big ? dir * RATCHET_MAX : dir), 1, RATCHET_MAX));
            else if (row === 'plock') setPlock(i, plockId, fromNorm(PART_PARAM_MAP[plockId], clamp(plockNorm(i) + dir * (big ? 0.2 : 0.05), 0, 1)));
            else handled = false;
            break;
          }
          case ' ': case 'Enter':
            if (row === 'on' || row === 'accent' || row === 'slide') {
              const field = row;
              setStep(i, field, s[field] ? 0 : 1);
              if (row === 'on' && !s.on) previewStep(i);
            } else if (row === 'ratchet') {
              const v = stepRatchet(s);
              setStep(i, 'ratchet', v >= RATCHET_MAX ? 1 : v + 1);
            } else if (row === 'lock') {
              toggleLock(i, e.shiftKey);
            } else if (row === 'plock') {
              setPlock(i, plockId, knobValue(sel(), plockId));
            } else handled = false;
            break;
          case 'Delete': case 'Backspace':
            if (row === 'plock') setPlock(i, plockId, null); else handled = false;
            break;
          default: handled = false;
        }
        if (!handled) return;
        e.preventDefault();
        e.stopPropagation();
        if (move) {
          const n = clamp(i + move, 0, SEQ_STEPS - 1);
          list.forEach((c, k) => { c.tabIndex = k === n ? 0 : -1; });
          list[n].focus();
        }
      });
      scope.on(cell, 'focus', () => list.forEach((c, k) => { c.tabIndex = k === i ? 0 : -1; }));
    });
  }

  // Audition a step when you set it (only while the transport is stopped).
  let previewOff = 0;
  function previewStep(i) {
    if (!music || !music.router || (music.transport && call(music.transport, 'isPlaying'))) return;
    const s = steps()[i];
    if (!s) return;
    const p = sel();
    const note = stepToMidi(s, store.get(`${seqPath()}.baseOctave`) ?? 3, store.get('global.scaleRoot') ?? 9, store.get('global.scaleType') ?? 1);
    const named = stepSlice(s);
    if (named != null && sliceView() && music.router._engineOn) {
      music.router._engineOn(p, note, s.vel ?? 0.8, 0, 'ui-preview', 0, named);
    } else call(music.router, 'noteOn', p, note, s.vel ?? 0.8, 'ui-preview');
    clearTimeout(previewOff);
    previewOff = setTimeout(() => call(music.router, 'noteOff', p, note, 'ui-preview'), 180);
  }

  // ---------------------------------------------------------------- playhead
  let lastCol = -1;
  function clearPlayhead() {
    if (lastCol >= 0 && cols[lastCol]) cols[lastCol].classList.remove('is-play');
    lastCol = -1;
    if (!call(music && music.transport, 'isPlaying') && chainPlaying !== -1) markChain(-1);
  }
  if (hasMusic) {
    scope.add(listen(music.transport, 'step', (ev) => {
      if (!ev || ev.part !== sel()) return;
      const i = ev.step;
      // v2.9 a chain may be playing another pattern than the one shown: no playhead then
      const shown = ev.pattern == null || ev.pattern === activePatternIndex(store.get(`parts.${sel()}`));
      const entry = ev.entry == null ? -1 : ev.entry;
      schedule(() => {
        if (!call(music.transport, 'isPlaying')) return;
        clearPlayhead();
        if (entry !== chainPlaying) markChain(entry);
        if (shown && cols[i]) { cols[i].classList.add('is-play'); lastCol = i; }
      });
    }));
    scope.add(listen(music.transport, 'state', (ev) => { if (!ev || !ev.playing) schedule(clearPlayhead); }));
  }
  scope.add(store.subscribe('ui.playing', () => { if (!store.get('ui.playing')) schedule(clearPlayhead); }));
  scope.add(() => clearTimeout(previewOff));

  render();
  return { el, dispose: scope.dispose };
}
