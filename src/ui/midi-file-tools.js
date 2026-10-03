// Seq tab > Pattern > MIDI file (v2.9): export the selected track's pattern
// or every playing sequencer as a .mid file, and import a .mid file into the
// selected track's pattern (one undo step). See src/music/midi-file.js.

import { patternPath, activePatternIndex, SEQ_RATES } from '../core/params.js';
import { exportMidi, parseMidi, midiChoices, importMidiNotes, CHORD_MODES } from '../music/midi-file.js';
import { h, createScope, setText, downloadBlob, has } from './dom.js';
import { recordingName } from './record.js';
import { icon } from './icons.js';

const EXPORT_BARS = [1, 2, 4, 8, 16];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function midiFileName(date, label) {
  const tag = String(label || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'session';
  return recordingName(date).replace('oro-', `oro-${tag}-`).replace(/\.wav$/, '.mid');
}

/** The music module's offline replay (sequencers, arps, chord trigger), when there is one. */
const renderWith = (music) => (has(music, 'renderEvents') ? (bars, o) => music.renderEvents(bars, o) : null);

/**
 * Save `bars` bars of every track whose sequencer is on. Returns a status
 * sentence for the caller to show.
 */
export function saveSessionMidi(store, bars, music = null) {
  const res = exportMidi(store.serialize(), { mode: 'session', bars, render: renderWith(music) });
  if (!res.tracks) return 'No track has its sequencer on, so there is nothing to export.';
  downloadBlob(new Blob([res.bytes], { type: 'audio/midi' }), midiFileName(new Date(), 'session'));
  return `Saved ${plural(res.tracks, 'track')} and ${plural(res.notes, 'note')} (${plural(bars, 'bar')}) as a MIDI file.`;
}

export function createMidiFileTools(ctx, selected) {
  const { store, music } = ctx;
  const scope = createScope();
  const scopeSel = h('select', { class: 'select-native', 'aria-label': 'What to export' },
    h('option', { value: '0' }, 'This pattern'), ...EXPORT_BARS.map((b) => h('option', { value: String(b) }, `All tracks, ${plural(b, 'bar')}`)));
  const exportBtn = h('button', { type: 'button', class: 'btn btn--xs', 'aria-label': 'Export MIDI file', dataset: { tip: 'Save the pattern, or every track whose sequencer is on, as a .mid file' }, html: icon('save') + '<span>Export</span>' });
  const importBtn = h('button', { type: 'button', class: 'btn btn--xs', 'aria-label': 'Import MIDI file into this pattern', dataset: { tip: 'Read a .mid file into this track\'s pattern' }, html: icon('plus') + '<span>Import</span>' });
  const fileIn = h('input', { type: 'file', accept: '.mid,.midi,audio/midi,audio/x-midi', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const chordSel = h('select', { class: 'select-native', 'aria-label': 'Chords in an imported file' },
    ...CHORD_MODES.map((m) => h('option', { value: m.id }, m.name)));
  chordSel.value = 'high';
  const pickSel = h('select', { class: 'select-native', 'aria-label': 'Track in the MIDI file to import' });
  const pickGo = h('button', { type: 'button', class: 'btn btn--xs btn--primary' }, 'Use track');
  const pickCancel = h('button', { type: 'button', class: 'btn btn--xs btn--ghost' }, 'Cancel');
  const pickRow = h('div', { class: 'seq-midi-pick', hidden: true },
    h('div', { class: 'select select--sm' }, pickSel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' })),
    h('div', { class: 'seq-midi-row' }, pickGo, pickCancel));
  const status = h('p', { class: 'seq-midi-status', role: 'status', 'aria-live': 'polite' });
  let pending = null; // {parsed, choices}

  const say = (text) => setText(status, text);
  const closePick = () => { pending = null; pickRow.hidden = true; };

  scope.on(exportBtn, 'click', () => {
    closePick();
    const bars = Number(scopeSel.value);
    try {
      if (bars > 0) { say(saveSessionMidi(store, bars, music)); return; }
      const p = selected();
      const part = store.get(`parts.${p}`) || {};
      const res = exportMidi(store.serialize(), { mode: 'pattern', part: p, render: renderWith(music) });
      if (!res.notes) { say('This pattern has no notes to export.'); return; }
      const pat = (part.patterns || [])[activePatternIndex(part)] || {};
      downloadBlob(new Blob([res.bytes], { type: 'audio/midi' }), midiFileName(new Date(), `${part.name || `track ${p + 1}`} ${pat.name || ''}`));
      say(`Saved ${plural(res.notes, 'note')} from ${pat.name || 'the pattern'} as a MIDI file.`);
    } catch (err) {
      console.warn('[ui] MIDI export failed', err);
      say('The MIDI file could not be made.');
    }
  });

  function apply(choice, parsed) {
    const p = selected();
    const pattern = store.get(patternPath(store, p));
    const res = pattern ? importMidiNotes(store, choice.notes, { part: p, chord: chordSel.value }) : null;
    if (!res) { say('This track has no pattern to import into.'); return; }
    const rate = SEQ_RATES[pattern.rate] ? SEQ_RATES[pattern.rate].name : '1/16';
    const where = res.tracks > 1 ? `${res.pattern} and the next ${plural(res.tracks - 1, 'track')}` : res.pattern;
    const out = [`Imported ${plural(res.used, res.drum ? 'hit' : 'note')} from ${choice.label.replace(/:.*$/, '')} into ${where}, quantized to ${rate}.`];
    if (res.snapped) out.push(`${plural(res.snapped, 'out-of-scale note')} snapped to the scale.`);
    if (res.dropped) out.push(`${plural(res.dropped, 'chord note')} left out (one note per step).`);
    if (res.voicesDropped) out.push(`${plural(res.voicesDropped, 'chord voice')} dropped: there were no more tracks.`);
    if (res.outside) out.push(`${plural(res.outside, 'note')} past step ${pattern.length || 16} ${res.outside === 1 ? 'was' : 'were'} left out.`);
    out.push(`File tempo ${Math.round(parsed.bpm)} BPM.`);
    say(out.join(' '));
  }

  scope.on(importBtn, 'click', () => fileIn.click());
  scope.on(fileIn, 'change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    closePick();
    if (!f) return;
    try {
      const parsed = parseMidi(new Uint8Array(await f.arrayBuffer()));
      const { choices, best } = midiChoices(parsed, { drum: !!store.get(`parts.${selected()}.drum.on`) });
      if (!choices.length) { say(`${f.name} has no notes.`); return; }
      if (choices.length === 1) { apply(choices[0], parsed); return; }
      pending = { parsed, choices };
      pickSel.replaceChildren(...choices.map((c, i) => h('option', { value: String(i) }, c.label)));
      pickSel.value = String(best);
      pickRow.hidden = false;
      say(`${f.name} has ${choices.length} tracks with notes. Choose one, then press Use track.`);
      pickSel.focus();
    } catch (err) {
      say(`${f.name} could not be read: ${err && err.message ? err.message : 'unknown format'}.`);
    }
  });
  scope.on(pickGo, 'click', () => {
    if (!pending) return;
    const c = pending.choices[Number(pickSel.value)] || pending.choices[0];
    const parsed = pending.parsed;
    closePick();
    apply(c, parsed);
    importBtn.focus();
  });
  scope.on(pickCancel, 'click', () => { closePick(); say('Import cancelled.'); importBtn.focus(); });
  scope.add(store.subscribe('ui.selectedPart', () => { if (pending) { closePick(); say(''); } }));

  const el = h('div', { class: 'seq-midi', role: 'group', 'aria-label': 'MIDI file' },
    h('span', { class: 'mini-label' }, 'MIDI file'),
    h('div', { class: 'select select--sm' }, scopeSel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' })),
    h('div', { class: 'seq-midi-row' }, exportBtn, importBtn),
    h('div', { class: 'select select--sm', dataset: { tip: 'Several notes on one import step: keep the highest or the lowest, or put each voice on its own track (this one and the ones after it)' } }, chordSel, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' })),
    pickRow, status, fileIn);
  return { el, dispose: () => scope.dispose() };
}
