// Live performance mode (2.12): the pad editor and the setlist dialog.
// Both are ordinary Oro dialogs (src/ui/modal.js) shown over the live view.

import { h, setText, uniqueId } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { icon } from '../ui/icons.js';
import { readSmart, smartKnobLabel, SMART_KNOBS } from '../core/smart.js';
import { MAX_PATTERNS, NOTE_NAMES, SCALE_NAMES, clamp } from '../core/params.js';
import { KIT_PADS } from '../dsp/drum-kit.js';
import { getVersions, startVersions } from '../core/versions.js';
import { mappingControl } from '../midi/midi.js';
import {
  PAD_TYPES, PAD_TYPE_LABEL, QUANTS, QUANT_LABEL, PAD_COLORS, PAD_KEY_LABELS, defaultQuant, sanitizePad, sanitizeEntry,
  parseNotes, formatNotes, scaleTriad, chordName, moveEntry, SETLIST_MAX,
} from './setup.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

function field(label, control, hint) {
  const id = control.id || uniqueId('lv');
  control.id = id;
  return h('div', { class: 'lv-field' }, h('label', { class: 'lv-field-label', for: id }, label), control, hint ? h('p', { class: 'lv-hint' }, hint) : null);
}

function select(options, value, label) {
  const el = h('select', { class: 'select-native', 'aria-label': label });
  for (const o of options) {
    if (o.group) {
      const g = h('optgroup', { label: o.group });
      for (const x of o.items) g.appendChild(h('option', { value: String(x.value) }, x.label));
      el.appendChild(g);
    } else el.appendChild(h('option', { value: String(o.value), disabled: !!o.disabled }, o.label));
  }
  el.value = String(value);
  return el;
}
const wrapSelect = (el) => h('div', { class: 'select lv-select' }, el, h('span', { class: 'select-caret', html: icon('chevron-down') }));

function radios(name, options, value, onPick) {
  const group = h('div', { class: 'lv-radios', role: 'radiogroup' });
  for (const o of options) {
    const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === value });
    input.addEventListener('change', () => { if (input.checked) onPick(o.value); });
    group.appendChild(h('label', { class: 'lv-radio' }, input, h('span', null, o.label)));
  }
  return group;
}

const trackName = (store, t) => store.get(`parts.${t}.name`) || `Track ${t + 1}`;
function trackOptions(store, { sel = false } = {}) {
  const n = (store.get('parts') || []).length;
  const out = sel ? [{ value: 'sel', label: 'The selected track' }] : [];
  for (let t = 0; t < n; t++) out.push({ value: t, label: `${t + 1}. ${trackName(store, t)}` });
  return out;
}

/** The label a pad gets when its own is left empty. */
export function autoLabel(pad, { store, presets } = {}) {
  if (!pad) return '';
  const tn = (t) => (store && t !== 'sel' ? trackName(store, t) : 'selected track');
  switch (pad.type) {
    case 'scene': {
      const sc = presets ? presets.scenes().find(x => x.id === pad.scene) : null;
      return sc ? sc.name : 'Scene';
    }
    case 'section': return `Section ${pad.pattern + 1}`;
    case 'pattern': {
      const name = store ? store.get(`parts.${pad.track}.patterns.${pad.pattern}.name`) : '';
      return name || `Pattern ${pad.pattern + 1}`;
    }
    case 'mute': return `Mute ${tn(pad.track)}`;
    case 'solo': return `Solo ${tn(pad.track)}`;
    case 'drum': return (store && store.get(`parts.${pad.track}.drum.pads.${pad.pad}.name`)) || `Pad ${pad.pad + 1}`;
    case 'note': return chordName(pad.notes) || 'Notes';
    case 'macros': return 'Macros';
    case 'smart': return 'Smart preset';
    default: return '';
  }
}

/** Edit pad `i` of live controller `live`. */
export function openPadEditor(ctx, live, i, { appRoot = null } = {}) {
  const { store, presets } = ctx;
  const start = live.pads()[i];
  let draft = start ? JSON.parse(JSON.stringify(start)) : { type: '', label: '', color: PAD_COLORS[i % PAD_COLORS.length], quant: 'off' };
  let quantTouched = !!start;

  const typeSel = select([{ value: '', label: 'Empty (does nothing)' }, ...PAD_TYPES.map(t => ({ value: t, label: PAD_TYPE_LABEL[t] }))], draft.type || '', 'What the pad does');
  const fieldsEl = h('div', { class: 'lv-type-fields' });
  const labelIn = h('input', { type: 'text', class: 'input lv-input', maxlength: '24', value: draft.label || '', placeholder: 'Automatic' });
  const quantEl = h('div');
  const colorsEl = h('div', { class: 'lv-swatches', role: 'radiogroup', 'aria-label': 'Colour' });
  const learnInfo = h('span', { class: 'lv-hint lv-inline' });
  const learnBtn = h('button', { type: 'button', class: 'btn btn--sm', html: `${icon('learn')}<span>MIDI Learn</span>` });
  const unmapBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost' }, 'Remove mapping');
  const saveBtn = h('button', { type: 'button', class: 'btn btn--primary' }, 'Save pad');
  const clearBtn = h('button', { type: 'button', class: 'btn btn--ghost' }, 'Clear pad');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const note = h('p', { class: 'lv-hint', role: 'status', 'aria-live': 'polite' });

  function renderQuant() {
    quantEl.replaceChildren(field('Quantise while playing',
      radios(uniqueId('lvq'), QUANTS.map(q => ({ value: q, label: QUANT_LABEL[q] })), draft.quant || 'off', (v) => { draft.quant = v; quantTouched = true; }),
      'Bar or Beat waits for the next bar or beat line, so changes land in time. When stopped, pads act at once.'));
  }

  function renderColors() {
    colorsEl.replaceChildren(...PAD_COLORS.map((c, k) => {
      const b = h('button', { type: 'button', class: 'lv-swatch', role: 'radio', 'aria-checked': String(draft.color === c), 'aria-label': `Colour ${k + 1}`, style: { '--sw': c } });
      b.addEventListener('click', () => { draft.color = c; renderColors(); });
      return b;
    }));
  }

  function numIn(value, label, { min = 0, max = 100 } = {}) {
    return h('input', { type: 'number', class: 'input lv-input lv-num', min: String(min), max: String(max), step: '1', value: value == null ? '' : String(value), 'aria-label': label });
  }

  function renderFields() {
    const t = draft.type;
    const parts = [];
    if (t === 'scene') {
      const list = presets ? presets.scenes() : [];
      const mine = list.filter(x => !x.factory), factory = list.filter(x => x.factory);
      const opts = [];
      if (mine.length) opts.push({ group: 'Your scenes', items: mine.map(x => ({ value: x.id, label: x.name })) });
      if (factory.length) opts.push({ group: 'Factory scenes', items: factory.map(x => ({ value: x.id, label: x.name })) });
      if (!draft.scene && list.length) draft.scene = (mine[0] || list[0]).id;
      const sel = select(opts.length ? opts : [{ value: '', label: 'No scenes yet', disabled: true }], draft.scene || '', 'Scene');
      sel.addEventListener('change', () => { draft.scene = sel.value; });
      parts.push(field('Scene', wrapSelect(sel), 'Loading a scene replaces the whole session (Undo brings it back). Your pads and setlist stay.'));
    }
    if (t === 'section' || t === 'pattern') {
      if (t === 'pattern') {
        if (!Number.isInteger(draft.track)) draft.track = Math.round(Number(store.get('ui.selectedPart')) || 0);
        const ts = select(trackOptions(store), draft.track, 'Track');
        ts.addEventListener('change', () => { draft.track = Number(ts.value); renderFields(); });
        parts.push(field('Track', wrapSelect(ts)));
      }
      const names = t === 'pattern' ? (store.get(`parts.${draft.track}.patterns`) || []) : [];
      const ps = select(Array.from({ length: MAX_PATTERNS }, (_, k) => ({ value: k, label: names[k] ? `${k + 1}. ${names[k].name}` : `${k + 1}${t === 'pattern' ? ' (not made yet)' : ''}` })), draft.pattern || 0, 'Pattern');
      ps.addEventListener('change', () => { draft.pattern = Number(ps.value); });
      parts.push(field('Pattern', wrapSelect(ps), t === 'section' ? 'Every track that has this pattern switches to it together.' : null));
    }
    if (t === 'mute' || t === 'solo' || t === 'drum') {
      if (!Number.isInteger(draft.track)) {
        const kit = (store.get('parts') || []).findIndex(p => p && p.drum && p.drum.on);
        draft.track = t === 'drum' && kit >= 0 ? kit : Math.round(Number(store.get('ui.selectedPart')) || 0);
      }
      const ts = select(trackOptions(store), draft.track, 'Track');
      ts.addEventListener('change', () => { draft.track = Number(ts.value); renderFields(); });
      parts.push(field('Track', wrapSelect(ts), t === 'drum' && !store.get(`parts.${draft.track}.drum.on`) ? 'This track is not a drum kit, so the pad plays a low note instead.' : null));
      if (t === 'drum') {
        const kitPads = store.get(`parts.${draft.track}.drum.pads`) || [];
        const ds = select(Array.from({ length: KIT_PADS }, (_, k) => ({ value: k, label: `${k + 1}. ${(kitPads[k] && kitPads[k].name) || `Pad ${k + 1}`}` })), draft.pad || 0, 'Drum pad');
        ds.addEventListener('change', () => { draft.pad = Number(ds.value); });
        parts.push(field('Drum pad', wrapSelect(ds)));
      }
    }
    if (t === 'note') {
      if (draft.track == null) draft.track = 'sel';
      const ts = select(trackOptions(store, { sel: true }), draft.track, 'Track');
      ts.addEventListener('change', () => { draft.track = ts.value === 'sel' ? 'sel' : Number(ts.value); });
      parts.push(field('Track', wrapSelect(ts)));
      const notesIn = h('input', { type: 'text', class: 'input lv-input', value: formatNotes(draft.notes || []), placeholder: 'C4 E4 G4' });
      notesIn.addEventListener('change', () => { draft.notes = parseNotes(notesIn.value); notesIn.value = formatNotes(draft.notes); });
      parts.push(field('Notes', notesIn, 'One note or up to eight, by name and octave (C4 is middle C) or MIDI number.'));
      const root = Math.round(Number(store.get('global.scaleRoot')) || 0), scaleType = Math.round(Number(store.get('global.scaleType')) || 0);
      const chordSel = select([{ value: '', label: 'Pick a chord in the key...' }, ...ROMAN.map((r, d) => { const n = scaleTriad(root, scaleType, d, 4); return { value: d, label: `${r}: ${chordName(n)} (${formatNotes(n)})` }; })], '', 'Chord in the key');
      chordSel.addEventListener('change', () => {
        if (chordSel.value === '') return;
        draft.notes = scaleTriad(root, scaleType, Number(chordSel.value), 4);
        notesIn.value = formatNotes(draft.notes);
        chordSel.value = '';
      });
      parts.push(field(`Chord in ${NOTE_NAMES[root]} ${SCALE_NAMES[scaleType] || ''}`, wrapSelect(chordSel)));
    }
    if (t === 'macros') {
      if (!Array.isArray(draft.values)) draft.values = [1, 2, 3, 4].map(k => Number(store.get(`global.macro${k}`)) || 0);
      const ins = draft.values.map((v, k) => {
        const el = numIn(Math.round(v * 100), `Macro ${k + 1} in percent`);
        el.addEventListener('change', () => { draft.values[k] = clamp((Number(el.value) || 0) / 100, 0, 1); });
        return h('label', { class: 'lv-num-cell' }, h('span', null, `Macro ${k + 1}`), el);
      });
      const grab = h('button', { type: 'button', class: 'btn btn--sm' }, 'Use the macros as they are now');
      grab.addEventListener('click', () => { draft.values = [1, 2, 3, 4].map(k => Number(store.get(`global.macro${k}`)) || 0); renderFields(); });
      parts.push(field('Macro positions (percent)', h('div', { class: 'lv-num-grid' }, ins)), grab);
    }
    if (t === 'smart') {
      if (draft.track == null) draft.track = 'sel';
      const ts = select(trackOptions(store, { sel: true }), draft.track, 'Track');
      ts.addEventListener('change', () => { draft.track = ts.value === 'sel' ? 'sel' : Number(ts.value); renderFields(); });
      parts.push(field('Track', wrapSelect(ts)));
      const t0 = draft.track === 'sel' ? Math.round(Number(store.get('ui.selectedPart')) || 0) : draft.track;
      const knobs = readSmart(store, t0).knobs;
      if (!Array.isArray(draft.values)) draft.values = knobs.map(k => (k.maps.length ? k.value : null));
      const ins = Array.from({ length: SMART_KNOBS }, (_, k) => {
        const v = draft.values[k];
        const el = numIn(v == null ? null : Math.round(v * 100), `${smartKnobLabel(knobs[k], k)} in percent`);
        el.placeholder = 'Leave';
        el.addEventListener('change', () => { draft.values[k] = el.value === '' ? null : clamp((Number(el.value) || 0) / 100, 0, 1); });
        return h('label', { class: 'lv-num-cell' }, h('span', null, smartKnobLabel(knobs[k], k)), el);
      });
      const grab = h('button', { type: 'button', class: 'btn btn--sm' }, 'Use the smart controls as they are now');
      grab.addEventListener('click', () => { draft.values = knobs.map(k => (k.maps.length ? k.value : null)); renderFields(); });
      parts.push(field('Smart control positions (percent, empty leaves a knob alone)', h('div', { class: 'lv-num-grid' }, ins)), grab);
      if (!knobs.some(k => k.maps.length)) parts.push(h('p', { class: 'lv-hint' }, 'This track has no smart controls set up yet. Set them up in the Sound tab first.'));
    }
    fieldsEl.replaceChildren(...parts);
  }

  typeSel.addEventListener('change', () => {
    draft = { label: draft.label, color: draft.color, quant: draft.quant, type: typeSel.value };
    if (!quantTouched || !draft.quant) draft.quant = defaultQuant(draft.type);
    renderFields();
    renderQuant();
  });

  const target = { scope: 'action', id: `live.pad${i + 1}` };
  function renderLearn() {
    const ok = ctx.midiOk && ctx.midiOk();
    const m = ok && ctx.findMapping ? ctx.findMapping(target) : null;
    learnBtn.disabled = !ok;
    unmapBtn.hidden = !m;
    setText(learnInfo, !ok ? 'Connect MIDI in Settings to map a controller button.' : m ? `Mapped to ${mappingControl(m)}${m.channel ? ` on channel ${m.channel}` : ''}.` : 'Press MIDI Learn, then a button or pad on your controller.');
  }
  learnBtn.addEventListener('click', () => ctx.learn.start(target, `pad ${i + 1}`, renderLearn));
  unmapBtn.addEventListener('click', () => { ctx.unmap(target); renderLearn(); });

  const content = h('div', { class: 'lv-dialog' },
    field('What the pad does', wrapSelect(typeSel)),
    fieldsEl,
    field('Label', labelIn, 'Leave it empty to name the pad after what it does.'),
    h('div', { class: 'lv-field' }, h('span', { class: 'lv-field-label' }, 'Colour'), colorsEl),
    quantEl,
    h('div', { class: 'lv-field' }, h('span', { class: 'lv-field-label' }, `Keys and MIDI: key ${PAD_KEY_LABELS[i]}`), h('div', { class: 'lv-row' }, learnBtn, unmapBtn), learnInfo),
    note,
    h('div', { class: 'lv-actions' }, clearBtn, h('span', { class: 'lv-spacer' }), cancelBtn, saveBtn));

  renderFields();
  renderQuant();
  renderColors();
  renderLearn();

  const modal = openModal(ctx.layers, appRoot, { title: `Pad ${i + 1}`, content, className: 'lv-modal', initialFocus: typeSel });
  cancelBtn.addEventListener('click', () => modal.close('cancel'));
  clearBtn.addEventListener('click', () => { live.setPad(i, null); modal.close('clear'); });
  saveBtn.addEventListener('click', () => {
    if (!draft.type) { live.setPad(i, null); modal.close('save'); return; }
    const candidate = { ...draft, label: labelIn.value.trim() };
    const clean = sanitizePad(candidate);
    if (!clean) {
      setText(note, draft.type === 'note' ? 'Type at least one note, such as C4.' : draft.type === 'scene' ? 'Choose a scene first.' : draft.type === 'smart' ? 'Give at least one smart control a position.' : 'That pad is not complete yet.');
      return;
    }
    if (!clean.label) clean.label = autoLabel(clean, { store, presets }).slice(0, 24);
    live.setPad(i, clean);
    modal.close('save');
  });
  return modal;
}

/** The setlist and live options. */
export function openSetlistEditor(ctx, live, { onChange, appRoot = null } = {}) {
  const { store, presets } = ctx;
  const listEl = h('ol', { class: 'lv-setlist' });
  const status = h('p', { class: 'lv-hint', role: 'status', 'aria-live': 'polite' });
  let versions = getVersions();
  const changed = () => { if (onChange) onChange(); };

  const write = (list) => { live.writeLive({ setlist: list }); changed(); renderList(); };
  const entries = () => live.setlist().map(e => ({ ...e }));

  function describeRef(e) {
    if (e.kind === 'scene') {
      const sc = presets ? presets.scenes().find(x => x.id === e.ref) : null;
      return sc ? `Scene: ${sc.name}${sc.key ? `, ${sc.key}` : ''}${sc.tempo ? `, ${sc.tempo} BPM` : ''}` : 'Scene missing from your library';
    }
    const v = versions ? versions.list().find(x => x.id === e.ref) : null;
    return v ? `Version: ${new Date(v.time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${v.name ? ` (${v.name})` : ''}` : 'Version no longer stored';
  }

  function renderList() {
    const list = entries();
    if (!list.length) { listEl.replaceChildren(h('li', { class: 'lv-empty' }, 'No songs yet. Add saved scenes or versions below.')); return; }
    const pos = live.position();
    listEl.replaceChildren(...list.map((e, k) => {
      const nameIn = h('input', { type: 'text', class: 'input lv-input', maxlength: '60', value: e.name, 'aria-label': `Song ${k + 1} name` });
      const keyIn = h('input', { type: 'text', class: 'input lv-input lv-key', maxlength: '24', value: e.key, placeholder: 'Key', 'aria-label': `Song ${k + 1} key` });
      const tempoIn = h('input', { type: 'number', class: 'input lv-input lv-num', min: '20', max: '400', step: '1', value: e.tempo ? String(e.tempo) : '', placeholder: 'BPM', 'aria-label': `Song ${k + 1} tempo note` });
      const cuesIn = h('textarea', { class: 'input lv-input lv-cues', maxlength: '400', rows: '2', placeholder: 'Cues: intro twice, drop at bar 17...', 'aria-label': `Song ${k + 1} cues` });
      cuesIn.value = e.cues;
      const commit = () => {
        const next = entries();
        next[k] = sanitizeEntry({ ...next[k], name: nameIn.value, key: keyIn.value, tempo: Number(tempoIn.value) || 0, cues: cuesIn.value }) || next[k];
        live.writeLive({ setlist: next });
        changed();
      };
      for (const el of [nameIn, keyIn, tempoIn, cuesIn]) el.addEventListener('change', commit);
      const up = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move song ${k + 1} up`, disabled: k === 0, html: icon('chevron-up') });
      const down = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move song ${k + 1} down`, disabled: k === list.length - 1, html: icon('chevron-down') });
      const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove song ${k + 1}`, html: icon('trash') });
      const go = h('button', { type: 'button', class: 'btn btn--xs' }, k === pos ? 'Playing' : 'Load');
      go.disabled = k === pos;
      up.addEventListener('click', () => write(moveEntry(entries(), k, -1)));
      down.addEventListener('click', () => write(moveEntry(entries(), k, 1)));
      del.addEventListener('click', () => { const next = entries(); next.splice(k, 1); write(next); });
      go.addEventListener('click', async () => {
        const r = await live.goTo(k, { confirmed: true });
        setText(status, r === 'loaded' ? `Loaded "${e.name}".` : r === 'queued' ? `"${e.name}" loads at the next bar.` : `"${e.name}" could not be loaded.`);
        renderList();
        changed();
      });
      return h('li', { class: ['lv-song', k === pos && 'is-now'] },
        h('div', { class: 'lv-song-top' }, h('span', { class: 'lv-song-num' }, String(k + 1)), nameIn, keyIn, tempoIn),
        h('div', { class: 'lv-song-ref' }, describeRef(e)),
        cuesIn,
        h('div', { class: 'lv-song-actions' }, go, h('span', { class: 'lv-spacer' }), up, down, del));
    }));
  }

  // Add songs
  const sceneOpts = () => {
    const list = presets ? presets.scenes() : [];
    const mine = list.filter(x => !x.factory), factory = list.filter(x => x.factory);
    const out = [];
    if (mine.length) out.push({ group: 'Your scenes', items: mine.map(x => ({ value: x.id, label: x.name })) });
    if (factory.length) out.push({ group: 'Factory scenes', items: factory.map(x => ({ value: x.id, label: x.name })) });
    return out.length ? out : [{ value: '', label: 'No scenes', disabled: true }];
  };
  const sceneSel = select(sceneOpts(), '', 'Scene to add');
  const addScene = h('button', { type: 'button', class: 'btn btn--sm', html: `${icon('plus')}<span>Add scene</span>` });
  addScene.addEventListener('click', () => {
    const sc = presets ? presets.scenes().find(x => x.id === sceneSel.value) : null;
    if (!sc) return;
    const list = entries();
    if (list.length >= SETLIST_MAX) { setText(status, `A setlist holds up to ${SETLIST_MAX} songs.`); return; }
    list.push({ kind: 'scene', ref: sc.id, name: sc.name, key: '', tempo: 0, cues: '' });
    write(list);
    setText(status, `Added "${sc.name}".`);
  });
  const saveSceneBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', html: `${icon('save')}<span>Save this session as a scene and add it</span>` });
  saveSceneBtn.addEventListener('click', () => {
    if (!presets) return;
    const name = `Song ${entries().length + 1}`;
    const id = presets.saveScene(name);
    const list = entries();
    if (list.length >= SETLIST_MAX) return;
    list.push({ kind: 'scene', ref: id, name: presets.scenes().find(x => x.id === id)?.name || name, key: '', tempo: 0, cues: '' });
    write(list);
    sceneSel.replaceChildren(...select(sceneOpts(), '', 'Scene to add').childNodes);
    setText(status, `Saved and added "${name}". Rename it here if you like.`);
  });
  const versionSel = select([{ value: '', label: 'Loading versions...', disabled: true }], '', 'Version to add');
  const addVersion = h('button', { type: 'button', class: 'btn btn--sm', html: `${icon('plus')}<span>Add version</span>` });
  addVersion.disabled = true;
  const fillVersions = () => {
    const list = versions ? versions.list().slice().reverse() : [];
    const opts = list.length ? list.map(v => ({ value: v.id, label: `${new Date(v.time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${v.name ? `, ${v.name}` : ''} (${v.tempo} BPM, ${v.key})` })) : [{ value: '', label: 'No versions yet', disabled: true }];
    versionSel.replaceChildren(...select(opts, '', 'Version to add').childNodes);
    versionSel.value = list.length ? list[0].id : '';
    addVersion.disabled = !list.length;
  };
  startVersions({ store }).then(async (v) => { versions = v; await v.ready; fillVersions(); renderList(); }).catch(() => { versionSel.replaceChildren(h('option', { value: '' }, 'Version history is not available')); });
  addVersion.addEventListener('click', () => {
    const v = versions ? versions.list().find(x => x.id === versionSel.value) : null;
    if (!v) return;
    const list = entries();
    if (list.length >= SETLIST_MAX) { setText(status, `A setlist holds up to ${SETLIST_MAX} songs.`); return; }
    list.push({ kind: 'version', ref: v.id, name: v.name || `Version ${new Date(v.time).toLocaleDateString([], { month: 'short', day: 'numeric' })}`, key: '', tempo: 0, cues: '' });
    write(list);
    setText(status, 'Added the version.');
  });

  // Options
  const cfg = live.setup();
  const setOpt = (patch, meta) => { live.writeLive(patch, meta); changed(); };
  const songChange = radios(uniqueId('lvs'), [
    { value: 'bar', label: 'At the next bar' }, { value: 'confirm', label: 'Ask first, then at the next bar' }, { value: 'now', label: 'At once' },
  ], cfg.songChange, (v) => setOpt({ songChange: v }));
  const backdropEl = radios(uniqueId('lvb'), [{ value: 'map', label: 'Map' }, { value: 'dim', label: 'Dimmed map' }, { value: 'off', label: 'Off (saves power)' }], cfg.backdrop, (v) => setOpt({ backdrop: v }, { source: 'prefs' }));
  const lookEl = radios(uniqueId('lvl'), [{ value: 'dark', label: 'Stage dark' }, { value: 'app', label: 'Match the app theme' }], cfg.look, (v) => setOpt({ look: v }, { source: 'prefs' }));

  const midiRow = h('div', { class: 'lv-row lv-wrap' });
  const renderMidi = () => {
    const ok = ctx.midiOk && ctx.midiOk();
    midiRow.replaceChildren(...[['live.prev', 'Previous song'], ['live.next', 'Next song'], ['live.play', 'Play / stop']].map(([id, label]) => {
      const t = { scope: 'action', id };
      const m = ok && ctx.findMapping ? ctx.findMapping(t) : null;
      const b = h('button', { type: 'button', class: 'btn btn--sm', disabled: !ok, html: `${icon('learn')}<span>${label}${m ? `: CC ${m.cc}` : ''}</span>` });
      b.addEventListener('click', () => ctx.learn.start(t, label, renderMidi));
      return b;
    }));
    if (!ok) midiRow.appendChild(h('p', { class: 'lv-hint' }, 'Connect MIDI in Settings to map controller buttons.'));
  };
  renderMidi();

  const content = h('div', { class: 'lv-dialog lv-setlist-dialog' },
    h('p', { class: 'lv-hint' }, 'Songs play in order with Next and Previous (the arrow keys, or MIDI). Notes are for you: key, tempo and cues show on the live screen; the song itself brings its own tempo and key.'),
    listEl,
    h('div', { class: 'lv-add' },
      h('div', { class: 'lv-row' }, wrapSelect(sceneSel), addScene),
      h('div', { class: 'lv-row' }, wrapSelect(versionSel), addVersion),
      saveSceneBtn),
    status,
    h('h3', { class: 'lv-sub' }, 'Options'),
    field('Song changes while playing', songChange),
    field('Backdrop', backdropEl),
    field('Colours', lookEl),
    h('div', { class: 'lv-field' }, h('span', { class: 'lv-field-label' }, 'MIDI Learn'), midiRow));
  renderList();
  const modal = openModal(ctx.layers, appRoot, { title: 'Setlist', content, className: 'lv-modal lv-modal--wide', wide: true });
  return modal;
}
